/** What each alert kind is called, in the Alerts page and in notifications (ADR-0032). */
export const ALERT_LABEL: Record<string, string> = {
  camera_link_upper: 'Top camera connection', camera_link_lower: 'Bottom camera connection', camera_hub_flaky: 'Camera hub connection',
  water_low: 'Water low', pump_fault: 'Pump fault', dose_fault: 'Dosing lockout', over_temp: 'Board over temperature', camera_missing: 'Camera not capturing', hal_offline: 'Hardware daemon offline', mirror_failed: 'Off-device copy failed',
  reminder_thinning: 'Thin seedlings', reminder_root_check: 'Check roots', reminder_harvest: 'Harvest window', reminder_nutrients: 'Add nutrients', reminder_sow: 'Start new yCubes', reminder_first_harvest: 'First harvest', reminder_schedule_switch: 'Schedule didn’t switch', light_fault: 'Light fault',
  setup_light_schedule: 'No light schedule', setup_pump_schedule: 'No pump schedule', setup_water_sensor: 'Tank sensor',
  watering_followed: 'Watering moved to the next stage', pump_schedule_missed: 'Scheduled watering didn’t run',
  chore_top_off: 'Top off the tank', chore_feed: 'Feed', chore_thin: 'Thin seedlings',
}
