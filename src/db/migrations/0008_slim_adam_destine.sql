CREATE TABLE `plant_profiles` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`harvestMinDays` integer,
	`harvestMaxDays` integer,
	`targetCover` real,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `pods` ADD `statusSince` text;--> statement-breakpoint
ALTER TABLE `pods` ADD `lastHarvestAt` text;--> statement-breakpoint
UPDATE `pods` SET `statusSince` = `updatedAt`;