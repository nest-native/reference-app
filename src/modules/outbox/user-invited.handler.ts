import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type OutboxHandlerResult,
  OutboxRegistry,
} from '@nest-native/messaging/in-process';
import {
  isUserInvitedPayload,
  OUTBOX_TOPIC_USER_INVITED,
} from './outbox.constants';
import { FakeEmailTransport } from './fake-email-transport.service';

@Injectable()
export class UserInvitedHandler implements OnModuleInit {
  constructor(
    @Inject(OutboxRegistry) private readonly registry: OutboxRegistry,
    @Inject(FakeEmailTransport)
    private readonly transport: FakeEmailTransport,
  ) {}

  onModuleInit(): void {
    this.registry.register(OUTBOX_TOPIC_USER_INVITED, (payload) =>
      this.handle(payload),
    );
  }

  private handle(payload: Record<string, unknown>): OutboxHandlerResult {
    if (!isUserInvitedPayload(payload)) {
      throw new Error('user.invited: malformed payload');
    }
    this.transport.send({
      to: payload.invitedEmail,
      subject: `You were invited to organization #${payload.orgId}`,
      body: `Hi! You've been added to a project (#${payload.projectId}). Sign in to get started.`,
    });
    return 'completed';
  }
}
