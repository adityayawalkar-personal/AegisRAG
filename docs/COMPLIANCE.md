# AegisRAG — Target Selection & Public Data Compliance Statement

**Hackathon Track**: WeMakeDevs — Into the Scrape-Verse (Bright Data)  
**Author**: Aditya Yawalkar  
**Date**: August 2026  

---

## 1. Primary Extraction Targets

AegisRAG is architected with a **Target-Agnostic Source Configuration Layer** ([`config/sources.json`](../config/sources.json)) capable of driving any long-tail web endpoint. For hackathon demonstration and repeatable evaluation, two primary targets are configured:

1. **Live Production Target**: `https://github.com/trending`
   - **Target Domain**: `github.com`
   - **Bright Data Scraper Studio Collector ID**: `c_msytsxke2c5eegz5we`
   - **Extraction Scope**: Public repository feeds, project names, developer handles, repository descriptions, star counts, and language metadata.

2. **Controlled Sabotage Fixture Target**: `http://localhost:3000` ([`shift-target/`](../shift-target/))
   - **Target Domain**: Local standalone HTTP mock server
   - **Purpose**: Simulates deterministic, reproducible DOM markup mutations (CSS class renames, card nesting shifts, field displacement) to exercise the live Sentinel detection $\rightarrow$ Gemma diagnosis $\rightarrow$ `bdata scraper heal` cycle on camera without network non-determinism.

---

## 2. Public Data & Privacy Justification

In compliance with official Bright Data Scraper-Verse guidelines:

- ✅ **100% Publicly Available Data**: All extracted target pages are publicly accessible without authentication, session cookies, paywalls, or rate-gated logins.
- ✅ **Zero Personal / Private Information**: Extracted fields are strictly limited to public open-source project names, software descriptions, public URLs, and repository aggregate star counters. No private user profiles, emails, phone numbers, or confidential telemetry are scraped.
- ✅ **Pre-Embedding PII Sanitization**: As an added safety boundary, [`src/indexing/pii-filter.ts`](../src/indexing/pii-filter.ts) sanitizes any incidental email addresses, phone numbers, or identification patterns prior to vector/BM25 embedding.
- ✅ **Passive Reference Sandboxing**: Scraped content is treated strictly as passive data inside `<RETRIEVED_CONTEXT>` prompt boundaries ([`src/retrieval/rag-service.ts`](../src/retrieval/rag-service.ts)), preventing prompt injection attacks.

---

## 3. Pre-Built Scraper Library Check

Bright Data maintains a vast library of 800+ pre-built scrapers for major global e-commerce and social platforms.

- **Check Result**: While Bright Data offers broad platform scrapers (e.g., standard GitHub profile scrapers), dynamically shifting trending feeds and long-tail public research/developer feeds require custom Scraper Studio collectors with tailored CSS/XPath selectors and schema definitions.
- **Custom Collector**: Collector `c_msytsxke2c5eegz5we` was created and trained specifically inside **Bright Data Scraper Studio** to extract structured trending arrays matching [`config/sources.json`](../config/sources.json).
- **Target Agility**: Because the pipeline is decoupled through [`src/config/sources.ts`](../src/config/sources.ts), changing targets to public conference call-for-papers, grant funding directories, or university announcements requires only adding an entry in `config/sources.json` with zero code modifications to the Sentinel or RAG layers.

---

## 4. Reproducibility & Audit Trail

The entire self-healing extraction loop can be reproduced in 3 ways:
1. **Live Autonomous Demo**: `npm run demo`
2. **Automated Reliability Benchmark**: `npm run benchmark`
3. **End-to-End Test Suite**: `npm test`
