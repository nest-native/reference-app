CREATE TABLE `outbox_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`topic` text NOT NULL,
	`payload` text,
	`headers` text NOT NULL,
	`key` text,
	`created_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text,
	`history` text NOT NULL,
	`reason` text NOT NULL,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_dead_letters_topic_failed_at_idx` ON `outbox_dead_letters` (`topic`,`failed_at`);--> statement-breakpoint
CREATE TABLE `outbox_inbox` (
	`consumer` text NOT NULL,
	`message_id` text NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`consumer`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `outbox_inbox_processed_at_idx` ON `outbox_inbox` (`processed_at`);--> statement-breakpoint
CREATE TABLE `outbox_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`topic` text NOT NULL,
	`payload` text,
	`headers` text NOT NULL,
	`key` text,
	`created_at` integer NOT NULL,
	`available_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`history` text DEFAULT '[]' NOT NULL,
	`lease_owner` text,
	`lease_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_messages_id_unique` ON `outbox_messages` (`id`);--> statement-breakpoint
CREATE INDEX `outbox_messages_key_seq_idx` ON `outbox_messages` (`key`,`seq`) WHERE "outbox_messages"."key" IS NOT NULL;