# AegisRAG — Automated Reliability & Self-Healing Benchmark

**Benchmark Execution Date**: August 2026  
**Runner Command**: `npm run benchmark` (`benchmarks/run-benchmarks.ts`)  
**Raw Results Artifact**: [`benchmarks/results.json`](../benchmarks/results.json)

---

## 1. Executive Summary

This benchmark measures AegisRAG's ability to detect, classify, heal, and verify realistic web scraping failure modes under automated conditions. Unlike spot-checks, this suite programmatically subjects the extraction pipeline to 6 distinct real-world structural, semantic, and anti-bot anomalies.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BENCHMARK KEY PERFORMANCE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  • Total Failure Scenarios Tested:        6                                 │
│  • Sentinel Anomaly Detection Rate:       100%                              │
│  • Self-Healing Recovery Success Rate:    100%                              │
│  • Golden-Row Gate Accuracy:              100%                              │
│  • Collector ID Invariant Preservation:   100% (c_msytsxke2c5eegz5we)       │
│  • Corrupted Downstream Ingestion:        0% (0 Corrupted Runs Indexed)     │
│  • Average Recovery Cycle Latency:        30ms                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Scenario Breakdown Matrix

| Scenario ID | Anomaly Name | Category | Sentinel Detection | Diagnostic Diff | Gemma AI Diagnosis | Golden Tolerance Gate | Collector ID Invariant | Downstream Ingestion | Latency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SCENARIO-01** | CSS Class Hierarchy Renamed | `dom_redesign` | ✅ `PASS` (`SCHEMA_CORRUPTED`) | Missing `product_page_url`, `trending_repositories` | ✅ Generated (227 chars) | ✅ `APPROVED` | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 131ms |
| **SCENARIO-02** | Card Container Nesting Shifted | `nesting_shift` | ✅ `PASS` (`SCHEMA_CORRUPTED`) | Nested wrapper div shifted key paths | ✅ Generated (227 chars) | ✅ `APPROVED` | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 13ms |
| **SCENARIO-03** | Critical Required Field Nullified | `null_expansion` | ✅ `PASS` (`SCHEMA_CORRUPTED`) | 100% null rate across expected fields | ✅ Generated (227 chars) | ✅ `APPROVED` | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 11ms |
| **SCENARIO-04** | Semantic Content Type Drift | `semantic_corruption`| ✅ `PASS` (`SCHEMA_CORRUPTED`) | Currency string placed in URL field | ✅ Generated (227 chars) | ✅ `APPROVED` | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 11ms |
| **SCENARIO-05** | Anti-Bot / Cloudflare Challenge Interception | `bot_challenge` | ✅ `PASS` (`SOFT_FAILURE`) | Token-overlap match on challenge keywords | 🛑 Bypassed (`BLOCKED`) | 🛑 Bypassed (`BLOCKED`) | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 1ms |
| **SCENARIO-06** | Flaky / Hallucinated AI Repair Attempt | `flaky_ai_repair` | ✅ `PASS` (`SCHEMA_CORRUPTED`) | Repaired star count spiked +83,232% vs baseline | ✅ Generated (227 chars) | ❌ `REJECTED` (Held DEGRADED) | ✅ `PASS` (Preserved) | ✅ `PASS` (Protected) | 10ms |

---

## 3. Load-Bearing Failure Mode Deep-Dive

### A. The "False-Heal" Trap (Scenario 06)
- **Problem**: When a scraper repair tool (`bdata scraper heal`) generates updated selectors, the new code often returns non-null strings that pass static TypeScript/Zod schemas, but extract semantically wrong values (e.g. star counts spiking from 120 to 99,999).
- **AegisRAG Defense**: The Golden-Row Verification Gate compares the newly extracted rows field-by-field against [`golden_rows`](../src/db/database.ts) using structural key matching (`url`/`slug`) and a 20% variance band. In Scenario 06, the discrepancy (+83,232% variance) triggered immediate rejection, holding the collector in `DEGRADED` and preventing vector DB pollution.

### B. Anti-Bot Challenge vs. Redesign (Scenario 05)
- **Problem**: Scrapers encountering Cloudflare challenges or 403 bot walls return HTML containing no expected data. Treating this as a DOM redesign wastes credits attempting to heal CSS selectors on challenge pages.
- **AegisRAG Defense**: The Sentinel's `softFailureRule` identifies challenge keywords and token overlaps, classifying the run as `BLOCKED`. It routes the error to proxy rotation and exponential retry backoff without consuming healing tokens.

---

## 4. How to Reproduce

Run the automated benchmark locally in any terminal:

```bash
npm run benchmark
```
