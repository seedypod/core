CREATE TABLE `pod_growth` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`slot` integer NOT NULL,
	`green` real NOT NULL,
	`captureId` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pod_growth_slot_ts` ON `pod_growth` (`slot`,`ts`);