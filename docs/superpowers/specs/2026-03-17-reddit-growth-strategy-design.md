# RocketRide Reddit Growth Strategy & Software Redesign

**Date:** 2026-03-17
**Status:** Draft
**Goal:** 70 -> 5,000+ GitHub stars in 12 weeks via Reddit-driven growth

---

## 1. Executive Summary

Based on 14 parallel Reddit research tasks across r/LocalLLaMA (653K), r/selfhosted, r/DataEngineering, r/MachineLearning, r/ClaudeAI, r/cursor, and r/LLMDevs, plus deep codebase investigation of the C++ engine:

**RocketRide has a real product with verified technical advantages (C++ GIL release, 12+ LLM provider APIs, 55+ pipeline nodes, MCP integration) but zero market awareness.** The competitive landscape shows a massive gap for a high-performance, IDE-native pipeline engine with MCP-first architecture.

The strategy has two tracks:
1. **Software improvements** (make the product Reddit-ready)
2. **Community engagement** (get the product in front of the right people)

---

## 2. Competitive Positioning

### 2.1 Market Map (March 2026)

| Tool | Stars | Trend | RocketRide Differentiator |
|------|-------|-------|--------------------------|
| n8n | ~180K | Rising | AI bolted onto automation tool; we're AI-native with C++ engine |
| Dify | ~133K | Peaking | Browser-based; we're IDE-native (VS Code). They're Python; we have C++ core |
| LangChain | ~130K | Declining | "Abstraction Soup" fatigue; we're leaner with visual debugging |
| ComfyUI | ~106K | Stable | Image/video focused; we're data/document pipeline focused |
| Ollama | ~95K | Stable | Inference only; we're full pipeline orchestration |
| LangGraph | ~27K | Rising fast | Code-first state machines; we add visual canvas + C++ performance |
| CrewAI | ~45K | Rising | Demo-ware criticism; we have production-grade C++ engine |

### 2.2 Positioning Statement

> "RocketRide is the C++ pipeline engine for heavy AI workloads -- 55+ nodes, GIL-free data operations, exposed as MCP tools for your favorite AI editor."

### 2.3 Messaging Rules

**DO say:**
- "Releases Python GIL during C++ data operations"
- "Run DeepSeek R1 locally via Ollama integration"
- "Expose any pipeline as a Cursor/Claude MCP tool"
- "Code-first, visual-second -- the canvas is a debugger, not a drag-and-drop toy"

**DO NOT say:**
- "GIL-free Python execution" (misleading -- Python nodes are still single-threaded)
- "Zero-copy" or "Apache Arrow" (not implemented yet -- Python dict -> C++ json::Value conversion)
- "AI coding assistant" (competes with Cursor/Claude Code -- losing battle)
- "No-code" (toxic for r/LocalLLaMA audience)
- "Knowledge base" / "code indexing" (competes with Cursor -- vetoed by lead engineer)
- "Dynamic batching" (model server not in this repo)
- "Leaner than LangChain" without qualifier (Ollama/DeepSeek nodes use `langchain_openai.ChatOpenAI` internally for OpenAI-compatible API routing; the C++ advantage is in data processing, not LLM call layer)

---

## 3. Software Redesign -- Tiered by Impact

### 3.1 TIER 1: "30-Second Magic" (Weeks 1-2) -- MUST HAVE FOR LAUNCH

**Rationale:** "In AI, the README is the product." Ollama got 95K stars because of one-command install. AutoGPT was abandoned due to setup friction. DX is the #1 factor.

#### 3.1.1 One-Command Demo Experience

**What:** A single `docker-compose up` that:
1. Pulls RocketRide engine + Ollama + Qdrant (vector DB)
2. Auto-downloads a small general-purpose model (llama3.2:3b -- NOT a code model)
3. Starts a pre-built demo pipeline: PDF folder -> OCR -> embeddings -> vector store -> chat
4. Opens a web UI showing the pipeline running with real results

**Implementation:**
- New file: `docker/demo/docker-compose.yml`
- Pre-built `.pipe` file with the demo pipeline
- Health check that waits for all services before starting the pipeline
- README snippet: "Try it in 30 seconds" at the TOP of README

**Success criteria:** User runs one command, sees results in <60 seconds, zero API keys needed.

#### 3.1.2 Density Benchmark Script

**What:** Reproducible benchmark comparing RocketRide's document processing throughput vs pure Python (LangChain + PyPDF + ChromaDB).

**Metrics to measure:**
- Documents processed per second (same pipeline: PDF -> OCR -> embeddings -> vector store)
- Peak memory usage (RSS)
- CPU utilization percentage
- Time to first result (latency)

**Hardware targets:**
- RTX 3090 (24GB) -- the r/LocalLLaMA gold standard
- Mac M2/M3 with 32GB+ unified memory
- CPU-only (no GPU) baseline

**Implementation:**
- REWRITE `test/density_benchmark.py` from scratch (existing script is a synthetic memory allocation test, NOT a real pipeline benchmark -- would be instantly exposed as misleading on Reddit)
- Must run REAL end-to-end pipelines: actual PDF processing, actual embedding generation, actual vector store writes
- Compare RocketRide pipeline vs equivalent LangChain + PyPDF + ChromaDB pipeline on identical documents
- Output: markdown table + CSV for charts
- Include hardware specs in output (auto-detected)

**HARD GATE:** Do NOT proceed to Week 5 launch unless benchmark shows >2x improvement on at least one metric with real workloads. If numbers are not impressive, delay launch and investigate.

**Post format:** "[Benchmark] RocketRide C++17 engine: X docs/sec on RTX 3090 vs Python alternatives"

#### 3.1.3 README Overhaul

**Changes:**
1. Move one-liner Docker install to line 1 (above the logo)
2. Add "Why RocketRide?" section with 3 bullets:
   - C++ core engine (releases GIL during data operations)
   - 66 pipeline nodes (12+ LLM provider APIs, 8 vector DBs, OCR, NER, PII)
   - MCP-native (expose any pipeline as a Cursor/Claude tool)
3. Add honest comparison table: RocketRide vs n8n vs Dify vs LangChain
4. Add "Try it in 30 seconds" section with docker-compose snippet
5. Remove all "coming soon" references
6. Add GIF showing VS Code pipeline debugging

#### 3.1.4 Pre-Built Pipeline Templates (3 minimum)

| Template | Pipeline | Target Subreddit |
|----------|----------|-----------------|
| "Total Recall" | Folder Watch -> Vision OCR -> PII Scrub -> Auto-Tag -> Vector DB -> Chat | r/selfhosted |
| "Invoice Processor" | PDF -> Structured JSON extraction (vendor, total, date) -> CSV export | r/DataEngineering |
| "RAG on Your Docs" | Folder -> Embeddings -> Qdrant -> Chat interface | r/LocalLLaMA |

**Implementation:** Pre-built `.pipe` files in `templates/` directory, each with a README and docker-compose.

---

### 3.2 TIER 2: "Killer Features" (Weeks 3-6) -- HIGH REDDIT IMPACT

#### 3.2.1 PDF Intelligence MCP Server (THE killer feature)

**Rationale:** Reddit research confirmed a "gaping hole" for high-performance document processing via MCP. Current solutions take 10-20 min for 100 pages. No professional MCP server exists for this.

**What:** A single MCP server that exposes RocketRide's OCR + NER + embeddings pipeline as tools for Cursor/Claude Code.

**MCP Tools exposed:**
- `parse_pdf(file_path) -> structured_markdown` -- OCR + layout preservation
- `extract_entities(file_path) -> {people, orgs, dates, amounts}` -- NER
- `index_folder(folder_path) -> status` -- batch indexing with progress
- `query(question, folder?) -> answer_with_citations` -- RAG query

**Implementation:**
- Wrap existing `client-mcp` package with pre-built document pipeline
- One-line Cursor config: `"rocketride": {"command": "rocketride-mcp", "args": ["--pipeline", "pdf-intelligence"]}`
- C++ engine handles the heavy lifting; Python just routes MCP requests

**Marketing post:** "Made my Cursor parse 10K PDFs using RocketRide as an MCP tool -- here's the 3-line config"

#### 3.2.2 Reasoning Stream Splitter Node

**Rationale:** Chain-of-thought orchestration is trending. DeepSeek R1 and Llama 4 emit `<thought>` tags. Reddit wants visual guardrails on LLM reasoning.

**What:** New pipeline node that splits LLM output into ThoughtStream and ResponseStream.

**Implementation:**
- New node: `nodes/src/nodes/reasoning_splitter/`
- Parses `<thought>...</thought>` and `<answer>...</answer>` tags
- Emits two output lanes: one for reasoning, one for response
- Allows visual pipeline to branch/kill based on reasoning content
- Works with DeepSeek R1, Llama 4, any model with CoT tags

**Marketing post:** "Visual guardrails on LLM reasoning -- kill hallucinations before they reach the user"

#### 3.2.3 Visual MCP Tool Creator

**Rationale:** Reddit wants "Turn any Python script into an AI tool in 10 seconds." MCP is hot but setup is painful.

**What:** Right-click any pipeline in VS Code -> "Export as MCP Tool" -> generates MCP server manifest automatically.

**Implementation:**
- VS Code extension command: `rocketride.exportAsMCP`
- Reads pipeline `.pipe` file, generates MCP server config
- Auto-creates `mcp-server.json` with tool definitions matching pipeline inputs/outputs
- Clipboard copy for Cursor/Claude config

#### 3.2.4 Pipeline Template Gallery

**What:** In-VS-Code browsable gallery of community-contributed pipeline templates.

**Implementation:**
- `templates/` directory in repo with categorized `.pipe` files
- VS Code sidebar panel: "Template Gallery" with search/filter
- One-click "Use Template" that copies to workspace
- Community contribution via PR (like shadcn/ui registry model)

---

### 3.3 TIER 3: "Technical Moat" (Weeks 6-12) -- LONG-TERM DIFFERENTIATION

#### 3.3.1 Apache Arrow IPC (Zero-Copy Python <-> C++)

**Rationale:** Currently Python dict -> C++ json::Value is a conversion, not zero-copy. Apache Arrow shared memory would eliminate serialization overhead entirely. This is the most requested performance feature on Reddit.

**What:** Replace JSON conversion at the Python/C++ boundary with Apache Arrow IPC.

**Impact:** Would make benchmark numbers dramatically better. Post: "We eliminated 90% of serialization overhead with Apache Arrow shared memory."

**Risk:** Major architectural change to the engine. Needs careful planning with lead engineer.

#### 3.3.2 PII Anonymization Pipeline

**Rationale:** r/selfhosted's #1 differentiator from cloud tools. "Local-only PII scrubbing" before data hits vector DB.

**What:** Pre-indexing pipeline step using existing NER node + new PII detection patterns (SSN, phone, email, address).

**Implementation:**
- Extend existing NER node with PII-specific entity types
- Add configurable redaction modes: mask, replace, remove
- Pre-built template: "Privacy-Safe RAG" pipeline

#### 3.3.3 Workflow "Time Travel" Debugger

**Rationale:** Senior engineers love Git mental model. "If agent hallucinates at step 7, rewind to step 6, swap model, resume."

**What:** State snapshots at each pipeline step. Visual UI to branch/rewind execution.

**Implementation:**
- Snapshot pipeline state (all lane data) at each node boundary
- VS Code timeline view showing execution history
- "Rewind to Step N" command
- "Branch from Step N" to try different model/parameters

#### 3.3.4 Dynamic Tool Discovery for MCP

**Rationale:** Context window bloat from pre-loaded MCP tools is the #1 complaint. Lazy-loading tool definitions would be heroic.

**What:** Instead of injecting all tool definitions upfront, expose a "skill catalog" and only inject full tool schema when the LLM expresses intent to use it.

---

## 4. Reddit Engagement Strategy

### 4.1 Pre-Launch Community Building (Weeks 1-4)

**Accounts:**
- Use PERSONAL accounts (not brand accounts) -- founder visibility builds 10x more trust
- Both accounts need 50+ karma before any self-promo posts
- Put RocketRide link in Reddit bio from day 1 (organic profile discovery > cold link drops)
- Start commenting helpfully NOW -- no direct product POSTS for 3 weeks (profile link is fine)
- 3-5 helpful comments per day across target subreddits
- Accounts must be COMPLETELY INDEPENDENT -- never upvote each other, never comment on each other's posts
- Always disclose: "Full disclosure: I'm a dev on RocketRide" when relevant in comments

**F5Bot alerts (set up immediately):**
- "pipeline engine", "MCP tools", "Python GIL", "document processing local"
- "C++ inference", "LangChain alternative", "PDF OCR local"
- "visual pipeline", "self-hosted AI workflow"

**Target subreddits:**

| Priority | Subreddit | Topics to Help With |
|----------|-----------|-------------------|
| 1 | r/LocalLLaMA (653K) | GIL issues, performance, MCP setup, document processing |
| 2 | r/selfhosted | Docker AI setups, Ollama config, PDF processing |
| 3 | r/DataEngineering | Pipeline architecture, Airflow/Dagster complaints |
| 4 | r/ClaudeAI + r/cursor | MCP configurations, tool setup |
| 5 | r/opensource | MIT license projects, C++ engineering |

### 4.2 Launch Sequence (Weeks 4-6)

#### Week 4 -- Soft Launch (low-risk, self-promo allowed)

| Day | Subreddit | Post |
|-----|-----------|------|
| Mon | r/SideProject | "Building a C++ pipeline engine -- what I learned about beating the Python GIL" |
| Wed | r/opensource | "RocketRide: 66-node AI pipeline engine with C++ core [MIT License]" |
| Fri | r/coolgithubprojects | Direct repo link with feature summary |

#### Week 5 -- Main Launch (high-impact)

**SUBREDDIT RULES (verified March 2026):**
- r/LocalLLaMA: OSS self-promo allowed; use "Show and Tell" flair; must include t/s, TTFT, VRAM, hardware specs
- r/selfhosted: "New Project Friday" rule -- projects <3 months MUST post on Friday only; 9:1 ratio enforced
- r/MachineLearning: Self-promo FORBIDDEN in main feed -- must use Monthly Self-Promotion Thread with [P] tag
- All posts: Frame as "feedback request" not "launch announcement"

| Day | Target | Post Format |
|-----|--------|-------------|
| Tue 10AM ET | r/LocalLLaMA | "Python's GIL was killing my pipeline throughput, so I rebuilt it in C++. Here are the benchmarks. Would love feedback." (flair: Show and Tell) -- verified peak: Tue 10-11AM ET |
| Fri | r/selfhosted | "Built a self-hosted AI pipeline engine with Docker one-liner -- would love feedback on the setup experience" (New Project Friday) |
| 1st of month | r/MachineLearning | Post in Monthly Self-Promotion Thread with [P] tag -- academic framing, link to benchmark repo |
| Following Mon 8AM EST | Hacker News | "Show HN: RocketRide -- C++ pipeline engine for AI workloads" (4+ day buffer after Reddit to fix issues) |

#### Week 6 -- Follow-up Wave

| Target | Post |
|--------|------|
| r/LocalLLaMA | MCP demo: "Made my Cursor parse 10K PDFs via RocketRide MCP tool" |
| r/DataEngineering | "When you outgrow LangChain: C++ pipeline orchestration with Python extensibility" |
| r/cursor + r/ClaudeAI | MCP integration tutorial |

### 4.3 r/LocalLLaMA Launch Post Template

```
Title: Python's GIL was killing my inference pipeline, so I rebuilt the data layer in C++. Here are the benchmarks.

Hey r/LocalLLaMA,

Full disclosure: I'm a dev on this project.

I've been in this community for weeks and kept seeing the same frustration
I was having: Python overhead killing pipeline throughput, the GIL bottleneck,
JSON serialization eating the latency budget.

So we built a C++ pipeline engine that releases the Python GIL
during data operations. 55+ nodes (OCR, NER, embeddings,
12+ LLM APIs including Ollama + DeepSeek R1, 8 vector DBs).

## Benchmark: Document Processing Pipeline

| Metric | RocketRide (C++) | Python Equivalent |
|--------|-----------------|-------------------|
| Docs/sec (RTX 3090) | X | Y |
| Memory usage | X GB | Y GB |
| CPU utilization | X% | Y% |
| Time to first result | Xs | Ys |

Hardware: [exact specs]

## How it works
- C++ core engine with pybind11 GIL release (40+ release points in data callbacks)
- Python nodes for extensibility (data stays in C++ during processing)
- GIL released for all I/O, inference, and data transfer operations
- 12+ LLM APIs: OpenAI, Anthropic, Ollama (DeepSeek R1), Gemini, Bedrock, etc.

## MCP Integration
Expose any pipeline as an MCP tool for Cursor/Claude Code:
[3-line config snippet]

## Try it in 30 seconds
docker-compose -f docker/demo/docker-compose.yml up

Or VS Code extension: search "RocketRide"

MIT License: [link]

Would love feedback from this community:
- Is the GIL bypass approach actually useful for your local LLM setups?
- What pipelines would you want to see as pre-built templates?
- Any benchmarks you'd like us to run that we're missing?

Happy to answer architecture questions -- I'll be in the comments all day.
```

**CRITICAL LAUNCH RULES:**
- "War Room" for first 4 hours -- reply to EVERY technical comment within 15 minutes
- Acknowledge where Python is better (ecosystem, iteration speed) to build trust
- Have canned answers ready for: "Why not Rust?", "What about Python 3.13 free-threaded?", "How is this different from n8n/Dify?"
- NEVER be defensive about limitations -- honesty wins on Reddit
- If someone finds a bug live, acknowledge immediately and file an issue publicly

### 4.4 Prepared Responses for Predictable Questions

| Question | Response |
|----------|----------|
| "Why not Rust?" | "Great question. Our C++ engine predates the Rust-for-ML wave and we have 100K+ lines of battle-tested C++17. Rust rewrite would be a multi-year effort with no user-facing benefit. We chose pybind11 for Python interop which is mature and well-documented." |
| "What about Python 3.13 free-threaded?" | "Exciting development. Our GIL release is specifically for the C++ data plane -- even with free-threaded Python, the C++ engine handles memory management and data transfer more efficiently. We're watching PEP 703 closely." |
| "How is this different from n8n?" | "n8n is an automation tool with AI bolted on (400+ integrations, great for Zapier-like workflows). We're AI-native with a C++ core optimized for heavy data processing -- OCR, NER, embeddings at scale. Different tools for different jobs." |
| "How is this different from Dify?" | "Dify is browser-based with a polished cloud UX. We're IDE-native (VS Code) with a C++ engine for local-first, privacy-focused workloads. Dify for cloud teams, RocketRide for engineers who want VS Code + Docker." |
| "Your Ollama node uses LangChain internally?" | "Yes, we use langchain_openai.ChatOpenAI for OpenAI-compatible API routing to Ollama -- it's a thin HTTP client, not the full LangChain framework. The C++ advantage is in the data processing pipeline (GIL release, shared memory), not the LLM call layer." |
| "Who is Aparavi?" | "Aparavi Software AG is the company behind RocketRide. The engine started as an internal data processing tool and we open-sourced it under MIT license." |

### 4.5 Sustained Engagement (Ongoing after launch)

**Weekly cadence:**
- 2-3 helpful comments per day (most with no product mention)
- 1 content post per week rotating:

| Week | Topic | Subreddit |
|------|-------|-----------|
| 1 | "Processing 10K legal PDFs locally with OCR + NER + vector search" | r/selfhosted |
| 2 | "Building a multi-agent RAG pipeline with visual debugging" | r/LocalLLaMA |
| 3 | "MCP + RocketRide: give your AI editor document superpowers" | r/ClaudeAI |
| 4 | "Density benchmark update: concurrent users per GPU" | r/LocalLLaMA |
| 5 | "Template gallery: 10 ready-to-use AI pipelines" | r/opensource |
| 6 | "PII anonymization pipeline: scrub sensitive data before RAG indexing" | r/selfhosted |
| 7 | "Reasoning stream splitter: visual guardrails on DeepSeek R1 CoT" | r/LocalLLaMA |
| 8 | "Invoice processor: PDF to structured JSON in one pipeline" | r/DataEngineering |

---

## 5. Technical Verification Summary

Claims verified against actual codebase:

| Claim | Status | Evidence |
|-------|--------|----------|
| C++ engine releases GIL | VERIFIED | `UnlockPython` class in `lock.hpp`, ~44 release points in data callbacks via `py::gil_scoped_release` |
| Ollama integration works | VERIFIED | `nodes/src/nodes/llm_ollama/` -- uses `langchain_openai.ChatOpenAI` pointed at `localhost:11434/v1` |
| DeepSeek R1 via Ollama | VERIFIED | 5 profiles (1.5B, 7B, 14B, 32B, 671B) in `services.json` -- no 70B profile |
| DeepSeek cloud API | VERIFIED | `nodes/src/nodes/llm_deepseek/` with API key validation for cloud; dummy key for local |
| 12+ LLM provider APIs | VERIFIED | OpenAI, Anthropic, Bedrock, Gemini, Vertex, Mistral, Ollama, DeepSeek, Perplexity, X.AI, Qwen. IBM Watson code exists but no `services.json` -- excluded |
| LangChain dependency | NOTE | Ollama/DeepSeek/OpenAI/Perplexity nodes use `langchain_openai.ChatOpenAI` -- be transparent; C++ advantage is data pipeline, not LLM call layer |
| MCP client/server | VERIFIED | `packages/client-mcp/` -- PyPI `rocketride-mcp` v1.0.2 |
| VS Code extension | VERIFIED | `apps/vscode/` -- marketplace publisher "rocketride" |
| Docker deployment | VERIFIED | `docker/` directory with GHCR images |
| Zero-copy / Apache Arrow | NOT FOUND | Python dict -> C++ json::Value conversion, not zero-copy |
| Dynamic batching | NOT IN REPO | May exist in separate model server repo |
| 256 threads | UNVERIFIED | Thread pool config not located in investigation |
| Aparavi branding | NOTE | Source files have MIT license headers crediting "Aparavi Software AG" -- Reddit will ask about this relationship; prepare a clear answer |

---

## 6. Metrics & Success Criteria

### 6.1 Realistic Predictions (data-driven from Reddit research)

**Key conversion ratios (verified):**
- Reddit upvote → GitHub star: ~0.3x to 0.5x (10 upvotes ≈ 1 star as floor estimate)
- HN front page → stars: 100-300 in first 24h (floor), 500-2000 if viral
- Star decay: Day 2 = 56% of peak, Day 3-7 = ~16% of peak, then 1-5 stars/day baseline

**r/LocalLLaMA tool post distribution (verified):**
- 55% of tool posts get <50 upvotes and die within 6 hours
- 35% get >100 upvotes (well-presented, clear value prop)
- 12% get >300 upvotes (high-utility infrastructure tools)
- 6% get >500 upvotes (polished UI + video demo)
- 2% get >1,000 upvotes (viral outliers)

### 6.2 Three Scenarios for RocketRide

| Scenario | r/LocalLLaMA | HN | Stars at 4 weeks | Stars at 12 weeks |
|----------|-------------|-----|-------------------|-------------------|
| **Worst-case (55% likely)** | ~15 upvotes, 2 comments, dies in 4h | Doesn't reach front page | 85 (+15 from 70) | 120 |
| **Likely-case (35% likely)** | ~85 upvotes, 18 comments, good discussion | Page 2 or brief front page | 250 | 500-700 |
| **Best-case (10% likely)** | ~600 upvotes, trending | Front page 12+ hours | 1,000 | 2,000-3,000 |

### 6.3 Target Metrics (using likely-case as baseline)

| Metric | Current | 4-Week Target | 8-Week Target | 12-Week Target |
|--------|---------|---------------|---------------|----------------|
| GitHub stars | ~70 | 200 | 500 | 1,000 |
| Docker pulls/week | Unknown | 50 | 200 | 500 |
| VS Code installs | Unknown | 30 | 150 | 400 |
| Reddit post avg upvotes | 0 | 30 | 85 | 150 |
| r/LocalLLaMA launch post | N/A | 85+ upvotes (likely) | - | - |
| HN launch post | N/A | Page 2+ | - | - |
| F5Bot "RocketRide" mentions/week | 0 | 2 | 10 | 25 |

### 6.4 Diagnostic Ratios (monitor during launch)

| Ratio | Healthy | Failing | Action |
|-------|---------|---------|--------|
| Upvotes : Stars | 10:1 or better | >20:1 | README/onboarding is broken -- people interested but not converting |
| Comments : Upvotes | 1:5 or better | <1:20 | Post not generating discussion -- rewrite or add controversy |
| Stars Day 1 : Stars Day 7 | 6:1 | >20:1 | No secondary distribution -- push to newsletters, Twitter |

### 6.5 Secondary Distribution Targets (for 500→1000 stars)

After initial Reddit/HN spike, stars slow to 1-5/day. To reach 1,000 requires:
- **Newsletters:** TLDR, Bytes, Python Weekly, Golang Weekly, Console.dev
- **"Awesome" lists:** awesome-selfhosted, awesome-llm, awesome-mcp
- **Twitter/X influencers:** Share benchmark results with local LLM community accounts
- **GitHub Trending:** If we hit 200+ stars in 24h, we may trend -- this creates a flywheel

---

## 7. Risk Matrix

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Benchmark numbers not impressive enough | Launch fails | HARD GATE: only post if >2x Python baseline on real workloads |
| Existing benchmark is synthetic toy | Credibility destroyed on Reddit | Rewrite from scratch with real end-to-end pipeline comparison |
| Reddit flags posts as spam | Account banned | Build karma first; 3 weeks no self-promo; NEVER cross-vote between team accounts |
| Astroturfing detection | Both accounts banned | Team accounts must NOT upvote/comment on each other's posts; maintain independence |
| README/docs not ready | Bad first impression | Block launch on README approval from lead engineer |
| Docker demo fails on user's machine | Negative comments dominate | Test on 5+ different systems (Linux, Mac, Windows WSL) before launch |
| Competitor launches similar feature | Loses differentiation | Move fast; MCP PDF intelligence is our unique angle |
| Community asks about zero-copy/Arrow | Credibility hit if we claim it | Never claim it; be honest about current architecture |
| LangChain dependency discovered | "Leaner than LangChain" claim looks hypocritical | Preemptively address: "We use LangChain's OpenAI-compatible client for LLM routing; C++ advantage is in the data processing pipeline" |
| Aparavi/RocketRide branding confusion | Reddit asks "who is Aparavi?" | Prepare clear answer about corporate relationship; source headers say Aparavi Software AG |
| HN launch too close to Reddit launch | No buffer to fix issues from Reddit feedback | Space HN post 4+ days after r/LocalLLaMA launch, not 1 day |
| Team bandwidth insufficient | 12-week plan requires parallel engineering + daily Reddit engagement | Add explicit ownership and "cut line" -- see Section 8 |

---

## 8. Timeline

**Ownership:** Dmitrii = Reddit engagement + Docker/DX. Lead engineer = README/docs + benchmarks.
**Cut line:** If behind at Week 4, drop Tier 2 features and launch with Tier 1 only.

```
Week 1-2: PREP
  [ ] README overhaul (lead engineer owns; Dmitrii reviews)
  [ ] One-command Docker demo (docker/demo/docker-compose.yml -- does NOT exist yet)
  [ ] Density benchmark script (REWRITE test/density_benchmark.py -- existing is synthetic toy)
  [ ] 3 pre-built pipeline templates (templates/ directory -- does NOT exist yet)
  [ ] VS Code marketplace listing polish
  [ ] Start community engagement -- both accounts building karma

Week 3-4: BUILD + ENGAGE
  [ ] PDF Intelligence MCP server
  [ ] Reasoning Stream Splitter node
  [ ] Demo GIF/video recording
  [ ] Continue community engagement (target: 50+ karma each)
  [ ] Set up F5Bot alerts
  HARD GATE: Benchmark must show >2x improvement on real workloads before proceeding

Week 4-5: SOFT LAUNCH
  [ ] Post to r/SideProject, r/opensource, r/coolgithubprojects
  [ ] Gather feedback, fix issues
  [ ] Prepare main launch posts

Week 5-6: MAIN LAUNCH
  [ ] r/LocalLLaMA benchmark post (Tuesday 10AM ET, "Show and Tell" flair -- verified peak)
  [ ] r/selfhosted (Friday -- "New Project Friday" rule, MANDATORY)
  [ ] r/MachineLearning Monthly Self-Promotion Thread ([P] tag)
  [ ] Hacker News "Show HN" (following Monday -- 4+ day buffer after Reddit)
  [ ] "War Room" for first 4 hours of each post -- reply within 15 minutes

Week 6-8: FOLLOW-UP
  [ ] MCP demo post
  [ ] Weekly content posts
  [ ] Visual MCP Tool Creator release
  [ ] Template gallery launch

Week 8-12: SUSTAIN
  [ ] Apache Arrow IPC (if resources allow)
  [ ] PII anonymization pipeline
  [ ] Workflow Time Travel debugger
  [ ] Continue weekly posts + community engagement
```
