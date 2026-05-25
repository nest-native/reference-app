import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  OUTBOX_TOPIC_USER_INVITED,
  type UserInvitedPayload,
} from './outbox.constants';
import { FakeEmailTransport } from './fake-email-transport.service';
import {
  type OutboxHandlerResult,
  OutboxRegistry,
} from './outbox-registry.service';

function isUserInvitedPayload(value: unknown): value is UserInvitedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<UserInvitedPayload>;
  return (
    typeof p.invitedEmail === 'string' &&
    typeof p.invitedUserId === 'number' &&
    typeof p.invitedByUserId === 'number' &&
    typeof p.orgId === 'number' &&
    typeof p.projectId === 'number'
  );
}

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
