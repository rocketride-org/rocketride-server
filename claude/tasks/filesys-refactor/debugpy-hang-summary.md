# Problem Summary: Designer dev-runs hang when the server runs under the IDE debugger

**Date:** 2026-08-03 · **Branch:** `feat/filestore-node` · **Status:** root-caused, fix direction undecided
**Companion evidence:** `image-bug-repro.md`, `dev-hang-probe.md` (this directory); lldb stack dumps referenced below.

## One-paragraph version

The new File Store Source node delivers all of its data correctly but every object hangs in
PROCESSING forever — only when the run is started from the designer, and only when the
RocketRide server was launched under the IDE's Python debugger (F5). debugpy's default
`"subProcess": true` auto-injects the debugger into every task subprocess the server spawns;
in those children pydevd's communication thread blocks in an infinite `sock_recv` on an
adapter that never services the session, so the first mid-run pydevd interaction — an
engine-owned C++ thread entering Python, or a lazily-spawned asyncio executor thread —
wedges forever on pydevd's internal lock. The node is the first designer-runnable pipeline
whose Python executes on engine-owned threads, so it is the first tenant of a latent
platform problem, not the cause of it.

## Symptom

- Pipeline: `filestore_source → parse → response_text` (project 9f3b7e21), run from the designer.
- Trace tab: objects deliver data (tag frames reach parse in ~ms), then sit in PROCESSING
  indefinitely. Task idles at ~0.1% CPU. No errors, no tracebacks.
- Same pipeline submitted via the SDK in task mode (no debugger): completes in seconds,
  every time, with correct per-object begin/end accounting.

## How it was found (investigation chain)

1. **Flow-trace analysis** (run-log continuum, `rrext_log read`): all objects got `begin` +
   data-lane traversals, but the whole run contained **zero `close`-lane or `end` events**.
   → nothing ever closes the objects.
2. **First real finding:** the dev-mode runner, unlike task-mode `processItem`
   (`engLib/task/core/pipetask.process.cpp:650`), leaves per-object closure to the source.
   Fixed by ending each render with `sendClose()` (commit `a468e364`; engine-side close is
   documented idempotent; task-mode regression-verified). Hang persisted → deeper cause.
3. **lldb thread dumps of the live hung task subprocess** (three separate hangs):
   - Render thread `pipeline-0` (engine `ThreadedQueue` C++ thread running our
     `renderObject` via `IPythonInstanceBase::renderObject`, `python-instance.source.cpp:206`)
     frozen inside `_Py_call_instrumentation_line → call_one_instrument →
     lock_PyThread_acquire_lock` — debugpy line tracing endlessly retrying pydevd's lock.
   - After adding a `pydevd.settrace(suspend=False)` registration guard (commit `ffc9c7bd`):
     `pipeline-0` got through and progressed into the file read — and the wedge moved to the
     **lazily-spawned aiofiles executor threads** and to `pipeline-1..3`, all queued on
     pydevd locks.
   - In every dump: pydevd's comm thread parked in **infinite `sock_recv`
     (`timeout=-1`)** on its socket to the IDE debug adapter.
4. **Launch inspection:** the server process command line shows it was started via
   `~/.cursor/extensions/ms-python.debugpy/...` (an F5 debug session for `eaas.py`).
   debugpy's `"subProcess": true` default auto-attaches every child the server spawns —
   including all task subprocesses ("debuggerAttached": false in their status; the adapter
   never truly services these child sessions).
5. **Control experiments:** identical binary + node code in task mode (no debugger):
   3/3 objects, per-object `begin`+`end`, exact content, ~4s. A fully serialized/pre-warmed
   node variant also ran clean under the debugger (see "tried and reverted").

## Why only this node ever hit it

What matters is **which thread executes a node's Python**:

| Source | Python runs on | Mid-run pydevd traffic | Designer usage |
|---|---|---|---|
| `filesys://` (C++) | none (source itself) | none from the source | rare |
| webhook / chat / dropper | Python-born web threads, created at task startup | none at steady state | the default |
| telegram | Python-born aiohttp threads | none at steady state | common |
| **filestore_source** | **engine-born C++ threads (`pipeline-N`), entering Python mid-run** | registration + executor spawns per run | new |

The server-source family is debugger-safe *by accident*: their threads all exist and
register while the adapter is still handshaking. Our node uses the engine's intended
finite-source contract (scan-callback → `renderObject`, `task/pipe/Pipeline.cpp` "Connect
the scanObjects function to the renderObject function") — chosen deliberately because the
telegram-style push bypasses the scan counter and falsely reports "Files not found" +
failure accounting on finite runs. The correct architecture and the accidentally-safe
architecture are currently different architectures.

**Falsifiable prediction:** a `filesys:// → parse → response_text` pipe (C++ source, Python
terminal node) run from a debugged server should hang the same way — downstream Python
executes on the C++ source's engine threads. Untested; would prove the issue predates this
node entirely.

## Tried and reverted

Commit `b9bb401e` made the node debugger-safe by construction: `getThreadCount()=1`
(single render thread), one persistent I/O loop with a pre-spawned executor worker created
at scan time, zero mid-run thread creation. It passed task-mode regression, but was
**reverted by decision**: it serializes all data through one thread and bends the node
around debugger internals — wrong layer, and a tax every future Python source node would
have to copy. Kept on the branch: `sendClose` (`a468e364`, a genuine dev-mode contract fix)
and the settrace guard (`ffc9c7bd`, inert without a debugger; removable).

## Candidate fixes (decision pending)

1. **Task engine owns its children's debug story** *(recommended)* — scrub inherited
   debugpy injection at the single spawn seam (`packages/ai/src/ai/modules/task/task_engine.py:1932`,
   where `subprocess_env` is already built). Task debugging remains available through the
   platform's own sanctioned flow (`cmd_debug` → `DbgDebugpy` DAP client), which sets up a
   *serviced* adapter. F5-on-the-server workflow untouched. Needs a spike to confirm
   debugpy's child-injection mechanism (env vars vs argv rewrite) so the scrub is complete.
2. **Ship `"subProcess": false` in the shared launch config** — one line, protects everyone
   using the checked-in config; mitigation only.
3. **Root-cause the half-attach** — why do auto-attached children end up with an unserviced
   adapter (likely the engine-binary→python exec chain breaking session registration)?
   Ideal end state (task breakpoints from one F5) but highest effort/uncertainty.
4. **File upstream with debugpy** — pydevd freezing all threads forever on an unserviced
   adapter socket is a robustness bug; evidence bundle is ready. No near-term relief.

## Immediate workaround (verified recipe)

Run the server without the debugger when exercising engine-thread pipelines:
`Ctrl+F5` (Run Without Debugging), or
`cd dist/server && ./engine ai/eaas.py --host=127.0.0.1 --port=5565 --trace=debugOut`.

## Current branch state (`feat/filestore-node`)

12 commits over `origin/develop`. Node suite 69 green; contract suite 2354/0 at last full
run; File Store Source fully verified in task mode (single file / folder / recursive /
error paths, per-object close accounting). The only open item is the designer-under-
debugger scenario documented here — a platform decision, not a node defect.
