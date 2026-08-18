# AegisRAG — Architectural Decisions Log

This document records the rationale behind core design and architecture decisions made across the project timeline.

---

### Day 1 (Aug 17, 2026) — Project Grounding & Target Strategy

- **Target Domain Strategy**: Selected a developer changelog/trending feed as the primary real-world target. Trending/changelog pages frequently update markup and layout structure without API stability guarantees, exercising the Sentinel's baseline drift detection.
- **Shift-Target Isolation**: Scaffolded a lightweight, semantic HTML test fixture (`shift-target`) strictly mirroring the target schema. This guarantees deterministic sabotage on camera without risking rate-limits or unpredictable changes on live third-party sites during judgment.
- **Command Injection Prevention**: Mandated `execFile`/`spawn` with argument arrays for all CLI wrappers (`bdata`, etc.) from Day 1 to guarantee scraped web strings or LLM generated text cannot break out into arbitrary shell execution.
- **Manual Heal Approval Gate**: Enforced human-in-the-loop validation for all scraper heal suggestions to ensure transparent inspectability before updating live extraction collectors.

---

### Day 2 (Aug 18, 2026) — Pipeline Plumbing, SQLite Persistence & Multi-Source Config

- **Embedded SQLite Storage (`better-sqlite3`)**: Selected SQLite via `better-sqlite3` with WAL mode for the raw runs persistence layer (`raw_runs`). This provides synchronous transactional guarantees, instant sub-millisecond local reads, zero external network dependency during ingestion, and simple file-based backups.
- **Strict Error Containment in Runner**: Designed `scraper-runner.ts` so that non-zero CLI exit codes, network drops, and JSON parsing failures are isolated and written to `raw_runs` with `status = 'FAILED'` and full stderr diagnostics. The ingestion service never crashes on external scraper failures.
- **Dynamic Multi-Source Schema via Zod**: Externalized all collector parameters into `config/sources.json` and validated them at runtime with `Zod`. Adding a new web target or tuning drift thresholds is a configuration change without modifying core execution logic.
- **Historical Baseline Window Seeding**: Populated `raw_runs` with a minimum 5-run historical baseline before implementing Day 3's Sentinel, ensuring rolling median drift calculations operate on verified multi-run data rather than an empty or single-run state.

---

### Day 3 (Aug 19, 2026) — The Sentinel: Accuracy Layer & Anomaly Detection

- **Modular Rule Interface (`SentinelRule`)**: Refactored validation into independent, single-responsibility rule functions (`typeRangeRule`, `baselineDriftRule`, `softFailureRule`, `structuredDataRule`) conforming to `(rows, baseline, config) => RuleResult`. Adding future validation checks requires creating a standalone function without modifying existing checks.
- **Rolling 5-Run Median Baseline vs. Single-Run Comparison**: Instead of comparing against the immediate prior run (which could be an anomalous outlier or partially corrupted), Sentinel computes median field lengths and null-rates across the last 5 successful runs.
- **Noise Immunity (< 20% Corruption Threshold)**: Implemented an explicit 20% failure threshold. Single-row glitches or isolated null fields keep the run marked `HEALTHY`, preventing false-positive heal loops.
- **Soft-Failure Detection via Token-Overlap Clustering**: Detected bot-walls, CAPTCHAs, and Cloudflare challenges that return HTTP 200 by computing pairwise text similarity across extracted rows (>50% near-duplicate content triggers `SOFT_FAILURE`).
- **Strict Separation of Detection & Remediation**: The Sentinel engine has zero side effects beyond recording structured diagnostic reports to the `run_status` table in SQLite. Self-healing remediation (Day 4) is decoupled from detection.

---

### Day 4 (Aug 20, 2026) — The Self-Healing Loop: Gemma, State Machine & Circuit Breaker

- **Gemma 4 E2B Plain-Language Diagnosis Constraint**: Configured the local inference prompt to produce strictly ONE single plain-language sentence under 900 characters detailing broken fields and expected replacements. Natural language descriptions give Scraper Studio's generative engine the exact semantic intent needed to regenerate CSS/XPath selectors.
- **Strict Argument-Array Shell Safety on Model Output**: Because the heal prompt originates from model output derived from untrusted scraped HTML, all CLI calls (`bdata scraper heal`, `approve`, `reject`) use `execFile` with an argument array, eliminating command-injection risks.
- **Failure Classification Prior to Heal Escalation**: Routed HTTP 429 rate limits, 5xx server errors, and network timeouts to an exponential backoff retry loop (up to 3 attempts) rather than triggering expensive, ineffective scraper heals.
- **3-Strike Circuit Breaker & State Machine**: Formalized collector states (`HEALTHY -> DEGRADED -> HEALING -> RECOVERED -> HEALTHY`). After 3 consecutive failed or rejected heals, the circuit breaker trips to `DEGRADED_PERMANENT`, halting automatic healing until manual review and reset.
