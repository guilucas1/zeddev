/**
 * Which of the platform's components are running (`component-independence.md` AC9).
 *
 * The API and the gateway answer HTTP probes, but the conversation worker and the
 * scheduler listen on no port, so nothing can ask them whether they are alive. Each
 * process therefore reports itself on a timer (`startHeartbeat`), one row per
 * process in `component_heartbeats` (migration 0021), and the operator's component
 * view (`readComponentStatus`) reads those rows back and names what is down.
 *
 * Lateness is judged by the database's clock on both sides, so processes on
 * different hosts, with clocks that disagree, are still judged consistently.
 *
 * A heartbeat proves a process is alive, not that it is doing its work, so the
 * report also carries the job queue's backlog, as counts (`app.queue_backlog()`,
 * migration 0022). A component that is reporting while the queue it consumes has
 * work waiting past `BACKLOG.stalledAfterMs` reads as `degraded`, reason `backlog`:
 * a stuck consumer, or too few workers for the traffic.
 *
 * The reporter never throws and never stops its service. A heartbeat that cannot
 * be written means the database is unreachable, which the service will notice on
 * its own; taking the service down for it would turn one component's outage into
 * two (`component-independence.md`).
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withHeartbeatScope, type Connection, type Pool } from '@zeddev/db';
import type { Logger } from '@zeddev/logging';
import { INBOUND_QUEUE } from '@zeddev/whatsapp';

/**
 * The components that report themselves. Mirrored by a CHECK in migration 0021; a
 * test asserts the two agree. `web` is not here: it has no database settings, and
 * whether it is up is answered by whether the dashboard loads at all.
 */
export const COMPONENTS = ['api', 'whatsapp-gateway', 'conversation-worker', 'scheduler'] as const;
export type Component = (typeof COMPONENTS)[number];

export const HEARTBEAT = {
  /** How often a process reports. The operator dashboard polls at the same cadence. */
  intervalMs: 15_000,
  /**
   * How many reports in a row a process may miss before it is called silent. One
   * missed report is a slow transaction or a busy event loop, not an outage.
   */
  missedBeats: 3,
  /**
   * How long a process that stopped reporting is remembered. Long enough to see
   * over a weekend that something died; short enough that restarts do not pile up.
   * Pruned by each process as it starts, so it needs no scheduler.
   */
  retentionMs: 7 * 24 * 3_600_000,
  /** The newest instances shown per component. A restart loop must not flood the view. */
  instancesShown: 20,
} as const;

/**
 * Which component consumes each queue, so that work waiting on a queue is charged to
 * the component that should be taking it. Every consumed queue is always reported,
 * with zeros when it is empty, so an operator sees it is being watched.
 */
export const QUEUE_CONSUMERS: Readonly<Record<string, Component>> = {
  [INBOUND_QUEUE]: 'conversation-worker',
};

export const BACKLOG = {
  /**
   * How long work that could run may wait before its consumer reads as degraded.
   * A healthy consumer takes a due job within milliseconds (it is woken by NOTIFY,
   * by the due time, and by a lease running out), and a busy one sweeps expired
   * leases every 30 s, so a minute is beyond any healthy wait while still well
   * inside what a customer would notice.
   */
  stalledAfterMs: 60_000,
} as const;

/** One queue's waiting work, as counts. Nothing here names a tenant, a customer, or a job. */
export interface QueueBacklog {
  readonly queue: string;
  /** The component that should be taking this work, or `null` for a queue nothing here consumes. */
  readonly consumer: Component | null;
  /** Ready, due, and first in its partition: what a consumer would take next. */
  readonly due: number;
  readonly tenantsWaiting: number;
  /** Ready but not yet due: a turn inside its quiet period, a retry in its backoff. */
  readonly scheduled: number;
  readonly running: number;
  /** Running past its lease and not yet taken back by any consumer. */
  readonly expiredLeases: number;
  readonly deadLastDay: number;
  /**
   * Since when the longest-waiting work has been waiting: the oldest due job's due
   * time or the oldest expired lease's end, whichever is earlier. `null` when nothing waits.
   */
  readonly waitingSince: string | null;
  /** How long that is, by the database's clock. 0 when nothing waits. */
  readonly waitingMs: number;
  /** `waitingMs` has passed `BACKLOG.stalledAfterMs`. */
  readonly stalled: boolean;
}

/** A process the operator can see: running, shut down on purpose, or gone quiet without saying so. */
export type InstanceState = 'live' | 'stopped' | 'silent';

export interface InstanceStatus {
  readonly instanceId: string;
  readonly host: string;
  readonly state: InstanceState;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly stoppedAt: string | null;
}

/**
 * - `up`: at least one instance is reporting, and none that ran alongside it went quiet.
 * - `degraded`: some instance is reporting, but one that was running at the same time
 *   went quiet without shutting down and nothing has replaced it.
 * - `down`: nothing is reporting.
 */
export type ComponentState = 'up' | 'degraded' | 'down';

/**
 * Why a component is not `up`. `stopped`: its last instance shut down cleanly.
 * `silent`: its last instance stopped reporting without shutting down, which is a
 * crash, a hang, or a lost database. `never_reported`: no instance on record.
 * `instance_silent`: degraded, an instance went quiet. `backlog`: degraded, it is
 * reporting but work on the queue it consumes has waited past `BACKLOG.stalledAfterMs`.
 */
export type ComponentReason = 'stopped' | 'silent' | 'never_reported' | 'instance_silent' | 'backlog';

export interface ComponentStatus {
  readonly component: Component;
  readonly state: ComponentState;
  readonly reason: ComponentReason | null;
  /** Instances reporting now: a scaled component's current capacity. */
  readonly live: number;
  /** The newest report from any instance, or `null` when none is on record. */
  readonly lastSeenAt: string | null;
  /** Newest first, at most `HEARTBEAT.instancesShown`. */
  readonly instances: readonly InstanceStatus[];
}

export interface ComponentReport {
  /** The database's clock at the moment of reading, which every state was judged against. */
  readonly checkedAt: string;
  readonly components: readonly ComponentStatus[];
  /** Every queue with work in it, and every consumed queue even when empty, by name. */
  readonly queues: readonly QueueBacklog[];
}

export interface BacklogRow {
  queue: string;
  due: string | number;
  oldest_due_at: Date | null;
  tenants_waiting: string | number;
  scheduled: string | number;
  running: string | number;
  expired_leases: string | number;
  oldest_expired_lease_at: Date | null;
  dead_last_day: string | number;
}

export interface InstanceRow {
  instance_id: string;
  component: string;
  host: string;
  state: InstanceState;
  started_at: Date;
  last_seen_at: Date;
  stopped_at: Date | null;
}

/**
 * Every component's state, read under the platform scope the operator's
 * transaction already holds. Every component in `COMPONENTS` is answered, including
 * one that has never reported, since "nothing on record" is exactly what an
 * operator needs to see when a service was never started.
 */
export async function readComponentStatus(tx: Connection): Promise<ComponentReport> {
  const clock = await tx.query<{ now: Date }>('SELECT now() AS now');
  const rows = await tx.query<InstanceRow>(
    `SELECT instance_id, component, host, started_at, last_seen_at, stopped_at, state
       FROM (
         SELECT h.*,
                CASE
                  WHEN stopped_at IS NOT NULL THEN 'stopped'
                  WHEN last_seen_at >= now() - make_interval(secs => interval_ms * $1::int / 1000.0) THEN 'live'
                  ELSE 'silent'
                END AS state,
                row_number() OVER (PARTITION BY component ORDER BY last_seen_at DESC, instance_id) AS position
           FROM component_heartbeats h
       ) ranked
      WHERE position <= $2::int
      ORDER BY component, last_seen_at DESC, instance_id`,
    [HEARTBEAT.missedBeats, HEARTBEAT.instancesShown],
  );

  const byComponent = new Map<string, InstanceRow[]>();
  for (const row of rows.rows) {
    const list = byComponent.get(row.component) ?? [];
    list.push(row);
    byComponent.set(row.component, list);
  }

  const now = clock.rows[0]!.now;
  const backlog = await tx.query<BacklogRow>('SELECT * FROM app.queue_backlog()');
  const queues = describeBacklog(backlog.rows, now);

  return {
    checkedAt: now.toISOString(),
    components: COMPONENTS.map((component) =>
      withBacklog(summarize(component, byComponent.get(component) ?? []), queues),
    ),
    queues,
  };
}

/** Exported for tests: the database's counts, with every consumed queue present and each judged. */
export function describeBacklog(rows: readonly BacklogRow[], now: Date): QueueBacklog[] {
  const byQueue = new Map(rows.map((row) => [row.queue, row]));
  const names = [...new Set([...Object.keys(QUEUE_CONSUMERS), ...byQueue.keys()])].sort();
  return names.map((queue): QueueBacklog => {
    const row = byQueue.get(queue);
    const candidates = [row?.oldest_due_at, row?.oldest_expired_lease_at].filter((at): at is Date => at instanceof Date);
    const since = candidates.length === 0 ? null : new Date(Math.min(...candidates.map((at) => at.getTime())));
    const waitingMs = since === null ? 0 : Math.max(0, now.getTime() - since.getTime());
    return {
      queue,
      consumer: QUEUE_CONSUMERS[queue] ?? null,
      due: Number(row?.due ?? 0),
      tenantsWaiting: Number(row?.tenants_waiting ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      running: Number(row?.running ?? 0),
      expiredLeases: Number(row?.expired_leases ?? 0),
      deadLastDay: Number(row?.dead_last_day ?? 0),
      waitingSince: since?.toISOString() ?? null,
      waitingMs,
      stalled: waitingMs > BACKLOG.stalledAfterMs,
    };
  });
}

/**
 * Exported for tests. A reporting component whose queue is stalled is degraded. One
 * that is down stays down (nothing is consuming, and saying so is more specific), and
 * one already degraded by a silent instance keeps that reason, which names the cause.
 */
export function withBacklog(status: ComponentStatus, queues: readonly QueueBacklog[]): ComponentStatus {
  if (status.state !== 'up') return status;
  const stalled = queues.some((queue) => queue.consumer === status.component && queue.stalled);
  return stalled ? { ...status, state: 'degraded', reason: 'backlog' } : status;
}

/** Exported for tests: the rule for one component, given its instances newest first. */
export function summarize(component: Component, rows: readonly InstanceRow[]): ComponentStatus {
  const instances = rows.map(
    (row): InstanceStatus => ({
      instanceId: row.instance_id,
      host: row.host,
      state: row.state,
      startedAt: row.started_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      stoppedAt: row.stopped_at?.toISOString() ?? null,
    }),
  );
  const live = rows.filter((row) => row.state === 'live');
  const newest = rows[0];
  const base = { component, live: live.length, lastSeenAt: newest?.last_seen_at.toISOString() ?? null, instances };

  if (newest === undefined) return { ...base, state: 'down', reason: 'never_reported' };
  if (live.length === 0) return { ...base, state: 'down', reason: newest.state === 'stopped' ? 'stopped' : 'silent' };

  // A silent instance that was still reporting after a live one started ran
  // alongside it, so capacity was lost and nothing took its place. One whose last
  // report predates every live instance was replaced (a restart is a new instance),
  // and is history rather than a fault.
  const earliestLiveStart = Math.min(...live.map((row) => row.started_at.getTime()));
  const lostAlongside = rows.some(
    (row) => row.state === 'silent' && row.last_seen_at.getTime() > earliestLiveStart,
  );
  return lostAlongside ? { ...base, state: 'degraded', reason: 'instance_silent' } : { ...base, state: 'up', reason: null };
}

export interface HeartbeatOptions {
  readonly pool: Pool;
  readonly component: Component;
  readonly logger: Logger;
  /** Tests shorten it. Each process states its own, so readers need not share it. */
  readonly intervalMs?: number | undefined;
  /** Defaults to the machine's (in a container, the container's) host name. */
  readonly host?: string | undefined;
}

export interface Heartbeat {
  readonly instanceId: string;
  /** Stop reporting and record a clean shutdown. Call before the pool is closed. Idempotent; never throws. */
  stop(): Promise<void>;
}

/**
 * Report this process as alive, now and every `intervalMs` until stopped.
 *
 * The first report is awaited, so a service is visible as soon as it has started,
 * and it prunes instances long gone. A failed report is logged once per run of
 * failures, not once per beat, and the next beat simply tries again.
 */
export async function startHeartbeat(options: HeartbeatOptions): Promise<Heartbeat> {
  const { pool, component, logger } = options;
  const intervalMs = options.intervalMs ?? HEARTBEAT.intervalMs;
  const host = (options.host ?? hostname()).slice(0, 255) || 'unknown';
  const instanceId = randomUUID();
  let failing = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const beat = async (prune: boolean): Promise<void> => {
    try {
      await withHeartbeatScope(pool, async (tx) => {
        if (prune) {
          await tx.query(
            `DELETE FROM component_heartbeats WHERE last_seen_at < now() - make_interval(secs => $1::bigint / 1000.0)`,
            [HEARTBEAT.retentionMs],
          );
        }
        // An upsert, so a report after a pruning or a lost first write still lands.
        await tx.query(
          `INSERT INTO component_heartbeats (instance_id, component, host, interval_ms)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (instance_id) DO UPDATE SET last_seen_at = now()`,
          [instanceId, component, host, intervalMs],
        );
      });
      if (failing) logger.info('component.heartbeat.restored', { component });
      failing = false;
    } catch (error) {
      if (!failing) logger.error('component.heartbeat.failed', error, { component });
      failing = true;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = beat(false).then(schedule);
    }, intervalMs);
    // Never the reason a process stays up.
    timer.unref();
  };

  inFlight = beat(true);
  await inFlight;
  schedule();
  logger.info('component.heartbeat.started', { component, instanceId });

  let stopping: Promise<void> | undefined;
  return {
    instanceId,
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        await inFlight;
        try {
          await withHeartbeatScope(pool, (tx) =>
            tx.query(
              `UPDATE component_heartbeats SET last_seen_at = now(), stopped_at = now() WHERE instance_id = $1`,
              [instanceId],
            ),
          );
        } catch (error) {
          // Read as "silent" instead of "stopped", which is the honest answer
          // when the shutdown itself could not be recorded.
          logger.error('component.heartbeat.stop_failed', error, { component });
        }
      })();
      return stopping;
    },
  };
}
