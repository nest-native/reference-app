import { Logger, Module } from '@nestjs/common';
import { TrpcModule } from '@nest-native/trpc';
import { join } from 'node:path';
import superjson from 'superjson';
import { ZodError, z } from 'zod';
import { AuthModule } from '../auth/auth.module';
import type {
  AuthContext,
  AuthenticatedRequest,
} from '../auth/auth-context';
import { loadEnv } from '../config/env';
import { PingRouter } from './ping.router';

const env = loadEnv();

export interface AppTrpcContext {
  authContext: AuthContext | null;
}

const logger = new Logger('Trpc');

/**
 * Queries that are safe to cache at the edge: public, unauthenticated and
 * tenant-independent. Everything else in this API is tenant-scoped, so it
 * must never carry a public cache header.
 */
const PUBLIC_CACHEABLE_QUERIES = new Set(['ping']);

@Module({
  imports: [
    AuthModule,
    TrpcModule.forRoot<AppTrpcContext>({
      path: env.trpcPath,
      autoSchemaFile: join(process.cwd(), 'src/@generated/server.ts'),
      createContext: ({ req }: { req: AuthenticatedRequest }) => ({
        authContext: req.authContext ?? null,
      }),

      // superjson (de)serializes every payload, so `Date` fields — e.g. the
      // activity feed's `createdAt` — cross the wire as real `Date` instances.
      // Combined with `autoSchemaFile`, the generated `AppRouter` is marked
      // transformer-enabled, which makes a client link without the matching
      // `transformer: superjson` a compile-time error (see client-smoke/).
      transformer: superjson,

      // Canonical tRPC recipe: when input validation fails, expose the
      // flattened Zod issues so typed clients can map errors back to fields.
      // Runs after HttpException → TRPCError mapping, so `error.code` is
      // already the mapped tRPC code.
      errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: {
          ...shape.data,
          zodError:
            error.code === 'BAD_REQUEST' && error.cause instanceof ZodError
              ? z.flattenError(error.cause)
              : null,
        },
      }),

      // Edge caching for the public health-style query only — every other
      // procedure is tenant-scoped and must never be publicly cacheable.
      responseMeta: ({ type, errors, paths }) =>
        type === 'query' &&
        errors.length === 0 &&
        paths !== undefined &&
        paths.every((path) => PUBLIC_CACHEABLE_QUERIES.has(path))
          ? { headers: { 'cache-control': 'public, max-age=60' } }
          : {},

      // Centralized error reporting: one hook sees every failed procedure
      // call before the response is sent.
      onError: ({ path, error }) => {
        logger.debug(
          `tRPC ${error.code} on "${path ?? '<router>'}": ${error.message}`,
        );
      },
    }),
  ],
  providers: [PingRouter],
})
export class AppTrpcModule {}
