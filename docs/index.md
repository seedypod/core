---
okf_version: "0.2"
---

# leafypod docs

Developer and operator documentation, authored as an OKF v0.2 bundle (same
profile as `knowledge/`). Concepts carry frontmatter with `status`,
`generated` and `sources`; `index.md` files are plain tables of contents.

- [Architecture decision records](adr/index.md) — Why things are the way they are.
- [Implementation plan](implementation-plan.md) — Phase 0 → 1.0 with parallelism markers.
- [Installation](INSTALLATION.md) · [Deployment](DEPLOYMENT.md) · [Debugging](DEBUGGING.md) · [Privacy](PRIVACY.md)
- [Hardware](hardware/index.md) — Pin map and verification checklist.
- [Testing](testing/index.md) — What runs where.

Facts and evidence (hardware measurements, horticulture targets, calibration) live
in the sibling bundle `knowledge/` (its own OKF bundle at the repository root).

[Update history](log.md)
