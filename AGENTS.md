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
| `npm test` | Runs the full suite. |
| `npm run typecheck` | `tsc --noEmit`. Type errors do **not** fail `npm test` — type stripping ignores types — so this must be run separately. |
| `npm run check` | `typecheck` then `test`. Use this as the gate before committing. |
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

## Gotchas

- `.gitignore` is Python-derived. Its `lib/`, `lib64/`, `parts/`, `var/` rules are
  anchored to the repo root (`/lib/`) so they do not swallow `src/lib/**`. Do not unanchor them.
- `FakeClock.advance()` is `async` — `await` it, and assert its guard with
  `assert.rejects`, not `assert.throws`.
