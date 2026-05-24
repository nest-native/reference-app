import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub: number;
  org: number | null;
  iat: number;
  exp: number;
}

const HEADER_JSON = JSON.stringify({ alg: 'HS256', typ: 'JWT' });

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64UrlDecode(input: string): Buffer {
  const pad = (4 - (input.length % 4)) % 4;
  const standard = input.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(pad);
  return Buffer.from(standard, 'base64');
}

function sign(message: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(message).digest());
}

const ENCODED_HEADER = base64UrlEncode(HEADER_JSON);

export function signJwt(
  payload: Pick<JwtPayload, 'sub' | 'org'>,
  secret: string,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const encodedPayload = base64UrlEncode(JSON.stringify(full));
  const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export class JwtError extends Error {
  constructor(public readonly reason: 'malformed' | 'algorithm' | 'signature' | 'expired') {
    super(`jwt:${reason}`);
  }
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  const [header, payload, signature] = parts;
  if (header !== ENCODED_HEADER) throw new JwtError('algorithm');

  const expected = sign(`${header}.${payload}`, secret);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new JwtError('signature');
  }

  const parsed = JSON.parse(base64UrlDecode(payload).toString()) as JwtPayload;
  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new JwtError('expired');
  }
  return parsed;
}
