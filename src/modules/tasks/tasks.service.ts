import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { Outbox } from '@nestjs/outbox';
import type {
  CurrentOrganizationContext,
  CurrentUserContext,
} from '../../auth/auth-context';
import {
  CURRENT_ORGANIZATION,
  CURRENT_USER,
} from '../../context/request-context.module';
import type { AppDatabase } from '../../database/database';
import type { Task } from '../../database/schema';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import {
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
  type TaskAssignedPayload,
  type TaskCompletedPayload,
  type TaskCreatedPayload,
} from '../outbox/outbox.constants';
import { X_IDEMPOTENCY_KEY } from '../outbox/wire-contract';
import { TasksRepository } from './tasks.repository';

export interface CreateTaskArgs {
  projectId: number;
  title: string;
}

export interface AssignTaskArgs {
  id: number;
  assigneeId: number;
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(TasksRepository) private readonly repo: TasksRepository,
    @Inject(ProjectsRepository) private readonly projects: ProjectsRepository,
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository,
    @Inject(CURRENT_USER)
    private readonly currentUser: CurrentUserContext | null,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
    @Inject(Outbox) private readonly outbox: Outbox<AppDatabase>,
    @InjectTransaction() private readonly db: AppDatabase,
  ) {}

  // Each mutation is a single transaction: the row write AND the matching
  // outbox message commit atomically (the dual-write guarantee). The relay then
  // publishes the message to the activity feed. `outbox.add()` runs
  // synchronously, because the app's SQLite store does: the row is part of this
  // better-sqlite3 transaction. The @Transactional() cast bridges the
  // synchronous body to the Promise signature the decorator imposes on
  // callers — the same pattern as OrganizationOnboardingService.

  @Transactional()
  createTask(input: CreateTaskArgs): Promise<Task> {
    const org = this.requireOrg();
    const user = this.requireUser();
    // `projectId` is caller input and the tasks table carries its own org id, so
    // without this the task would attach to a project of ANOTHER tenant. The
    // error is identical whether the project belongs to someone else or does not
    // exist at all — a distinct message would be a cross-tenant existence oracle.
    if (!this.projects.findByIdInOrg(input.projectId, org.id)) {
      throw new NotFoundException(`Project ${input.projectId} not found`);
    }
    const task = this.repo.create({
      orgId: org.id,
      projectId: input.projectId,
      title: input.title,
      createdBy: user.id,
    });

    const payload: TaskCreatedPayload = {
      taskId: task.id,
      orgId: org.id,
      projectId: task.projectId,
      title: task.title,
      createdBy: user.id,
    };
    this.outbox.add(this.db, {
      topic: OUTBOX_TOPIC_TASK_CREATED,
      payload,
      headers: {
        [X_IDEMPOTENCY_KEY]: `${OUTBOX_TOPIC_TASK_CREATED}:${org.id}:${task.id}`,
      },
    });

    return task as unknown as Promise<Task>;
  }

  @Transactional()
  assignTask(input: AssignTaskArgs): Promise<Task> {
    const org = this.requireOrg();
    const user = this.requireUser();
    // The task is org-scoped by the repository, but the assignee is not: only a
    // member of THIS org may hold work here. Same-message rule as createTask —
    // "no such user" and "member of another org" are indistinguishable.
    if (!this.memberships.findByOrgAndUser(org.id, input.assigneeId)) {
      throw new NotFoundException(
        `User ${input.assigneeId} is not a member of this organization`,
      );
    }
    const task = this.repo.assign(org.id, input.id, input.assigneeId);
    if (!task) throw new NotFoundException(`Task ${input.id} not found`);

    const payload: TaskAssignedPayload = {
      taskId: task.id,
      orgId: org.id,
      projectId: task.projectId,
      assigneeId: input.assigneeId,
      assignedBy: user.id,
    };
    this.outbox.add(this.db, {
      topic: OUTBOX_TOPIC_TASK_ASSIGNED,
      payload,
      headers: {
        [X_IDEMPOTENCY_KEY]: `${OUTBOX_TOPIC_TASK_ASSIGNED}:${org.id}:${task.id}:${input.assigneeId}`,
      },
    });

    return task as unknown as Promise<Task>;
  }

  @Transactional()
  completeTask(id: number): Promise<Task> {
    const org = this.requireOrg();
    const user = this.requireUser();
    const task = this.repo.complete(org.id, id);
    if (!task) throw new NotFoundException(`Task ${id} not found`);

    const payload: TaskCompletedPayload = {
      taskId: task.id,
      orgId: org.id,
      projectId: task.projectId,
      completedBy: user.id,
    };
    this.outbox.add(this.db, {
      topic: OUTBOX_TOPIC_TASK_COMPLETED,
      payload,
      headers: {
        [X_IDEMPOTENCY_KEY]: `${OUTBOX_TOPIC_TASK_COMPLETED}:${org.id}:${task.id}`,
      },
    });

    return task as unknown as Promise<Task>;
  }

  listTasks(projectId: number): Task[] {
    const org = this.requireOrg();
    return this.repo.listForProject(org.id, projectId);
  }

  get(id: number): Task {
    const org = this.requireOrg();
    const task = this.repo.findById(org.id, id);
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task;
  }

  private requireOrg(): CurrentOrganizationContext {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    return this.currentOrg;
  }

  private requireUser(): CurrentUserContext {
    if (!this.currentUser) throw new UnauthorizedException();
    return this.currentUser;
  }
}
