import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import {
  type AuthContext,
  readAuthContext,
} from '../../src/auth/auth-context';

// Both guards read the caller through readAuthContext, so its transport
// branching is the single place an authentication source is decided.
// This stub mirrors Nest's ExecutionContextHost: switchToHttp().getRequest()
// is just getArgs()[0], whatever the transport is.
function executionContext(type: string, args: unknown[]): ExecutionContext {
  return {
    getType: () => type,
    getArgs: () => args,
    switchToHttp: () => ({ getRequest: () => args[0] }),
  } as unknown as ExecutionContext;
}

const caller: AuthContext = {
  user: { id: 7 },
  organization: { id: 3 },
};
const forged: AuthContext = {
  user: { id: 99 },
  organization: { id: 99 },
};

// @nest-native/trpc dispatches guards with args = [input, trpcCtx] and
// type 'rpc' (see its trpc-context-creator).
test('tRPC: the procedure context is the authentication source', () => {
  const context = executionContext('rpc', [{ projectId: 1 }, { authContext: caller }]);
  assert.deepEqual(readAuthContext(context), caller);
});

test('tRPC: a caller-supplied input is never an authentication source', () => {
  const context = executionContext('rpc', [
    { authContext: forged },
    { authContext: undefined },
  ]);
  assert.equal(readAuthContext(context), undefined);
});

test('HTTP: the request carries the auth context', () => {
  const context = executionContext('http', [
    { headers: {}, authContext: caller },
    { statusCode: 200 },
  ]);
  assert.deepEqual(readAuthContext(context), caller);
});

test('HTTP: an unauthenticated request yields no context', () => {
  const context = executionContext('http', [{ headers: {} }, { statusCode: 200 }]);
  assert.equal(readAuthContext(context), undefined);
});
