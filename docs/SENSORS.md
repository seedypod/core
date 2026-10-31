---
type: "Guide"
title: "Adding a probe"
description: "Fit a pH, EC or water-temperature probe, add it from the Sensors screen, calibrate it, and remove it."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T08:30:00+00:00"}
sources: [{"resource": "/adr/0018-runtime-sensor-inventory.md", "title": "ADR 0018: Runtime sensor inventory"}, {"resource": "/hardware/hal.md", "title": "hald reference"}]
---

# Adding a probe

seedypod reads Atlas Scientific EZO circuits on the Pi's I²C bus: **pH**,
**conductivity (EC)** and **water temperature (RTD)**. You add them from the app;
there's no config file to edit and nothing to restart.

> Not yet verified on a real Gardyn (Phase 1). Everything below works against
> the simulator and the live demo.

## 1. Wire it

Put the EZO circuit in I²C mode, then connect it to the Pi's 3.3 V, GND, SDA
(GPIO2) and SCL (GPIO3). Each circuit has its own factory address: pH 0x63,
EC 0x64, RTD 0x66. Only re-address one if two parts collide.

## 2. Add it

Open **Sensors** → **Add sensor**, pick the probe type, keep the suggested
address and press **Add**. The daemon talks to the circuit first; if it
doesn't answer, nothing is added and you see why (wrong address, loose wire).
Once added, the probe's reading appears under **Water quality** on the home
screen, in Home Assistant, and in the API. It stays added across restarts.

The Sensors screen also lists the built-in parts, and flags any that didn't
respond at startup.

## 3. Calibrate it

Press **Calibrate** on the probe's card and follow the steps; each one shows
the live reading so you can wait for it to settle.

| Probe | Steps |
|---|---|
| pH | Midpoint in pH 7.00 buffer (required; clears earlier points), then optionally pH 4.00 and pH 10.00 |
| EC | Dry, in air; then in reference solution (1.413 mS/cm unless yours says otherwise) |
| Water temperature | In water of a known temperature (an ice-water bath is 0 °C) |

Enter the value printed on your solution if it differs from the suggestion.
Implausible values are refused before anything reaches the probe. **Advanced →
Clear** wipes the stored calibration.

## 4. Remove it

**Remove** on the probe's card stops its readings and deletes it from Home
Assistant; its history is kept. Built-in sensors can't be removed from the app
(the water-level sensor protects the pump).

## For developers

`GET /api/devices`, `POST /api/devices/sensors {kind, addr}`,
`DELETE /api/devices/sensors/{kind}/{addr}` and
`POST /api/sensors/{id}/calibrate`. Agents can read the inventory
(`list_devices`, `seedypod://devices`) but can't change it. To support a new
probe type, see ADR-0018.
