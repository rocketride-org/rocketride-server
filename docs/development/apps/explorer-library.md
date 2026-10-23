# Explorer library (`apps/shared/src/explorer/`)

The code every Explorer app shares: finding tool nodes in running pipelines,
calling them safely, keeping per-connection history, and running a batch of
statements honestly. SQL Explorer (`apps/sql-ui`) is the reference consumer;
read its `src/connect/`, `src/history/` and `src/views/QueryView.tsx` next to
this page. This page is for people changing the library or adding an Explorer;
what each app does for its users is documented in that app's own folder.

## Rules that shape everything

- **Factories, not singletons.** Nothing under `explorer/` holds module-level
  state. `createEndpointStore`, `createHistoryStore`, `createAnnouncer`,
  `createActiveKeyStore` and the rest return instances; each app creates and
  owns its own. The library is **compiled into each app** (source, not a
  Module Federation module), so two Explorers never share a store, a timer or a
  token.
- **Import path.** `shared/explorer` is the barrel of the pure modules;
  everything else is `shared/explorer/<module>` (for example
  `shared/explorer/connect/store`). It resolves through the app's `tsconfig`
  `paths` entry `shared/*`, like the other `shared/...` imports.
- **Only three places may import a *value* from `shell`:**
  [`shellBinding.ts`](../../../apps/shared/src/explorer/shellBinding.ts),
  [`react.tsx`](../../../apps/shared/src/explorer/react.tsx) and
  [`components/`](../../../apps/shared/src/explorer/components/). Every other
  module (and the barrel) is pure, so its tests run under `node:test` without
  the shell. Components and `react.tsx` are not exported from the barrel; import
  them by path.
- **Task tokens are secrets.** See [Tokens](#tokens-and-identity).
- **No Node-only globals outside `*.test.ts(x)`.** `shell:freeze` (and so
  `./builder shell:check`) type-checks `apps/shared/src` with the browser libs
  and **without Node types**, so a helper such as
  [`connect/testing.ts`](../../../apps/shared/src/explorer/connect/testing.ts)
  must not use `setImmediate`, `process`, `Buffer` or `require`. `shared:test`
  adds Node types for the test files only (`tsconfig.test.json`), so it can pass
  while `shell:check` fails: run both.

## Discovery

[`connect/discovery.ts`](../../../apps/shared/src/explorer/connect/discovery.ts)
reads `client.getTasks()`: the **running** tasks the caller may see, each with
its **own** `token`, `teamId`, `runKind`, `ownerKind`, `ownerId` and the
pipeline dict. It never calls `getTaskToken` (that resolves only the caller's
own dev run) and is not paged, so more than 100 tasks is one response. The
project id is `pipeline.project_id`; the row has no `projectId` field.
`pipeline.components` is read from the row; `getTaskPipeline(token)` is a
bounded fallback only when a row carries none.

**Names come from one `listTasks` call.** `getTasks()` names a run by its
pipeline's `name`, or by its source id when the pipeline has none. The readable
name #2625 shows, `{task name}.{source component name}` (for example "Shop
Postgres.Tools"), is the task's status name, and only `listTasks` carries it.
So discovery asks `listTasks` once, together with `getTasks()`, for the newest
100 live tasks (`TASK_NAMES_REQUEST`), and uses it **for names only**. Which
endpoints exist, and their keys and tokens, still come from `getTasks()`.
- **Matching.** A name matches exactly one run, by the run's display id,
  built in memory the way the server builds it. A `listTasks` row has no owner
  or team, so nothing else tells two teams' deployments of one project apart.
- **Unnamed runs.** A run started without a task name, including every deploy,
  has a status name made from its display id. That is not a readable name, so
  it is ignored.
- **Role maps.** A role map is named by its tools run only, so its label does
  not change with which run anchors the connection.
- **Waiting.** Discovery waits for the names at most `TASK_NAMES_TIMEOUT_MS`
  (10 s). The wait overlaps `getTasks()`, so the store's 30 s discovery bound
  stays the deadline.
- **Failure.** A failure is logged once per client, and the names fall back.
- **Fallback.** A run `listTasks` does not name is named by its pipeline's
  name, then its source component's name, then its source id.

The server scopes a user-owned run by its owner, so `getTasks()` still returns
the caller's own runs from an organization they have switched away from, with
their tokens. Discovery drops a row, before grouping and before its token
reaches the store, when the identity lists its organization's teams
(`identity.teamPermissions`) and the row's `teamId` is not one of them
(`runInIdentityOrganization` in
[`connect/identity.ts`](../../../apps/shared/src/explorer/connect/identity.ts)).
A row with no `teamId`, or an identity without a team list, keeps every row.
This also keeps a platform administrator's Explorer to the organization they
are signed in to. A run under another team of the same organization stays.

A connection is a **role map**, not a provider set
([`types.ts`](../../../apps/shared/src/explorer/types.ts)):

| Spec | Roles | Use |
|---|---|---|
| `SINGLE_TOOLS_ROLE` | one `tools` role, any source | SQL, Graph |
| `VECTOR_ROLES` | `ingest_1`, `chat_1`, `tools_1` (`tools` required) | Vector (tested with mocks; no Vector app ships) |

Multi-role specs group the running sources of **one project, owner kind, owner,
team and run kind** into one connection. Runs that differ in any of those never
merge (a developer's run and the team's deployment of the same pipeline are two
connections). A role with no running source is reported as `null` in
`endpoint.roles` and listed in `missingRoles`; it is never borrowed from another
run. A missing **required** role makes the endpoint `stopped`. Rows whose
pipeline has no `project_id` are never grouped with other rows (multi-role specs).

## Endpoint keys

`buildEndpointKey` ([`keys.ts`](../../../apps/shared/src/explorer/keys.ts))
produces

```text
k1|runKind|ownerKind|ownerId|teamId|projectId|role=source,role=source|nodeId
```

with every field percent-encoded, so a key never contains a raw `:` or `|` and
the documents' "strip one trailing `:segment`" address rule stays exact. Role
bindings are sorted, and a fixed-source role keeps its source in the key while
not running, so a connection's key survives an optional source starting and
stopping. A key is **never derived from a token**.

`legacyKey` is SQL Explorer's old `projectId:source:nodeId`. It is set only for
`runKind === 'dev'`, `ownerKind === 'user'` with a known project id and a
single role (`legacyKeyFromKey`), because that is all the old token lookup could
open. Deployments, other owners and projectless pipelines get `null`.

`projectId` is `''` when a pipeline carries no `project_id` (the server mints one
it never reports). Two such pipelines with the same owner, run kind, source and
node id collide on their key. A `.pipe` file saved in a VS Code workspace gets a
`project_id`; the Graph Explorer templates ship without one and get it on
import, so two copies of one template posted raw through an SDK collide and
show as one card.

## Endpoint states

| State | Meaning |
|---|---|
| `probing` | discovered; the one `dialect` probe is pending |
| `ready` | the probe answered |
| `stopped` | its task is not running (kept in the list after it disappears), or a required role is missing |
| `unreachable` | running, but the probe failed (not wired to a tools source, node error, timeout) |
| `inaccessible` | the probe failed and the identity's team permissions lack `task.data` for that run's team (a hint, never a gate) |

The probe runs once per endpoint, with bounded concurrency (default 4), and one
failure never affects another. A `ready` endpoint is not probed again unless a
refresh asks for it, its token changes, or it disappears and returns. An
`unreachable` or `inaccessible` endpoint is probed again only on an explicit
`store.refresh()`, a restart or reconnect, `store.probe()` (Test connection) or
a changed token, never on a focus or an ordinary task event: a probe is a tool
call, and a tool call that reaches the task counts as activity for its idle
timeout. An endpoint that disappeared from discovery is not probed:
`store.probe()` sends nothing for it and returns null, and the answer to a
probe that was in flight when it disappeared is not applied, so its card stays
`stopped`. It is probed when a discovery lists it again, on any refresh. An
empty `getTasks()` list is not proof that something failed to provision.

## Tokens and identity

Tokens live only in a `Map` inside the store
([`connect/store.ts`](../../../apps/shared/src/explorer/connect/store.ts)).
Endpoints, probe results, the state snapshot, keys, sessions and errors never
contain one, so nothing the library returns can leak one into preferences,
storage, a URL, a log, a copied JSON or a document payload. Call tools only
through `store.session(client, endpoint)`; the session reads the token at call
time and never keeps it.

Discovery lists running tasks only, so a task that is restarting disappears
from it just like a stopped one. An endpoint that disappears is shown
`stopped`, but the store keeps its token, and the node's last good `dialect`
answer for the session's capability check and budget, until the endpoint is
discovered again or the store resets. A call made in the meantime is still
sent, and that is its first send, not a retry. The server holds it until a
restarting task is running again. A pipeline stopped within the last few
minutes is still registered and answers `TASK_STOPPED`, so an idempotent call
first gets the one bounded re-discovery (up to the 15 s retry window, see "The
one retry") and then fails with that code; a task that is no longer registered
answers `TASK_NOT_REGISTERED` at once. A call is refused locally as
`unavailable` only for an endpoint whose latest discovery row carried no token
or reported it `stopped` (a required role not running); its token is dropped
then.

`store.reset()` forgets endpoints, probes, tokens and sessions, and drops probes
that were in flight. It runs on sign-out and when the identity fingerprint
(`userId|orgId|devTeam`, [`connect/identity.ts`](../../../apps/shared/src/explorer/connect/identity.ts))
changes; a permissions-only change does not reset. Wire it with
`useEndpointStoreLifecycle(store, client, identity)` from `react.tsx` (task
events, focus, reconnect, identity events through `shellBinding.ts`).
Refresh is debounced (300 ms) for task events, rate-limited (5 s) for focus, and
concurrent refreshes coalesce into one follow-up. One discovery may take at most
30 s (`discoveryTimeoutMs`); after that the refresh ends with status `error`, so
a server that never answers cannot leave the list refreshing forever.

## Calling a tool

[`connect/session.ts`](../../../apps/shared/src/explorer/connect/session.ts):
`session.invoke(tool, input, { idempotent?, timeoutMs?, generation?, retry? })`
resolves with the checked value or throws `ExplorerToolError`
([`errors.ts`](../../../apps/shared/src/explorer/errors.ts)): `kind` is one of
`raised`, `invalid`, `store`, `error-envelope`, `malformed`, `timeout`,
`upgrade`, `unavailable`, `stale`; `message` is the full verbatim text,
`headline` its first line, `detail` the rest, `code` the server's
machine-readable code when present.

Failure depends on the **tool**, so each tool gets a `ResultCheck`
([`checks.ts`](../../../apps/shared/src/explorer/checks.ts)):

| Tool shape | Failure arrives as | Check |
|---|---|---|
| `execute`, `read_query` | the call rejects; the envelope is validated | `checkRowEnvelope` (positional rows, `row_limit`, `truncated`, additive metadata, `truncated_by` null, `rows`, `elements` or `values`); SQL's `execute` answers with object rows and uses `checkObject` |
| `get_data` | `{valid: false}` with an `error` (even beside an `answer`) or with neither fails; `{valid: false, answer}` with no `error` is a prose answer and passes | `checkValidFlag` (the `get_query` rule) |
| `get_query` | `{valid: false}` with an `error` (even beside an `answer`) or with neither fails; `{valid: false, answer}` with no `error` is prose and passes | `checkGetQuery` |
| store / vector tools | `{success: false, error}` | `checkStoreSuccess` |
| FalkorDB legacy `query` | `{error, columns: [], rows: []}` | `checkLegacyErrorEnvelope` |
| `get_schema`, `refresh_schema` | never an error by itself | `classifySchemaV2` returns `fresh`, `stale`, `error`, `incapable` or `unknown`; an absent `schema` block is `unknown`, never an empty graph |

**Timeouts** come from the session's own timer, never from SDK message text.
The default wait is the node's published `dialect.limits.statement_timeout_ms`
plus 10 s, or 40 s when it is not published. `DEFAULT_TOOL_TIMEOUTS`:

| Tool | Client wait | Why |
|---|---|---|
| `dialect` | 15 s | a name and a few limits |
| `get_schema` | 60 s | serves the snapshot the node already holds |
| `refresh_schema` | 135 s | the node can queue behind another refresh (budget + 5 s) and then reflect for its own budget (`SCHEMA_REFRESH_BUDGET_MS` = 60 s, `packages/ai/src/ai/common/graph/schema.py`): 2 × 60 s + 5 s, plus the 10 s pad |
| `get_data`, `get_query` | 120 s | a model writes the query first |

A client wait must sit above the node's own deadline, otherwise the app says
"stopped waiting" just before the node returns its honest stale or error answer.
A tool spec's `timeoutMs: null` means no client timeout. The
SDK is asked to wait 1 s longer than the session so the session's typed
`timeout` wins. A client timeout does **not** cancel the server's work.

**Stale results.** Each request takes a ticket from `createGeneration()`; passing
it as `generation` makes a result (or failure) that arrives after the ticket
expired throw `kind: 'stale'`, which callers ignore.

**Capability gate.** A tool spec's `capability` names a `dialect.capabilities`
key that must be `true`; otherwise the call is refused locally as `upgrade`
before anything is sent. The library never falls back to another tool (for
example from `read_query` to `execute`).

### The one retry

A call is retried **at most once**, and only when **all** hold:

1. the call is idempotent: `idempotent: true` on the tool's spec, or on the
   call itself. A write never is, and `execute` is not by default; a caller may
   mark one `execute` call idempotent for a statement it classifies as a read
   (SQL Explorer does, for reads, table pages, row counts and plain `EXPLAIN`).
   Such a replay is safe only because of rule 2: `TASK_STOPPED` is raised
   before the request is dispatched, so the first attempt never ran;
2. the failure is `raised` with `code === 'TASK_STOPPED'`, which the server
   raises from `wait_for_running` **before** the request reaches the node;
3. bounded re-discovery (at most 15 s, inside the call's own timeout) finds the
   **same endpoint key** running again (the token may be identical: task tokens
   are deterministic);
4. at least a second of the call's budget remains.

`TASK_NOT_REGISTERED`, `TASK_COMPLETED`, `TASK_AMBIGUOUS`, permission errors,
malformed results, `upgrade` and timeouts are never retried. The server has no
dedicated "restarting" code: a restart and a real stop both give `TASK_STOPPED`,
which is why re-discovery, not the code alone, decides.

This depends on the SDKs preserving the server code. `client.call()` throws
`DAPException` (TypeScript) / `CommandException` (Python), both carrying `.code`
(see the SDKs' `errors.md` pages); the library only reads a string `code`
property and imports no SDK class. With an SDK that drops the code, nothing is
retried.

## History

`createHistoryStore({ historyKey, recordingKey, textField, limits?, runs?,
legacyKeyOf? })` ([`history/store.ts`](../../../apps/shared/src/explorer/history/store.ts))
persists through the shell's workspace preferences, per connection key, and
writes only while a preferences accessor is attached (see the file header for
why a background write would be misfiled). SQL Explorer uses `sql.history`,
`sql.historyRecording`, `sql.patternChecks` and the persisted field `sql`; Graph
Explorer uses `graph.history`, `graph.historyRecording` and `cypher`. It has no
pattern-check switch: its write console always confirms the statements its text
check flags and sends the rest without a dialog, with no option to stop asking.
**These names and the entry shape never change**: renaming one
silently orphans users' saved history. Mount the accessor with
`createHistoryPrefsBridge(store)` from `react.tsx`. The store keeps what it read
after the last bridge detaches and merges it into the next attach, so the bridge
attaches under the signed-in identity's fingerprint (`attachPrefs(api, owner)`,
the owner read with the shell's `useAuthUser`) and attaches again when it
changes. An attach under a different owner, a sign-out included, first forgets
every entry, switch, queued run and pending write held in memory, so one
account's history is never shown to, merged into or written for the next one
that signs in on the same page. Writes are batched (`persistDelayMs`, 300 ms
by default) and the LAST detach drops a batch still waiting. So call `flush()`
before every detach that ends an owner's attachment while that batch is still
theirs: an unmount, and the moment the identity becomes unknown or changes (a
disconnect, a sign-out and an account switch all reach the identity before
anything unmounts, so an unmount-time flush comes too late for them).
`flush()` hands the pending batch at once to the attached accessor, and does
nothing when nothing is pending or nothing is attached. What happens to it
next is the accessor's rule: the dev-tool fs accessor (`devtool/prefs.ts`)
writes it for its owner, holds it while nobody is known, and drops it once
another identity is known, so keep that accessor alive (do not dispose it)
while the identity is merely unknown. Code outside React
reads the store with `getHistory(key)`, `getRecording(key)` and
`subscribe(listener)`. Per-connection booleans use
`createConnectionFlags` ([`history/flags.ts`](../../../apps/shared/src/explorer/history/flags.ts)).

**Legacy keys.** When `legacyKeyOf` maps a connection to its pre-v1 key (SQL
passes `legacyKeyFromKey`), reads are a merged view of both lists. No automatic
write touches the old list, because several new keys can read one old key (the
same dev run under two development teams). New runs go to the new key only, and
the per-connection bound applies to the merged view, so an old entry it leaves
out stays stored. Pin, note and a re-run that repeats an old statement write a
copy under the new key (same id, so the copy stands in for the original). Remove
and clear are the user's own deletes and do reach the old list: remove drops the
entry from both lists, and clear empties the connection's own list and the old
list, so every connection reading that old list stops seeing them. A recording
or pattern-check switch saved under the old key still applies until the new key
has its own. Nothing is migrated, and a deployment or another owner never reads
the old list. Apart from remove and clear, the only thing that can drop an old
entry is the size budget across all connections (`trimBag`, oldest first).

## Running statements

[`runner/batch.ts`](../../../apps/shared/src/explorer/runner/batch.ts) holds
`runStatementBatch`, pure and testable with a fake session; the app supplies the
language-specific hooks. Its rules: one statement per call, in order; the first
failure ends the batch and the rest are `skipped` (no claim of atomicity); a
`refuse` hook can veto the whole batch before anything is sent; a text pattern
check asks before a flagged statement is sent (run, run and stop asking, or
decline, which skips the rest); when the batch's generation ticket expires
(Stop waiting, or the component that owns the runner unmounting: a closed
document, a switch to another app) it sends nothing more, stops touching state,
and the late result **and** the late failure are dropped. The statement already
in flight finishes at the node; nothing can cancel it. `abandonRuns` marks the
statement in flight `abandoned`.
[`runner/useStatementRunner.ts`](../../../apps/shared/src/explorer/runner/useStatementRunner.ts)
binds it to React state; its unmount cleanup (`attachRunnerLifetime`) is what
expires the ticket, so every app using the hook gets this without code of its own.

Shared components under `components/` (import by path): `StatementStrip`,
`FailureBanner` (headline, where it happened, "Database said" collapsed),
`PatternConfirmDialog` (its sentence "This is a text check, not a database
safeguard." is fixed), `RowInspector` (positional fields, so duplicate column
names survive), `ConnectionsLanding` and `EndpointDrawer` (the app injects its
wording, icon, probe, extra rows and empty states; state wording is in
`endpointState.ts`). Also pure: `a11y/` (`createAnnouncer`,
`createLiveRegion`), `nav/` (`createActiveKeyStore`, `createRequestChannel`,
document-URI key rule), and the drawer's selection and probe rules
(`components/drawerModel.ts`).

## Adding an Explorer app

1. Create the app with the normal app scaffold (see
   [Building Shell Apps in the Monorepo](index.md)).
2. In its own modules, create one instance of each store it needs:
   `createEndpointStore({ providers, roles, tools })` with its exact provider
   set, `createHistoryStore` with its own preference keys and text field, an
   announcer, an active-key store. Never import another app's instance.
3. Describe every tool the app calls in the `tools` map: `idempotent`,
   `check`, `timeoutMs`, `capability`. Reads and reflection are idempotent;
   `execute` is not (a call may still mark one statement it knows is a read,
   see "The one retry").
4. Mount `useEndpointStoreLifecycle(store, client, identity)` once at the app
   root, and call tools only through `store.session`. The store resets when
   the identity fingerprint changes (sign-out included); the app must then
   close every connection-scoped document (keep the Connections landing) and
   clear its per-connection caches, such as schema snapshots, cached sessions
   and reads in flight, as SQL Explorer (`identityScope.ts`) and Graph
   Explorer (`graph/identityChange.ts`) do. The shared `EndpointDrawer` needs
   nothing extra: when the store resets, it forgets its selection and drops
   the probe result, including one still in flight. Nor does history: the
   bridge from `createHistoryPrefsBridge` makes the history store forget the
   previous identity's entries (see [History](#history)).
5. Wire the runner's hooks and the shared components; keep the language
   (lexer, classifier, row limits, failure wording) in the app.
6. Tests: pure logic runs under the app's `*:test` action; for `shared:test`,
   keep suites beside the code. `connect/testing.ts` has a fake client and a
   manual clock (not exported from the barrel).

## Running the library in a dev-tool controller

A dev tool (`AppDescriptor.devToolSidebar` plus `devToolFrame`) mounts the app
twice and gives neither mount a client. The deep entry
[`devtool/`](../../../apps/shared/src/explorer/devtool/), imported as
`shared/explorer/devtool/<module>`, is what an Explorer needs to run there. It
is **not** exported from the `shared/explorer` barrel and imports no value from
`shell`: the caller passes in the realm's `ConnectionManager` (as a structural
type) and the shell's `createToolChannel`, `createToolController` and
`createToolOpServer`. So every module runs under `node:test`.

**Split ownership.** The sidebar mount is the **controller**. It owns the
endpoint store (token vault, discovery, probes, task watch), the bus client,
identity, schema caches, history and every op handler. **Frames** own the
editor, the statement runner and its generation tickets, render models,
selection and "Stop waiting". They hold no client and reach the engine only
through ops. Nothing may assume the two share memory: in VS Code they are
separate webviews.

**Engine access** ([`busClient.ts`](../../../apps/shared/src/explorer/devtool/busClient.ts)).
`getBusExplorerClient(cm)` is the library's `IExplorerClient` over
`cm.request('client.<op>', …)`, with one instance per realm. Every request names
its own bus timeout, and none relies on the bus's 120 s default
([`timeouts.ts`](../../../apps/shared/src/explorer/devtool/timeouts.ts)):

| Request | Bus `timeoutMs` |
|---|---|
| `client.tool` with an SDK `timeout` | `timeout + BUS_TOOL_MARGIN_MS` (5 s) |
| `client.tool` the session left unbounded (`timeoutMs: null`) | `UNBOUNDED_TOOL_TIMEOUT_MS` (24 h; a delay above 2^31-1 ms fires at once) |
| `client.getTasks`, `client.getTaskPipeline` | 30 s each |
| `client.listTasks` (discovery's names) | `LIST_TASKS_TIMEOUT_MS` (10 s, discovery's own wait for it) |
| `client.addMonitor`, `client.removeMonitor` | 15 s |
| anything else (`fs*`, `use`, `getEnvironmentKeys`) | `busRequest(cm, op, params, timeoutMs)`; the timeout is required |

A frame waits longer than its controller: `frameOpTimeoutMs(controllerMs)` adds
`FRAME_OP_MARGIN_MS` (5 s), and `toolCallBudgetMs(wait)` is one tool call's
controller budget.

**Ops** ([`reply.ts`](../../../apps/shared/src/explorer/devtool/reply.ts),
[`deadline.ts`](../../../apps/shared/src/explorer/devtool/deadline.ts),
[`frame.ts`](../../../apps/shared/src/explorer/devtool/frame.ts)).

- **Failures are data.** The op lane carries a handler's failure as its message
  only. So every op returns `Reply<T>`: `{ ok: true, value }` or
  `{ ok: false, error: { kind, code?, message, tool?, detail?, retryAfterS? } }`.
  - On the controller, `toReply(fn)` builds it. The lanes' own timeout texts
    ("did not answer within", "timed out after") become kind `timeout`, and
    "Not connected to server" becomes `unavailable`. Programming errors are
    rethrown.
  - On the frame, `fromReply` (or `callReply`) rebuilds an `ExplorerToolError`
    equal to the original, so `failures.ts` and the `code` switches work
    unchanged.
- **Void ops answer `Reply<null>`.** JSON has no `undefined`: in VS Code,
  `{ ok: true, value: undefined }` arrives as `{ ok: true }`. So `replyOk` and
  `toReply` turn an undefined value into `null`, and a success whose value was
  dropped still reads as a Reply with value `null`.
- **Deadlines.** Every call carries `deadlineAt` (the frame's now plus its
  `timeoutMs`). The controller refuses a call that has no deadline, or that
  arrives after it, without running it.
- **The frame caller.** `createFrameCaller` builds one controller function and
  one channel per frame peer.
  - Every call needs an explicit `timeoutMs`. A missing or unusable one is a
    programming error: `call` and `callReply` **throw** a RangeError
    synchronously, so a `.catch` on the returned promise never sees it.
  - It rejects every pending call as soon as `host:connection` turns false,
    with kind `timeout`: the call may still have run.
  - A call made while `host:connection` is already false is rejected at once,
    before anything is posted, with kind `unavailable`: it was not sent, so it
    cannot have run. Before the host publishes the topic at all, calls pass.
  - The controller's refusal of a call that arrived after its deadline (timers
    throttled in a hidden webview) reaches a still-waiting frame as kind
    `timeout`.
  - **It waits for its controller.** A call is sent only while the controller's
    readiness state carries a nonce (see below). Until then it waits, inside
    its own timeout: the deadline stays the one stamped at call time, and the
    op lane gets what is left of it. If readiness never comes, the call
    rejects as kind `timeout`, unsent. A wait cut short by `host:connection`
    turning false rejects as `unavailable`. `controllerReady()` reports the
    state, and `waitForController: false` sends at once (for a controller
    that publishes no readiness).

**Controller wiring** ([`controller.ts`](../../../apps/shared/src/explorer/devtool/controller.ts)).
`attachController({ peer, channel, createToolChannel, createToolOpServer, handlers })`
uses the host's channel, or builds one per peer, **before** it creates exactly
one op server, and serves every handler through the deadline guard. Call it in a
`useEffect` and return its `dispose` as the cleanup; never build the op server
in `useMemo`, because StrictMode mounts twice.

- **Every op answers a Reply.** The op map must declare a `Reply<T>` result and
  an `IDeadline` in the params of every op, or `attachController<Ops>` does not
  compile. Each handler is wrapped, so a lane cannot lose a failure's kind or
  code by forgetting `toReply`:
  - a returned Reply passes through;
  - a plain value becomes `replyOk(value)`, and nothing at all becomes
    `Reply<null>`;
  - a tool failure that escapes becomes Reply data with its kind and code;
  - programming errors still throw.

  A returned object counts as a Reply only when its keys are exactly `ok` and
  `value` (or `ok` and a valid `error`). So a plain result that has an `ok`
  field, such as a probe result, is wrapped as data. **Those two shapes are
  reserved:** a domain value that has exactly one of them is taken for a
  Reply, so a handler answering one returns `replyOk(value)` explicitly.
- **The types refuse what cannot work.** An op whose params or result is
  `any`, or whose result is `never`, does not compile (an op that never
  answers is `Reply<never>`). Handlers are optional in `ControllerHandlers`;
  annotate production wiring with `RequiredControllerHandlers<Ops>` so that a
  missing or misspelt op is a compile error.
- **The op server sees calls only.** It subscribes through a shim that drops
  every other envelope, so a channel event that shares an op's name can never
  run a handler. The controller's channel still hears every event.
- **Readiness.** Once every handler is served, the controller publishes
  `{ ready: <nonce> }` on the state topic `devtool:controller`
  (`CONTROLLER_STATE_TOPIC`), and `{ ready: null }` when the live mount
  unmounts. Frames send nothing before they see a nonce. The `devtool:` prefix
  (`RESERVED_STATE_PREFIX`) is reserved for this library: lanes never publish
  under it (the shell reserves `host:` the same way).
- **Held calls, and dropped ones.** The peer holds a frame call only while NO
  subscriber at all is on the sidebar peer, and hands it to the next
  subscriber. The calls held that way reach the handlers once they are all
  registered, and the deadline decides whether each one runs. But both hosts
  build the sidebar channel during render (VS Code `DevToolSidebarMount.tsx`,
  rocket-ui `DevToolMount.tsx`), before the controller's effect, and that
  channel holds the live slot until the op server subscribes. A call that
  arrives in that window goes to the channel, which drops it. Readiness is
  what keeps frames from sending then.
- **Without a host channel** (a test-only path: both real hosts pass a sidebar
  channel), the fallback channel's first subscription hands any held calls
  over to the op server instead of swallowing them.

**Identity** ([`identity.ts`](../../../apps/shared/src/explorer/devtool/identity.ts)).
`createIdentityTracker({ cm })` reports `{ known, identity, fingerprint }` and
fails closed:

- A disconnect, a logout or an organization change makes the identity unknown.
  Logout and organization change stay unknown until a real account arrives.
- In a realm that owns the client (rocket-ui), the source is the SDK client's
  account, which every handshake refreshes. It is not
  `ConnectionManager.getAccountInfo()`, which keeps the account from sign-in.
- In a socketless realm (VS Code), the source is the root's retained
  `shell:account` topic, read at mount and on every reconnect. The realm's
  manager ignores the `null` that topic carries after a sign-out.
- A reconnect never brings back the account from before the drop. Account A,
  then a disconnect, then a reconnect as B reads A, unknown, B.
- A topic delivery is newer than any root read still in flight, so a late read
  never overrides it.
- An anonymous or public attach never yields an identity. The SDK sets no
  account for it, and the shell emits `shell:connected` only for an
  authenticated client. The tracker also requires a client realm's client to
  report `isAuthenticated()`.

**Activation** ([`activation.ts`](../../../apps/shared/src/explorer/devtool/activation.ts)).
The first discovery waits until the tool has been activated. Both hosts build
a store tool's sidebar only when its tab is first selected, or when one of its
frames summons the controller (`host.mountToolSidebar`), and then keep it
mounted. So the mount itself counts as the activation in any realm the gate can
classify: a client realm (rocket-ui) or a **socketless** one (VS Code:
connected, `getClient()` null). The selection's `shell:toolSidebarActivated`
fires before the sidebar can hear it, so the gate cannot wait for it.

A bus the gate cannot classify (no `getClient`) waits for the first of these:

- `shell:toolSidebarActivated` for this app;
- the first op from a frame;
- a string `activeDocKey` (`''` is the generic frame);
- `open('user')`.

Before #2625 `9bd5d931f`, rocket-ui mounted every pinned controller at boot,
and the gate kept a client realm closed until one of those signals arrived.

**Discovery** ([`watch.ts`](../../../apps/shared/src/explorer/devtool/watch.ts)).
`createDevToolDiscovery({ cm, client, identity, activation })` gives the store's
watch. It allows discovery only while the identity is known **and** the tool is
activated. It forwards identity changes (unknown resets the store), and
registers the task monitor only once discovery is allowed. It refreshes once
whenever discovery becomes allowed, and again when the identity switches
between two known fingerprints. A change in permission hints alone refreshes
nothing.

**Frame identity** ([`frameIdentity.ts`](../../../apps/shared/src/explorer/devtool/frameIdentity.ts)).
The controller publishes `{ fingerprint }` on the `identity` state topic with
`publishIdentityState(channel, tracker)`. In each frame,
`createFrameIdentityGuard({ channel, docKey, documents, onReset })` remembers
the first fingerprint it sees and keeps following:

- every different one calls `onReset('identity')`, so the frame clears its
  caches, and is adopted. A document frame also closes
  (`documents.close(docKey)`), at most once. `closed()` latches only on a
  close that returned: with no `documents`, or a close that threw, the next
  change tries again. A landing frame (`docKey` undefined or `''`) is reset
  but never closed;
- `null` calls `onReset('unknown')`;
- `host:connection` turning false calls `onReset('disconnected')`.

`publishIdentityState` publishes nothing until the tracker settles
(`whenSettled`: at once in a client realm, after the root read in a socketless
one) or knows an identity. So a controller remount, whose new tracker starts
unknown, does not make live frames reset for nothing.

`followSignIn(channel, onChange)` tells a frame what it may say about the
account. It reports one of three states:

- `'pending'`: nothing published yet; claim nothing;
- `'nobody'`: the controller vouches for no one; say "waiting for sign-in", not "not connected";
- `'signed-in'`: a fingerprint was published.

**Summoning the controller** ([`summon.ts`](../../../apps/shared/src/explorer/devtool/summon.ts)).
Since #2625 `9bd5d931f`, a host builds a tool's sidebar only when the tool is
selected, or when busPeer summons it: while no controller is subscribed, the
sidebar peer holds frame messages and emits `host.mountToolSidebar` once per
hold period. `createControllerSummon({ channel })` uses that on purpose.

- **What it sends.** A frame whose controller has published no readiness nonce
  sends one `devtool:summon` event once `SUMMON_SETTLE_MS` have passed. It
  re-sends at `SUMMON_RETRY_MS` while no nonce arrives, and sends nothing
  while the host says it is disconnected. The re-sends help only a sidebar
  peer that rocket-ui arms late. A peer whose host has no mount handler (a
  collapsed rocket-ui sidebar) latches busPeer's one summon per hold, and the
  re-sends are only held; the frame then says to open the sidebar.
- **It is an event, never a call.** On the summon-driven mount, a call held in
  the peer is delivered into the host channel and dropped. No controller
  listens for the event, so its replays do nothing.
- **Its states.** `state()` is `'summoning'` for `SUMMON_GRACE_MS`, then
  `'unanswered'`, or `'ready'` once a nonce arrives. Say "open the sidebar"
  only when the state is `'unanswered'`.
- **The retained slot.** The event takes the peer's retained last-payload slot,
  so a frame re-announces its own hints (such as `active`) once a controller is
  ready.

**Grid layouts: never hand Tabulator a stored object** ([`gridPersistence.ts`](../../../apps/shared/src/explorer/devtool/gridPersistence.ts)).
A shell `DataGrid` with a `tableId` persists its layout through the grid config
channel. That covers Tabulator's sort, columns and page blobs, and DataGrid's
own display and format blobs. The host answers from the active app's workspace
prefs.

On #2625 `9bd5d931f` this freezes the page:
1. The host hands a stored blob out by reference.
2. Tabulator's sort module rewrites the sorter list it reads in place, putting
   its live column object where the field name was. That list is the workspace
   store's own object, so the column is now in the prefs.
3. Only a later sort write would replace it, and the web host's bridge merges
   each write over the prefs it saw at its last render. So a write of another
   blob in the same pass keeps the rewritten list, and can even undo a sort
   write.
4. The next workspace save never finishes: the SDK's message redaction walk
   does not end on a Tabulator column.

Once a sort is stored, any remount of the grid reads it again (a page switch, a
re-run, a reload). So this hits a full app as surely as Rocket Builder.

So every explorer grid takes `persistence={env.gridPersistence}`, and both
choices below store and hand out plain-JSON copies:
- **A dev-tool frame** uses `createSessionGridPersistence()`, one per realm. Its
  active app is the host, whose prefs a store tool must not write, so layouts
  stay in memory. In Rocket Builder that is until the page reloads. In VS Code
  each document is its own panel and realm, so it is as long as that panel.
- **A full app** uses `createCopyingGridPersistence(() => createMessageGridPersistence())`,
  passing in the shell's own channel factory. The adapter is made on first use,
  so building an env never touches the shell, and a test can stand in a
  channel first. Layouts stay in the app's own prefs.

Tests use `installHostGridBridge` and `tabulatorSetSort` from
[`devtool/testing.ts`](../../../apps/shared/src/explorer/devtool/testing.ts): the
real channel behind a stand-in `document` whose bridge answers by reference, as
the web host's does.

**Retained state stays small** ([`state.ts`](../../../apps/shared/src/explorer/devtool/state.ts)).
The cost of a publish is the whole state map. The sidebar peer republishes the
WHOLE map on every publish, and the VS Code bridge posts it to every frame
realm. So every publish of any topic re-delivers EVERY topic to every frame
there, and **a frame's `onState` handlers must be idempotent**. Every frame
also replays the map when it attaches.

**Lanes publish summaries that are bounded by construction**, and bulk data
(rows, samples) travels as op results. `guardRetainedState(channel)` is the
backstop:

- **Limits.** It holds each snapshot to `MAX_RETAINED_STATE_BYTES` (64 KiB of
  JSON, measured by `jsonByteLength`) and all of its topics together to
  `MAX_RETAINED_TOTAL_BYTES` (128 KiB). It tracks the last size per topic, and
  `retainedBytes()` reports them.
- **It degrades.** It replaces an oversize snapshot with the lane's
  `shrink(topic, snapshot, info)`, or else with `truncateLists`. That cuts the
  largest list properties and records `truncated: { <prop>: { kept, total } }`
  (the key `truncated` is reserved in guarded snapshots).
- **Withholding is the opt-in** (`withhold: true`), and throwing is
  `strict: true`, for tests. By default nothing is thrown into the publisher.
- **Reports.** `onOversize` reports every case, with its `outcome`, and
  `assertRetainedStateSize` lets a test pin the largest snapshots.

**History in dev-tool mounts** ([`prefs.ts`](../../../apps/shared/src/explorer/devtool/prefs.ts)).
Store tools get no workspace preferences, so the controller passes the history
store `createFsPrefs({ cm, path: historyPrefsPath('<tool>'), owner: fingerprint, ownerNow })`.
That is a file at `@/User/.workspace/rocketride.<tool>.history.json`, attached
with `attachWhenLoaded(prefs, (api, owner) => store.attachPrefs(api, owner))`.

- **Load first.** `client.fsStat` then `client.fsReadJson` run before the
  attach, so the store never starts empty and its first write never clobbers
  the file. A change made before or during the load is queued, applied over
  what the load read, and written once it is ready.
- **First run vs unreadable file.**
  - The engine's `fs_stat` answers `{ exists: false }` for a missing file AND
    for a missing parent folder (`FileStore.stat`,
    `packages/ai/src/ai/account/file_store.py`), so a first run is always
    ready.
  - A failed request is retried (`PREFS_LOAD_ATTEMPTS` in all) before the
    session falls back to memory.
  - A file that exists but cannot be read, or is in an unknown or newer
    format, is never written; history stays in memory for that session.
    That includes a zero-byte file, such as one left by an interrupted write
    before #2625 `9bd5d931f` made `fsWriteJson` a single request. It never
    parses, so history stays in memory in every session until the file is
    deleted by hand.
- **One bag per identity fingerprint.** At most 8 bags are kept. The owner is
  checked before every file request and again after every awaited one (a
  write's mkdir, a load's stat and read).
  - A write that falls due while nobody is vouched for (`ownerNow()` null, a
    reconnect) is held. It looks again at most every 30 s, without using up
    the failure retries, and lands once the same owner is back. A load waits
    the same way before its next request.
  - A different owner drops a pending write and stops a load.
  - An answer that arrives after the owner changed is discarded: a load reads
    again once the owner is back. A write is composed only after its mkdir
    settled and the owner was checked again.
  - After `dispose()`, nothing is sent and nothing read is accepted.
- **Writes.** They are debounced and serialised, and the first one runs
  `client.fsMkdir` on the folder.
  - A failed write retries with backoff (`PREFS_WRITE_RETRIES`).
  - The file is capped at twice the 256 KB history bag, measured as the SDK
    writes it (two-space indented JSON).
  - Every fs request has an explicit timeout.
  - `@/User/.workspace/…` and SQL's scope-less `.workspace/…` are the same
    folder.
- **Last writer wins across windows** (a known limitation). Drafts and
  captions stay session-only.

**Rules a controller must follow** (they come from the shell's `busPeer.ts`
and `toolOps.ts`):

- The sidebar peer has **one** live subscriber, whichever subscribed last.
  Nothing may subscribe after the op server, and the controller never calls
  `peer.subscribe` itself. Nothing at runtime can catch a stray subscriber, so
  each app keeps two guards:
  - **One wiring module.** `createToolChannel`, `createToolOpServer` and
    `createToolController` are imported in ONE wiring module per app. A
    source-reading test pins this with `findToolFactoryImports` from
    `testing.ts`. That helper is an accident guard, not a boundary: it reads
    text, and catches named, aliased, namespace, default, re-export and
    dynamic imports in either quote style.
  - **A mount test.** The lane's mount test ends with
    `assertSidebarSubscribers(spy)`, which requires exactly two live
    subscriptions: the channel, then the op server.
- The live subscriber hears every frame event twice, and a remount replays the
  last one. Events are idempotent hints only and every mutation is an op. Rod's
  op server would run an event that shares an op's name, so
  `attachController`'s shim drops events before the op server sees them. Even
  so, keep event and op names disjoint.
- Calls are held only while no subscriber at all is on the sidebar peer, and
  `attachController` passes held calls to the handlers, so the deadline
  decides whether each one runs. A call that arrives while another subscriber
  (the host channel) holds the slot is dropped; frames wait for readiness to
  avoid that.
- A sidebar mount posts no event and no call, opens no document and registers
  no monitor; its only posts are retained state (readiness, identity).

**What the platform loses.** In VS Code, the controller's own `client.tool`
failures arrive without `code`: the bus bridge carries messages only. So the
`TASK_STOPPED` retry and the stopped-versus-unreachable probe split cannot work
there, and no code is ever rebuilt from message text. There are no brokered
`chat` or pipe ops, so features that need them must degrade in dev-tool mounts.

**Testing** ([`testing.ts`](../../../apps/shared/src/explorer/devtool/testing.ts)).
The harness runs the shell's **real** `busPeer`, `toolOps`, `toolChannel` and
retained registry, imported from source by relative path.

- **The JSON wire.** By default `createDevToolHarness` carries every bus
  payload as its JSON image, as VS Code's postMessage does, and records each
  payload that JSON would change in `h.violations`. A test that asserts
  `h.violations` is empty proves R4 end to end. The shell envelope's own
  optional fields (`payload`, `args`, `result`, `error`) may be absent;
  whatever they hold is judged in full. `{ json: false }` models rocket-ui's
  in-process realm.
- **Helpers.** It adds `assertJsonSafe`, `settle()`, `spyPeer`, the two quirk-1
  guards above, and fake VS Code and rocket-ui realms whose rules cite
  `connection.ts`.

## Known limits

- The React hook and the components that import from `shell` are type-checked
  and bundled but have no DOM tests: the repository has no component test
  harness. The runner's rules are covered by the pure batch suite.
- Vector roles are tested with mocks only.
- A pipeline launched without `project_id` can collide with a lookalike (see
  [Endpoint keys](#endpoint-keys)).
- The server has no `TASK_RESTARTING` code and no permission-denied code, so
  `inaccessible` is an identity-permission hint plus a failed probe, and a retry
  needs re-discovery.
- SQL Explorer's `execute` has no client timeout (SQL nodes set no statement
  deadline; the app offers Stop waiting). Schema reflection waits up to 5
  minutes and the engine check 15 seconds.
- Nothing cancels a running tool call. Stop waiting stops the client, not the
  node.
