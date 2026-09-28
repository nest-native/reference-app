import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import type { Channel, GetMessage, RecoveringChannelModel } from 'amqplib';
import type { InboxDelivery } from '../../src/modules/rabbitmq/inbox-deliveries.service';

// GATED end-to-end against a LIVE RabbitMQ broker — the RabbitMQ profile's
// counterpart of reliable-messaging.kafka.spec.ts. Skipped unless RABBITMQ_URL
// is set; CI's `rabbitmq-e2e` job runs it against a RabbitMQ 4 service
// container through `test:rabbitmq:strict`, which fails if anything skipped.
// To run it locally:
//
//   npm run infra:up        # compose `redpanda` + `rabbitmq` services
//   npm run test:rabbitmq   # this file, with RABBITMQ_URL set for you
//   npm run infra:down
//
// It exercises the whole profile: a transactional enqueue → the claimer
// publishes on a confirm channel → the consumer writes ONE audit row → a forced
// redelivery is recognised as a duplicate; the task lifecycle's three topics on
// one queue, projected into the feed (and the assignment reminder scheduled);
// both dead-letter paths; and the broker dropping the app's connection, which
// needs RABBITMQ_MANAGEMENT_URL (the broker's management API, with
// credentials) as well.
const LIVE = Boolean(process.env.RABBITMQ_URL);
const MANAGEMENT_URL = process.env.RABBITMQ_MANAGEMENT_URL;

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-rabbitmq-e2e-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let onboarding: import('../../src/modules/onboarding/organization-onboarding.service').OrganizationOnboardingService;
let tasksService: import('../../src/modules/tasks/tasks.service').TasksService;
let claimer: import('@nest-native/messaging').OutboxClaimer;
let deliveries: import('../../src/modules/rabbitmq/inbox-deliveries.service').InboxDeliveries;
let inspect: import('../../src/database/database').AppDatabase;
let schema: typeof import('../../src/database/schema');
let topology: typeof import('../../src/modules/rabbitmq/rabbitmq.topology');
let drizzleOps: typeof import('drizzle-orm');
let probe: Channel;
let exchange: string;
let seededOrgId: number;
let seededAdminId: number;
let seededProjectId: number;

before(async () => {
  if (!LIVE) return;
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'rabbitmq-e2e-test-secret-min-32-characters-xx';
  // The two broker profiles are exclusive; this spec is the RabbitMQ one.
  delete process.env.KAFKA_BROKERS;

  const { seedDatabase } = await import('../../scripts/seed');
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;
  seededProjectId = seeded.project.id;

  schema = await import('../../src/database/schema');
  topology = await import('../../src/modules/rabbitmq/rabbitmq.topology');
  drizzleOps = await import('drizzle-orm');
  const { ContextIdFactory, NestFactory } = await import('@nestjs/core');
  const { getDrizzleClientToken } = await import('@nest-native/drizzle');
  const { OutboxClaimer } = await import('@nest-native/messaging');
  const { loadEnv } = await import('../../src/config/env');
  const { InboxDeliveries } = await import(
    '../../src/modules/rabbitmq/inbox-deliveries.service'
  );
  const { OrganizationOnboardingService } = await import(
    '../../src/modules/onboarding/organization-onboarding.service'
  );
  const { TasksService } = await import('../../src/modules/tasks/tasks.service');
  const { AppModule } = await import('../../src/app.module');

  // The queues are durable and outlive a run, and a run that failed midway
  // can leave messages in them. Declare the topology exactly as the app will
  // and empty the queues BEFORE the app subscribes: purging afterwards races
  // the consumers for whatever was left.
  const { connect } = await import('amqplib');
  const setup = await connect(process.env.RABBITMQ_URL!);
  try {
    const channel = await setup.createChannel();
    await topology.declareTopology(channel, loadEnv().rabbitmq!.exchange);
    for (const queue of topology.CONSUMED_QUEUES) {
      await channel.purgeQueue(queue.name);
      await channel.purgeQueue(queue.deadLetterQueue);
    }
  } finally {
    await setup.close();
  }

  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  await app.init(); // declares the topology, then both consumers subscribe
  onboarding = app.get(OrganizationOnboardingService);
  claimer = app.get(OutboxClaimer);
  deliveries = app.get(InboxDeliveries);
  inspect = app.get(getDrizzleClientToken());
  exchange = loadEnv().rabbitmq!.exchange;

  const contextId = ContextIdFactory.create();
  app.registerRequestByContextId(
    {
      authContext: {
        user: { id: seededAdminId },
        organization: { id: seededOrgId },
      },
    },
    contextId,
  );
  tasksService = await app.resolve(TasksService, contextId);

  probe = await app
    .get<RecoveringChannelModel>(topology.RABBITMQ)
    .createChannel();
});

after(async () => {
  if (!LIVE || !app) return;
  await probe.close();
  await app.close();
});

/**
 * Resolves with the first settled delivery matching `match`. Subscribe before
 * causing the delivery, then await: the consumer reports every outcome through
 * InboxDeliveries, so the test waits on the fact rather than on a sleep.
 */
function nextDelivery(
  match: (delivery: InboxDelivery) => boolean,
  timeoutMs = 20_000,
): Promise<InboxDelivery> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no matching delivery within ${timeoutMs}ms`));
    }, timeoutMs);
    const stop = deliveries.listen((delivery) => {
      if (match(delivery)) {
        clearTimeout(timer);
        stop();
        resolve(delivery);
      }
    });
  });
}

async function nextDeadLetter(queue: string, timeoutMs = 20_000): Promise<GetMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await probe.get(queue, { noAck: false });
    if (message) return message;
    if (Date.now() > deadline) throw new Error(`nothing reached ${queue}`);
    await delay(100);
  }
}

const deliveredAuditCount = (subjectId: string) =>
  inspect
    .select()
    .from(schema.auditEvents)
    .where(
      drizzleOps.and(
        drizzleOps.eq(schema.auditEvents.action, 'user.invited.delivered'),
        drizzleOps.eq(schema.auditEvents.subjectId, subjectId),
      ),
    )
    .all().length;

const inboxCount = (key: string) =>
  inspect
    .select()
    .from(schema.inboxEvents)
    .where(drizzleOps.eq(schema.inboxEvents.messageKey, key))
    .all().length;

test(
  'enqueue → confirmed publish → exactly one audit row; a redelivery is acked as a duplicate',
  { skip: !LIVE },
  async () => {
    const invited = await onboarding.inviteUser({
      orgId: seededOrgId,
      invitedByUserId: seededAdminId,
      email: 'rabbitmq.e2e@acme.test',
      projectName: 'RabbitMQ E2E Project',
      initialPassword: 'rabbitmq-pass-1234',
    });
    const subjectId = String(invited.user.id);
    // The inbox dedups on the wire contract's first hit, `x-event-id` — the
    // outbox row id the transport stamps on every message.
    const eventId = invited.outboxEventId;
    const queue = topology.USER_INVITED_QUEUE.name;

    const processed = nextDelivery(
      (d) => d.queue === queue && d.dedupKey === eventId && d.outcome === 'processed',
    );
    // The row completes only once the broker acked the message and did not
    // return it.
    const report = await claimer.tick();
    assert.equal(report.claimed, 1);
    assert.equal(report.completed, 1);
    await processed;
    assert.equal(deliveredAuditCount(subjectId), 1, 'consumer delivered once');
    assert.equal(inboxCount(eventId), 1, 'one inbox dedup row');

    // A redelivery looks exactly like the same message published again.
    const duplicate = nextDelivery(
      (d) => d.queue === queue && d.dedupKey === eventId && d.outcome === 'duplicate',
    );
    const [row] = inspect
      .select()
      .from(schema.outboxEvents)
      .where(drizzleOps.eq(schema.outboxEvents.id, eventId))
      .all();
    probe.publish(exchange, 'user.invited', Buffer.from(JSON.stringify(row!.payload)), {
      messageId: eventId,
      contentType: 'application/json',
      persistent: true,
      headers: {
        'x-event-id': eventId,
        'x-idempotency-key': row!.idempotencyKey ?? eventId,
      },
    });
    await duplicate;
    assert.equal(deliveredAuditCount(subjectId), 1, 'the duplicate wrote no second audit row');
    assert.equal(inboxCount(eventId), 1, 'still exactly one inbox row');
  },
);

test(
  'the task lifecycle arrives on one queue, three bindings, and lands in the feed once',
  { skip: !LIVE },
  async () => {
    const feedFor = (projectId: number) =>
      inspect
        .select()
        .from(schema.activityEvents)
        .where(drizzleOps.eq(schema.activityEvents.projectId, projectId))
        .all();
    const before = feedFor(seededProjectId).length;
    const queue = topology.TASK_ACTIVITY_QUEUE.name;

    const created = await tasksService.createTask({
      projectId: seededProjectId,
      title: 'Ship the RabbitMQ profile',
    });
    await tasksService.assignTask({ id: created.id, assigneeId: seededAdminId });
    await tasksService.completeTask(created.id);

    // Three events, routed by topic to one queue; the consumer picks the
    // projection by routing key.
    const seen: InboxDelivery[] = [];
    const threeProcessed = new Promise<void>((resolve) => {
      const stop = deliveries.listen((delivery) => {
        if (delivery.queue === queue && delivery.outcome === 'processed') {
          seen.push(delivery);
          if (seen.length === 3) {
            stop();
            resolve();
          }
        }
      });
    });
    const report = await claimer.tick();
    assert.equal(report.completed, 3, 'created, assigned and completed published');
    await Promise.race([
      threeProcessed,
      delay(20_000).then(() => {
        throw new Error(`only ${seen.length} of 3 task events processed`);
      }),
    ]);

    const feed = feedFor(seededProjectId);
    assert.equal(feed.length - before, 3, 'one feed row per lifecycle event');
    assert.deepEqual(
      feed.slice(-3).map((row) => row.type).sort(),
      ['task.assigned', 'task.completed', 'task.created'],
    );
    // task.assigned's projection also scheduled the reminder, in the same
    // dedup transaction.
    const reminders = inspect
      .select()
      .from(schema.jobs)
      .where(drizzleOps.eq(schema.jobs.name, 'task.assignment-reminder'))
      .all()
      .filter((job) => (job.payload as { taskId?: number }).taskId === created.id);
    assert.equal(reminders.length, 1, 'exactly one reminder job');
  },
);

test(
  'poison is dead-lettered with its reason; an unknown routing key is rejected into the dead-letter exchange',
  { skip: !LIVE },
  async () => {
    // A payload that can never be processed: republished to the dead-letter
    // queue with the reason, and acked.
    const poisonId = `poison-${randomUUID()}`;
    probe.publish(exchange, 'user.invited', Buffer.from(JSON.stringify({ invitedEmail: 42 })), {
      messageId: poisonId,
      headers: { 'x-event-id': poisonId },
    });
    const poison = await nextDeadLetter(topology.USER_INVITED_QUEUE.deadLetterQueue);
    assert.equal(poison.properties.headers?.['x-event-id'], poisonId);
    assert.equal(poison.properties.headers?.['x-error'], 'payload failed validation');
    probe.ack(poison);

    // A topic the task consumer has no projection for can only arrive through
    // a binding it does not know about. Bind one for the length of the test.
    const queue = topology.TASK_ACTIVITY_QUEUE;
    const strayId = `stray-${randomUUID()}`;
    await probe.bindQueue(queue.name, exchange, 'task.archived');
    try {
      probe.publish(exchange, 'task.archived', Buffer.from('{}'), {
        messageId: strayId,
        headers: { 'x-event-id': strayId },
      });
      const stray = await nextDeadLetter(queue.deadLetterQueue);
      assert.equal(stray.properties.messageId, strayId);
      // Rejected by the broker's own dead-lettering, which records why.
      const death = (stray.properties.headers?.['x-death'] as Array<{ reason: string }>)[0];
      assert.equal(death?.reason, 'rejected');
      probe.ack(stray);
    } finally {
      await probe.unbindQueue(queue.name, exchange, 'task.archived');
    }
  },
);

test(
  'the broker drops the connection: the transport and both consumers carry on without a restart',
  { skip: !LIVE || !MANAGEMENT_URL },
  async () => {
    const rabbit = app.get<RecoveringChannelModel>(topology.RABBITMQ);
    const api = managementApi(MANAGEMENT_URL!);
    // What a broker restart or a network blip looks like to the app.
    const dropped = await connectionOf(api, 'reference-app');
    const response = await api('DELETE', `/api/connections/${encodeURIComponent(dropped)}`);
    assert.equal(response.status, 204, 'the broker closed the connection');
    // The probe lived on that connection; open another once it is back.
    probe = await rabbit.createChannel();

    const invited = await onboarding.inviteUser({
      orgId: seededOrgId,
      invitedByUserId: seededAdminId,
      email: 'rabbitmq.reconnect@acme.test',
      projectName: 'RabbitMQ Reconnect Project',
      initialPassword: 'rabbitmq-pass-1234',
    });
    await tasksService.createTask({ projectId: seededProjectId, title: 'After the reconnect' });
    const invitedProcessed = nextDelivery(
      (d) =>
        d.queue === topology.USER_INVITED_QUEUE.name &&
        d.dedupKey === invited.outboxEventId &&
        d.outcome === 'processed',
    );
    const taskProcessed = nextDelivery(
      (d) => d.queue === topology.TASK_ACTIVITY_QUEUE.name && d.outcome === 'processed',
    );

    // The first publish may still meet the closing channel and fail; the
    // claimer retries it, the way the worker loop would.
    let completed = 0;
    const deadline = Date.now() + 20_000;
    while (completed < 2) {
      completed += (await claimer.tick()).completed;
      if (completed < 2) {
        assert.ok(Date.now() < deadline, `only ${completed} of 2 events published after the reconnect`);
        await delay(200);
      }
    }
    // Both consumers subscribed again on their own.
    await Promise.all([invitedProcessed, taskProcessed]);
    assert.equal(deliveredAuditCount(String(invited.user.id)), 1, 'delivered once');
    await connectionOf(api, 'reference-app', dropped); // the app is on a new connection
  },
);

type ManagementApi = (method: string, path: string) => Promise<Response>;

/** Calls the management API with the credentials from its URL (fetch refuses a URL that carries them). */
function managementApi(url: string): ManagementApi {
  const base = new URL(url);
  const credentials = `${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`;
  const authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  base.username = '';
  base.password = '';
  return (method, path) =>
    fetch(new URL(path, base), {
      method,
      headers: { authorization, 'x-reason': 'reference-app e2e: a simulated broker restart' },
    });
}

/**
 * The broker's name for a connection — found by the name the app gave it —
 * once the management API lists it (its statistics lag a little). With
 * `except`, waits for a connection other than that one: a reconnect.
 */
async function connectionOf(api: ManagementApi, name: string, except?: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await api('GET', '/api/connections');
    const all = (await response.json()) as {
      name: string;
      client_properties?: { connection_name?: string };
    }[];
    const found = all.find(
      (c) => c.client_properties?.connection_name === name && c.name !== except,
    );
    if (found) return found.name;
    if (Date.now() > deadline) throw new Error(`no ${name} connection in the management API`);
    await delay(200);
  }
}
