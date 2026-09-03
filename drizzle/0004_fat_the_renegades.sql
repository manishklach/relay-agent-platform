CREATE TABLE `agent_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`config_json` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`parent_version_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_versions_number` ON `agent_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_agent_versions_status` ON `agent_versions` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `graph_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`graph_id` text NOT NULL,
	`graph_version_id` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`graph_version_id`) REFERENCES `graph_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_graph_runs_workspace_status` ON `graph_runs` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_graph_runs_lease` ON `graph_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `graph_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition_json` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`graph_id`) REFERENCES `graphs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_graph_versions_number` ON `graph_versions` (`graph_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_graph_versions_status` ON `graph_versions` (`graph_id`,`status`);--> statement-breakpoint
CREATE TABLE `graphs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_graphs_workspace_status` ON `graphs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `improvement_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`base_version_id` text NOT NULL,
	`candidate_version_id` text NOT NULL,
	`evaluation_suite_id` text NOT NULL,
	`evaluation_run_id` text,
	`minimum_score` real NOT NULL,
	`score` real,
	`status` text NOT NULL,
	`rationale` text NOT NULL,
	`proposed_by` text NOT NULL,
	`reviewed_by` text,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	`activated_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_suite_id`) REFERENCES `evaluation_suites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_run_id`) REFERENCES `evaluation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_improvements_workspace_status` ON `improvement_proposals` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_improvements_agent` ON `improvement_proposals` (`agent_id`,`created_at`);