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
| `npm run check` | `typecheck`, then requires both PostgreSQL and object storage, then `test`. Use this as the gate before committing. Calls `scripts/require-services.ts`. |
| `npm run check:offline` | `typecheck` + `test` without a database. Does not cover `@zeddev/db`, `@zeddev/schema`, or `@zeddev/storage`. Only use when Docker is unavailable. |
| `npm run spec-coverage` | Prints which `specs/*.md` have covering tests and which have none. |
| `npm run config-reference` | Regenerates `docs/configuration.md` from the config schemas. A test fails the build if the committed file is stale. |

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
- **A tenant id is validated in exactly one place**: `assertTenantId`/`normalizeTenantId` from
  `@zeddev/tenancy`. Do not re-derive the rule — in object storage a tenant id is a key path
  segment, so a value containing `/` silently relocates one tenant's object under another's prefix.
- **Adding a `*_CONFIG_SCHEMA` to a package means registering it** in `PLATFORM_CONFIG_SCHEMAS`
  in `src/lib/deployment/index.ts` and running `npm run config-reference`. A test scans
  `src/lib` and fails the build otherwise.

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
