CREATE TABLE `run_agent_versions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`agent_version_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action
);
