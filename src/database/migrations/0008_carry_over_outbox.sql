-- Custom SQL migration file, put your code below! --
-- The rows @nest-native/messaging left behind, carried over to the official outbox's tables.
-- Unpublished events keep their ids, so a consumer's inbox still recognises one the old worker already published.
-- Times move from ISO-8601 text to epoch milliseconds. Failed events are not carried over.
INSERT INTO `outbox_messages` (`id`, `topic`, `payload`, `headers`, `key`, `created_at`, `available_at`, `attempts`, `last_error`)
SELECT `id`, `topic`, `payload`,
  CASE WHEN `idempotency_key` IS NULL THEN '{}' ELSE json_object('x-idempotency-key', `idempotency_key`) END,
  NULL,
  CAST(round(unixepoch(`created_at`, 'subsec') * 1000) AS INTEGER),
  CAST(round(unixepoch(`available_at`, 'subsec') * 1000) AS INTEGER),
  `attempts`, `last_error`
FROM `outbox_events` WHERE `status` IN ('pending', 'processing') ORDER BY `created_at`, `id`;
--> statement-breakpoint
-- The consumers' dedup records, under the same consumer names (Kafka `<topic>:<group>`, the RabbitMQ queue) and keys.
INSERT INTO `outbox_inbox` (`consumer`, `message_id`, `processed_at`)
SELECT `source`, `message_key`, CAST(round(unixepoch(`processed_at`, 'subsec') * 1000) AS INTEGER)
FROM `inbox_events` WHERE true
ON CONFLICT DO NOTHING;
