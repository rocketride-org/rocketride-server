# MCP Module (`ai.modules.mcp`)

Contributor notes for the engine's built-in HTTP MCP server. The public doc —
endpoint, auth, setup, the tool surface — lives in `docs/public/mcp/http/`
(site page `/connect/mcp/http`); this page covers only what a contributor
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

Every client connects to one engine URI, resolved once in `initModule` by
`_resolve_engine_uri` (which also feeds the widget CSP origin and the
upload/dropper links): explicit `rocketride_uri` / `ROCKETRIDE_URI` wins;
otherwise a loopback bind uses this engine's own `ws://127.0.0.1:<port>`, and
any other bind uses the `MCP_RESOURCE_IDENTIFIER` origin as `wss://`/`ws://`.

That URI must be encrypted **when it addresses a remote engine**: the caller's
own credential rides the first DAP `auth` frame, so a `ws://`/`http://` URI
pointing at a non-loopback host fails boot with a message naming the value and
the variable it came from. The rule keys on the TARGET host, never on the bind,
and every resolved value goes through it — explicit or derived, on any bind. A
loopback-bound engine pointed at `ws://engine.remote:5565` still puts the
credential on the network, so the bind excuses nothing. `ws://127.0.0.1:5565`
or `http://localhost:5565` is kept whatever the bind, because that credential
never reaches a wire anyone can tap (and the shipped `dist/server/.env` carries
exactly such a value into the engine image).

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
