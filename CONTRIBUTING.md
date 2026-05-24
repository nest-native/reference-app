# Contributing

Thanks for helping improve `nest-native/reference-app`. This repo is a
reference application: it exists to **serve** `nest-drizzle-native` and
`nest-trpc-native`, not to become a product of its own.

If you use an AI coding agent, brief it on the rules in this file — the
design rules, dependency-review, and security-pass sections below are the
contract an agent must preserve while editing this repo.

## Local Setup

```bash
nvm use
npm install
npm run db:migrate
npm run smoke
```

The repo uses Node.js `>=20`.

## Design Rules

- Keep the public surface decorator-first and class-based. Do not wrap
  library decorators behind local helpers.
- Use only the primary onboarding APIs of the libraries:
  - `nest-trpc-native`: `TrpcModule.forRoot()`/`forRootAsync()`, `@Router()`,
    `@Query()`, `@Mutation()`, `@Subscription()`, `@Input()`,
    `@TrpcContext()`, the generated `AppRouter`.
  - `nest-drizzle-native`: `DrizzleModule.forRoot()`/`forRootAsync()`/`forFeature()`,
    `@InjectDrizzle()`, `@DrizzleRepository()`, `@Transactional()`,
    `@InjectTransaction()`.
- Do not reach for library internals.
- Migrations are forward-only and reversible-by-replacement. No destructive
  in-place data changes in a single migration. Splitting is cheap; data loss
  is not.
- If a pattern repeats three times in this app, it is a candidate for the
  library — not for a local helper here.

## Library Fixes Ship As Separate PRs

If you find a bug in `nest-drizzle-native` or `nest-trpc-native` while
building here, do not work around it locally. Instead:

1. Stash your work, including untracked files:
   ```bash
   git stash push -u -m "reference-app work before library fix"
   ```
2. Branch from `main` of the relevant library repo.
3. Fix the bug with focused regression tests.
4. Run the library's `npm run ci`.
5. Open and merge the library-fix PR first.
6. Return here and pop the stash:
   ```bash
   git stash pop
   ```

## Validation

For small docs-only changes:

```bash
git diff --check
```

For code changes:

```bash
npm run ci
```

If you cannot run a required check locally, say so in the PR and explain why.

## Tests

Add or update tests when behavior changes. The highest-risk areas are:

- the transactional `inviteUser` workflow (rollback safety)
- the outbox worker (crash recovery, retry)
- request-scoped providers (`currentUser`/`currentOrganization`)
- migration replay (drizzle-kit output applied on an empty DB)
- typed client usage (`client-smoke/` consuming the generated `AppRouter`)

## Dependency Review

Every dependency addition or update needs an explicit reason in the PR.

Before approving dependency changes, review:

- whether the dependency is needed at all
- whether it belongs in `devDependencies` instead of `dependencies`
- package legitimacy and maintenance health
- lifecycle scripts such as `preinstall`, `install`, `postinstall`, and
  `prepare`
- lockfile churn
- unpinned Git or URL dependencies

Default to Node built-ins where they suffice.

## Security Review

Every PR needs an explicit security pass, even docs-only PRs.

Check for:

- auth/authz bypass risk
- input-validation gaps
- prototype pollution
- path traversal
- unsafe dynamic execution
- unsafe deserialization
- secret leakage in code, tests, samples, logs, and docs
- risky CORS/CSRF assumptions
- suspicious dependency or lockfile changes

High-risk findings block merge until mitigated or explicitly accepted.

## Commit Style

Prose subject, imperative mood. No Conventional Commits dogma — the org
history does not enforce them.

## Module Touch Tracking

The PR template asks you to list the modules touched (`organizations`,
`projects`, `audit-log`, `outbox`, etc.). Reviewers use that to scope the
security pass and the regression-test review.
