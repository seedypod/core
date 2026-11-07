CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`mode` text DEFAULT 'staggered' NOT NULL,
	`request` text NOT NULL,
	`layout` text NOT NULL,
	`sowing` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`appliedAt` text,
	`issued` text DEFAULT '[]' NOT NULL
);
