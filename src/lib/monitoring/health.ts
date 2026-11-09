/**
 * The operator's view across tenants — `operator-health-monitoring.md`.
 *
 * Everything here is read under the platform scope, from tables whose platform
 * policy is limited to connection health and counts. A defect in this file cannot
 * reach a transcript, because no policy would admit the read.
 *
 * There are two ways in, because they are asked at different rates. The connection
 * states are cheap, so a dashboard can poll them to stay current on its own (AC2).
 * The metrics sum many stored hours for every tenant, and are asked for when the
 * operator changes what they are looking at.
 */

import type { Connection } from '@zeddev/db';
import { DefectError, NotFoundError, ValidationError } from '@zeddev/errors';
import { isTenantId } from '@zeddev/tenancy';
import {
  CONNECTION_STATES,
  describeConnection,
  type ConnectionErrorReason,
  type ConnectionState,
  type ConnectionStatus,
} from '@zeddev/whatsapp';
import {
  assessHealth,
  METRIC_BASELINE_MS,
  NO_METRICS,
  parseMetricSelection,
  resolveMetricRange,
  summarizeMetrics,
  type HealthFlags,
  type MetricRange,
  type MetricSelection,
  type MetricTotals,
  type TenantMetrics,
} from './metrics.ts';

/** How many of a tenant's connection changes the detail view carries. */
export const TRANSITION_HISTORY_LIMIT = 100;

export const TENANT_HEALTH_SORTS = [
  'businessName',
  'connectionState',
  'errorRate',
  'messagesReceived',
  'messagesSent',
  'averageResponseMs',
] as const;
export type TenantHealthSort = (typeof TENANT_HEALTH_SORTS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** `not_connected` is the filter AC5 names: every state in which messages cannot flow. */
export type ConnectionFilter = ConnectionState | 'not_connected';

export interface TenantHealthQuery {
  readonly selection: MetricSelection;
  readonly connection: ConnectionFilter | undefined;
  readonly sortBy: TenantHealthSort;
  readonly sortDirection: SortDirection;
}

export function parseTenantHealthInput(body: Readonly<Record<string, unknown>>): TenantHealthQuery {
  const issues: { key: string; reason: string }[] = [];
  const selection = parseMetricSelection(body, issues);

  let connection: ConnectionFilter | undefined;
  if (body.connection !== undefined) {
    if (body.connection === 'not_connected' || CONNECTION_STATES.includes(body.connection as ConnectionState)) {
      connection = body.connection as ConnectionFilter;
    } else {
      issues.push({ key: 'connection', reason: `must be not_connected or one of ${CONNECTION_STATES.join(', ')}` });
    }
  }

  let sortBy: TenantHealthSort = 'businessName';
  if (body.sortBy !== undefined) {
    if (TENANT_HEALTH_SORTS.includes(body.sortBy as TenantHealthSort)) sortBy = body.sortBy as TenantHealthSort;
    else issues.push({ key: 'sortBy', reason: `must be one of ${TENANT_HEALTH_SORTS.join(', ')}` });
  }

  let sortDirection: SortDirection = 'asc';
  if (body.sortDirection !== undefined) {
    if (SORT_DIRECTIONS.includes(body.sortDirection as SortDirection)) sortDirection = body.sortDirection as SortDirection;
    else issues.push({ key: 'sortDirection', reason: `must be one of ${SORT_DIRECTIONS.join(', ')}` });
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return { selection, connection, sortBy, sortDirection };
}

export function parseTenantDetailInput(body: Readonly<Record<string, unknown>>): {
  readonly tenantId: string;
  readonly selection: MetricSelection;
} {
  const issues: { key: string; reason: string }[] = [];
  const selection = parseMetricSelection(body, issues);
  const tenantId = body.tenantId;
  if (typeof tenantId !== 'string' || !isTenantId(tenantId)) issues.push({ key: 'tenantId', reason: 'must be a tenant id' });
  if (issues.length > 0) throw new ValidationError(issues);
  return { tenantId: tenantId as string, selection };
}

/** An unscoped read sees no tenants, which would render as an empty platform. */
async function requirePlatformScope(connection: Connection, operation: string): Promise<void> {
  const scope = await connection.query<{ on: boolean }>('SELECT app.has_platform_scope() AS on');
  if (scope.rows[0]?.on !== true) {
    throw new DefectError(`${operation} requires the platform scope`, { code: 'monitoring.platform_scope_required' });
  }
}

interface TenantRow {
  tenant_id: string;
  business_name: string;
  provisioning_state: string;
  created_at: Date;
  state: ConnectionState | null;
  error_reason: ConnectionErrorReason | null;
  last_known_good_at: Date | null;
  changed_at: Date | null;
}

/** From `tenants` outward, so a tenant that never connected a number is still listed (AC1, AC10). */
const TENANT_SELECT = `
  SELECT t.id AS tenant_id, t.business_name, t.provisioning_state, t.created_at,
         c.state, c.error_reason, c.last_known_good_at, c.changed_at
    FROM tenants t
    LEFT JOIN whatsapp_connections c ON c.tenant_id = t.id`;

function connectionStatus(row: TenantRow): ConnectionStatus {
  return {
    state: row.state ?? 'disconnected',
    errorReason: row.error_reason,
    lastKnownGoodAt: row.last_known_good_at,
    changedAt: row.changed_at,
  };
}

function describeCurrent(status: ConnectionStatus): Omit<ReturnType<typeof describeConnection>, 'history'> {
  const { history: _history, ...current } = describeConnection(status);
  return current;
}

/** Every tenant's connection and nothing else: what a dashboard polls to stay current. */
export async function listConnectionHealth(connection: Connection): Promise<
  readonly ({ readonly tenantId: string } & ReturnType<typeof describeCurrent>)[]
> {
  await requirePlatformScope(connection, 'listConnectionHealth');
  const tenants = await connection.query<TenantRow>(`${TENANT_SELECT} ORDER BY t.created_at, t.id`);
  return tenants.rows.map((row) => ({ tenantId: row.tenant_id, ...describeCurrent(connectionStatus(row)) }));
}

/** The summed columns. Fixed names, never input. */
const COUNT_COLUMNS = [
  ['messages_received', 'messagesReceived'],
  ['messages_sent', 'messagesSent'],
  ['turns_answered', 'turnsAnswered'],
  ['responses_failed', 'failedResponses'],
  ['deliveries_failed', 'failedDeliveries'],
  ['deliveries_expired', 'expiredDeliveries'],
  ['responses_timed', 'responsesTimed'],
  ['response_ms_total', 'responseMsTotal'],
] as const satisfies readonly (readonly [string, keyof MetricTotals])[];

interface PeriodTotals {
  readonly current: MetricTotals;
  readonly baseline: MetricTotals;
}

function totalsFrom(row: Record<string, unknown>, prefix: string): MetricTotals {
  const entries = COUNT_COLUMNS.map(([column, field]) => [field, Number(row[`${prefix}${column}`] ?? 0)] as const);
  return Object.fromEntries(entries) as unknown as MetricTotals;
}

/**
 * Sum the stored hours of the range and of the week before it.
 *
 * A tenant with no activity has no rows and so no entry here; the caller supplies
 * zero for it, which is what makes AC11 hold for every tenant that was quiet.
 * Each sum is cast because SUM over bigint is numeric, which decodes to a string.
 */
async function loadTotals(
  connection: Connection,
  range: MetricRange,
  tenantId: string | undefined,
): Promise<ReadonlyMap<string, PeriodTotals>> {
  const inRange = 'bucket_start >= $1 AND bucket_start < $2';
  const inBaseline = 'bucket_start >= $3 AND bucket_start < $1';
  const columns = COUNT_COLUMNS.flatMap(([column]) => [
    `SUM(${column}) FILTER (WHERE ${inRange})::bigint AS current_${column}`,
    `SUM(${column}) FILTER (WHERE ${inBaseline})::bigint AS baseline_${column}`,
  ]).join(',\n           ');
  const result = await connection.query<Record<string, unknown> & { tenant_id: string }>(
    `SELECT tenant_id,
           ${columns}
       FROM tenant_metric_buckets
      WHERE bucket_start >= $3 AND bucket_start < $2
        AND ($4::uuid IS NULL OR tenant_id = $4::uuid)
      GROUP BY tenant_id`,
    [range.from, range.to, new Date(range.from.getTime() - METRIC_BASELINE_MS), tenantId ?? null],
  );
  return new Map(
    result.rows.map((row) => [row.tenant_id, { current: totalsFrom(row, 'current_'), baseline: totalsFrom(row, 'baseline_') }]),
  );
}

function describeRange(range: MetricRange): {
  readonly from: string;
  readonly to: string;
  readonly available: boolean;
  readonly retainedSince: string;
} {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    available: range.available,
    retainedSince: range.retainedSince.toISOString(),
  };
}

export type RangeDescription = ReturnType<typeof describeRange>;

export interface TenantHealth {
  readonly tenantId: string;
  readonly businessName: string;
  readonly provisioningState: string;
  readonly onboardedAt: string;
  readonly connection: ReturnType<typeof describeCurrent>;
  /** Null when the range is past retention (AC8): unknown, and not zero. */
  readonly metrics: TenantMetrics | null;
  readonly health: HealthFlags | null;
}

function describeTenant(row: TenantRow, range: MetricRange, totals: PeriodTotals | undefined): TenantHealth {
  const measured = range.available ? (totals ?? { current: NO_METRICS, baseline: NO_METRICS }) : undefined;
  return {
    tenantId: row.tenant_id,
    businessName: row.business_name,
    provisioningState: row.provisioning_state,
    onboardedAt: row.created_at.toISOString(),
    connection: describeCurrent(connectionStatus(row)),
    metrics: measured === undefined ? null : summarizeMetrics(measured.current),
    health: measured === undefined ? null : assessHealth(measured.current, measured.baseline),
  };
}

/** Worst first when ascending: the order that puts what needs attention at the top. */
const CONNECTION_SEVERITY: Readonly<Record<ConnectionState, number>> = {
  error: 0,
  reconnecting: 1,
  connecting: 2,
  disconnected: 3,
  connected: 4,
};

function sortValue(tenant: TenantHealth, by: TenantHealthSort): number | string | null {
  switch (by) {
    case 'businessName':
      return tenant.businessName;
    case 'connectionState':
      return CONNECTION_SEVERITY[tenant.connection.state];
    default:
      return tenant.metrics?.[by] ?? null;
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order the tenants.
 *
 * A tenant with no value to sort by goes last in either direction. It has no rate
 * because it had no traffic, and sorting descending to find the worst must not start
 * with the quiet ones. Ties fall back to the name so that the order is stable between
 * refreshes.
 */
export function sortTenantHealth(
  tenants: readonly TenantHealth[],
  by: TenantHealthSort,
  direction: SortDirection,
): readonly TenantHealth[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...tenants].sort((a, b) => {
    const left = sortValue(a, by);
    const right = sortValue(b, by);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const order = compareValues(left, right);
      if (order !== 0) return sign * order;
    }
    return compareValues(a.businessName, b.businessName) || compareValues(a.tenantId, b.tenantId);
  });
}

function matchesConnection(tenant: TenantHealth, filter: ConnectionFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter === 'not_connected') return tenant.connection.state !== 'connected';
  return tenant.connection.state === filter;
}

/**
 * Every tenant, with its connection and its numbers for the range.
 *
 * No paging, deliberately: the spec forbids a tenant being omitted from this view, and
 * the sort and filter are over derived values, so a page of them would need all of
 * them computed anyway.
 */
export async function listTenantHealth(
  connection: Connection,
  query: TenantHealthQuery,
  now: Date,
): Promise<{ readonly range: RangeDescription; readonly tenants: readonly TenantHealth[] }> {
  await requirePlatformScope(connection, 'listTenantHealth');
  const range = resolveMetricRange(query.selection, now);
  const tenants = await connection.query<TenantRow>(TENANT_SELECT);
  const totals = range.available ? await loadTotals(connection, range, undefined) : new Map<string, PeriodTotals>();
  const described = tenants.rows
    .map((row) => describeTenant(row, range, totals.get(row.tenant_id)))
    .filter((tenant) => matchesConnection(tenant, query.connection));
  return { range: describeRange(range), tenants: sortTenantHealth(described, query.sortBy, query.sortDirection) };
}

/** One tenant in depth: the same numbers, plus how its connection got here. */
export async function readTenantHealth(
  connection: Connection,
  tenantId: string,
  selection: MetricSelection,
  now: Date,
): Promise<{
  readonly range: RangeDescription;
  readonly tenant: TenantHealth;
  readonly transitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly errorReason: string | null;
    readonly occurredAt: string;
  }[];
}> {
  await requirePlatformScope(connection, 'readTenantHealth');
  const range = resolveMetricRange(selection, now);
  const tenants = await connection.query<TenantRow>(`${TENANT_SELECT} WHERE t.id = $1`, [tenantId]);
  const row = tenants.rows[0];
  if (row === undefined) throw new NotFoundError('tenant');
  const totals = range.available ? await loadTotals(connection, range, tenantId) : new Map<string, PeriodTotals>();
  const history = await connection.query<{
    from_state: string;
    to_state: string;
    error_reason: string | null;
    occurred_at: Date;
  }>(
    `SELECT from_state, to_state, error_reason, occurred_at
       FROM whatsapp_connection_transitions
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [tenantId, TRANSITION_HISTORY_LIMIT],
  );
  return {
    range: describeRange(range),
    tenant: describeTenant(row, range, totals.get(tenantId)),
    transitions: history.rows.map((entry) => ({
      from: entry.from_state,
      to: entry.to_state,
      errorReason: entry.error_reason,
      occurredAt: entry.occurred_at.toISOString(),
    })),
  };
}
