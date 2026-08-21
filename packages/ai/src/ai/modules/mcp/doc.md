<!-- Copyright 2026 Aparavi Software AG. MIT License. -->

# MCP module (`ai.modules.mcp`)

In-process **Streamable-HTTP MCP server**, registered as a first-class engine module
alongside `services`, `chat`, `dropper`, `clients`, `task`, `task_http`, and `shell`
(see `server.use('mcp')` in `packages/ai/src/ai/eaas.py`). It is fronted by `ai/web/`
like every other module and mounted at:

```text
/mcp
```

This module exposes a static, 28-tool RocketRide authoring/execution surface served
over HTTP from inside the running engine process — no separate process or transport
bridge required. It supersedes the earlier 2-tool port, which exposed a dynamic
per-pipeline `{filepath}` tool plus a `RocketRide_Document_Processor` convenience
tool; both are removed (see "History" below).

## Protocol

The mounted `StreamableHTTPSessionManager` serves **both** MCP protocol revisions on
the same `/mcp` endpoint, unconditionally — the SDK (`mcp>=2,<3`) inspects the
`MCP-Protocol-Version` request header per request and routes accordingly, with no
opt-in flag on our side:

- **`2026-07-28`** (current) — any request whose `MCP-Protocol-Version` header is
  present and is *not* one of the legacy handshake versions is routed to the modern
  per-request path (`mcp.server._streamable_http_modern`): no `initialize` handshake,
  no `Mcp-Session-Id`, one JSON-RPC request in, one JSON-RPC response out.
- **`2025-11-25`** (and `2024-11-05` / `2025-03-26` / `2025-06-18`) — a request with no
  `MCP-Protocol-Version` header, or one of those four handshake-era values, falls
  through to the legacy `initialize`-handshake path instead. Because this module runs
  `stateless=True`, the legacy path also stays stateless per request (a fresh
  transport per POST, no `Mcp-Session-Id` minted) — legacy clients still complete the
  full `initialize` → `notifications/initialized` → `tools/list`/`tools/call` sequence,
  they just get no session continuity across POSTs, same as the modern path.

  This dual-revision serving is what keeps a 2025-era client (Claude Desktop, Cursor,
  or any Streamable-HTTP client that hasn't shipped 2026-07-28 support yet) working
  against this endpoint without any server-side branching of our own — pinned by
  `packages/ai/tests/ai/modules/mcp/test_dual_revision.py`.

### Required request headers (2026-07-28 path only)

On the modern per-request path, the SDK validates two headers against the JSON-RPC
body and rejects a mismatch with `HEADER_MISMATCH` (`-32020`) before the request ever
reaches a handler — this module does not implement or override this check, it is
enforced entirely inside the SDK's inbound classifier:

| Header | Must equal | Applies to |
| --- | --- | --- |
| `Mcp-Method` | `body.method` | every request |
| `Mcp-Name` | the body's `name` (`tools/call`, `prompts/get`) or `uri` (`resources/read`) param | only `tools/call`, `prompts/get`, `resources/read` |

`MCP-Protocol-Version` is also checked at this rung: it must equal
`params._meta["io.modelcontextprotocol/protocolVersion"]` in the body, or the
request is rejected the same way.
Legacy-path requests (see above) are not subject to this header rung at all — it is
only exercised on the modern route.

### Cache-hint policy

`cache_policy.py` sets `ttl_ms`/`cache_scope` (wire: `ttlMs`/`cacheScope`, SEP-2549)
on every `CacheableResult` this module returns:

| Result | `ttl_ms` | `cache_scope` | Rationale |
| --- | --- | --- | --- |
| `tools/list` | `3_600_000` (1h) | `private` | Static per build, but kept private (not public) because tool listings become entitlement-filtered once node-auth lands. |
| `resources/list` | `30_000` (30s) | `private` | Near-static catalog (fixed descriptors plus whichever widget bundles are built), but cheap enough to refresh that it gets a short TTL rather than the 1h one. |
| `rocketride://status` read | `0` | `private` | Live connection/task-count snapshot — immediately stale, must not be cached at all. |
| `rocketride://pipelines` read | `30_000` (30s) | `private` | Reflects registered deployments (`deploy_list`) — changes on `deploy_add`/`deploy_update`/`deploy_remove`, not build-static. |

## How it boots

`initModule(server, config)` in `__init__.py`:

1. Builds a **lazy-singleton** `EngineClient` factory. The client is not constructed
   until the first MCP request, so a missing `ROCKETRIDE_URI`/`ROCKETRIDE_AUTH` does
   not crash engine boot — it only fails the first call.
2. Builds the low-level MCP `Server` (`handlers.build_mcp_server`) and wraps it in a
   **stateless** `StreamableHTTPSessionManager` (`event_store=None`, `json_response=False`,
   `stateless=True`).
3. Mounts the manager's raw ASGI handler at `/mcp` via `starlette.routing.Mount`
   (a raw ASGI callable, not a FastAPI route function).
4. Wires the session manager's `run()` lifespan into the app's startup/shutdown —
   directly via `app.router.add_event_handler` for the FakeServer/plain-FastAPI test
   double, and chained through `server._user_startup`/`_user_shutdown` for the real
   `WebServer`, whose custom `_lifespan` does not fire router events. Shutdown drains
   the session manager first (`_stack.aclose()`), then closes the shared `EngineClient`
   if one was ever created (`try`/`finally`, so each step happens regardless of whether
   the other raises).
5. Applies the auth seam (see below).

## Environment variables / config

| Name | Read by | Purpose |
| --- | --- | --- |
| `ROCKETRIDE_URI` | `engine.make_engine_client` | WS/DAP URI for the engine connection used by the v0 `EngineClient`. Required — missing it raises `ValueError` on first request. |
| `ROCKETRIDE_AUTH` | `engine.make_engine_client` | Auth token for the engine connection. Falls back to `ROCKETRIDE_APIKEY` if unset. One of the two is required. |
| `ROCKETRIDE_APIKEY` | `engine.make_engine_client` | Alternate name for the auth token; used only if `ROCKETRIDE_AUTH` is not set. |
| `MCP_DEV_NO_AUTH=1` | `__init__.initModule` | Dev-only bypass: marks `/mcp` as a public route so the engine's `AuthMiddleware` skips it. Equivalent to setting the `mcp_dev_no_auth` config key. Honored only when the server binds a loopback host (`localhost`/`127.0.0.1`/`::1`); on any other bind the bypass is ignored with a warning and `/mcp` stays authenticated. |

Config key `mcp_dev_no_auth` (bool, in the module `config` dict passed to `initModule`)
is the config-driven equivalent of `MCP_DEV_NO_AUTH=1`; either one enables the bypass.

## The 28 tools

Dispatch is registry-based: `tooling.ToolRegistry` holds `{name -> (description,
inputSchema, handler)}`; `tools/__init__.register_all(registry)` populates one shared
registry per server by calling each tool group's own `register(registry)`.
`handlers.build_mcp_server` builds that one registry plus one `registry.TaskRegistry`
and wires them into a single `mcp.server.lowlevel.Server('rocketride-mcp')` via the
`on_list_tools`/`on_call_tool`/`on_list_resources`/`on_read_resource` constructor
kwargs (the SDK v2 registration surface — the v1 `@server.list_tools()`-style
decorators were removed; see "Protocol" above). Every handler has the
signature `async def handler(client: EngineClient, tasks: TaskRegistry, args: dict) -> dict`.

All tools are static and typed (fixed name + JSON Schema) — there is no dynamic
per-pipeline tool generation and no `filepath`-shaped catch-all tool of the kind the
legacy 2-tool port used.

The 28 tools are organized into 8 groups (plus 2 resources), matching
`claude/tasks/http-mcp-tools-port/final-tool-surface.md` minus the Query group
(see History: the 3 convenience query tools were removed pending their cloud DB
backend), plus the Run log (DVR) group and `list_integrations` added below.

**Introspection (5)** — `tools/introspection.py` plus `tools/integrations.py`, read-only/static-analysis, no task tokens:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `list_components` | List pipeline components ready to use *now* — zero-config components plus integrations whose credentials are configured. Configured entries carry a `wiring` block of `${VAR}` placeholders; a `note` counts integrations omitted for needing setup. Call `list_integrations` for those. | none |
| `describe_component` | Full metadata/config schema for one component; catalog nodes also get a `credentials` block (same readiness vocabulary as `list_integrations`). | `name` (required) |
| `resolve_config` | What a component config resolves to at load, after the engine applies profile and default merging. Reports keys the resolver discarded, which a schema cannot express. | `provider` (required), `config` |
| `validate_pipeline` | Validate a pipeline against the engine's own rules (engine-authoritative, zero client-side drift). | `pipeline` |
| `describe_pipeline` | Statically describe a pipeline's source and components (id, provider, title, classType, inputs); synthesized client-side, no backing SDK method. | `pipeline` |
| `list_integrations` | Credential readiness for catalog integrations this engine has a matching node for. Bare call: terse per-integration rows (`name`/`title`/`status`/`missing_count`). With `name`: full field detail, `missing`, `candidates`, the caller's own variable names (`caller_variables`), and either `setup` (not configured) or `wiring` (configured). | `name` (optional) |

**Execution (4)** — `tools/execution.py`, token-based, no sessions:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `run_pipeline` | Start an inline pipeline, returning a `task_token`; optionally send `inputs` in the same call and get a result back. | `pipeline`, `inputs`, `ttl`, `use_existing`, `source`, `threads`, `pipelineTraceLevel` |
| `run_dropper_pipe` | Start an inline pipeline and return two self-contained URLs for getting files in over a separate HTTP data channel — file bytes cannot ride the MCP tool call: `upload_url` for programmatic POSTing and `dropper_url` for a human to drag-drop files in a browser. Same inputs as `run_pipeline` minus `inputs` (no inline-send path). `upload_url` is `POST {base}/task/data?auth=<pk_>` (multipart or raw body); `dropper_url` is `GET {base}/dropper?auth=<pk_>` (a browser page whose UI then POSTs to `/task/data`). Both embed only the task's public auth key (`pk_`) — `/task/data` resolves the task from it, so no `Authorization` header and no routing token are required; the `tk_` control token never rides in a URL. | `pipeline`, `ttl`, `use_existing`, `source`, `threads`, `pipelineTraceLevel` |
| `send_data` | Send data to a running task by `task_token`, return its result. | `task_token`, `input` |
| `terminate` | Tear down a running task by `task_token` — also the stop-runaway-task path. | `task_token` |

**Ingestion (1)** — also in `tools/execution.py`:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `send_files` | Upload one or more store-relative file paths to a running task by `task_token`. | `task_token`, `files` |

**Visibility (2)** — `tools/visibility.py`:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `monitor` | Bounded poll of task status until a terminal state or `timeout` elapses, returning a snapshot. | `task_token`, `timeout` (default 30), `interval` (default 1) |
| `list_running_pipelines` | Server-authoritative list of running tasks (task token, name, state) — thin wrapper over the same `client.list_tasks()` seam backing the `rocketride://status` resource. Makes tokens discoverable for `monitor`/`send_data`/`terminate` without having started the task yourself in this session. | none |

**Store (4)** — `tools/capability.py`, read-only, SDK: `rocketride.mixins.store`:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `store_read` | Read a text file from the RocketRide store by store-relative path (in-band). | `path` |
| `store_list` | List entries under a store-relative directory path. | `path` (default `''` = root) |
| `store_stat` | File/dir metadata: `exists`, `type` (file\|dir), `size`, `modified`. | `path` |
| `store_get_url` | Time-limited signed download URL for a store file — the out-of-band counterpart to `store_read` for large files that can't ride an in-band JSON-RPC result. The returned URL is directly fetchable (plain HTTP GET, e.g. by a browser or the calling agent's sandbox) — no further MCP round-trip needed to retrieve the bytes. | `path`, `expires_in` (seconds, default 3600), `download_name` |

**Templates (2)** — also in `tools/capability.py`:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `save_template` | Save an inline pipeline as a reusable template. | `template_id`, `pipeline` |
| `load_template` | Load a previously saved pipeline template. | `template_id` |

**Deployments (5)** — also in `tools/capability.py`, full lifecycle, SDK: `rocketride.deploy.DeployApi`:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `deploy_add` | Register an inline pipeline as a deployment, optionally on a cron schedule. | `pipeline`, `schedule` |
| `deploy_list` | List the caller's deployments with status and schedule. | none |
| `deploy_status` | Detailed status of one deployment by `project_id`. | `project_id` |
| `deploy_remove` | Undeploy and remove a deployment by `project_id`. | `project_id` |
| `deploy_update` | Update a deployment's pipeline and/or schedule by `project_id`. | `project_id`, `pipeline`, `schedule` |

**Run log (DVR) (4)** — `tools/logs.py`, read-only, keyed by `projectId`/`source`
(never task tokens), backed by the engine's persisted continuum (`rrext_log`) —
works for both past and live runs:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `log_chapters` | List recorded runs (chapters) for a pipeline — begin/end times, `beginSeq`, outcome. | `projectId`, `source`, `teamId` (optional — omit for your own dev runs) |
| `log_read` | Read raw run-log events, cursor-paged; `types=["output"]` returns console lines only. Pass `nextCursor` back as `cursor` to continue. | `projectId`, `source`, `fromSeq`, `cursor`, `maxEvents` (floored at 1, capped at 200), `types` |
| `log_traces` | List per-object trace summaries (one per file/document that traveled the pipeline). Each carries `beginSeq` — the permanent trace id. Returns `{traces, open, context}` — `traces` holds finished runs, `open` holds ones still in flight, `context` echoes the keying identity (`projectId`, `source`, `teamId?`) so a follow-up call or widget can address the same run. Defaults to the latest/live run; pass `chapterBeginSeq` (from `log_chapters`) to address a specific past run instead. | `projectId`, `source`, `n` (default 20, clamped 1-100), `chapterBeginSeq` |
| `log_trace` | Fetch one object's full begin-to-end journey through the pipeline by its `beginSeq`: a summary plus every component enter/leave with lane data, plus node narration. Returns `{beginSeq, summary, events, context}` (same `context` shape as `log_traces`). | `projectId`, `source`, `beginSeq` |

A `log_read` page is bounded two ways: `maxEvents` (≤ 200) and a fixed 1 MiB
total-byte cap forwarded to the engine as `max_bytes` — so a maxed-out page is
≈ 1 MiB of in-band JSON-RPC result, not `maxEvents` × the 64KB per-event cap.
At most 4 `log_read` calls run concurrently (module-level semaphore); each
in-flight page can pin ~3× its size while `handlers.py` holds the result, its
JSON text, and the parsed `structured_content`.

Runs are keyed by `(projectId, source[, teamId])` — the scope is the kind: a
`teamId` addresses that team's deploy continuum, omitting it addresses your own
dev stream. Address them with the `projectId`/
`source` that `run_pipeline`/`run_dropper_pipe` now return (see Execution above),
not by task token — the run log outlives the task. Retention is 7 days (dev) / 30
days (deploy), or earlier under segment/chapter caps. An unrecognized `projectId`/
`source` pair (no chapters at all) returns `error_type: 'NotFound'` from
`log_chapters`; `log_traces` on an unrecognized `chapterBeginSeq` returns the same
`'NotFound'`; `log_trace` on an evicted `beginSeq` returns
`error_type: 'TraceExpired'` (PascalCase, like every other `error_type` on this
surface). Both conditions are signaled by the seam's dedicated
`engine.LogNotFound` exception, not a bare `KeyError`. Traces are gated by
`pipelineTraceLevel` on the originating `run_pipeline`/`run_dropper_pipe` call
(both tools now default it to `'summary'`): a run submitted with
`pipelineTraceLevel: 'none'` still has chapters and console output, but
`log_traces`/`log_trace` come back empty, with an explanatory `note`. The
`EngineClient` seam (`log_traces`/`log_trace` on `WsEngineClient`) is a faithful
transport that returns the SDK's raw nested shapes verbatim — the engine's
`open`/`closed` trace-summary split and `summary`/`events` trace-detail split —
with no reshaping; the `log_traces`/`log_trace` MCP tools do the normalizing
described above. When `chapterBeginSeq` is passed, the seam looks the chapter
up via `log.chapters()` and seeks the event-stream session to that chapter's
`endTime` (or `'live'` if the chapter is still open) before reading traces, so
results reflect that run rather than the latest one. All four `log_*` tool
handlers wrap their blocking seam call in the same `asyncio.wait_for(...)` +
in-band timeout envelope (`error_type: 'Timeout'`) used by the execution tools
(`tools/execution.py`), rather than letting a slow engine surface as a hard MCP
error.

Tool call dispatch (`handlers._on_call_tool`) looks up the handler by name in the
registry and calls `await handler(engine_client, task_registry, arguments)`. Errors
are normalized via `errors.normalize_error`: self-correctable failures come back as
an in-band `{ok: False, error_type, message, hint}` result; hard failures
(`errors.HardError`, or a raw exception whose type name is in `errors.HARD_EXC_NAMES`
— `ConnectionError`, `AuthenticationException`, `TimeoutError`) propagate out of the
handler and surface as a genuine MCP tool error, not a structured result. Structured `{ok: False}` envelopes additionally set `isError=true` on the `CallToolResult` (derived from the in-band `ok` field) so hosts can detect a failed call without parsing the JSON body — the envelope itself still rides `content`/`structuredContent` for the agent to self-correct from.

## Integrations & credential readiness

A curated catalog (`credentials.json`, sibling to this doc) describes which
config *fields* on which nodes are credential-shaped, and suggests a
`ROCKETRIDE_*` environment-variable name for each. `credentials.py` turns that
catalog plus the caller's own variable *names* (never values — see below) into
a per-integration readiness verdict, shared by `list_integrations`,
`list_components`, and `describe_component`'s `credentials` block.

### The catalog

- **Location**: `packages/ai/src/ai/modules/mcp/credentials.json`, keyed by
  node name, each entry a `title` plus a list of `fields` (`path`, `title`,
  `kind`, `required`, `suggests`, optional `review`).
- **Generator**: `nodes/scripts/gen-credentials.mjs` scans every node's
  `services*.json` for credential-shaped fields (name matches
  `api_key`/`secret`/`passw`/`bearer`/`credential`/`token`, empty-string
  default) and reconciles them against the catalog.
- **Curated names win.** A path the generator detects that is already covered
  by an existing catalog entry is left completely untouched — a human's
  chosen `title`/`suggests` always beats the generator's derived stub. A
  newly detected path with no catalog entry gets a stub appended with
  `review: true` so a human can give it a real name later.
- **Builder wiring**: `nodes:credentials-generate` (writes) runs as part of
  `nodes:build`, immediately after `nodes:docs-generate`.
  `nodes:credentials-check` (drift gate, never writes) exits non-zero on an
  unmapped credential path or a stale catalog entry; a `review: true` field
  still pending curation only warns, it does not fail the gate. Staleness is
  path-level only for generator-owned `review: true` stubs — the generator no
  longer detecting their path is the signal a human still needs to name or
  remove them. A human-curated field (no `review` flag) on a node that still
  exists is never path-stale, since curation exists precisely to describe
  config the generator can't detect; either kind goes stale, whole-entry, if
  its node's directory is gone entirely. Nothing is ever auto-deleted.
- As of this change the catalog covers 55 nodes / 83 fields.

### The readiness rule

`credentials.evaluate(spec, env_keys)` — same logic behind every tool above —
classifies each integration as exactly one of:

| Status | Meaning |
| --- | --- |
| `configured` | Every required field's suggested name is an exact match in the caller's environment-key names. `wiring` (a `{path: '${VAR}'}` map) is returned; `setup` is not. |
| `unconfirmed` | Either a required field is missing but a name-token substring match against the caller's variable names *surfaces candidates* (the agent proposes a binding, the user must confirm before it's used — a substring match never confers readiness on its own), **or** the environment-keys read itself failed. A read failure must never look like "nothing is set up," so it is always `unconfirmed`, never `available`. |
| `available` | A required field is missing and no candidate names were found either — nothing detected, not yet configured. |

Both non-`configured` statuses carry a `setup` block (`variables`, `how`,
`docs`) so the agent can relay concrete next steps: `how` points at
RocketRide's VS Code extension (Settings → Variables) or
`https://app.rocketride.ai/settings/variables`. **Variable *names* only ever
transit MCP — values never do**; `caller_variables` on a named
`list_integrations` call, and the candidate lists everywhere else, are always
names.

### Per-caller identity

`/mcp` requests build a per-request `EngineClient` from the caller's own
credential when the request carries one (an API key, or a verified OAuth JWT
— both passed through as `rocketride_auth`, the same pattern `task_http`
uses), so `get_environment_keys()` — and therefore every readiness verdict
above — reflects *that caller's* configured variables, not the server
operator's. A request with no credential falls back to the configured
`ROCKETRIDE_AUTH`/`ROCKETRIDE_APIKEY` singleton, unchanged from
pre-integrations behavior. See "The `EngineClient` seam" below for the
factory mechanics and `identity.py` for the `ContextVar` propagation; the
mount's `finally` closes each per-request client.

## Resources (2)

`resources.py` exposes two read-only resources, both `application/json`:

| URI | Contents |
| --- | --- |
| `rocketride://status` | `{connected, pipeline_count, pipelines: [names]}` derived from `EngineClient.list_tasks()` — running tasks. |
| `rocketride://pipelines` | Registered deployments — `EngineClient.deploy_list()` (`deploy.list()`), not running tasks. |

`rocketride://nodes` was removed — superseded by the `list_components` tool plus the
static Skills map.

## Embedded UI (MCP Apps)

The server implements the `io.modelcontextprotocol/ui` extension (spec
2026-01-26). Widgets are single-file HTML bundles built by
`builder mcp-widgets:build` from the vite workspace embedded at `apps/` next
to this module, straight into `apps/dist/`, and served as
`ui://rocketride/<name>.html` resources with mimeType
`text/html;profile=mcp-app`. A tool opts in via
`ToolRegistry.register(..., ui_resource_uri=...)`, which emits
`_meta.ui.resourceUri`; hosts that support MCP Apps render the widget beside
that tool's result, all other hosts see the unchanged JSON. The capability is
advertised only when at least one built bundle exists on disk.

Current widgets: `pipelines-table` (linked to `list_running_pipelines`;
refresh/terminate call back through the bridge), `dropper` (linked to
`run_dropper_pipe`; in-chat file upload with progress, then renders the
pipeline's results), and `trace-viewer` (linked to both `log_traces` and
`log_trace`; renders the run's request list and, on open, one request's
full call tree). The introspection tools (`describe_pipeline`,
`validate_pipeline`) carry no widget link — their results are plain JSON.
(Two earlier widgets were removed after live testing: the run-monitor view
and the pipeline-view widget in both its incarnations, the SVG graph and the
real-canvas iframe embed — see git history if either is ever revisited.)
Widgets that make direct network calls (`dropper` uploads straight to the
engine) declare `csp.connectDomains`; the server stamps that list with the
live engine origin when resources are listed, so the host can authorize the
request. Widgets that only call tools through the bridge declare no
`csp.connectDomains`. Tool results also carry `structuredContent` alongside
the text payload, giving widgets typed JSON to render without re-parsing.

## Prompts: removed

There is no prompt surface. "Knowledge lives in Skills," not MCP prompts — the 3
prompt templates from the earlier port were removed along with their tests.

## The `EngineClient` seam

`engine.py` defines one `Protocol`, `EngineClient`, with the methods needed
by the 28-tool surface (task lifecycle, services/validation, store/templates/store
metadata/signed URLs, full deployment lifecycle, `rrext_log` chapters/read/traces/
trace — see the `Protocol` definition in `engine.py` for exact signatures). All
tool/resource code depends only on this interface — never on a concrete client — so
the implementation is swappable.

**v0 implementation: `WsEngineClient`.** Wraps the existing `RocketRideClient` WS/DAP
SDK (the same client the TS/Python SDKs use). Because `RocketRideClient.request()`/
`use()`/`send()` don't auto-connect (the constructor only builds the client; a DAP
`request()` before `connect()` raises `RuntimeError('Server is not connected')`),
`WsEngineClient` connects **lazily on first use** and reuses the connection for its
lifetime, guarded by an `asyncio.Lock` so concurrent requests can't race to open the
socket twice. `close()` disconnects (safe to call even if never connected — used from
the module's shutdown hook).

`make_engine_client(config)` reads `ROCKETRIDE_URI`/`ROCKETRIDE_AUTH`/`ROCKETRIDE_APIKEY`
from the environment and constructs a `WsEngineClient`; this is the only place those
env vars are consumed.

`handlers.build_mcp_server` takes an `engine_factory: Callable[[], EngineClient]` and
calls it on every request/handler invocation. In production `engine_factory`
(`_make_engine_factory` in `__init__.py`) branches on `identity.CALLER_AUTH`, a
`ContextVar` set for the duration of the request by the `/mcp` mount:

- **Caller credential present** (the request carried its own API key or a
  verified OAuth JWT — see "Per-caller identity" below) — a **fresh**
  `WsEngineClient` is built from `{**config, 'rocketride_auth': caller_auth}`,
  never cached, and appended to that request's `identity.REQUEST_CLIENTS`
  bucket so the mount's `finally` can close it once the request completes.
- **No caller credential** — the pre-integrations lazy-**singleton** path,
  unchanged: the first such call builds one long-lived `WsEngineClient` from
  the configured `ROCKETRIDE_AUTH`/`ROCKETRIDE_APIKEY`, and every later call
  on this path returns that same instance. Concurrent unauthenticated-caller
  `/mcp` requests multiplex this one shared WS connection; the client's
  connect lock only guards the one-time `connect()` race, not in-flight
  request correlation.

Only the singleton client is closed from `initModule`'s shutdown hook
(`engine_factory._state['client']`); per-caller clients are closed per-request
by the mount, not at shutdown.

This seam exists specifically so a later revision can swap in a direct in-process
`modules/task` implementation (bypassing the WS round-trip entirely, since the MCP
module already runs inside the same engine process) without touching any tool or
resource code — only `engine.py` would change.

## Server-owned `TaskRegistry`

The RocketRide SDK has no client-side task registry: `use()` returns a bare task
token, and enumerate/terminate/monitor across separate tool calls need somewhere to
keep `{token -> metadata}`. `registry.TaskRegistry` (`registry.py`) is a plain
in-memory dict, scoped to a single asyncio event loop — not thread-safe, must not be
shared across event loops or accessed concurrently from multiple threads.
`run_pipeline` calls `tasks.add(token, pipeline_ref=...)`; `terminate` calls
`tasks.remove(token)`.

## Security

- **Pipelines are inline-only — no tool reads server-local files.** No tool
  accepts a `filepath` argument. A server-side file read would hand any
  authenticated MCP caller read access to the engine process's local
  filesystem, so the pipeline-taking tools (`run_pipeline`,
  `run_dropper_pipe`, `validate_pipeline`, `describe_pipeline`,
  `save_template`, `deploy_add`, `deploy_update`) all require the pipeline
  definition inline. Pipeline definitions are small JSON; an MCP client that
  has a `.pipe` file on disk reads it itself and sends the content. The only
  file-shaped surface that remains is the store tool group (`store_read`
  etc.), which resolves store-relative paths through the engine's own
  account-scoped file store, and `send_files`, whose paths are likewise
  store-relative — neither touches the server's raw filesystem namespace.
- **`MCP_DEV_NO_AUTH` stays loopback-only.** The `MCP_DEV_NO_AUTH=1` /
  `mcp_dev_no_auth` bypass (see above) must **only** ever be enabled on a
  **loopback bind** — never on `0.0.0.0` or any other publicly reachable
  bind: an unauthenticated `/mcp` hands the whole tool surface (pipeline
  execution, store access) to anyone who can reach it. `initModule` enforces
  this: the bypass is honored only when the **configured host**
  (`server.config['host']`, falling back to the module config's `host`,
  default `CONST_DEFAULT_WEB_HOST`) is exactly `localhost`, `127.0.0.1`, or
  `::1` — the same allowlist as the environment table above. The check reads
  the configured value, not the resolved bind address, so a hostname that
  *resolves* to loopback but isn't one of those three literals does not
  qualify. On any other value the bypass is ignored (with a warning) and
  `/mcp` stays authenticated.

## OAuth discovery

`/mcp` is an OAuth 2.0 protected resource. Two things make it discoverable to
clients that cannot be handed an API key (Claude, ChatGPT):

| Path | Auth | Purpose |
|---|---|---|
| `/.well-known/oauth-protected-resource/mcp` | public | RFC 9728 metadata naming the authorization server |
| `/mcp` | required | the MCP endpoint itself; 401s carry `WWW-Authenticate: Bearer resource_metadata="..."` |

The metadata document is registered by `initModule` through
`ai.web.oauth_resource.register_routes()`, using `add_route(..., public=True)`.
It **must** stay public: it is what an unauthenticated client reads in order to
learn how to authenticate. Publishing it does not open `/mcp` itself, which
remains behind the auth middleware (pinned by `test_module_registration.py`).

The authorization server is Zitadel, which serves its own RFC 8414 document at
`https://auth.rocketride.ai/.well-known/oauth-authorization-server`. There is no
broker and no dynamic client registration — DCR is deliberately disabled, and
external clients are registered in a dedicated Zitadel project and issued a
static client id.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MCP_RESOURCE_IDENTIFIER` | `https://api.rocketride.ai/mcp` | Canonical resource identifier. Must match the deployed URL exactly — it determines both the well-known path and the audience clients request. |
| `MCP_AUTHORIZATION_SERVER` | `https://auth.rocketride.ai` | Issuer allowed to mint tokens for this resource. |
| `MCP_EXPECTED_AUDIENCE` | *(unset)* | Zitadel **project id** an OAuth token must carry in `aud`. See "Audience enforcement" below. |
| `MCP_JWKS_URL` | `<issuer>/oauth/v2/keys` | Where the issuer's public signing keys are fetched from. |

### Audience enforcement

`ai.modules.mcp.auth` gates the `/mcp` mount before the session manager sees a
request. A bearer token is a ticket, and Zitadel stamps each one with the id of
the project its client belongs to (the `aud` claim). Without checking that
stamp, a token minted for the VS Code extension would open `/mcp` as readily as
one minted for Claude — hence a dedicated MCP-only Zitadel project, whose id
goes in `MCP_EXPECTED_AUDIENCE`.

The guard verifies the JWT signature against the issuer's JWKS, checks the
issuer, and requires `MCP_EXPECTED_AUDIENCE` to appear in `aud`. Verified claims
are stashed at `scope['state']['mcp_claims']` for downstream handlers. The check
lives here rather than in the engine's global authenticator chain deliberately:
"was this token issued for MCP" is a rule about MCP, and must not be imposed on
`/task` or `/api/chat`.

Two things it does not affect:

- **Persistent user API keys.** `rr_` keys and bare API keys are opaque
  strings, not JWTs, and are routed by *shape* rather than by a prefix
  allowlist. They take the existing authenticator path with no audience check,
  so Cursor and the CLI are unchanged.
- **Requests with no credential.** Whether one is required is the auth
  middleware's decision, not the guard's.

One class of static keys it rejects outright, on every bind: task-scoped keys
(`tk_`/`pk_`) and PKCE exchange codes (`cd_`). These are minted per-task (or
per-exchange), and the authenticator chain scopes their *permissions* but not
their *routes* — a `pk_` travels in dropper URLs by design, and without this
reject a leaked one would still reach the tools that never consult engine
permissions. `/mcp` callers are `rr_` keys and audience-verified OAuth tokens,
nothing else.

When `MCP_EXPECTED_AUDIENCE` is unset, OAuth tokens are accepted on a loopback
bind and **refused on any other bind** — the same posture `MCP_DEV_NO_AUTH`
takes. Local development keeps working; a production deploy that forgets the
setting fails loudly instead of silently accepting every token it is handed.

Per RFC 9728 §3.1 the well-known segment is inserted between host and path, so
the document's location follows the identifier. Changing it to a bare host (e.g.
`https://mcp.rocketride.ai`) moves the document from
`/.well-known/oauth-protected-resource/mcp` to
`/.well-known/oauth-protected-resource`. Routing must follow, or discovery
silently 404s.

Note that Zitadel discards the RFC 8707 `resource` parameter and stamps its own
project id into the token's `aud` claim instead. The resource identifier above
and the value that actually appears in `aud` are therefore different strings by
design; audience enforcement compares against the project id.

## Dev caveats — not production-ready

- **Local processes + in-band results are the dev mode.** File inputs are
  reference-able only as store-relative paths (`send_files`); pipeline
  definitions are inline-only. Outputs are inherently in-band today: `send()`
  returns the full `PIPELINE_RESULT` synchronously (can embed base64 images, large
  text) as one atomic JSON-RPC message — no cap or paging. **Out-of-band /
  reference-passing / egress-spill is deferred**; large payloads over HTTP (proxy
  buffering, timeouts, SSE framing) are a known future risk. See
  `claude/tasks/http-mcp-tools-port/tool-specs.md` §Data-handling.
- **`deploy_add`/`deploy_update` require a `project_id` in the pipeline** — an SDK
  requirement, not enforced by this module's schema.
- **Env/secrets *mutation* tools (`set_env`, `list_env_keys`) remain out of
  scope for this surface.** They shipped briefly, then were removed. What
  this module now does own is read-only credential *readiness* —
  `list_integrations`, plus `list_components`/`describe_component`'s
  credentials integration — see "Integrations & credential readiness" above;
  variable values are never read, written, or transmitted by any tool here.
  `ROCKETRIDE_URI`/`ROCKETRIDE_AUTH`/`ROCKETRIDE_APIKEY` (the *connection* env
  vars, unrelated to either) are still read at boot — see "Environment
  variables / config" above.
- **Known pre-existing follow-up:** `resources.read_resource` returns a bare `str`,
  which the MCP SDK now deprecates in favor of `Iterable[ReadResourceContents]`.
  Cleanup deferred; not a functional break today.
- **Auth / OAuth** — by default `/mcp` is protected by the engine's
  `AuthMiddleware` like every other route; the `MCP_DEV_NO_AUTH` dev bypass is
  the only *override* of that default, and it exempts `/mcp` entirely (loopback
  binds only — see Security above). There is no OAuth flow, per-client
  credential, or MCP-spec auth negotiation implemented.
- **DB provisioning** — out of scope for this module; no database is provisioned or
  assumed by any tool/resource here.

## History

This module originally shipped as a 2-tool port of the standalone stdio MCP server:
one dynamic tool generated per pipeline file (a raw caller-supplied `{filepath}` read
off the local filesystem with no sandboxing) plus a `RocketRide_Document_Processor`
convenience tool, 3 `rocketride://` resources, and 3 MCP prompts. That surface was
first replaced by a 16-tool static/typed surface (introspection, execution,
ingestion, `monitor`, env/secrets, store/templates, `deploy_add`), ported from the
design in `claude/tasks/rocketride-mcp-server/` via
`claude/tasks/http-mcp-tools-port/`. The dynamic per-pipeline tools, the convenience
tool, `rocketride://nodes`, and all 3 prompts are removed.

The surface then grew to **25 tools**: `run_dropper_pipe` landed with the
ingress work (16 → 17); the 3 `sql_query`/`graph_query`/`vector_search` query tools
followed (17 → 20); `set_env`/`list_env_keys` were then dropped as out of scope
(20 → 18); and `store_stat`, `store_get_url`, `deploy_list`, `deploy_status`,
`deploy_remove`, `deploy_update`, and `list_running_pipelines` were added to round
out store/deployment/visibility lifecycles (18 → 25). A per-node pipeline-trace
visibility tool (25 → 26) followed, adding node-level `pipelineTraceLevel`/
FLOW-event tracing — its mechanics (registry routing, dispatcher shape,
subscribe-at-start, event fields) were ported from the
`feature/mcp-server-overhaul` branch, which had already proven them live.

The 3 `sql_query`/`graph_query`/`vector_search` convenience query tools were
then removed (26 → 23): they target RocketRide-hosted SQL/graph/vector
databases whose backend is not yet available in OSS `develop`, so shipping them
would expose tools that fail at call time. They are expected to return once the
cloud DB backend lands.

Then the per-node pipeline-trace visibility tool and its live-only
in-memory event-buffer machinery (the `TaskRegistry` side-buffers, the
dispatcher factory in `handlers.py`, and the engine-seam subscribe/event-hook
wiring) were retired (23 → 22): the feature only ever worked for the life of
one connection and one process, with nothing persisted. A DVR-style run log
that persists per-project/source/run traces supersedes it in a follow-up
change.

**2026-08-06** — DVR run-log tools added (+4): 22 → 26 (the
`get_pipeline_trace` retirement is the 23 → 22 step recorded above). Run tools
now default `pipelineTraceLevel` to `'summary'` and return
`projectId`/`source`.

**2026-08-17** — `list_integrations` added (26 → 27), alongside the
credential-catalog readiness engine described above ("Integrations &
credential readiness"). `list_components` narrowed at the same time to only
usable components (zero-config plus configured integrations), and
`describe_component` gained a `credentials` block for catalog nodes.

## Running / testing locally

The module loads automatically at engine boot via `server.use('mcp')` in
`packages/ai/src/ai/eaas.py`, alongside the other `ai` modules — no separate process
to start. Once the engine is up, the MCP endpoint is reachable at `http://<host>:<port>/mcp`
using any Streamable-HTTP MCP client.

The module's test suite lives at `packages/ai/tests/ai/modules/mcp/`. Run it with the
project's standard test runner, e.g. `./builder ai:test` or
`python -m pytest packages/ai/tests/ai/modules/mcp/`.
