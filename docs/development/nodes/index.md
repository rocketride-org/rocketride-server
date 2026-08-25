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
| `questions` |     17      |     39      | A query/prompt envelope flowing toward a model     |
| `answers`   |     36      |      6      | A model/agent response                             |
| `documents` |     29      |     23      | Chunked/embeddable document records                |
| `text`      |     23      |     15      | Plain text                                         |
| `table`     |     10      |      5      | Structured/tabular data                            |
| `image`     |      6      |     10      | Image payloads                                     |
| `audio`     |      4      |      3      | Audio payloads                                     |
| `video`     |      3      |      6      | Video payloads                                     |
| `tags`      |      3      |      3      | Metadata/markers attached to records               |
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

Nodes whose `classType` is `tool` (and a few infrastructure nodes) **have no data

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

Roughly a third of the services carrying `tool` also declare lanes. `tool_n8n`
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
     `endGlobal()` around the run (`python-global.cpp`).

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

## Prototyping Local Nodes

Develop a node in your own workspace -- next to your `.pipe` -- without changing
the installed engine. Set `--node_path` to the directory that holds your
`local_nodes` folder (the folder name is required):

```sh
engine --node_path=/path/to/dir-containing-local_nodes ...
```

Its nodes are scanned like the built-in ones but imported as `local_nodes.<node>`
(set this in each `services.json` `"path"`), so they never clash with the
built-in `nodes` package.

```text
my-workspace/
└── local_nodes/
    ├── __init__.py          # empty -- just marks local_nodes as a package
    └── my_node/
        ├── __init__.py      # required -- exports IGlobal/IInstance (see "Adding a New Node")
        ├── services.json    # "path": "local_nodes.my_node"
        ├── IGlobal.py
        ├── IInstance.py
        └── requirements.txt
```

Build the node exactly as in [Adding a New Node](#adding-a-new-node) -- its
`IGlobal` installs the node's own `requirements.txt`, so dependencies work the
same as any built-in node.

To ship a node so it becomes part of RocketRide, clone the
[rocketride-server](https://github.com/rocketride-org/rocketride-server) repo,
move your node into `nodes/src/nodes/<node>/`, change its `services.json`
`"path"` to `nodes.<node>`, and open a pull request following the
[contributing guide](../../../CONTRIBUTING.md).

---

## License

MIT License, see [LICENSE](../../../LICENSE).
