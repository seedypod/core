CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`raisedAt` text NOT NULL,
	`clearedAt` text,
	`acknowledgedAt` text,
	`dismissedAt` text
);
--> statement-breakpoint
CREATE INDEX `alerts_kind_active` ON `alerts` (`kind`,`active`);--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`camera` text NOT NULL,
	`ts` text NOT NULL,
	`path` text NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `captures_camera_ts` ON `captures` (`camera`,`ts`);--> statement-breakpoint
CREATE TABLE `counters` (
	`key` text PRIMARY KEY NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`unitName` text DEFAULT 'Gardyn' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`temperatureUnit` text DEFAULT 'C' NOT NULL,
	`waterFullCm` real DEFAULT 5 NOT NULL,
	`waterEmptyCm` real DEFAULT 20 NOT NULL,
	`tankCapacityL` real DEFAULT 19 NOT NULL,
	`thinningReminderDays` integer DEFAULT 14 NOT NULL,
	`rootCheckReminderDays` integer DEFAULT 21 NOT NULL,
	`harvestReminderDays` integer DEFAULT 35 NOT NULL,
	`nutrientReminderDays` integer DEFAULT 7 NOT NULL,
	`apiKey` text DEFAULT '' NOT NULL,
	`mqttUrl` text,
	`mqttUsername` text,
	`mqttPassword` text,
	`mqttTlsEnabled` integer DEFAULT false NOT NULL,
	`mqttTlsInsecure` integer DEFAULT false NOT NULL,
	`captureIntervalMin` integer DEFAULT 60 NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grow_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`startedAt` text NOT NULL,
	`endedAt` text,
	`stage` text DEFAULT 'germination' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`issued` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pods` (
	`slot` integer PRIMARY KEY NOT NULL,
	`plant` text,
	`plantedAt` text,
	`status` text DEFAULT 'empty' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheduleId` text NOT NULL,
	`key` text NOT NULL,
	`firedAt` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_runs_key_unique` ON `schedule_runs` (`key`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`days` integer DEFAULT 127 NOT NULL,
	`spec` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`sensor` text NOT NULL,
	`value` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telemetry_sensor_ts` ON `telemetry` (`sensor`,`ts`);