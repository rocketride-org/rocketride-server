# Vector Explorer: notes for contributors

The app's README is what users read on the app's page, so contributor notes
live here. The store-side contract (the tools, their answers, codes and
limits) is `docs/development/nodes/vector-tool-contract.md`.

## Layout

- App id `rocketride.vector`, development port 3103. How apps are built,
  registered and served in this repository is in
  `docs/development/apps/index.md`.
- `src/contract/` is the frozen seam between the console, the map and the
  chat/ingest code: the wire types every tool answers with, the console model,
  the shared selection (`bridge.ts`) and the props of every component one part
  of the app renders for another. A change to it is a decision for all three.
- `src/vector/` is plain TypeScript with no browser or shell dependency, so it
  runs under `node:test`: reading answers (`results.ts`), wording (one
  sentence per code and caveat), the statistics cards and chips, the document
  listing and its auto-pager, the folder tree and grid logic, staged removals
  and their confirmations, connection cards, the console model and
  the console controller (`consoleStore.ts`, which owns the console's calls
  and their pacing with an injected clock).
- `src/adapters/explorer.ts` is the one place the app takes from the shared
  Explorer library (`apps/shared/src/explorer`): providers, the tool table,
  the probe, the endpoint store over `VECTOR_ROLES` with its node filter,
  history, the announcer and the cache registry a change of identity clears.
  `adapters/react.ts` is the only file that imports the library's shell-bound
  React bindings.
- The views (`src/views`) and components render what the pure modules decide.
  The console is the first view of every connection: a header, a tab row
  (Overview, Documents, Query, Map, Collection, Trash), the banners and one
  panel per tab, built the first time its tab shows. A stored document opens in
  its own tab. Removals are confirmed inline in both mounts
  (`components/InlineRemoveConfirm.tsx`); the only dialog left is the upload's
  replace question (`ingest/ReplaceConfirmDialog.tsx`).
- The app imports the shared library as `shared/*` (tsconfig paths), so its
  manifest declares `"include": ["apps/shared"]`.
- The pipeline templates in `templates/` are not part of the build: users get
  them from the repository (the README links them).

## Mounts and the env seam

- Three mounts: the full app (`app:`, `VectorApp.tsx`) and, as a dev tool,
  the sidebar CONTROLLER (`VectorDevToolSidebar.tsx`) and each document FRAME
  (`VectorDevTool.tsx`). Views never call `useShellConnection` or the
  adapter's store: they read the VectorEnv through `envContext.tsx`
  (`useVectorEnv`, `useConnection`, `useLiveEndpoint`, `useEndpointsState`).
  The env type and its pure helpers are `src/env.ts`. The full app and the
  controller use the LOCAL env (`src/localEnv.ts`): the full app over the
  store singleton and its SDK client (the client it uses for chat and uploads,
  which the bus does not carry), the controller over its own store and the
  realm's bus-backed client. A frame uses the REMOTE env built by
  `src/devtool/frame.ts`, which holds no client.
- Connection objects (console controller, selection, tab, scope) live in a
  per-mount registry (`createConnectionRegistry` in `adapters/connections.ts`)
  and call their store through a link read at call time. The full app's is the
  module-level `appConnections` (`connectionEntry`, cleared with the
  connection caches); each frame has its own, so a confirmation shows only in
  the document that asked. A frame's reset clears its own registry. Only an
  account change also forgets the frame's own connection in the realm's
  caches (`connectionCaches.forgetKey`; a cache kept per connection registers
  how to forget one, and the chat and uploads, which a frame never holds,
  register none). The host connection dropping, or the identity becoming
  unknown, forgets nothing there: in rocket-ui the realm may also run the full
  app, which keeps a connection's saved views and filters, chat and uploads
  across a reconnect.
- `src/devtool/protocol.ts` is the contract: the `vector.*` ops (each answers
  a Reply and carries a deadline; a tool op is `{ key, input }` with the
  tool's own input, a write also names the calling frame as `origin`), the
  fixed state topics (`endpoints`, `identity`, `docVersions`, `queries`,
  `consoleSummary`, `focusRequests`, `mapRequests`, each budgeted and cut by the
  protocol) and the events (`active`, `queryChanged`, `consoleSummary` from
  frames; `focusChunk`, `showOnMap` to frames). `waitFor` names each op's
  session wait (a sample its budget, capped at 300 s, plus 30 s; search and
  embed 60 s; everything else the statement deadline plus 10 s, or 40 s); the
  controller asks the session for exactly that, the bus adds 6 s and the frame
  5 s more (`frameTimeoutFor`).
- `src/devtool/controller.ts` serves it. It resolves the key to its endpoint
  and the node (the embedding node for `embed`), answers the raw tool value
  (failure envelopes included: the frame unwraps them with their code), caps
  results (`RESULT_TOO_LARGE`) and arguments before any call, re-checks the
  write gate on its own record and probe for every write, sends a write once
  and bumps `docVersions` for every write that ran or timed out. Each version
  carries the controller mount's `epoch` (a remounted controller counts again
  from 1). Over its budget the snapshot keeps every connection's stamp first
  and gives the list of documents that left (`gone`) back to the newest writes
  that fit (`versionsSnapshot`): a stamp that left and came back would read as
  a new write. A bump names the asking frame as `origin` only when the write
  answered (that frame relists itself); a timeout, or an answer still over the
  cap after it was cut to the fields a frame reads, names no frame, so the one
  that asked relists too. A call that arrives before its discovery listed and
  probed the connection (a call held across a remount) waits for it, then runs
  with what is left of its deadline less a second, and is not sent when less
  than a second is left. `src/devtool/wiring.ts`
  is the only module that imports the shell's protocol factories. Both build on
  `shared/explorer/devtool` (see `docs/development/apps/explorer-library.md`).
- `src/devtool/frame.ts` holds the frame's side as plain functions:
  `remoteChannel` (each tool to its op; generation tickets checked locally; a
  call no controller took says to open the sidebar), `bindConsole` (the
  console's query and median out as hints, sent again to a controller that
  remounted without them; another frame's write in, which relists, refreshes,
  probes, redraws the map and forgets what left; map requests in, taken once),
  `bindDocument` (the console's query in for the heat strip, focus requests in,
  every write in), and `documentActions` (Show on map goes to the console).
  Both bindings follow a connection's versions by (epoch, version), and a map
  that no longer holds the connection forgets what was seen. The
  React mount only routes the docKey and calls these in effects. What a
  document shows before it can open is `connectionDocState` in
  `src/devtool/frameText.ts` (F13 order).
- No window-wide overlay in either mount: confirmations are
  `components/InlineRemoveConfirm.tsx` (the `vector/confirm.ts` content,
  through `confirmationFor`) and the connection details
  `components/ConnectionDetailsPanel.tsx`; neither has an overlay or a
  document or window listener. The sidebar list is
  `components/DevToolConnectionList.tsx` (wording in `vector/connections.ts`:
  `connectionRow`, `rowStatusText`, `sidebarListLine`); the full app keeps
  `VectorSidebar` and `ConnectionsView`.
- Degraded in a dev-tool mount (R11): the REMOTE env serves the console model
  with chat and uploads off and their notes (`devToolConsoleModel`); the Query
  tab's Ask says so and offers Use Search, so Search and Compare stay reachable,
  and Add documents opens with the reason. A refused
  download keeps its text (`ExportOutcome.copy`) for **Copy as**; refused
  copies are announced. One live region serves each realm
  (`components/RealmLiveRegion.tsx`), the full app's included.

## Tests

- `./builder vector-ui:test` type-checks `src` and `tests`
  (`tsconfig.test.json`), then runs every `*.test.ts(x)` in `tests/` (flat;
  fixtures and helpers live in subfolders). It fails if `tests/` is missing or
  holds no test file, or if a suite named in `REQUIRED_TESTS`
  (`scripts/tasks.js`) is missing. Test files not in that list run as well.
- No React renderer runs under `node:test`. Logic lives in pure modules with
  unit tests; the React-side rules (the console is the first view, the map a
  tab, the focus rules of a confirmation, no token or node configuration rendered, the identity
  reset wired) are pinned by reading the source in `tests/vector.wiring.test.ts`.
- `tests/fixtures/provisional/` holds hand-written tool answers shaped by the
  contract; `tests/fixtures/defaults.json` is generated from the node's
  `vx_defaults.py` by `scripts/gen_defaults.py` (so the templates test follows
  a change of the write default), and `tests/fixtures/chunking.json` holds the
  calibrated chunking the templates carry.
- A test whose subject lives outside the app (the browser lanes and their
  privacy checker in `scripts/acceptance/vector-explorer/browser`) asserts
  that the file is there instead of skipping: a missing lane fails the suite.
- The dev-tool suites (`tests/devtool.*.test.ts`) run the controller and
  frames over the shell's REAL bus peer, op lane and channel through the base's
  harness (`shared/explorer/devtool/testing`, JSON wire on), with a fake engine
  behind the base's fake VS Code and rocket-ui realms (`tests/support/`). They
  dispose what they mounted after each test, so a failing test leaves no timer
  behind.
- `./builder vector-ui:e2e-live` runs the browser lanes in
  `scripts/acceptance/vector-explorer/browser` against `ENGINE_URL`. It is
  opt-in: not part of `vector-ui:test`, `builder test` or CI.

## Build

- `./builder vector-ui:build` bundles the app, registers it and copies it to
  the served directory. Rebuilding an app at the same version needs the
  engine's store reset before the server serves it again.
- The bundle exposes only `./AppDescriptor`; `react`, `react-dom`, `shell`
  and `rocketride` come from the shell at run time.
