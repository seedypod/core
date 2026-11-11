CREATE TABLE `pod_code_reads` (
	`slot` integer PRIMARY KEY NOT NULL,
	`camera` text NOT NULL,
	`code` text,
	`confidence` real NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pod_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`plant` text NOT NULL,
	`confirmedAt` text NOT NULL
);
