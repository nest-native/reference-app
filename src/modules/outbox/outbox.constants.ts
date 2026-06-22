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

/**
 * Runtime type guard for {@link UserInvitedPayload}. Single-sourced here so the
 * producer-side handler and the consumer-side inbox validate the `user.invited`
 * contract against the same predicate — the wire shape is defined once.
 */
export function isUserInvitedPayload(
  value: unknown,
): value is UserInvitedPayload {
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
