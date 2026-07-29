# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]: since 2026-06-08

## [3.3.0] - 2026-06-08

### ⚠ Breaking Changes: Client SDKs (`rocketride` / `rocketride-python`)

These changes affect code that imports and calls the Python or TypeScript client SDKs directly. The old `connect()` / `disconnect()` signatures are preserved as backward-compatible wrappers, but callers should migrate to the new layered API.

#### Connection API (both SDKs)

| Before (1.0.x) | After (1.1.0) | Notes |
|---|---|---|
| `connect(auth?, uri?, timeout?)` → `void` | `connect(credential?, { uri?, timeout? })` → `ConnectResult` | Now returns full user identity (userId, organizations, apps, teams). The `auth` param is renamed `credential` to reflect that it accepts API keys, Zitadel access tokens, and `rr_*` user tokens. Old positional `auth`/`uri` kwargs still accepted but deprecated. |
| `disconnect()` → `void` | `disconnect()` → `void` | Signature unchanged; internally calls `logout()` + `detach()`. |
| *(not available)* | `attach(uri?)` → `void` | Opens the WebSocket **without** authenticating. Required for public/unauthenticated operations like catalog browsing. |
| *(not available)* | `login(credential?)` → `ConnectResult` | Sends the DAP `auth` command over an attached transport. Supports credential rotation (auto-logout if credential differs). |
| *(not available)* | `logout()` → `void` | Sends new `deauth` DAP command, reverts the connection to unauthenticated without closing the socket. |
| *(not available)* | `detach()` → `void` | Tears down the WebSocket and cancels the reconnect engine. |
| `isConnected()` | `isConnected()` *(unchanged)* | Returns `true` only when both attached **and** authenticated. |
| *(not available)* | `isAttached()` | `true` when the WebSocket is open, regardless of auth state. |
| *(not available)* | `isAuthenticated()` | `true` when the auth handshake has succeeded on the current connection. |

**Reconnection engine rewritten**: the old flag soup (`_manualDisconnect`, `_authRejected`, `_didNotifyConnected`) is replaced by a `_desiredState` model (`'detached'` | `'attached'` | `'authenticated'`). Linear backoff (250ms increments, 15s cap) replaces exponential backoff, reconnection now **never gives up**. `maxRetryTime` is accepted for backward compatibility but **ignored**.

#### Python-specific breaking changes

- **`async with` context manager removed**: `__aenter__` / `__aexit__` are deleted. Replace `async with RocketRideClient(...) as client:` with explicit `await client.connect()` / `await client.disconnect()` in a try/finally.
- **`connect()` now returns `ConnectResult`**: previously returned `None`. Callers that did `await client.connect()` without capturing the result are unaffected; callers that typed the return as `None` will need to update.
- **`use()` no longer substitutes `${ROCKETRIDE_*}` client-side**: the raw pipeline is sent to the server, which handles all variable resolution via `get_merged_env()`. If you were relying on client-side `.env` interpolation, variables must now be set server-side (via the Variables page or `client.account.set_env()`).
- **Event type renames**: `EVENT_STATUS_UPDATE` → `EVENT_STATUS`; `EVENT_TASK` → split into `TASK_EVENT`, `TASK_EVENT_FLOW`, `TASK_EVENT_RUNNING`, `TASK_EVENT_BEGIN`, `TASK_EVENT_END`, `TASK_EVENT_RESTART`. Code that imports the old names will get `ImportError`.
- **`auth` credential removed from transport layer**: `TransportWebSocket` no longer stores or exposes `auth`. Auth is exclusively managed by the `ConnectionMixin` / `RocketRideClient` layer.

#### TypeScript-specific breaking changes

- **`connect()` signature changed**: old: `connect(options?: number | { uri?, auth?, timeout? })` → `void`. New: `connect(credential?, options?: { uri?, timeout? })` → `Promise<ConnectResult>`. The `auth` property inside options is removed; pass the credential as the first argument. The numeric-only shorthand `connect(5000)` is removed.
- **`DataPipe` errors changed from `Error` to `PipeException`**: `open()`, `write()`, and `close()` now throw `PipeException` (extends `Error`) instead of plain `Error` when the server reports a failure. Callers catching `Error` are still compatible; callers matching on error message strings may need to update. `PipeException` carries the full DAP response body.
- **`setConnectionParams()` removed**: use `login(credential, { uri })` or call `attach(newUri)` + `login()` instead.
- **Project store methods removed**: `saveProject()`, `getProject()`, `deleteProject()`, `getAllProjects()` are deleted. Use the new filesystem API: `fsOpen()`, `fsRead()`, `fsWrite()`, `fsClose()`, `fsDelete()`, `fsListDir()`, `fsMkdir()`, `fsRmdir()`, `fsStat()`, `fsRename()`, `fsReadString()`, `fsWriteString()`, `fsReadJson()`, `fsWriteJson()`.
- **`validate()` return type changed**: previously returned `Record<string, unknown>`. Now returns `ValidationResult` (typed interface with `valid`, `errors`, `warnings` fields).
- **`getServices()` return type changed**: previously returned `Record<string, unknown>`. Now returns `ServicesResponse` (typed interface).

#### Both SDKs: new exception types

- **`PipeException`** (Python: subclass of `RuntimeError`; TypeScript: subclass of `Error`): thrown by `DataPipe.open()`, `.write()`, `.close()` when the server reports failure. Carries the full DAP response including `message`, `body`, and error code. Replaces generic `RuntimeError` / `Error`.
- **`ConnectionException`** (TypeScript): thrown on transport-level failures.

### Added

#### New Nodes
- **Exa Search**: semantic web search node integrating with the Exa API (exa.ai) for real-time data enrichment in pipelines. Agents invoke the tool to search the web and retrieve structured results including titles, URLs, text content, relevance scores, and published dates. Includes configurable `numResults` with min/max validation, retry exception sanitization to prevent API key leakage, and defensive boolean config parsing (#386, #509)
- **Bland AI**: voice call tool node for AI-driven phone calls via the Bland AI platform (#521)
- **OpenAI Compatible**: generic LLM node supporting any OpenAI-compatible API endpoint, allowing connection to self-hosted or third-party inference servers that follow the OpenAI chat completions API (#518)
- **GMI Cloud**: LLM connector for GMI Cloud inference platform (api.gmi-serving.com) hosting 100+ models on H100/H200 GPUs. Two tiers: shared (always-on, key-only: DeepSeek, GPT, Claude, Gemini) and deploy-on-demand (endpoint URL + key: Llama 4, Qwen3). Custom profile for arbitrary model/endpoint combinations (#540)
- **Guardrails**: AI safety node with comprehensive input/output validation. Input: prompt injection detection (regex + keyword scoring), topic restriction (allowed/blocked keyword lists), input length enforcement (char + token limits). Output: hallucination detection (sentence-level grounding), content safety (self-harm, violence, illegal activity patterns), PII leak detection (email, phone, SSN, credit card, IP), format compliance (JSON, markdown, bullet/numbered lists). Policy modes: block/warn/log. Profiles: basic (injection + PII), strict (all checks), custom. 87 tests (#534)
- **Video Embedding**: extracts frames from video input (MP4, AVI, MOV, WebM) at configurable intervals and generates vector embeddings using CLIP/ViT models for semantic search and RAG pipelines. Configurable frame interval, max frames, start time, duration, and max video file size (default 500 MB) to prevent unbounded memory. VideoCapture resource leak fixed with finally block (#516)
- **Kokoro TTS**: self-contained text-to-speech node using the Kokoro engine. Slim requirements (no piper/transformers/cloud). KokoroLoader, spacy_en_model, wav_to_mp3 utilities. Supports question, answer, and document lanes (RR-411, #662)
- **Telegram Bot**: source node connecting a Telegram bot to a pipeline via long polling or webhook. Routes incoming messages to appropriate lanes by content type (text, image, audio, video, documents) and sends pipeline responses back as replies (#659)
- **GitHub Tool**: tool node for GitHub API operations (issues, PRs, repositories) with full test suite for tool calling (#640)
- **Git Tool**: self-contained Git operations using pygit2 (libgit2), no host git binary required. Capabilities: clone, init, status, log, show, diff, blame, file_at, ls_files, grep, stage, commit, stash, branch create/checkout/merge/delete, fetch, pull, push (token + SSH auth), write_file with path-traversal guard. Safe mode (default on) blocks force-push and force branch deletion. Full unit test suite + integration tests (activated via `GIT_TEST_REPO_PATH` env). Includes `git_agent_example.pipe` (#654, #731)
- **Filesystem Tool**: file system operations (read, write, list, mkdir, delete) with path whitelist security check via `_prepare()` method. Operations can be selectively enabled/disabled at the node level. Shared prologue extraction via keyword flags (path_required, needs_encoding, needs_content) (#682)
- **Pipeline Tool**: run pipelines as tool calls from other pipelines, enabling pipeline composition and hierarchical agent workflows (#647)
- **LLM Vision (Gemini)**: image understanding via Gemini models with cache management (non-symmetric cache + empty frame guard)
- **LLM Vision (OpenAI)**: image understanding via OpenAI vision models
- **Webhook**: question lane support for webhook-triggered pipelines (#431)
- **CrewAI Orchestrator**: multi-agent orchestration via CrewAI framework. Exposes expert config fields (goal, backstory, expected_output, max_iter) for both agent and orchestrator node types. Advanced mode for fine-grained control. Sub-agent config propagated through `crewai.describe()`. Manager node renamed from Orchestrator, tool invoke removed from manager (#608)

#### VS Code Extension
- **Engine management overhaul**: replaced scattered engine lifecycle code (connection/, deploy/) with a clean `EngineBackend` hierarchy under `src/engine/`. Each connection mode (local, service, docker, cloud, onprem) gets its own backend implementation. `EngineRegistry` singleton reconciler detects config changes (API key, host URL, etc.) via checksums and auto-restarts affected engines on settings save. Eliminated `engine:status` event, all progress flows through `shell:statusChange`. `ConnectionManager` becomes passive: connects on engine `ready`, disconnects on `idle`. Unified `ioControl` message pattern for all panel operations. Migration from legacy layout (`globalStorage` + `config.json`) to new structure. Welcome page uses same `applyAllSettings` + reconcile path as Settings (#922)
- **Settings overhaul & target panels**: atomic settings save via `ConfigManager.applyAllSettings()` with `isBatchApplying` flag suppressing intermediate change events (eliminates race conditions from writing 20+ config keys individually, which caused connection managers to react to half-written state). Self-contained panels per mode (Local, Cloud, OnPrem, Docker, Service) handling both configuration and operational UI (status, install/start/stop/remove/update, progress, version selection). `EngineOperations` service extracted from `PageDeployProvider`. Deploy page command redirected to Settings. `useTheme` hook for VS Code dark/light detection. Embedded Docker/Service SVG logos. Build config consolidated: `.config` as single source of truth for Zitadel URLs/client IDs, esbuild loads `.config` first then `.env` on top, stopped name remapping of Zitadel keys. Cloud mode no longer hardcodes a non-existent URL, uses `config.hostUrl` at runtime (#725)
- **Standalone Variables page**: new "Variables" webview accessible from sidebar footer for managing `ROCKETRIDE_*` environment variables per connection slot (Development/Deployment). `EnvironmentProvider` with per-slot client resolution, `EnvironmentWebview` with pill bar for slot selection. OSS servers show single "Server Variables" card; SaaS servers show Organization/Team/User cards gated by permissions. `set_env` now updates `os.environ` in-memory before writing `.env` file. Deploy connection fix: removed `isSharedMode()` guard that skipped engine status listener registration. `commonStyles.tabContent` now uses `border-box` sizing. Removed capabilities filter that hid Cloud option. All "Environment" labels renamed to "Variables"
- **`${ROCKETRIDE_*}` variable autocomplete**: node config fields now offer autocomplete suggestions for defined pipeline variables. `useEnvVarAutocomplete` hook detects `${` trigger and filters keys by partial match. `EnvVarSuggestions` popover with arrow-key navigation. Wired into `BaseInputTemplate`, `TextareaWidget`, and `ApiKeyWidget`. `transformErrors` suppresses RJSF validation errors for fields containing `${ROCKETRIDE_*}`. `rrext_validate` now resolves env vars before validation using the same merged env as pipeline execution. Fixed `getHttpUrl()` to normalize engineUri before parsing
- **Category headers in QuickAddPopup**: compatible services grouped by bold uppercase category headers with indented items. Shared `CATEGORY_TITLES` extracted to `categoryTitles.ts`. `CreateNodePanel` auto-expands matching categories during search, restores previous expand/collapse state when search is cleared. Environment protocol types extracted to prevent build errors
- **Server Monitor panel**: real-time dashboard showing connections, tasks, and aggregate metrics via new `getDashboard()` / `get_dashboard()` SDK methods (DAP `rrext_dashboard` command). Client identification (`clientName`/`clientVersion`) forwarded during auth handshake so server can distinguish "VS Code 0.9.4" vs "CLI 1.2.0". Python DAP client skips auth message when transport lacks `get_auth()` (fixes crash for non-WebSocket transports). Consolidated `ServicePython` log level into `DebugOut` (#595)
- **Other task viewer via ProjectWebview**: `PageStatusProvider` completely rewritten. Previously opened a lightweight `StatusWebview` that couldn't show the node graph (nodes squashed at top, no toolbar, missing servicesJson). Now fetches unresolved pipeline via `getTaskToken` + `getTaskPipeline`, creates panel using the full Canvas/ProjectView stack, sends `project:load` with `isReadonly:true`. Falls back to synthesized single-node project if fetch fails. `StatusWebview` deleted (#803)
- **Readonly canvas**: single `isReadonly` prop replaces two inconsistent lock mechanisms (14-boolean `IFlowFeatures` and partially-implemented `isLocked`). `effectiveLock = isReadonly || internalIsLocked`. Guards added to `addNode()`, `updateNode()`, `deleteNode()`, paste, context-menu, lane click, config panel Save, all previously unguarded. Lock button hidden when `isReadonly` (#803)
- **Save button in canvas toolbar**: always-visible floppy disk icon with dirty-state tracking; grayed when clean, brand-colored when dirty. `isDirty`/`isNew`/`onSave` threaded through `IFlowProps` → `FlowContainer` → `FlowProvider` → `FlowProjectProvider`. `FlowCanvas` defers ReactFlow render until container has non-zero dimensions via `ResizeObserver`. `canvas:requestSave` calls `document.save()` directly (#678)
- **Dirty-state save pattern for settings**: card header starts clean (no buttons); on edit, Cancel and Save appear; on save, buttons disappear and "Saved" flashes for 5 seconds then fades; Cancel reverts to last-saved snapshot. Applied to all 5 VS Code settings tabs and shell-ui settings page (#877)
- **Play button shows actionable text**: renamed idle label from "Play" to "Run Pipeline". Added STOPPING state with "Stopping..." disabled button to prevent double-clicks. Widened hover expansion for longer label. Smooth CSS transitions with easing functions (#575)
- **Improved stop button feedback**: Pipeline Observability screen handles `TASK_STATE.STOPPING` with "Stopping..." disabled state and distinct orange styling, preventing duplicate clicks (#549)
- **Simplified sidebar footer**: replaced popup menu (three redundant gear icons all opening Settings) with flat layout when connection is shared and no cloud account. Documentation and Settings buttons rendered directly, connection status inline, announcements ticker rotates cards every 7 seconds. Full popup preserved for cloud account or independent connections. Panel sash restyled with native `--vscode-sash-hoverBorder` token, widened from 2px to 4px
- **Test Connection button**: available on service/docker/onprem panels via `ioControl('test')`
- **Docker GHCR tag fetching**: global cache for prerelease resolution with 15s timeout on HTTPS requests. Split-button dropdowns with grouped "Recommended" / "All versions" headers. Version metadata persisted per instance lifecycle. Linux package manager auto-detection (apt/dnf/yum/pacman) instead of hardcoded apt-get
- **Version tracking**: persistent `version.local.json`, `version.service.json`, `version.docker.json` files. PID liveness check before preserving `.pid` files during engine dir clear. Guard against phantom installs (missing binary). UAC-cancel fallback and uninstall.ps1 fixes
- **Event naming unification**: all connection events renamed to `shell:*` namespace matching cloud-ui vocabulary. `'event'` → `'shell:event'`, `'connected'` → `'shell:connected'`, `'connectionStateChanged'` → `'shell:statusChange'`, etc. All 10 providers renamed to drop redundant `Page` prefix. All 9 view directories renamed similarly (#803)
- **`.env` file management removed**: ~350 lines of env file handling removed from `ConfigManager` (envFileWatcher, envRawText, parseEnvFile, saveEnvFile, syncSettingsToEnv, etc.). Environment variables for pipeline variable replacement are now managed server-side (layered env in DB). Extension no longer maintains workspace `.env` file. URL resolution consolidated into `ConnectionManager` (per-group, not hardcoded to dev group) (#803)
- **On-demand env loading**: replaced 7 env-specific `AccountView` props with 2 generic callbacks (`onLoadEnv`, `onSaveEnv`) plus `refreshSignal`. Each `EnvScopeCard` requests its own data on mount. Promise-based messaging with 10s timeout. `shell:accountUpdate` as first-class event (no longer filtered from generic stream). Standalone `BillingProvider` deleted; billing is a tab inside Account (#803)
- **Welcome page simplification**: `welcomeDismissed` set automatically on save (no manual checkbox). Works from both Welcome and Settings pages (#803)

#### Shell UI (Web Host)
- **Shell-ui replaces cloud-ui**: new Module Federation host application served by Python `shell` module (`ai.modules.shell`) with public HTTP routes for SPA and all static assets under `/shell/`. Unifies OSS and SaaS into single codebase. Server-side app manifest delivery via `get_public_apps()` / `get_apps_for_user()` on AccountBase. Pre-auth info probe returns public apps for marketplace. Connect response includes authenticated user's full entitled app list (#803)
- **MUI removal**: replaced Material UI with plain CSS/HTML across entire shared-ui package; runtime theme system with light/dark JSON tokens
- **Theme rebrand**: replaced legacy purple (#5900FF) with cyan (#00b9ec) TOKENS palette. Light theme updated to warm-neutral (cream/stone backgrounds instead of pure white) (#803)
- **Theme flash fix**: `index.html` inline script sets `--rr-bg-default` and body background synchronously before React renders. `createShellConfig` reads saved theme from localStorage instead of always defaulting to rocketride-light, eliminating tan background during 1.5s OAuth code-exchange window (#878)
- **Chat module**: host-agnostic chat surface following established module pattern (props-in, callbacks-out, `--rr-*` CSS tokens). `ChatView` (MessageList + ChatInputField), `MessageBubble` (user/bot/system/status with markdown), `MarkdownRenderer` (react-markdown + GFM + syntax highlighting + charts), `ChartRenderer` (chart.js with circular-reference guard), `TypingIndicator` (animated bouncing dots), `useChatMessages` hook (message state + sendMessage + monotonic IDs) (#724)
- **Canvas state persistence**: viewport (zoom/pan), lock state, snap-to-grid, and editor mode now persist in `.pipe` files via `PipelineConfig` schema (TypeScript + Python SDKs). New `isFlowReady` boolean state tracks when all nodes have been rendered/measured by ReactFlow, replacing scattered `setTimeout`/`requestAnimationFrame` workarounds. Centralized `loadCanvas(nodes, edges)` as single entry point for structural canvas changes. Viewport restored on load via `isFlowReady` cycle, falls back to fitView. Spiral search for non-overlapping node placement. `EmptyCanvasPrompt` only shown when `nodes.length === 0 AND isFlowReady` (#670)
- **ProjectView architecture**: decomposed monolithic `modules/flow/` canvas module into composable multi-view project architecture (#670)
- **Style consolidation**: added `buttonPrimarySmall`, `buttonSecondarySmall`, `buttonDangerSmall`, `modalDialog`, `modalHeader`, `modalBody`, `modalFooter` to `commonStyles`. Added `cardHeaderButton`/`cardBodyButton` size modifiers for card contexts. Eliminated `Btn` wrapper component. Account `shared.tsx` trimmed from ~30 to 9 entries. All emojis removed from account UI (#803)
- **Shared connection types**: `ConnectionState` enum, `ConnectionMode`, `IAuthProvider`, `IConnectionManager` interface, `ShellAppEntry`, `ShellConnectionEventMap` with typed payloads for all `shell:*` events. Index signature for app-defined events (#803)

#### Billing, Account & Auth
- **Billing detail**: `BillingDetail` type gains `planNickname`, `unitAmount`, `billingInterval`, `currentPeriodStart` in both SDKs. Subscription cards show detail grid with plan info. Cancel subscription requires confirmation modal. App display name shown instead of raw appId. Credit grant summary per subscription using `creditLabels` from Stripe metadata (#803)
- **Account/Billing merge**: Billing is now a tab inside Account (2nd pill) via `BillingPanel`. Standalone Billing page and provider deleted
- **Permission enforcement**: frontend computes `isOrgAdmin`/`isTeamAdmin` from profile; action buttons hidden for users without required permissions; `OrganizationPanel` read-only for non-admins; destructive actions go through confirmation modals. Team admin enforcement: must always have ≥1 admin (UI + server guard). Permission key fixed: `'admin'` → `'team.admin'`. `_require_team_admin` queries DB directly instead of stale cache (#803)
- **Team-based task permissions**: replaced all `control.userId == caller.userId` ownership checks with `resolve_task_permissions()` so teammates and org admins can monitor/control each other's tasks. Permission strings (e.g. `'task.control'`, `'task.monitor'`) checked against resolved list (#803)
- **Layered environment secrets**: pipeline variables (`ROCKETRIDE_*`) stored encrypted (Fernet) in database per org/team/user scope, merged server-side during task execution. Merge order: `.env` → org → team → user → caller env. `get_merged_env()` on `AccountBase` with OSS (`.env` only) and SaaS (DB) implementations. `client.use()` `env` param for caller overrides (only `ROCKETRIDE_*` accepted). Client-side `processEnvSubstitution` removed, resolution is server-only (#803)
- **Session keys**: API keys are now true PATs inheriting user identity. `is_session` flag on `ApiKey` model. `ensure_session_key()` on every OAuth login: refreshes 90-day expiry if active, creates fresh key if expired/missing. Session keys cannot be self-revoked. Admin revoke is hard-delete. Housekeeping: keys revoked >30d purged on login. UI shows "Session" / "Interactive login" badge (#803)
- **Scoped PATs**: PATs optionally restricted to single team with explicit permissions. Effective permissions intersected with user's actual permissions at auth time (can never escalate). Optional `team_id` on `ApiKey`. Create key modal: team dropdown + conditional `PermGrid`. Key list shows team scope badge (#803)
- **userToken → userId refactor**: server-side event tenant scoping uses `userId` instead of `userToken`. Fixes bug where two connections from same user with different keys wouldn't see each other's dashboard events (#803)
- **Account UI overhaul**: all card headers use `commonStyles.labelUppercase`. Save button pattern: hidden until dirty, shows [Cancel][Save], "Saved" green text with 5s timer. `ProfilePanel`: single "Organizations / Workspaces" card with nested teams. `TeamsPanel`: Delete moved to list with confirm modal. `PermGrid`: `PERM_DISPLAY` labels, alphabetized, added `task.store`, contrasting text on checked tiles (#803)
- **Client SDK attach/login split**: replace monolithic `connect()`/`disconnect()` with layered API: `attach(uri?)` opens WebSocket without auth (for public APIs like catalog), `login(credential?)` sends DAP auth, `logout()` sends new `deauth` command (reverts to unauthenticated without closing socket), `detach()` tears down WebSocket. Old `connect()`/`disconnect()` preserved as backward-compatible wrappers. Reconnection engine rewritten around `_desiredState` model ('detached' | 'attached' | 'authenticated'). Linear backoff (250ms increments, 15s cap), reconnection never gives up. Auth credential removed from transport layer (#803)
- **Server-driven appStatus**: replaced `subscriptionStatus` with server-computed `appStatus` ('auth' | 'free' | 'unsubscribed' | 'subscribed' | 'trialing' | 'past_due' | 'canceled') and `onDesktop` boolean per app manifest entry. Eliminates client-side reconciliation races (#803)
- **App mode & subscription gating**: `mode` field (free/subscription/paywall) in app manifests. Shell-level subscription gate blocks app iframe until active subscription exists. Desktop app management moved into account identity flow (#803)
- **Token storage hardened**: moved from `localStorage` to `sessionStorage` (cleared when tab closes) addressing CodeQL "Clear text storage of sensitive information" alert (#803)

#### Profiler
- **DAP-based cProfile system**: replaced HTTP-endpoint profiler module with per-process cProfile profiling over DAP connections. Any connected client can profile any process (task server, data engine subprocesses, model server). `CProfileManager` singleton with start/stop/status/report/release API. Owner tracking per connection with disconnect cleanup. SDK methods: `cprofileStart`/`cprofileStop`/`cprofileStatus`/`cprofileReport` (TS + Python) with optional `target` parameter for pipeline profiling. New `profiler-ui` Module Federation remote app with `ProfilerView`, `ConnectionManagerView`, and `ProfilerSidebar` (#803)

#### Module Federation
- **MF stability**: added `runtime: false` to all remote apps (shell-ui provides shared runtime; without it each remote embeds its own runtime copy, causing remoteEntry.js to change on every rebuild and version-mismatch errors during HMR). Added `eager: true` to react/react-dom shared configs (breaks async shared-scope negotiation deadlock where host waits for remote's async chunk and remote waits for host). App loader filters out server-only entries with no `remoteEntry` URL (prevents `normalizeRemote()` crash on `undefined`) (#877)

#### Engine & Core
- **Database EXECUTE**: direct SQL/Cypher execution via `QuestionType.EXECUTE` with `client.database.query()` namespace on both SDKs, bypassing LLM translation and safety gating. Gated behind opt-in `allow_execute` config (default off). Results bounded with `fetchmany(max_execute_rows+1)` (default 25000). Neo4j results capped at same limit. `allow_execute` parses strings strictly: only `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive). EXECUTE output wrapped in try/except; serialized with `default=str`. SDK validates non-empty token/sql before dispatching
- **Database DIALECT**: `QuestionType.DIALECT` for engine capability discovery. SDK callers can ask which engine a database pipeline is connected to (`DatabaseDialect` enum). `_db_dialect()` abstract method on `DatabaseInstanceBase`. `services.json` now exposes UI-toggleable `allow_execute` boolean
- **Handle-based streaming I/O**: generic filesystem-style interface (`open`/`read`/`write`/`close`/`delete`/`stat`/`mkdir`/`list_dir`) on `FileStore`, replacing monolithic in-memory buffering. Domain methods become thin convenience wrappers on client SDKs. Supports S3 multipart upload (5 MB buffer), Azure staged blocks (4 MB buffer), and local filesystem. Handles tagged with owning `connection_id` and force-closed on connection termination (#600)
- **`@tool_function` decorators**: collapsed the two-class pattern (IInstance + ToolsBase driver) into a single class. Any `IInstanceBase` subclass can declare tool entry points with a decorator; the method name becomes the tool ID, decorator carries schema/description, base class `invoke()` dispatches automatically. Eliminates parallel driver classes, factory methods, and boilerplate delegation (#599)
- **Experimental + Deprecated capability flags**: `DEPRECATED = BIT(15)`, `EXPERIMENTAL = BIT(16)` in `PROTOCOL_CAPS`. Both flags wired through C++ parser, pybind11 bindings, both client SDKs, and shared-ui. Yellow "EXPERIMENTAL" badge rendered on canvas nodes, Add Node slider, and Quick Add popup (#606)
- **Docker-compose and healthcheck**: `HEALTHCHECK` instruction in `Dockerfile.engine` using curl to `/ping`. `docker-compose.yml` with engine, PostgreSQL+pgvector, Milvus (+ etcd, MinIO), ChromaDB. Override file for dev hot-reloading. All images pinned to specific versions. Security warnings in `.env.example` (#496)
- **Billing commands mixin**: `BillingCommands` in TaskConn's MRO for `rrext_account_billing`. OSS implementation routes on `arguments.subcommand` with stubs so UI doesn't hang in half-rendered state (#692)
- **Task engine extraction**: `task_engine` and `cmd_data` extracted as standalone modules (#661)
- **GPU inference billing**: `metrics.resource('gpu')` context manager times inference. `CONST_RATE_GPU_INFERENCE_SECOND` for billing. Custom node counters (`pagesProcessed`, etc.) with configurable rates. All 9 AI model files wrapped with `metrics.counter('gpu_inference_count')` + `metrics.resource('gpu')`. Billing reports include `gpu_inference` and `custom` token fields (#803)
- **Metrics rewrite**: replaced Timer class and `resource()` context manager with flat `MetricsManager`: `timer()`, `add_time()`, `counter()`, `event()`. Thread-safe via single lock. Removed per-pipe `ContextVar`, metrics are per-subprocess. ModelClient auto-records server-reported perf dict (#803)
- **ModelClient refactor**: derived from `RocketRideClient` with `ws_path='/models'` so URI normalization, protocol selection, and auth are handled by SDK. Python SDK gains `ws_path` kwarg. Sync `disconnect()` override for worker thread callers. All 9 model wrappers updated. `get_model_server_address()` simplified to return raw string (#877)
- **Model server DAP namespace**: all model server commands renamed to `rrext_ms_*` prefix (load_model → rrext_ms_load_model, etc.) for disambiguation from core DAP commands (#803)
- **GPU guard**: `install_gpu_guard()` blocks direct torch/tensorflow imports in model server mode; all GPU inference must go through ModelClient RPC (#803)
- **Pipeline error surfacing**: `binder.cpp` sets `completionCode` on Entry when `callMethods` encounters error. `bindings.cpp` exposes `completionError` read-only property. `data_conn.py` rewrites `close_sync()` to always extract results even when end/close throws, surfaces `Entry.completionError` when `objectFailed` is True. Errors now reach dropper UI (#803)
- **`rrext_get_pipeline` DAP command**: returns task's unresolved pipeline (with `${...}` placeholders intact) so VS Code can reconstruct node graph without exposing secrets. `_build_task()` now accepts explicit resolved pipeline, `self._pipeline` retains original unresolved form (#803)

#### Client SDKs: New Features

**Layered connection API (both SDKs):**
- `attach()` / `detach()`: open/close the WebSocket without authentication. Enables unauthenticated operations (public catalog browsing, server probes) before the user logs in
- `login()` / `logout()`: authenticate/deauthenticate over an attached transport. `login()` returns `ConnectResult` with full user identity (userId, organizations, apps, teams, permissions). `logout()` sends new `deauth` DAP command, reverting to unauthenticated without closing the socket. Supports credential rotation (auto-logout if a different credential is supplied)
- `connect()` / `disconnect()` preserved as backward-compatible wrappers (`attach` + `login` / `logout` + `detach`), but `connect()` now returns `ConnectResult` instead of void
- `isAttached()`: true when WebSocket is open (regardless of auth)
- `isAuthenticated()`: true when auth handshake has succeeded

**Namespaced API accessors (both SDKs):**
- `client.account`: profile, API keys, org, members, teams, environment variables (`get_env()` / `set_env()` / `get_environment_keys()`)
- `client.billing`: subscriptions, checkout, credits, cancel
- `client.database`: `client.database.query()` for direct SQL/Cypher execution; `client.database.dialect()` for engine discovery (`DatabaseDialect` enum)

**New methods:**
- `RocketRideClient.getServerInfo(uri)` (static): probe a server for capabilities without authenticating. Returns `ServerInfoResult` with version, capabilities, platform, and public apps
- `getTaskToken(projectId, source)`: resolve a running task's session token
- `getTaskPipeline(token)`: retrieve the unresolved pipeline for a running task (placeholders intact, no secrets)
- `getDashboard()`: real-time server dashboard (connections, tasks, metrics)
- `cprofileStart/Stop/Status/Report`: per-process cProfile profiling over DAP
- `call(command, token?, **kwargs)` (Python): single public entry point for all typed DAP operations with optional `on_trace` callback

**TypeScript-specific additions:**
- `wsPath` config option for custom WebSocket paths (e.g. `'/models'` for model server)
- `onTrace` callback for observing all `call()` traffic
- `MonitorKey` type and `addMonitor()` / `removeMonitor()` for reference-counted monitor subscriptions
- `restart()` method for restarting pipeline tasks
- Filesystem API: `fsOpen()`, `fsRead()`, `fsWrite()`, `fsClose()`, `fsDelete()`, `fsListDir()`, `fsMkdir()`, `fsRmdir()`, `fsStat()`, `fsRename()`, `fsReadString()`, `fsWriteString()`, `fsReadJson()`, `fsWriteJson()`: replaces the old project store methods
- `getTaskStatus()` applies default 15s timeout (configurable via `options.timeout` or `{ timeout: false }`)
- `validate()` now returns typed `ValidationResult` (was `Record<string, unknown>`)
- `getServices()` now returns typed `ServicesResponse`; `getService()` returns `ServiceDefinition`
- `DataPipe.open()` sets `_opened` only after successful SSE setup with rollback on failure
- `normalizeUri()` preserves user-specified port (was being stripped for scheme-default ports like :443)

**Python-specific additions:**
- `ws_path` kwarg for custom WebSocket paths
- `client_name` / `client_version` kwargs forwarded in auth handshake for client identification
- `on_trace` callback for observing all `call()` traffic
- `public` mode for permanently unauthenticated connections (only `rrext_public_*` commands)
- `DashboardMixin`, `CProfileMixin`, `StoreMixin` added to MRO
- Improved `send()` pipe error context with `PipeException` (catchable as `RuntimeError`)

**New types (both SDKs):**
- `ConnectResult`, `ServerInfoResult`, `AppManifestEntry`, `StripePriceEntry`
- `AccountProfile`, `AccountOrganization`, `AccountOrgTeam`, `ApiKeyRecord`, `OrgDetail`, `MemberRecord`, `TeamRecord`, `TeamDetail`, `TeamMemberRecord`
- `BillingDetail` (extended with `planNickname`, `unitAmount`, `billingInterval`, `currentPeriodStart`, `credits`, `creditLabels`), `StripePlan`, `CreditBalance` (extended with `labels`), `CreditPack`
- `PROTOCOL_CAPS` enum with all 17 capability flags
- `SERVICE_DEFINITION`, `SERVICES_RESPONSE`, `VALIDATION_ERROR`, `VALIDATION_RESULT`
- `DASHBOARD_OVERVIEW`, `DASHBOARD_MONITOR`, `DASHBOARD_CONNECTION`, `DASHBOARD_TASK`, `DASHBOARD_RESPONSE`, `DASHBOARD_EVENT` and 7 event subtypes
- `TASK_EVENT`, `TASK_EVENT_FLOW`, `TASK_EVENT_RUNNING`, `TASK_EVENT_BEGIN`, `TASK_EVENT_END`, `TASK_EVENT_RESTART` (replace old `EVENT_TASK`)
- `EVENT_STATUS` (replaces `EVENT_STATUS_UPDATE`)
- `TASK_TOKENS` extended with `gpu_inference` and `custom` fields
- `CreateKeyParams` accepts optional `teamId` for scoped PATs
- `EVENT_TYPE.DASHBOARD` flag (bit 7) for server-level events; `EVENT_TYPE.ALL` updated to include it
- **Config**: `Config.getNodeConfig()` emits warnings for deprecated profiles with migration guidance from profile's `migration` field

#### MCP
- **MCP Resources and Prompts**: `rocketride://` URI resources (pipeline list, server status, node registry) with graceful error handling for disconnected clients. Three prompt templates (analyze-document, chat-with-data, evaluate-pipeline) with required argument validation and message rendering. 44 tests (#541)

#### Agents & Pipelines
- **Agent framework overhaul**: ProjectView architecture with shared-ui migration (#670)
- **Example pipeline templates** for common AI workflows (#572)

#### Build System
- **Rsbuild upgrade**: all UI apps upgraded from pinned 0.4/1.1 to ~1.7.5, eliminating Node.js `DEP0180` deprecation warnings in Node 22+. ESM config migration (`.ts` → `.mts`). cmake minimum bumped from 3.14 to 3.19. `@rspack/binding-*` platform pins removed. Service config renamed `config.json` → `service-config.json` with migration (#905)
- **Build-input caching**: source fingerprinting (`buildInputHash()` + `hasBuildInputChanged()`) skips UI modules whose inputs haven't changed. `appModule.js` factory eliminates ~80 lines of boilerplate per app. Shell-ui tracks own src/ + shared-ui/src + package.json. `--force` flag bypasses caching. Clean actions clear cached hashes (#877)
- **Builder CLI**: `server:run` action (build + run without shell-ui dev server). `--taskserver=ADDR` replaces `--testport`. `--modelserver` semantics clarified (bare flag = start local, `=ADDR` = use existing). `--simulate-gpus=N` forwarded to model server. `parseServerAddress()` utility (#803, #877)

#### CI/CD
- **Cosign container signing**: keyless signing of rocketride-engine image via Sigstore + GitHub OIDC (signs by digest). GPG detached-signature step for server tarballs/zips, gated on `GPG_SIGNING_KEY` secret (#798)
- **Dependabot**: weekly version updates with smoke tests for litellm and pipeline-node deps. Blocked rsbuild/rslib/rspack 0.x churn and pip major bumps. Semver-major ignores across all 10+ ecosystems (#788, #843, #842, #862)
- **Experimental-release workflow**: `workflow_dispatch`-only, builds from arbitrary branch under configurable tag suffix. Per-product release jobs. No marketplace publishing. `prerelease: true`. First use case: workshop builds (#848)
- **Nightly prereleases**: initially from stage branch (#631), moved to develop on green CI (#713). `workflow_dispatch` expanded to develop/stage/main (#906)
- **Daily Actions storage cleanup** workflow (#636)
- **Discord notifications**: PRs, issues, discussions with live CI check status and PR state tracking in embed (#612, #614, #638). Duplicate posts on discussion edits prevented (#698). Retry/backoff for webhook calls (#797)
- **Ruff and gitleaks**: pre-commit checks (#722); gitleaks made blocking (#681); `ruff format` applied to all Python files (#723)
- **Sequential builder tests** to isolate cross-suite flakes (#734)
- **cmake 4** support (#807)
- **Actions pinned** to immutable commit hashes (#483)
- **Artifact retention** dropped to 1 day for 0.5 GB storage cap (#779)
- **CodeQL** switched from advanced to default setup (#768)

#### Documentation
- **Observability & tracing**: integration guide documenting how external services consume runtime logs, lifecycle events, and pipeline traces over the WebSocket DAP channel. Wired into all agent stubs (Claude Code, Cursor, Windsurf, Copilot) (#716)
- **Node usage guides**: `db_neo4j` with practical examples (#490), `llm_openai` with provider examples (#493), source connectors (#650)
- **Per-node documentation** overhaul, added and updated docs for each node (#639, #660)
- **Engine**: Tika ExternalParser media tool requirements (#729)
- **Python client**: clarified `send()` sources and `.pipe` usage (#705); updated Python 3.8 → 3.10 references (#657); added `.env.example` (#492)
- **Contributing**: require green CI checks before review (#627)
- **SOC2-ready SECURITY.md**: explicit triage/remediation SLA (critical 7d, high 30d, medium 90d), scanning toolchain documentation (CodeQL, Scorecard, Trivy, Dependabot, secret scanning), quarterly access reviews (#762)
- **Two-person control** on alert dismissals documented (#800)
- **Code of Conduct** (#591)
- **README improvements**: onboarding wording, absolute image URLs, GIFs, Product Hunt badge (#706, #506, #478, #590)

#### Security Policies
- **Workflow permissions**: top-level permissions added to 5 reusable workflows (#790); storage-cleanup narrowed to job-level (#794)
- **Stale lockfile removed**: `packages/client-typescript/pnpm-lock.yaml` deleted, override declared in root (#796)

### Changed

- **LLM provider migration**: all LLM providers migrated to `ai.common.LLMBase` (#719); automated LLM model sync tool fetches models from provider APIs, smoke-tests new ones, merges into `services.json` with smart deprecation and three-source token limit resolution (provider API → OpenRouter → LiteLLM). `modelSource` field tracks discovery origin. Weekly CI workflow opens PR with sync report. `builder models:update` command (#651)
- **llm_gemini model profiles**: added `gemini-3.1-pro-preview`, `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-3-pro-image-preview`; standardized `gemini-2.5-*` dot notation; deprecated profiles retained with migration guidance
- **Removed `llm_vertex` node**: Vertex AI now supported via `llm_gemini`; migrated vision nodes to `LLMBase`; fixed `llm_gemini` API key validation (dropped strict `startsWith('AI')` check, added sub-key fallback for old pipe files where sub-key is `profile.split('_',1)[1]`); fixed `validateConfig` to early-return when apikey is empty (secure fields not decrypted at validate time); removed vertex icon from UI; bumped client-typescript SDK to 1.1.0 (#902)
- **OpenAI models** updated to latest (#503); deprecated Gemini models removed (#500)
- **Service config cleanup**: removed obsolete `input` section from 72 service configuration files (was duplicate of lane declaration, closes #629) (#728)
- **Milvus node**: configurable timeout (default 60s, was hardcoded 20), connection error handling with meaningful messages, bulk insert with configurable batch size (default 50, was one-at-a-time), `_batchUpsertResults()` helper for markDeleted/markActive, timeout on `remove()`, COSINE distance score range [0,2] rescaling documented (#562)
- **Node tests parallelized** with pytest-xdist (#700)
- **Tool input helpers**: `normalize_tool_input()` replaces 4 copy-pasted variants across tool nodes. `require_str`/`require_int`/`optional_str` replace local validators (44 callsites in `tool_github`). `require_str` now raises `ValueError` cleanly on non-string inputs (was `AttributeError`). `require_int` rejects `bool` (an `int` subclass). 41 unit tests (#759, #766)
- **Backward-compat DAP token fallback**: `get_task_token()` checks `arguments.token` first, falls back to `request.token` for older clients (#902)
- **pnpm** pinned via `packageManager` field (#623)
- **Version bump**: all release packages bumped to next minor (server 3.1.2 → 3.2.0, chat/dropper-ui 2.0.1 → 2.1.0, all others 1.0.x → 1.1.0)
- **engines.node** bumped from ≥18.0.0 to ≥20.0.0 (aligns with serialize-javascript@7 requirement and CI reality)
- **Provisioning**: creates Development + Production teams (Production default); `build_api_key` uses random nonce
- **VSCode detection**: chat-ui/dropper-ui changed from `window.parent !== window` to checking for `acquireVsCodeApi` (canonical detection)
- **Lefthook**: sequential mode; disabled colors to fix terminal corruption on Windows

### Fixed

#### Security
- **Critical: RCE**: prevent arbitrary module injection via `/use` endpoint. Added `ALLOWED_MODULES` frozenset whitelist restricting dynamic imports to 10 known service modules. Requests for any other module return 400 (#342)
- **Critical: Injection**: prevent filter expression injection in Milvus vector store (#355)
- **Auth**: require authentication for profiler endpoints; escape HTML output (#362)
- **Env expansion**: restrict `${VAR}` expansion in pipeline configs to allowlisted prefixes (`ROCKETRIDE_`, `PIPELINE_`, `NODE_`, `ROCKET_`); all others replaced with `<REDACTED>` to prevent exfiltration of AWS keys, DB URLs, tokens (#359)
- **Temp files**: use secure temporary file creation in task engine (#356)
- **SQL safety**: switch from blacklist to allowlist approach (#577)
- **Path traversal**: use `pathlib.is_relative_to` checks (#580)
- **Redaction**: expand sensitive field redaction patterns in VS Code logger (#578)
- **Input validation**: add validation/sanitization to LLM chat drivers (#559)
- **Rate limiting**: add rate limiting to `tool_http_request` node (#560)
- **Remote nodes**: improve error handling in remote node execution (#565)
- **Pinned deps**: handlebars + protobufjs via pnpm.overrides (#783)

#### Client SDKs: Fixes
- **Python client**: break drain cycle causing `RecursionError` on disconnect, `_drain_message_tasks` walks each candidate's `_fut_waiter` chain and excludes tasks that transitively await the drainer itself, so the gather can never close back on itself. `dap_client.request()`'s `ConnectionError` handler now uses fire-and-forget `self._transport.disconnect()` instead of `await self.disconnect()` (develop's `disconnect()` is sync-returns-Task). Two regression tests pinning each fix (#792)
- **Python client**: clean pending DAP request on send failure, prevents zombie futures accumulating on flaky connections when the WebSocket drops mid-request (#736)
- **Python client**: align `requires-python` with monorepo target (py310), was still declaring py38 (#491)
- **Python client**: `set_env` now updates `os.environ` in-memory (removes stale `ROCKETRIDE_*` keys, then sets new values) before writing the `.env` file, so `get_env` reflects changes immediately without a server restart. Uses `sys.executable` instead of `sys.argv[0]` for the `.env` file location
- **Python client**: `ws_path` composition uses `parsed._replace` instead of string concatenation to avoid malformed URIs
- **Python client**: popped consumed kwargs (`ws_path`, `client_name`, `env`, etc.) before passing to `super().__init__()` to avoid "multiple values for keyword argument" `TypeError`
- **TypeScript client**: preserve user-specified port in `normalizeUri`, the URL API silently strips scheme-default ports (:443 on https, :80 on http); now checks raw input for explicit `:digits` after the scheme before deciding whether to add default port (#377)
- **TypeScript client**: `DataPipe.open()` sets `_opened` only after successful SSE setup; on `setEvents` failure, rolls back via `close()` so the server pipe is not left half-open. `close()` now also handles the case where server assigned `pipe_id` but `_opened` was never set to true (#704)
- **TypeScript client**: `DataPipe.close()` sets `_opened = false` in the finally block, preventing double-close races
- **TypeScript client**: `connect()` treats empty or whitespace-only `ROCKETRIDE_APIKEY` in the client env snapshot as **unset**, so it does not override constructor-provided auth (#704)
- **TypeScript client**: `getTaskStatus` applies a default per-request timeout of 15s so CI doesn't hang indefinitely on a dead task; callers can pass `options.timeout` (ms) or `{ timeout: false }` to skip (#704)
- **Both clients**: pipe error messages now include common-cause diagnostics (pipeline not running, wrong source type, MIME mismatch) to reduce debugging time
- **SDK connect error callback type** corrected, was typed incorrectly in the TypeScript client (#576)
- **`CreditBalance` type** aligned with backend camelCase wire shape (#714)

#### VS Code Extension
- **Chat webview blank screen**: realigned `view:ready` handshake so chat panel renders after extension reload (#688)
- **Explorer empty-state**: clicking +File/+Folder on empty PIPELINES tree was silent no-op (input row gated on `entries.length > 0`). Now renders input when root-level create is pending. Stale `selectedPath` falls through to root when all entries deleted (#901)
- **Annotation double-click**: annotation nodes advertised "Double-click gear to add content..." but gear was hidden until hover (CSS opacity:0→1), opened on single-click not double-click, and body had no `onDoubleClick`. Added `onDoubleClick` on annotation root, updated placeholder text (#901)
- **Team selector**: cloud team selector not appearing after sign-in because team fetching was embedded inside cached `probeServerInfo()`. Decoupled into separate `fetchCloudTeams()` driven by `useEffect([isSaas, cloudSignedIn])` (#877)
- **Billing app names**: subscription cards showing raw `appId` instead of human-readable name. Added full `apps` manifest prop chain so components build own `appId → app` lookup map (#877)
- **Canvas-played pipelines** now register in sidebar menu (#571)
- **Missing hostname** handled in URI parsing (#530)
- **OSX Python path** for Python-EaaS debugger (#693)
- **Dark mode**: fixed icon and edge visibility in flow builder (#597)
- **UI validation** fixes (#767)
- **Icons and coloring** for Bland, GMI, and trash bin (#634)
- **QuickAdd popup** label copy improved (#679)
- **Product Hunt badge**: converted SVG to PNG (marketplace rejects SVGs)

#### Engine & Nodes
- **LLM**: clear correct `_chat` reference in `endGlobal` across all LLM nodes (#531)
- **Milvus**: apply `retrieval_score_threshold` filter in `searchSemantic` (#726)
- **Database**: bound Neo4j EXECUTE rows; parse `allow_execute` strictly (only '1'/'true'/'yes'/'on')
- **Frame grabber**: user-configured interval was being ignored (#675)
- **Pipeline configs**: error handling for missing configuration files (#544)
- **Mutable defaults**: replaced mutable default arguments with `None` across Python nodes (#582)
- **Chunk scoping**: `_processFullTables` used stale `doc` variable from outer loop and called `Doc()` with invalid constructor params. Fixed to reset `page_content` on chunk itself. Follow-up: fixed score assignment that replaced Doc with float, and first-chunk aliasing that dropped text (#776)
- **Mock truthiness**: `psycopg2`: `isinstance(False, int)` is True, so `isDeleted=False` was matched as LIMIT value (added `not isinstance(p, bool)` guard). `chromadb`: `if limit and ...` treated `limit=0` as falsy (changed to `limit is not None`). `weaviate`: `distance if distance else 1.0` collapsed 0.0 (exact match) to 1.0 (changed to `distance is not None`) (#748)
- **Async safety**: `_message_tasks` set accessed from multiple async contexts without a lock (#535)
- **CLI shutdown**: SIGINT/SIGTERM handlers with proper exit codes (130/143), double-signal force exit, 5s cleanup timeout, idempotent `cleanupClient` via dedup promise, `isCancelled` guards on command actions, `run()`/`main()` shutdown awareness via `awaitShutdown()` (RR-655, #891)
- **setuptools**: bootstrapped alongside wheel for `uv pip compile`, legacy sdists (e.g. `docopt 0.6.2` via kokoro → misaki → num2words chain) need setup.py but uv doesn't supply setuptools when build isolation is off (#871)
- **Cloud port**: corrected from 433 to 443 in `services.json` (#684)
- **LLM providers**: small cleanup across all LLM nodes (#645)
- **Auth token precedence**: URL auth param prioritized over stale sessionStorage token from previous task (#902)
- **AVIReader**: capture errors from background `_data_process` thread and re-raise on `stop()` so pipeline errors surface as task errors (#803)
- **Webhook/Telegram nodes**: removed `server.use('profiler')` calls (profiler module was deleted; these caused "Module 'profiler' is not allowed" crash) (#803)
- **Task auth**: removed early `ValueError` on empty credential that prevented anonymous/no-key OSS connections from reaching auth check (#803)

#### CI/CD
- **Open VSX**: handle 'already published' error in release workflow (#480)
- **Docs-only PRs**: build passthrough so they don't block CI (#607)
- **Flaky tests**: resolve timeouts and hanging in concurrent pipeline tests, shared hardcoded `project_id` caused server-side contention serializing subprocess launches (#561, #877)
- **Discord webhooks**: retry/backoff for webhook calls (#797); prevent duplicate posts on discussion edits (#698)
- **Nightly workflow**: explicit branch check on `workflow_run` trigger (#771); allow `workflow_dispatch` from stage and main (#906)
- **Release tags**: push via `WORKFLOW_PAT` with repo+workflow scope (#774)
- **pytest-xdist race**: all 6 path-traversal test methods shared same `outside.txt` in system temp root; fixed by wrapping `workdir` in per-test tempdir (#872)
- **pnpm-lock.yaml**: restore libc fields (#622); fix lucide-react dependency (#621)
- **CI API key**: use literal `ROCKETRIDE_APIKEY` in Test step instead of secret (#742); match GraphQL github-actions author login (#699)
- **ruff format**: pure whitespace fixes for vision node files that left develop CI red (#902)

#### Tests
- **AI unit-test coverage** grown from 8% to 43% (395 → 945 passing tests). Covers: sql_safety, common/util/validation/table, dap_conn, pipeline_validation, web endpoints, auth middleware, sandbox execution, profiler lifecycle, account/reporter/keystore, all command handlers, data_conn, task_engine state, task_server background loops, transports, task_http, store providers (S3 + Azure), DB base classes, dropper path-traversal guard. Assertions tightened per CodeRabbit review. CodeQL auth-callback URL assertions anchored (#831)
- **Tests realigned** with team-based permissions and metrics rewrite, updated mocks for `teamId`, `organizations`, `resolve_task_permissions`, `tokens.gpu_inference`/`tokens.custom`, renamed `apikey` → `user_id`. Dropped tests for deleted code. Added `test_cmd_public.py` (#870)
- **Node tests**: full improvements and mock cleanup (#687)

### Dependency Updates
- litellm ~1.50 → ~1.83 (#816)
- DOMPurify → 3.4.x (resolves 16 alerts / 8 GHSAs) (#886)
- cryptography pinned to 46.0.7 (#884)
- SQLAlchemy owned at ai layer, pinned ≥2.0,<2.1 (#804)
- Patched via pnpm.overrides:
  - **Routing**: react-router 6.26→6.30.3, @remix-run/router inlined (#914)
  - **Parsers**: ajv@8→≥8.18.0, markdown-it→≥14.1.1, postcss→≥8.5.10, prismjs→≥1.30.0, yaml@1→≥1.10.3 (#915)
  - **Middleware**: koa→≥2.16.4 (3 advisories), qs→≥6.14.2 (#916)
  - **Util/SVG**: svgo@2→≥2.8.1, flatted→≥3.4.2, immutable@5→≥5.1.5, underscore→≥1.13.8 (#917)
  - **Security**: picomatch@2→≥2.3.2, picomatch@4→≥4.0.4, fast-uri→≥3.1.2, serialize-javascript→≥7.0.5 (#890)
  - **Minimatch**: all 4 major lines patched (3→≥3.1.4, 5→≥5.1.8, 9→≥9.0.7, 10→≥10.2.3) (#887)
  - **Core**: undici→≥7.24.0 (6 advisories), lodash→≥4.18.0, lodash-es→≥4.18.0 (#888)
  - handlebars→≥4.7.9, protobufjs→≥7.5.5 (#783)
- Bumped: aiohttp, pygit2 1.15→1.19, soundfile 0.12→0.13, requests, ws 8.19→8.20, postcss 8.5.6→8.5.10, nltk, spacy, spacy-transformers, cymem, murmurhash, preshed, srsly, thinc, psycopg2-binary, pymysql, opensearch-py, npm-production group (adm-zip, tar, lucide-react, dockerode, web-vitals), shared-ui devDependencies (rollup, @types/react, @types/react-dom), cosign-installer, ossf/scorecard-action, gh-actions group (pnpm/action-setup, github/codeql-action, softprops/action-gh-release, dorny/paths-filter)

## [1.0.3] - 2026-03-01

### Added

- Docker image for one-click deploy (#126)

### Fixed

- Performance metrics reset on tab switch (#137)
- Engine crash on malformed pipeline input (#134)

## [1.0.2] and earlier

See [GitHub Releases](https://github.com/rocketride-org/rocketride-server/releases) for previous release notes.

[Unreleased]: https://github.com/rocketride-org/rocketride-server/compare/server-v1.0.3...HEAD
[1.0.3]: https://github.com/rocketride-org/rocketride-server/compare/server-v1.0.2...server-v1.0.3
