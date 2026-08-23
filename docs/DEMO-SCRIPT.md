# AegisRAG — 90-Second Hackathon Demo Script

**Target Time**: 1 minute 30 seconds (90 seconds)  
**Track**: WeMakeDevs — Into the Scrape-Verse (Bright Data)  
**Presenter**: Aditya Yawalkar  

---

## ⏱️ Visual & Spoken Timeline (One Continuous Take)

```
0:00 ─── 0:15 ─── 0:30 ─── 0:45 ─── 1:00 ─── 1:15 ─── 1:30 (seconds)
[ Problem ] [ Healthy ] [ Break ] [ Detect ] [ Heal ] [ Verify ] [ Q&A RAG ]
```

---

### **Beat 1: The Problem (0:00 – 0:12 | 12s)**
> **🎥 Screen**: Dark-mode **AegisRAG Dashboard** (`http://localhost:3001`).

**🎙️ Spoken:**
> *"Web scrapers don't always crash when websites change — they return believable, well-typed, wrong data. Downstream vector databases get poisoned, and LLMs hallucinate with confidence. AegisRAG is a self-healing pipeline that catches silent corruption, repairs the scraper using Bright Data, and proves the fix is correct before trusting it."*

---

### **Beat 2: Healthy Baseline State (0:12 – 0:25 | 13s)**
> **🎥 Screen**: Point to the **Pipeline Ribbon** showing:
> - Collector ID: `c_msytsxke2c5eegz5we` (🟢 `HEALTHY`)
> - Verified Rows: `4` | Sentinel Gate: `Active (5-Run Median)`

**🎙️ Spoken:**
> *"Here is our active Bright Data Scraper Studio collector `c_msytsxke2c5eegz5we`. In its baseline state, our Sentinel accuracy layer validates extraction against a 5-run median, and RAG answers questions with verified source timestamps."*

---

### **Beat 3: Visible Sabotage & Sentinel Drift Detection (0:25 – 0:42 | 17s)**
> **🎥 Screen**: Terminal running `npm run demo:break` (or `npm run demo`).

**🎙️ Spoken:**
> *"Now, we simulate a target website redesign where CSS class hierarchies shift. When the extraction runs, The Sentinel immediately detects 100% field drift, drops the Health Score, marks the collector `DEGRADED`, and pauses all downstream RAG ingestion."*

---

### **Beat 4: Local Gemma Diagnosis & Real `bdata heal` (0:42 – 1:05 | 23s)**
> **🎥 Screen**: Terminal / Health Console showing Gemma Diagnosis & Approval Envelope.

**🎙️ Spoken:**
> *"An on-device Gemma AI model analyzes the failure diff and synthesizes a concise 200-character repair diagnosis. AegisRAG invokes Bright Data's `bdata scraper heal` CLI in preview mode without shell interpolation. As the operator, I review the candidate extraction and approve the heal."*

---

### **Beat 5: Golden-Row Verification & Collector ID Preservation (1:05 – 1:20 | 15s)**
> **🎥 Screen**: Show Golden Verification PASS output & Invariant check in terminal.

**🎙️ Spoken:**
> *"Post-heal, AegisRAG runs Golden-Row Verification, matching rows by structural URL key against baseline tolerance bands. The repair passes, the collector recovers, and notice: the **SAME Collector ID `c_msytsxke2c5eegz5we` is preserved** with zero downstream configuration rewrites."*

---

### **Beat 6: Downstream Verifiable RAG Recovery (1:20 – 1:30 | 10s)**
> **🎥 Screen**: Switch to **Chat Tab**, show recovered answer with verified inline timestamp citation.

**🎙️ Spoken:**
> *"Stale schema chunks are purged, and the RAG assistant immediately answers with verified inline timestamp citations. If an unanswerable question is asked, the refusal gate triggers instantly. That is AegisRAG: verifiable data reliability from scraper to prompt."*

---

## 🚀 Execution Command Summary for Demo:

```bash
# 1. Start Server & UI
npm run server

# 2. Run the deterministic 90-second walkthrough in terminal
npm run demo
```
