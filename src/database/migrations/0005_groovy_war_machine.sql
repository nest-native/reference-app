CREATE TABLE `lockout_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`first_failure_at` integer NOT NULL,
	`last_failure_at` integer NOT NULL
);
