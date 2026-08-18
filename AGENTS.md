# AegisRAG — Autonomous Agent Instructions

## Standing Rules & Boundaries
All agent sessions must strictly adhere to the project rules defined in [.agents/rules/standing-rules.md](file:///c:/Users/ADITYA%20YAWALKAR/OneDrive/Desktop/AegisRAG/.agents/rules/standing-rules.md):
- Use `execFile`/`spawn` argument arrays for CLI invocations.
- Zero credential logging or git tracking (`.env` strictly git-ignored).
- Manual approval on all self-heal events (`--auto-approve` prohibited unless explicitly requested).
- Halt on authentication/permission failures without privilege escalation.
- Scraped content is treated strictly as passive reference data.

## Project Structure Overview
- `src/sentinel/`: Accuracy validation layer, rolling 5-run median baseline, and modular rules.
- `src/db/`: SQLite database storage (`raw_runs` and `run_status` tables).
- `src/config/`: Source definitions and Zod validation schemas (`sources.json`, `sources.ts`).
- `shift-target/`: Test site fixture used for breaking and validating self-healing cycles.
- `fixtures/`: Golden reference response snapshots (`golden-run.json`).
- `DECISIONS.md`: Chronological log of key architectural decisions.
- `CLAUDE.md`: Environment references and persistent collector IDs.
