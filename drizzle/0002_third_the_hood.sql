CREATE TABLE `tool_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`retry_safe` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`next_attempt_at` integer NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tool_executions_approval` ON `tool_executions` (`approval_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tool_executions_idempotency` ON `tool_executions` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_tool_executions_claim` ON `tool_executions` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_tool_executions_run` ON `tool_executions` (`run_id`,`created_at`);