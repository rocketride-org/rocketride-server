# RocketRide User Task Battery — 256 Acceptance Questions

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

Scored against ONLY `docs/stubs/CLAUDE.md` and the ten files it references in
`docs/agents/`. No source code, no shell.d.ts, no prior product knowledge was
used. Pass history: 7.7 (first), 9.0 (second, after UI_COMPONENTS /
INTEGRATIONS / Patterns 16–29), 9.0 (this pass — see below).

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
touches lightly, so the headline barely moves (2295 → 2307 points) — but they
close the last workflow gaps: scripted app deploys, dev-vs-deploy targeting,
and hand-rolled app scaffolds.

Each question's leading number is replaced by a score `[n]` on a 0–10 scale:
how completely and accurately the delivered docs alone answer it.

| Score | Meaning |
| --- | --- |
| 10 | Fully answered: complete, accurate, directly actionable from the docs |
| 7–9 | Answerable with minor gaps (a detail, an example, or an edge missing) |
| 4–6 | Partially answered: the concept or API is present but key steps must be guessed or composed from fragments |
| 1–3 | Barely touched: named or implied, not actionable |
| 0 | Not covered at all |

### Category summary

| Category | Avg | Prev | Δ | Items |
| --- | --- | --- | --- | --- |
| A. Setup, connection & workspace | 8.7 | 8.1 | +0.6 | 12 |
| B. Pipeline grammar & wiring | 9.1 | 9.1 | — | 14 |
| C. Pipeline recipes by use case | 9.0 | 9.0 | — | 28 |
| D. Driving pipelines from code | 8.8 | 8.8 | — | 18 |
| E. Chat, Question & streaming | 9.1 | 9.1 | — | 8 |
| F. Files, cloud store & templates | 8.6 | 8.6 | — | 14 |
| G. Events, monitoring & run logs | 8.6 | 8.6 | — | 14 |
| H. Deploying & scheduling pipelines | 9.4 | 9.3 | +0.1 | 14 |
| I. App structure & layout | 9.6 | 9.5 | +0.1 | 14 |
| J. App UI components | 9.8 | 9.8 | — | 16 |
| K. App hooks, state, theming & styles | 9.5 | 9.5 | — | 12 |
| L. App + pipeline integration | 9.2 | 9.2 | — | 10 |
| M. App dev loop & debugging | 8.3 | 8.3 | — | 8 |
| N. App packaging, publish, store & review | 9.3 | 9.3 | +0.1 raw | 16 |
| O. Account, orgs, teams, keys & env | 8.8 | 8.8 | — | 12 |
| P. Billing & plans | 7.3 | 7.3 | — | 6 |
| Q. Dashboard & operations | 7.8 | 7.8 | — | 6 |
| R. Database & SQL | 9.8 | 9.8 | — | 4 |
| S. CLI | 9.4 | 9.4 | — | 8 |
| T. MCP & external integrations | 10.0 | 10.0 | — | 6 |
| U. Observability ingestion | 9.3 | 9.3 | — | 6 |
| V. Performance profiling | 9.0 | 9.0 | — | 2 |
| W. Troubleshooting | 8.1 | 8.0 | +0.1 | 8 |
| **Overall** | **9.0** | **9.0** | **+12 pts** | **256** |

Items that moved this pass: workspace setup [8→9], cloud connect/sign-in
[6→8] (the two-pair contract removes auth-flow guesswork), API-key handling
[8→9], dev-vs-cloud switching [7→9], headless auth [9→10], two-team configs
[7→8] (deploy-server env-layer rule), wizard/scaffold [9→10], app-id
reservations [8→9] (`local.*` now documented), Package-tab readiness [8→9]
(`verifyApp` mirrors it scriptably), blank-preview diagnosis [6→7] (the
scaffold section now names the failure symptoms and their causes in one place).

Remaining items at 5 or below: store size/quota limits [2], per-user vs
per-app storage path conventions [4], `.pipe` git/team sharing [5], invoking a
single node capability without a pipeline [5], what counts against billing
quota [5]. Weakest categories: P. Billing & plans (7.3) and Q. Dashboard &
operations (7.8).

---

## A. Setup, connection & workspace — avg 8.7

| Score | Question |
| --- | --- |
| 9 | Set up a brand-new RocketRide workspace from an empty folder — what goes where? |
| 8 | Connect my workspace to RocketRide Cloud and sign in. |
| 8 | Connect to my self-hosted engine at ws://myserver:5565 instead of the cloud. |
| 9 | Where does my API key come from, and how do I keep it out of git? |
| 9 | Switch my project between a local dev server and the cloud without editing code. |
| 10 | Authenticate a headless script with an API key instead of a browser login. |
| 7 | Log in from a TypeScript app with OAuth/PKCE and log out cleanly. |
| 9 | Reconnect automatically when the server drops, and surface connection state in my app. |
| 10 | Use environment-variable substitution (`${ROCKETRIDE_APIKEY}`) inside a `.pipe` file. |
| 9 | What is the `.rocketride/` folder in my workspace, and which parts may I edit? |
| 9 | Check what server version and features I'm connected to. |
| 7 | Write a check script that proves my project's connection and pipeline are healthy. |

## B. Pipeline grammar & wiring — avg 9.1

| Score | Question |
| --- | --- |
| 10 | Create my first `.pipe` file by hand — the minimal valid structure and required field order. |
| 10 | What are lanes, and how do I know which two nodes can connect? |
| 9 | Wire one parser's output into two different consumers. |
| 10 | What's the difference between a source node and a processing node — and which sources exist? |
| 8 | Configure a node with profiles vs inline config — when is each right? |
| 10 | Override one field of a built-in profile without redefining the whole thing. |
| 10 | Discover every available node and its config options from my workspace. |
| 9 | Read a node's schema to learn required vs optional config fields. |
| 10 | Attach a tool node to an agent — why doesn't that connection use lanes? |
| 10 | Build a sub-pipeline invoked as a tool (`tool_pipe`) and the ownership rules it must obey. |
| 10 | Why is my sub-pipeline rejected as "reachable from two control roots"? |
| 7 | Position and hide nodes with the `ui` block — does layout affect execution? |
| 9 | Validate a pipeline without running it, and interpret the validation errors. |
| 5 | Version my `.pipe` files in git and share them with my team. |

## C. Pipeline recipes by use case — avg 9.0

| Score | Question |
| --- | --- |
| 9 | Drop any file — PDF, DOCX, image, audio, video — and get its text back. |
| 8 | Classic RAG: chunk documents, embed, store in Qdrant, answer questions with citations. |
| 7 | Swap the vector store: the same RAG on Pinecone, Milvus, Weaviate, or Chroma. |
| 10 | Use Postgres as my vector store instead of a dedicated engine. |
| 9 | OCR scanned documents and photos of documents. |
| 10 | Parse with LlamaParse, Landing.AI, or Reducto instead of the built-in parser — when and why? |
| 8 | Transcribe audio files and answer questions about what was said. |
| 10 | Text-to-speech: generate spoken audio with ElevenLabs or OpenAI TTS and return it. |
| 10 | Grab frames from a video and describe them with a vision LLM. |
| 10 | Video understanding and search with TwelveLabs. |
| 9 | Detect and anonymize PII before anything hits storage. |
| 7 | Extract named entities (people, orgs, places) from documents. |
| 7 | Summarize long contracts and extract their key facts. |
| 10 | Extract structured JSON from invoices and validate it against a schema. |
| 10 | Put guardrails on LLM output before it reaches the user. |
| 9 | A chat pipeline with conversation memory — internal vs persistent memory. |
| 8 | Long-term user memory across sessions with mem0. |
| 8 | Swap the LLM provider (OpenAI → Anthropic → Gemini → local Ollama) with a one-line change. |
| 8 | Which model should I use for quality vs speed vs cost — current guidance. |
| 10 | Vision Q&A over images (GPT-4o vision, Gemini, Mistral, Ollama). |
| 10 | Batch image cleanup: background removal and thumbnail generation. |
| 10 | Pose estimation or depth estimation over an image set. |
| 7 | Build a knowledge graph from documents (Neo4j / FalkorDB) and query it. |
| 10 | GraphRAG with Cognee. |
| 10 | A web-research pipeline: Exa/Tavily search plus Firecrawl scraping, synthesized by an LLM. |
| 10 | A crew of agents: CrewAI manager delegating to subagents. |
| 7 | agent_rocketride vs CrewAI vs LangChain vs LlamaIndex vs DeepAgent — pick one and wire it. |
| 10 | An agent that can safely run Python code as a tool. |

## D. Driving pipelines from code — avg 8.8

| Score | Question |
| --- | --- |
| 9 | Run a `.pipe` from a Python script and wait for the result. |
| 10 | Run a pipeline object from a browser app, where file paths don't exist. |
| 9 | Reuse an already-running pipeline instead of starting a new one (`useExisting`) — exact semantics. |
| 10 | Pass runtime arguments into a pipeline (`args`). |
| 9 | Set a TTL so an idle pipeline shuts itself down. |
| 9 | Send a text payload into a running pipeline and receive the response. |
| 8 | Upload many files with bounded concurrency and per-file progress. |
| 10 | Stream data chunks into a running pipeline (DataPipe open/write/close). |
| 9 | Poll task status and distinguish queued vs running vs finished vs failed. |
| 9 | Get a running task's token and reattach to it from another process. |
| 9 | Retrieve the exact pipeline definition a running task is executing. |
| 9 | Restart a task with a modified pipeline. |
| 9 | Terminate a running pipeline cleanly. |
| 6 | Process a large document set concurrently — threads and throughput guidance. |
| 5 | Invoke a single node's capability directly without authoring a pipeline. |
| 10 | List available services and fetch one service's definition programmatically. |
| 8 | Handle the SDK exception hierarchy and retry transient failures sensibly. |
| 10 | Why does my long CPU-bound loop kill the websocket after ~60 seconds, and how do I fix it? |

## E. Chat, Question & streaming — avg 9.1

| Score | Question |
| --- | --- |
| 10 | Ask a one-shot question to a chat pipeline and print the answer. |
| 10 | Stream tokens live (SSE) into my UI as the model generates. |
| 9 | Build a multi-part Question with system instructions. |
| 10 | Get the answer back as structured JSON (`expectJson`). |
| 8 | Restrict which documents the chat searches with a filter. |
| 8 | Keep conversation context across multiple chat calls to the same task. |
| 9 | Route follow-up questions from different browser tabs to the same running chat. |
| 9 | `response_answers` vs `response_text` — which do I wire, and why? |

## F. Files, cloud store & templates — avg 8.6

| Score | Question |
| --- | --- |
| 10 | Write pipeline results to the cloud file store and read them back later. |
| 10 | List a store directory and stat individual files. |
| 10 | Read and write JSON objects to the store without manual serialization. |
| 10 | Fetch many store files in one round trip. |
| 10 | Rename, move, and delete files; create and remove directories. |
| 10 | Get a download URL I can hand to a browser. |
| 9 | Stream a large store file without loading it all in memory. |
| 9 | Save a pipeline as a reusable template; list, apply, and delete templates. |
| 10 | Where do dropper-uploaded files land, and how do I fetch them afterward? |
| 10 | Return a generated artifact (say, TTS audio) to my app's user as a download. |
| 2 | What are the store's size and quota limits? |
| 9 | Share store files between my app and my pipelines. |
| 4 | Organize storage per-user vs per-app — path conventions. |
| 7 | Clean up old artifacts programmatically. |

## G. Events, monitoring & run logs — avg 8.6

| Score | Question |
| --- | --- |
| 10 | Subscribe to every event from one task. |
| 9 | Monitor all my tasks at once, dashboard-style. |
| 10 | Choose event types (TASK/SUMMARY/FLOW/OUTPUT/SSE/DETAIL) — what each carries. |
| 9 | Stop monitoring cleanly when my component unmounts. |
| 9 | Migrate off the deprecated `setEvents` to monitors. |
| 8 | Identify my client connection — why and when it matters. |
| 8 | Show a live pipeline-progress graph from per-node FLOW events. |
| 9 | Record a run and replay it later (the run-log DVR). |
| 9 | List and delete recorded run logs. |
| 9 | Seek inside a recorded run — chapters and segments. |
| 8 | Choose a pipeline trace level — detail vs cost. |
| 8 | Capture full debug output for one run. |
| 9 | Update my app's UI from platform events — shell events vs task monitors, which for what? |
| 6 | Alert me (or call my webhook) when any pipeline errors. |

## H. Deploying & scheduling pipelines — avg 9.4

| Score | Question |
| --- | --- |
| 10 | Deploy a pipeline to the server so it runs without my machine. |
| 10 | Deploy v2 of a pipeline, list versions, and see what each contains. |
| 10 | Point my team at version N; roll back to N−1 without rebuilding. |
| 10 | Run a deployed pipeline on demand. |
| 10 | Schedule a deployed pipeline to run Monday/Wednesday/Friday from 08:00 to 15:00. |
| 10 | Pause a schedule for the holidays and resume it — without losing the cron. |
| 10 | Set per-source trace and debug settings that ride every scheduled run. |
| 8 | See the run history of a deployment. |
| 7 | Preview what a deployed source will do before running it. |
| 10 | Disable, enable, and remove a deployment. |
| 8 | Deploy the same pipeline for two teams with different configurations. |
| 9 | What is a sourceId — schedule two sources of one project independently. |
| 9 | Download the artifact of a deployed version. |
| 10 | Guarantee a scheduled run always ends by a wall-clock time. |

## I. App structure & layout — avg 9.6

| Score | Question |
| --- | --- |
| 10 | Create a new app with the App Builder wizard — what the templates give me. |
| 10 | The anatomy of a scaffolded app — what each of the ten files is for. |
| 10 | Every `appManifest` field, explained — id, publisher, categories, mode, authenticated, and the rest. |
| 9 | Choose my app id — why `<developer>.<name>` matters and what's reserved. |
| 10 | Add a sidebar to my app with AppLayout. |
| 9 | Turn on the bottom status bar and know what it shows. |
| 10 | Put my own content in the status bar. |
| 9 | A multi-view app: sidebar navigation that switches content panes. |
| 10 | A file-editor app using the Documents system — tabs, explorer, split views. |
| 10 | Persist my app's UI state across reloads. |
| 9 | Ship and render my app's icon correctly. |
| 9 | What are my app's props (`isConnected`, `identity`) and when do they change? |
| 10 | Expose a second component from my app for others to embed. |
| 10 | Embed a component from another app into mine. |

## J. App UI components — avg 9.8

| Score | Question |
| --- | --- |
| 10 | What stock components exist, and where do I browse them? |
| 10 | A data table with sorting, filtering, and pagination over live data. |
| 8 | A card-grid view with a filter strip as an alternative to the table. |
| 10 | A full chat UI wired to a chat pipeline. |
| 10 | Render LLM/markdown output safely — including images and charts. |
| 10 | A file drop zone — styling, multiple files, accepted types. |
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

## K. App hooks, state, theming & styles — avg 9.5

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
| 10 | Embed external web content in an iframe that follows the platform theme. |

## L. App + pipeline integration — avg 9.2

| Score | Question |
| --- | --- |
| 10 | Import a `.pipe` file into my app's code and start it (including the type declaration). |
| 9 | Start the pipeline on connect, keep its token in state, and survive hot reload. |
| 9 | Send dropped files through a pipeline and render the returned text. |
| 8 | Show live progress while the pipeline processes a file. |
| 10 | Stream a chat answer token-by-token into my chat component. |
| 7 | Run two different pipelines in one app and keep their tokens straight. |
| 9 | Ship pipelines inside the app package — how packaging embeds them, and why they can't be scheduled. |
| 10 | One shared pipeline task for all users vs a task per user — how to choose and implement. |
| 10 | Show a useful error state when the pipeline fails mid-run. |
| 10 | Trigger a server-deployed pipeline from my app instead of embedding one. |

## M. App dev loop & debugging — avg 8.3

| Score | Question |
| --- | --- |
| 10 | Run my app live with watch — what triggers rebuild, reinstall, restart. |
| 9 | Preview at phone/tablet/desktop sizes; zoom and fit. |
| 9 | See my `console.log` output and runtime errors while developing. |
| 6 | Debug my app with breakpoints from VS Code. |
| 8 | The preview shows stale code — why, and the reload rules. |
| 7 | Test my app in dark, light, and VS Code themes before shipping. |
| 9 | Preview as my signed-in self vs as an anonymous user. |
| 8 | Use the component gallery: live demos, knobs, and copyable snippets. |

## N. App packaging, publish, store & review — avg 9.3

| Score | Question |
| --- | --- |
| 9 | Make the Package tab fully green — identity, icon, README, include paths. |
| 10 | Include a shared workspace folder in my app's package. |
| 9 | Deploy even with type errors — the typecheck waiver and its consequences. |
| 10 | Deploy my app to the server — what the server build does with my source. |
| 8 | Publish to myself and run it from the app rail. |
| 9 | Publish to my team. |
| 9 | Submit my app to the public store — what review involves. |
| 9 | Track review status and reply to reviewer feedback. |
| 10 | Withdraw a submission. |
| 9 | My server build failed — find the build log and fix the cause. |
| 10 | Ship an update: deploy v4, repoint the audience, roll back if it breaks. |
| 10 | Where is my app live right now — every rung, version, and state at a glance. |
| 9 | Register my developer id — namespace ownership rules for app ids. |
| 8 | Write the store listing: description, categories, and pricing plans. |
| 10 | Take a published app down — disable vs remove. |
| 10 | Test a specific published version in the browser via the version override. |

## O. Account, orgs, teams, keys & env — avg 8.8

| Score | Question |
| --- | --- |
| 9 | See my profile and which organization I'm operating in. |
| 8 | Switch organizations — what changes when I do. |
| 10 | Invite someone to my org; remove someone who left. |
| 9 | Create teams and use them as deploy audiences. |
| 10 | Create an API key for CI; revoke it later. |
| 9 | Set the org's OpenAI key once so every member's pipelines use it. |
| 9 | Layered environment secrets — org vs team vs user precedence. |
| 9 | Use server-side secrets in pipelines with no local `.env` at all. |
| 10 | What can members do vs admins? |
| 6 | A key leaked — rotate it everywhere, fast. |
| 9 | Read account info inside my app and react when it changes. |
| 7 | Make my app require sign-in (`authenticated: true`) — what the user experiences. |

## P. Billing & plans — avg 7.3

| Score | Question |
| --- | --- |
| 8 | See my current plan and usage. |
| 8 | Upgrade my plan from inside the product. |
| 5 | What counts against my quota — tasks, tokens, storage? |
| 9 | Define paid plans for my own store app. |
| 6 | How do my app's subscribers get billed, and how are entitlements enforced? |
| 8 | Manage invoices and payment methods. |

## Q. Dashboard & operations — avg 7.8

| Score | Question |
| --- | --- |
| 7 | What's running right now across my org? |
| 9 | Who's connected to my server? |
| 8 | Kill a stuck task from an ops script. |
| 8 | Watch fleet-wide activity with the dashboard event feed. |
| 9 | Build a health/usage panel into my own admin app. |
| 6 | How long is task history retained, and where do old runs go? |

## R. Database & SQL — avg 9.8

| Score | Question |
| --- | --- |
| 10 | Run SQL from my app through the platform's database client. |
| 10 | Wrap multiple statements in a transaction with commit/rollback. |
| 9 | Query pipeline results that a `db_postgres` node stored. |
| 10 | When do I use a relational store vs a vector store vs a graph store? |

## S. CLI — avg 9.4

| Score | Question |
| --- | --- |
| 10 | Start a pipeline from the terminal. |
| 10 | Upload files to a running task from the terminal. |
| 10 | Check status and stop a task from the terminal. |
| 9 | List my running tasks from the terminal. |
| 10 | Browse the cloud store from the terminal. |
| 7 | Upload, download, and delete store files from the terminal. |
| 9 | Follow a task's events from the terminal. |
| 10 | Use the CLI in CI to smoke-test a deployed pipeline. |

## T. MCP & external integrations — avg 10.0

| Score | Question |
| --- | --- |
| 10 | Expose my pipelines as MCP tools so Claude/Cursor can call them. |
| 10 | Control which pipelines become tools and how they're described to the model. |
| 10 | Call RocketRide from an n8n workflow. |
| 10 | Trigger a pipeline from an external system's webhook — including auth. |
| 10 | Put a Telegram bot in front of a pipeline. |
| 10 | Call my own HTTP API from the middle of a pipeline. |

## U. Observability ingestion — avg 9.3

| Score | Question |
| --- | --- |
| 10 | Build an external service that ingests all platform events. |
| 9 | Authenticate a headless monitoring daemon. |
| 9 | Which event payload schemas are stable enough to parse? |
| 9 | Capture run lifecycle reliably across my daemon's reconnects. |
| 9 | Live ingestion vs DVR replay — when is each the right source? |
| 10 | Feed events into my own metrics database — the recommended ingester shape. |

## V. Performance profiling — avg 9.0

| Score | Question |
| --- | --- |
| 9 | Profile the server-side performance of my pipeline. |
| 9 | Read the profile tree and find the slow node. |

## W. Troubleshooting — avg 8.1

| Score | Question |
| --- | --- |
| 7 | "Component not found" when opening my pipeline — diagnose it. |
| 9 | Two nodes won't connect — read the lane mismatch and fix the wiring. |
| 8 | The pipeline starts but nothing happens — the source-node config checklist. |
| 7 | My app preview is a blank screen — the module-federation checklist. |
| 9 | I deployed v3 but users still see v2 — version vs binding, untangled. |
| 10 | Login loops forever in my app preview — the auth checklist. |
| 8 | Events stop arriving after a few minutes — keepalive and blocking causes. |
| 7 | A scheduled run failed overnight — which log has the answer, build vs run. |
