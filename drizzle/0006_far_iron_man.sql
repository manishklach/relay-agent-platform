CREATE TABLE `harness_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`split` text NOT NULL,
	`benchmark` text NOT NULL,
	`input` text NOT NULL,
	`expected_json` text NOT NULL,
	`grader_type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `harness_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_harness_cases_project_split` ON `harness_cases` (`project_id`,`split`,`benchmark`);--> statement-breakpoint
CREATE TABLE `harness_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`harness_version_id` text NOT NULL,
	`split` text NOT NULL,
	`benchmark` text NOT NULL,
	`lane` text NOT NULL,
	`executor_mode` text NOT NULL,
	`executor_config_json` text NOT NULL,
	`status` text NOT NULL,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`results_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `harness_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`harness_version_id`) REFERENCES `harness_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_harness_evals_version` ON `harness_evaluations` (`harness_version_id`,`split`,`lane`,`status`);--> statement-breakpoint
CREATE INDEX `idx_harness_evals_project_created` ON `harness_evaluations` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `harness_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`domain` text NOT NULL,
	`creator_agent_version_id` text NOT NULL,
	`status` text NOT NULL,
	`official_candidate_budget` integer NOT NULL,
	`probe_budget_per_round` integer NOT NULL,
	`official_candidates_used` integer DEFAULT 0 NOT NULL,
	`baseline_version_id` text,
	`final_version_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_harness_projects_workspace_status` ON `harness_projects` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `harness_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`artifact_json` text NOT NULL,
	`constraint_audit_json` text NOT NULL,
	`creator_agent_version_id` text NOT NULL,
	`official_submitted` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `harness_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_harness_versions_number` ON `harness_versions` (`project_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_harness_versions_stage` ON `harness_versions` (`project_id`,`stage`,`status`);