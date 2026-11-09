/**
 * What the per-tenant numbers mean — `operator-health-monitoring.md`.
 *
 * The counting happens in migration 0020, in triggers on the tables that hold the
 * events. This module holds the rules for reading those counts back: which hours a
 * request covers, whether they are still retained, how the counts combine into a
 * rate, and when a rate is unusual. All of it is pure except the retention sweep.
 */

import { withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { ValidationError } from '@zeddev/errors';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * [DECISION] Ninety days, and a constant rather than a setting. The spec requires a
 * defined window and leaves its length open. The API that answers "is this range
 * retained?" and the scheduler that deletes what is not have to agree, and if they
 * were two separately configured services a mismatch would show exactly what AC8
 * forbids: a range reported as available with its early hours already gone.
 */
export const METRIC_RETENTION_DAYS = 90;
const RETENTION_MS = METRIC_RETENTION_DAYS * DAY_MS;

/** The presets a dashboard offers, in hours. */
export const METRIC_WINDOWS = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 } as const;
export type MetricWindow = keyof typeof METRIC_WINDOWS;

/** How much of a tenant's own history counts as its "recent normal". */
export const METRIC_BASELINE_MS = 7 * DAY_MS;

/**
 * What counts as unusual. The spec leaves the numbers to implementation.
 *
 * - `minimumSample` keeps one failed message out of two from reading as a 50% outage.
 *   Every test below needs that many attempts in the period being judged.
 * - A rate compared with the tenant's own history needs a floor as well, or a tenant
 *   that has never failed would be flagged by its first failure.
 * - The absolute limits catch what a comparison cannot: a tenant that has always been
 *   this bad has a recent normal to match.
 */
export const HEALTH_THRESHOLDS = {
  minimumSample: 10,
  errorRate: 0.2,
  errorRateFloor: 0.05,
  errorRateMultiple: 2,
  responseMs: 5 * 60_000,
  responseMultiple: 2,
} as const;

/** What was asked for: a preset, or explicit instants. */
export type MetricSelection =
  | { readonly kind: 'window'; readonly window: MetricWindow }
  | { readonly kind: 'range'; readonly from: Date; readonly to: Date };

/** The hours a request actually covers, which may be wider than what was asked. */
export interface MetricRange {
  readonly from: Date;
  readonly to: Date;
  /** False when any part of the range is older than what is kept (AC8). */
  readonly available: boolean;
  /** The oldest instant still retained. */
  readonly retainedSince: Date;
}

const DEFAULT_WINDOW: MetricWindow = '24h';

function isMetricWindow(value: unknown): value is MetricWindow {
  return typeof value === 'string' && Object.hasOwn(METRIC_WINDOWS, value);
}

function parseInstant(body: Readonly<Record<string, unknown>>, key: 'from' | 'to', issues: { key: string; reason: string }[]): Date | undefined {
  const value = body[key];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push({ key, reason: 'must be an ISO 8601 date or instant' });
    return undefined;
  }
  return new Date(value);
}

/** Read a preset or an explicit range from a request body. Nothing means the shortest preset. */
export function parseMetricSelection(
  body: Readonly<Record<string, unknown>>,
  issues: { key: string; reason: string }[],
): MetricSelection {
  const fallback: MetricSelection = { kind: 'window', window: DEFAULT_WINDOW };
  const explicit = body.from !== undefined || body.to !== undefined;
  if (explicit) {
    if (body.window !== undefined) {
      issues.push({ key: 'window', reason: 'cannot be combined with from and to' });
      return fallback;
    }
    const from = parseInstant(body, 'from', issues);
    const to = parseInstant(body, 'to', issues);
    return from === undefined || to === undefined ? fallback : { kind: 'range', from, to };
  }
  if (body.window === undefined) return fallback;
  if (!isMetricWindow(body.window)) {
    issues.push({ key: 'window', reason: `must be one of ${Object.keys(METRIC_WINDOWS).join(', ')}` });
    return fallback;
  }
  return { kind: 'window', window: body.window };
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function ceilHour(ms: number): number {
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

/** The first hour still kept. The sweep and the availability answer both use this. */
function retentionStart(now: Date): number {
  return floorHour(now.getTime()) - RETENTION_MS;
}

/**
 * Turn a selection into whole hours, because hours are what is stored.
 *
 * The range widens rather than narrows, so a request never silently loses the edges
 * it named, and the answer states the hours it really covers. A range that reaches
 * past retention at all is unavailable as a whole: reporting only its surviving part
 * is the "silently showing incomplete data" AC8 rules out.
 */
export function resolveMetricRange(selection: MetricSelection, now: Date): MetricRange {
  const end = floorHour(now.getTime()) + HOUR_MS;
  const retainedSince = retentionStart(now);
  let from: number;
  let to: number;
  if (selection.kind === 'window') {
    to = end;
    from = to - METRIC_WINDOWS[selection.window] * HOUR_MS;
  } else {
    from = floorHour(selection.from.getTime());
    to = Math.min(ceilHour(selection.to.getTime()), end);
    if (from >= to) {
      throw new ValidationError([{ key: 'from', reason: 'must be before to, and not in the future' }]);
    }
  }
  return { from: new Date(from), to: new Date(to), available: from >= retainedSince, retainedSince: new Date(retainedSince) };
}

/** Counts over some period, exactly as summed from the stored hours. */
export interface MetricTotals {
  readonly messagesReceived: number;
  readonly messagesSent: number;
  readonly turnsAnswered: number;
  readonly failedResponses: number;
  readonly failedDeliveries: number;
  readonly expiredDeliveries: number;
  readonly responsesTimed: number;
  readonly responseMsTotal: number;
}

export const NO_METRICS: MetricTotals = {
  messagesReceived: 0,
  messagesSent: 0,
  turnsAnswered: 0,
  failedResponses: 0,
  failedDeliveries: 0,
  expiredDeliveries: 0,
  responsesTimed: 0,
  responseMsTotal: 0,
};

/** The counts plus what is derived from them. A rate is null when nothing was attempted. */
export interface TenantMetrics extends Omit<MetricTotals, 'responseMsTotal'> {
  /** Nothing at all happened in the range (AC11). */
  readonly noActivity: boolean;
  readonly errorRate: number | null;
  readonly responseFailureRate: number | null;
  readonly deliveryFailureRate: number | null;
  readonly averageResponseMs: number | null;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** How many things could have gone wrong: each answer decided, each delivery finished. */
function attempts(totals: MetricTotals): number {
  return totals.turnsAnswered + totals.messagesSent + totals.failedDeliveries;
}

/**
 * Derive the rates.
 *
 * The single `errorRate` a dashboard sorts by counts both ways a customer can be let
 * down, over both chances for it to happen, which keeps it within 0 and 1 even when
 * one turn fails twice. A delivery that missed the 24-hour window is reported but not
 * in the rate: it says a reply came late, not that anything is failing.
 */
export function summarizeMetrics(totals: MetricTotals): TenantMetrics {
  const { responseMsTotal, ...counts } = totals;
  const average = ratio(responseMsTotal, totals.responsesTimed);
  return {
    ...counts,
    noActivity: Object.values(counts).every((count) => count === 0),
    errorRate: ratio(totals.failedResponses + totals.failedDeliveries, attempts(totals)),
    responseFailureRate: ratio(totals.failedResponses, totals.turnsAnswered),
    deliveryFailureRate: ratio(totals.failedDeliveries, totals.messagesSent + totals.failedDeliveries),
    averageResponseMs: average === null ? null : Math.round(average),
  };
}

/** Whether a tenant stands out, for the view that does not open each one. */
export interface HealthFlags {
  readonly elevatedErrorRate: boolean;
  readonly degradedResponseTime: boolean;
}

/** Compare a period with the tenant's own recent normal, and with the absolute limits. */
export function assessHealth(current: MetricTotals, baseline: MetricTotals): HealthFlags {
  const limits = HEALTH_THRESHOLDS;
  const now = summarizeMetrics(current);
  const before = summarizeMetrics(baseline);

  const rate = now.errorRate;
  const elevatedErrorRate =
    rate !== null &&
    attempts(current) >= limits.minimumSample &&
    (rate >= limits.errorRate ||
      (attempts(baseline) >= limits.minimumSample &&
        rate >= limits.errorRateFloor &&
        rate >= limits.errorRateMultiple * (before.errorRate ?? 0)));

  const average = now.averageResponseMs;
  const degradedResponseTime =
    average !== null &&
    current.responsesTimed >= limits.minimumSample &&
    (average >= limits.responseMs ||
      (baseline.responsesTimed >= limits.minimumSample &&
        average >= limits.responseMultiple * (before.averageResponseMs ?? 0)));

  return { elevatedErrorRate, degradedResponseTime };
}

/**
 * Delete hours past retention. Returns how many rows went.
 *
 * Found across tenants under the platform scope, which may only read, and deleted
 * under each tenant's own binding, the same shape as connection recovery. Safe to run
 * in several scheduler instances: the delete is idempotent. One run handles a bounded
 * number of tenants, and the next run takes up whatever is left.
 */
export async function purgeExpiredMetrics(pool: Pool, now: Date, tenantLimit = 500): Promise<number> {
  const cutoff = new Date(retentionStart(now));
  const tenants = await withPlatformScope(pool, (tx) =>
    tx.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM tenant_metric_buckets WHERE bucket_start < $1 LIMIT $2`,
      [cutoff, tenantLimit],
    ),
  );
  let deleted = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    const result = await withTenant(pool, tenantId, (tx) =>
      tx.query(`DELETE FROM tenant_metric_buckets WHERE tenant_id = app.current_tenant_id() AND bucket_start < $1`, [cutoff]),
    );
    deleted += result.rowCount;
  }
  return deleted;
}
