# AGENTS.md

Operational reference only. Status, progress, and findings belong in `IMPLEMENTATION_PLAN.md`.

## Toolchain

- **Node.js >= 24** is required and is the whole toolchain. Node 24 runs `.ts` files
  directly via type stripping, so **there is no build step** and no bundler.
- **npm workspaces** (`src/lib/*`, `src/services/*`). No pnpm/yarn — pnpm is not installed.
- **`node:test`** is the test runner. No jest/vitest.
- TypeScript is used for typechecking only (`noEmit`).

## Commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `npm install` | Links workspaces. Required after adding a package under `src/lib/*` or `src/services/*`. |
| `npm test` | Runs the full suite with `--env-file-if-exists=.env.test`, so database settings are picked up automatically. |
| `npm run typecheck` | `tsc --noEmit`. Type errors do **not** fail `npm test` — type stripping ignores types — so this must be run separately. |
| `npm run db:up` | Starts a disposable PostgreSQL 17 container (`zeddev-pg`) on `127.0.0.1:55432` and adds its settings to `.env.test`. Required before `npm run check`. |
| `npm run db:down` | Removes the `zeddev-pg` container and its `.env.test` entries. |
| `npm run storage:up` | Starts a disposable MinIO container (`zeddev-minio`) on `127.0.0.1:59000` and adds its settings to `.env.test`. Required before `npm run check`. |
| `npm run storage:down` | Removes the `zeddev-minio` container and its `.env.test` entries. |
| `npm run mail:up` | Starts a disposable Mailpit container (`zeddev-mailpit`) with SMTP on `127.0.0.1:51025` and its message API on `127.0.0.1:58025`, and adds its settings to `.env.test`. Required before `npm run check`. |
| `npm run mail:down` | Removes the `zeddev-mailpit` container and its `.env.test` entries. |
| `npm run check` | `typecheck`, then requires PostgreSQL, object storage, and SMTP, then `test`. Use this as the gate before committing. Calls `scripts/require-services.ts`. |
| `npm run check:offline` | `typecheck` + `test` without any container. Does not cover `@zeddev/db`, `@zeddev/schema`, `@zeddev/storage`, or `@zeddev/mail`'s SMTP adapter. Only use when Docker is unavailable. |
| `npm run spec-coverage` | Prints which `specs/*.md` have covering tests and which have none. |
| `npm run config-reference` | Regenerates `docs/configuration.md` from the config schemas. A test fails the build if the committed file is stale. |
| `node src/services/api/main.ts` | Runs the API service. Reads every setting from the environment and refuses to start, listing every missing key. |
| `node src/services/api/cli.ts create-operator --email <addr>` | Creates the platform operator. Password is read from stdin. |
| `docker compose up -d` (add `--profile local-mail` on a laptop) | Runs the platform from `compose.yaml`. Needs a `.env` and `deploy/secrets/postgres-superuser-password` — see the header of `compose.yaml`. |

Run a single file with `node --test src/lib/<pkg>/index.test.ts`.

## Conventions that the tooling enforces

- **Relative imports need the `.ts` extension** (`./index.ts`). Node's resolver does
  not add it. Cross-package imports use the package name (`@zeddev/errors`).
- **`erasableSyntaxOnly` is on.** No `enum`, no `namespace`, no constructor parameter
  properties — type stripping cannot erase them. Use `as const` object literals instead of enums.
- **New workspace package**: create `src/lib/<name>/package.json` with
  `"exports": { ".": "./index.ts" }` and a `tsconfig.json` extending
  `../../../tsconfig.base.json`, add `@zeddev/testing` to `devDependencies`, then `npm install`.
- **Tests declare the spec they cover**: `specTest('<spec>.md', 'AC7 ...', 'name', fn)`.
  An unknown spec filename throws at definition time. Use `unitTest` for behavior not
  traceable to a spec criterion.
- `src/lib/testing/portability.test.ts` scans all non-test sources and fails the build on
  environment-tier branching, embedded hostnames/endpoints, or credential-shaped literals.
  Configuration is the only permitted way to vary behavior between deployments.
- **A new `Queue` implementation must pass the shared conformance suite.**
  `runQueueConformance(harness)` from `@zeddev/queue/testing` is the single definition of the
  port's semantics and runs against both the PostgreSQL adapter and the in-memory fake. Import
  `InMemoryQueue` only from `@zeddev/queue/testing`, never from `@zeddev/queue`.
- **A new `ObjectStore` implementation must pass the shared conformance suite.**
  `runStorageConformance(harness)` from `@zeddev/storage/testing` is the single definition of
  the port's semantics and runs against both the S3 adapter and the in-memory fake. Import
  `InMemoryObjectStore` only from `@zeddev/storage/testing`, never from `@zeddev/storage`.
- **A new `Mailer` implementation must pass the shared conformance suite.**
  `runMailConformance(harness)` from `@zeddev/mail/testing` is the single definition of the
  port's semantics and runs against both the SMTP adapter and the in-memory fake. Import
  `InMemoryMailer` only from `@zeddev/mail/testing`, never from `@zeddev/mail`.
- **Message bytes are built in exactly one place**: `buildMessage` in `src/lib/mail/message.ts`.
  Both adapters call it, which is what makes the fake's validation and encoding identical to the
  real one's. Do not let an adapter assemble headers itself.
- **A tenant id is validated in exactly one place**: `assertTenantId`/`normalizeTenantId` from
  `@zeddev/tenancy`. Do not re-derive the rule — in object storage a tenant id is a key path
  segment, so a value containing `/` silently relocates one tenant's object under another's prefix.
- **Identity rules live in `@zeddev/identity` and nowhere else.** Password strength
  (`assertPasswordStrength`), email canonicalisation (`assertEmail`/`normalizeEmail`), and the
  action→principal-type table (`ACTION_PRINCIPALS`) are each defined once. Signup, password change,
  and password reset all call the same strength check; a second copy would let the weakest of the
  three define the platform's actual policy.
- **A new permission means a new entry in `ACTION_PRINCIPALS`** in `src/lib/identity/principals.ts`.
  Adding an action without naming the principal type that holds it is a type error, and
  `principals.test.ts` asserts over the whole table rather than over examples.
- **Adding a `*_CONFIG_SCHEMA` to a package means registering it** in `PLATFORM_CONFIG_SCHEMAS`
  in `src/lib/deployment/index.ts` and running `npm run config-reference`. A test scans
  `src/lib` and `src/services` and fails the build otherwise.
- **Services live in `src/services/<name>`**; each needs its own `Dockerfile` and a
  `dockerfile: src/services/<name>/Dockerfile` entry in `compose.yaml` — a test in `@zeddev/deployment`
  enforces both. A service's own config schema lives in its `config.ts`, exported via a `./config`
  subpath, and is registered in `PLATFORM_CONFIG_SCHEMAS` like any library's.
- **A process entrypoint that is also imported by tests uses `if (import.meta.main)`** to run.
- **A tenant-scoped API route goes through `asClient(context, action, resource, fn)`** in
  `src/services/api/app.ts` (→ `IdentityService.withClientAction`). It resolves the session, authorizes and
  records the action, then binds the tenant. Do not open `withTenant` from a route directly.
- **Bot configuration rules live in `@zeddev/bot`** (validation, limits, option lists, readiness, prompt
  rendering). Its functions take an already tenant-bound `Connection` and write `app.current_tenant_id()`,
  never a tenant parameter. An option list or limit mirrored by a SQL CHECK needs a test asserting the two agree.
  Shared validation helpers (code-point length counting, control-character rules, multi-line text parsing,
  `requireTenant`) live in `src/lib/bot/shared.ts`; do not copy them into a new module.
- **Readiness is defined once, in SQL**: `app.bot_readiness_unmet` in migration 0007. A new readiness
  condition needs a clause there, an AFTER trigger on its input table calling
  `app.reevaluate_bot_readiness_trigger()`, and an entry in `READINESS_CONDITIONS` in
  `src/lib/bot/activation.ts` (a test asserts the two agree). Never flip `bot_activation.active` from
  application code except through `setBotActive`.
- **An operator data route goes through `identity.withOperatorAction(token, action, resource, fn)`**, the
  operator counterpart of `asClient`.
- **The API router matches exact paths only** — no path parameters. An operation on one item of a
  collection names it by an `id` in the JSON body (e.g. `PUT /v1/bot/behavior-rules/rule`), and a delete
  that needs an id is a `POST …/delete`, not a DELETE with a body.

### Database-backed tests

- Tests for `@zeddev/db` and `@zeddev/schema` run against a real PostgreSQL; there is
  no in-memory fake for the database, on purpose.
- Each test fixture creates its own disposable database **and** its own
  `NOSUPERUSER NOBYPASSRLS` role via `createTestDatabase()` from `@zeddev/db/testing`.
- Every tenant-scoped table needs `tenant_id`, `ENABLE` **and** `FORCE ROW LEVEL
  SECURITY`, and a policy; new tenant-scoped tables must also be added to
  `TENANT_SCOPED_TABLES` in `src/lib/schema/index.ts` or the structural test will not
  check them.
- Tables reachable from the queue's cross-tenant dispatch context must also be listed in
  `DISPATCH_READABLE_TABLES` in `src/lib/schema/index.ts`; a structural test fails the build if a
  table grants `app.has_dispatch_scope()` without being declared there.
- Migrations live at `src/lib/schema/migrations/NNNN_snake_case_name.sql`, are
  forward-only, gapless from `0001`, and are checksummed after they are applied
  (editing an applied one fails the run).
- `@zeddev/identity`'s tests also run against a real PostgreSQL. Session, lockout, and token
  expiry are judged by the **database** clock, not an injected `Clock`, so a `FakeClock` cannot
  drive them: those tests build a service with a sub-second window and really wait, the same way
  `@zeddev/queue`'s PostgreSQL lease tests do. Pass `credentialParams: { N: 1024, r: 8, p: 1 }` to
  `IdentityService` in tests — the production scrypt cost is deliberately ~100 ms per hash.

### Object-storage-backed tests

- Tests for `@zeddev/storage` run against a real S3-compatible server (MinIO); there is
  no fake server in the package, on purpose — a fake would have to implement SigV4
  verification in order to test SigV4 signing.
- Each fixture creates and drops its own bucket via `createTestBucket()` from
  `@zeddev/storage/testing`.
- The fixture pins `listPageSize` to 2 so every listing crosses a continuation-token boundary.
- What *is* faked, via the injectable `transport` option on `S3ObjectStore`, is only what a
  real server will not produce on demand: throttling, corruption at rest, a truncated listing.

## Gotchas

- `.gitignore` is Python-derived. Its `lib/`, `lib64/`, `parts/`, `var/` rules are
  anchored to the repo root (`/lib/`) so they do not swallow `src/lib/**`. Do not unanchor them.
- `FakeClock.advance()` is `async` — `await` it, and assert its guard with
  `assert.rejects`, not `assert.throws`.
- A PostgreSQL superuser or a `BYPASSRLS` role is exempt from ALL row-level security;
  `FORCE ROW LEVEL SECURITY` does not change that. Never connect the application as
  one. `assertTenantIsolationEnforceable()` from `@zeddev/db` refuses to start against
  such a role — call it at service startup.
- `describe(name, { skip }, fn)` in `node:test` does not execute `fn` at all, so
  `specTest` calls inside a skipped suite never register and spec coverage silently
  under-reports. Any command that collects coverage must invoke the tests the same
  way `npm test` does.
- When a `before` hook fails in `node:test`, the child tests report only
  `cancelledByParent`; the real error appears solely on the parent suite's entry. Use
  `--test-reporter=tap` and look at the suite line to see it.
- A `PostgresQueue` holds one pool connection permanently once `waitForWork` is first called
  (it is the `LISTEN` session). Size `DATABASE_POOL_MAX` accordingly and call `close()` on
  shutdown, or the pool will not drain.
- SMTP frames a message body with `<CRLF>.<CRLF>`, and that leading CRLF **is** the line break
  ending the body's last line. `buildMessage` therefore produces a message that never ends with a
  line break, and `dataTerminator` supplies the framing CRLF only when it is missing. A body's
  trailing newlines are stripped for the same reason: 7bit cannot represent one and base64 can, so
  without stripping, `send` would preserve or drop it depending on whether the text happened to be
  ASCII.
- Mail tests share one Mailpit container across parallel test files, so each fixture owns a unique
  recipient domain and only ever reads its own messages. Do not add a "clear the mailbox" step —
  it would delete another file's mail between its send and its assertion.
- A test asserting that content did not leak into a log must use a needle that cannot occur in
  a fixture identifier. Test tenant UUIDs contain long runs of repeated digits, so short numeric
  markers produce false positives.
- An HTTP `HEAD` response carries no body, so S3's `<Error><Code>` is unavailable on it. Any
  check that must distinguish "no such bucket" from "bad credential" has to use a method that
  returns a body — `verifyAccess()` lists one key for this reason.
- `URLSearchParams` is not the encoder SigV4 requires (it renders a space as `+`, not `%20`).
  Build query strings with `canonicalQuery` from `@zeddev/storage`, or the signature will not
  match for values containing the offending characters.
- `scripts/db.sh` and `scripts/storage.sh` each upsert only their own `ZEDDEV_TEST_*` block in
  `.env.test` and can be run in either order. Do not make either one truncate the file.
- A new log field name is silently redacted unless it is added to `OPERATIONAL_FIELDS` in
  `src/lib/logging/index.ts`.
- `access_records` and `tenant_lifecycle_events` grant SELECT only to the **platform scope** and to
  a bound tenant — not to the identity scope that writes them. A test reading them under
  `withIdentityScope` gets an empty array, which looks exactly like a missing row.
- A failed login must commit its failed-attempt counter, so `IdentityService` returns an outcome
  from the transaction and throws after it commits. Throwing from inside would roll the counter
  back and the lockout would silently never engage. Keep that shape when adding credential paths.
- Leaving a `for await` loop over an `IncomingMessage` early (throw or break) destroys the socket along
  with it, so an error reply written afterwards never arrives — the caller just sees a reset connection.
  Read and discard to the end of the stream instead.
- The portability guard exempts only bare `example.com`/`example.org` hosts in URL literals, not
  subdomains. Use those bare hosts in schema examples and tests, not `app.example.com` or similar.
- The repo root's `.env` is a developer file, not platform configuration. Do not overwrite it; verify
  Compose changes in a temporary copy of the repo, under a separate project name
  (`docker compose -p <other-name>`).
- `core.autocrlf` is on for this checkout. `.gitattributes` keeps `*.sh`, `Dockerfile`, and `*.yaml` as LF
  regardless, because those files run inside Linux containers.
- Row-level security applies to migrations: the migration role is not exempt. A data backfill must bind
  each tenant with `set_config('app.tenant_id', …, true)` (see the `DO` block at the end of
  `0007_bot_activation.sql`) or it silently touches no rows.
- In the Bash tool (Git Bash on Windows), `node` does not understand `/tmp/...` paths. Pass files to
  `node -e` scripts via `$(cygpath -w /tmp/file)`.
- `ValidationError` sorts its issues by key; assert issue lists in key order.
- Python is not usable on this machine (pyenv shim with no version set). Script file edits with `node`: write the script to a file with a quoted heredoc (`<<'EOF'`) and run
  `node "$(cygpath -w /tmp/x.js)"`. Inline `node -e "…"` mangles backslash escapes and backticks.
