CREATE TABLE `inbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_key` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`processed_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_events_source_message_key_unique` ON `inbox_events` (`source`,`message_key`);