CREATE TABLE `job_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`job_name` text NOT NULL,
	`payload` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` text,
	`max_attempts` integer,
	`priority` integer,
	`unique_key` text,
	`last_enqueued_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_schedules_name_unique` ON `job_schedules` (`name`);--> statement-breakpoint
CREATE INDEX `job_schedules_enabled_next_run_idx` ON `job_schedules` (`enabled`,`next_run_at`);