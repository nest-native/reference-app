# nest-trpc-native handover — HttpException → INTERNAL_SERVER_ERROR when an APP_INTERCEPTOR is present

**Target repo:** `nest-native/nest-trpc-native`
**Affected version:** `0.4.2` (current latest at time of writing)
**Reporter:** discovered while building `nest-native/reference-app` milestone 6 (transactional workflow).
**Approach for the fix:** TDD — write the failing test first, then apply the one-line code change. Do **not** apply the code change before you have a red test.

## TL;DR

When `ClsModule` (from `nestjs-cls`) is registered in a Nest app — even with default settings — every `HttpException` thrown inside a tRPC procedure is silently coerced into `INTERNAL_SERVER_ERROR` (`httpStatus: 500`). Auth `401`, `404`, `400`, `403`, etc. all disappear.

Root cause is a missing `await` in `packages/trpc/src/context/trpc-context-creator.ts`. When any interceptor is in the chain, the handler returns a rejected `Promise` from the `return this.transformToResult(result)` statement — but because there's no `await`, the rejection escapes the surrounding `try/catch`, so `handleException` → `toTrpcError` never runs.

The fix is one line. The trickier part is the **regression test**: it must exercise the interceptor codepath (because the bug only fires when `interceptors.length > 0`).

## Symptom

A `@Query()` or `@Mutation()` throws `new UnauthorizedException('...')`. The tRPC response is:

```json
{
  "error": {
    "message": "Invalid email or password",
    "code": -32603,
    "data": {
      "code": "INTERNAL_SERVER_ERROR",
      "httpStatus": 500,
      "stack": "UnauthorizedException: Invalid email or password\n    at AuthService.login (.../auth.service.ts:37:13)\n    at AuthRouter.login (.../auth.router.ts:31:22)\n    at handler (.../nest-trpc-native/context/trpc-context-creator.ts:323:27)\n    ..."
    }
  }
}
```

Note that the **stack still shows `UnauthorizedException`** — the error type is preserved up until the very last frame, then quietly mapped to `INTERNAL_SERVER_ERROR`. The same is true for `NotFoundException` (becomes 500 instead of 404), `BadRequestException` (instead of 400), `ForbiddenException` (instead of 403), and every other `HttpException` subclass.

The bug **does not fire** when there are no interceptors in the chain. A vanilla nest-trpc-native app without `ClsModule` and without any `@UseInterceptors()` correctly maps HttpException → the right tRPC code. Add `ClsModule.forRoot({ global: true })` to the app module and the symptom appears across every procedure.

## Why it happens

`ClsModule.forRoot()` registers `APP_INTERCEPTOR` unconditionally in `cls-root.module.ts`:

```js
// node_modules/nestjs-cls/dist/src/lib/cls-module/cls-root.module.js (l. 134)
{
  provide: core_1.APP_INTERCEPTOR,
  inject: [cls_internal_constants_1.CLS_INTERCEPTOR_OPTIONS],
  useFactory: this.clsInterceptorFactory,
},
```

When `options.interceptor.mount` is `false` (the default), the factory returns a passthrough:

```js
return { intercept: (_, next) => next.handle() };
```

That passthrough is still an interceptor in the chain. So `interceptors.length` is `≥ 1` for every procedure as soon as ClsModule is in the module graph.

Now look at `packages/trpc/src/context/trpc-context-creator.ts` (the same lines in `dist/.../trpc-context-creator.js` are 115–118 in 0.4.2):

```ts
try {
  if (guards.length) {
    /* ... */
  }
  const handler = async () => { /* ... */ return callback.call(instance, ...handlerArgs); };
  const result = interceptors.length > 0
    ? await this.runtime.interceptorsConsumer.intercept(interceptors, contextArgs, instance, callback, handler, TRPC_CONTEXT_TYPE)
    : await handler();
  return this.transformToResult(result);   // ← BUG: missing `await`
}
catch (error) {
  return this.handleException(error, exceptionHandler, executionContext);
}
```

`InterceptorsConsumer.intercept(...)` returns an **Observable**, not a Promise. `await observable` on a modern rxjs `Observable` yields the Observable itself (Observables don't implement `then`). So when interceptors are present, `result` is an `Observable<T>` carrying a deferred handler invocation.

`transformToResult(observable)` subscribes via `lastValueFrom(observable)`, which yields a Promise. If the underlying handler throws an `HttpException`, that Promise rejects.

But the code says `return this.transformToResult(result)` — **no await**. In an `async` function, `return p` (where `p` is a Promise) does **not** await; the function returns a Promise that resolves to whatever `p` resolves to (or rejects with whatever `p` rejects with). The enclosing `try/catch` only fires for **awaited** rejections. So the rejected Promise propagates out of `createHandler`, past `handleException`, past `toTrpcError`, all the way up to `@trpc/server`'s procedure boundary, which sees a generic `Error` and wraps it as `TRPCError({ code: 'INTERNAL_SERVER_ERROR' })`.

When there are zero interceptors, the other branch (`await handler()`) directly awaits, so the catch fires normally — that's why the bug is invisible without ClsModule.

## Fix

One line in `packages/trpc/src/context/trpc-context-creator.ts`:

```diff
-       return this.transformToResult(result);
+       return await this.transformToResult(result);
```

That's it. Standard async-function semantics: awaiting before return makes the rejection observable to the surrounding `try/catch`, which routes through `handleException` → `toTrpcError` → the existing `HttpException` branch maps to the right tRPC code.

Watch for the ESLint rule `no-return-await` — it's misleading in this case (the rule explicitly allows `return await` inside `try` to make rejections catchable). If sonarjs or any linter flags it, suppress with `// eslint-disable-next-line no-return-await` on that one line and a comment explaining why.

## TDD: write the failing test first

**Do not modify `createHandler` until you have a red test.** This is a regression test for a contract (HttpException type preservation through the interceptor chain), and the test is the artifact that prevents the regression from coming back.

### Suggested test file

`packages/trpc/test/error-mapping.spec.ts` (or wherever the existing context-creator tests live in the trpc-native repo). The test must:

1. Stand up a Nest application context with a real tRPC router.
2. Register at least one global interceptor (the exact passthrough shape `ClsModule` uses is fine — see below).
3. Define a `@Query()` (and/or `@Mutation()`) that throws a known `HttpException` subclass.
4. Invoke it via a tRPC client or via `TrpcRouter` directly.
5. Assert the **tRPC error code** (e.g. `UNAUTHORIZED`, `NOT_FOUND`) and `httpStatus` — **not** `INTERNAL_SERVER_ERROR`.

Run the test before applying the fix → it must fail with `INTERNAL_SERVER_ERROR`/`500`. Then apply the fix → it passes.

### Minimal repro (use as the test fixture)

```ts
import { Injectable, Module, NotFoundException, UnauthorizedException, UseInterceptors } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { Query, Router, TrpcModule } from 'nest-trpc-native';
import { join } from 'node:path';

// Mirror nestjs-cls's passthrough interceptor exactly.
const passthroughInterceptor = {
  intercept: (_ctx: any, next: { handle: () => any }) => next.handle(),
};

@Router('demo')
class DemoRouter {
  @Query()
  unauthorized(): never {
    throw new UnauthorizedException('nope');
  }

  @Query()
  notFound(): never {
    throw new NotFoundException('absent');
  }
}

@Module({
  imports: [
    TrpcModule.forRoot({
      path: '/trpc',
      autoSchemaFile: join(process.cwd(), 'test/@generated/server.ts'),
    }),
  ],
  providers: [
    DemoRouter,
    { provide: APP_INTERCEPTOR, useValue: passthroughInterceptor },
  ],
})
class TestAppModule {}

// In the spec:
const app = await NestFactory.create(TestAppModule, { logger: false });
await app.listen(0, '127.0.0.1');
const baseUrl = await app.getUrl();

const r = await fetch(`${baseUrl}/trpc/demo.unauthorized`);
const body = await r.json() as { error: { data: { httpStatus: number; code: string } } };

// EXPECTED (post-fix):
assert.equal(body.error.data.httpStatus, 401);
assert.equal(body.error.data.code, 'UNAUTHORIZED');

// PRE-FIX (current behavior):
// body.error.data.httpStatus === 500
// body.error.data.code === 'INTERNAL_SERVER_ERROR'
```

### Test coverage to add (in TDD order)

Write each as a separate `test(...)` so failures are diagnostic:

1. **No interceptors, HttpException → correct mapping** (should pass before and after the fix; locks the existing behavior).
2. **With a passthrough APP_INTERCEPTOR, `UnauthorizedException` → `UNAUTHORIZED` / 401** — fails pre-fix with 500/INTERNAL_SERVER_ERROR.
3. **With a passthrough APP_INTERCEPTOR, `NotFoundException` → `NOT_FOUND` / 404** — same shape.
4. **With a passthrough APP_INTERCEPTOR, `ForbiddenException` → `FORBIDDEN` / 403** — same shape.
5. **With a passthrough APP_INTERCEPTOR, a plain `throw new Error('boom')` → `INTERNAL_SERVER_ERROR` / 500** — confirms the catch-all branch still works after the fix.
6. **With a passthrough APP_INTERCEPTOR on a `@Mutation()`, HttpException → correct mapping** — confirms the fix applies to both Query and Mutation codepaths (same code, but worth a separate assertion).
7. **With a real `@UseInterceptors(SomeNoopInterceptor)` at the class level instead of APP_INTERCEPTOR, same behavior** — confirms it's not specific to APP_INTERCEPTOR registration.

Tests 2–7 must be red before the fix and green after. Test 1 and test 5 must stay green throughout.

If you want a stronger property test: parameterize over every `HttpException` subclass in `@nestjs/common` (`BadRequestException`, `UnauthorizedException`, `NotFoundException`, `ForbiddenException`, `ConflictException`, `UnprocessableEntityException`, `InternalServerErrorException`, `BadGatewayException`, etc.) and assert each maps to the expected tRPC `code` + `httpStatus`. The mapping table lives in `mapHttpStatusToTrpcCode` in the same file.

## Where exactly to apply the fix

In `packages/trpc/src/context/trpc-context-creator.ts`, inside `createHandler(options)`, after the `try {` block:

```diff
       const result = interceptors.length > 0
         ? await this.runtime.interceptorsConsumer.intercept(
             interceptors, contextArgs, instance, callback, handler, TRPC_CONTEXT_TYPE,
           )
         : await handler();
-      return this.transformToResult(result);
+      return await this.transformToResult(result);
     }
     catch (error) {
       return this.handleException(error, exceptionHandler, executionContext);
     }
```

That's the entire code change.

## Verification checklist

- [ ] Red test exists in `packages/trpc/test/` exercising HttpException through an interceptor — fails on `main` before the fix.
- [ ] One-line fix applied to `createHandler`.
- [ ] Red test goes green.
- [ ] No other test regresses (run `npm run test:cov` in the trpc-native repo).
- [ ] `npm run complexity:check` still passes (the change does not affect complexity).
- [ ] PR body explains the bug, the interaction with `nestjs-cls`'s default passthrough interceptor, and links back to this handover.
- [ ] CHANGELOG entry under `[Unreleased]` with a one-line summary.
- [ ] Release `0.4.3` (or whatever the next patch is) and publish to npm.

## After the fix is published

The `nest-native/reference-app` milestone-6 branch (`milestone/06-transactional-workflow`) is **paused on this bug**. To resume:

1. In `reference-app`, bump `nest-trpc-native` to the fixed version: `npm install nest-trpc-native@<new-version>`.
2. Re-run `npm run ci` locally — the 2 currently-failing tests (`auth.login` 401, `projects.get` 404) and the 3 §7 workflow tests should all pass.
3. The milestone-6 PR can then ship.

## Why this matters beyond reference-app

Any user of `nest-trpc-native` who adopts `nestjs-cls` (extremely common in production NestJS apps — request context, transactional decorators, anything that needs ALS) is silently losing all HTTP-status semantics on every tRPC procedure. The client sees `INTERNAL_SERVER_ERROR` instead of `UNAUTHORIZED`/`NOT_FOUND`/`BAD_REQUEST`, breaks any client-side error handling that branches on status, and floods logs with false 500s. This is high-severity for any production deployment combining the two libraries.

## Related context

- The fix is a known async-function antipattern: `return promise` inside `try { ... } catch` does not catch rejections; `return await promise` does. The ESLint rule `no-return-await` documents the exception. See: https://eslint.org/docs/latest/rules/no-return-await#options
- The interaction was discovered while implementing the transactional workflow in `nest-native/reference-app` (brief §7). The reference app uses `ClsModule.forRoot()` to wire `@nestjs-cls/transactional` for the outbox/audit workflow; the moment ClsModule was added, all unrelated 401/404 e2e tests started returning 500.
- Reproduction takes < 30 seconds in any nest-trpc-native sample by adding `ClsModule.forRoot({ global: true })` to the app module and throwing an `HttpException` from a procedure.
