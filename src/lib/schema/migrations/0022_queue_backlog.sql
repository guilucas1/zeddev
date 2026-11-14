-- How much work is waiting on the job queue, for the operator, as counts only
-- (`component-independence.md` AC9: "down or degraded").
--
-- WHY THIS EXISTS
-- A heartbeat (0021) proves a process is alive, not that it is doing its work. A
-- conversation worker whose consumer is stuck, or too few workers for the traffic,
-- still reports itself every 15 s and reads as `up`, while customers' messages sit
-- unanswered. The age of the oldest job that could run and has not is what shows
-- it, and only the queue knows that.
--
-- WHY A FUNCTION AND NOT A PLATFORM POLICY ON `queue_jobs`
-- 0004 said a platform policy on `queue_jobs` would be a one-line migration. It
-- would also be a leak. `partition_ref` is SHA-256 of the tenant id and the
-- end-customer's phone number with no secret key, and the tenant id is in the same
-- row, so anyone who can read the row can recover the phone number by trying every
-- number in a country's plan. The dispatch scope can read it because a worker has
-- to; the operator must not (`tenant-data-isolation.md` AC7).
--
-- So the operator gets this function and nothing else: it refuses unless the
-- platform scope is held, reads `queue_jobs` under the dispatch scope for its own
-- duration only (it sets the scope itself and puts the previous value back before
-- returning, so the caller never holds it), and returns aggregates per queue. Its result
-- has no tenant id, no partition, no job id, and no error code, because the shape is
-- fixed here, in the database, rather than by whatever query a future route writes.
--
-- This grants nothing new. The application role can already set any `app.*` scope
-- for itself; scopes protect against an application bug reaching the wrong rows,
-- and this keeps that protection by confining the crossing to one fixed query.
--
-- WHAT IS COUNTED
-- `due`: ready, its time has come, and nothing earlier in its partition is still
-- ready or running, which is exactly what the claim query (`@zeddev/queue`) would
-- take next. A later message from the same customer waiting behind a turn being
-- answered is not backlog, it is ordering (`message-delivery-reliability.md` AC5),
-- so it is not counted as due. A per-tenant concurrency cap is a worker setting the
-- database does not know, so a tenant held at its cap still counts: its customers
-- are waiting all the same, and `tenants_waiting` shows when it is only one tenant.
-- `scheduled`: ready but not yet due (a turn still inside its quiet period, a retry
-- in its backoff). `expired_leases`: running past its lease, which a live consumer
-- sweeps back to ready, so one that stays is another sign nobody is consuming. A
-- lease "until T" is expired at T, as in both queue adapters.
-- `dead_last_day`: jobs that ran out of attempts in the last 24 hours.

CREATE OR REPLACE FUNCTION app.queue_backlog()
  RETURNS TABLE (
    queue                   text,
    due                     bigint,
    oldest_due_at           timestamptz,
    tenants_waiting         bigint,
    scheduled               bigint,
    running                 bigint,
    expired_leases          bigint,
    oldest_expired_lease_at timestamptz,
    dead_last_day           bigint
  )
  LANGUAGE plpgsql VOLATILE
AS $fn$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.dispatch_scope', true);
BEGIN
  IF NOT app.has_platform_scope() THEN
    RAISE EXCEPTION 'the queue backlog is read under the platform scope only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Not a `SET app.dispatch_scope = 'on'` clause on the function, which would be
  -- tidier: PostgreSQL lets only a superuser attach a custom setting to a function,
  -- and the migration role is deliberately not one. RETURN QUERY runs the query to
  -- completion before the next statement, so the scope is put back before this
  -- function returns. On an error the transaction (or the caller's savepoint) is
  -- rolled back, which reverts the setting with it.
  PERFORM set_config('app.dispatch_scope', 'on', true);

  RETURN QUERY
  SELECT j.queue,
         count(*) FILTER (WHERE j.claimable),
         min(j.run_at) FILTER (WHERE j.claimable),
         count(DISTINCT j.tenant_id) FILTER (WHERE j.claimable),
         count(*) FILTER (WHERE j.state = 'ready' AND j.run_at > now()),
         count(*) FILTER (WHERE j.state = 'running'),
         count(*) FILTER (WHERE j.state = 'running' AND j.leased_until <= now()),
         min(j.leased_until) FILTER (WHERE j.state = 'running' AND j.leased_until <= now()),
         count(*) FILTER (WHERE j.state = 'dead')
    FROM (
      SELECT q.queue, q.tenant_id, q.state, q.run_at, q.leased_until,
             (q.state = 'ready'
              AND q.run_at <= now()
              AND (q.partition_ref IS NULL
                   OR NOT EXISTS (
                        SELECT 1 FROM queue_jobs b
                         WHERE b.tenant_id = q.tenant_id
                           AND b.queue = q.queue
                           AND b.partition_ref = q.partition_ref
                           AND b.state IN ('ready', 'running')
                           AND b.seq < q.seq))) AS claimable
        FROM queue_jobs q
       WHERE q.state IN ('ready', 'running')
          OR (q.state = 'dead' AND q.finished_at >= now() - interval '1 day')
    ) j
   GROUP BY j.queue
   ORDER BY j.queue;

  PERFORM set_config('app.dispatch_scope', COALESCE(previous, ''), true);
END
$fn$;
