import { Module } from '@nestjs/common';
import { TrpcModule } from 'nest-trpc-native';
import { join } from 'node:path';
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

@Module({
  imports: [
    AuthModule,
    TrpcModule.forRoot<AppTrpcContext>({
      path: env.trpcPath,
      autoSchemaFile: join(process.cwd(), 'src/@generated/server.ts'),
      createContext: ({ req }: { req: AuthenticatedRequest }) => ({
        authContext: req.authContext ?? null,
      }),
    }),
  ],
  providers: [PingRouter],
})
export class AppTrpcModule {}
