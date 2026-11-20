ALTER TABLE `device_settings` ADD `notifyTarget` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `ntfyServer` text DEFAULT 'https://ntfy.sh' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `ntfyTopic` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `webhookUrl` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `webhookFormat` text DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `webhookSecret` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `notifyGroups` text;