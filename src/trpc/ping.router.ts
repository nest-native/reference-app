import { Query, Router } from '@nest-native/trpc';
import { z } from 'zod';

export const PingOutputSchema = z.literal('pong');

@Router()
export class PingRouter {
  @Query({ output: PingOutputSchema })
  ping(): 'pong' {
    return 'pong';
  }
}
