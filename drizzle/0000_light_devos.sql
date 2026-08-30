CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`source_project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_owner_updated` ON `projects` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_owner_source` ON `projects` (`owner_user_id`,`source_project_id`);--> statement-breakpoint
CREATE TABLE `runner_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`leased_by` text,
	`lease_token_hash` text,
	`lease_expires_at` integer,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_runner_jobs_owner_status_created` ON `runner_jobs` (`owner_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runner_jobs_project_created` ON `runner_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `runner_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runner_tokens_hash` ON `runner_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_runner_tokens_owner` ON `runner_tokens` (`owner_user_id`);