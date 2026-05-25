export const OUTBOX_REGISTRY = Symbol.for('reference-app:outbox-registry');
export const FAKE_EMAIL_TRANSPORT = Symbol.for('reference-app:fake-email-transport');

export const OUTBOX_TOPIC_USER_INVITED = 'user.invited' as const;
export type OutboxTopic = typeof OUTBOX_TOPIC_USER_INVITED;

export interface UserInvitedPayload {
  invitedEmail: string;
  invitedUserId: number;
  invitedByUserId: number;
  orgId: number;
  projectId: number;
}
