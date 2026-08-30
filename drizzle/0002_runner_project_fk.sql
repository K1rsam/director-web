ALTER TABLE `runner_jobs` RENAME TO `prototype_runner_jobs`;
--> statement-breakpoint
ALTER TABLE `projects` RENAME TO `prototype_projects`;
--> statement-breakpoint
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
	FOREIGN KEY (`project_id`) REFERENCES `Project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_active_runner_jobs_owner_status_created` ON `runner_jobs` (`owner_user_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_active_runner_jobs_project_created` ON `runner_jobs` (`project_id`,`created_at`);
