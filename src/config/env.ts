import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  trpcPath: string;
}

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return parsed;
}

function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return join(
    tmpdir(),
    `nest-native-reference-app-${process.pid}-${Date.now()}.db`,
  );
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  return {
    nodeEnv,
    port: readPort(),
    databaseUrl: readDatabaseUrl(),
    trpcPath: process.env.TRPC_PATH ?? '/trpc',
  };
}
