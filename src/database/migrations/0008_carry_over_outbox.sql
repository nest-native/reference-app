-- Custom SQL migration file, put your code below! --
-- The rows @nest-native/messaging left behind, carried over to the official outbox's tables.
-- Unpublished events keep their ids, so a consumer's inbox still recognises one the old worker already published.
-- Times move from ISO-8601 text to epoch milliseconds. Failed events become dead letters; completed ones are history.
INSERT INTO `outbox_messages` (`id`, `topic`, `payload`, `headers`, `key`, `created_at`, `available_at`, `attempts`, `last_error`)
SELECT `id`, `topic`, `payload`,
  CASE WHEN `idempotency_key` IS NULL THEN '{}' ELSE json_object('x-idempotency-key', `idempotency_key`) END,
  NULL,
  CAST(round(unixepoch(`created_at`, 'subsec') * 1000) AS INTEGER),
  CAST(round(unixepoch(`available_at`, 'subsec') * 1000) AS INTEGER),
  `attempts`, `last_error`
FROM `outbox_events` WHERE `status` IN ('pending', 'processing') ORDER BY `created_at`, `id`;
--> statement-breakpoint
-- The events the old worker gave up on, as dead letters that OutboxDeadLetters lists, requeues and purges: `exhausted`
-- when they ran out of attempts, `rejected` when an error failed them for good first. They never had a seq, so they get
-- -n to -1 in the order they were created: below anything AUTOINCREMENT hands out, so a requeued one never takes the seq
-- of a message added after the upgrade.
INSERT INTO `outbox_dead_letters` (`id`, `seq`, `topic`, `payload`, `headers`, `key`, `created_at`, `attempts`, `last_error`, `history`, `reason`, `failed_at`)
SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) - count(*) OVER () - 1, `topic`, `payload`,
  CASE WHEN `idempotency_key` IS NULL THEN '{}' ELSE json_object('x-idempotency-key', `idempotency_key`) END,
  NULL,
  CAST(round(unixepoch(`created_at`, 'subsec') * 1000) AS INTEGER),
  `attempts`, `last_error`, '[]',
  CASE WHEN `attempts` >= `max_attempts` THEN 'exhausted' ELSE 'rejected' END,
  CAST(round(unixepoch(coalesce(`processed_at`, `available_at`), 'subsec') * 1000) AS INTEGER)
FROM `outbox_events` WHERE `status` = 'failed';
--> statement-breakpoint
-- The consumers' dedup records, under the same consumer names (Kafka `<topic>:<group>`, the RabbitMQ queue) and keys.
INSERT INTO `outbox_inbox` (`consumer`, `message_id`, `processed_at`)
SELECT `source`, `message_key`, CAST(round(unixepoch(`processed_at`, 'subsec') * 1000) AS INTEGER)
FROM `inbox_events` WHERE true
ON CONFLICT DO NOTHING;
