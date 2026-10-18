import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { eq } from 'drizzle-orm';
import { Outbox, type OutboxMessage } from '@nestjs/outbox';
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
import {
  OUTBOX_TOPIC_USER_INVITED,
  type UserInvitedPayload,
} from '../outbox/outbox.constants';
import { X_IDEMPOTENCY_KEY } from '../outbox/wire-contract';
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
  /** The outbox message's id: the `x-event-id` consumers deduplicate on. */
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
    @Inject(Outbox) private readonly outbox: Outbox<AppDatabase>,
  ) {}

  // scrypt is slow on purpose, so the password is hashed before the
  // transaction opens: it takes SQLite's write lock at BEGIN, and the worker's
  // writes would wait on the hash.
  inviteUser(input: InviteUserInput): Promise<InviteUserResult> {
    return this.invite(input, hashPassword(input.initialPassword));
  }

  // Declared `Promise<InviteUserResult>` so callers can `await` naturally:
  // @Transactional() always returns a Promise even if the inner body is
  // synchronous (which it must be on better-sqlite3 — the official
  // @nestjs-cls/transactional-adapter-drizzle-orm auto-detects the
  // synchronous sqlite driver and runs the transaction in sync mode).
  // The cast on the return value below bridges the sync body to the Promise
  // signature the decorator imposes on the caller's view of the method.
  //
  // BEGIN IMMEDIATE, because the invite reads the invitee's email before it
  // writes, and SQLite fails a deferred transaction that has read at once
  // (SQLITE_BUSY) when it needs the write lock the worker holds, instead of
  // waiting for it (see TasksService).
  @Transactional<TransactionalAdapterDrizzleOrm<AppDatabase>>({
    behavior: 'immediate',
  })
  private invite(
    input: InviteUserInput,
    passwordHash: string,
  ): Promise<InviteUserResult> {
    const user = this.createInvitee(input.email, passwordHash);
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
    // `add()` is typed Awaitable, but the app's SQLite store answers
    // synchronously, so the message is already built (and its row written in
    // this transaction) when it returns.
    const event = this.outbox.add(this.db, {
      topic: OUTBOX_TOPIC_USER_INVITED,
      payload,
      headers: {
        [X_IDEMPOTENCY_KEY]: `user.invited:${input.orgId}:${user.id}:${project.id}`,
      },
    }) as OutboxMessage<UserInvitedPayload>;

    return { user, membership, project, outboxEventId: event.id } as unknown as Promise<InviteUserResult>;
  }

  /**
   * An invite always creates a NEW account. It deliberately does not attach an
   * existing one: joining an organization is the account owner's decision, and
   * an admin who could attach any address would be able to pull another
   * tenant's user into this org with a role of their choosing — after which
   * that account satisfies every "is a member of this org" predicate, including
   * the assignee check in `TasksService.assignTask`.
   *
   * The "already a member here" and the "belongs to another tenant" cases raise
   * the SAME error, so the refusal never reveals which tenants an address
   * belongs to. It does still reveal that the address HAS an account; removing
   * that last signal needs a pending-invitation row the invitee accepts, which
   * is the shape a production app should reach for.
   */
  private createInvitee(email: string, passwordHash: string): User {
    const existing = this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (existing) {
      throw new ConflictException(
        'An account already exists for this email; it can only join an organization from its own side',
      );
    }
    return this.db
      .insert(users)
      .values({
        email,
        passwordHash,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
}
