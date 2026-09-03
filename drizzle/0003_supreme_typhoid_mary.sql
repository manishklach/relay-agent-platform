CREATE TABLE `run_checkpoints` (
	`run_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`status` text NOT NULL,
	`state_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_checkpoints_workspace_status` ON `run_checkpoints` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_run_checkpoints_lease` ON `run_checkpoints` (`status`,`lease_expires_at`);