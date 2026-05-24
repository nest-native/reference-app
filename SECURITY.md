# Security Policy

Security reports are taken seriously. Please avoid posting exploit details,
secrets, private URLs, or production data in public issues.

## Supported Line

The current supported runtime targets are:

- Node.js `>=20`
- NestJS `11.x`
- tRPC `11.x`
- Drizzle ORM `0.45.x`
- `nest-drizzle-native` `0.2.x`
- `nest-trpc-native` `0.4.x`

This repo is a reference application, not a published library. Security
fixes target the running app and its module-level patterns. If a finding is
in `nest-drizzle-native` or `nest-trpc-native`, please report it on the
relevant library repository instead.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting if it is available:

https://github.com/nest-native/reference-app/security/advisories/new

If the private flow is unavailable, open a public issue with only a
non-sensitive summary and ask for a private disclosure channel. Do not
include proof-of-concept payloads, tokens, stack traces with secrets,
private endpoints, or customer/user data in the public issue.

Helpful private report details:

- affected commit or release
- affected runtime: Node, NestJS, tRPC, Drizzle, adapter, and validation
  stack
- minimal reproduction steps
- expected impact
- whether the issue affects the API, the outbox worker, migrations,
  generated tRPC schema, samples, or dependencies
- any known mitigations

## What This Repo Controls

This reference app demonstrates module-level patterns. Security fixes here
may involve:

- transactional boundary correctness (`@Transactional()` scope)
- request-scoped context isolation (`currentUser`, `currentOrganization`)
- outbox worker claim/retry safety (re-claim semantics, idempotency)
- audit-event write-path completeness
- input validation across tRPC procedures (Zod and class-validator)
- migration safety (forward-only, no in-place data loss)
- supply-chain risk through dependency changes

## What Adopters Must Still Configure

If you fork this repo as a starting point, you remain responsible for your
own:

- authentication policy and session handling
- authorization model
- rate limiting
- CORS and CSRF posture
- request body limits
- secret management and transport security
- logging policy and PII handling

The patterns in this repo are illustrative defaults, not a turnkey
production posture.
