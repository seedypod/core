CREATE TABLE `schedule_library` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cycles` text DEFAULT '[]' NOT NULL,
	`lightPresetId` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`lastUsedAt` text
);
--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `protocolId` text;--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `shiftDays` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `holdStageId` text;--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `holdSince` text;--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `thenKind` text DEFAULT 'stay' NOT NULL;--> statement-breakpoint
ALTER TABLE `grow_cycles` ADD `thenScheduleId` text;