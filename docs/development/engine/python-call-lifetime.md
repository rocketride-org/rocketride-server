# Python call lifetime

How the engine keeps alive the objects that a running Python call into C++
uses while a pipeline ends, and how it refuses the calls that come after the
end. Read this before you change a `cb_*` callback, `forwardTo()`, the handles
behind `self.instance`, `IPythonInstanceBase::boundInstance()`,
`IServiceFilterInstance::endFilterInstance()`, `IServiceEndpoint::getPipe()` or
`IServiceEndpoint::endEndpoint()`. The node-author view of the same contract is
[Threads and the end of a pipeline](../nodes/index.md#threads-and-the-end-of-a-pipeline).

## Terms

| Term | Meaning |
| --- | --- |
| Filter | One C++ object in a pipe's chain (`IServiceFilterInstance`). A Python node is a filter of type `IPythonInstanceBase`. |
| Instance stack | The filters of one pipe, top to bottom. The top filter (index 0) is the pipe filter, also called the head. The endpoint keeps one stack per pipe in `m_instanceStacks`, guarded by `m_stackLock`. |
| Links | A filter's strong pointers to other engine objects: `endpoint`, `global`, `pipe` and `pDown`. The filter's weak self link `instance` is not a link in this sense: it owns nothing, it is never reset, and it expires when the filter is freed. |
| Handle | The Python object that stands for a filter: `self.instance`, a borrowed pipe, or the value of `next` or `pipe`. It holds only a weak link to the filter. |
| Python call | A call from Python into the engine through a handle: any `cb_*` callback in `filter.callbacks.target.cpp` or `filter.callbacks.source.cpp`, which Python reaches through `forwardTo()`. Also the three handle properties `next`, `pipe` and `currentObject`, and the endpoint method `putPipe(pipe)`, which create their own call guard. |
| In flight | A Python call that has passed the call gate and has not returned yet. |
| Gate closed | The filter's flag `m_ended` is set. `closeGate()` sets it during teardown and when a pipe build is not published, and the base `IServiceFilterInstance::endFilterInstance()` sets it too. It is never cleared, and `hasEnded()` reads it. "Ended" in `hasEnded()` and in the late-return warning means exactly this: the gate is closed. The links may still be valid then. |
| End of the pipeline | The end of the endpoint (`endEndpoint()`), at the end of the task. It is not the end of one request: one pipe serves many objects or requests in turn, and its gates stay open between them. |
| Ending | The endpoint's flag `m_ending`. Teardown sets it under `m_stackLock` when it takes its copy of the filters. From then on no pipe is handed out and no new stack is published. |
| Node ended | The Python filter's flag `m_pyEnded`. `IPythonInstanceBase::endFilterInstance()` sets it when it releases the node's Python object. |

## The invariant

> Invariant: the links (endpoint, pipe, global, pDown) and the buffers of a
> stack's filters are released only when no Python call that passed the gate
> runs on any filter of that stack: right after a full drain, or by the
> deferred release below. In a stack whose filters were never linked to each
> other (a pipe build that failed before its bind) this holds per filter: the
> head is released when no call runs on the head, and every other filter keeps
> its links until it is freed. Once a filter's gate is closed, every new Python
> call on it is refused. No filter object is freed while a Python call into the
> engine runs on it.

The same text is the doc comment on `CallGuard` in
`packages/server/engine-lib/engLib/store/headers/filter.hpp`. These pieces keep
it: the handle, the call gate, the drain in `endEndpoint()`, the deferred
release, and the refusal of new pipes once teardown has started. In addition,
`boundInstance()` keeps a late call out of a Python node that has ended.

One Python call, step by step:

1. Python calls a method on a handle, for example `self.instance.invoke(q)`.
   `invoke` calls the handle's `control` method, and `bindings.cpp` binds
   `control` to `cb_control` through `forwardTo()`.
2. `forwardTo()` calls the handle's `lock()`. It turns the weak link into a
   strong pointer to the filter for this one call. If the filter is gone, it
   raises "The pipeline has ended".
3. `forwardTo()` hands that pointer to a `CallGuard`, which holds the filter
   for the whole call. If the gate is closed, the guard raises "The pipeline
   has ended".
4. Otherwise the guard counts the call as in flight and takes a strong copy of
   `pipe`, the head of the stack.
5. `forwardTo()` calls the callback (here `cb_control`). The callback, and the
   binder code below it, read the link members. The invariant keeps them valid
   while the call is counted.
6. The guard lowers the count and, when the stack waits for this call,
   releases it. Then it lets go of the head, the filter and, when it released
   the stack, the endpoint, in that order. The result goes back to Python.

## The handle

Python never receives one of the engine's own filter objects. The filter
classes are not registered in `engLib`, so a filter cannot be cast to a Python
object. Python gets a handle instead (`FilterHandle` and its subclasses in
`packages/server/engine-lib/engLib/store/python/filter-handle.hpp`). A handle
keeps only a weak link to its filter. Every callback method on a handle goes
through `forwardTo()` in `filter-handle.hpp`, which calls `lock()`;
`bindings.cpp` binds each callback with it. Every property calls `lock()`
itself. When the handle is not bound yet, or the filter has been freed,
`lock()` throws `Ec::PipelineEnded` "The pipeline has ended".

| Python class | C++ class | What it is | Notes |
| --- | --- | --- | --- |
| `engLib.IFilterHandle` | `FilterHandle` | Base: every filter method and property | `engLib.IServiceFilterInstance` is an alias of it. |
| `engLib.IFilterInstanceHandle` | `NodeHandle` | A node's `self.instance` | Adds `targetObjectUrl` and `targetObjectPath`. `rocketlib.filters._patch_classes()` adds `invoke` and `sendSSE`. `engLib.IFilterInstance` is an alias of it. |
| `engLib.IServiceFilterPipeHandle` | `PipeHandle` | A pipe from `getPipe()`, and the value of `next` and `pipe` | `putPipe` takes it back. It has no `invoke` or `sendSSE`. `engLib.IServiceFilterPipe` is an alias of it. |

An alias is the same class object under a second name, so code that imports or
checks one of the alias names gets the handle class.

`IPythonInstanceBase::beginFilterInstance()` binds the node's handle to the
filter's weak self link just before it calls the node's `beginInstance`. A call
through the handle before that raises the same error. A thread that a node
starts in `beginInstance` must not call the engine before the engine's first
call to one of the node's handlers (for example `open`): until then the pipe is
not wired yet, because `bindFilters()` runs after every filter of the stack has
begun.

A handle does not keep a filter alive. A copy of `self.instance` kept in a
global, a closure or a thread keeps only the weak link.

What a call on a handle does at each stage:

| Call | Gate open | Gate closed, filter alive | Filter freed |
| --- | --- | --- | --- |
| Engine callbacks (`invoke`/`control`, `open`, `write*`, `send*`, `close`, `closing`, `hasListener`, `getListeners`, `getControllerNodeIds`, `add*` permission calls), and the properties `next`, `pipe` and `currentObject` | works | raises (call gate) | raises (handle) |
| `endpoint.putPipe(pipe)` | works | does nothing and raises nothing | does nothing and raises nothing |
| `pipeId`, `pipeType`, and `sendSSE` (it reads only `pipeId`) | works | works | raises (handle) |
| `targetObjectUrl`, `targetObjectPath` | works | works | raises (handle) |
| `pyInstance` | works | works until the Python node has ended; after that the read returns `None`, because the node's object is released | raises (handle) |

`targetObjectUrl` and `targetObjectPath` describe the object the node is
handling. Node code reads them only inside a handler, on the thread that runs
it.

## The call gate

`IServiceFilterInstance::CallGuard` (`filter.hpp`, `store/core/filter/filter.cpp`)
counts a Python call or refuses it. `forwardTo()` creates it with the filter
that `lock()` returned, before it calls the callback. The `cb_*` callbacks do
not create a guard themselves. Four members in `bindings.cpp` read links
without a callback and create their own guard: the handle properties `next`,
`pipe` and `currentObject`, and the endpoint method `putPipe`.

1. If the gate is closed, the guard throws `Ec::PipelineEnded` "The pipeline
   has ended".
2. Otherwise it adds one to `m_inFlight`.
3. Under `m_linkLock`, it copies `pipe`, the head of the stack, and notes
   whether `pipe` and `endpoint` are both set.
4. It checks the gate again. If the gate has closed in the meantime, or `pipe`
   or `endpoint` was empty because the links were reset, the guard leaves
   through `leave()` and throws the same error. `leave()` reaches the head
   through the copy from step 3.

`putPipe` builds its guard by hand, and a refusal there ends the call quietly.
When `lock()` or the guard throws `Ec::PipelineEnded`, `putPipe` returns
without an error and does nothing: once the gate is closed, teardown ends the
pipe's stack in any case, so no stack is left to take the pipe back. So a
`putPipe` in a `finally` block keeps the error that is being handled. While
the gate is open, `putPipe` gives the pipe back to the endpoint, also while
teardown waits in step 2 of the drain. The properties `next`, `pipe` and
`currentObject` raise the refusal. The rule behind this: once the gate is
closed, a call that only gives something back to the engine does nothing and
raises nothing, and a call that asks the engine to do work raises.

Every guard that raised the count leaves through `leave()`: the destructor of a
guard that passed, and a guard that refused in step 4. `leave()` lowers the
count and then calls `releaseStackIfIdle()` on the head, so a stack that waits
for its last call is released (see [At the deadline](#at-the-deadline)). The
count drops before the guard lets go of the head, so letting go of the last
owner of the stack never waits on its own call. `leave()` then lets go of the
head, the filter and the endpoint that the release returned, in that order, so
the stack's filters are freed before their endpoint, on the late call's thread
as well.

The guard holds the filter, as the strong pointer from `lock()`, and the head
for the whole call. The callback and the code below it read the link members:
`cb_control` reads `endpoint` and `pipe`, and `Binder::callMethods` reads
`endpoint`, `pipe` and `pDown`. The invariant is what keeps those valid while
the call is counted. `m_linkLock` is held only to copy or reset the links,
never across a call into Python or a wait. `stackFilter()` takes the endpoint's
`m_stackLock` while the calling thread holds the GIL, so code that holds
`m_stackLock` never calls into Python and never waits for the GIL.

`cb_control` and `cb_getControllerNodeIds` read instance-stack entries through
`stackFilter()`, which reads under the endpoint's `m_stackLock`. When the entry
is gone it raises "The pipeline has ended", after it has released the lock.

Rules for code in this area:

- A new `cb_*` callback is bound on the handle with `forwardTo()`, which
  creates the `CallGuard`. The callback does not create one itself.
- Any other new handle method or property, and any endpoint method that takes
  a handle, calls `lock()`. If it reads a link, it creates a `CallGuard` too,
  as `next`, `pipe`, `currentObject` and `putPipe` do.
- A new handler entry into a Python node (such as a `write*`, `open` or
  `control`) gets the node's object through `boundInstance()`, never through
  `m_pyInstance`. Only `beginFilterInstance()` and `endFilterInstance()` call
  the node's `beginInstance` and `endInstance` on `m_pyInstance` directly: the
  first runs before the node can end, and the second is the step that ends it.
- Code that adds a stack to `m_instanceStacks` checks `m_ending` under
  `m_stackLock` first, as `buildInstancePipe()` does.
- An override of `endFilterInstance()` calls its parent's. Teardown closes
  every gate itself, so the gate still closes without that call, but after a
  full drain the filter then keeps its links until its destructor runs.
  `IPythonInstanceBase::endFilterInstance()` skips its parent's call in two
  cases:
  - The node failed to bind (`m_boundError`: the node's Python object could
    not be created). It returns that error at once. Such a filter never joins
    a stack: its `beginFilterInstance()` returns the same error, so
    `buildInstancePipe()` closes its gate and drops it, and the filter's
    destructor releases its links.
  - The node's `endInstance` raised (a `preventDefault` included), so
    `checkCallParent` skips the parent's call. Teardown has already closed the
    gate, and the node still counts as ended. After a full drain the links
    stay until the destructor runs the base `endFilterInstance()`. After a
    drain that gave up, the deferred release resets them with the rest of the
    stack.

## The drain

`IServiceEndpoint::endEndpoint()` (`store/core/endpoint/endpoint.cpp`) works in
phases. It uses `drainInFlightCalls()` for each wait. A Python endpoint's
`IPythonEndpointBase::endEndpoint()` runs the node's `endEndpoint` hook and then
these phases; they run even when the hook raises, and the hook's error is the
one returned.

1. Under `m_stackLock`, it sets `m_ending` and copies the filters of every
   instance stack. No stack is published after this, so the copy holds every
   stack that step 5 ends (see
   [New pipes during teardown](#new-pipes-during-teardown)).
2. It reads `drainDeadline()` once, for the whole teardown. Gates open: it sums
   `callsInFlight()` over the filters. With nothing in flight there is no
   wait. Otherwise it checks the sum every 50 ms (`async::sleep(50ms)`) until
   it is zero, for about half of the deadline (5 s by default). The wait
   stops early when `async::cancelled()` is true: the calling thread was
   cancelled, or the global cancel flag is set. Calls may still start
   meanwhile, and they are counted. This wait gets only half because new
   calls keep coming in while the gates are open, and the wait with the gates
   closed must always have time for the calls that are already inside.
3. It closes the gate of every filter (`closeGate()`). From here a new call is
   refused.
4. It reads the sum again and, if it is above zero, waits again, for the other
   half of the deadline plus the time that the wait in step 2 did not use. So
   the two waits together take about one deadline: each wait checks the time
   only every 50 ms, so each can run over its share by up to one check. A
   call that is still running after that keeps its links, as the next section
   describes.
   The order is what makes this race-free: a call raises the count and then
   checks the flag, teardown sets the flag and then reads the count (both
   sequentially consistent), so either the call sees the closed gate and
   refuses, or teardown sees the call.
5. It moves the instance stacks out under `m_stackLock` and ends each one with
   `endInstanceStack()`: the filters from the last to the first, outside the
   lock, because ending a filter calls into Python.
6. It ends every global (`endFilterGlobal()`) and sets the endpoint's open mode
   to `NONE`.

When nothing is in flight at both reads, nothing sleeps and the GIL is not
touched. The waits hold neither `m_stackLock` nor any `m_linkLock`. When the
calling thread holds the GIL, the drain releases it for the wait, so the calls
it waits for can finish.

Each endpoint drains on its own. A task ends its source endpoint and then its
target endpoint, so the end of a task can wait up to twice the deadline.

Every gate is already closed when the filters are ended. A Python filter runs
the node's `endInstance` hook first and then the base
`IServiceFilterInstance::endFilterInstance()`, which resets the links. So an
`endInstance` hook runs with its gate closed: an engine call from it raises
"The pipeline has ended". The hook only releases the node's own resources. When
`endInstance` raises, the base call is skipped; the last rule in
[The call gate](#the-call-gate) says what then happens to the links.

Example, a call that returns in time:

1. A node's helper thread calls `self.instance.invoke(q)`. The gate is open,
   one call is in flight, and `cb_control` calls the target node's `control()`.
2. On the teardown thread, `endEndpoint()` sets `m_ending` and copies the
   filters. `drainInFlightCalls()` finds one call. It releases the GIL if this
   thread holds it, and checks every 50 ms.
3. The target returns. `cb_control` writes the debugger LEAVE and delivers the
   result. No call is in flight now, and `invoke()` returns the result in the
   helper thread.
4. The drain finds no call. Teardown closes every gate and reads the sum
   again: zero.
5. Teardown moves the stacks out and ends each filter, last first: the node's
   `endInstance` runs with its gate closed, then the links are reset under
   `m_linkLock`.
6. Teardown ends every global with `endFilterGlobal()`.

### At the deadline

When calls are still in flight after step 4, the drain logs one warning: one
of the two "Drain deadline" lines in
[Constants and log lines](#constants-and-log-lines). It is the "cancelled" line
when `async::cancelled()` is true, and the other line otherwise. In those
lines:

- `<count>` counts every Python call in flight, not only `invoke`.
- `<deadline>` is the configured `drainDeadline()`, not the time the drain
  waited.
- `<filters>` names each filter that still has calls, as
  `<node>(pipe <id>, <count>)`, each after a space.
- The global cancel flag is set, for example, by SIGTERM, or by Ctrl+Break on
  Windows. The drain then stops at its next check, well before the deadline.

`endInstanceStack()` then calls `retainLinksOnEnd()` on every filter before it
ends it. The filter's end hooks run as usual, but the base
`endFilterInstance()` keeps `endpoint`, `global`, `pipe`, `pDown` and the
buffers. So the objects that a running call holds through these links are not
freed while it runs. The request is used once.

Every link stays, the pipe filter's link to itself included (the filter at
index 0 is its own `pipe`): a late return reaches the debugger through that
link (`Binder::callMethods` → `pipe->debugger.debugLeave`), whether the call
entered through a node's `self.instance` or through a borrowed pipe. The self
link closes a cycle; the deferred release below is what breaks it.

After it has ended every filter of a stack this way, `endInstanceStack()` arms
the stack's head (`armDeferredRelease()`). The links of the whole stack are
then released exactly once, by whoever finds the stack idle first
(`releaseStackIfIdle()`):

- the last Python call to leave the stack: its guard's `leave()` runs the
  release on the calling thread. A guard that was refused leaves the same way,
  so its short count cannot hold the release back; or
- teardown itself, right after arming, if the late call returned meanwhile.

The stack is idle when no call is in flight on any of its filters, read
head-first along `pDown`. The release resets every filter's `endpoint`,
`global`, `pipe` and `pDown` and frees the buffers, so the filters, their
globals and the endpoint are freed then, not at process exit, in the order that
[The call gate](#the-call-gate) gives. A global is freed when the last filter
that links to it lets go of it, which can be before that filter itself is
freed.

The guard lowers its count and then reads the flag; teardown sets the flag and
then reads the counts (both sequentially consistent), so one of them always
sees the other, and the flag's exchange makes the release happen once. The
filter destructor still releases whatever is left, even if an earlier end was
skipped.

Teardown does not wait any longer: every filter's `endInstance` and every
global's `endFilterGlobal()` run while the late call is still running.
Anything those hooks closed on the Python side (a client, a connection) is
closed.

## New pipes during teardown

`IServiceEndpoint::getPipe()` (`store/core/endpoint/endpoint.pipes.cpp`) hands
out an idle pooled pipe, or builds a new one with `buildInstancePipe()`.

From the moment teardown sets `m_ending` (step 1 of the drain), `getPipe()`
refuses with `Ec::PipelineEnded` "The pipeline has ended", for an idle pooled
pipe and for a new one. This holds for C++ callers and for Python code that
calls `getPipe()` on an endpoint. It checks the flag under `m_stackLock`, after
two other checks. When the open mode is `NONE`, which is the case once
`endEndpoint()` has returned, it raises `Ec::InvalidCommand` "The endpoint is
not open during call to getPipe" instead. The pipe gate (`pipeGate`) may refuse
before the flag check, with its own error.

`buildInstancePipe()` does not publish the stack it built in three cases:

1. One filter's `beginFilterInstance()` returns an error. The build closes
   that filter's gate and drops it, so it is not in the stack that is ended
   below. The build returns that error.
2. Teardown has set `m_ending`. The build checks the flag under `m_stackLock`
   just before it would add the stack to `m_instanceStacks`, and returns
   `Ec::PipelineEnded` "The pipeline has ended".
3. `bindFilters()` fails. The build returns the error of `bindFilters()`.

In each case its local function `endUnpublished` ends the filters of that
stack, on the caller's thread and outside `m_stackLock`: it closes their gates,
waits once, up to the full `drainDeadline()`, for the calls on them, and then
calls `endInstanceStack()`. The gates close first and the calls drain, so the
invariant holds for these filters too. A failed `getPipe()` can therefore wait
up to the deadline, but only when a call is in flight on the unpublished stack.

When a call is still in flight there, `endInstanceStack()` arms the head for
the deferred release, which walks the stack along `pDown`. In cases 1 and 2
`pDown` is not set yet, so the deferred release covers the head only, and every
other filter releases its links when it is freed. `bindFilters()` sets `pDown`
on every filter before it binds the lanes, so in case 3 the deferred release
covers the whole stack.

## Late return

A late return is a control call (`invoke`) whose target returns after the gate
of the caller or of the target has closed. `cb_control` checks `hasEnded()` on
both right after `filter->control(control)` returns. In that case it:

- does not touch the debugger or the endpoint, so no LEAVE trace is written:
  the debugger trace shows an ENTER for the call with no matching LEAVE;
- logs one warning line:
  `Warning: invoke returned after the pipeline ended; pipe <id> caller <node> ( <type> ) target <node> ( <type> ) control <class>`;
- delivers the result the target wrote into the control object, so `invoke()`
  in Python returns it. If the target failed, the caller gets the target's
  error. In a chain dispatch where the target declined the call
  (`PreventDefault`), there is no next driver to try, so the caller gets "The
  pipeline has ended".

The caller's next engine call meets a closed gate and raises
"The pipeline has ended".

Example, a call that outlives the deadline:

1. A helper thread of the caller node calls `self.instance.invoke(q)`. The gate
   is open, one call is in flight, and `cb_control` calls the target's
   `control()`, which runs long.
2. Teardown starts: `endEndpoint()` sets `m_ending`, copies the filters, and
   the drain waits for the one call.
3. About half of the deadline passes, and the call is still in flight. Teardown
   closes every gate and waits for the rest of the deadline. The call is still
   in flight then, so teardown logs the "still in flight" warning.
4. Teardown ends every filter with its links retained (each node's
   `endInstance` runs with its gate closed), arms the head of each stack, and
   ends every global with `endFilterGlobal()`.
5. The target's `control()` returns. The caller's gate is closed, so
   `cb_control` writes no debugger LEAVE, does not use the endpoint, and logs
   "invoke returned after the pipeline ended".
6. The guard lowers the count. When no other call runs on the stack, this
   thread releases the links of the whole stack.
7. `invoke()` returns the target's result in the helper thread.
8. The helper's next call, for example `self.instance.writeAnswers(...)`,
   meets the closed gate and raises "The pipeline has ended".

## Late calls inside the chain

A late call can also reach a Python node that has ended, for example a
`writeText` that a slow node passes on without `preventDefault`, or that goes
to the next listener of a lane.

Every handler entry into a Python node (such as a `write*`, `open` or
`control`) gets the node's Python object through one accessor,
`IPythonInstanceBase::boundInstance()`. It tests an explicit flag,
`m_pyEnded`. `IPythonInstanceBase::endFilterInstance()` sets that flag in the
same GIL-held step that releases the node's Python object, after `endInstance`
returns, and also when `endInstance` raises. While `endInstance` runs, entries
still enter the node. Once the flag is set, `boundInstance()` throws
`Ec::PipelineEnded` "The pipeline has ended" instead of entering Python. The
error travels back up the chain to the Python call that started it and is
raised there, the same way a gate refusal is.

## An object left open

`open` keeps a reference to the Python entry on the filter it was called on
(`pyCurrentEntry`), so Python does not free the entry while the object is
open. The node's `close` drops that reference under the GIL, and the next
`open` on the same filter replaces it. The filter can still hold the reference
when it is freed: a `close` after the end is refused, like every engine
callback (see [The handle](#the-handle)); a node can end without closing; an
`open` that failed keeps the reference; and `putPipe()` closes an object that
is still open on the pipe without dropping the reference.

The filter's destructor drops the reference then, under the GIL. The filter
may hold the last reference, and then the entry is freed right there, on the
thread that frees the filter. That thread may or may not hold the GIL: the
thread of the last Python call to leave the stack holds it
([At the deadline](#at-the-deadline)); the thread that ends the endpoint, a
`getPipe()` whose new stack is not published
([New pipes during teardown](#new-pipes-during-teardown)), and C++ code that
lets go of a pipe may not.

## Constants and log lines

| Name | Value | Where | Notes |
| --- | --- | --- | --- |
| `IServiceEndpoint::drainDeadline()` | 10 s | `endpoint.cpp` | The time limit for one endpoint's drain, both waits together, and for the one wait of a pipe build that is not published. Each wait checks the time every 50 ms, so it can end up to one check late. Production code never writes it; tests set it, higher or lower. |
| Wait with the gates open | half of `drainDeadline()`, 5 s by default | `endEndpoint()` | Step 2 of the drain. The wait with the gates closed (step 4) gets the other half plus what this wait did not use. |
| Drain poll interval | 50 ms | `drainInFlightCalls()` | Each round checks `async::cancelled()` and then calls `async::sleep(50ms)`. |
| `async::globalCancelFailsafe()` | 10 s | `engine-core/apLib/async/api.cpp` | The engine's cancel fail-safe. The drain deadline has the same value but is a separate constant: a fail-safe of 0 means "exit at once" and must not turn the drain into a zero wait. |
| `Ec::PipelineEnded` | an `Ec` error code | `engine-core/apLib/error/Ec.h` | The code of every refusal that says "The pipeline has ended". Python reads it as `Ec.PipelineEnded` from `engLib` or `rocketlib`. |
| `PipelineEndedMessage` | `"The pipeline has ended"` | `filter.hpp` | The text of every `Ec::PipelineEnded` refusal. Node code compares `exc.message` with it, so the text is part of the contract. |

All three warnings are logged at level `Always`. The log writer puts a space
between the parts of a line, so search for the fixed parts:

| Event | Text |
| --- | --- |
| Late return | `Warning: invoke returned after the pipeline ended; pipe <id> caller <node> ( <type> ) target <node> ( <type> ) control <class>` |
| Drain deadline | `Warning: teardown: <count> Python call(s) still in flight after <deadline> ; ending the filters without releasing their links: <filters>` |
| Drain deadline, cancelled | `Warning: teardown: <count> Python call(s) still in flight (cancel requested, the drain was cut short); ending the filters without releasing their links: <filters>` |

## What Python sees

The `engLib` error translator in `store/python/bindings.cpp` turns every C++
`Error` into the builtin Python `Exception`. For this error:

| Field | Value |
| --- | --- |
| Type | `Exception` |
| `str(exc)` | `PipelineEnded: The pipeline has ended at (<file>:<line>)` |
| `exc.code` | An `int`: the value of `Ec.PipelineEnded` |
| `exc.message` | `'The pipeline has ended'` |

`<file>:<line>` is the place in the engine that refused the call (for example
the call gate, the handle, `cb_control`, `boundInstance()` or `getPipe()`), so
it differs from one refusal to the next.

Node code tells the refusal by `exc.code` and `exc.message` together. The rule
and the helper `pipeline_ended()` are in
[Threads and the end of a pipeline](../nodes/index.md#threads-and-the-end-of-a-pipeline).
Both fields are needed: the translator puts only the number of the code into
`exc.code`, so an operating-system error that the engine passes to Python can
carry the same number. The text in `exc.message` is the same in every refusal.

The code is not `Ec.Cancelled`: a pipeline that ended normally was not
cancelled, and a stopped task already reports `Cancelled` for the stop itself.

## Known limits

- The engine never stops a running call. A call that outlives the drain
  returns late, after the end hooks of the filters and globals have run.
- A node thread that never returns keeps the task process alive at exit,
  because Python's interpreter shutdown waits for every non-daemon thread. The
  drain does not change this.
- A call that returns while teardown still waits in step 4 of the drain (it
  starts at about half of the deadline or sooner, 5 s by default) is logged as a
  late return, because its gate is closed: it writes no debugger LEAVE and
  logs the warning, although its links are still valid and teardown waits for
  it. In a chain dispatch where its target declined the call
  (`PreventDefault`), it raises "The pipeline has ended" instead of trying the
  next driver.
- The drain counts calls into the engine. A node that calls another node's
  Python object directly (through `pyInstance`) is not counted until that node
  calls the engine.

## Rules for node code

The rules for node code are in
[Threads and the end of a pipeline](../nodes/index.md#threads-and-the-end-of-a-pipeline).

## Where it lives

| Piece | Files under `packages/server/engine-lib/` |
| --- | --- |
| Call gate, `hasEnded()`, `closeGate()`, `callsInFlight()`, `retainLinksOnEnd()`, `armDeferredRelease()`, `releaseStackIfIdle()`, `stackFilter()`, `PipelineEndedMessage` | `engLib/store/headers/filter.hpp`, `engLib/store/core/filter/filter.cpp` |
| Callbacks, late return (`cb_control`) | `engLib/store/core/filter/filter.callbacks.target.cpp`, `engLib/store/core/filter/filter.callbacks.source.cpp` |
| Drain, `m_ending`, `drainDeadline()`, `endEndpoint()`, `endInstanceStack()` | `engLib/store/headers/endpoint.hpp`, `engLib/store/core/endpoint/endpoint.cpp` |
| `getPipe()`, `buildInstancePipe()`, `bindFilters()` | `engLib/store/core/endpoint/endpoint.pipes.cpp` |
| Handles, `forwardTo()` | `engLib/store/python/filter-handle.hpp`, `engLib/store/python/filter-handle.cpp` |
| Python classes of the handles and their alias names, the three properties and `putPipe` with their own guard, the error translator, the Python enum `Ec` | `engLib/store/python/bindings.cpp` |
| `boundInstance()`, `m_pyEnded`, binding the handle | `engLib/store/python/python-base.hpp`, `python-instance.cpp` (the entries are in `python-instance.*.cpp`) |
| A Python endpoint's `endEndpoint` hook, then the drain | `engLib/store/python/python-endpoint.cpp` |
| The bottom filter's `endFilterInstance()`, which calls its parent (the rule in [The call gate](#the-call-gate)) | `engLib/store/filters/bottom/bottom.hpp` |
| `invoke` and `sendSSE` on the node handle | `rocketlib-python/lib/rocketlib/filters.py` (`_patch_classes()`) |
| The entry of an open object (`pyCurrentEntry`): kept by `cb_open`, dropped by `cb_close` and by the filter's destructor | `engLib/store/headers/filter.hpp`, `engLib/store/core/filter/filter.callbacks.target.cpp`, `engLib/store/core/filter/filter.cpp` |
| Tests | `test/store/tests/invoke_teardown.cpp` (`store::invokeTeardown`, `store::invokeTeardownDataChain`, `store::invokeTeardownPython`, `store::invokeTeardownOpenEntry`, `store::invokeTeardownOpenEntryLateCall`); their fixture and fake filters are in `test/store/tests/invoke_teardown_fixture.hpp` |

The error code `Ec::PipelineEnded` itself is in
`packages/server/engine-core/apLib/error/Ec.h`.
