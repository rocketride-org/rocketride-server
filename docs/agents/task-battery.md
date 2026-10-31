# RocketRide User Task Battery — 506 Acceptance Questions

Purpose: the acceptance test for the agent-doc rewrite. Every item is something a
real user would ask a coding agent to do with RocketRide. A doc file is DONE when
an agent can complete its items from the delivered docs alone — no reading
`shell.d.ts`, no reading platform source, no trial-and-error recovery.

Grounding: the 151-node services catalog, the TypeScript client (79 client
methods + Account/Billing/Deploy/Log/Database sub-clients + app-sdk), the Python
client (~157 callables across mixins and sub-clients), the shell API surface
(110 exports), and the App Builder lifecycle.

Rule of use: when a doc section is drafted, run its category here against an
agent with ONLY the docs in context. Items it cannot complete mark the gaps.

---

## Doc-coverage scoring pass — executed 2026-08-20 09:39 (third pass)

Scored against ONLY the `CLAUDE.md` stub and the ten `ROCKETRIDE_*` files it
referenced (now `docs/agents/context/stubs/CLAUDE.md` and
`docs/agents/context/`; `ROCKETRIDE_CLI.md` postdates this pass). No source
code, no shell.d.ts, no prior product knowledge was used. Pass history: 7.7
(first), 9.0 (second, after UI_COMPONENTS / INTEGRATIONS / Patterns 16–29),
9.0 (third pass).

Changes since the second pass: the **two-`.env`-pair credentials contract**
(`ROCKETRIDE_URI`/`APIKEY` = development server, `ROCKETRIDE_DEPLOY_URI`/
`APIKEY` = deployment target; absence of the deploy pair = stop and ask) in
CONCEPTS, README, the stub, and both API docs, with mixed-topology semantics
(deploy server's clock and env layers); the **scaffold-only rule** with three
front doors (`New App wizard`, `client.deploy.createApp`, `rocketride app
create`, `local.<slug>` default id); **scriptable app packaging** —
`deploy.addApp`/`add_app` (packs exactly as the App Builder: include entries,
gitignore + baseline, 50MB/512MB caps), `deploy.verifyApp`/`verify_app`
(local dry run), and the `rocketride app create/verify/deploy` CLI trio;
the **server-matched client version note**; and the **pnpm requirement** for
app work. These land mostly on operational-correctness ground the battery
touches lightly, so the headline barely moved (2295 → 2307 points) — but they
closed the last workflow gaps: scripted app deploys, dev-vs-deploy targeting,
and hand-rolled app scaffolds.

Third-pass items that moved: workspace setup [8→9], cloud connect/sign-in
[6→8] (the two-pair contract removes auth-flow guesswork), API-key handling
[8→9], dev-vs-cloud switching [7→9], headless auth [9→10], two-team configs
[7→8] (deploy-server env-layer rule), wizard/scaffold [9→10], app-id
reservations [8→9] (`local.*` now documented), Package-tab readiness [8→9]
(`verifyApp` mirrors it scriptably), blank-preview diagnosis [6→7] (the
scaffold section now names the failure symptoms and their causes in one place).

## Doc-coverage scoring pass — executed 2026-10-21 (fourth pass)

Scored against ONLY `docs/agents/context/stubs/CLAUDE.md` and the twelve
`ROCKETRIDE_*` files now in `docs/agents/context/` (`ROCKETRIDE_CLI.md` and
`ROCKETRIDE_DEVTOOL.md` postdate the third pass). Method: sixteen parallel
scoring agents, each holding only the context docs, each grading its
category's questions against the 0–10 rubric below. No source code, no
shell.d.ts, no prior product knowledge was credited. This is the first pass to
score the 2026-10-21 addendum (X–AD, 250 items), and the first re-measurement
of A–W since 08/20.

Headline: **3,805 points / 506 items = 7.5 overall**. The legacy battery
(A–W, 256 items) re-measures at **8.8** against the 9.0 baseline — scorer
variance plus a few honest dips (P. Billing 6.0, S. CLI 8.4). The addendum
(X–AD, 250 items) measures **6.2** and is what pulls the headline down.

What the fourth pass established:

- **X. Dev tools (9.5)** — `ROCKETRIDE_DEVTOOL.md` delivers. Nearly every
  trap (mount-is-not-activation, pane-reopen-on-load, `document.hidden`,
  unmount-never-fires) is defused verbatim in the doc. Weakest items:
  stale-second-document diagnosis [7] and porting off the old `peer` prop [7].
- **Y. Node development (2.7)** — the context docs cover nodes almost
  entirely from the consumer side (catalog, schemas, wiring, profiling). The
  authoring contract — scaffold layout, `IGlobal.py`/`IInstance.py`,
  `services.json`, README schema, lifecycle/emit/error APIs, testing under
  `./builder` — is absent (those live in `docs/development/nodes/`, not in
  the agent bundle). Thirteen items score 0. The two store-app traps
  (`scaffold_node`/`local_nodes` wrong for store apps, custom nodes can't
  ship in store pipelines) are the one authoring-adjacent area explicitly
  covered [8–9].
- **Z. Advanced pipelines (7.1)** — lifecycle, TTL, CI validation, DVR,
  scheduling, and the two realm traps (browser push, VS Code SSE) score 8–10.
  Holes: conditional routing by document value [1], chunking-for-citations
  [2], incremental index maintenance [2], handle-lifetime semantics [2],
  `.pipe` diffing [3].
- **AA. VS Code extension development (4.1)** — the platform/bus surface the
  extension exposes is well covered (monitor refcounting, `clearAllMonitors`
  refusal, API-key hook, level-not-edge all 8–9), but the extension's own
  contributor workflow — build programs, tsconfigs, `getLogger()` rule, VSIX
  packaging, builder tests, doc routing — is entirely outside the context
  docs (it lives in AGENTS.md / `docs/development/`). Eight items score 0.
- **AB. Browser-based development (7.3)** — dev loop, iframe bridge,
  seeded/loaded workspace state, and DataGrid traps are strong (9–10). Holes:
  announcements-ticker control [1], first-paint profiling [2], dev-preview
  detection [3], manual entry-URL override [4], Stripe return from a
  web-origin-less realm [4].
- **AC. Shell bus, realms & the client (6.6)** — the lane model, op registry
  rules, tri-state connection, and retry/timeout traps are explicit (9–10).
  Holes are wire-level: the error registry [0], byte framing and binary DAP
  members [0], request-vs-call chokepoint rationale [3], bus-timeout budget
  [3], host-op registration architecture [1–2], monitor refcounting across
  realms [4].
- **AD. Advanced app development (6.9)** — scaffold/install traps, the
  deploy-binds-nothing trap, billing, and manifest coverage are strong
  (9–10). Holes: the app catalog / marketplace listing surface [1–3],
  payouts [3], add-to-desktop verb [4], private-protocol apps [1], and
  repo documentation rules [0] (AGENTS.md ground, not agent-doc ground).

A–W items that moved against the 08/20 baseline (measurement, not doc
changes, unless noted): P. Billing fell 7.3→6.0 (quota model [5→2],
entitlement enforcement, invoices); S. CLI fell 9.4→8.4 (no per-task status
verb, no event-follow verb, no store download-to-file — all now explicitly
routed to the SDK by ROCKETRIDE_CLI.md, which is honest but unactionable from
the terminal); H dipped on deployment run-history [8→7] and source preview
[7→4]; C dipped on NER [7→4] and knowledge-graph building [7→5]. Gains:
A. Setup 8.7→9.2 and O. Account 8.8→9.1 (the two-pair contract and layered
env sections continue to firm up), M. dev loop 8.3→8.6.

Open decision flagged by this pass: Y and AA fail mostly on material that
deliberately lives outside `docs/agents/context/` (node authoring in
`docs/development/nodes/`, extension contributing in AGENTS.md). Either those
categories' ceiling is accepted as "wrong corpus — agents working in the
monorepo get AGENTS.md routing instead", or a condensed authoring doc joins
the context bundle. Until that's decided, treat the Y/AA numbers as a corpus
statement, not a doc-quality verdict.

### Decision and remediation plan — 2026-10-21

**The open decision is resolved two different ways, because Y and AA are not
the same problem.**

**Y — node authoring JOINS the bundle.** Writing a node is something a user
does *in their own workspace*, against the engine they are connected to. That
it currently lives in `docs/development/nodes/` is an artifact of the monorepo,
not a statement about audience. A condensed `ROCKETRIDE_NODES.md` ships.

**AA — the contributor half stays OUT, and its ceiling is accepted.** Building
the VS Code extension from source, choosing between its two tsconfigs, the
`getLogger()` rule, VSIX packaging, running its tests under `./builder`, and
which docs a surface change must update are tasks for someone working *on the
platform*, in this monorepo, where AGENTS.md already routes them. An agent in a
user's workspace never does any of it, and shipping it would enlarge every
user's context for work they cannot perform. **Those eight zeros are correctly
zero.** AA should be split at its next revision: the platform/bus half (already
8–9) stays here; the contributor half moves to a separate battery scored
against AGENTS.md + `docs/development/`. The same applies to AD's two repo-
documentation items [0] and the contract-freeze item [1].

**Priority order, by items × gap rather than by gap alone:**

| # | Work | Doc | Items reached | Now |
|---|---|---|---|---|
| 1 | Node authoring contract | **new `ROCKETRIDE_NODES.md`** | ~30 of Y's 40 | 2.7 |
| 2 | Wire-level realm semantics | `ROCKETRIDE_DEVTOOL.md` §new | ~12 of AC's 40 | 6.6 |
| 3 | Catalog & marketplace surface | `ROCKETRIDE_APPS.md` | ~6 of AD | 6.9 |
| 4 | Retrieval-quality recipes | `ROCKETRIDE_PIPELINES.md` | ~5 of Z + 2 of C | 7.1 |
| 5 | Shell runtime & preview detection | `ROCKETRIDE_APPS.md` | ~5 of AB | 7.3 |
| 6 | Quota & entitlement model | `ROCKETRIDE_CONCEPTS.md` | ~4 of P | 6.0 |

**1. `ROCKETRIDE_NODES.md` must answer, in this order** (each line is a 0–3
scorer today): the scaffold's file-by-file layout; `IGlobal.py` versus
`IInstance.py` and what state belongs in each; `services.json` for one and for
several capabilities; the README contract and *which region is generated and
must never be hand-edited*; how to regenerate parameter docs; lane declaration
so a wrong wiring is refused; config schema so the editor renders a form, plus
conditional fields and load-time validation; the document lifecycle — read,
transform, emit one, emit many; error policy (fail the run versus skip the
document); cancellation; progress reporting; emitting engine events; logging
where an operator will see it; streaming large payloads and carrying binary;
secrets; dependency declaration; testing under `./builder` and against a live
pipeline; the deploy-server environment checklist; config versioning; and
promoting a local node into the catalog. Carry over verbatim the two traps that
already score 8–9 (`scaffold_node`/`local_nodes` are wrong for a store app;
a custom node cannot ship inside a store app's pipeline).

**2. AC's holes are all wire-level** and belong in one new section of
`ROCKETRIDE_DEVTOOL.md`, since they are consequences of one design: `request()`
is the chokepoint rather than `call()` (everything that bypasses `call()` for
the binary member funnels there); DAP has exactly one binary member,
`arguments.data`, and unframed bytes become an index-keyed JSON object that
silently corrupts a write; the error registry rebuilds an exception's class so
`instanceof` survives a process boundary, and an unknown class degrades to
`Error` with its name kept; the bus timeout must outlast the SDK's so the
engine's own limit expires first; `host.*` ops live in two places because
`packages/shell` sits below `shared` and cannot import its op map.

**3–6** are ordinary coverage gaps — named APIs and recipes that exist but are
undocumented. No structural question attached.

**Re-score after each item lands**, not once at the end: Y alone moves the
overall figure by roughly +1.5, which would otherwise mask whether 2–6 worked.

Each question's leading number is a score `[n]` on a 0–10 scale:
how completely and accurately the delivered docs alone answer it.

| Score | Meaning |
| --- | --- |
| 10 | Fully answered: complete, accurate, directly actionable from the docs |
| 7–9 | Answerable with minor gaps (a detail, an example, or an edge missing) |
| 4–6 | Partially answered: the concept or API is present but key steps must be guessed or composed from fragments |
| 1–3 | Barely touched: named or implied, not actionable |
| 0 | Not covered at all |

### Category summary

`Baseline (08/20)` is the third pass's result. `Measured (10/21)` is the
fourth pass. Per-item scores in the tables below are the 10/21 measurement.

| Category | Baseline (08/20) | Measured (10/21) | Δ | Items |
| --- | --- | --- | --- | --- |
| A. Setup, connection & workspace | 8.7 | 9.2 | +0.5 | 12 |
| B. Pipeline grammar & wiring | 9.1 | 9.3 | +0.2 | 14 |
| C. Pipeline recipes by use case | 9.0 | 8.1 | −0.9 | 28 |
| D. Driving pipelines from code | 8.8 | 8.8 | 0.0 | 18 |
| E. Chat, Question & streaming | 9.1 | 9.1 | 0.0 | 8 |
| F. Files, cloud store & templates | 8.6 | 8.3 | −0.3 | 14 |
| G. Events, monitoring & run logs | 8.6 | 8.7 | +0.1 | 14 |
| H. Deploying & scheduling pipelines | 9.4 | 8.9 | −0.5 | 14 |
| I. App structure & layout | 9.6 | 9.6 | 0.0 | 14 |
| J. App UI components | 9.8 | 9.6 | −0.2 | 16 |
| K. App hooks, state, theming & styles | 9.5 | 9.4 | −0.1 | 12 |
| L. App + pipeline integration | 9.2 | 9.2 | 0.0 | 10 |
| M. App dev loop & debugging | 8.3 | 8.6 | +0.3 | 8 |
| N. App packaging, publish, store & review | 9.3 | 9.4 | +0.1 | 16 |
| O. Account, orgs, teams, keys & env | 8.8 | 9.1 | +0.3 | 12 |
| P. Billing & plans | 7.3 | 6.0 | −1.3 | 6 |
| Q. Dashboard & operations | 7.8 | 7.2 | −0.6 | 6 |
| R. Database & SQL | 9.8 | 9.5 | −0.3 | 4 |
| S. CLI | 9.4 | 8.4 | −1.0 | 8 |
| T. MCP & external integrations | 10.0 | 9.7 | −0.3 | 6 |
| U. Observability ingestion | 9.3 | 9.2 | −0.1 | 6 |
| V. Performance profiling | 9.0 | 8.5 | −0.5 | 2 |
| W. Troubleshooting | 8.1 | 8.3 | +0.2 | 8 |
| X. Dev tools — the two mounts | *new* | 9.5 | — | 32 |
| Y. Node development | *new* | 2.7 | — | 40 |
| Z. Advanced pipeline development | *new* | 7.1 | — | 34 |
| AA. VS Code extension development | *new* | 4.1 | — | 36 |
| AB. Browser-based development | *new* | 7.3 | — | 32 |
| AC. Shell bus, realms & the client | *new* | 6.6 | — | 40 |
| AD. Advanced app development | *new* | 6.9 | — | 36 |
| **Overall** | **9.0** (A–W only) | **7.5** (A–W: 8.8) | — | **506** |

---

## A. Setup, connection & workspace — avg 9.2

| Score | Question |
| --- | --- |
| 10 | Set up a brand-new RocketRide workspace from an empty folder — what goes where? |
| 9 | Connect my workspace to RocketRide Cloud and sign in. |
| 9 | Connect to my self-hosted engine at ws://myserver:5565 instead of the cloud. |
| 10 | Where does my API key come from, and how do I keep it out of git? |
| 8 | Switch my project between a local dev server and the cloud without editing code. |
| 10 | Authenticate a headless script with an API key instead of a browser login. |
| 7 | Log in from a TypeScript app with OAuth/PKCE and log out cleanly. |
| 10 | Reconnect automatically when the server drops, and surface connection state in my app. |
| 10 | Use environment-variable substitution (`${ROCKETRIDE_APIKEY}`) inside a `.pipe` file. |
| 10 | What is the `.rocketride/` folder in my workspace, and which parts may I edit? |
| 9 | Check what server version and features I'm connected to. |
| 8 | Write a check script that proves my project's connection and pipeline are healthy. |

## B. Pipeline grammar & wiring — avg 9.3

| Score | Question |
| --- | --- |
| 10 | Create my first `.pipe` file by hand — the minimal valid structure and required field order. |
| 10 | What are lanes, and how do I know which two nodes can connect? |
| 10 | Wire one parser's output into two different consumers. |
| 10 | What's the difference between a source node and a processing node — and which sources exist? |
| 7 | Configure a node with profiles vs inline config — when is each right? |
| 10 | Override one field of a built-in profile without redefining the whole thing. |
| 10 | Discover every available node and its config options from my workspace. |
| 9 | Read a node's schema to learn required vs optional config fields. |
| 10 | Attach a tool node to an agent — why doesn't that connection use lanes? |
| 10 | Build a sub-pipeline invoked as a tool (`tool_pipe`) and the ownership rules it must obey. |
| 10 | Why is my sub-pipeline rejected as "reachable from two control roots"? |
| 7 | Position and hide nodes with the `ui` block — does layout affect execution? |
| 10 | Validate a pipeline without running it, and interpret the validation errors. |
| 7 | Version my `.pipe` files in git and share them with my team. |

## C. Pipeline recipes by use case — avg 8.1

| Score | Question |
| --- | --- |
| 8 | Drop any file — PDF, DOCX, image, audio, video — and get its text back. |
| 8 | Classic RAG: chunk documents, embed, store in Qdrant, answer questions with citations. |
| 7 | Swap the vector store: the same RAG on Pinecone, Milvus, Weaviate, or Chroma. |
| 9 | Use Postgres as my vector store instead of a dedicated engine. |
| 9 | OCR scanned documents and photos of documents. |
| 9 | Parse with LlamaParse, Landing.AI, or Reducto instead of the built-in parser — when and why? |
| 7 | Transcribe audio files and answer questions about what was said. |
| 9 | Text-to-speech: generate spoken audio with ElevenLabs or OpenAI TTS and return it. |
| 8 | Grab frames from a video and describe them with a vision LLM. |
| 9 | Video understanding and search with TwelveLabs. |
| 8 | Detect and anonymize PII before anything hits storage. |
| 4 | Extract named entities (people, orgs, places) from documents. |
| 7 | Summarize long contracts and extract their key facts. |
| 9 | Extract structured JSON from invoices and validate it against a schema. |
| 9 | Put guardrails on LLM output before it reaches the user. |
| 9 | A chat pipeline with conversation memory — internal vs persistent memory. |
| 8 | Long-term user memory across sessions with mem0. |
| 7 | Swap the LLM provider (OpenAI → Anthropic → Gemini → local Ollama) with a one-line change. |
| 7 | Which model should I use for quality vs speed vs cost — current guidance. |
| 9 | Vision Q&A over images (GPT-4o vision, Gemini, Mistral, Ollama). |
| 9 | Batch image cleanup: background removal and thumbnail generation. |
| 9 | Pose estimation or depth estimation over an image set. |
| 5 | Build a knowledge graph from documents (Neo4j / FalkorDB) and query it. |
| 9 | GraphRAG with Cognee. |
| 9 | A web-research pipeline: Exa/Tavily search plus Firecrawl scraping, synthesized by an LLM. |
| 9 | A crew of agents: CrewAI manager delegating to subagents. |
| 7 | agent_rocketride vs CrewAI vs LangChain vs LlamaIndex vs DeepAgent — pick one and wire it. |
| 9 | An agent that can safely run Python code as a tool. |

## D. Driving pipelines from code — avg 8.8

| Score | Question |
| --- | --- |
| 9 | Run a `.pipe` from a Python script and wait for the result. |
| 9 | Run a pipeline object from a browser app, where file paths don't exist. |
| 9 | Reuse an already-running pipeline instead of starting a new one (`useExisting`) — exact semantics. |
| 10 | Pass runtime arguments into a pipeline (`args`). |
| 9 | Set a TTL so an idle pipeline shuts itself down. |
| 9 | Send a text payload into a running pipeline and receive the response. |
| 9 | Upload many files with bounded concurrency and per-file progress. |
| 10 | Stream data chunks into a running pipeline (DataPipe open/write/close). |
| 8 | Poll task status and distinguish queued vs running vs finished vs failed. |
| 9 | Get a running task's token and reattach to it from another process. |
| 10 | Retrieve the exact pipeline definition a running task is executing. |
| 10 | Restart a task with a modified pipeline. |
| 10 | Terminate a running pipeline cleanly. |
| 4 | Process a large document set concurrently — threads and throughput guidance. |
| 6 | Invoke a single node's capability directly without authoring a pipeline. |
| 10 | List available services and fetch one service's definition programmatically. |
| 8 | Handle the SDK exception hierarchy and retry transient failures sensibly. |
| 10 | Why does my long CPU-bound loop kill the websocket after ~60 seconds, and how do I fix it? |

## E. Chat, Question & streaming — avg 9.1

| Score | Question |
| --- | --- |
| 10 | Ask a one-shot question to a chat pipeline and print the answer. |
| 8 | Stream tokens live (SSE) into my UI as the model generates. |
| 10 | Build a multi-part Question with system instructions. |
| 10 | Get the answer back as structured JSON (`expectJson`). |
| 9 | Restrict which documents the chat searches with a filter. |
| 9 | Keep conversation context across multiple chat calls to the same task. |
| 8 | Route follow-up questions from different browser tabs to the same running chat. |
| 9 | `response_answers` vs `response_text` — which do I wire, and why? |

## F. Files, cloud store & templates — avg 8.3

| Score | Question |
| --- | --- |
| 10 | Write pipeline results to the cloud file store and read them back later. |
| 10 | List a store directory and stat individual files. |
| 10 | Read and write JSON objects to the store without manual serialization. |
| 10 | Fetch many store files in one round trip. |
| 10 | Rename, move, and delete files; create and remove directories. |
| 10 | Get a download URL I can hand to a browser. |
| 9 | Stream a large store file without loading it all in memory. |
| 8 | Save a pipeline as a reusable template; list, apply, and delete templates. |
| 9 | Where do dropper-uploaded files land, and how do I fetch them afterward? |
| 9 | Return a generated artifact (say, TTS audio) to my app's user as a download. |
| 1 | What are the store's size and quota limits? |
| 8 | Share store files between my app and my pipelines. |
| 5 | Organize storage per-user vs per-app — path conventions. |
| 7 | Clean up old artifacts programmatically. |

## G. Events, monitoring & run logs — avg 8.7

| Score | Question |
| --- | --- |
| 10 | Subscribe to every event from one task. |
| 9 | Monitor all my tasks at once, dashboard-style. |
| 10 | Choose event types (TASK/SUMMARY/FLOW/OUTPUT/SSE/DETAIL) — what each carries. |
| 9 | Stop monitoring cleanly when my component unmounts. |
| 9 | Migrate off the deprecated `setEvents` to monitors. |
| 9 | Identify my client connection — why and when it matters. |
| 8 | Show a live pipeline-progress graph from per-node FLOW events. |
| 10 | Record a run and replay it later (the run-log DVR). |
| 9 | List and delete recorded run logs. |
| 9 | Seek inside a recorded run — chapters and segments. |
| 8 | Choose a pipeline trace level — detail vs cost. |
| 9 | Capture full debug output for one run. |
| 9 | Update my app's UI from platform events — shell events vs task monitors, which for what? |
| 4 | Alert me (or call my webhook) when any pipeline errors. |

## H. Deploying & scheduling pipelines — avg 8.9

| Score | Question |
| --- | --- |
| 10 | Deploy a pipeline to the server so it runs without my machine. |
| 10 | Deploy v2 of a pipeline, list versions, and see what each contains. |
| 10 | Point my team at version N; roll back to N−1 without rebuilding. |
| 10 | Run a deployed pipeline on demand. |
| 10 | Schedule a deployed pipeline to run Monday/Wednesday/Friday from 08:00 to 15:00. |
| 10 | Pause a schedule for the holidays and resume it — without losing the cron. |
| 10 | Set per-source trace and debug settings that ride every scheduled run. |
| 7 | See the run history of a deployment. |
| 4 | Preview what a deployed source will do before running it. |
| 10 | Disable, enable, and remove a deployment. |
| 7 | Deploy the same pipeline for two teams with different configurations. |
| 9 | What is a sourceId — schedule two sources of one project independently. |
| 9 | Download the artifact of a deployed version. |
| 9 | Guarantee a scheduled run always ends by a wall-clock time. |

## I. App structure & layout — avg 9.6

| Score | Question |
| --- | --- |
| 8 | Create a new app with the App Builder wizard — what the templates give me. |
| 10 | The anatomy of a scaffolded app — what each of the ten files is for. |
| 10 | Every `appManifest` field, explained — id, publisher, categories, mode, authenticated, and the rest. |
| 9 | Choose my app id — why `<developer>.<name>` matters and what's reserved. |
| 10 | Add a sidebar to my app with AppLayout. |
| 9 | Turn on the bottom status bar and know what it shows. |
| 10 | Put my own content in the status bar. |
| 10 | A multi-view app: sidebar navigation that switches content panes. |
| 10 | A file-editor app using the Documents system — tabs, explorer, split views. |
| 10 | Persist my app's UI state across reloads. |
| 9 | Ship and render my app's icon correctly. |
| 9 | What are my app's props (`isConnected`, `identity`) and when do they change? |
| 10 | Expose a second component from my app for others to embed. |
| 10 | Embed a component from another app into mine. |

## J. App UI components — avg 9.6

| Score | Question |
| --- | --- |
| 10 | What stock components exist, and where do I browse them? |
| 10 | A data table with sorting, filtering, and pagination over live data. |
| 6 | A card-grid view with a filter strip as an alternative to the table. |
| 10 | A full chat UI wired to a chat pipeline. |
| 10 | Render LLM/markdown output safely — including images and charts. |
| 9 | A file drop zone — styling, multiple files, accepted types. |
| 10 | Modals, confirmations, and save-file dialogs. |
| 10 | Form inputs: text fields, toggles, chips. |
| 9 | Buttons — variants, sizes, disabled states, icon buttons. |
| 10 | Status displays: badges, dots, banners, empty states. |
| 10 | Page scaffolding: cards, sections, label/value rows. |
| 10 | A content header with title and action buttons. |
| 10 | Tabbed interfaces and slide-in detail panels. |
| 10 | Sidebar menus and the announcements footer. |
| 10 | Rich grid cells: badges, buttons, avatars, monospace — and a custom actions column. |
| 10 | Remember each user's grid layout and column choices. |

## K. App hooks, state, theming & styles — avg 9.4

| Score | Question |
| --- | --- |
| 10 | Get the connected client and connection state in any component. |
| 10 | React to platform events (login, org change, theme change) with typed handlers. |
| 9 | Read the signed-in user and offer a working logout. |
| 10 | Style with theme tokens so dark and light modes both look right. |
| 10 | What's in `commonStyles`, and when do I use it versus my own styles? |
| 10 | The styling rules of the platform — what's idiomatic, what's forbidden. |
| 10 | React to a theme change at runtime. |
| 10 | Debounce a search box; poll a value on an interval. |
| 10 | Position a custom popup that closes on outside click. |
| 9 | Respond to the sidebar collapsing. |
| 6 | Handle running inside VS Code vs the browser — what differs. |
| 9 | Embed external web content in an iframe that follows the platform theme. |

## L. App + pipeline integration — avg 9.2

| Score | Question |
| --- | --- |
| 8 | Import a `.pipe` file into my app's code and start it (including the type declaration). |
| 9 | Start the pipeline on connect, keep its token in state, and survive hot reload. |
| 9 | Send dropped files through a pipeline and render the returned text. |
| 9 | Show live progress while the pipeline processes a file. |
| 10 | Stream a chat answer token-by-token into my chat component. |
| 8 | Run two different pipelines in one app and keep their tokens straight. |
| 10 | Ship pipelines inside the app package — how packaging embeds them, and why they can't be scheduled. |
| 10 | One shared pipeline task for all users vs a task per user — how to choose and implement. |
| 10 | Show a useful error state when the pipeline fails mid-run. |
| 9 | Trigger a server-deployed pipeline from my app instead of embedding one. |

## M. App dev loop & debugging — avg 8.6

| Score | Question |
| --- | --- |
| 10 | Run my app live with watch — what triggers rebuild, reinstall, restart. |
| 10 | Preview at phone/tablet/desktop sizes; zoom and fit. |
| 10 | See my `console.log` output and runtime errors while developing. |
| 5 | Debug my app with breakpoints from VS Code. |
| 10 | The preview shows stale code — why, and the reload rules. |
| 7 | Test my app in dark, light, and VS Code themes before shipping. |
| 10 | Preview as my signed-in self vs as an anonymous user. |
| 7 | Use the component gallery: live demos, knobs, and copyable snippets. |

## N. App packaging, publish, store & review — avg 9.4

| Score | Question |
| --- | --- |
| 9 | Make the Package tab fully green — identity, icon, README, include paths. |
| 10 | Include a shared workspace folder in my app's package. |
| 9 | Deploy even with type errors — the typecheck waiver and its consequences. |
| 10 | Deploy my app to the server — what the server build does with my source. |
| 9 | Publish to myself and run it from the app rail. |
| 10 | Publish to my team. |
| 9 | Submit my app to the public store — what review involves. |
| 9 | Track review status and reply to reviewer feedback. |
| 10 | Withdraw a submission. |
| 9 | My server build failed — find the build log and fix the cause. |
| 10 | Ship an update: deploy v4, repoint the audience, roll back if it breaks. |
| 10 | Where is my app live right now — every rung, version, and state at a glance. |
| 8 | Register my developer id — namespace ownership rules for app ids. |
| 9 | Write the store listing: description, categories, and pricing plans. |
| 10 | Take a published app down — disable vs remove. |
| 10 | Test a specific published version in the browser via the version override. |

## O. Account, orgs, teams, keys & env — avg 9.1

| Score | Question |
| --- | --- |
| 10 | See my profile and which organization I'm operating in. |
| 8 | Switch organizations — what changes when I do. |
| 10 | Invite someone to my org; remove someone who left. |
| 9 | Create teams and use them as deploy audiences. |
| 10 | Create an API key for CI; revoke it later. |
| 10 | Set the org's OpenAI key once so every member's pipelines use it. |
| 9 | Layered environment secrets — org vs team vs user precedence. |
| 9 | Use server-side secrets in pipelines with no local `.env` at all. |
| 10 | What can members do vs admins? |
| 5 | A key leaked — rotate it everywhere, fast. |
| 10 | Read account info inside my app and react when it changes. |
| 9 | Make my app require sign-in (`authenticated: true`) — what the user experiences. |

## P. Billing & plans — avg 6.0

| Score | Question |
| --- | --- |
| 8 | See my current plan and usage. |
| 6 | Upgrade my plan from inside the product. |
| 2 | What counts against my quota — tasks, tokens, storage? |
| 9 | Define paid plans for my own store app. |
| 5 | How do my app's subscribers get billed, and how are entitlements enforced? |
| 6 | Manage invoices and payment methods. |

## Q. Dashboard & operations — avg 7.2

| Score | Question |
| --- | --- |
| 6 | What's running right now across my org? |
| 8 | Who's connected to my server? |
| 9 | Kill a stuck task from an ops script. |
| 6 | Watch fleet-wide activity with the dashboard event feed. |
| 8 | Build a health/usage panel into my own admin app. |
| 6 | How long is task history retained, and where do old runs go? |

## R. Database & SQL — avg 9.5

| Score | Question |
| --- | --- |
| 10 | Run SQL from my app through the platform's database client. |
| 10 | Wrap multiple statements in a transaction with commit/rollback. |
| 8 | Query pipeline results that a `db_postgres` node stored. |
| 10 | When do I use a relational store vs a vector store vs a graph store? |

## S. CLI — avg 8.4

| Score | Question |
| --- | --- |
| 10 | Start a pipeline from the terminal. |
| 10 | Upload files to a running task from the terminal. |
| 7 | Check status and stop a task from the terminal. |
| 10 | List my running tasks from the terminal. |
| 10 | Browse the cloud store from the terminal. |
| 8 | Upload, download, and delete store files from the terminal. |
| 5 | Follow a task's events from the terminal. |
| 7 | Use the CLI in CI to smoke-test a deployed pipeline. |

## T. MCP & external integrations — avg 9.7

| Score | Question |
| --- | --- |
| 10 | Expose my pipelines as MCP tools so Claude/Cursor can call them. |
| 10 | Control which pipelines become tools and how they're described to the model. |
| 9 | Call RocketRide from an n8n workflow. |
| 10 | Trigger a pipeline from an external system's webhook — including auth. |
| 10 | Put a Telegram bot in front of a pipeline. |
| 9 | Call my own HTTP API from the middle of a pipeline. |

## U. Observability ingestion — avg 9.2

| Score | Question |
| --- | --- |
| 10 | Build an external service that ingests all platform events. |
| 9 | Authenticate a headless monitoring daemon. |
| 8 | Which event payload schemas are stable enough to parse? |
| 9 | Capture run lifecycle reliably across my daemon's reconnects. |
| 9 | Live ingestion vs DVR replay — when is each the right source? |
| 10 | Feed events into my own metrics database — the recommended ingester shape. |

## V. Performance profiling — avg 8.5

| Score | Question |
| --- | --- |
| 9 | Profile the server-side performance of my pipeline. |
| 8 | Read the profile tree and find the slow node. |

## W. Troubleshooting — avg 8.3

| Score | Question |
| --- | --- |
| 8 | "Component not found" when opening my pipeline — diagnose it. |
| 9 | Two nodes won't connect — read the lane mismatch and fix the wiring. |
| 8 | The pipeline starts but nothing happens — the source-node config checklist. |
| 7 | My app preview is a blank screen — the module-federation checklist. |
| 9 | I deployed v3 but users still see v2 — version vs binding, untangled. |
| 10 | Login loops forever in my app preview — the auth checklist. |
| 8 | Events stop arriving after a few minutes — keepalive and blocking causes. |
| 7 | A scheduled run failed overnight — which log has the answer, build vs run. |

---

# Addendum — 2026-10-21: 250 questions on the current surface

Added for the capabilities that landed after the third pass: the dev-tool
contract, the realm-owned client, node authoring, and the two hosts as
development targets. **Deliberately harder than A–W**: these are the questions
an agent gets wrong by guessing plausibly, so most have a specific right answer
that only the docs can supply. Several encode a trap — the plausible answer is
the wrong one — and are marked **(trap)**.

First measured in the fourth pass (2026-10-21, see above). Trap items were
scored high only where the docs explicitly state the correct non-obvious
answer; a silent doc scores a trap 0–3 because the agent would guess the
plausible-but-wrong answer.

## X. Dev tools — the two mounts — avg 9.5

| Score | Question |
| --- | --- |
| 10 | Turn my existing full-screen app into a dev tool without losing the full-screen form. |
| 10 | What exactly makes the host treat my app as a dev tool rather than an app? |
| 9 | Build a dev tool that has a sidebar panel but no document of its own. |
| 9 | Build a dev tool that is one document surface with no controls. |
| 10 | My tool's sidebar renders but the document never opens when I select the tool — fix it. |
| 10 | Open my tool's pane when the user selects my tool, and only then. **(trap)** |
| 10 | My tool's pane reopens on every page load, including panes I closed — why? **(trap)** |
| 9 | Give my tool one document per database connection, each with its own tab title. |
| 10 | Highlight the row in my sidebar that matches whichever of my documents is fronted. |
| 10 | Clear my sidebar's detail panel when the user switches to another tool's document. |
| 9 | My tool runs in VS Code where the two mounts are separate webviews — what breaks? |
| 9 | Share a selection between my sidebar and my document views. |
| 7 | A second document opens and immediately shows stale data — diagnose it. |
| 10 | My sidebar asks the frame for its state on mount and every tool's pane pops open. **(trap)** |
| 10 | Which mount should own a refcounted resource, and why not the other one? |
| 9 | Send a command from the sidebar to a document that may not be open yet. |
| 10 | Let a document tell the sidebar which page it is on, surviving a sidebar reload. |
| 9 | Add a manual Refresh button in my document that nudges the sidebar's shared poller. |
| 10 | Publish a snapshot from my controller that a document opening later renders instantly. |
| 10 | Two documents both need the same 3-second data — how many pollers should exist? |
| 10 | Run work in my controller only while my tool's panel is the selected tab. |
| 10 | My tool keeps polling after the user switches to another tool — stop it. |
| 10 | Why can I not use `document.hidden` to tell whether my tool's panel is visible? **(trap)** |
| 10 | Why does unmount cleanup never fire when my tool's panel is hidden? **(trap)** |
| 9 | Pause an engine monitor when my panel is deactivated and restore it on return. |
| 10 | What should I deliberately NOT pause when my panel goes out of view? |
| 10 | There is no "am I visible" prop — derive a correct initial polling state anyway. |
| 10 | Decide whether my tool should act on activation at all — the two cases. |
| 8 | Tear down every registration my tool made, and list what leaks if I forget one. |
| 9 | Theme my dev tool so it matches both the browser shell and the VS Code editor. |
| 10 | Why does my tool receive no `client` prop, and what do I use instead? |
| 7 | Port a tool written against the old `peer` prop to the channel-only contract. |

## Y. Node development — avg 2.7

| Score | Question |
| --- | --- |
| 1 | Scaffold a new node from scratch — every file it must have, and what each is for. |
| 0 | What is the difference between `IGlobal.py` and `IInstance.py`, and which holds what? |
| 1 | Write a node that reads documents and emits transformed ones on the same lane. |
| 3 | Declare my node's config schema so the pipeline editor renders a form for it. |
| 0 | My node's README fails `validate-node-readme.py` — read the schema and fix it. |
| 0 | Which region of my node's README must I never hand-edit, and what maintains it? **(trap)** |
| 0 | Regenerate my node's parameter documentation after changing its config. |
| 3 | Declare my node's lanes so it refuses to wire to an incompatible neighbour. |
| 2 | Write `services.json` for a node that exposes two capabilities. |
| 0 | Give my node an icon that renders in the editor's palette. |
| 0 | Declare a Python dependency for my node without breaking the engine's environment. |
| 0 | Write a unit test for my node that runs under `./builder`. |
| 4 | Test my node against a real pipeline without deploying anything. |
| 6 | My node loads but never receives a document — diagnose the lane wiring. |
| 1 | Emit multiple output documents from one input document. |
| 2 | Hold state across documents inside one node instance, correctly. |
| 0 | Share expensive state (a loaded model) across every instance of my node. |
| 5 | My node needs a secret — where does it come from, and never from where? |
| 1 | Make my node's failure stop the pipeline, versus skip the document. |
| 5 | Report progress from a long-running node so the monitor shows it. |
| 1 | Write a node that calls an external HTTP API with retries and a timeout. |
| 2 | Stream a large file through my node without loading it into memory. |
| 2 | Accept binary payloads in my node and pass them along intact. |
| 3 | Write a sink node that commits only once the whole run succeeds. |
| 0 | Write a source node that paginates an external system. |
| 2 | Make my node's config fields conditional on one another in the editor. |
| 0 | Validate a node's config at load time and fail with a message a user can act on. |
| 0 | Version my node's config so an old pipeline keeps working. |
| 4 | My node works locally but not on the deploy server — the environment checklist. |
| 8 | When is `scaffold_node`/`local_nodes` the wrong choice? **(trap)** |
| 9 | Why can a store app's bundled pipeline not use my custom node? **(trap)** |
| 2 | Contribute my node to the catalog — what changes versus a local node? |
| 9 | Find out which catalog node already does what I am about to write. |
| 9 | Read a node's schema to discover a config field the docs did not mention. |
| 8 | Profile my node to find out why it is the slow stage of my pipeline. |
| 2 | Log from inside a node so the output lands where an operator will see it. |
| 6 | Write a node that emits engine events my app can subscribe to. |
| 1 | Make my node cancellable so terminating the task actually stops it. |
| 1 | Handle a malformed input document without taking the run down. |
| 3 | Document my node so an agent can configure it without reading its source. |

## Z. Advanced pipeline development — avg 7.1

| Score | Question |
| --- | --- |
| 5 | Design a pipeline with two profiles — cheap-and-fast versus accurate — in one file. |
| 6 | Fan one input out to three parallel branches and rejoin them in order. |
| 1 | Route documents down different branches by a value in the document. |
| 5 | Build a pipeline that retries only the failed documents of a batch. |
| 8 | Add a mid-pipeline HTTP call without blocking the whole lane. |
| 10 | Reference an environment variable in a `.pipe` so no secret is committed. |
| 8 | Share one `.pipe` across a team and keep per-developer settings out of it. |
| 10 | Reuse a running pipeline instead of starting a second one. |
| 10 | Give a provisioned pipeline a TTL and understand what happens at expiry. |
| 10 | Validate a `.pipe` in CI and fail the build on a schema error. |
| 3 | Diff two `.pipe` files and explain what changed behaviourally. |
| 4 | Convert an ad-hoc script into a pipeline — what moves where? |
| 3 | Choose between a pipeline and a single node capability for a one-shot job. |
| 10 | Stream a pipeline's output into my app as it is produced. |
| 8 | Push data into an already-running pipeline from a browser realm. **(trap)** |
| 9 | Attach an SSE callback to a pipe from a VS Code webview — what happens? **(trap)** |
| 6 | Build a RAG pipeline and explain which stage to tune first when answers are poor. |
| 5 | Add a reranker to an existing retrieval pipeline without rebuilding the index. |
| 2 | Chunk documents so citations still point at the right place. |
| 2 | Keep an embedding index incrementally updated rather than rebuilt. |
| 9 | Build an agentic pipeline that calls tools and decides when to stop. |
| 8 | Give an agent pipeline a budget so it cannot loop forever. |
| 9 | Capture a recorded run and replay it to debug a failure. |
| 10 | Seek to a position in a recorded run and read the trace there. |
| 9 | Build a pipeline that writes to the cloud file store and one that reads from it. |
| 2 | A handle's lifetime belongs to which connection, and what breaks if the realm dies? **(trap)** |
| 10 | Schedule a pipeline with a cron expression and preview the next five runs. |
| 10 | Pause and resume a schedule without losing its configuration. |
| 10 | Deploy a pipeline to a different server from the one I develop against. |
| 7 | My pipeline passes validation but produces nothing — the source-node checklist. |
| 5 | Diagnose a pipeline that works on small inputs and stalls on large ones. |
| 9 | Find which node in a slow pipeline is actually the bottleneck. |
| 10 | Set trace level and debug output for one deployed source only. |
| 9 | Explain the difference between deploying a pipeline and publishing an app containing it. |

## AA. VS Code extension development — avg 4.1

| Score | Question |
| --- | --- |
| 0 | Build and run the extension from source, then load it in a fresh VS Code window. |
| 0 | Which build program compiles the extension host, and which compiles the webviews? **(trap)** |
| 0 | My webview file type-checks nowhere — which tsconfig was I missing? **(trap)** |
| 2 | Add a new webview surface and attach it to the shell bus as a realm. |
| 5 | Why is a `requestId` field in a webview protocol a bug report? **(trap)** |
| 4 | Convert a legacy per-page postMessage protocol into bus ops. |
| 0 | Log from the extension host correctly — and what I must never use. **(trap)** |
| 0 | Surface an error to the user from extension-host code, with the right error type. |
| 4 | Configure the dev and deploy connections separately in the extension. |
| 6 | Resolve an env value against the deploy slot rather than the dev slot. |
| 0 | Add a command to the command palette that acts on the active pipeline. |
| 9 | Show my tool in the extension's sidebar alongside the built-in ones. |
| 7 | Mount a dev tool in VS Code and confirm both mounts are separate realms. |
| 2 | Trace every bus message crossing a webview boundary while debugging. |
| 7 | Why does a webview never hold the auth token, and what does it hold instead? |
| 3 | Register a host op that only the extension host can answer. |
| 5 | Override a shared op with a host-specific implementation and have it win. |
| 2 | Broadcast a host push to every attached webview realm. |
| 7 | Receive engine events in a webview and dispatch them through my client. |
| 4 | Mirror a piece of host-only state into every realm as a retained topic. |
| 9 | Why must a mirrored value be a level and not an edge? **(trap)** |
| 9 | My webview panel shows "waiting for connection" while the status bar says connected. **(trap)** |
| 8 | Keep monitor subscriptions correct when two webviews subscribe to the same key. **(trap)** |
| 9 | Why does calling `clearAllMonitors()` from a webview throw, and what do I call? |
| 7 | Write a file to the cloud store from a webview and prove the bytes arrived intact. |
| 3 | Read a file's bytes from a webview — the supported path and the one that refuses. |
| 9 | Get the API key inside a webview, and explain why it is not an accessor. |
| 0 | Package the extension into a VSIX and verify the readme images resolve. |
| 0 | Which docs must change when I alter the extension's user-visible surface? |
| 2 | Debug a webview that boots blank with no console error. |
| 8 | Make a webview survive a reload without re-running the user's last command. **(trap)** |
| 2 | Keep the extension's dirty-close policy intact when adding a new editor surface. |
| 0 | Run the extension's tests through the builder rather than directly. |
| 3 | Reproduce a bug that only happens in the bridged realm, not in the browser. |
| 7 | Profile the engine from inside VS Code and read the result. |
| 3 | Add a setting to the extension and read it from both the host and a webview. |

## AB. Browser-based development — avg 7.3

| Score | Question |
| --- | --- |
| 7 | Run the browser shell locally and load my app into it without deploying. |
| 8 | Point the shell at a local app bundle while everything else stays remote. |
| 8 | My app loads in the App Builder preview but not in the deployed shell — why? |
| 8 | Diagnose a blank preview — the module-federation checklist end to end. |
| 8 | Why does the browser shell have one realm while VS Code has several? |
| 7 | My code works in the browser and fails in VS Code — name the three likely causes. **(trap)** |
| 9 | A module singleton shared between my two mounts works in the browser only. **(trap)** |
| 7 | Register a micro-frontend remote and have the shell resolve it at runtime. |
| 9 | Pin my app to a specific registry version in the browser for testing. |
| 4 | Override an app's entry URL locally without touching the registry. |
| 9 | Embed external web content in my app and bridge messages to it safely. |
| 9 | Seed the theme into an embedded iframe so it does not flash unstyled. **(trap)** |
| 10 | What answers the iframe bridge's ready message, and what is in the reply? |
| 5 | Why are early iframe events dropped rather than queued? |
| 9 | Make my app's sidebar carry its own brand instead of the platform wordmark. |
| 1 | Hide the platform announcements ticker in my app, and explain the opt-in direction. |
| 8 | Keep my app's layout correct when the shell sidebar collapses. |
| 10 | Persist a small UI preference so it survives a reload. |
| 10 | Store an opaque per-app blob and explain the two-phase startup around it. |
| 10 | Tell the difference between seeded and loaded workspace state, and why it matters. |
| 6 | React to the user switching orgs without leaving stale data on screen. |
| 4 | Handle a Stripe return URL correctly from a realm that has no web origin. **(trap)** |
| 6 | Open a checkout session from my app and resume cleanly afterwards. |
| 5 | Read the shell's runtime config and branch on a host capability. |
| 3 | Detect that my app is running inside a dev preview and behave accordingly. |
| 9 | Make my app work when the user is unauthenticated but the shell is up. |
| 9 | Build a grid whose paging and sorting happen server-side. |
| 10 | Refetch the current page of a grid after a mutation. |
| 9 | Supply a grid's rows from a real SDK call rather than an invented client method. **(trap)** |
| 6 | Choose between the local and remote grid modes for 50,000 rows. |
| 8 | Make my app's status bar reflect engine liveness without polling. |
| 2 | Profile a browser app whose first paint is slow. |

## AC. Shell bus, realms & the client — avg 6.6

| Score | Question |
| --- | --- |
| 10 | Explain the three bus lanes and pick the right one for a fact, a request, and a notification. |
| 10 | A panel is empty until I switch tabs and back — which lane did I choose wrongly? **(trap)** |
| 10 | Publish state that a subscriber mounting later receives immediately. |
| 10 | Why does a retained topic have exactly one publisher, and what breaks with two? |
| 10 | Send a request between a tool's mounts and get a typed reply. |
| 10 | Declare a tool's op vocabulary once so both ends type-check against it. |
| 9 | Why does a reply exist only when the caller stamped a correlation id? |
| 9 | A reply never arrives because the caller closed — what should my code do? |
| 9 | Why are tool calls never retained, and what would break if they were? **(trap)** |
| 10 | Register two handlers for the same op name — what happens? |
| 7 | Make a host-specific handler take precedence over a shared one. |
| 10 | A request timed out — is it safe to retry? **(trap)** |
| 3 | Summon a dormant realm by addressing an op it owns. |
| 10 | Explain what a realm is, and how many engine sockets exist per host process. **(trap)** |
| 10 | Get a working RocketRide client inside a VS Code webview. |
| 8 | What is the one method the realm client overrides, and why that one? |
| 3 | Why is `request()` the chokepoint rather than `call()`? **(trap)** |
| 10 | Call a brand-new SDK method from a webview with no brokering change. |
| 10 | Call an SDK namespace method (`client.deploy.*`) from a realm. |
| 5 | Catch an `AuthenticationException` thrown by a call made from a webview. **(trap)** |
| 5 | Why does `instanceof` still work on an error that crossed a process boundary? |
| 0 | An error class the registry does not know crosses the bus — what arrives? |
| 5 | Write bytes to a file from a realm and explain which member carries them. **(trap)** |
| 0 | Why would unframed bytes silently corrupt a file written from a webview? **(trap)** |
| 0 | Which DAP member may be binary, and how many are there? |
| 2 | Read a file's bytes in a realm — what refuses, and what is the supported route? |
| 3 | Set a request timeout and explain why the bus limit must outlast it. **(trap)** |
| 9 | Why does the realm client refuse `connect()` and `disconnect()`? |
| 7 | Add a monitor from a realm and explain why it cannot run locally. **(trap)** |
| 4 | Two realms monitor the same key — what keeps one from cancelling the other? |
| 5 | Receive engine events in a non-root realm and have `onEvent` fire. |
| 2 | Why are engine events broadcast rather than requested? |
| 5 | Why are events not retained, when connection status is? **(trap)** |
| 1 | An account-refresh event updates my realm client's accessors — how? |
| 10 | Tell the three states of `useConnectionReady` apart and render each correctly. **(trap)** |
| 10 | `client` is null in my realm — is that disconnected, or something else? **(trap)** |
| 10 | Re-publish controller state after a reconnect, and explain what shows if I do not. |
| 2 | Where do the shell's own host ops live versus the host app's, and why two places? |
| 1 | Add a new shell-served host op without adding a registration line at the bootstrap. |
| 10 | Why should I never add a `client.*` passthrough op for an SDK method? **(trap)** |

## AD. Advanced app development — avg 6.9

| Score | Question |
| --- | --- |
| 10 | Scaffold a new app the only supported way, from an agent and from a human. **(trap)** |
| 10 | Install the client into my app from the right source — and never from where? **(trap)** |
| 7 | Reserve an app id and understand what `local.*` means. |
| 10 | Declare a settings page for my app from the manifest alone. |
| 10 | Package an extra directory into my app's bundle. |
| 5 | Add a second top-level screen zone and keep the layout responsive. |
| 9 | Give my app multiple documents with split panes. |
| 10 | Build a tab strip whose panels keep their state when hidden. |
| 5 | Drive my app entirely from the manifest so the shell needs no code change. |
| 10 | Deploy a version, then publish it to my team without rebuilding. |
| 10 | Roll back to a previous version by moving a pointer. |
| 10 | Explain why users still see the old version after a deploy. **(trap)** |
| 9 | Check my app's Package-tab readiness from a script. |
| 9 | Submit my app for store review and read the build log on rejection. |
| 10 | Reply to a store reviewer from code. |
| 3 | Register as a developer and check my payout status. |
| 9 | Price my app and validate a promo code before checkout. |
| 9 | Show a credit balance and purchase a top-up from inside my app. |
| 9 | Cancel and upgrade a subscription, and explain which needs a new price id. |
| 2 | List every app the current user can reach, and which call is the real catalog. **(trap)** |
| 3 | Why is the account list not the app catalog? **(trap)** |
| 1 | Page the marketplace catalog and filter it client-side, explaining why. |
| 4 | Add an app to the user's desktop and reflect its status live. |
| 9 | Build an app that embeds a pipeline and streams its output into a grid. |
| 10 | Pass configuration into an embedded pipeline without committing a secret. |
| 9 | Run a pipeline on behalf of a user and attribute the cost correctly. |
| 8 | Show a run's live trace inside my app. |
| 9 | Build a dashboard from the engine's own dashboard call and keep it current. |
| 8 | List connections and tasks, and terminate a runaway task from my app. |
| 7 | Query the SQL surface from an app and page the results. |
| 1 | Add an app that talks to its own private protocol server rather than the engine. |
| 7 | Keep my own socket polling while the shell connection is down. **(trap)** |
| 0 | Write my app's docs in the right place, and explain the two exceptions. **(trap)** |
| 0 | Which docs must change when I alter a public SDK signature? |
| 1 | Freeze the shell contract after adding an app-facing hook. |
| 5 | Diagnose an app that works for me and fails for a teammate on another team. |
