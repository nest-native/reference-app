# reference-app

<p align="center">Production reference application for the Nest Native stack.</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" alt="Node 20+" />
  <img src="https://img.shields.io/badge/status-bootstrap-yellow.svg" alt="Status: bootstrap" />
</p>

## What This Is

`reference-app` is the canonical reference application for the
[Nest Native](https://nest-native.dev) stack. It demonstrates how
[`nest-drizzle-native`](https://github.com/nest-native/nest-drizzle-native) and
[`nest-trpc-native`](https://github.com/nest-native/nest-trpc-native) compose
under realistic backend pressure: feature modules, multi-tenant auth context,
cross-service transactions, post-commit side effects via the transactional
outbox pattern, real-database integration tests, and a typed tRPC client
smoke check.

It exists to **serve the libraries** — to give adopters a credible end-to-end
shape to study, and to give the libraries a feedback loop on what feels
awkward in practice.

## Status

Pre-bootstrap. The implementation brief is the single source of truth for v1
scope, philosophy alignment, tech stack, module specs, the transactional
workflow, the outbox spec, quality gates, and milestones:

- [`nest-native/nest-native.github.io` — `ideas/reference-app.md`](https://github.com/nest-native/nest-native.github.io/blob/main/ideas/reference-app.md)

Read it end-to-end before contributing.

## Compatibility (target)

| Item | Target |
| --- | --- |
| Node.js | `>=20` |
| NestJS | `11.x` |
| TypeScript | `^6` |
| `nest-drizzle-native` | latest |
| `nest-trpc-native` | latest |
| Local database | SQLite (`better-sqlite3` or libSQL) |
| Production database recipe | Postgres via `pg` |

## What it will demonstrate

- Module boundaries: organizations, users, projects, audit log, outbox.
- Auth context with request-scoped `currentUser` / `currentOrganization`.
- A single `@Transactional()` workflow that spans multiple services
  (invite user → create project → write audit event → emit outbox event).
- The transactional outbox pattern with a worker process, retries, and
  crash recovery.
- Real-database integration tests, including rollback safety.
- A typed `AppRouter` consumed by a `client-smoke` workspace.
- Production-shaped CI: typecheck, lint, complexity ceiling, coverage,
  security audit, on Node 20 and 22.

## Non-goals

- A scaffolding CLI (`create-nest-native-app`).
- A standalone outbox npm package.
- A feature-rich frontend.
- Multi-database or microservice topologies.

## Philosophy

This app must feel native in NestJS while staying honest about the
libraries it composes. Decorator-first, no hidden magic, no unnecessary
runtime dependencies, no public helpers before a pattern repeats. Library
bugs found here ship as separate PRs upstream to the relevant library
repo, not as local workarounds.

## License

MIT (to be added in the bootstrap commit).

---

Part of [Nest Native](https://nest-native.dev).
