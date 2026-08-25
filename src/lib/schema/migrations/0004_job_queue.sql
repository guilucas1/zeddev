-- The job queue: durable, tenant-fair background work, carried by the same
-- PostgreSQL instance as everything else.
--
-- WHY THIS IS A TABLE AND NOT A BROKER
-- `cost-efficient-operation.md` AC6 requires that "no meaningful fixed cost is
-- being incurred solely to keep the platform available for future onboarding".
-- A dedicated broker is exactly such a cost: it is always on, it is charged
-- whether or not a tenant exists, and it is a second thing that has to be made
-- identical across a laptop, a VPS, and a managed cloud. A table in the store
-- that already exists costs nothing when empty, and LISTEN/NOTIFY lets a worker
-- sleep rather than poll, so an idle deployment does no work at all.
--
-- WHY THE PAYLOAD IS A SEPARATE TABLE
-- This is the load-bearing structural decision here, and it exists because of an
-- ordering constraint that cannot be designed away: a worker must select the next
-- job *before* it can know which tenant that job belongs to. The tenant is
-- derived from the job, exactly as at login the tenant is derived from the
-- account. So dispatch needs a scope that crosses tenants — and a scope that
-- crosses tenants must not be able to read message content.
--
-- Row-level security is row-level, not column-level, so "dispatch may read the
-- row but not the payload column" is not expressible. Splitting the payload into
-- its own table makes it expressible: `queue_jobs` carries a dispatch policy and
-- holds only routing metadata, and `queue_job_payloads` carries *no* dispatch
-- policy at all, so a payload can only ever be read inside a transaction bound to
-- its own tenant. This is the same move `tenant_secrets` makes against the
-- identity scope, and it means `tenant-data-isolation.md` AC2 ("no data from that
-- conversation appears in tenant B's ...") survives a bug in the dispatch loop
-- rather than depending on there being no bug.
--
-- WHY THERE IS NO PLATFORM POLICY ON ANY OF THESE TABLES
-- `tenant-data-isolation.md` AC7 gives the operator status and metrics, never
-- content. Queue depth is arguably a metric, but it is not needed yet, and the
-- default that keeps AC7 true as tables accumulate is "the operator cannot see
-- it". Adding a `FOR SELECT USING (app.has_platform_scope())` policy to
-- `queue_jobs` later is a one-line forward migration; retrofitting the absence of
-- one is not.


-- `app.dispatch_scope` — the fourth and, so far, last scope. Named after the
-- situation in which the tenant filter provably cannot apply, per the rule
-- established in 0001: a worker choosing the next job cannot bind a tenant it has
-- not yet discovered.
CREATE OR REPLACE FUNCTION app.has_dispatch_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT COALESCE(current_setting('app.dispatch_scope', true), '') = 'on' $fn$;


-- Global dispatch counter backing the round-robin cursor below. A single
-- sequence rather than timestamps because two dispatches in the same millisecond
-- would tie, and a tie in a fairness ordering is a tenant that can be starved.
CREATE SEQUENCE queue_dispatch_seq AS bigint START 1;


-- ---------------------------------------------------------------------------
-- queue_jobs
-- ---------------------------------------------------------------------------
-- Routing metadata only. Every column here is readable under the dispatch scope,
-- so every column here must be operational in the sense
-- `message-delivery-reliability.md` AC17 means: "error codes, timestamps, retry
-- counts" and no message content. That is why `partition_ref` and `dedupe_ref`
-- are digests rather than the keys they stand for — an end-customer's phone
-- number used as an ordering key would otherwise be sitting in a cross-tenant
-- readable column. `@zeddev/queue` hashes them on the way in, so the raw value
-- never reaches the database at all.
CREATE TABLE queue_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Constrained to an identifier shape because the notification trigger below
  -- concatenates it into a channel name, and LISTEN cannot take a bound
  -- parameter. The constraint is what makes that concatenation safe; the library
  -- applies the identical rule before it interpolates.
  queue         text        NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_]{0,39}$'),

  -- The handler to run. A developer-authored constant, never caller input.
  kind          text        NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),

  -- Enqueue order. Separate from `enqueued_at` because ordering must be a total
  -- order and a timestamp is not: two jobs written in the same transaction share
  -- `now()`, and per-partition FIFO would then be undefined between them.
  seq           bigint      NOT NULL GENERATED ALWAYS AS IDENTITY,

  -- Jobs sharing a (tenant, queue, partition_ref) are executed strictly one at a
  -- time in `seq` order. This is what `message-delivery-reliability.md` AC5
  -- ("processes and stores them in the order the end-customer actually sent
  -- them") needs from the queue layer. NULL means unordered, which is the right
  -- default: serialising work that has no ordering requirement only costs
  -- throughput.
  partition_ref text        CHECK (partition_ref ~ '^[0-9a-f]{64}$'),

  -- Enqueue idempotency. Deliberately NOT the inbound-redelivery suppression
  -- AC4 requires: that record has to outlive the job by design, and tying its
  -- lifetime to a queue row would make the retention of one govern the other.
  dedupe_ref    text        CHECK (dedupe_ref ~ '^[0-9a-f]{64}$'),

  state         text        NOT NULL DEFAULT 'ready'
                            CHECK (state IN ('ready', 'running', 'succeeded', 'dead')),
  attempt       int         NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts  int         NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),

  run_at        timestamptz NOT NULL DEFAULT now(),
  -- Server-assigned, never client-assigned. A worker whose clock runs fast would
  -- otherwise expire its own lease early and hand a job that is still executing
  -- to a second worker — a duplicate reply, which AC7 forbids.
  leased_until  timestamptz,

  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  -- Classification only, from the `@zeddev/errors` taxonomy. No message, because
  -- PostgreSQL's and the upstream platform's error prose quotes the data that
  -- caused the failure, and this row is readable across tenants.
  last_error_kind text      CHECK (length(last_error_kind) <= 40),
  last_error_code text      CHECK (length(last_error_code) <= 80),

  -- Lets `queue_job_payloads` carry a composite foreign key, which makes "a
  -- payload's tenant matches its job's tenant" a schema invariant rather than an
  -- application convention.
  UNIQUE (id, tenant_id)
);

-- Dispatch asks two questions: "does this tenant have anything ready in this
-- queue?" and then "which of its jobs is next?". Both are answered from here.
CREATE INDEX queue_jobs_ready_idx
  ON queue_jobs (queue, tenant_id, run_at, seq)
  WHERE state = 'ready';

-- The per-partition FIFO check, which is an anti-join on every dispatch and so is
-- the query most worth indexing precisely.
CREATE INDEX queue_jobs_partition_idx
  ON queue_jobs (tenant_id, queue, partition_ref, seq)
  WHERE partition_ref IS NOT NULL AND state IN ('ready', 'running');

-- Lease reclamation, and the per-tenant in-flight count used by the optional
-- concurrency cap.
CREATE INDEX queue_jobs_running_idx
  ON queue_jobs (queue, tenant_id, leased_until)
  WHERE state = 'running';

-- Retention sweeps.
CREATE INDEX queue_jobs_finished_idx
  ON queue_jobs (state, finished_at)
  WHERE state IN ('succeeded', 'dead');

-- Enqueue idempotency. Spans terminal states on purpose: re-enqueuing the key of
-- a job that already succeeded must be a no-op, not a second execution.
CREATE UNIQUE INDEX queue_jobs_dedupe_idx
  ON queue_jobs (tenant_id, queue, dedupe_ref)
  WHERE dedupe_ref IS NOT NULL;

ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY queue_jobs_own ON queue_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Three narrow dispatch policies rather than one `FOR ALL`, because there is no
-- situation in which dispatch should *create* a job. Enqueue is always performed
-- by a tenant-bound caller, so `tenant_id` on a new row is always the caller's
-- own and cannot be chosen. Omitting the INSERT half is how that is enforced.
CREATE POLICY queue_jobs_dispatch_read ON queue_jobs
  FOR SELECT USING (app.has_dispatch_scope());

CREATE POLICY queue_jobs_dispatch_update ON queue_jobs
  FOR UPDATE USING (app.has_dispatch_scope()) WITH CHECK (app.has_dispatch_scope());

CREATE POLICY queue_jobs_dispatch_purge ON queue_jobs
  FOR DELETE USING (app.has_dispatch_scope());

-- The dispatch UPDATE policy's WITH CHECK admits any row shape, which would let a
-- defect in the dispatch loop move a job between tenants. Nothing in the library
-- does that; this makes it impossible rather than merely unintended.
CREATE OR REPLACE FUNCTION app.queue_jobs_tenant_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'queue_jobs.tenant_id is immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER queue_jobs_tenant_immutable
  BEFORE UPDATE ON queue_jobs
  FOR EACH ROW EXECUTE FUNCTION app.queue_jobs_tenant_is_immutable();

-- Wakes a waiting consumer. The payload is empty and the channel names only the
-- queue, so a notification carries no tenant identity and no content — it says
-- "look again", nothing more.
--
-- The `run_at <= now()` guard matters: a job scheduled for the future is `ready`
-- but not yet claimable, and notifying on it would wake every consumer to find
-- nothing. Delayed work is reached by the consumer's timer instead.
CREATE OR REPLACE FUNCTION app.notify_queue_job() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('zeddev_queue_' || NEW.queue, '');
  RETURN NULL;
END $fn$;

CREATE TRIGGER queue_jobs_notify
  AFTER INSERT OR UPDATE OF state ON queue_jobs
  FOR EACH ROW WHEN (NEW.state = 'ready' AND NEW.run_at <= now())
  EXECUTE FUNCTION app.notify_queue_job();


-- ---------------------------------------------------------------------------
-- queue_job_payloads
-- ---------------------------------------------------------------------------
-- One row per live job, holding whatever the handler needs. Carries only a tenant
-- policy: no dispatch scope, no identity scope, no platform scope. See the header
-- for why that split is the whole point of this table existing.
--
-- The row is deleted the moment its job succeeds, so content lives exactly as
-- long as the work does. A dead job keeps its payload, because a job in the
-- dead-letter state exists to be inspected and replayed by its own tenant, and
-- replaying it without its input is not replaying it.
CREATE TABLE queue_job_payloads (
  job_id    uuid  PRIMARY KEY,
  tenant_id uuid  NOT NULL,
  payload   jsonb NOT NULL,
  FOREIGN KEY (job_id, tenant_id) REFERENCES queue_jobs (id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE queue_job_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_job_payloads FORCE ROW LEVEL SECURITY;

CREATE POLICY queue_job_payloads_own ON queue_job_payloads
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- queue_dispatch_cursors
-- ---------------------------------------------------------------------------
-- The fairness mechanism. One row per (queue, tenant), holding the value of
-- `queue_dispatch_seq` at that tenant's most recent dispatch; dispatch always
-- prefers the tenant with the lowest value among those that have ready work, and
-- bumps it on the way out. A tenant that was just served therefore goes to the
-- back of the line.
--
-- WHY THIS IS A REQUIREMENT AND NOT AN OPTIMISATION
-- `message-delivery-reliability.md` AC16: "Given one tenant's message path is
-- experiencing a failure, backlog, or traffic surge, when another tenant's
-- messages are processed during the same period, then the other tenant's
-- processing latency and success rate are unaffected." A single global FIFO — the
-- obvious implementation, and what `ORDER BY seq LIMIT 1` gives you — fails that
-- outright: ten thousand queued jobs for one tenant sit in front of every other
-- tenant's next message. `cost-efficient-operation.md` forbids the other obvious
-- answer, a dedicated queue per tenant, because that is per-tenant fixed
-- infrastructure. Fair scheduling within shared capacity is what is left, and no
-- spec names an algorithm because the outcome is what binds.
--
-- The row is created at enqueue time, not at first dispatch, so that a tenant
-- that has never been served is visible to the dispatch ordering with a cursor of
-- zero — that is, first in line.
CREATE TABLE queue_dispatch_cursors (
  queue             text   NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_]{0,39}$'),
  tenant_id         uuid   NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  last_dispatch_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (queue, tenant_id)
);

ALTER TABLE queue_dispatch_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_dispatch_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY queue_dispatch_cursors_own ON queue_dispatch_cursors
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY queue_dispatch_cursors_dispatch_read ON queue_dispatch_cursors
  FOR SELECT USING (app.has_dispatch_scope());

CREATE POLICY queue_dispatch_cursors_dispatch_update ON queue_dispatch_cursors
  FOR UPDATE USING (app.has_dispatch_scope()) WITH CHECK (app.has_dispatch_scope());

CREATE POLICY queue_dispatch_cursors_dispatch_purge ON queue_dispatch_cursors
  FOR DELETE USING (app.has_dispatch_scope());
