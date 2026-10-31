CREATE TABLE `analysis_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`captureId` text NOT NULL,
	`ts` text NOT NULL,
	`camera` text NOT NULL,
	`analyzer` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`slot` integer NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`detail` text,
	`artifact` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_results_key` ON `analysis_results` (`captureId`,`analyzer`,`version`,`slot`,`metric`);--> statement-breakpoint
CREATE INDEX `analysis_results_series` ON `analysis_results` (`analyzer`,`metric`,`slot`,`ts`);--> statement-breakpoint
ALTER TABLE `device_settings` ADD `primaryAnalyzer` text DEFAULT 'green-threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `analysisArtifacts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `analysisIngestToken` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorEndpoint` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorBucket` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorRegion` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorPrefix` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorAccessKeyId` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mirrorSecretAccessKey` text;--> statement-breakpoint
INSERT OR IGNORE INTO `analysis_results` (`captureId`, `ts`, `camera`, `analyzer`, `version`, `source`, `slot`, `metric`, `value`)
SELECT p.`captureId`, p.`ts`,
  COALESCE((SELECT c.`camera` FROM `captures` c WHERE c.`id` = p.`captureId`), CASE WHEN p.`slot` <= 15 THEN 'upper' ELSE 'lower' END),
  'green-threshold', 1, 'device', p.`slot`, 'green_fraction', p.`green`
FROM `pod_growth` p;
