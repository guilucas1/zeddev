/**
 * Automatic recovery of an interrupted connection — the half of
 * `whatsapp-number-connection.md` that needs a timer.
 *
 * `delivery.ts` in `@zeddev/conversation` moves a connection to `reconnecting`
 * when a send fails for a recoverable reason, and back when a later send succeeds.
 * That leaves two holes this module closes: a tenant with no traffic never tries
 * again, and nothing ever gives up (AC6).
 *
 * ## The shape of one attempt
 *
 * The same three phases as every other call to Meta: a short transaction that
 * claims the attempt and unseals the token, the network calls outside any
 * transaction, then a second short transaction that records the answer. A database
 * connection is never held across a third party's latency.
 *
 * The claim advances `recovery_next_at`, and that is the only coordination there
 * is. Several scheduler instances may sweep at once, and whichever commits its
 * claim first owns the attempt; there is no leader to elect and nothing to fail
 * over.
 *
 * ## What is counted
 *
 * An attempt is counted when it is settled, and only if the answer was a
 * recoverable failure. So a scheduler that dies mid-probe spends nothing, and
 * neither does a defect in this platform: such a failure says nothing about the
 * client's link, and exhausting their allowance over it would take a healthy bot
 * off the air over a local bug. The exception is logged instead, and stays visible
 * to the operator as a connection that never leaves `reconnecting`.
 *
 * ## [DECISION] An attempt budget, not a time window
 *
 * The spec leaves the bound to implementation. A window would run down while the
 * platform itself is off — a laptop asleep overnight would wake to every
 * interrupted tenant in `error`, which is terminal until the client reconnects by
 * hand. An attempt budget only spends what was actually tried.
 *
 * ## What a recovered probe does and does not prove
 *
 * That the token is live, the number is reachable, the business is not blocked,
 * and the webhook subscription is in place — re-establishing it if it lapsed, the
 * one repair available from this side. It does not send a message: there is nobody
 * to send one to, and it would cost money. So a number that is only rate limited
 * returns to `connected` while its sends are still being throttled, and the next
 * refused send moves it back. That is the right reading of the vocabulary, because
 * a throughput limit is not a broken link and readiness holds through both states.
 */

import { withPlatformScope, withTenant, type Connection, type Pool } from '@zeddev/db';
import { DefectError, NotFoundError } from '@zeddev/errors';
import type { Logger } from '@zeddev/logging';
import type { SecretSealer } from '@zeddev/secrets';
import type { Backoff } from '@zeddev/time';
import {
  CLOUD_RECOVERABLE_REASONS,
  probeCloudLink,
  type CloudCredentials,
  type CloudLinkProbe,
  type WhatsAppCloud,
} from './cloud.ts';
import { transitionConnection, type ConnectionErrorReason } from './connection.ts';
import { loadCloudCredentials } from './onboarding.ts';

/** Who `secret_access_records` names when a probe unseals a tenant's token. */
export const RECOVERY_PRINCIPAL = 'system:connection-recovery';

export const RECOVERY_LIMITS = {
  /**
   * Connections looked at per sweep. Oldest due first, so a backlog larger than
   * this drains over several sweeps instead of starving anybody.
   */
  batchSize: 100,
  /**
   * Probes in flight at once. Each is a handful of Graph calls, so this bounds how
   * long a sweep can take during a Meta outage, when every call runs to its timeout.
   */
  concurrency: 4,
} as const;

export interface RecoveryPolicy {
  /** Recoverable failures before the connection falls to `error`. */
  readonly maxAttempts: number;
  /** The wait after a failure, given how many have now happened. */
  readonly backoff: Backoff;
}

export type RecoveryClaim =
  | { readonly status: 'ready'; readonly credentials: CloudCredentials }
  /** Another instance took it, the state moved on, or it is not due yet. */
  | { readonly status: 'not_due' }
  /** There is nothing to probe with. Already settled as `error`. */
  | { readonly status: 'unrecoverable' };

/** What became of one connection in a sweep. */
export const RECOVERY_VERDICTS = [
  'recovered',
  'failed',
  'exhausted',
  'retrying',
  'superseded',
  'not_due',
  'unrecoverable',
  'defect',
] as const;
export type RecoveryVerdict = (typeof RECOVERY_VERDICTS)[number];
export type RecoverySweep = Readonly<Record<RecoveryVerdict, number>>;

function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'whatsapp.tenant_unbound' });
  }
}

/**
 * The tenants whose connection is due a probe.
 *
 * The one cross-tenant read here, and it returns ids and nothing else. The tenant
 * has to be discovered before it can be bound, and this is the connection-health
 * carve-out `tenant-data-isolation.md` AC7 already names; everything after this
 * runs under that tenant's own binding.
 */
export async function listConnectionsDueForRecovery(pool: Pool, limit: number): Promise<readonly string[]> {
  const result = await withPlatformScope(pool, (tx) =>
    tx.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM whatsapp_connections
        WHERE state = 'reconnecting' AND (recovery_next_at IS NULL OR recovery_next_at <= now())
        ORDER BY recovery_next_at NULLS FIRST
        LIMIT $1`,
      [limit],
    ),
  );
  return result.rows.map((row) => row.tenant_id);
}

/**
 * Take one attempt, if it is still there to take.
 *
 * The condition is judged again here under the row lock, because the list above
 * was read in another transaction and may be stale by now. A wait of the backoff's
 * delay is written up front, which is both the claim and the pacing: it stands
 * whether the attempt goes on to succeed, fail, or never report back.
 */
export async function claimRecoveryProbe(
  connection: Connection,
  sealer: SecretSealer,
  policy: RecoveryPolicy,
): Promise<RecoveryClaim> {
  requireTenant(connection, 'claimRecoveryProbe');
  const locked = await connection.query<{ recovery_attempts: number }>(
    `SELECT recovery_attempts FROM whatsapp_connections
      WHERE tenant_id = app.current_tenant_id() AND state = 'reconnecting'
        AND (recovery_next_at IS NULL OR recovery_next_at <= now())
        FOR UPDATE`,
  );
  const row = locked.rows[0];
  if (row === undefined) return { status: 'not_due' };

  let credentials: CloudCredentials;
  try {
    credentials = await loadCloudCredentials(connection, sealer, { principal: RECOVERY_PRINCIPAL });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // No number or no token, and waiting will not produce one. The client has to
    // connect it again, which is what this reason's description tells them.
    await transitionConnection(connection, 'error', { reason: 'configuration_invalid' });
    return { status: 'unrecoverable' };
  }

  await connection.query(
    `UPDATE whatsapp_connections
        SET recovery_next_at = now() + make_interval(secs => $1::double precision)
      WHERE tenant_id = app.current_tenant_id()`,
    [policy.backoff(row.recovery_attempts + 1) / 1000],
  );
  return { status: 'ready', credentials };
}

/**
 * Record what a probe found.
 *
 * Judged under the row lock against the state as it is now, because the client may
 * have disconnected or a send may have succeeded while the probe was out. Either
 * makes the answer about a stay in `reconnecting` that has already ended, and it is
 * dropped rather than applied.
 */
export async function settleRecoveryProbe(
  connection: Connection,
  probe: CloudLinkProbe,
  policy: RecoveryPolicy,
): Promise<RecoveryVerdict> {
  requireTenant(connection, 'settleRecoveryProbe');
  const locked = await connection.query<{ state: string; recovery_attempts: number }>(
    `SELECT state, recovery_attempts FROM whatsapp_connections
      WHERE tenant_id = app.current_tenant_id() FOR UPDATE`,
  );
  const row = locked.rows[0];
  if (row?.state !== 'reconnecting') return 'superseded';

  if (probe.ok) {
    await transitionConnection(connection, 'connected');
    return 'recovered';
  }
  if (!CLOUD_RECOVERABLE_REASONS.has(probe.reason)) {
    // Meta said no in a way retrying will not change, so the allowance is beside
    // the point: AC9's business verification and AC12's specific reason both need
    // the actual answer on the connection, not `recovery_exhausted` hours later.
    await transitionConnection(connection, 'error', { reason: probe.reason as ConnectionErrorReason });
    return 'failed';
  }

  const attempts = row.recovery_attempts + 1;
  if (attempts >= policy.maxAttempts) {
    await transitionConnection(connection, 'error', { reason: 'recovery_exhausted' });
    return 'exhausted';
  }
  await connection.query(
    `UPDATE whatsapp_connections SET recovery_attempts = $1 WHERE tenant_id = app.current_tenant_id()`,
    [attempts],
  );
  return 'retrying';
}

export interface RecoverySweepDependencies {
  readonly pool: Pool;
  readonly cloud: WhatsAppCloud;
  readonly sealer: SecretSealer;
  readonly policy: RecoveryPolicy;
  readonly logger?: Logger | undefined;
  /** Stops starting probes. Those in flight finish and are recorded. */
  readonly signal?: AbortSignal | undefined;
}

/** Probe every connection that is due, one failure never stopping the rest. */
export async function sweepConnectionRecovery(deps: RecoverySweepDependencies): Promise<RecoverySweep> {
  const due = await listConnectionsDueForRecovery(deps.pool, RECOVERY_LIMITS.batchSize);
  const summary = Object.fromEntries(RECOVERY_VERDICTS.map((verdict) => [verdict, 0])) as Record<RecoveryVerdict, number>;

  let next = 0;
  const drain = async (): Promise<void> => {
    while (next < due.length && deps.signal?.aborted !== true) {
      const tenantId = due[next]!;
      next += 1;
      const verdict = await recoverOne(deps, tenantId);
      summary[verdict] += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECOVERY_LIMITS.concurrency, due.length) }, drain));
  return summary;
}

async function recoverOne(deps: RecoverySweepDependencies, tenantId: string): Promise<RecoveryVerdict> {
  try {
    const claim = await withTenant(deps.pool, tenantId, (tx) => claimRecoveryProbe(tx, deps.sealer, deps.policy));
    if (claim.status !== 'ready') return claim.status;
    const probe = await probeCloudLink(deps.cloud, claim.credentials);
    const verdict = await withTenant(deps.pool, tenantId, (tx) => settleRecoveryProbe(tx, probe, deps.policy));
    deps.logger?.info('whatsapp.recovery.settled', {
      tenantId,
      outcome: verdict,
      ...(probe.ok ? {} : { reason: probe.reason }),
    });
    return verdict;
  } catch (error) {
    deps.logger?.error('whatsapp.recovery.defect', error, { tenantId });
    return 'defect';
  }
}
