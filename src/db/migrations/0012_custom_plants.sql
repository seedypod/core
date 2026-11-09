CREATE TABLE `custom_plants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`zone` text NOT NULL,
	`harvestMinMonths` integer NOT NULL,
	`harvestMaxMonths` integer NOT NULL,
	`careLevel` text,
	`size` text DEFAULT 'normal' NOT NULL,
	`succession` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
