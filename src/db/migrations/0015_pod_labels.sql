CREATE TABLE `pod_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`captureId` text NOT NULL,
	`ts` text NOT NULL,
	`camera` text NOT NULL,
	`slot` integer NOT NULL,
	`label` text NOT NULL,
	`labelledAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pod_labels_key` ON `pod_labels` (`captureId`,`slot`);--> statement-breakpoint
CREATE INDEX `pod_labels_ts` ON `pod_labels` (`ts`);