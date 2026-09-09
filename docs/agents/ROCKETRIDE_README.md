# RocketRide — Start Here

RocketRide is a platform for building **AI solutions**, and a solution usually has
three layers:

- An **app** — the UI a person actually touches, built with the platform's React
  shell and stock UI components, running in RocketRide Cloud or VS Code.
- One or more **pipelines** — the intelligence: portable `.pipe` JSON files that
  wire pipeline components (parsers, LLMs, vector stores, agents, tools) into
  executable dataflows on a RocketRide server.
- **Pipeline components (nodes)** — the 150+ capabilities pipelines compose:
  13+ LLM providers, vector/graph/relational stores, OCR, transcription,
  vision, PII handling, agents, and a large tool ecosystem.

You can build any layer alone — a script driving a pipeline is a complete
project — but the platform's leverage is the combination: an app that embeds a
pipeline, streams its output, and ships through the built-in store.

## What is in this workspace

| Path | What it is |
|---|---|
| `.rocketride/docs/` | This documentation set |
| `.rocketride/services-catalog.json` | Index of every available pipeline component (name, class, description, lanes) |
| `.rocketride/schema/<name>.json` | Full config schema per pipeline component — the ground truth for configs |
| `.rocketride/shell/` | The vendored platform package apps compile against (`shell.tgz`, typings) |
| `./apps/` | App projects (each scaffolded by the App Builder) |
| `./pipelines/` | Standalone `.pipe` files |
| `.env` | Connection settings (`ROCKETRIDE_URI`, `ROCKETRIDE_APIKEY`) — gitignored, auto-populated when you connect to a server |

## Task router — what to read for the job at hand

| You are asked to… | Read |
|---|---|
| Understand how the pieces fit together | ROCKETRIDE_CONCEPTS.md |
| Build or modify a pipeline | ROCKETRIDE_CONCEPTS.md → ROCKETRIDE_PIPELINES.md → ROCKETRIDE_COMPONENT_REFERENCE.md |
| Pick or configure a pipeline component | ROCKETRIDE_COMPONENT_REFERENCE.md (+ the catalog and schemas above) |
| Drive a pipeline from Python or TypeScript | your language's API doc, §Pipeline execution |
| Build or modify an app | ROCKETRIDE_CONCEPTS.md → ROCKETRIDE_APPS.md → your language's API doc §Apps |
| Use a specific UI component (grid, chat, forms…) | ROCKETRIDE_UI_COMPONENTS.md |
| Wire an app to a pipeline | ROCKETRIDE_APPS.md §Embedding pipelines |
| Connect the outside world (MCP, n8n, webhooks, Telegram, CI) | ROCKETRIDE_INTEGRATIONS.md |
| Deploy, publish, or schedule anything | ROCKETRIDE_CONCEPTS.md §Artifact lifecycle → API doc §Deploy |
| Store or fetch files, templates, recorded runs | API doc §Cloud file store / §Templates & run logs |
| Consume runtime events, build monitoring | ROCKETRIDE_OBSERVABILITY.md |
| Debug a failing pipeline or app | the Pitfalls sections of ROCKETRIDE_PIPELINES.md / ROCKETRIDE_APPS.md |

The API docs are `ROCKETRIDE_python_API.md` and `ROCKETRIDE_typescript_API.md`;
they share the same section skeleton, so any `§` reference works in both.

## Mandatory setup for a new project

0. **A bare folder becomes a workspace with `rocketride init`** — it signs
   in (writing `.env`), syncs the services catalog + schemas, vendors the
   platform packages into `.rocketride/`, installs this documentation set,
   and gitignores `.rocketride/` + `.env`. Idempotent — re-run any time to
   refresh everything against the connected server. If the workspace
   already has `.rocketride/docs/` and a populated `.env`, init has run.
1. **Install the SDK**: `pip install rocketride` or `npm install rocketride`.
   **App development additionally requires pnpm** — the App Builder's
   install and watch tooling runs pnpm, never npm — and new apps are
   always created through the scaffold (agents: `deploy.createApp` via the
   API; humans: the App Builder's New App wizard), never by hand. The
   client to call comes from the workspace's own `.rocketride/client/
   rocketride.tgz`, vendored at boot — never the npm registry
   (ROCKETRIDE_APPS.md §Creating an App).
2. **Connection settings live in `.env`, maintained by the platform** — up
   to two pairs: `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` (the development
   server: run, validate, iterate) and `ROCKETRIDE_DEPLOY_URI`/
   `ROCKETRIDE_DEPLOY_APIKEY` (the deployment target: deploy, publish,
   schedule). Never construct auth flows; when credentials are rejected,
   `rocketride login` re-authenticates and rewrites the pair. Build
   clients from the pair that matches the job (ROCKETRIDE_CONCEPTS.md
   §Credentials). Keep `.env` gitignored (init, login, and the extension
   all enforce this); commit a `.env.example` with empty values instead.
3. **Pipelines use the `.pipe` extension** and are JSON — see
   ROCKETRIDE_PIPELINES.md before writing one.
4. **Write a check script** (`check.py` / `check.ts`) that connects, validates
   the project's pipeline, and reports clearly — it is the fastest way to prove
   the project is healthy after any change. Keep such scripts IN the
   workspace and run them from its root — Node resolves the installed
   `rocketride` package from the workspace's `node_modules`, so a script
   run from a temp directory outside it cannot import the client. Shell
   working directories persist between commands in most agent harnesses:
   `cd` explicitly (or use absolute paths) rather than assuming each
   command starts fresh at the root.

## The one rule

Never invent pipeline component names, config fields, or SDK methods. The
catalog, the schemas, and these docs are the ground truth — if it is not in
them, verify before using it.
