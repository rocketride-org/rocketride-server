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

### 2. Tool binding: agents and tools

Nodes whose `classType` is `tool` (and a few infrastructure nodes) **have no data
lanes**. They do not sit in the data flow. Instead they **attach to an agent node's
tool channel** and are invoked on demand by the agent. A tool is agent-agnostic:
the same `tool_github` or `tool_tavily` can attach to `agent_deepagent`,
`agent_langchain`, `agent_crewai`, or `agent_rocketride`.

> Rule of thumb: if a node has lanes, **wire** it into the flow. If it is a `tool`,
> **bind** it to an agent. Mixing these up produces an invalid pipeline.

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
2. Implement the required interfaces:

   ```python
   # nodes/src/nodes/my_node/__init__.py
   from .my_node import MyNode
   from .IInstance import IInstance
   from .IGlobal import IGlobal


   # nodes/src/nodes/my_node/my_node.py
   class MyNode:
       def __init__(self, config):
           self.config = config

       def process(self, input_data):
           # Process data
           output_data = input_data
           return output_data
   ```

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
        ├── __init__.py      # required -- runs depends(requirements.txt) and exports IGlobal/IInstance (see "Adding a New Node")
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
