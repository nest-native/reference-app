import { Inject, Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../auth/password';
import type { AppDatabase } from '../../database/database';
import {
  type Membership,
  type Project,
  type User,
  users,
} from '../../database/schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { OutboxProducer } from '../outbox/outbox-producer.service';
import {
  OUTBOX_TOPIC_USER_INVITED,
  type UserInvitedPayload,
} from '../outbox/outbox.constants';
import { ProjectsRepository } from '../projects/projects.repository';

export interface InviteUserInput {
  orgId: number;
  invitedByUserId: number;
  email: string;
  projectName: string;
  initialPassword: string;
  role?: 'admin' | 'member' | 'viewer';
}

export interface InviteUserResult {
  user: User;
  membership: Membership;
  project: Project;
  outboxEventId: string;
}

@Injectable()
export class OrganizationOnboardingService {
  constructor(
    @InjectTransaction() private readonly db: AppDatabase,
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository,
    @Inject(ProjectsRepository) private readonly projects: ProjectsRepository,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
    @Inject(OutboxProducer) private readonly outbox: OutboxProducer,
  ) {}

  // Declared `Promise<InviteUserResult>` so callers can `await` naturally:
  // @Transactional() always returns a Promise even if the inner body is
  // synchronous (which it must be on better-sqlite3 — the official
  // @nestjs-cls/transactional-adapter-drizzle-orm auto-detects the
  // synchronous sqlite driver and runs the transaction in sync mode).
  // The cast on the return value below bridges the sync body to the Promise
  // signature the decorator imposes on the caller's view of the method.
  @Transactional()
  inviteUser(input: InviteUserInput): Promise<InviteUserResult> {
    const user = this.upsertUser(input.email, input.initialPassword);
    const membership = this.memberships.create({
      orgId: input.orgId,
      userId: user.id,
      role: input.role ?? 'member',
    });
    const project = this.projects.create({
      orgId: input.orgId,
      name: input.projectName,
      createdBy: input.invitedByUserId,
    });

    this.audit.record({
      orgId: input.orgId,
      actorUserId: input.invitedByUserId,
      action: 'user.invited',
      subjectType: 'user',
      subjectId: String(user.id),
      metadata: {
        invitedEmail: input.email,
        membershipId: membership.id,
        projectId: project.id,
      },
    });

    const payload: UserInvitedPayload = {
      invitedEmail: input.email,
      invitedUserId: user.id,
      invitedByUserId: input.invitedByUserId,
      orgId: input.orgId,
      projectId: project.id,
    };
    const event = this.outbox.enqueue({
      topic: OUTBOX_TOPIC_USER_INVITED,
      payload: payload as unknown as Record<string, unknown>,
      idempotencyKey: `user.invited:${input.orgId}:${user.id}:${project.id}`,
    });

    return { user, membership, project, outboxEventId: event.id } as unknown as Promise<InviteUserResult>;
  }

  private upsertUser(email: string, initialPassword: string): User {
    const existing = this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (existing) return existing;
    return this.db
      .insert(users)
      .values({
        email,
        passwordHash: hashPassword(initialPassword),
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
}
