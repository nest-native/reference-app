CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 10 NOT NULL,
	`unique_key` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`claimed_at` text,
	`claimed_by` text,
	`processed_at` text,
	`last_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_name_unique_key_unique` ON `jobs` (`name`,`unique_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_available_idx` ON `jobs` (`status`,`available_at`);