CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automationId` integer NOT NULL,
	`firedAt` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_runs_rule_time` ON `automation_runs` (`automationId`,`firedAt`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`dryRun` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`cooldownMin` integer,
	`trigger` text NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `device_settings` ADD `autopilotEnabled` integer DEFAULT true NOT NULL;