# Graph Explorer: notes for contributors

The app's README is what users read on the app's page, so contributor notes
live here.

## Layout

- App id `rocketride.graph`, development port 3102. How apps are built,
  registered and served in this repository is in
  `docs/development/apps/index.md`.
- The code under `src/graph`, `src/cypher` and `src/layout` is plain
  TypeScript with no browser or shell dependency, so it runs under `node:test`.
  The shared Explorer library (`apps/shared/src/explorer`) provides discovery,
  the tool session, history and the statement runner.
- The app imports that library as `shared/*` (tsconfig paths), so its manifest
  declares `"include": ["apps/shared"]` for the App Builder and
  `rocketride app deploy`, which pack only the app folder and its include roots.
- The pipeline templates in `templates/` are not part of the build: users get
  them from the repository (the README links them).

## Mounts and the env seam

- Three mounts: the full app (`app:`, `GraphApp.tsx`) and, as a dev tool, the
  sidebar CONTROLLER (`GraphDevToolSidebar.tsx`) and each document FRAME
  (`GraphDevToolFrame.tsx`). Views never call `useShellConnection`, `usePrefs`
  or the adapter's stores: they read the GraphEnv (`src/env.ts`). The full app
  and the controller use the LOCAL env (`src/localEnv.ts`) over their own
  stores and the realm's bus-backed client; a frame uses the REMOTE env built
  by `src/devtool/frame.ts`, which holds no client.
- `src/devtool/protocol.ts` is the contract: the `graph.*` ops (each answers a
  Reply and carries a deadline), the retained state topics (each under 64 KiB;
  rows and history lists travel as op results) and the `active` event.
  `src/devtool/controller.ts` serves it (it re-checks the write gate and counts
  writes); `src/devtool/wiring.ts` is the only module that imports the shell's
  protocol factories. Both build on `shared/explorer/devtool` (see
  `docs/development/apps/explorer-library.md`).
- Schema loads are STARTED across the channel, not awaited. `graph.loadSchema`
  answers once the controller has started the load (a frame waits at most
  15 s for that), and the outcome arrives as `schemas` state. At the
  controller the load is bounded by the session's own waits (`get_schema`
  60 s, `refresh_schema` 135 s; a refresh asked for during a first load runs
  after it, so about 3.5 minutes at worst) and always ends as `ready` or as
  `error` with its reason, never as an endless `loading`. Holding a frame call
  open for that long (the "~150 s frame timeout" a single `refresh_schema`
  would need) would give nothing: a frame uses the schema only for label
  colours, and the schema tree is drawn in the sidebar, which runs the load
  itself. `graph.refreshEndpoints` works the same way: discovery and probes
  report through `endpoints`.
- History changes are ops. The History panel announces a change ("Note
  saved.") only when the controller's Reply confirms it, and says why when it
  fails. A history store attaches under one identity at a time, through one fs
  accessor per identity whose `ownerNow` reads the controller's identity
  tracker (owner known: write; nobody known: the base holds the write; someone
  else: the base drops it). A disconnect, a sign-out or an account switch
  reaches the tracker before anything unmounts, so `syncHistory` hands the
  store's pending batch to the outgoing owner's accessor (`flush()`) BEFORE the
  detach, and still forgets that owner's entries in memory at once, so nothing
  of A is served to B while B's file loads. While nobody is known the accessor
  is HELD and re-used for the same owner (its change goes out at once). For
  another owner it is flushed while that owner is known, so the base drops the
  change. When the controller unmounts with an owed accessor (VS Code, on a
  disconnect) the accessor and its tracker are PARKED for the realm
  (`devtool/owedHistory.ts`): the next controller adopts it; otherwise it
  writes when its owner is back, drops for another, and is released after 10
  minutes. Known limit: a run recorded after a switch, while the new owner's
  file is still loading (it waits, unhydrated, in the store), is dropped if the
  identity changes again before that load ends. It is never given to another
  owner.
- A disconnect does not keep a document's work. The controller resets its
  store (the identity is unknown), and both hosts unmount the documents while
  the server is unreachable (rocket-ui's DevToolMount, VS Code's panel), so the
  editor text, results and graph are gone; the frame identity guard's
  "disconnected" reset only clears data caches for the time a frame is still
  mounted. VS Code also unmounts the controller, which remounts with fresh
  stores; frames announce themselves to it on its new readiness nonce.
- A frame summons a controller that is not ready with the base's
  `createControllerSummon` (one reserved non-op event, never a call) and
  follows `followSignIn`; both are disposed with the frame. What a connection
  document shows is decided by `connectionDocState` in
  `src/devtool/frameText.ts`, the first state that applies winning: host
  connection false, not yet published, the summon's quiet grace, an
  unanswered summon, nobody signed in, then the list's own loading, omitted
  and not-listed texts. A document that has already shown its view keeps it
  while its controller is summoned again, except when nobody is signed in:
  then it waits for sign-in like any other document. The frame re-announces
  `active` on each readiness nonce, because the summon event takes busPeer's
  single retained slot.
- As a dev tool there is no Connections landing: the generic frame is one
  EmptyState, the sidebar lists the connections (`GraphSidebar` under
  `devtool`; wording in `graph/connections.ts`: `connectionRow`,
  `rowStatusText`, `sidebarListLine`), and a connection's document shows the
  connection details inline under its header (`ConnectionDetailsPanel`, state
  in `detailsPanelAfter`). Not a drawer: rocket-ui keeps hidden documents
  mounted, and a modal `DetailPanel` left open in one would trap Tab, lock the
  page scroll and take Escape for the whole realm; the panel has no overlay and
  no document or window listener. The full app keeps `ConnectionsView` as its
  `CONNECTIONS_URI` document, its menu entry and its `ConnectionDrawer`; both
  render `ConnectionDetailsBody` and test through `useConnectionTest`.
- Retained state: the base guard keeps each snapshot under 64 KiB and the
  whole republished map under 128 KiB. The controller's `shrink` hook degrades
  `endpoints`, `schemas` and `dataVersions` through the protocol's own cuts
  (so `omitted` and the newest-first schema order stay true), never through the
  generic `truncated` marker the frames would not read.

## Tests

- `./builder graph-ui:test` type-checks `src` and `tests`
  (`tsconfig.test.json`), then runs every `*.test.ts(x)` in `tests/`. It fails
  if `tests/` is missing or holds no test file, or if a suite named in
  `REQUIRED_TESTS` (`scripts/tasks.js`) is missing. Test files not in that list
  run as well; the list only guards suites that must not disappear.
- No React renderer runs under `node:test`. Logic lives in pure modules with
  unit tests, and the React-side rules that decide whether the UI stays in step
  with its state are pinned by reading the source (`tests/graph.wiring.test.ts`).
- The dev-tool suites (`tests/devtool.*.test.ts`) run the controller and frames
  over the shell's real bus peer, op lane and channel, with every payload
  carried as JSON as VS Code does (`tests/support/devtool.ts`). `mountFrame`
  runs each frame's summon on manual timers (`timers.advance(ms)`), so a suite
  sees a summon only when it moves time on.
- `tests/fixtures/v1/live/` holds answers captured from the real node tools on
  Neo4j, FalkorDB and Apache AGE; `tests/fixtures/provisional/` is hand-modelled
  and kept for the cases the live set does not cover.

## Build

- `./builder graph-ui:build` bundles the app, registers it and copies it to the
  served directory. Rebuilding an app at the same version needs the engine's
  store reset before the server serves it again.
