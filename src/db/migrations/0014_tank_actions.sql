CREATE TABLE `tank_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real,
	`unit` text,
	`product` text,
	`note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tank_actions_ts` ON `tank_actions` (`ts`);