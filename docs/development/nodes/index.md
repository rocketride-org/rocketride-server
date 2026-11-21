# Pipeline Nodes

A node is the unit you build pipelines from. Each one does a single job (parse a
document, call an LLM, store embeddings, transcribe audio) and you chain them
together through their service definitions.

Every node is declared in one or more `services*.json` files under
`nodes/src/nodes/<node>/`. A single directory may register **several services**
(for example `core`, `webhook`, `remote`, `agent_crewai`, and `store_elasticsearch`
each expose multiple variants), so a node directory and a service are not the same
thing.

> **There is no hand-maintained node catalog here, by design.** Each node's
> co-located `README.md` is the catalog entry, and `./builder nodes:docs-generate`
> regenerates its parameter tables from `services*.json`. `docs:gather` publishes
> those READMEs to the site's Nodes section, grouped by `classType`. A second list
> kept by hand drifts the moment a node is added — the one that used to live here
> did. Browse the nodes at <https://docs.rocketride.org/nodes>, or read
> `nodes/src/nodes/<node>/README.md` directly.
>
> For the file format, see [Node Service Definitions](services-schema.md); for the
> README contract, [Node README Schema](readme-schema.md); for testing,
> [Node Testing](testing.md).

---

## How nodes connect

Nodes connect in **two different ways**, and knowing which is which is the
difference between a pipeline that runs and one that doesn't, whether you wire it
by hand or hand the job to an LLM.

### 1. Data flow: typed lanes

Most nodes exchange data over **lanes**. A lane is a typed port: a node declares
which lane types it **consumes** (inputs) and which it **produces** (outputs) in
its `lanes` block. Two nodes are wire-compatible when an **output lane type of
the upstream node matches an input lane type of the downstream node**.

The complete lane-type ontology and who produces / consumes each type:

| Lane type   | Produced by | Consumed by | Meaning                                            |
| ----------- | :---------: | :---------: | -------------------------------------------------- |
| `questions` |     18      |     51      | A query/prompt envelope flowing toward a model     |
| `answers`   |     53      |     13      | A model/agent response                             |
| `documents` |     36      |     31      | Chunked/embeddable document records                |
| `text`      |     41      |     21      | Plain text                                         |
| `table`     |     18      |      7      | Structured/tabular data                            |
| `image`     |     15      |     22      | Image payloads                                     |
| `audio`     |      6      |      5      | Audio payloads                                     |
| `video`     |      5      |      8      | Video payloads                                     |
| `tags`      |      4      |      4      | Metadata/markers attached to records               |
| `_source`   |      0      |      5      | Entry lane of **source** nodes (external triggers) |

A typical RAG flow chains these types end to end:
`webhook (_source → questions)` → `embedding_openai (questions → questions)` →
`pinecone (questions → documents)` → `prompt (documents → questions)` →
`llm_openai (questions → answers)` → `response (answers → -)`.

#### The media lanes are streamed

`image`, `audio` and `video` do not arrive in one piece. They are delivered as a
`BEGIN` / `WRITE`… / `END` sequence through `writeImage`, `writeAudio` and
`writeVideo`, so a consumer can work with bounded memory no matter how large the
payload is. `BEGIN` carries the stream's **descriptor** — its source backlink,
MIME type and declared byte count — rather than media bytes; the bytes come on
the `WRITE` calls.

One object can produce **several streams on one lane**: a cropper turning an
album page into separate photos, a frame grabber pulling frames from a video.
`IInstanceBase` normalizes that for every node, so as a node author you can rely
on this:

> A media lane handler receives, per stream, exactly one `BEGIN`, zero or more
> `WRITE`s, and at most one `END`. That `END` is either the producer's own, passed
> through exactly as it arrives, or one the base supplies in its place — when the
> next stream begins on the lane, or as the object closes.
>
> The base supplies one only for a stream that received every byte its `BEGIN`
> declared, so the guarantee is this and no more: a stream **displaced by the next
> `BEGIN`, or still open when the object closes**, is either ended or reported as
> lost — never dropped in silence. One case is deliberately left out of that: a
> stream that neither promised bytes nor delivered any goes without an `END` and
> without a word, having lost nothing. A producer's own `END` is never checked
> against the declared size, so if you must know the bytes are whole, check them
> yourself.
>
> A displaced stream that carried no bytes, fell short of what it declared, or
> declared nothing at all **gets no `END`**; you learn of it from the next `BEGIN`
> on that lane, or from `open()`, and must release whatever you were holding there.

So a consumer keeps one buffer (or one write handle) per lane, fills it on
`WRITE`, does its work on `END`, and drops whatever is still pending when a new
`BEGIN` or an `open()` arrives. It never needs to work out which stream is which
— the base delivers the `END` a producer failed to send before the next `BEGIN`
reaches you. A node that holds an operating-system resource, such as an open file
handle or a decoder, should also release it in `closing()`, which is the last call
before the instance goes away.

Producers are the other half of the contract: **declare the stream's byte count
on `BEGIN`**, because that is the only signal telling a complete stream from a
truncated one. Use the helpers in `ai.common.avi.descriptor` —
`image_begin_payload`, `audio_begin_payload`, `video_begin_payload`, or the
`forward_enriched_*` wrappers when you hold the whole payload in memory. A stream
that declares nothing still completes on its own `END`, and several of them in a
row are fine as long as each one ends. What the base cannot rescue is the one whose
`END` never comes: with no byte count to check it against, it stays open until the
next `BEGIN` displaces it, and is then dropped and reported as lost.

### 2. Tool binding: agents and tools

A node whose `classType` includes `tool` **attaches to an agent node's tool
channel** and is invoked on demand by the agent instead of (or as well as) being
pulled along by the data flow. A tool is agent-agnostic: the same `tool_github`
or `tool_tavily` can attach to `agent_deepagent`, `agent_langchain`,
`agent_crewai`, or `agent_rocketride`.

**The two connection kinds are independent axes, not a choice.** A node declares
lanes or not, and includes `tool` in `classType` or not, and all four
combinations are legal:

| | No `tool` in `classType` | `tool` in `classType` |
| --- | --- | --- |
| **No `lanes`** | — | Pure tool: `tool_tavily`, `tool_python`, `tool_http_request` |
| **Has `lanes`** | Ordinary pipeline node: `prompt`, `llm_openai` | Both: `tool_n8n`, `tool_filesystem`, `agent_crewai` |

Roughly two in five of the services carrying `tool` also declare lanes. `tool_n8n`
(`classType: ["data", "tool"]`) consumes and produces six lane types *and* exposes
itself to agents; every `agent_*` node is `["agent", "tool"]` with `questions`
lanes, which is what lets one agent be another agent's tool; `tool_pipe` is
`["tool"]` alone yet still declares a `_source` lane. `scripts/validate-node-readme.py`
mirrors this — it requires a `Lanes` section when `lanes` is present and an
`As a tool` section when `tool` is in `classType`, evaluating the two conditions
separately.

> So: **wire** a node by its lanes, **bind** it by its `classType`. A node that
> declares both wants both, and leaving one side unconnected is what produces a
> pipeline that does not run — not the combination itself.

The vector-store nodes are one example of "both": their lanes and their tool
functions come from the shared store base, so a new store driver gets the whole
tool surface for free. [Vector-store tools](vector-store-tools.md) has the
contract a driver implements and the optional capabilities it can opt into.

---

## Core module

The `core` module (`nodes/src/nodes/core/`) is not a single node, it registers a
family of built-in services through several `services.common.*.json` files:

- **Sources / connectors:** local filesystem, S3, Azure Blob, Google Drive,
  OneDrive, SharePoint, Outlook, Gmail, Confluence, Slack, SMB.
- **Processing:** document parsing, content hashing/fingerprinting, ZIP creation,
  word indexing, and vectorization helpers.

These are configured through pipeline service definitions rather than as
standalone catalog nodes.

---

## Adding a New Node

1. Create a directory in `nodes/src/nodes/<node_name>/`.
2. Implement the loader contract. The engine imports **one module** — the dotted
   name in the service definition's `"path"` (`nodes.my_node`), which resolves to
   the directory's `__init__.py` — and then reads two attributes off it:

   - **`IInstance` is required.** `IPythonInstanceBase` does
     `m_pyModule.attr("IInstance")` with no guard, so a module that does not
     export it fails to load
     (`packages/server/engine-lib/engLib/store/python/python-instance.cpp`).
   - **`IGlobal` is optional.** `IPythonGlobalBase` guards it with
     `py::hasattr(m_pyModule, "IGlobal")`. When present the engine instantiates it
     once per pipeline, injects `IEndpoint` and `glb`, and calls `beginGlobal()` /
     `endGlobal()` around the run (`python-global.cpp`). After a successful
     task initialization, teardown runs even when execution fails or is
     cancelled; an execution error takes precedence over a teardown error.
     Long-running Python sources must return from `scanObjects` on cancellation:
     poll `rocketlib.isCancelled()` between bounded waits when no scan callbacks
     are being emitted. It reports the native engine's global or calling-thread
     cancellation flag. Chat, Webhook, Dropper, and Tools do this automatically.
     Cleanup is bounded by the supervisor's graceful-stop deadline, so external
     resources should still have vendor-side timeouts for crashes or forced kills.

   Because the imported module is the package itself, `__init__.py` **must
   re-export both symbols** — a class sitting in `my_node.py` that `__init__.py`
   does not surface is invisible to the loader. There is no `process()` entry
   point and no node class beyond these two.

   ```text
   nodes/src/nodes/my_node/
   ├── __init__.py        # re-exports IGlobal and IInstance — this is what the engine imports
   ├── IGlobal.py
   ├── IInstance.py
   ├── services.json      # "path": "nodes.my_node"
   ├── my_node.svg
   └── requirements.txt
   ```

   ```python
   # nodes/src/nodes/my_node/__init__.py
   from .IGlobal import IGlobal
   from .IInstance import IInstance

   __all__ = ['IGlobal', 'IInstance']
   ```

   ```python
   # nodes/src/nodes/my_node/IGlobal.py
   from rocketlib import IGlobalBase, OPEN_MODE


   class IGlobal(IGlobalBase):
       """Shared state, one per pipeline run."""

       def beginGlobal(self) -> None:
           # The editor opens nodes in CONFIG mode just to validate settings —
           # never install dependencies or open connections in that mode.
           if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
               return

           from depends import load_depends

           load_depends(__file__)  # installs this node's requirements.txt

       def endGlobal(self) -> None:
           """Release anything beginGlobal acquired."""
   ```

   ```python
   # nodes/src/nodes/my_node/IInstance.py
   from rocketlib import Entry, IInstanceBase

   from .IGlobal import IGlobal


   class IInstance(IInstanceBase):
       """Per-object state. The engine injects IEndpoint, IGlobal, and instance."""

       IGlobal: IGlobal
       buffer: str = ''

       def open(self, obj: Entry) -> None:
           self.buffer = ''

       def writeText(self, text: str) -> None:
           self.buffer += text
           self.preventDefault()  # take the lane over; re-emit at closing

       def closing(self) -> None:
           self.instance.writeText(self.buffer.upper())
   ```

   **Only methods you actually override are bound.** At load time the engine walks
   a fixed list of callbacks and, for each, compares the method on your class with
   the one on `IInstanceBase`; if they are the same object the callback is left
   unbound and the engine never calls it. Inheriting a method therefore costs
   nothing — but a misspelled method name silently does nothing rather than
   erroring. The bindable set is `beginInstance`, `endInstance`, `checkChanged`,
   `control`, `open`, `closing`, `close`, `writeTag`, `writeText`, `writeTable`,
   `writeWords`, `writeJson`, `writeAudio`, `writeVideo`, `writeImage`,
   `writeQuestions`, `writeAnswers`, `writeClassifications`,
   `writeClassificationContext`, `writeDocuments`, `getPermissions`,
   `getPermissionsBulk`, `outputPermissions`, and `getThreadCount`.

   Agent-facing behaviour does not go through that list: decorate `IInstance`
   methods with `@tool_function` (or `@invoke_function` for control-plane ops) and
   `IInstanceBase.invoke()` dispatches to them by name.

3. Add a `services.json` (or `services.<variant>.json`) node definition. This is
   where you declare `classType`, `capabilities`, the `lanes` block (which makes
   the node wire-compatible with others), and the `fields` / `shape` config schema
   the canvas renders.
4. Drop the node icon SVG next to `services.json` and reference it by filename:

   ```json
   {
     "icon": "my_node.svg"
   }
   ```

   The build pipeline auto-discovers every `nodes/src/nodes/<node>/*.svg`, no
   central registry to update. It also inspects each SVG and:

   - If the SVG is **monochrome** (one distinct fill/stroke color), it auto-rewrites
     the color to `currentColor` so the icon inherits the active light/dark theme
     color. Author the SVG in whichever single color you like (commonly `#000`);
     the theme handles re-tinting.
   - If the SVG is **multicolor** (two or more distinct colors, a gradient, or a
     pattern), it passes through unchanged and renders in its authored colors. Use
     this for brand logos.

   No theme flag, no manifest list to maintain.

5. Add `requirements.txt` for dependencies.
6. Optionally add a `test` section to `services.json` for automated testing (see
   [Node Testing](testing.md)).

---

## Threads and the end of a pipeline

Your node may start its own threads: a worker, a timer, a thread pool. The
engine does not know about them. It knows only when your handler
(`writeQuestions`, `open`, `closing`, ...) returns. After that, the pipeline may
end at any time, even while one of your threads is still inside
`self.instance.invoke(...)` or another `self.instance.*` call:

1. Your handler starts a thread and returns.
2. The engine sees that the handler has returned. From now on it may end the
   pipeline.
3. Your thread is still inside `self.instance.invoke(...)`. That call can
   return after the pipeline has ended.

Here "the pipeline has ended" means that the engine has ended the node's
endpoint, at the end of the task. It does not mean the end of one object or
request.

This is what the engine guarantees, and what it asks of you:

- **A call that is already running is not cut off.** The engine waits for it
  (see the 10 seconds below) and keeps the engine objects it uses until it
  returns, and `invoke()` returns the result of the node it called. When an
  `invoke()` returns only after the engine has stopped taking new calls, for
  example because it ran longer than that wait, the engine logs a warning that
  contains `Warning: invoke returned after the pipeline ended;`.
  If you called `invoke()` without a `component_id`, and the node that returned
  that late declined the call (`preventDefault`), `invoke()` raises the error
  of the next point instead of returning a result: after the end, the engine
  asks no other node.
  Each engine call that the running work makes on its way (for example when
  the node you called calls `invoke()` in turn) is a new call: once the
  engine has stopped taking new calls, about 5 seconds after its wait began
  or sooner when no call is running, it raises like any other call after the
  end. So long work that needs more engine calls must not count on them once
  the end has begun.
- **After the end, the next call raises.** Every engine call through
  `self.instance` (`invoke`, `write*`, `send*`, `open`, `close`, ...) raises a
  plain `Exception` whose `code` attribute is the value of `Ec.PipelineEnded`.
  Its `message` attribute is `'The pipeline has ended'`.
  `sendSSE` and the read-only values `self.instance.pipeId` and
  `self.instance.pipeType` keep working until the engine frees the node's
  filter, and then raise the same way.
- **A running call can be refused further down.** When your call reaches a
  Python node that has already ended, and that node handles the lane or the
  `invoke`, the engine does not enter that node. Your call raises the same
  error.
- **`getPipe()` raises once the pipeline starts to end.** From the moment the
  pipeline starts to end, `getPipe()` raises the same error, even when an idle
  pipe exists. Do not call it on an endpoint object that you kept after the
  task has ended (see the rule about not keeping the endpoint object for your
  thread, below). After the end, calls on a pipe
  you borrowed raise the same error too. The one exception is `putPipe()`:
  after the end it does nothing and raises nothing, because no pipe stack is
  left to take the pipe back. So a `putPipe()` in a `finally`
  block keeps the error that you are handling. While the pipeline is alive,
  and while the engine still takes new calls during the end, `putPipe()` gives
  the pipe back as usual.
- **The engine waits up to about 10 seconds per endpoint.** When the pipeline
  ends, the engine waits up to about 10 seconds for calls that are still
  running. The wait has two parts. First the engine still takes new calls, and
  waits until no call is running, for up to about 5 seconds. Then it refuses
  every new call and waits for the calls that are still running, for the rest
  of the 10 seconds. So a new call can be refused from about 5 seconds after
  the engine's wait began, or sooner, as soon as no call is running.
  The same 10 seconds also cover a `getPipe()` that is still building a new
  pipe when the end begins (the `beginInstance` of the nodes in that pipe runs
  then). The engine waits for that build before it calls `IGlobal.endGlobal`,
  and that `getPipe()` raises the "pipeline has ended" error. If the build
  takes longer, your `endGlobal` runs when the build returns, on the thread
  that called `getPipe()`. So do not hold a lock that your `endGlobal` takes
  while you call `getPipe()`.
  A task waits for its source endpoint and then for its target endpoint, so up
  to about 20 seconds in all. The engine does not stop a call that takes
  longer; that call just returns late. If your node has its own `IEndpoint`
  class, its `endEndpoint` runs first, before the engine waits, while your
  calls may still run. After the wait, teardown goes on: your `endInstance`
  and your `IGlobal.endGlobal` can run while a late call is still running.
  Anything these hooks close (a client, a connection) is closed for your
  thread too. Before it ends the nodes, the engine refuses every new call, so
  an engine call from `endInstance` (`self.instance.writeText(...)`,
  `hasListener(...)`, `invoke(...)`, `currentObject`) raises; if
  `endInstance` does not catch it, the task ends with that error. Read-only
  properties such as `pipeType` and `sendSSE` still answer there. Use
  `endInstance` only to release your node's own resources.
- **Keeping `self.instance` does not keep the pipeline alive.** `self.instance`
  is an `engLib.IFilterInstanceHandle`: a handle with a weak link to the
  engine's object. A copy in a global, a closure or a thread raises once the
  pipeline has ended. The same holds for `self.instance.next`,
  `self.instance.pipe`, and a pipe you borrow with `getPipe()` (give it back
  with `putPipe()`). These are `engLib.IServiceFilterPipeHandle` objects. The
  names `engLib.IFilterInstance`, `engLib.IServiceFilterPipe` and
  `engLib.IServiceFilterInstance` are aliases of the handle classes.
- **A thread you start in `beginInstance` makes no engine call before your
  first handler call.** The engine binds `self.instance` just before it calls
  your `beginInstance`. A call before that raises the same error. From a thread
  that you start in `beginInstance`, make no engine call until the engine has
  called one of your handlers (for example `open`): until then the pipe is not
  wired yet.
- **Give your thread plain values, not engine objects.** From a thread of your
  own, make engine calls through `self.instance` and the pipe handles (a pipe
  borrowed with `getPipe()`, and the value of `next` or `pipe`). Use other
  engine objects your node can reach (for example the endpoint object, the
  global object, or an entry handed to your method or read from
  `currentObject`) only inside the call that provided them, on the thread that
  made that call. Do not keep them for a thread of your own, and do not use
  them after the pipeline has ended. Read `self.instance.targetObjectUrl` and
  `self.instance.targetObjectPath` only inside a handler too. Read what you
  need in the handler and give your thread plain values.
- **Make no engine call from your thread after your handler has returned.**
  The engine refuses calls only after the pipeline has ended. One pipe serves
  many objects or requests in turn, so a call that your thread makes after your
  handler returned belongs to whatever the pipe handles at that moment. Finish
  or stop your threads before the handler returns its last result. A thread
  that you cannot stop in time, because it is still inside a call, makes no
  further engine call, as in the example below.
- **A thread that never returns keeps the process alive.** When the task
  process exits, Python waits for every non-daemon thread. Give your thread's
  work a time limit.

The refusal has its own error code, `Ec.PipelineEnded`. To tell that the
pipeline has ended, compare `exc.code` with `Ec.PipelineEnded.value`: `code` is
a plain `int`, and an `Ec` value is never equal to an `int`. `exc.code` holds
the number only, and an operating-system error that the engine passes to Python
carries its own number in the same field. So `pipeline_ended()` below checks
`exc.message` as well. The `message` text is the same in every refusal.

```python
import threading

from ai.common.schema import Question
from rocketlib import Ec, IInstanceBase, warning
from rocketlib.types import IInvokeLLM


def pipeline_ended(exc: Exception) -> bool:
    """Tell whether the engine refused a call because the pipeline has ended.

    Args:
        exc: The exception that an engine call raised.

    Returns:
        True when ``exc`` is the engine's refusal after the end of the pipeline,
        False for any other exception.
    """
    return (
        getattr(exc, 'code', None) == Ec.PipelineEnded.value
        and getattr(exc, 'message', None) == 'The pipeline has ended'
    )


class IInstance(IInstanceBase):
    def writeQuestions(self, question: Question) -> None:
        """Ask the LLM on a thread of this node and write the answer, or go on without it after 30 s.

        Args:
            question: The question to ask the LLM.
        """
        result = {}

        def ask() -> None:
            """Ask the LLM and keep its answer, or the error it raised, in ``result``."""
            try:
                # This call has no time limit of its own. The LLM node must limit
                # its request, or this thread may never end.
                result['answer'] = self.instance.invoke(IInvokeLLM.Ask(question=question))
            except Exception as exc:
                if pipeline_ended(exc):
                    return  # too late: the pipeline has ended, nobody waits for this answer
                result['error'] = exc

        worker = threading.Thread(target=ask)
        worker.start()
        worker.join(timeout=30)

        if worker.is_alive():
            # The call goes on in the thread after this handler returns. The
            # thread makes no further engine call, so a late answer is dropped.
            warning('LLM call took longer than 30 s; going on without it')
            return

        if 'error' in result:
            raise result['error']
        self.instance.writeAnswers(result['answer'])
```

How the engine does this (the handle, the call gate, the teardown wait) is in
[Python call lifetime](../engine/python-call-lifetime.md).

---

## Prototyping a Node

Build the node in `nodes/src/nodes/<node>/` and run the engine from this repo.
Its `services.json` uses `"path": "nodes.<node>"`, the same as every node that
ships with the engine, and its `IGlobal` installs the node's own
`requirements.txt`.

A local node exists only on the engine that loads it. RocketRide Cloud loads
none, so an app published to the store cannot depend on one, and store
reviewers reject a pipeline that references a node outside the catalog (see
[Apps for the Store Use Catalog Nodes Only](../../../CONTRIBUTING.md#apps-for-the-store-use-catalog-nodes-only)).
Keep that step in the app, or contribute the node to the catalog (below).

```text
nodes/src/nodes/my_node/
├── __init__.py          # required -- exports IGlobal/IInstance (see "Adding a New Node")
├── services.json        # "path": "nodes.my_node"
├── IGlobal.py
├── IInstance.py
└── requirements.txt
```

A node developed this way is already in the right place to ship: follow the
[contributing guide](../../../CONTRIBUTING.md) and open a pull request.

Developing a node **outside** this repo is the point of the node rail, and the
local half of it is not built yet. Until it is, a node is developed here.

---

## License

MIT License, see [LICENSE](../../../LICENSE).
