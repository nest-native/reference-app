# nest-native reference app

<p>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node version" />
  <img src="https://img.shields.io/badge/status-bootstrap-orange.svg" alt="Status" />
</p>

## What This Is

A production-shaped reference application demonstrating how
[`nest-drizzle-native`](https://github.com/nest-native/nest-drizzle-native) and
[`nest-trpc-native`](https://github.com/nest-native/nest-trpc-native) compose
under realistic backend pressure: feature modules, auth context, transactions
across services, migrations, real-DB tests, an outbox-pattern worker for
post-commit side effects, and a typed tRPC client smoke check.

## Why It Exists

The reference app **serves the libraries** — it is not a product. Two implicit
deliverables:

1. A credible demo a team could adapt for a real backend.
2. A feedback loop on the libraries themselves. If something feels awkward
   here, that is signal to add API there in a separate PR to the relevant
   library repo.

## Status

`v0.0.1-scaffold`. The bootstrap layer is in place: Nest app, Drizzle wired
to SQLite with one schema, tRPC wired with one `ping` procedure, CI. The
domain modules described in [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md)
(when present) land in subsequent milestones.

## Compatibility

| Runtime | Supported line |
| --- | --- |
| Node.js | `>=20` |
| NestJS | `11.x` |
| tRPC | `11.x` |
| Drizzle ORM | `0.45.x` |
| `nest-drizzle-native` | `0.2.x` |
| `nest-trpc-native` | `0.4.x` |

## Repo Layout

```
src/
  main.ts                  Nest bootstrap
  app.module.ts            Root module
  config/                  Environment loading
  database/                Drizzle module wiring, schema, migrations
  health/                  /health endpoint
  trpc/                    tRPC module + routers + schema generation
test/
  integration/             Real-DB integration tests (node:test)
  e2e/                     tRPC end-to-end smoke
scripts/                   Migration runner, seed, smoke
docs/                      Architecture, outbox, transactions, deployment
```

## Getting Started

```bash
nvm use
npm install
npm run db:migrate
npm run smoke
```

To run the API locally:

```bash
npm run start:dev
```

The HTTP server listens on `http://localhost:3000`. The tRPC endpoint is
mounted at `/trpc`. The health endpoint is `GET /health`.

## What It Demonstrates (so far)

- `nest-drizzle-native` module setup with `better-sqlite3` for zero-setup
  local dev.
- `nest-trpc-native` module setup with one `ping` query at the root level.
- Schema-first Drizzle table + a drizzle-kit-generated migration.
- A smoke script that boots the Nest container, runs migrations against an
  ephemeral SQLite file, and exercises the wired surfaces.

## Testing

```bash
npm run test          # node --test, integration + e2e
npm run test:cov      # with c8 coverage
```

Coverage is **pragmatic, not 100%**. The 100% bar belongs to the libraries.
Aim for ≥90% on domain modules; the outbox worker and transactional workflow
must have explicit rollback/retry tests regardless of overall percentage.

## Quality Gates

```bash
npm run ci
```

Runs in order: `typecheck`, `lint`, `complexity:check` (cognitive complexity
ceiling 15), `test:cov`, `security:audit` (`npm audit --audit-level=high`),
`build`.

CI runs on Node 20 and 22.

## Philosophy

- **Feel native.** Decorator-first, Nest modules + DI + enhancers, lifecycle
  hooks. No functional wrappers around library decorators.
- **Stay honest.** Drizzle remains SQL-first; tRPC remains tRPC.
- **No unnecessary runtime dependencies.** Every `dependencies` entry needs
  a one-line justification in the PR that adds it.
- **Library fixes ship as separate PRs to library repos.** If you find a bug
  in `nest-drizzle-native` or `nest-trpc-native` while building here, stash,
  open the library-fix PR upstream, get it merged, then resume.

See [AI_CODING_GUIDELINES.md](AI_CODING_GUIDELINES.md) for the rules an AI
coding agent must preserve while editing this repo.
