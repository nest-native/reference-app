import { Module } from '@nestjs/common';
import { TrpcModule } from 'nest-trpc-native';
import { join } from 'node:path';
import { loadEnv } from '../config/env';
import { PingRouter } from './ping.router';

const env = loadEnv();

@Module({
  imports: [
    TrpcModule.forRoot({
      path: env.trpcPath,
      autoSchemaFile: join(process.cwd(), 'src/@generated/server.ts'),
    }),
  ],
  providers: [PingRouter],
})
export class AppTrpcModule {}
