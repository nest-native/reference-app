import { Module } from '@nestjs/common';
import { DrizzleModule } from 'nest-drizzle-native';
import { loadEnv } from '../config/env';
import { createDatabase } from './database';
import { schema } from './schema';

const env = loadEnv();
const handle = createDatabase(env.databaseUrl);

@Module({
  imports: [
    DrizzleModule.forRoot({
      schema,
      connection: handle.db,
      shutdown: () => {
        handle.sqlite.close();
      },
    }),
  ],
  exports: [DrizzleModule],
})
export class DatabaseModule {}
