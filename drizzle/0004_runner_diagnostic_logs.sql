CREATE TABLE IF NOT EXISTS `runner_diagnostic_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`runner_token_id` text NOT NULL,
	`device_id` text NOT NULL,
	`event_id` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`operation` text NOT NULL,
	`severity` text NOT NULL,
	`job_id` text,
	`task_kind` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`event_json` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_token_id`) REFERENCES `runner_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_runner_diagnostic_token_event` ON `runner_diagnostic_logs` (`runner_token_id`,`event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runner_diagnostic_owner_received` ON `runner_diagnostic_logs` (`owner_user_id`,`received_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runner_diagnostic_token_received` ON `runner_diagnostic_logs` (`runner_token_id`,`received_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runner_diagnostic_job` ON `runner_diagnostic_logs` (`job_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runner_diagnostic_upload_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`runner_token_id` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_token_id`) REFERENCES `runner_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runner_diagnostic_request_token_status` ON `runner_diagnostic_upload_requests` (`runner_token_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runner_diagnostic_request_owner_created` ON `runner_diagnostic_upload_requests` (`owner_user_id`,`created_at`);


