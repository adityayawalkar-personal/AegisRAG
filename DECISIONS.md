# AegisRAG — Architectural Decisions Log

This document records the rationale behind core design and architecture decisions made across the project timeline.

---

### Day 1 (Aug 17, 2026) — Project Grounding & Target Strategy

- **Target Domain Strategy**: Selected a developer changelog/release feed as the primary real-world target. Changelog pages frequently update markup and layout structure between releases without API stability guarantees, perfectly exercising the Sentinel's baseline drift detection.
- **Shift-Target Isolation**: Scaffolded a lightweight, semantic HTML test fixture (`shift-target`) strictly mirroring the target schema (`title`, `version_tag`, `release_date`, `summary`, `changelog_url`). This guarantees deterministic sabotage on camera without risking rate-limits or unpredictable changes on live third-party sites during judgment.
- **Command Injection Prevention**: Mandated `execFile`/`spawn` with argument arrays for all CLI wrappers (`bdata`, etc.) from Day 1 to guarantee scraped web strings or LLM generated text cannot break out into arbitrary shell execution.
- **Manual Heal Approval Gate**: Enforced human-in-the-loop validation for all scraper heal suggestions to ensure transparent inspectability before updating live extraction collectors.
