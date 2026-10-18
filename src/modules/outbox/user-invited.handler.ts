import { Inject, Injectable } from '@nestjs/common';
import { NonRetryableMessageError, OnOutboxMessage } from '@nestjs/outbox';
import {
  isUserInvitedPayload,
  OUTBOX_TOPIC_USER_INVITED,
} from './outbox.constants';
import { FakeEmailTransport } from './fake-email-transport.service';

@Injectable()
export class UserInvitedHandler {
  constructor(
    @Inject(FakeEmailTransport)
    private readonly transport: FakeEmailTransport,
  ) {}

  // The outbox's local transport skips a message id this consumer already
  // handled, and records it once send() returns: once, unless the worker dies
  // in between, which an email can live with.
  @OnOutboxMessage(OUTBOX_TOPIC_USER_INVITED, { consumer: 'invite-email' })
  sendInvite(payload: unknown): void {
    if (!isUserInvitedPayload(payload)) {
      throw new NonRetryableMessageError('user.invited: malformed payload');
    }
    this.transport.send({
      to: payload.invitedEmail,
      subject: `You were invited to organization #${payload.orgId}`,
      body: `Hi! You've been added to a project (#${payload.projectId}). Sign in to get started.`,
    });
  }
}
