# AegisRAG — Architectural Decisions Log

This document records the rationale behind core design and architecture decisions made across the project timeline.

---

### Day 1 (Aug 17, 2026) — Project Grounding & Target Strategy

- **Target Domain Strategy**: Selected a developer changelog/release feed as the primary real-world target. Changelog pages frequently update markup and layout structure between releases without API stability guarantees, perfectly exercising the Sentinel's baseline drift detection.
- **Shift-Target Isolation**: Scaffolded a lightweight, semantic HTML test fixture (`shift-target`) strictly mirroring the target schema (`title`, `version_tag`, `release_date`, `summary`, `changelog_url`). This guarantees deterministic sabotage on camera without risking rate-limits or unpredictable changes on live third-party sites during judgment.
- **Command Injection Prevention**: Mandated `execFile`/`spawn` with argument arrays for all CLI wrappers (`bdata`, etc.) from Day 1 to guarantee scraped web strings or LLM generated text cannot break out into arbitrary shell execution.
- **Manual Heal Approval Gate**: Enforced human-in-the-loop validation for all scraper heal suggestions to ensure transparent inspectability before updating live extraction collectors.

---

### Day 2 (Aug 18, 2026) — Pipeline Plumbing, SQLite Persistence & Multi-Source Config

- **Embedded SQLite Storage (`better-sqlite3`)**: Selected SQLite via `better-sqlite3` with WAL mode for the raw runs persistence layer (`raw_runs`). This provides synchronous transactional guarantees, instant sub-millisecond local reads, zero external network dependency during ingestion, and simple file-based backups.
- **Strict Error Containment in Runner**: Designed `scraper-runner.ts` so that non-zero CLI exit codes, network drops, and JSON parsing failures are isolated and written to `raw_runs` with `status = 'FAILED'` and full stderr diagnostics. The ingestion service never crashes on external scraper failures.
- **Dynamic Multi-Source Schema via Zod**: Externalized all collector parameters into `config/sources.json` and validated them at runtime with `Zod`. Adding a new web target or tuning drift thresholds is a configuration change without modifying core execution logic.
- **Historical Baseline Window Seeding**: Populated `raw_runs` with a minimum 5-run historical baseline before implementing Day 3's Sentinel, ensuring rolling median drift calculations operate on verified multi-run data rather than an empty or single-run state.
