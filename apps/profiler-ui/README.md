# Profiler

Find out where the time goes. The Profiler starts a cProfile session on your
connected server process or on any running pipeline task, and when you stop
it, lays the result out SnakeViz-style: a sunburst or icicle chart over a
call-stack breadcrumb over the full pstats function table, with the raw text
report one click away. Click into the chart or the table to re-root the
visualisation on the function you care about.

The Profiler runs in the RocketRide shell and as a panel inside the
RocketRide VS Code extension. It is the same app either way, and it always
profiles the server your shell is connected to.

## Before you start

- **An authenticated connection.** The app profiles the host's connected
  engine; there is no server picker inside it.
- **A running task, if you want to profile a pipeline.** The target dropdown
  lists the tasks currently running on the server (refreshed every ten
  seconds). To profile the server process itself, no task is needed.
- **Tolerance for overhead.** cProfile instruments every Python call in the
  target process, which slows it down while the session runs. Profile when
  you are hunting a problem, not permanently.

## Running a profile

All session controls live in the sidebar:

1. **Pick a target** — `Server Process`, or one of the running tasks (shown
   with name and status).
2. **Name the session** if you like; the name appears in the status line and
   the report. Left empty, the server names it.
3. **Start Profiling.** The status line switches to
   `Profiling "<session>" (owned by <client>, N.Ns)` and counts up. The
   chart area stays empty while the session is live — data exists only once
   the session stops.
4. **Stop Profiling.** The app fetches the report and renders it.

Sessions are server-side state, shared with every client: the status line
names the owner, and a session started here can be stopped by another
client — or by the CLI — and the other way around. `rocketride profile
start / stop / run / status / list / report / threads / tree` drives exactly
the same server-side profiler, so `rocketride profile run --duration 30`
followed by opening this app shows the same report the CLI can print as a
tree.

If the server already holds a report for the selected target (from an
earlier session, yours or anyone's), the app loads it when it opens, so a
freshly opened Profiler is not blind to work already done. **View Report**
opens the raw pstats text in a modal at any time a session is not active.

## Reading the results

- **The chart** — `Sunburst` (rings out from the root) or `Icicle`
  (flame-graph layout), chosen in the toolbar. Arc size is cumulative time.
  Clicking an arc re-roots the chart on that function; **Reset Root** goes
  back to the top. `Depth` (3–20) and `Cutoff` (hide calls below 1/1000 or
  1/100 of total time, or show everything) control how much of the tree is
  drawn — they prune the picture, not the data.
- **System calls** — off by default, so you see your project's code. Turn it
  on to include library and interpreter internals; the tree is re-fetched
  with them included.
- **Thread** — on servers that report per-thread data, a dropdown offers all
  threads merged or any single thread (name, tid and total time in the
  label). On older servers the selector simply does not appear and
  everything is merged.
- **The call stack** — once you have re-rooted, a breadcrumb shows the path
  from the original root to the current one; every entry is clickable.
- **The stats table** — the flat per-function totals in pstats column order:
  `ncalls`, `tottime`, `percall`, `cumtime`, `percall`,
  `filename:lineno(function)`. Sortable by any column, searchable, and it
  always shows all functions regardless of where the chart is rooted.
  Clicking a row re-roots the chart on that function.

## Limits

- **Python only.** cProfile measures the Python interpreter inside the
  target process. Time spent in native code is attributed to the Python
  call that invoked it, not broken down further.
- **One session per target.** Starting a session on a target someone else is
  already profiling fails, and the status line tells you who owns it.
- **Starting a new session discards the previous result.** The server keeps
  one report per target — the latest — and the app clears its view when a
  new session starts.
- **Tree numbers below the first level are shares, not measurements.** The
  call tree distributes each caller-to-callee total across the paths that
  reach it, with call counts rounded, so deep-path figures are a fair
  apportioning rather than exact per-path timings. The stats table's totals
  are the exact pstats numbers.
- **No export.** The report lives in the view; the raw-report modal is
  selectable text, but there is no download, and nothing is saved on your
  machine. Use `rocketride profile report` to capture the text elsewhere.
- **Thread breakdown depends on the server.** Without the thread-list
  command on the server, all threads are merged and no selector is shown.
