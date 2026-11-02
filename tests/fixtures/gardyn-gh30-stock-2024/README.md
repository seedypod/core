# Stock Gardyn Home 3.0 sensor history (Oct–Nov 2024)

Two and a half weeks of readings from a real Gardyn Home 3.0, taken from the logs on its stock microSD card. Use them for the simulator and for tests that need real behaviour, such as the pump losing prime.

- **Unit:** Gardyn Home 3.0 (hardware profile `hw_gh30`), stock firmware `master.440`, Raspberry Pi Zero W Rev 1.1, DHT20 air sensor.
- **Span:** 2024-10-17T19:51 to 2024-11-05T10:57, in the unit's local time (`America/Los_Angeles`). It covers one full tank, from just after a fill to empty.
- **Source:** `syslog` and `daemon.log`, including rotations, read from a backup image of the card on 2026-11-01. Lines that appear in both files are kept once.
- **Excluded:** every identifier, namely the Wi-Fi SSID, camera upload URLs, device ids, serials and keys. No Gardyn code is included; the firmware is proprietary.

## Files

### `telemetry.csv`
One row per message the unit sent to Gardyn's cloud. That's every 30 minutes, plus one whenever the light or pump changed.

| Column | Meaning |
|---|---|
| `ts` | Local time |
| `reason` | `_` for a periodic message, otherwise the change: `light.boost`, `light.off`, `pump.auto_on`, `pump.auto_off`, `pump.on`, `pump.off`, `pump.gardian_off` (the 15-minute limit), and so on |
| `water_cm` | Median ultrasonic distance, lid to water (cm); larger means less water |
| `board_c` | PCB temperature (PCT2075, °C) |
| `cpu_c` | Pi CPU temperature (°C) |
| `air_c`, `humidity_pct` | DHT20 readings |
| `light_pct` | Grow light level; this unit only ever used 0 or 100 |
| `pump` | `on`/`off` as the firmware believed it (see caveats) |
| `pump_power_mw` | INA219 pump power, when the message reports it |
| `wifi_signal` | Wi-Fi signal (dBm) |

### `water_level_1min.csv`
Raw DYP-A01 pings grouped by minute (about 5 a minute). Readings outside 3–25 cm are counted in `bad_pings` and left out of the other columns. Most bad pings are under 3 cm, inside the sensor's blind zone.

| Column | Meaning |
|---|---|
| `minute` | Local time, to the minute |
| `pings` | Good pings that minute |
| `median_cm` | Median of the good pings |
| `min_cm`, `max_cm` | Range of the good pings |
| `bad_pings` | Pings rejected as out of range or failed |

### `pump_runs.csv`
One row per pump run. The stock firmware drives the pump fully on (no PWM) and logs an INA219 summary at the end of each run.

| Column | Meaning |
|---|---|
| `start`, `end` | Local time |
| `complete` | `0` when the log has a gap (power loss or reboot) before the run ended; `end` and `duration_s` are then blank |
| `end_reason` | `pump.auto_off` (schedule), `pump.off` (stopped from the app), `pump.gardian_off` (15-minute limit), or `log gap` |
| `duration_s` | Run length |
| `samples` | INA219 readings, about 1 a second |
| `power_median_mw`, `power_stdev_mw` | Pump power over the run |
| `read_errors` | Failed INA219 reads |
| `water_cm_at_start` | Last median water distance before the run |

## What the data shows

- **Tank:** about 5.9 cm after a fill and about 20 cm empty, falling about 1.3 cm a day.
- **Pump:** about 10.7 W while lifting water. From about 19.6 cm the draw falls to about 6.8 W, and once the pump has lost prime it is about 3.3 W.
- **Board temperature:** 23–53 °C, highest with the light at 100 %. CPU: 38–60 °C.
- **Schedules, as observed:** light at 100 % from 09:00 to 23:00; pump for 5 minutes at 03:00, 09:00, 15:00 and 21:00. The schedule files left on the card were last changed on the final day and differ from this.

## Caveats

- `pump` in `telemetry.csv` comes from a status file. After a power loss it can read `on` while the pump is off. The two `log gap` runs are such cases, not runs that kept going.
- `water_cm` is whatever the firmware estimated at the time, so it can lag the per-minute medians.
- The stock firmware used a 0.08 Ω shunt for the INA219, and these power figures are on that calibration.
