import type { RecordAuditEventInput } from '../audit-log/audit-log.service';
import type { UserInvitedPayload } from '../outbox/outbox.constants';

/**
 * The audit row a delivered `user.invited` event writes — the broker profiles'
 * exactly-once side effect. The Kafka and RabbitMQ consumers both record it,
 * so the two transports leave the same trace; only the delivery differs.
 */
export function userInvitedDelivered(
  invite: UserInvitedPayload,
): RecordAuditEventInput {
  return {
    orgId: invite.orgId,
    actorUserId: invite.invitedByUserId,
    action: 'user.invited.delivered',
    subjectType: 'user',
    subjectId: String(invite.invitedUserId),
    metadata: {
      invitedEmail: invite.invitedEmail,
      projectId: invite.projectId,
    },
  };
}
