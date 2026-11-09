# Docs update log

## 2026-11-09 (port 80)

- **Update**: User-facing addresses drop `:3000` now that a Pi install forwards port 80 to core: [Installation](INSTALLATION.md) (and when `:3000` is still the address), [Maintenance](MAINTENANCE.md) and [Capture analysis](ANALYSIS.md).

## 2026-11-09

- **Update**: Replaced "hasn't run on a real Gardyn" warnings with what the bring-up verified and what it didn't (pump, water level against water, button, the USB hub) in the README, [handoff](HANDOFF.md), [hald reference](hardware/hal.md#verification-status), [hardware map](hardware/pin-map.md), [Maintenance](MAINTENANCE.md), [Debugging](DEBUGGING.md) and [Installation](INSTALLATION.md#how-long-it-takes); added a status update to [ADR 0023](adr/0023-homekit.md). The README shows the web UI.

## 2026-11-08

- **Update**: [Maintenance → Updates](MAINTENANCE.md#updates) covers **Settings → Updates**: channel, check, update, live progress and the rollback result.
- **Creation**: [ADR 0026](adr/0026-web-update.md), one-click update: a root helper core runs with fixed arguments, checked prebuilt releases, a swap that keeps the previous version, and rollback on a failed health check. The one exception to core's no-internet rule. [Maintenance](MAINTENANCE.md#updates), [Installation](INSTALLATION.md) and [Deployment](DEPLOYMENT.md) cover it.

## 2026-11-06

- **Update**: Recorded the first bring-up on a real unit in the [handoff](HANDOFF.md), with the open USB hub fault and next steps.
- **Update**: Added a marker check for telling the cameras apart to [Maintenance](MAINTENANCE.md#check-which-camera-is-which), and recorded the camera ports and USB routing confirmed on a real unit in the [hardware map](hardware/pin-map.md).
- **Update**: [ADR 0021](adr/0021-sd-card-wear-and-recovery.md) phase 4 built as amended: seedypod OS, the official Raspberry Pi OS Lite customised in a chroot by the installers themselves. [Installation](INSTALLATION.md) makes it the recommended path, and [Deployment](DEPLOYMENT.md) and [Maintenance](MAINTENANCE.md) cover it.
- **Update**: [ADR 0021](adr/0021-sd-card-wear-and-recovery.md) covers the Database view under **Settings → SD card**: what's writing to the card, table by table, from a read-only scan on a worker thread. [Maintenance](MAINTENANCE.md) and [Debugging](DEBUGGING.md) point to it.
- **Update**: [Installation](INSTALLATION.md) covers the SSH login logo, how to turn it off and how to remove it.

## 2026-11-05

- **Creation**: [ADR 0025](adr/0025-accessory-sensor-nodes.md), accessory sensor nodes (proposed): a sensors-only `hald` outside the unit, merged into its parent by core. First use is an external pH probe.
- **Update**: ADR 0025 covers buses: an accessory can use USB as well as I²C, and doesn't have to be a Pi.

## 2026-11-02

- **Creation**: [ADR 0024](adr/0024-pod-planner.md), the pod planner: a Gardyn-sourced plant catalog, zone-aware layout, staggered sowing and saved plans.

## 2026-11-01

- **Update**: [ADR 0017](adr/0017-ios-client.md): core now advertises `_seedypod._tcp` over Bonjour; [Installation](INSTALLATION.md) covers the TXT keys and `SEEDYPOD_MDNS=0`.
- **Creation**: [ADR 0023](adr/0023-homekit.md), HomeKit: the accessory mapping, the per-unit identity (porting sleepypod ADR 0020), the ciao advertiser and HomeKit in backups. [Maintenance](MAINTENANCE.md) and [Privacy](PRIVACY.md) cover the backup and the local-only pairing.

## 2026-10-31

- **Update**: ADR 0021 phases 1–3 accepted and built: SD card wear settings and the flash-writes meter, off-card backups with `backup_stale`, and one-step restore with undo. [Maintenance](MAINTENANCE.md) has the new card-replacement steps; [Installation](INSTALLATION.md), [Debugging](DEBUGGING.md), [Privacy](PRIVACY.md) and the [simulated bring-up](hardware/sim-bringup.md) checklist cover the rest.
- **Creation**: [Handoff](HANDOFF.md) for the repository transfer.
- **Creation**: ADRs 0010–0016 for the Store, MCP/MHS, deployment and trust, the HA bridge, dosing safety, the event bus and the shared design language. Added Home Assistant Lovelace and automation examples.
- **Update**: Documented CI secrets and variables in [Deployment](DEPLOYMENT.md).
- **Creation**: Converted `docs/` to an OKF v0.2 bundle: frontmatter on every ADR and guide, bundle index and this log. Added the [WebSocket amendment](adr/0005-trpc.md) to ADR 0005.
- **Creation**: ADRs 0001–0007 and 0009, the hardware pin map, installation/deployment/debugging/privacy guides, testing overview and the implementation plan.
