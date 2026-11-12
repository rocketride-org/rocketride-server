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
2. Implement the loader contract. The node package is **file-per-class**: the
   engine takes the dotted package name from the service definition's `"path"`
   (`nodes.my_node`) and imports each class from its own submodule, by file
   name. It never reads a class off the package itself, so `__init__.py` carries
   only the license header — no re-exports, no factories.

   - **`<path>.IInstance` is required.** `IPythonInstanceBase` imports
     `nodes.my_node.IInstance` and reads the `IInstance` class from it; a package
     without `IInstance.py` fails to load
     (`packages/server/engine-lib/engLib/store/python/python-instance.cpp`).
   - **`<path>.IGlobal` is optional.** When the pipeline runs, `IPythonGlobalBase`
     imports `nodes.my_node.IGlobal` if the file exists; an `IGlobal.py` that
     does not define `IGlobal` is an error. Without the file the engine uses
     `rocketlib.IGlobalBase`, which still resolves the node's configuration, so
     `self.settings` works in a node that ships only `IInstance.py`
     (`python-global.cpp`). The engine instantiates the global once per
     pipeline, injects `IEndpoint` and `glb`, and calls `beginGlobal()` /
     `endGlobal()` around the run. After a successful task initialization,
     teardown runs even when execution fails or is cancelled; an execution
     error takes precedence over a teardown error. Long-running Python sources
     must return from `scanObjects` on cancellation: poll
     `rocketlib.isCancelled()` between bounded waits when no scan callbacks are
     being emitted. It reports the native engine's global or calling-thread
     cancellation flag. Chat, Webhook, Dropper, and Tools do this automatically.
     Cleanup is bounded by the supervisor's graceful-stop deadline, so external
     resources should still have vendor-side timeouts for crashes or forced
     kills.
   - **`<path>.IValidator` is optional and used only to validate.** When the
     editor validates a configuration (CONFIG / PIPELINE_CONFIG mode) the engine
     imports `nodes.my_node.IValidator` and nothing else from the package —
     `IGlobal.py` and `IInstance.py` are never imported there, so they may import
     heavy libraries at module top. Without the file the engine uses
     `rocketlib.IValidatorBase`, which checks the stored configuration against
     the schema. Add `IValidator.py` only for semantic checks the schema cannot
     express (a connectivity probe, a JSON block parsed from text); keep it
     import-light (`rocketlib`, the standard library, light clients).
   - **`<path>.IEndpoint` is required for a node that registers as an
     endpoint** (a source); `IPythonEndpointBase` imports it the same way
     (`python-endpoint.cpp`). Filters do not need one.

   There is no `process()` entry point and no node class beyond these.

   ```text
   nodes/src/nodes/my_node/
   ├── __init__.py        # license header only
   ├── IGlobal.py         # optional: per-control caches (clients, models), never state
   ├── IInstance.py       # required: per-object state
   ├── IValidator.py      # optional: semantic config checks, import-light
   ├── services.json      # "path": "nodes.my_node"
   ├── my_node.svg
   └── requirements.txt
   ```

   ```python
   # nodes/src/nodes/my_node/IGlobal.py
   from rocketlib import IGlobalBase


   class IGlobal(IGlobalBase):
       """Per-control caches, built once from self.config; never state."""

       def beginGlobal(self) -> None:
           # Only called when the pipeline runs; validation imports IValidator
           # instead, so installing dependencies here is safe.
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

   **What a node reads, and where it keeps what must survive a call.** The
   IGlobal holds caches, never state: the balancer sends one pipeline's calls to
   different replicas and an idle IGlobal is swept, so anything whose loss
   changes an answer (a rolling window, a session, a counter) never lives on it,
   at module scope, or on the instance (which lives one call). The doors:

   - `self.config` (IGlobal): the configuration, the same for every call;
     reading a `param`-flagged key here raises.
   - `self.settings` (IInstance): this call's configuration, the configuration
     plus the call's parameters; a selector among them re-resolves which branch
     applies.
   - `self.caller` (IInstance): who the call is for, read-only and bound once
     by the engine. Use it for the node's own decisions and logs, never as a
     key for anything the node keeps.
   - `self.state` (IInstance): small JSON values that survive a call —
     `get`, `put(key, value, ttl=)`, `delete`, `incr`, and
     `with self.state.lock(key):` around a read-modify-write (a write to the
     locked key after the lock's lease lapsed is refused, never laid over the
     next holder's). The node names only its own key; the server prefixes it
     with the calling owner, so one owner never reads another's values. Three
     rules bound it:
     - **Keys are per node.** The server also puts the node's id in the key,
       so two nodes of one pipeline that both use `series:cpu` each have their
       own value. The id keeps keys apart; it is not an access boundary:
       the nodes of one pipeline run for one owner, and the server checks
       the owner, not which node sent a request.
     - **Every value expires, within 7 days.** A `put` or `incr` without a
       `ttl` takes the pipeline's idle timeout, 7 days at most, and 7 days when
       the pipeline has none; a `ttl` above 7 days is refused. Each write
       restarts the expiry, so a value still in use is kept alive by writing
       it. Never treat state as permanent storage: what must outlive a week of
       silence belongs in `self.files`.
     - **16 keys per node.** A node holds at most 16 live keys per calling
       owner and pipeline. A write that would create a 17th is refused with an
       error naming the limit; nothing is evicted. Writing a key the node
       already holds always succeeds, and a deleted or expired key frees its
       slot. A node with many small items (one per series, per session) keeps
       them inside a few values or deletes what it no longer needs.
   - `self.files` (IInstance; `IEndpoint.files` for a source's own scan): the
     file store rooted at the calling owner's tree — `read` (100 MB at most
     unless the node names `max_size`), `write`,
     `open_write`/`write_chunk`/`close_write`, `list_dir`, `stat`, `mkdir`,
     `rename`, `delete`, `put_json`/`get_json`, `get_url` (a short expiry by
     default). Plain relative paths only.

   **Where a node's messages go.** An engine can serve many callers, so a
   node's output takes one of two paths, and they reach different people:

   - *Engine output*: bare `print`, and `rocketlib.debug` / `warning` /
     `error`, go to the engine log, which names no request. On a private
     engine (your own run) the engine's own controls receive it. On an
     engine shared across users it is platform signal: it reaches only the
     operators' `OPS` stream (`apaevt_ops`, `sys.admin`), never a caller and
     never the pipe's publisher. Bare print is ops.
   - *Per-request output*: `self.instance.sendSSE(type, **data)` emits an
     `apaevt_sse` event tagged with this binding's `pipeId` and `traceId`, so
     the server delivers it to the control that made the request (its
     monitors and its run log) and to no other holder of the engine. Anything
     the caller should see goes this way; so do the `>DBG` flow traces and
     the data-op results the engine emits for the binding.
   - *From a worker thread or asyncio task*: take `logger = self.logger()`
     inside the call and use `logger.sendSSE(...)` from the worker.
     `self.instance` follows whichever binding is current on the pipe, so a
     thread that outlives the call would tag the next caller's request; the
     logger keeps the ids it captured. Keeping the ids does not keep the
     request alive: send before the request's pipe is returned. For
     `CONST_BINDING_GRACE_SECONDS` (5 seconds) after that, an event still
     reaches the caller, marked `late: true`; after the grace window the tree
     has no owner and the event goes the way of engine output: to the
     engine's own controls on a private engine, and to the operators' `OPS`
     stream, never the caller, on an engine shared across users. Its
     `debug` / `warning` / `error` are the engine log, exactly like the
     module-level functions.

   Debug a node in your own run, where the engine is private and its engine
   output reaches you.

   The node test framework's two-replica harness (`nodes/test/framework/replicas.py`)
   runs a node's calls alternately on two independent replicas sharing only the
   server's state and files, and checks the answers match a single replica's.

3. Add a `services.json` (or `services.<variant>.json`) node definition. This is
   where you declare `classType`, `capabilities`, the `lanes` block (which makes
   the node wire-compatible with others), and the `propertyDefinitions` /
   `properties` config schema the canvas renders and the engine resolves.
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

## Converting a Custom Node from 1.x

A node written for a 1.x server does not load on 4.0 until it follows the
contract above. In order:

1. **Definition.** Run `rocketride node convert nodes/<node>/services*.json`
   (no connection needed). It rewrites `preconfig` / `fields` / `shape` into
   `propertyDefinitions` / `properties` and adds the node's `legacy` block,
   from which the server converts pipelines saved against the old definition.
   It prints a warning for everything it cannot carry over.
2. **Layout.** Move each class into its own file (`IGlobal.py`,
   `IInstance.py`, `IEndpoint.py`, `IValidator.py`) and leave `__init__.py`
   with the license header only. The converter does not touch Python files.
3. **Configuration.** Replace `Config.getNodeConfig(...)` and
   `getMultiProviderConfig(...)` (both deleted) with `self.config` in
   `IGlobal` and `self.settings` in `IInstance`. A `param`-flagged key is read
   from `self.settings`; `self.config` refuses it.
4. **Validation.** Delete the `OPEN_MODE.CONFIG` guards and move semantic
   checks into an import-light `IValidator.py`. Heavy imports may move to the
   top of `IGlobal.py` and `IInstance.py`.
5. **Lifetime.** An `IInstance` lives for one request (one binding), not for
   the pipe: `beginInstance` and `endInstance` run per request. Move anything
   that must outlive a request into `self.state` or `self.files`, and keep
   only caches (never caller data) on `IGlobal`.
6. **Output.** Send what the caller should see with `self.instance.sendSSE`,
   or a `self.logger()` taken in the call when a worker thread sends it (see
   "Where a node's messages go" above).

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
├── __init__.py          # package marker only -- no re-exports (see "Adding a New Node")
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
