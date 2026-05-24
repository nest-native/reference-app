import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JwtError, signJwt, verifyJwt } from '../../src/auth/jwt';

const SECRET = 'test-secret-must-be-at-least-32-characters-long-xx';

test('signJwt + verifyJwt round-trip preserves payload', () => {
  const token = signJwt({ sub: 42, org: 7 }, SECRET, 60);
  const payload = verifyJwt(token, SECRET);

  assert.equal(payload.sub, 42);
  assert.equal(payload.org, 7);
  assert.equal(typeof payload.iat, 'number');
  assert.equal(typeof payload.exp, 'number');
  assert.equal(payload.exp - payload.iat, 60);
});

test('verifyJwt rejects malformed tokens', () => {
  assert.throws(
    () => verifyJwt('not-a-jwt', SECRET),
    (err: unknown) => err instanceof JwtError && err.reason === 'malformed',
  );
});

test('verifyJwt rejects a token signed with a different secret', () => {
  const token = signJwt({ sub: 1, org: null }, SECRET, 60);
  assert.throws(
    () => verifyJwt(token, 'different-secret-also-32-characters-min-xxx'),
    (err: unknown) => err instanceof JwtError && err.reason === 'signature',
  );
});

test('verifyJwt rejects a tampered payload', () => {
  const token = signJwt({ sub: 1, org: 1 }, SECRET, 60);
  const [header, payload, sig] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ sub: 999, org: 999, iat: 0, exp: 9_999_999_999 }))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  assert.notEqual(payload, tampered);
  assert.throws(
    () => verifyJwt(`${header}.${tampered}.${sig}`, SECRET),
    (err: unknown) => err instanceof JwtError && err.reason === 'signature',
  );
});

test('verifyJwt rejects expired tokens', () => {
  const token = signJwt({ sub: 1, org: null }, SECRET, -1);
  assert.throws(
    () => verifyJwt(token, SECRET),
    (err: unknown) => err instanceof JwtError && err.reason === 'expired',
  );
});

test('verifyJwt rejects unsupported algorithm headers', () => {
  const fakeHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64')
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  assert.throws(
    () => verifyJwt(`${fakeHeader}.payload.sig`, SECRET),
    (err: unknown) => err instanceof JwtError && err.reason === 'algorithm',
  );
});
