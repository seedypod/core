CREATE TABLE `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`destination` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`ok` integer NOT NULL,
	`detail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backups_ts` ON `backups` (`ts`);