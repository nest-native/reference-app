import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { OutboxProducer } from '@nest-native/messaging';
import type { SqliteOutboxStore } from '@nest-native/messaging/sqlite';
import type {
  CurrentOrganizationContext,
  CurrentUserContext,
} from '../../auth/auth-context';
import {
  CURRENT_ORGANIZATION,
  CURRENT_USER,
} from '../../context/request-context.module';
import type { Task } from '../../database/schema';
import {
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
  type TaskAssignedPayload,
  type TaskCompletedPayload,
  type TaskCreatedPayload,
} from '../outbox/outbox.constants';
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
    @Inject(CURRENT_USER)
    private readonly currentUser: CurrentUserContext | null,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
    // Typed with the SQLite store so `enqueue` returns the row synchronously —
    // callable inside these synchronous @Transactional bodies (see onboarding).
    @Inject(OutboxProducer)
    private readonly outbox: OutboxProducer<SqliteOutboxStore>,
  ) {}

  // Each mutation is a single transaction: the row write AND the matching
  // outbox event commit atomically (the dual-write guarantee). The claimer then
  // relays the event to the activity feed. The @Transactional() cast bridges the
  // synchronous better-sqlite3 body to the Promise signature the decorator
  // imposes on callers — the same pattern as OrganizationOnboardingService.

  @Transactional()
  createTask(input: CreateTaskArgs): Promise<Task> {
    const org = this.requireOrg();
    const user = this.requireUser();
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
    this.outbox.enqueue({
      topic: OUTBOX_TOPIC_TASK_CREATED,
      payload,
      idempotencyKey: `${OUTBOX_TOPIC_TASK_CREATED}:${org.id}:${task.id}`,
    });

    return task as unknown as Promise<Task>;
  }

  @Transactional()
  assignTask(input: AssignTaskArgs): Promise<Task> {
    const org = this.requireOrg();
    const user = this.requireUser();
    const task = this.repo.assign(org.id, input.id, input.assigneeId);
    if (!task) throw new NotFoundException(`Task ${input.id} not found`);

    const payload: TaskAssignedPayload = {
      taskId: task.id,
      orgId: org.id,
      projectId: task.projectId,
      assigneeId: input.assigneeId,
      assignedBy: user.id,
    };
    this.outbox.enqueue({
      topic: OUTBOX_TOPIC_TASK_ASSIGNED,
      payload,
      idempotencyKey: `${OUTBOX_TOPIC_TASK_ASSIGNED}:${org.id}:${task.id}:${input.assigneeId}`,
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
    this.outbox.enqueue({
      topic: OUTBOX_TOPIC_TASK_COMPLETED,
      payload,
      idempotencyKey: `${OUTBOX_TOPIC_TASK_COMPLETED}:${org.id}:${task.id}`,
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
