import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../../src/auth/password';

test('hashPassword produces scrypt$<salt>$<hash> format', () => {
  const hash = hashPassword('correct-horse');
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});

test('verifyPassword accepts the correct password', () => {
  const hash = hashPassword('correct-horse');
  assert.equal(verifyPassword('correct-horse', hash), true);
});

test('verifyPassword rejects the wrong password', () => {
  const hash = hashPassword('correct-horse');
  assert.equal(verifyPassword('battery-staple', hash), false);
});

test('verifyPassword rejects malformed hashes', () => {
  assert.equal(verifyPassword('any', 'not-a-hash'), false);
  assert.equal(verifyPassword('any', 'scrypt$only-two-parts'), false);
  assert.equal(verifyPassword('any', 'bcrypt$abc$def'), false);
  assert.equal(verifyPassword('any', 'scrypt$$abc'), false);
});

test('hashPassword produces a different salt every call', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
});
