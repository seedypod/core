---
type: "Research note"
title: "Open Knowledge Format"
description: "Pinned upstream format and local authoring rules."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:10:00+00:00"}
sources: [{"resource": "https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md", "title": "Official OKF specification v0.2"}, {"resource": "https://github.com/sleepypod/training/blob/main/knowledge/references/okf.md", "title": "sleepypod/training OKF note (same pin, same local rules)"}]
---

# Open Knowledge Format

This bundle uses OKF v0.2, pinned to revision `ad30107c31c06aec8a7d5636e0d1058118604e6f` — the same pin as `sleepypod/training`; upgrades require a deliberate review in both repos.

Concepts use YAML frontmatter and ordinary Markdown links. `index.md` and `log.md` are reserved. `generated` records authorship, not correctness; a `verified` attestation is added only after a human has checked the concept against hardware or a primary source. `scripts/validate_knowledge.py` enforces the local profile (frontmatter, status, actors, sources, links); it does not verify claims.
