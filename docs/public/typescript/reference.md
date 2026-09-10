---
title: API Reference
sidebar_position: 10
---

# API Reference

The core public surface of the TypeScript SDK. Constructor options and
environment variables are on [Configuration](/clients/typescript/configuration);
exceptions on [Error Handling](/clients/typescript/errors).

## RocketRideClient

### Connection

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `attach` | `attach(uri?: string, options?: { timeout?: number }): Promise<void>` | `Promise<void>` | Opens an anonymous WebSocket attachment without authenticating. Public `rrext_public_*` requests are available. A URI override becomes the current endpoint. |
| `detach` | `detach(): Promise<void>` | `Promise<void>` | Cancels pending login and reconnect work, closes a CONNECTING or OPEN transport, and leaves the client detached. An in-flight login rejects with cancellation reason `detached`. |
| `isAttached` | `isAttached(): boolean` | `boolean` | Whether the WebSocket transport is open, regardless of authentication. |
| `login` | `login(credential?: string \| { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>` | `Promise<ConnectResult>` | Attaches if needed, authenticates, restores monitor subscriptions, and returns account data. The credential and URI may override construction-time values. |
| `logout` | `logout(): Promise<void>` | `Promise<void>` | Clears authentication while retaining an anonymous attachment. During an in-flight login it cancels all joined waiters with reason `logout` and establishes a fresh anonymous attachment. |
| `isAuthenticated` | `isAuthenticated(): boolean` | `boolean` | Whether authentication succeeded for the current attachment. |
| `connect` | `connect(credential?: string \| { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>` | `Promise<ConnectResult>` | Compatibility method that performs attach and login as one foreground operation. |
| `disconnect` | `disconnect(): Promise<void>` | `Promise<void>` | Best-effort logout/deauthentication, then cancels pending work and detaches. |
| `isConnected` | `isConnected(): boolean` | `boolean` | Compatibility **alias for `isAttached()`**; it does not imply authentication. |
| `setEnv` | `setEnv(env: Record<string, string>): void` | `void` | Replaces the client's environment map. `use()` uses it for `ROCKETRIDE_*` substitution; `login()` consults `ROCKETRIDE_APIKEY` when no explicit credential is supplied. |

Join/supersede semantics for concurrent logins are described on
[Connection](/clients/typescript/connection#concurrent-logins). The client also
supports `await using` (`Symbol.asyncDispose`).

### Pipeline execution

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `use` | `use(options?: { token?: string; filepath?: string; pipeline?: PipelineConfig; source?: string; threads?: number; useExisting?: boolean; args?: string[]; ttl?: number; pipelineTraceLevel?: 'none' \| 'metadata' \| 'summary' \| 'full'; name?: string; env?: Record<string, string> }): Promise<Record<string, any> & { token: string }>` | `Promise<{ token, ... }>` | Starts a pipeline. Pass either `pipeline` (object, used as-is — do not wrap it) or `filepath` (Node only). `pipelineTraceLevel` sets run-log trace verbosity, `name` a task display name, `env` per-run variable overrides. Returns at least `token`, plus `reused: true` when `useExisting` handed back an already-running instance instead of starting this pipeline. |
| `validate` | `validate(options: { pipeline: PipelineConfig \| Record<string, unknown>; source?: string }): Promise<ValidationResult>` | `Promise<ValidationResult>` | Validates a pipeline configuration without starting it; returns errors and warnings. |
| `terminate` | `terminate(token: string): Promise<void>` | - | Stops the pipeline for that token and frees server resources. |
| `getTaskStatus` | `getTaskStatus(token: string, options?: { timeout?: number \| false }): Promise<TASK_STATUS>` | `Promise<TASK_STATUS>` | Current task status (`completedCount`, `totalCount`, `completed`, `state`, `exitCode`, …). Per-call `timeout` defaults to 15000 ms; pass `false` to disable. |

### Data

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `pipe` | `pipe(token: string, objinfo?: Record<string, any>, mimeType?: string, provider?: string, onSSE?): Promise<DataPipe>` | `Promise<DataPipe>` | Creates a **streaming** data pipe: open, one or more writes, close. Default MIME: `application/octet-stream`. `onSSE` receives server-sent events. |
| `send` | `send(token: string, data: string \| Uint8Array, objinfo?: Record<string, any>, mimetype?: string, onSSE?): Promise<PIPELINE_RESULT \| undefined>` | `Promise<PIPELINE_RESULT \| undefined>` | Sends data in **one shot** (open, write once, close). No MIME auto-detection — default is `application/octet-stream`. |
| `sendFiles` | `sendFiles(files: Array<{ file: File; objinfo?: Record<string, any>; mimetype?: string }>, token: string, maxConcurrent?: number): Promise<UPLOAD_RESULT[]>` | `Promise<UPLOAD_RESULT[]>` | Uploads browser `File` objects through a worker pool capped at `maxConcurrent` (default **5**; must be a positive integer, else `RangeError`). Results resolve in the same order as `files`. Progress via `onEvent` as `apaevt_status_upload`. |

### Events

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `addMonitor` | `addMonitor(key: MonitorKey, types: string[]): Promise<void>` | - | Adds a reference-counted monitor subscription; events are delivered to `onEvent`. `MonitorKey` is `{ token }` or `{ projectId, source, pipeId?, teamId? }`. |
| `removeMonitor` | `removeMonitor(key: MonitorKey, types: string[]): Promise<void>` | - | Removes a monitor subscription; a type unsubscribes from the server only when its reference count reaches zero. |
| `setEvents` | `setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void>` | - | **Deprecated** — use `addMonitor`/`removeMonitor`. Subscribes the task (or optional pipe) to the given event types. |

### Services, validation, and ping

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `getServices` | `getServices(): Promise<ServicesResponse>` | `Promise<ServicesResponse>` | Lightweight **summaries** of every service, plus a deduplicated `icons` table and the server `version`. Full definitions come from `getService`. |
| `getService` | `getService(service: string): Promise<ServiceDefinition>` | `Promise<ServiceDefinition>` | One service's full definition (config schema included). **Throws** on failure — it never resolves to `undefined`. |
| `ping` | `ping(token?: string): Promise<void>` | - | Liveness check; throws on failure. Optional `token` for task-scoped ping. |

### Chat

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `chat` | `chat(options: { token: string; question: Question; onSSE? }): Promise<PIPELINE_RESULT>` | `Promise<PIPELINE_RESULT>` | Sends the `Question` to the pipeline and returns the result. `onSSE` streams server-sent events (e.g. token-by-token output). See [Chat](/clients/typescript/chat). |

### Convenience

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `getConnectionInfo` | `getConnectionInfo(): { connected: boolean; transport: string; uri: string }` | object | Current connection state and URI. |
| `getApiKey` | `getApiKey(): string \| undefined` | `string \| undefined` | The API key in use (debugging only; avoid logging in production). |

### Static

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `withConnection` | `RocketRideClient.withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T>` | `Promise<T>` | Creates a client, calls `connect()`, runs `callback(client)`, then `disconnect()` in a `finally` block. In Python, use `async with RocketRideClient(...)` instead. <!-- language-specific --> |

### Store (file access)

Paths are **relative** to the store root; absolute-like paths are rejected. See
[File Storage](/clients/typescript/storage) for the workflow.

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `fsOpen` | `fsOpen(path: string, mode?: 'r' \| 'w'): Promise<{ handle: string; size?: number }>` | `Promise<{ handle; size? }>` | Open a handle (`mode` default `'r'`). Read mode also returns `size`. |
| `fsRead` | `fsRead(handle: string, offset?: number, length?: number): Promise<Uint8Array>` | `Promise<Uint8Array>` | Read up to `length` bytes (default 4 MB) from `offset`. Empty array = EOF. |
| `fsWrite` | `fsWrite(handle: string, data: Uint8Array): Promise<number>` | `Promise<number>` | Write raw bytes to a write handle. Resolves to the number of bytes written. |
| `fsClose` | `fsClose(handle: string, mode: 'r' \| 'w'): Promise<void>` | `Promise<void>` | Close a handle. `mode` must match the mode passed to `fsOpen`. |
| `fsReadString` | `fsReadString(path: string): Promise<string>` | `Promise<string>` | Read an entire file as a UTF-8 string. |
| `fsWriteString` | `fsWriteString(path: string, text: string): Promise<void>` | `Promise<void>` | Write a UTF-8 string to a file (overwrites). |
| `fsReadJson` | `fsReadJson<T = any>(path: string): Promise<T>` | `Promise<T>` | Read and parse a JSON file. |
| `fsWriteJson` | `fsWriteJson(path: string, obj: any): Promise<void>` | `Promise<void>` | Serialize an object to JSON and write it. |
| `fsListDir` | `fsListDir(path?: string): Promise<{ entries: Array<{ name; type: 'file' \| 'dir'; size?; modified? }>; count }>` | `Promise<{ entries; count }>` | List immediate children (default: store root). |
| `fsStat` | `fsStat(path: string): Promise<{ exists: boolean; type?: 'file' \| 'dir'; size?; modified? }>` | `Promise<{...}>` | File/dir metadata (`size`/`modified` for files only). |
| `fsMkdir` | `fsMkdir(path: string): Promise<void>` | `Promise<void>` | Create a directory. |
| `fsRmdir` | `fsRmdir(path: string, recursive?: boolean): Promise<void>` | `Promise<void>` | Remove a directory. `recursive` (default `false`) deletes contents. |
| `fsRename` | `fsRename(oldPath: string, newPath: string): Promise<void>` | `Promise<void>` | Rename or move a file/directory (copy+delete on object stores; recursive for directories). |
| `fsDelete` | `fsDelete(path: string): Promise<void>` | `Promise<void>` | Delete a file. |
| `fsGetUrl` | `fsGetUrl(path: string, expiresIn?: number, downloadName?: string): Promise<string>` | `Promise<string>` | Time-limited HTTP(S) URL for direct browser access; inline by default, `downloadName` forces `Content-Disposition: attachment`. `expiresIn` in seconds (default 3600). |
| `fsReadMany` | `fsReadMany(paths: string[]): Promise<Array<{ path, ok, data?, error? }>>` | `Promise<Array>` | Batch-read many small files in one round trip (max 256 paths / 32 MiB total). Per-entry failures (`ok: false` + `error`), request order, `data` as `Uint8Array`. |

### Database

Raw SQL through a pipeline database node (requires `allow_execute: true` on the
node).

| Method | Signature | Description |
| --- | --- | --- |
| `database.query` | `database.query({ token, sql, nodeId?, sessionId?, params? }): Promise<{ rows, affected_rows }>` | Execute raw SQL through the pipeline's `execute` tool function. |
| `database.beginTransaction` | `database.beginTransaction({ token, nodeId? }): Promise<{ session_id }>` | Open a transaction (`begin` tool function). |
| `database.commit` | `database.commit({ token, sessionId, nodeId? }): Promise<{ ok }>` | Commit the open transaction. |
| `database.rollback` | `database.rollback({ token, sessionId, nodeId? }): Promise<{ ok }>` | Roll back the open transaction. |
| `database.dialect` | `database.dialect({ token, nodeId? }): Promise<DatabaseDialect>` | The target node's SQL dialect. |
| `database.sequelize` | `database.sequelize({ Sequelize, token, nodeId?, sequelizeOptions? }): Sequelize` | Build a Sequelize v6 instance whose Postgres dialect transports SQL over the pipeline. See [Sequelize over Pipelines](/clients/typescript/database-sequelize). <!-- language-specific --> |

### Deploy (`client.deploy`)

See [Deployments](/clients/typescript/deploy) for the model.

| Method | Description |
| --- | --- |
| `deploy.add({kind?, pipeline?, data?, metadata?, comment?, deployTo?}) | The ONE rail door: deploy any kind of object as the next immutable registry version. `kind:'pipe'` (default) takes a `pipeline` dict; `kind:'app'` takes ONE `data` zip of the app's SOURCE — the server performs the build (client-produced binaries are never trusted); the zip is retained and unpacked at receipt, born deployment-state `private`. The app id must be inside your developer namespace. |
| `deploy.addApp(appRoot, { workspaceRoot?, comment?, metadata?, onProgress? }): Promise<PublishResult>` | Pack an app folder's source and deploy it as the next registry version — the one call behind the App Builder's Deploy button and CI scripts. Packs by the App Builder rules (workspace-rooted zip, `appManifest.include`, hierarchical gitignore + the hard node_modules/dist/.git baseline, symlink containment, 50MB zipped / 512MB uncompressed caps); `onProgress` receives one line per step. Deploying activates nothing — bind an audience with `publishApp` afterwards. |
| `deploy.verifyApp(appRoot, { workspaceRoot? }): Promise<AppVerifyReport>` | The no-side-effect precheck for `addApp` — purely local, no server call: manifest shape and id grammar, declared icon/README assets, `appManifest.include` entries, and a pack dry run against the size caps. Server-side concerns (the build, store review) are out of scope. |
| `deploy.deploy(projectId, version, teamId)` | Point a team at a version — promotion and rollback alike. |
| `deploy.list(params?)` | Deployments visible to you, standard `{ rows, total, page, pageSize }` envelope. |
| `deploy.get(projectId, teamId)` | One team's deployment, registry-joined. |
| `deploy.versions(projectId, params?)` | Registry versions (the version strip), newest first. |
| `deploy.history(projectId, params?)` | The immutable audit trail, newest first, server-paged. |
| `deploy.disable(projectId, teamId)` | The kill switch: nothing runs until enabled again. |
| `deploy.enable(projectId, teamId)` | Enable a disabled deployment. |
| `deploy.remove(projectId, teamId)` | Soft remove — history and artifacts survive forever. |
| `deploy.setSchedule(projectId, sourceId, schedule, teamId, options?)` | Set (or clear with `null`) one source's cron schedule; the paused flag is untouched. |
| `deploy.pauseSchedule(projectId, sourceId, teamId)` | Pause ONE schedule — cron/ttl kept, it just stops firing. |
| `deploy.resumeSchedule(projectId, sourceId, teamId)` | Resume a paused schedule. |
| `deploy.setSourceConfig(projectId, sourceId, teamId, options?)` | Per-source execution settings for deploy runs (`traceLevel`, `debugOut`). |
| `deploy.run(projectId, sourceId, teamId)` | Start one deployed source NOW (manual trigger); returns `{ token, version }`. |
| `deploy.artifact(projectId, version)` | One immutable version's pipeline JSON, sha256-verified server-side. |
| `deploy.preview(schedule, count?)` | THE single cron evaluator: validity + next occurrences. |

Returns mirror the Python table: `publish` → `PublishResult`; `deploy`, `get`,
`disable`, `enable`, `remove`, `setSchedule`, `pauseSchedule`, `resumeSchedule`,
`setSourceConfig` → `Deployment`; `list`/`versions`/`history` →
`DeployListEnvelope<T>`; `run` → `{ token, version }`; `artifact` →
`PipelineConfig`; `preview` → `SchedulePreview`.

### App publish ladder

See [Deployments](/clients/typescript/deploy#app-publish-ladder) for the model.

| Method | Signature | Description |
| ------ | --------- | ----------- |
| `deploy.add` | `deploy.add({kind?, pipeline?, data?, metadata?, comment?, deployTo?}): Promise<PublishResult>` | The ONE rail door: deploy any kind of object as the next immutable registry version. `kind:'pipe'` (default) takes a `pipeline` dict; `kind:'app'` takes ONE `data` zip of the app's SOURCE — the server performs the build (client-produced binaries are never trusted); the zip is retained and unpacked at receipt, born deployment-state `private`. The app id must be inside your developer namespace. |
| `deploy.addApp` | `deploy.addApp(appRoot, { workspaceRoot?, comment?, metadata?, onProgress? }): Promise<PublishResult>` | Pack an app folder's source and deploy it as the next registry version — the one call behind the App Builder's Deploy button and CI scripts. Packs by the App Builder rules (workspace-rooted zip, `appManifest.include`, hierarchical gitignore + the hard node_modules/dist/.git baseline, symlink containment, 50MB zipped / 512MB uncompressed caps); `onProgress` receives one line per step. Deploying activates nothing — bind an audience with `publishApp` afterwards. |
| `deploy.verifyApp` | `deploy.verifyApp(appRoot, { workspaceRoot? }): Promise<AppVerifyReport>` | The no-side-effect precheck for `addApp` — purely local, no server call: manifest shape and id grammar, declared icon/README assets, `appManifest.include` entries, and a pack dry run against the size caps. Server-side concerns (the build, store review) are out of scope. |
| `listDeployments` | `listDeployments(appId): Promise<RailEntry[]>` | The version rail, newest first — the developer org sees its FULL rail (published or not), other callers only their visible versions. Each entry carries its deployment `state`, its `buildStatus` ('ok' = servable), and the `rungs` naming the audiences bound to it. |
| `submitApp` | `submitApp(appId, registryVersion): Promise<{artifact}>` | Submit a deployed version for store review — flips the deployment `private` → `submit` (it enters the admin queue). Developer-org + namespace gated. |
| `withdrawApp` | `withdrawApp(appId, registryVersion): Promise<{artifact}>` | Withdraw a pending review — the developer's own cancel: flips the deployment `submit` → `private` (leaves the admin queue, back to draft; history records `withdrawn`). Only a version in `submit` withdraws. Developer-org + namespace gated. |
| `replyApp` | `replyApp(appId, message, registryVersion?): Promise<{replied, appId}>` | Append a developer message to the app's review thread — the developer half of the reviewer conversation. Rides `deployment_history` as a `reply` row (side `'developer'`), the same stream `deploy.history()` reads. Developer-org + namespace gated. |
| `buildLog` | `buildLog(appId, registryVersion): Promise<{appId, version, log}>` | One version's durable server build log — the full phase-by-phase output the build worker stores beside the version's artifacts (no error text rides the rail rows). Long logs serve their tail; `''` = no log. Developer-org gated. |
| `publishApp` | `publishApp(appId, registryVersion, target): Promise<{publish}>` | Bind a deployment to '@me', '@team/<name>', or '@public' ('@user' = legacy input alias). The binding is a pure pointer born 'enabled'. `@public` requires the deployment be `ready` (approved); `@me`/`@team` accept any non-`failed` deployment. Pinning ANOTHER org's public app to '@me'/'@team' is the version selector and is allowed; publishing your own app requires the id to be in your namespace. |
| `whereApp` | `whereApp(appId): Promise<Pin[]>` | The reverse index: `{rung, handle, version, appVersion, state, deployedAt}` per audience — `state` is the bound DEPLOYMENT's review state. |

Serving needs no verb: a version's bundle loads from the stable
`/apps/<appId>/v<N>/remoteEntry.js` URL constructed from its registry
version number, with entitlement enforced by the serve route on every
request (registry ints ONLY — semver is display).

### App marketplace + developer verbs

Two raw DAP commands carry this surface (call via
`client.call('<command>', { subcommand, ... })`):

- **`rrext_deploy_app`** — the developer-account + review verbs (claiming a
  developerId is a deploy PREREQUISITE, not a marketplace action): the
  `developer_*` family, `submit`, and `register_dev`.
- **`rrext_app`** — the pure marketplace: browse (`list`/`get`/`list_mine`),
  install (`desktop_add`/`desktop_remove`), admin review (`admin_*`), and
  pricing (`pricing_*`).

Grouped families (the `developer_*`/`submit`/`register_dev` rows are on
`rrext_deploy_app`; the rest on `rrext_app`):

| Subcommand family | Subcommands | Guard | Purpose |
| ----------------- | ----------- | ----- | ------- |
| developer_* | `developer_register` · `developer_stripe` · `developer_dashboard` · `developer_status` | org.admin (register) | Claim the org's developer id slug + Stripe Connect onboarding. |
| submit | `submit` · `withdraw` · `reply` | developer org + namespace | Submit a deployed version for review (flips the DEPLOYMENT `private` → `submit`), cancel a pending review, or append a developer message to the review thread (sugar over `submitApp`/`withdrawApp`/`replyApp`). |
| register_dev | `register_dev` | self | Per-user live dev overlay (App Builder hot-reload); OSS-capable. |
| catalog | `list` · `get` · `list_mine` · `desktop_add` · `desktop_remove` | authenticated | Browse reachable apps, the developer's own rail view, and desktop membership. |
| admin_* | `admin_queue` · `admin_approve` · `admin_reject` · `admin_reply` · `admin_reseed` | sys.admin | Store review over the DEPLOYMENTS: the queue is deployments in `submit`; `admin_approve(appId, version)` flips it `ready`, `admin_reject(appId, version)` flips it `rejected`. |
| pricing_* | `pricing_list` · `pricing_create` · `pricing_delete` | developer org (owns the app_products row) | Manage Stripe price tiers for a monetized app. |

**Review model.** The review state lives on the DEPLOYMENT (`deployment_artifacts.state`).
`@me`/`@team` bindings need no approval — they serve any non-`failed`
deployment at once. Going public is a three-step flow: `submit` (deployment →
`submit`, enters the admin queue) → `admin_approve` (→ `ready`) → `publishApp
@public` (point the public binding at the now-`ready` version). A reject flips
the deployment `rejected`; the developer fixes and deploys a NEW version. The
store serves only public bindings whose deployment is `ready`.

### Run logs (`client.log`)

See [Run Logs](/clients/typescript/logs) for the continuum model and the DVR
session.

### Additional client surface

Further public methods, present in both SDKs, in brief:

| Area | Methods |
| --- | --- |
| Generic invoke | `call(command, ...)` — any DAP command; `tool(...)` — invoke a pipeline tool function <!-- language-specific --> |
| Task helpers | `getTaskToken`, `getTaskPipeline`, `restart` |
| Identity | `getAccountInfo`, `getOrgId`; static `getServerInfo`, `normalizeUri` |
| Monitors | `clearAllMonitors`, `identify` (plus `addMonitor`/`removeMonitor` above) |
| Template storage | `saveTemplate`, `getTemplate`, `deleteTemplate`, `getAllTemplates` |
| Log storage | `saveLog`, `getLog`, `deleteLog`, `listLogs` |
| Dashboard | `getDashboard`, `listConnections`, `listTasks` |
| Profiling | `cprofileStart`, `cprofileStop`, `cprofileStatus`, `cprofileReport`, `cprofileReportTree` |
| Namespaces | `client.account`, `client.billing` (account and billing APIs) |

## DataPipe

Returned by `client.pipe()`. One streaming upload: **open → write (one or more) →
close**. The server assigns a `pipeId` on open; `close()` finalizes the stream and
returns the pipeline result.

| Member | Type | Description |
| --- | --- | --- |
| `isOpened` | `boolean` (getter) | Whether the pipe has been opened and not yet closed. |
| `pipeId` | `number \| undefined` (getter) | Server-assigned pipe ID; set after `open()`. |

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `open` | `open(): Promise<DataPipe>` | `Promise<DataPipe>` | Opens the pipe on the server. Must be called before `write()`. |
| `write` | `write(buffer: Uint8Array): Promise<void>` | - | Writes a chunk. Pipe must be open. |
| `close` | `close(): Promise<PIPELINE_RESULT \| undefined>` | `Promise<PIPELINE_RESULT \| undefined>` | Closes the pipe and returns the processing result. No-op if already closed. |
| `tool` | `tool<T = any>(tool: string, nodeId = '', input: Record<string, unknown> = {}): Promise<T>` | `Promise<T>` | Invokes a pipeline tool function through the pipe. |

## Question

From `rocketride`. Build a question for `client.chat({ token, question })`.

```typescript
constructor(options?: {
  type?: QuestionType;
  filter?: DocFilter;
  expectJson?: boolean;
  role?: string;
})
```

`QuestionType`: `QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT`.

| Method | Signature | Description |
| --- | --- | --- |
| `addInstruction` | `addInstruction(title: string, instruction: string): void` | Adds an instruction for the AI (e.g. "Answer in bullet points"). |
| `addExample` | `addExample(given: string, result: string \| object \| any[]): void` | Adds an example input/output so the AI can match format. |
| `addContext` | `addContext(context: string \| object \| string[] \| object[]): void` | Adds context (e.g. "Q4 2024 data"). |
| `addHistory` | `addHistory(item: QuestionHistory): void` | Adds a history item (`{ role, content }`) for multi-turn chat. |
| `addQuestion` | `addQuestion(question: string): void` | Appends the main question text. |
| `addDocuments` | `addDocuments(documents: Doc \| Doc[]): void` | Adds documents for the AI to reference. |
| `addGoal` | `addGoal(goal: string): void` | Adds a goal statement for the AI. |
| `getPrompt` | `getPrompt(hasPreviousJsonFailed?: boolean): string` | Returns the full prompt (internal use). |

## Answer

Parses chat response content — see
[Chat](/clients/typescript/chat#parse-the-response-with-answer) for semantics.

```typescript
constructor(expectJson?: boolean)  // default false
```

| Method | Signature | Description |
| --- | --- | --- |
| `setAnswer` | `setAnswer(value: string \| object \| unknown[]): void` | Stores the response value, validating/parsing it as JSON when `expectJson` is `true`. |
| `getText` | `getText(): string` | The stored answer as plain text. |
| `getJson` | `getJson(): unknown` | The stored answer as parsed JSON; **throws** if it is not JSON-compatible. |
| `isJson` | `isJson(): boolean` | Returns the `expectJson` flag this `Answer` was constructed with (does not inspect content). |
| `Answer.parsePython` | `parsePython(value: string): string` | Static. Extracts Python code from a code block in the response. |

## Types

- **DAPMessage**: `{ type, seq, command?, arguments?, body?, success?, message?, request_seq?, event?, token?, data?, trace? }`.
- **TASK_STATUS**: Task status with `completedCount`, `totalCount`, `completed`, `state`, `exitCode`, and many more fields.
- **PIPELINE_RESULT**: `{ name, path, objectId, result_types?, [key: string]: any }`.
- **PipelineConfig**: Pipeline definition with `name`, `description`, `version`, `components`, `source`, `project_id`.
- **UPLOAD_RESULT**: Per-file result with e.g. `action` (`'complete'` \| `'error'`), `filepath`, `error?`, `result?`, `upload_time?`.
- **ConnectResult**: Identity payload returned by `connect()`/`login()` — user, organizations, apps, teams.
- **QuestionHistory**: `{ role: string, content: string }` · **QuestionExample**: `{ given: string, result: string }` · **QuestionType**/**QuestionText**.
- **Deploy types**: `DeployArtifact`, `Deployment`, `DeploymentSchedule`, `DeployActor`, `DeployHistoryEntry`, `PublishResult`, `DeployListEnvelope<T>` (the generic list/versions/history envelope), `DeployListParams`, `SchedulePreview` (from `rocketride`).
- **Sequelize types**: `CreateSequelizeOptions`, `SequelizeConstructor` (see [Sequelize over Pipelines](/clients/typescript/database-sequelize)). <!-- language-specific -->

## Advanced: low-level DAP

For commands not covered by the typed surface. TypeScript composes
`buildRequest()` + `request()` (the one-step `dap_request` shorthand is
Python-only).

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `buildRequest` | `buildRequest(command: string, options?: { token?: string; arguments?: Record<string, unknown>; data?: Uint8Array \| string }): DAPMessage` | `DAPMessage` | Builds a DAP request message with the next sequence number. |
| `request` | `request(request: DAPMessage, timeout?: number): Promise<DAPMessage>` | `Promise<DAPMessage>` | Sends the request and returns the response. `timeout` (ms) overrides the config default for this call. Check `didFail(response)` before using `response.body`. |
| `didFail` | `didFail(request: DAPMessage): boolean` | `boolean` | `true` when the passed response indicated failure (`success === false`). |

```typescript
const req = client.buildRequest('rrext_monitor', { token, arguments: { types: ['apaevt_status_upload'] } });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
```
