export const AUTH_CONFIG = Symbol.for('reference-app:auth-config');

export interface AuthConfig {
  secret: string;
  ttlSeconds: number;
}
