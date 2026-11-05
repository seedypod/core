# Docs update log

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
