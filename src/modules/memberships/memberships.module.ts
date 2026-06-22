import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { MembershipsRepository } from './memberships.repository';

@Module({
  imports: [DrizzleModule.forFeature([MembershipsRepository])],
  exports: [DrizzleModule.forFeature([MembershipsRepository])],
})
export class MembershipsModule {}