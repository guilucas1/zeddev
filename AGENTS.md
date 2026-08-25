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
| `npm run db:up` | Starts a disposable PostgreSQL 17 container (`zeddev-pg`) on `127.0.0.1:55432` and writes `.env.test`. Required before `npm run check`. |
| `npm run db:down` | Removes the `zeddev-pg` container and `.env.test`. |
| `npm run check` | `typecheck`, then requires a database, then `test`. Use this as the gate before committing. |
| `npm run check:offline` | `typecheck` + `test` without a database. Does not cover `@zeddev/db` or `@zeddev/schema`. Only use when Docker is unavailable. |
| `npm run spec-coverage` | Prints which `specs/*.md` have covering tests and which have none. |

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

### Database-backed tests

- Tests for `@zeddev/db` and `@zeddev/schema` run against a real PostgreSQL; there is
  no in-memory fake for the database, on purpose.
- Each test fixture creates its own disposable database **and** its own
  `NOSUPERUSER NOBYPASSRLS` role via `createTestDatabase()` from `@zeddev/db/testing`.
- Every tenant-scoped table needs `tenant_id`, `ENABLE` **and** `FORCE ROW LEVEL
  SECURITY`, and a policy; new tenant-scoped tables must also be added to
  `TENANT_SCOPED_TABLES` in `src/lib/schema/index.ts` or the structural test will not
  check them.
- Migrations live at `src/lib/schema/migrations/NNNN_snake_case_name.sql`, are
  forward-only, gapless from `0001`, and are checksummed after they are applied
  (editing an applied one fails the run).

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
