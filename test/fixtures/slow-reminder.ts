import { AssignmentReminderHandler } from '../../src/modules/reminders/assignment-reminder.handler';

// Preloaded into a worker by worker-shutdown.spec.ts (`--import`): the
// assignment reminder becomes a job that runs for SLOW_JOB_MS before it does
// its work, so the jobs loop's tick outlives a signal sent meanwhile. It says
// on stdout when it starts.
const original = AssignmentReminderHandler.prototype.handle;
AssignmentReminderHandler.prototype.handle = async function (payload, ctx) {
  process.stdout.write('slow job running\n');
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.SLOW_JOB_MS ?? 2_000)),
  );
  original.call(this, payload, ctx);
};
