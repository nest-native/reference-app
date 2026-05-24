## Summary

- Describe the user-facing or maintainer-facing outcome of this PR.
- Call out any compatibility or release-process changes.
- Link related issues or follow-up PRs.

## Changes

- List the main implementation changes.
- List any docs or test updates.

## Modules Touched

- [ ] `organizations` / `users` / `memberships`
- [ ] `projects`
- [ ] `audit-log`
- [ ] `outbox` (module or worker)
- [ ] `auth` / `context`
- [ ] `trpc` (routers, generated schema)
- [ ] `database` (schema, migrations, wiring)
- [ ] Tooling / CI / docs only

## Public Surface (libraries)

- [ ] No use of library internals introduced
- [ ] Only primary onboarding APIs of `nest-trpc-native` used
      (`TrpcModule`, `@Router`, `@Query`, `@Mutation`, `@Subscription`,
      `@Input`, `@TrpcContext`, generated `AppRouter`)
- [ ] Only primary onboarding APIs of `nest-drizzle-native` used
      (`DrizzleModule.{forRoot,forRootAsync,forFeature}`, `@InjectDrizzle`,
      `@DrizzleRepository`, `@Transactional`, `@InjectTransaction`)

## Security Review

- [ ] Reviewed auth/authz bypass risk
- [ ] Reviewed input-validation and injection surfaces
- [ ] Reviewed path traversal, unsafe dynamic execution, and unsafe
      deserialization risks
- [ ] Reviewed secret leakage in code, tests, samples, docs, and logs
- [ ] Reviewed transport assumptions such as CORS, CSRF, request limits,
      and redirects where relevant
- [ ] No unresolved high-risk security finding remains

## Dependency Review

- [ ] No dependency or lockfile changes
- [ ] Dependency or lockfile changes are intentional and explained
- [ ] Each runtime `dependencies` addition has a one-line justification in
      `CHANGELOG.md`
- [ ] Reviewed lifecycle scripts (`preinstall`, `install`, `postinstall`,
      `prepare`)
- [ ] Confirmed no unapproved Git/URL dependencies

## Migrations

- [ ] No schema changes
- [ ] Migration added via `npm run db:generate` (drizzle-kit output, not
      hand-edited)
- [ ] Migration is forward-only and does not perform destructive in-place
      data changes

## Validation

- [ ] `git diff --check`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run complexity:check`
- [ ] `npm run test:cov`
- [ ] `npm run security:audit`
- [ ] `npm run build`
- [ ] `npm run smoke`
- [ ] Not run; explained below

## Validation Notes

- Explain skipped checks, local environment limits, or follow-up validation
  needs.

## Release Notes

- [ ] No release impact
- [ ] Release impact: `CHANGELOG.md` updated

## AI Coding Agent Disclosure

- [ ] If an AI coding agent changed this PR, it was given the repo-specific
      guidance in `AI_CODING_GUIDELINES.md`
