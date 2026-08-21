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

---

### Day 5 (Aug 21, 2026) — Structure-Preserving, Self-Cleaning Chunking & Hybrid Indexing

- **Parent-Child Section Hierarchy (`parent_id`, `heading_path`)**: Chunks retain explicit pointers to their parent document sections and heading paths. This enables the retrieval engine on Day 6 to expand top-matching fragments to full context windows without hallucinating disconnected sentences.
- **Pre-Embedding PII Redaction Boundary**: Filtered all raw web content for email addresses, phone numbers, and sensitive identifiers prior to generating embeddings or indexing into BM25.
- **Schema Invalidation & Stale Chunk Self-Cleaning**: Implemented strict schema versioning (`schema_version`). When a self-healing event or config update modifies a collector's schema, all chunks tagged with superseded versions (`< currentVersion`) are atomically deleted from both SQLite and BM25 before indexing new runs, permanently preventing stale and corrupted extractions from lingering in the knowledge base.
- **Sentinel Quality Ingestion Gate**: Guarded the indexing entry point so that only runs with `run_status = 'HEALTHY'` can be chunked or embedded. Corrupted, divergent, or soft-failure runs are rejected before reaching the index.

---

### Day 6 (Aug 22, 2026) — Hybrid Retrieval, Honest Citations, Dashboard & Security Hardening

- **Reciprocal Rank Fusion (RRF, $k=60$)**: Combined dense vector semantic similarity with Okapi BM25 keyword relevance in parallel. Equalizes differing scale distributions and improves precision across both keyword-exact and semantic intent queries.
- **Parent-Section Context Expansion**: Automatically expanded top fused child chunks to their enclosing parent document sections, giving the model complete contextual paragraphs while avoiding hallucinated fragments.
- **Prompt Injection Defense Boundary**: Sandboxed all retrieved web text inside `<RETRIEVED_CONTEXT>` blocks with explicit system instructions to treat content strictly as passive reference data.
- **Deterministic Citation Verification**: Enforced factual claim attribution by regex-verifying inline `[Source: <url> | Last Verified: <iso_date>]` markers. Uncited statements trigger a strict re-citation pass; out-of-domain queries trigger explicit insufficiency refusals rather than speculative hallucination.
- **Comprehensive Security Hardening**: Gated all mutating API endpoints (`/api/query`, `/api/trigger-run`, `/api/heal/approve`, `/api/heal/reject`) with `API_AUTH_SECRET` bearer token validation. Escaped and sanitized all rendered text across the dashboard (Chat, Health Console, Incident Replay) against XSS vulnerabilities.

---

### Day 7 & Hardening Audit (Aug 23, 2026) — Security Hardening, Concurrency Locking & Direct Node Invocation

- **Direct Node Execution Without Shell (`shell: false`)**: Replaced `npx.cmd` and `shell: isWindows` with direct `process.execPath` resolution targeting `@brightdata/cli/dist/index.js`. Guarantees `shell: false` across Windows, macOS, and Linux, eliminating `cmd.exe` argument-reinterpretation and shell injection vulnerabilities.
- **Real Published Dependency Pinning (`@brightdata/cli@0.3.5`)**: Corrected package version to the real published npm release `0.3.5`, guaranteeing zero-friction clean-checkout installation.
- **Collector Concurrency Mutex Locking**: Added an in-memory mutex set (`activeHealLocks`) keyed by `collector_id` in `initiateHeal()`. Blocks race conditions where overlapping triggers on the same collector could execute parallel heals before state transitions take effect.
- **Strict Startup Auth Secret Validation**: Eliminated all public hardcoded default token fallbacks. The server now immediately throws on startup (`getAuthSecret()`) if `API_AUTH_SECRET` is unset or empty, and setup scripts automatically generate secure random tokens.
- **Strict XML Framing in Gemma Diagnosis Prompts**: Wrapped all dynamic diagnostic fields (`<TARGET_URL>`, `<FAILED_FIELDS>`, `<DIAGNOSTIC_SUMMARY>`, `<EXPECTED_SCHEMA_FIELDS>`) in strict XML tags with explicit system directives enforcing passive reference data treatment.
