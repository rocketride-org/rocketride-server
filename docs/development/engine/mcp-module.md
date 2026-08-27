# MCP Module (`ai.modules.mcp`)

Contributor notes for the engine's built-in HTTP MCP server. The public doc —
endpoint, auth, setup, the tool surface — is `docs/public/mcp/http/README.md`
(site page `/protocols/mcp/http`); this page covers only what a contributor
needs that lives nowhere else. Deep design history: `git log` on
`packages/ai/src/ai/modules/mcp/`.

## Where it lives and how it loads

`packages/ai/src/ai/modules/mcp/` is a first-class engine module, loaded at
boot via `server.use('mcp')` in `packages/ai/src/ai/eaas.py` and mounted at
`/mcp` on the engine web server — no separate process. The test suite is
`packages/ai/tests/ai/modules/mcp/`; run it with `./builder ai:test` or
`python -m pytest packages/ai/tests/ai/modules/mcp/`.

## The engine-client seam

Tool and resource handlers never touch the WS/DAP SDK directly — they depend on
the `EngineClient` protocol in `engine.py`, so the transport is swappable (a
future in-process implementation replaces one file, not the tool code). A
request that carries its own credential (API key or verified OAuth JWT) gets a
fresh per-request client under that identity, closed when the request ends;
credential-less requests share one lazy singleton built from
`ROCKETRIDE_AUTH`/`ROCKETRIDE_APIKEY`.

## The credentials catalog and its builder gates

`credentials.json` (sibling to the module code) maps credential-shaped node
config fields to suggested `ROCKETRIDE_*` variable names; it powers the
integration-readiness tools. Two builder actions maintain it:

- `nodes:credentials-generate` — scans every node's `services*.json` for
  credential-shaped fields and reconciles them into the catalog (runs inside
  `nodes:build`, right after `nodes:docs-generate`). Human-curated entries are
  never overwritten; newly detected fields get a `review: true` stub.
- `nodes:credentials-check` — the drift gate. **A node with new credential
  fields fails this gate until the catalog covers them**; a `review: true` stub
  still awaiting curation only warns.

Variable *names* are all the catalog and the tools ever handle — values never
transit MCP.

## The widget workspace

MCP Apps widgets (running-pipelines table, dropper, trace viewer) are a vite
workspace embedded at `packages/ai/src/ai/modules/mcp/apps/`, registered as the
`mcp-widgets` builder module (`build`, `clean`, `test`).
`mcp-widgets:build` produces single-file HTML bundles into `apps/dist/` and is
sequenced **before** `ai:build` (see `packages/server/scripts/tasks.js`); the
server advertises the MCP Apps capability only when at least one built bundle
exists on disk.
