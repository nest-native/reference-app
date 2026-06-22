# nest-native reference app

<p>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node version" />
  <img src="https://img.shields.io/badge/status-v0.1-blue.svg" alt="Status" />
</p>

## What This Is

A production-shaped reference application that demonstrates how
[`nest-drizzle-native`](https://github.com/nest-native/nest-drizzle-native) and
[`nest-trpc-native`](https://github.com/nest-native/nest-trpc-native) compose
under realistic backend pressure: feature modules, multi-tenant auth context,
cross-service transactions, real-database integration tests, an
outbox-pattern worker for post-commit side effects, and a typed tRPC
client smoke check.

## Why It Exists

The reference app **serves the libraries** — it is not a product. Two
implicit deliverables:

1. A credible demo a team could adapt for a real backend.
2. A feedback loop on the libraries themselves. If something feels awkward
   here, that is signal to add API there in a separate PR to the relevant
   library repo.

## Status

All eight milestones in the implementation brief are complete:

| | Milestone | What landed |
| --- | --- | --- |
| 1 | Bootstrap | Repo skeleton, governance, CI, Nest scaffold, Drizzle + tRPC `ping` |
| 2 | Database wired | (covered by 1) |
| 3 | Schema + seed | Six tables, drizzle-kit migrations, idempotent seed |
| 4 | Auth + request context | `scrypt` passwords, real HS256 JWT, `AuthGuard`, request-scoped `CURRENT_USER` / `CURRENT_ORGANIZATION` |
| 5 | Core modules | `organizations` / `users` / `projects` repos + services + tRPC routers, scoped by current org |
| 6 | Transactional workflow | `OrganizationOnboardingService.inviteUser()` writes 5 rows in one `@Transactional()`; happy-path, rollback-safety, crash-recovery tests |
| 7 | Worker | Long-running `OutboxClaimer` poller with graceful shutdown (`scripts/start-worker.ts`) |
| 8 | Polish | `client-smoke/` typed-client check, Dockerfile + docker-compose, `docs/architecture.md`, this README |

## Compatibility

| Runtime | Supported line |
| --- | --- |
| Node.js | `>=20` |
| NestJS | `11.x` |
| tRPC | `11.x` |
| Drizzle ORM | `0.45.x` |
| `nest-drizzle-native` | `0.2.x` |
| `nest-trpc-native` | `0.4.3+` |
| `@nestjs-cls/transactional` | `^3` |

## Repo Layout

```
src/
  main.ts                       Nest bootstrap (listens on PORT)
  app.module.ts                 Root module + ClsPluginTransactional wiring
  config/env.ts                 loadEnv() — single source of truth for env
  database/                     DrizzleModule.forRoot wiring + schema + migrations
  auth/                         JWT, scrypt, AuthService, middleware, AuthGuard,
                                @CurrentUser / @CurrentOrganization, AuthRouter
  context/                      Request-scoped CURRENT_USER / CURRENT_ORGANIZATION
  health/                       /health controller
  modules/
    organizations/              repo + service + tRPC router
    users/                      repo + service + tRPC router (includes users.invite)
    projects/                   repo + service + tRPC router
    memberships/                repo only (used by onboarding)
    audit-log/                  AuditLogService.record()
    outbox/                     producer + claimer + registry + transport + handler
    onboarding/                 OrganizationOnboardingService — the @Transactional flow
  trpc/                         TrpcModule.forRoot wiring + PingRouter + generate-types
test/
  integration/                  real-DB tests (node:test)
  e2e/                          tRPC over HTTP smoke tests
scripts/
  migrate.ts                    drizzle-kit migrator runner
  seed.ts                       Idempotent dev seed (1 org + 1 admin + 1 project)
  smoke.ts                      Boots app, hits /health, checks DB
  start-worker.ts               Long-running outbox poller (SIGTERM-aware)
client-smoke/
  client.ts                     Typed tRPC client over the generated AppRouter
  tsconfig.json
docs/
  architecture.md               One-sitting tour of the app
Dockerfile                      Multi-stage production image
docker-compose.yml              API + worker + (optional) Postgres recipe
```

## Getting Started

```bash
nvm use
npm install
DATABASE_URL=./reference-app.db npm run db:migrate
DATABASE_URL=./reference-app.db npm run seed
AUTH_SECRET=dev-secret-must-be-at-least-32-characters-xxxxx \
  DATABASE_URL=./reference-app.db \
  npm run start:dev
```

API listens on `http://localhost:3000`. tRPC mounts at `/trpc`. Health at
`/health`. Seed creates `admin@acme.test` / `admin123!` with one starter
project for local poking.

Run the outbox worker as a separate process:

```bash
AUTH_SECRET=… DATABASE_URL=./reference-app.db npm run start:worker
```

## What It Demonstrates

- `nest-drizzle-native`: `DrizzleModule.forRoot` + `forFeature([Repo])`,
  `@DrizzleRepository`, `@InjectDrizzle`, `@InjectTransaction` for tx
  participation, `getDrizzleClientToken`.
- `nest-trpc-native`: `TrpcModule.forRoot` with `createContext`, `@Router`,
  `@Query`/`@Mutation`, `@Input`/`@TrpcContext`, generated `AppRouter`,
  guards/interceptors integration.
- `@nestjs-cls/transactional` with the official
  `@nestjs-cls/transactional-adapter-drizzle-orm` (>=1.3.0), which
  auto-detects better-sqlite3's synchronous driver and runs the transaction
  in sync mode.
- Multi-tenant patterns: request-scoped `CURRENT_USER` /
  `CURRENT_ORGANIZATION` providers populated by an Express middleware that
  decodes a JWT; tRPC procedures consume the same `authContext` through
  `@TrpcContext` and class-level `@UseGuards(AuthGuard)`.
- Transactional outbox: post-commit side effects with at-least-once delivery,
  exponential backoff, partial-unique idempotency, stuck-claim recovery.
- A typed tRPC client (`client-smoke/`) that consumes the generated
  `AppRouter` and exercises one query, one mutation, and one
  auth-protected call against a live local server.

See [`docs/architecture.md`](docs/architecture.md) for the full tour.

## Testing

```bash
npm run test          # node --test, integration + e2e (currently 45 tests)
npm run test:cov      # with c8 coverage
npm run client-smoke  # typed client against a live, seeded local server
```

Coverage is **pragmatic, not 100%**. The 100% bar belongs to the libraries.
Aim for ≥90% on domain modules; the outbox worker and transactional
workflow have explicit rollback/retry/crash-recovery tests regardless of
overall percentage.

## Quality Gates

```bash
npm run ci
```

Runs in order: `typecheck`, `lint`, `complexity:check` (cognitive
complexity ceiling 15), `test:cov`, `security:audit`
(`npm audit --audit-level=high`), `build`. CI runs on Node 20 and 22.

## Deployment

The default storage is `better-sqlite3` for zero-setup local dev. The
production recipe is Postgres — see
[`docs/architecture.md#production-deployment-recipe`](docs/architecture.md#production-deployment-recipe)
for the swap, and [`docker-compose.yml`](docker-compose.yml) for the
two-process (API + worker) stack with an optional Postgres service.

## Philosophy

- **Feel native.** Decorator-first, Nest modules + DI + enhancers,
  lifecycle hooks. No functional wrappers around library decorators.
- **Stay honest.** Drizzle remains SQL-first; tRPC remains tRPC. No hidden
  magic where explicit application code is clearer.
- **No unnecessary runtime dependencies.** Every `dependencies` entry has
  a one-line justification in `CHANGELOG.md`.
- **Library fixes ship as separate PRs to library repos.** If you find a
  bug in `nest-drizzle-native` or `nest-trpc-native` while building here,
  stash, open the library-fix PR upstream, get it merged, then resume.

See [CONTRIBUTING.md](CONTRIBUTING.md) for design rules, the library-fix
workflow, dependency review, and security pass expectations.
