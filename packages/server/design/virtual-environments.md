# Design: Virtual Environments for RocketRide Pipelines

**Status:** Draft (design round — no implementation yet)
**Scope:** Engine (C++ + embedded Python), `depends.py`, the `remote` sub-pipeline mechanism,
the pipeline canvas (shared-ui / VS Code), and the test/CLI harnesses.
**Audience:** Engine + tooling engineers. This is an *internal* design document, not user-facing
documentation — it deliberately lives in `packages/server/design/`, **not** `packages/server/docs/`
(which `docs:gather` publishes to the public site under *Protocols › WebSocket*).

---

## 1. Problem

When a pipeline runs, **all** of its nodes execute inside **one** `engine.exe` process (an embedded
CPython interpreter). Every node module is imported into that single interpreter, sharing **one**
`lib/site-packages` pinned by **one** `cache/constraints.txt`.

That constraints file is built by globbing **all** node and `ai/` requirements
(`REQUIREMENTS_GLOBS = ['requirement*.txt', 'nodes/**/requirement*.txt', 'ai/**/requirement*.txt']`,
`depends.py:58`), concatenating them (`_combine_requirements`), and running **`uv pip compile` over
the union** (`ensure_constraints`). So if two nodes need incompatible versions (e.g. `torch==2.0` vs
`torch==2.1`), the unified compile **fails at engine startup** (`_compile_constraints` →
*"Failed to compile constraints"*), before any pipeline runs.

**Corollary:** today *all shipped nodes must be mutually dependency-compatible*, and a pipeline that
uses nothing audio-related still drags in `whisper`; nothing NER-related still drags in `gliner`.

**Goal:** let a user partition a pipeline into named **virtual environments** — groups of nodes that
run in their own OS process with their own isolated `site-packages` — so conflicting dependencies no
longer collide. Nodes in different environments exchange lane data over secured local IPC.

### Goals
- Allow nodes with mutually-incompatible Python dependencies to coexist in one pipeline.
- Scope dependency installation to **only the nodes a pipeline actually uses** (per environment) —
  faster, smaller, and conflict-surfacing at *compile* time rather than at *runtime*.
- Reuse existing engine machinery (the `remote` sub-pipeline, `depends.py`, the canvas group node)
  rather than inventing parallel stacks; **no/minimal C++ engine changes**.

### Non-goals
- **Not a security sandbox.** Virtual environments isolate *dependencies*, not untrusted code — a
  node in a venv can still touch the filesystem and network. This is not tenant isolation.
- Not a general distributed-execution feature. Inter-venv transport is local (loopback) in v1.

---

## 2. Background (verified)

### 2.1 Canvas groups are inert in the engine
The canvas (`packages/shared-ui/src/components/canvas`, ReactFlow/xyflow) already has a **group node**
(`INodeType.Group`). Nodes dropped into a group get `parentId`; on save,
`graph.ts:getProjectComponents()` **nests the group's children into `config.pipeline.components`**.

But a group has **no engine-side meaning today**: there is no `group` provider, nothing flattens or
recurses into `config.pipeline.components`, and `stack.cpp` (`generatePipelineStack`/`buildConnections`)
iterates only top-level `components[]`. So a group is purely a UI container; the nested blob in the
saved document is inert. **The new partitioner is where group structure gets runtime meaning.**

### 2.2 The `remote` sub-pipeline mechanism (the reuse foundation)
The repo has a **live** remote-sub-pipeline feature under `nodes/src/nodes/remote/`:
`remote` / `remote_server` nodes + `prepare_pipeline.py` + a WebSocket lane bridge + HTTP endpoints in
`packages/ai/src/ai/modules/remote/`. It already:

- takes a nested `config.pipeline` (the **same shape** as canvas groups);
- **rewrites the graph** two ways — `prepareLocalPipeline` *inlines* a sub-pipeline (= "flatten");
  `prepareRemotePipeline` *inserts bridge/stub nodes + reroutes lanes* (= cut a boundary);
- bridges lane data over a **token-authed WebSocket** (Bearer token, `~1 MB` chunking);
- gates members by a **`REMOTING`** capability (on by default; cleared by `noremote`, `services.cpp:1737`).

Two facts that shape the design (both **verified** against the code):

- **Lane coverage is 3, not 5.** Server-side `callLocal` (`remote/base/IInstance.py`) handles only
  `writeTag`/`writeText`/`writeDocuments` (+ `open`/`closing`/`close`) → **text/tags/documents**;
  everything else `raise TypeError`. `image`/`video`/`audio`/questions/answers/classifications are
  missing. (The client also *sends* `words` but the server has **no `writeWords` handler** — a latent
  network-remote bug to fix separately.)
- **The transport is not cleanly separable.** WebSocket `_send`/`_recv`/`connect`/`disconnect` are
  embedded **directly** in `remote/base/IInstance.py`, not behind a transport seam.
- `remote_source_stub` is **not** a real node — it is *synthesized at runtime* by `prepare_pipeline.py`.
- `REMOTING`/`noremote` is a **network**-remoting gate; the `noremote` set is local-resource nodes
  (local filesystem `core` source, DB nodes, `text_output`). Venvs are *same-host*, so this gate may
  be too restrictive — see §7.

### 2.3 Embedded Python & dependency machinery
- `init.cpp` initializes CPython with an **isolated `PyConfig`** (`Py_InitializeFromConfig`), home set
  to the executable dir. **`PYTHONPATH` is ignored** — `sys.path` is mutated at runtime instead
  (`init.cpp:setPaths`, and `depends.py:_ensure_site_packages` does `sys.path.append(...)`).
- Linux/macOS statically link CPython into `engine.exe`; Windows ships `python3XX.dll` + the MSVC
  `vcruntime` next to it, loaded at C++ init **before** `sys.path` is touched.
- `depends.py` resolves all paths relative to `dirname(sys.executable)`: `engine_cache_dir()` =
  `<exe>/cache`, `model_cache_dir(name)` = `<exe>/cache/models/<name>`, base site-packages =
  `<exe>/lib/site-packages`. It already has a `FileLock`/`install.lock` + progress sidecar for
  concurrent installs.
- The dev-mode debug shim copies `engine.exe → python.exe` **in the same directory** (so
  `dirname(sys.executable)` is unchanged). `engtest` (the engine-lib Catch2 binary) asserts
  `sys.prefix == sys.executable dir == rootDir` — an invariant this design preserves.

### 2.4 `project_id` and multi-source pipelines
- A pipeline's stable id lives at **`config.pipeline.project_id`** (a GUID; the top-level
  `project_id` is null). `task_server.py` reuses it and only generates one if absent; it survives
  edit/save/rename. Unsaved ad-hoc editor runs may get a fresh UUID each run.
- A pipeline may have **multiple source nodes** (e.g. `dropper_1`, `dropper_2`) = multiple execution
  lanes. The engine runs **one source per task** (separate `task-*.json` + `taskId` per source), but
  **every per-source task file carries the FULL `components[]` and the same `project_id`** (verified
  on `examples/task-0d4f3caa.dropper_1…json` / `task-575adb74.dropper_2…json`).

---

## 3. Design overview

**A virtual environment = a "local remote".** Each isolated group becomes a flat sub-pipeline run by
a child `engine.exe` process (TARGET mode, as the engine runs any pipeline today), with its own
isolated `site-packages` overlay. Boundary edges are bridged over a token-authed WebSocket on
loopback; the main process's orchestrator routes inter-venv frames. The C++ engine is unchanged.

Three pillars:

1. **Per-environment requirement scoping** (the actual conflict fix). Stop globbing all node/`ai`
   requirements into one resolution; instead each environment compiles + installs **only the nodes it
   uses**, into its own overlay. This even helps no-venv pipelines (scoped installs). *Foundation —
   shippable on its own.*
2. **The venv runtime.** A new first-class canvas **Virtual Environment** container; a Python
   **partitioner** that turns isolated groups into venv sub-pipelines + bridge nodes; a **`venv`
   bridge node** (sharing a base with `remote`) carrying all lanes; **local spawn + hub routing**;
   orchestration (lifecycle, merge-back, observability).
3. **Polish & scale.** Cross-cut debug/observability, pre-warm, and v2 optimizations (direct
   venv↔venv mesh, shared-memory for large buffers, the local-IPC transport seam).

---

## 4. Detailed design

### 4.1 The Virtual Environment container (UI)
The **only new visible/placeable** canvas element is a first-class **Virtual Environment** container
(its own palette/creation entry). It reuses group *mechanics* (`parentId` nesting, children →
`config.pipeline.components`, `onNodeDragStop` drop-into) but is distinct from a plain organizational
group: it carries `config.environment = { name, isolated: true }` and an "isolated" visual treatment
(badge/border). A **cog** exposes a **Purge environment** action (§4.10).

The **bridge/`remote`/`venv` nodes stay internal** — synthesized/inserted by the partitioner, **never
in the node palette**, never user-placed. (Like the `remote` nodes today, which are not canvas-exposed.)

VS Code host wiring (`apps/vscode/.../ProjectWebview.tsx`) follows the extension rules
(`Callout.call`, `AppError`, `logger.*`). The schema field is added to
`packages/client-typescript/src/client/types/pipeline.ts`.

### 4.2 Pipeline document format — two formats

**Authoring format** (what the canvas saves into `.pipe`): a venv is the existing group node with the
**only additive change** `config.environment = { name, isolated: true }`. Member nodes keep their
`input`/`control`; a member's `input.from` may reference a node *outside* the group (lane edges cross
groups today) — those are the boundary edges.

**Runtime format** (what each `engine.exe` receives): the engine reads only **top-level**
`components[]` and ignores `config.pipeline`. The **partitioner** (Python, pre-launch, modeled on
`prepare_pipeline.py`) expands the authoring doc into N **flat** sub-documents — `main` + one per venv
— inserting bridge nodes at each boundary edge and rewriting the downstream `input.from`.

```jsonc
// authoring: a "vision" venv with one member (detect), fed by parse(main), feeding response(main)
{ "id": "venv_vision", "config": {
    "environment": { "name": "vision", "isolated": true },
    "pipeline": { "components": [
      { "id": "detect_1", "provider": "detect", "ui": { "parentId": "venv_vision" },
        "input": [ { "lane": "image", "from": "parse_1" } ] }   // crosses INTO the venv
    ] } },
  "ui": { "nodeType": "group" } }
```

### 4.3 Partitioner
A Python transform pass in the task-start path (`task_engine.py`, after `_check_pipeline`, before
`_build_task`), run **automatically whenever any group is `isolated`** (no isolated groups → no-op).
Modeled on / generalizing `prepare_pipeline.py`:

- **Non-isolated** groups → **flattened** (children lifted to top level, like `prepareLocalPipeline`).
- **Isolated** groups → a separate flat sub-pipeline per venv; each boundary **data-lane** edge gets a
  bridge-node pair + a `channelId` recorded in a routing table.
- Builds the **env-quotient graph** to detect cross-env cycles.
- Reads the **full `components[]`**, not the executing source's reachable subgraph (see §4.13).

Covered cases: lane fan-out across envs, multiple lanes per env-pair, A→B→main chains, source/sink
placement (§4.11). **Invoke/control edges never cross a boundary** (the editor's `isValidConnection`
requires equal `parentId` for invoke handles; data lanes cross freely) — so cross-env tool-call RPC is
out of v1 *by construction*. **This is editor-only — C++ does not check `parentId` on invoke edges
(verified)** — so **the partitioner must enforce it as a hard validation** (reject cross-boundary
invoke/control edges), not assume the document is well-formed.

### 4.4 Bridge nodes — shared base + a new `venv` node
The transport is *not* cleanly separable (§2.2), so rather than editing `remote` in place or rebuilding
a parallel stack:

- **Extract the common bridge base** (lane dispatch/serialization in `callLocal` + the transform) into
  shared code.
- Add a **new `venv` / `venv_server`** node pair inheriting it, alongside `remote` / `remote_server`.
- The `venv` node implements **all data lanes** — the 15 `Binder::MethodNames` minus the
  `open`/`closing`/`close` framing: `tags, text, table, words, audio, video, questions, answers,
  image, classifications, classificationContext, documents` (today's `callLocal` covers only 3 data
  lanes — text/tags/documents), critically `image`/`video`/`audio` (vision is image-heavy). Derive lane
  handlers from **one table** so a new engine lane forces a wire-format bump, never a silent gap. Reuse
  the serialization vocabulary in `data_conn.py` (`_determine_lane`, `_begin`/`_write`/`_end`).

This **reuses the fiddly logic** (shared base) while **decoupling** venv work from the live `remote`
feature — no regression risk to network-remote, and its `words` gap stays its own problem. It is *not*
the rejected `venvEgress`/`venvIngress` reinvention; it is a sibling of `remote` over one base.

### 4.5 IPC transport & security
**v1 reuses the existing WebSocket lane bridge bound to loopback, unchanged** — it already carries a
Bearer token. Bind to `127.0.0.1`; reject unauthenticated connections; deliver the token via inherited
env/handle, never argv.

- **Known limit (v1 acceptance gate, not a v2 "confirm"):** WS frames chunk at `~1 MB`
  (`remote/base/IInstance.py`); large image/video relies on chunking. **Measure a representative
  image/video crossing against a target throughput ceiling as a v1 acceptance criterion**; raise the
  chunk ceiling for AV if it misses.
- **Cloud-store direction shrinks the *payload*, not the *lane set*.** In the planned model AV bytes
  live in **cloud storage** (`ai..account.store`); the bulk bytes are fetched from the store, not
  streamed node-to-node. **But AV metadata still travels on the `writeVideo`/`writeAudio`/`writeImage`
  lanes** — so the bridge must **still implement every AV lane** (§4.4 "all data lanes" is *not*
  reducible), and those lanes still cross the venv boundary. What changes is the **payload size**: a
  small metadata/URL frame instead of multi-MB buffers, which is what drops the throughput risk (the
  ~1 MB chunking is a non-issue for small frames). The interim caveat still holds — before the store
  migration, raw AV crosses these lanes and the throughput gate above applies. (The child's store fetch
  needs account/store context — ties into secrets/`ROCKETRIDE_CLIENT_ID` propagation, §6.)
- **Hardening (deferred to 2C):** OS-access-controlled local IPC so the kernel rejects other-user
  processes *before* any token check — **named pipe + user-SID ACL** (Windows), **Unix domain socket**
  `0700` + `SO_PEERCRED`/`LOCAL_PEERCRED` (Linux/macOS). Matters for **multi-tenant** hosts (Linux
  cloud especially); single-tenant is fine on loopback + token (same-user child). This is **not
  Windows-specific** — but it requires the same `IInstance.py` transport refactor that makes the
  transport not-separable, so it is deferred, not a v1 item.

### 4.6 Inter-venv routing — hub via main
All venv children connect **only to main**. Main's **orchestrator** (the Python process that spawned
them, *not* main's node pipeline) owns a socket per child and acts as a **byte router** at the
transport layer: it reads a frame off one child's socket and forwards it to another's via the routing
table.

```
dropper(main) → parse(venv1) → detect(venv2) → return_image(main)
connections: main↔venv1, main↔venv2   (no venv1↔venv2 link)
parse(venv1) ──▶ main ──(route by channelId)──▶ detect(venv2)
```

**The data never enters main's engine/node graph nor main's `site-packages`** — main forwards **opaque
frames**, so it needs **no codecs/deps** for the data crossing it (a venv-`torch` image passes through
main without main having `torch`). Routing through main's *nodes* would force main's env to understand
every crossing lane — explicitly avoided.

Rationale for hub over mesh: N connections (not N²), central lifecycle/token/routing/observability, each
child authenticates with **only main**. Cost: a venv→venv edge is 2 transfers. **v2 optimization:**
direct venv↔venv peering for hot large-buffer edges (+ shared-memory for AV).

### 4.7 Per-environment requirement scoping (the conflict fix)
Today `_find_requirement_files()` globs **all** `nodes/**` + `ai/**` requirements (pipeline-blind);
the unified `uv pip compile` fails the moment two nodes conflict. Instead:

**Uniform per-environment scoping (main included; one code path).** Each environment compiles +
installs **only the nodes it uses**, into its own node-set-keyed overlay. The partitioner already knows
each env's node set, so:

- map the env's components → `provider` → `nodes/src/nodes/<provider>/requirements*.txt`;
- **AST-discover** the `ai/**` submodules each node imports (§4.8) → include only those
  `requirements*.txt`;
- `ensure_constraints()` takes an **explicit requirement-file set + env dir** (not the global glob).

**Node set = the WHOLE document (all sources/lanes), not the executing source's subgraph** — because
the on-disk env is keyed by `project_id` and shared across all per-source runs. Compiling per-lane would
each succeed but **conflict at runtime** (dropper_1 lane `torch 2.0` + dropper_2 lane `torch 2.1`);
full-set compilation surfaces it at **compile time**, and both lanes reuse the **same** venv.

**Consequence / blast radius (must gate).** The base `lib/site-packages` becomes **engine-runtime-only**;
**all** node deps move into per-environment overlays — even main's, **even for pipelines with no venvs**.
When enabled, this changes dependency resolution for the *whole* pipeline (main included), so it is
gated by the **`ROCKETRIDE_SERVER_USE_VENV` master switch (§4.15)** with a **permanent** fallback to
today's global-glob path (`=0`). The default (auto) only scopes per-env when the pipeline opts in via an
isolated group — a no-venv pipeline under the default keeps today's global-glob behavior unchanged; the
legacy path is a supported mode, not a transitional flag.

**Upside:** eliminates "all shipped nodes must be compatible" entirely (conflicts only *within* an env →
resolved by the venv split); shrinks the overlay-can't-hide-a-base-package limit to only packages the
**engine runtime itself** needs.

### 4.8 AST discovery of `ai/**` requirements
Run **once per pipeline init**, cached by node-set hash.

**Input contract.** The partitioner (the only component that reads the `.pipe`) resolves each env's
components → `provider` → the node's **entry-module path** (resolution rule below) and hands
`depends.py` an explicit **per-env node-set descriptor**: a list of
`(provider, entry_module_path)` + the node-set hash + the env dir. **`depends.py` never parses the
`.pipe`** — a single AST-discovery entry point there walks each entry-module path, follows imports
into `ai.*` to find the `ai/common/models/<x>` submodules reached, and returns those submodules'
`requirements*.txt` to fold into the env's requirement-file set. So a pipeline with no audio never
pulls in `whisper`. This reconciles §4.7 (partitioner resolves the node set) with §9 (the AST walk
lives in `depends.py`): **the partitioner passes paths; `depends.py` parses them.**

**Resolution rule (verified — NOT `nodes.<provider>`).** The entry module is **not**
`nodes/src/nodes/<provider>/` by string; that naive rule holds for ~91 of ~133 providers and **breaks
for ~42**. The authoritative mapping is: `provider` = the `logicalType` (protocol scheme with `://`
stripped, e.g. `detect://` → `detect`) → its matched `services*.json` → that file's **`path`
(`nodePath`) field** → dots-to-slashes under `nodes/src/` → a **package dir with `__init__.py`** that
re-exports `IInstance`/`IGlobal` (and `IEndpoint` for endpoint nodes); the node logic to AST-parse is
`IInstance.py`/`IGlobal.py` there. Traps the partitioner must handle: **aliases** (many providers →
one dir: `chat`,`dropper` → `webhook`; all `response_*` → `response`), **sub-package paths** (`remote`
→ `nodes/remote/client`, whose own `__init__.py` re-exports nothing — you *must* follow `path`),
**name ≠ dir** (`text-output` → `text_output`, `db_supabase` → `db_postgres`), and **native providers
with no `path`** (`parse`, `filesys`, `hash`, …) which have **no Python module and are skipped**. The
engine loader itself does exactly this (`python-global.cpp` uses `serviceDef.nodePath`, not the
provider string), so the partitioner must read `path` from `services*.json`, never synthesize it.

**Known risk — the AST premise is weaker than it looks (VERIFIED against `detect`, `pose_estimation`,
`audio_transcribe`, `ner`, `anonymize`).** The heavy pip packages are **not** declared per node and are
**not** chosen by per-variant `depends()` calls: no `requirements_pose`/`requirements_detection` files
exist, and `detect`/`pose_estimation` have **no `requirements.txt` and call `depends()` zero times**.
Instead —
- a node's `IGlobal.py` typically **defers** the `ai.common.models.*` import into `beginGlobal`
  (config-gated), and the actual package is a **lazy, config-selected import inside `ai`** — e.g.
  `from rfdetr import RFDETRBase` inside `ai/common/models/vision/detection.py::_build_backend`, picked
  by the `engine` config, **two hops from the node file**;
- config (`profile`/`engine`/`model`) selects a **runtime model backend, never a requirements file**.

Consequences a static node-file AST walk must confront:
- it **systematically under-includes** — the true deps sit behind deferred/config-driven imports inside
  `ai`, invisible to a walk of `IGlobal.py`/`IInstance.py`;
- the `depends()` **backstop does not rescue these nodes** — `detect`/`pose` never call `depends()`, so
  nothing installs mid-run; today their deps come from the **pre-populated shared `ai`/model-server
  environment**.

So per-env `ai/**` inclusion **cannot rely on node-file AST alone.** The walk must be **transitive
through the `ai` package** (follow deferred + config-branch imports inside `ai.common.models.*`, not
just the node's top-level imports); where a config branch selects among mutually-exclusive backends,
**include all reachable backends' `requirements*.txt`** (then verify they don't mutually conflict)
rather than trusting a runtime `depends()` that never fires. Nodes that *do* call `depends()` /
`load_depends()` (e.g. `detect_segment`, some TTS) install a **single fixed** `requirements.txt`, not a
variant — so the backstop is a narrow safety net, not the primary mechanism.

**Prototype result (VERIFIED — throwaway static-AST walk run against `detect`, `audio_transcribe`,
`anonymize`, the three hardest nodes).**
- **Correctness holds — static AST is feasible.** With two walker requirements — (1) collect
  **nested/in-function imports** (not just module-level), (2) resolve **relative imports** correctly
  (`__init__.py` package vs regular-module package) — the walk reached **every** ground-truth
  requirement file (`requirements_detection.txt`+`requirements_vision.txt`+`torch` for `detect`;
  `requirements_whisper.txt`+`torch`; `requirements_gliner.txt`+`torch`) with **zero under-includes and
  zero dynamic `importlib` calls**. The earlier worry that config-selected backends hide from AST was
  **wrong**: `from rfdetr import RFDETRBase` inside `_build_backend` is a *literal nested* import the
  walk sees.
- **The residual problem is PRECISION, not correctness — the `ai.common.models` barrel `__init__`.**
  `detect` imports by **full submodule path** (`from ai.common.models.vision.detection import …`) → the
  walk stays tight (only detection+vision+torch). But `audio_transcribe`/`anonymize` import via the
  **`ai.common.models` package `__init__`, which statically re-exports EVERY submodule** — so the walk
  transitively reaches the **entire model universe** and over-includes `rfdetr`, `rtmlib`, `gliner`, all
  OCR, `transformers` for an *audio* node. That reintroduces the very torch-conflict + bloat venvs exist
  to remove.
- **Prerequisite for precise scoping — DONE (Option A applied).** Either nodes import `ai` model
  submodules **by full path** (as `detect` already does), or the `ai.common.models` barrel `__init__` is
  made **lazy (PEP 562)**. **Chose Option A** (the 4 barrel importers now use full-path imports —
  `.gliner`/`.audio`/`.transformers`/`.ocr`); Option B was rejected because it does **not** help the AST
  walk without a matching walker change (`ast.walk` still traverses the `TYPE_CHECKING` re-export block,
  or under-includes if that block is removed). Measured effect: `audio_transcribe` **24 → 7** files,
  `anonymize` **23 → 5**, zero cross-family leaks.
- **Residual: within-family over-inclusion (DEFERRED decision — revisit after the engine call-site).**
  Cross-family isolation is exact — verified on the **real engine**: the `audio_transcribe` overlay
  dropped **183 → 114** packages, no `rfdetr`/`gliner`/`easyocr`/`surya`/`timm`. But a node still pulls
  **siblings within its own model family**, because the walk co-locates every `requirements*.txt` in a
  reached `ai/` directory — e.g. `audio_transcribe` pulls `kokoro` (TTS, `audio` family), `detect` pulls
  `rtmlib` (pose, `vision` family). Sound over-approximation, never under-includes; cosmetic (siblings
  are small). To tighten later, pick one:
  - **Option 1 (node-local):** the node imports the *specific* submodule
    (`from ai.common.models.audio.whisper import Whisper`) instead of the family `__init__` → drops the
    sibling for that node.
  - **Option 2 (walker):** in `ast_deps`, for `ai/` model dirs collect only files named by
    `_REQUIREMENTS_FILE` constants instead of blanket directory co-location → drops all siblings
    globally, but must re-verify it never under-includes.
- **Blast radius + generalization (whole node-tree sweeps, VERIFIED).** The barrel fix is **small and
  bounded: exactly 4 nodes** import via the barrel — `anonymize`, `audio_transcribe`,
  `embedding_transformer`, `ocr` — vs **9 already on full path** (`detect`, `ner`, `pose_estimation`,
  `caption`, `depth_estimate`, `audio_tts`, `background_removal`, `detect_segment`, `embedding_image`).
  So the prerequisite is a **4-node change** (or one lazy-barrel change), not a refactor. And the
  "no dynamic imports" result **generalizes**: a sweep of **all 481** node+ai-model files found **exactly
  one** dynamic import — `preprocessor_code/code.py`'s `importlib.import_module(modmap[lang_key])`, a
  **static lang→module dict** whose targets the walk can enumerate (or the runtime `depends()` backstop
  covers). Static AST is sound across the tree, modulo that one enumerable case.

**The backstop is not free** — an under-include means a possibly multi-GB `depends()` install happens
*mid-run* inside the venv child. Specify timing/failure: prefer resolving all reachable variants
**before readiness**; if a late install is unavoidable, block that lane (surfacing progress via the
heartbeat) and **fail cleanly** (do not hang) if it errors. AST is the pre-resolution + early-conflict
layer; runtime `depends()` is the safety net.

**Backstop contract.** (a) Prefer resolving every statically-reachable variant **before readiness**.
(b) When a dynamic `depends()` fires mid-run, block **only that lane**, surface install progress via
the existing heartbeat/sidecar (`updateProgress`), and on install failure **fail the lane with a clear
error** rather than hanging. (c) Bound the mid-run install with a timeout. Canonical cases: the
config-selected `rfdetr` import inside `ai` for the under-include path (backstop can't fire — `detect`
calls no `depends()`); `detect_segment`'s `load_depends(__file__)` for the single-fixed-file
`depends()` path.

**Model-server dimension (`--modelserver`) — a second axis the requirement set depends on (VERIFIED).**
Every `ai.common.models.*` facade branches on `get_model_server_address()` (`base.py`): with a model
server set it constructs a thin `ModelClient` (WebSocket RPC) and **never imports torch/rfdetr/whisper**
(`gpu_guard.py` installs a `sys.meta_path` blocker that makes `import torch` *raise* in this mode);
without one, `*Loader._ensure_dependencies` (`base.py`) installs + imports the heavy stack. The heavy
imports live **exclusively in the local (no-model-server) branch**. Implications for scoping:
- **Sound baseline (flag-agnostic):** both branches are statically present in the same file, so the
  transitive `ai` walk **over-approximates** — include the heavy `ai/**` requirements regardless of the
  flag. Always correct, but fat.
- **Pruning = the payoff:** make scoping **model-server-aware** — a proxied node contributes only
  wrapper/networking deps, not the `ai/**` heavy files. This shrinks venvs sharply and dissolves most
  cross-node torch-version conflicts. **Prerequisite:** node `requirements.txt` are **model-server-blind
  today** — `audio_transcribe` (faster-whisper) and `anonymize` (gliner) install heavy deps even when
  proxied, whereas `ner` (empty) / `detect_segment` (client-side only) already gate correctly. Pruning
  requires fixing the blind ones (or the scoper overriding them).
- **Does NOT sidestep the compile-time conflict.** The torch-2.0-vs-2.1 failure is at **constraints
  *compile* time** — a union over the `nodes/**` + `ai/**` globs taken **irrespective of `--modelserver`**
  (the flag changes only runtime install/import). So per-env scoping stays necessary in model-server
  mode; the flag is a **footprint optimization, not a conflict fix**.

### 4.9 Directory layout, identity & keying
- `<exe>/lib/site-packages` — **base = engine runtime only** (engLib + bundled deps); **no node deps**.
- `<exe>/venvs/<project_id>/<env_id>/` — **per-environment overlay** for EVERY env, a **top-level
  `venvs/` dir** (sibling of `lib/`, `cache/` — **not** under `cache/`). `env_id ∈ { main, <group_id> }`
  → main lives at `venvs/<project_id>/main`. Each holds `site-packages/` + its own scoped `combined.txt`,
  `constraints.txt`, `requirements.hash`, lock. The path helpers
  `_get_combined_path`/`_get_constraints_path`/hash are parameterized by the env dir. **The refactor
  surface is wider than the path helpers:** `depends.py`'s single-environment module state — the
  `_processed` set, the `install.lock`, `_progress_path`, and the single-holder heartbeat — must
  become **env-keyed** too, or concurrent envs collide.
- `<exe>/cache/models/<name>` — **shared** model weights via `model_cache_dir`, resolved relative to
  `sys.executable`. The venv child runs the **same `engine.exe`, unmoved**, so it resolves the same
  `cache/models` automatically. Models are weights, not packages → not isolated per venv.

**Constraints strategy: per-env, compiled independently of the global (VERIFIED live).** The single
biggest lever venvs pull is *not sharing one constraint resolution*.

- `<exe>/cache/constraints.txt` (**global**) governs **only** the base runtime and the legacy path
  (`ROCKETRIDE_SERVER_USE_VENV=0` / auto-without-venv). Under `=1` the **`nodes/**` glob is dropped from
  this startup compile** (`_SCOPED_EXCLUDED_GLOBS`) and it is compiled from `ai/**` + the root
  requirements alone; node dependencies then arrive exclusively through per-env scoped installs.
  **This gating is load-bearing, not an optimization (VERIFIED live).** While `nodes/**` stayed in the
  glob, every node in the installation had to be mutually satisfiable: two nodes pinning incompatible
  versions made `ensure_constraints()` fail at import of `ai/__init__.py`, so **the engine could not
  start at all** — before any pipeline, endpoint, or per-env logic ran. Per-env scoping cannot deliver
  its headline benefit while the startup compile still unions the whole node universe.
- `venvs/<project_id>/<env_id>/constraints.txt` (**per-env**) is compiled from **that env's
  `combined.txt` alone — no global base** — so it resolves versions solely from the requirement files its
  nodes reach. The scoped install **and** the runtime `depends()` calls active in that env both resolve
  against the **env** constraints (never the global), so the overlay is internally consistent and no
  global pin leaks in.
- **Granularity is per-env, not per-project.** `venvs/<proj>/main`, `venvs/<proj>/<group>` each get their
  own `constraints.txt`. This is exactly what lets an env with `torch 2.0` and another with `torch 2.1`
  coexist — a shared per-project constraints file would collapse them into one resolution and defeat the
  isolation venvs exist for.
- **Why `ai` makes this essential:** `ai/**` modules carry their own pins (`torch/requirements.txt` →
  `torch==2.10.0+cu128`, `requirements_detection.txt` → `rfdetr`, …). Under one global compile every pin
  meets every other; per-env, only the pins of the `ai` modules an env's nodes actually reach (via the
  AST walk) enter that env's constraints → fewer pins, fewer false conflicts, real conflicts isolated to
  their env.
- **Runtime `depends()` integration (implemented, live-verified):** while an overlay is active,
  `depends()` installs via `uv --target <overlay>` and `-c <env constraints>` (not `-c cache/…`), so
  node model-loads and the AST-miss backstop land **in the overlay at the env-resolved versions** (no
  version churn), keeping base untouched.
- **Residual (honest):** base *today* still receives `ai/**` at startup bootstrap (legacy behavior), so
  it is not yet strictly runtime-only. Constraints are already fully per-env; physically stripping the
  node/model deps out of base is the remaining Phase-2A-step-1 work (§4.7 blast radius).

**Key by stable IDs; name is metadata.**

- `<project_id>` (the pipe-id) is a stable GUID at `config.pipeline.project_id`. Shared across all
  per-source task runs of the same pipeline.
- `<group_id>` (the venv-id) = the group node's `id` (e.g. `group_1`) — stable, generated once, **never
  changes when the venv is renamed** (the display name lives in `config.environment.name`).
- **Consequence: NO rename logic needed** — renaming a venv changes only metadata, not the path.
- **Requirements drift** detected by a `requirements.hash` inside the env dir (reusing
  `depends.py`'s `_compute_hash`/`_load_stored_hash`/`_save_hash`); mismatch → update install in place.
- **MAX_PATH (decision, not a note):** a 36-char GUID nested above `site-packages` + deep torch/nvidia
  paths **will** exceed Windows 260, and long-path support is host-opt-in/unreliable → **default to a
  shortened id segment** (e.g. first 8 hex of the `project_id` GUID; likewise `group_id`). Point all
  venv installs at **one shared `uv` download cache** so common wheels aren't re-downloaded.

### 4.10 Lifecycle: per-run process, install lock, purge/GC
- **Venv process = the pipeline run.** A venv child is spawned when the run starts and exits when it
  ends — a **sibling** of the main `engine.exe`, mirroring today's process-per-run model. It handles all
  objects in that run but is **never reused across runs**. No warm pool. Two runs (same or different
  pipeline) → separate processes → no interference.
- **On-disk env reused across runs** (only the process is per-run): installed once, keyed by stable IDs,
  drift detected by `requirements.hash`.
- **Install timing:** lazy on first run + opt-in deploy-time pre-warm; reuse `depends.py`'s existing
  install-progress reporting verbatim (`updateProgress` / heartbeat / sidecar), tagged per env.
- **Concurrent-install lock (race fix):** process-per-run + a shared cached env dir + install-on-drift
  could let two concurrent runs both `uv install --target` into the same `site-packages` → corruption.
  `depends.py` **already** has the `FileLock`/`install.lock` mechanism — **scope it per env dir** (one
  lock per `venvs/<proj>/<env>/`, not the single global lock) and define the **second-run
  wait-on-readiness** vs. fail behavior.
- **Purge & delete (canvas-driven).** *Purge* = remove all installed packages, keeping standard Python
  (delete the contents of the venv's `site-packages`; the base/stdlib survives because it's shared).
  - **Operation A — Purge (cog):** wipes packages, keeps the container + nodes. Allowed only when no run
    uses that env (active-task registry, `task_server.py`); deleting files a live process holds fails on
    Windows, so the gate is mandatory. Exposed as an engine command over the protocol (local + cloud).
  - **Operation B — Delete the container:** asks (1) delete member nodes + connections? (no = ungroup,
    keep them); (2) also remove the venv? (yes = delete the entire `venvs/<project_id>/<group_id>/`).
  - **Operation C — Pipeline deleted:** delete the whole `venvs/<project_id>/` subtree.
  - **Lifecycle coupling:** the dir lives as long as its canvas entity; **orphan-GC reconciliation** is
    the safety net (pipelines/groups can be deleted out-of-band — e.g. the `.pipe` removed directly).
    LRU eviction under disk pressure is a separate, secondary mechanism for still-valid-but-stale envs.

### 4.11 Overlay mechanism (sys.path; never move the binary)
The venv child runs the **original `engine.exe`, unmoved**; the bootstrap reads `ROCKETRIDE_VENV_SITE`
and does **`sys.path.insert(0, venv_site)`** — the exact mirror of the existing
`_ensure_site_packages` `append`, but `insert`-ahead-of-base for **overlay precedence** (venv `torch`
wins; append would let base shadow it). **`PYTHONPATH` won't work** (isolated `PyConfig`); use the
runtime insert.

Because `sys.executable` is unchanged, `model_cache_dir`/`engine_cache_dir`/base `lib/site-packages`
all resolve to the shared install dir — `cache/models` shared, base runtime preserved. **Do not copy
the engine into the venv dir:** that changes `sys.executable` → cache/site-packages resolve to the venv
dir (wrong; also loses the engine runtime, and on Windows would require copying the `python3XX.dll` +
`vcruntime`). The dev debug shim copies `python.exe` but **in the same dir**, so it's safe; venvs don't
copy.

Supporting `depends.py` changes: `uv pip install --target <venv_site>`; reuse the existing post-install
cache reset (`importlib.invalidate_caches()` + `sys.path_importer_cache.pop`) on the venv path. **Verify:**
the insert position (venv ahead of base site-packages but not breaking the engine framework dirs
`rocketlib`/`ai`/`nodes`), and `uv --target` + `--no-build-isolation` behavior (`.pth`, console scripts,
the pywin32 path hack).

### 4.12 Response & failure merge-back
A venv node's final response and any `objectFailed`/`completionError` must be shipped back and **merged
into the root entry** the client reads (`data_conn.py:_close`), or venv-produced results/failures
silently vanish. This is what allows an **end/return node to live in a venv** (§4.11 asymmetry).

### 4.13 Edge cases
- **Membership is `parentId`, not canvas geometry.** A node belongs to exactly one venv. Two boxes that
  visually **intersect** still have unambiguous membership (the partitioner reads `parentId`); the UI
  should prevent/warn on overlap. **Nested** isolated groups (venv-in-venv) are **rejected in v1**.
- **Start/source node must stay in `main`** (rejected inside a venv in v1) — the client drives the root
  pipe in the process it connects to. The guard belongs in `resolve_implied_source` (which does the
  exactly-one-`Source` detection), not `_check_pipeline` (which only validates the named source exists).
- **End/return node MAY be in a venv** — via response merge-back (§4.12). Asymmetric with the source
  (input is driven in; output flows back).
- **How many distinct environments drives the outcome:** no isolated groups → 1 process (today); some
  in main + some in venvs → partition + hub; **all nodes in ONE venv** → **collapse** to a single
  process running that venv's overlay (no bridge); ≥2 venvs with nothing in base → uncommon corner
  (v1: require the source's env to be root, or a base-env source).
- **Multi-source pipelines** are one pipeline with multiple lanes; constraints span the **whole
  document** (§4.7). **Process-count note:** each source is its own task/process today, so a pipeline
  with N sources and M venvs spawns **N × (1 + M)** processes (children are per-run, never shared across
  source-tasks, §4.10). The per-env install lock covers the shared *disk* env; the process count itself
  is the accepted v1 cost — revisit (shared children per pipeline) only if real pipelines hit limits.

### 4.14 Non-pipeline entry points (engtest, CLI, ad-hoc, test harnesses)
These have **no `project_id`**, so the scoping must degrade gracefully: `ROCKETRIDE_VENV_SITE` unset →
overlay no-ops → use base; `depends.py` tolerates a missing `project_id`/`env_id` and falls back to a
**default env** (or base). Concrete cases:

- **`engtest`** (engine-lib Catch2 binary, links engLib → embeds Python) runs
  `loadModule("nodes.webhook")`. Its `python::config` test asserts `sys.prefix == sys.executable dir ==
  rootDir` — our **no-move-binary overlay preserves this** (the rejected copy-binary approach would
  fail it → a free regression guard). Node modules import from `nodes/src` on `sys.path` (dev), so
  module-load needs no install; only third-party deps need the env.
- **`builder nodes:test`** runs **many** nodes' tests in one env today (works only because all nodes are
  currently compatible). Once venvs allow incompatible nodes, a single pytest process (one
  `site-packages`) can't host `torch 2.0` and `torch 2.1` tests → **per-node-scoped test envs**, reusing
  the same `depends.py` env-dir primitive, with incompatible nodes in **separate worker processes**
  pinned via `ROCKETRIDE_VENV_SITE` (composing with the planned pytest-xdist work). Declarative node
  tests are already mini-pipelines (`nodes/test/framework/pipeline.py`) → run them through the same
  partitioner. **Must land before the first incompatible node ships**, else the suite breaks.

### 4.15 Compatibility & the venv master switch (`ROCKETRIDE_SERVER_USE_VENV`)
The whole feature (venv runtime **and** per-environment scoping) is gated by one environment variable,
so downstream/open-source consumers can pin today's behavior. **This is a permanent supported mode, not
a migration flag.**

The variable is read by `venv_env.use_venv_mode()` at the moment dependencies are resolved. It is set
on the **server** process (launch config, systemd unit, container env); the task subprocess inherits it,
and the whole execution path — startup compile, endpoint hook, per-env install — is therefore
self-consistent. Clients need nothing: an SDK client does not import `rocketlib` (the import in
`client-python`'s `dap_base` is guarded by `except ImportError`) and so never enters dependency
resolution at all.

**Known gap.** `<exe>/.env` is loaded by `ai/web/server.py` inside `WebServer.__init__`, but
`ai/__init__.py` calls `depends()` at import — so a value placed in `.env` is read **after** the
resolution it would govern and silently has no effect. Putting the switch there therefore does not work
today. Closing this properly means moving the engine's `load_dotenv` ahead of dependency resolution, not
teaching `venv_env` to parse the file.

- **Unset (default) = auto.** The partitioner inspects the *resolved* pipeline: an `isolated` group
  present → venv runtime + per-env scoping; none present → today's single-process / global-glob
  behavior. (This is already how §4.3/§4.13 behave — the default changes nothing for existing pipes.)
- **`=0` = force off (legacy mode).** Never partition: any `isolated` group is **demoted to a plain
  organizational group** (flattened into one process), and dependencies resolve via the **global-glob
  `constraints.txt` path**. Byte-for-byte today's behavior; **never an error**, even if the document
  contains isolated groups. This is the escape hatch for downstream consumers.
- **`=1` = force on.** Enables the venv machinery and per-env scoping (still a no-op partition if the
  pipeline genuinely has no isolated groups, but per-env `main` scoping applies). It **also drops
  `nodes/**` from the global startup compile** (§4.9), which is what actually lets nodes with
  conflicting pins coexist in one installation.

**Known limit of `auto` (honest).** The startup compile happens at process init, before any pipeline is
known, so `auto` cannot decide the node-glob question per pipeline: it keeps the legacy union and
therefore keeps the conflicting-nodes failure. In Phase 2A **only `=1` delivers conflict isolation**.
Removing the limit means taking node dependencies out of the startup path entirely (resolving them
per-env on first use) — the same work as the base-runtime-only residual in §4.9.

A second consequence of `=1`: nodes whose imports the AST walk cannot resolve statically (flagged
`dynamic_imports`) no longer get their dependencies from the startup glob and fall back to the runtime
`depends()` backstop, which installs into the active overlay (§4.8).

Open-source/default posture: with the var unset, a consumer who never creates an isolated group gets
exactly today's engine; `=0` additionally guarantees legacy behavior even for documents authored
elsewhere that carry `environment`.

---

## 5. Open questions — resolved (with residual verification noted)
1. **Venv membership gate — RESOLVED.** `REMOTING`/`noremote` is a *network* gate; the `noremote` set
   (local filesystem `core` source, DB nodes, `text_output`) exists because those nodes can't run on a
   *remote host*. Venvs are **same-host**, so that reason doesn't apply — **do not reuse the network
   `noremote` set.** v1 rule: **venv membership is unrestricted except the source node** (already forced
   to `main`, §4.13); DB/filesystem/`text_output` nodes run fine in a venv. Define a venv-specific
   capability only if a concrete node proves it needs the client's direct fd; none found so far.
2. **AST variant discovery — RESOLVED via §4.8 correction (premise was wrong).** No
   `requirements_pose`/`requirements_detection` variant files exist; `detect`/`pose_estimation` declare
   no `requirements.txt` and never call `depends()`. Heavy deps are lazy, config-selected imports **two
   hops inside `ai`** (`detection.py::_build_backend`), so a node-file AST walk **under-includes** and
   the `depends()` backstop **doesn't fire** for them. Resolution: the walk must be **transitive through
   `ai`** and **include all reachable config-branch backends' `requirements*.txt`** (§4.8). **A
   throwaway prototype has now PROVEN this** on `detect`/`audio_transcribe`/`anonymize`: zero
   under-includes, zero dynamic imports (§4.8 Prototype result). The remaining 2A prerequisite is
   **precision** — the `ai.common.models` barrel `__init__` re-exports every submodule, so barrel-
   importing nodes over-include the whole ML stack until the barrel goes lazy or nodes import submodules
   by full path. Second axis: the walk (or a model-server-aware pruning of it) must account for
   `--modelserver` mode, where the heavy `ai/**` deps aren't imported at all (§4.8 Model-server
   dimension).
3. **Non-isolated grouped pipelines — RESOLVED: they do NOT run today (verified).** `getProjectComponents`
   nests group children into the group's `config.pipeline.components`; the engine (`stack.cpp`) reads
   only top-level `components[]`; **no flattening pass exists** in `prepare_pipeline.py`, `pipeline.py`,
   `task_engine.py`, or C++. Grouped children are silently dropped. → The partitioner **must** own
   "flatten non-isolated groups" (already Phase-2B step 5); this also fixes an existing latent bug.
4. **Partitioner + orchestration ownership — RESOLVED: both in `task_engine.py`; pure transform in
   `pipeline.py`.** The engine subprocess is spawned in `task_engine.py` (`create_subprocess_exec`,
   ~L1561; readiness ~L501-520; teardown `_terminated` ~L563). Put the partitioner as a **pure function
   in `pipeline.py`** (sibling to `resolve_pipeline_env`/`resolve_implied_source`), invoked from
   `Task._build_task` (~L355) before the task file is written. Venv-child spawn/lifecycle/channel
   **mirror the existing engine-spawn pattern in `task_engine.py`**. `task_server.py` keeps the
   active-task registry (`_task_control`/`TASK_CONTROL.project_id`), the **port broker**
   (`assign_port`/`release_port`, already cross-called from `task_engine` ~L1500/1513), and auth/WS/DAP;
   it gains only the minimal shared-resource entries a venv child needs (a registry row + a port).
5. **Multi-process debug UX — DIRECTION set; detailed UX deferred to 2C.** Each venv child gets its own
   `--debug_port` from the existing port broker (`assign_port`), exactly as the main engine does today.
   The client attaches to **main**, which **advertises/multiplexes the child DAP endpoints** (it already
   owns the per-child sockets as the hub, §4.6). Cross-cut single-stepping and unified breakpoint UX are
   the genuinely open part → 2C.

## 6. Risks & gating requirements
- 🟠 **Metrics/billing multi-PID rollup (money bug) — driver-feasibility DE-RISKED; residual is
  grouping.** **CPU/RAM** sum across the venv process tree (per-PID). For **GPU**: **concurrent pipelines
  are already billed correctly today**, and each running pipeline is its own `engine.exe` PID — so the
  billing path **already attributes GPU across multiple independent PIDs** on our real hardware. That is
  empirical proof the driver-level per-PID capability exists, so the earlier "feasibility spike" is **no
  longer needed**. Venvs therefore reduce to **bookkeeping**: sum a venv's child PIDs under the **parent
  pipeline's** billing identity (the orchestrator already tracks which children it spawned) rather than
  counting them as separate pipelines. Residual (still money-critical but **desk-checkable, no spike**):
  confirm children are **grouped into the parent's bill** — not dropped (under-bill) nor double-counted
  as standalone pipelines (over-bill).
- 🟠 **Phase 2A blast radius = only pipelines where the scoped path is enabled** (`=1`, or auto with
  isolated groups). Under the default (unset, no venvs) **nothing changes** — §4.15 semantics. The
  radius becomes "every pipeline" only if/when a later release flips auto to scoped-by-default.
- 🟢 **AST correctness PROVEN and precision prerequisite DONE (§4.8 Prototype result).**
  `ast_deps.py` (implemented, 13 tests) resolves providers and does the transitive walk; over the three
  hardest nodes it reached **every** ground-truth requirement file with **zero under-includes and zero
  dynamic imports**. The over-inclusion residual (the `ai.common.models` barrel `__init__`) is **fixed
  via Option A** — the 4 barrel importers (`anonymize`, `audio_transcribe`, `embedding_transformer`,
  `ocr`) now import by full path; measured `audio_transcribe` **24→7** files, `anonymize` **23→5**, no
  cross-family leaks. A whole-tree sweep (481 files) found only **1** dynamic import (`preprocessor_code`,
  enumerable). Was 🔴 → 🟠 (prototype) → 🟢 (barrel fix applied).
- **Scoping should be model-server-aware (footprint optimization, §4.8).** Under `--modelserver` a
  proxied node needs no `ai/**` heavy deps (facades take the `ModelClient` branch; `gpu_guard` blocks
  `import torch`); pruning them shrinks venvs and removes most conflicts. Prerequisite: node
  `requirements.txt` are model-server-blind today (`audio_transcribe`, `anonymize`). Note: model-server
  mode does **not** remove the *compile-time* conflict (that glob union is flag-independent), so venvs
  stay necessary.
- 🟠 **Concurrent install race** — per-env lock (§4.10).
- 🟠 **Large image/video crossings — payload shrinks with cloud store, but the AV lanes stay.** In the
  target architecture AV bytes live in **cloud storage** (`ai..account.store`); bulk bytes are fetched
  from the store rather than streamed node-to-node. **AV metadata still crosses on the
  `writeVideo`/`writeAudio`/`writeImage` lanes**, so the bridge must still implement every AV lane
  (§4.4 is *not* reducible) — what drops is the per-frame **payload size** (small metadata vs multi-MB
  buffers), which is what removes the ~1 MB-chunk throughput risk. **Interim** (pre-store): raw AV
  crosses these lanes and must meet a throughput target on the loopback WS bridge (2-hop hub multiplies
  buffer copies), with UI warning on a heavy-lane boundary and shared-memory zero-copy as the v2
  fallback. Store-fetch in the child needs account context (secrets/`ROCKETRIDE_CLIENT_ID` propagation).
- **Cross-env cyclic deadlock** — v1: detect env-cycles at partition and reject.
- **Secrets scoping (a win):** partition runs on the *resolved* pipeline, so each child sub-document
  carries only the secrets its own nodes reference (the `ocr` venv never sees the LLM key). Document how
  account context / `ROCKETRIDE_CLIENT_ID` reaches each child.
- **Backward compatibility:** old `.pipe` documents lack `environment` and must run unchanged (additive).
- **Free upside:** separate processes = separate GILs → CPU-bound nodes in different venvs run *genuinely*
  in parallel.

---

## 7. Phased implementation plan

**Phase 1 — this design document.** (Done; pauses for review.)

**Phase 2A — Foundation: per-environment requirement scoping (no venvs yet; independently shippable).**
*Behind a feature flag with fallback to today's global-glob path (blast radius = every pipeline).*
1. `depends.py` parameterization — `ensure_constraints()`/install take an **explicit requirement-file
   set + env dir** (no global glob); uniform per-env build (main included); `uv --target
   <venvs/<project_id>/<env_id>/site-packages>`; per-env constraints/lock/`requirements.hash`; the
   `sys.path.insert` overlay hook; base = engine runtime only; default-env fallback when no `project_id`;
   **env-key the module-global install state** (`_processed`/lock/progress/heartbeat), not just the path
   helpers.
2. **AST `ai/**` discovery** — once per init, cached; config-driven-variant + dynamic-import handling;
   runtime `depends()` backstop with defined timing/failure.
3. **Non-pipeline entry points** — `engtest` fallback; `builder nodes:test` per-node isolation (must
   precede any incompatible node).
   *Payoff (opt-in, per §4.15):* when the scoped path is enabled (`ROCKETRIDE_SERVER_USE_VENV=1`, or
   auto with an isolated group present), the pipeline runs in a node-scoped "main" env → faster/smaller,
   no gliner/whisper bloat. **If no venv is needed** — the pipeline contains no isolated groups and the
   variable is unset — **it runs exactly as today**: one process, global-glob resolution, no behavior
   change. De-risks the dependency-model change in isolation.
   *Strategic note:* in **model-server deployments** the model servers already isolate the heavy
   conflicting deps (each server owns its own env), so **most of the value lands in 2A alone**; the 2B
   venv *runtime* is primarily for **internal / no-model-server mode**, where conflicting nodes share one
   in-process interpreter. This sharpens sequencing: ship 2A broadly, prioritize 2B for internal-mode
   users.
- **Tests (§8.1–8.3):** AST-walk / resolution-rule / `depends`-parameterization / model-server-pruning
  **unit tests**; the `vtest_alpha`/`vtest_beta` **fixture nodes**; the **no-venv-conflict-fails** and
  **only-needed-installed (no-whisper)** acceptance tests; embedding-invariant regression.

**Phase 2B — Venv runtime (the isolation feature), on top of 2A.**
4. **Schema + UI:** the placeable Virtual Environment container + `config.environment`; validation
   (source-in-group via `resolve_implied_source`, env-cycle, nested/overlap). Bridge nodes internal.
5. **Partitioner:** generalize `prepare_pipeline.py` (flatten non-isolated; cut isolated; insert bridge
   nodes; routing table; full-document node set).
6. **Bridge: extract shared base + new `venv` node** (all 15 lanes; `image`/`video`/`audio`); network-
   remote untouched.
7. **Local spawn + transport (v1 = WS-over-loopback unchanged):** spawn the venv child (its overlay) and
   point the existing `remote` WS bridge at it over loopback (Bearer token; raise the ~1 MB AV ceiling);
   main-orchestrator hub routing. No layer-2 swap in v1.
8. **Orchestrator** (`task_engine.py`): N children/run (sibling lifetime), channel wiring, readiness,
   teardown-with-run, response/failure merge-back, monitor/trace/SSE fan-in, **metric aggregation across
   child PIDs**, orphan-safe binding (OS process-tree: Windows Job Objects / Unix process groups),
   install reporting, purge/delete + GC.
- **Tests (§8):** partitioner **unit tests**; the **two-venv conflict-coexists** acceptance
  (`vtest_alpha`/`vtest_beta` split across venvs); compat `=0` isolated-group **demotion**; purge /
  delete / GC **lifecycle** (blocked while a run is active).

**Phase 2C — Polish & scale.** Multi-process debug/observability across the cut; deploy-time pre-warm;
the local-IPC transport seam (UDS/named-pipe/shared-mem, §4.5); v2 optimizations (direct venv↔venv mesh,
shared-memory for AV).

---

## 8. Verification & testing
Three layers; each test is tagged with the phase that first makes it runnable (**[2A]** = scoping only,
**[2B]** = needs the venv runtime).

### 8.1 Unit tests
- **AST discovery walk** (`depends.py`) — promote the throwaway prototype (§4.8 Prototype result) to a
  real unit test with a golden requirement-set per fixture: `detect`→{detection,vision,torch},
  `audio_transcribe`→{whisper,torch}, `anonymize`→{gliner,torch}. Assert the two properties proven
  necessary: (a) **nested/in-function** imports are followed; (b) **relative imports** resolve correctly
  (`__init__` package vs module). Plus: `provider → path` resolution (aliases `chat`/`dropper`→`webhook`;
  sub-package `remote`→`remote/client`; name≠dir; native no-`path` skip); dynamic `importlib` flagged;
  **barrel-`__init__` over-inclusion guard** (full-path import stays tight, barrel import is detected). [2A]
- **`depends.py` per-env parameterization** — env-keyed paths / lock / `_processed` / progress;
  `requirements.hash` drift → reinstall; default-env fallback when no `project_id`; base =
  engine-runtime-only. [2A]
- **Compatibility switch** — `ROCKETRIDE_SERVER_USE_VENV` unset(auto) / `0`(force-off, isolated group
  demoted to a plain group, global-glob) / `1`(force-on). [2A scoping paths; 2B demotion path]
- **Model-server pruning** — a proxied node contributes only wrapper/networking deps, not `ai/**` heavy
  files (§4.8). [2A]
- **Partitioner** (`pipeline.py`) — flatten non-isolated groups; cut isolated → per-venv sub-doc +
  bridge pair + routing table; env-cycle detection; **reject** cross-boundary invoke/control edges,
  nested isolated groups, source-in-venv. Golden-file: authoring doc → expected N flat sub-docs. [2B]

### 8.2 Test-fixture nodes (purpose-built, lightweight, decoupled from `ai/**`)
Add a pair of **trivial pure-Python nodes** under the node-test tree (e.g.
`nodes/test/fixtures/nodes/vtest_alpha`, `.../vtest_beta` — the extra `nodes/` mirrors the prod
`nodes/src/nodes/` layout so `ProviderIndex` resolves them by the same rule). Each imports **only one tiny leaf package pinned to an
exact, mutually-incompatible version** — e.g. `vtest_alpha` → `tabulate==0.8.10`, `vtest_beta` →
`tabulate==0.9.0`. Pick a package **not used by the SDK or engine runtime** (`requests` would be a bad
choice — the SDK depends on it, so the pin would collide with runtime deps and muddy the test).
**They import nothing from `ai.*`**, so their requirements never touch `packages/ai`
and the conflict is isolated to the venv-scoping mechanism — fast, deterministic, no GPU/torch. These
**replace `torch 2.0/2.1`** as the conflict fixture. [created 2A; used by 8.3]

### 8.3 Integration / acceptance

- **Conflict → isolated to its environment (the core proof) — VERIFIED live.** A pipeline with **both**
  `vtest_alpha` + `vtest_beta` under `=1`: the engine **starts normally**, the client connects, and the
  conflict surfaces only in that environment's compile — `venvs/<proj>/main/combined.txt` is written with
  both pins and `uv pip compile` reports them unsatisfiable. The run aborts with the pin names in the
  message; **the server stays up** and cleans the task up. Two properties asserted from artifacts: the
  env's combined file held **9 sources** (the AST-reachable set — the two fixtures, `nodes/webhook` via
  the `dropper` alias, and the `ai/**` modules reached) rather than the 101 node requirement files in the
  installation; and the **global** `cache/combined.txt` contained **no** `tabulate` at all, so the base
  runtime was never touched. [2A]
- **The same pipeline before the `nodes/**` gating (§4.9) — the counter-proof.** With node requirements
  still in the startup glob, the identical setup killed `ai/__init__`'s `depends()` at import: the engine
  **could not start at all**, in every process including the CLI client. This is what motivated the
  gating.
- **Conflict → split across venvs → all good.** The same two nodes in **two separate venvs** → each env
  compiles/install its single pin → the pipeline runs **end-to-end**, both `requests` versions
  coexisting. Assert each overlay's `site-packages` holds the expected version (alpha-env→`0.8.10`,
  beta-env→`0.9.0`) and the other is **absent**. [2B]
- **Only-needed-installed (scoping).** (a) A pipeline using `vtest_alpha` only → its env has
  `tabulate==0.8.10`, **not** the other pin and **not** `whisper`/`faster-whisper`/`torch`. (b) A
  **no-audio** pipeline → `whisper`/`faster-whisper` **absent** from every env's install set; an audio
  pipeline → **present** (the "if whisper isn't needed it isn't installed" check). (c) Assert the
  **requirement-file set processed equals exactly the AST-reachable set**, not the global glob. [2A]
- **Compatibility (`=0` and auto) — VERIFIED live.** Both modes ran a real pipeline end-to-end
  (`venv-detect`, objectId returned) with **no `venvs/` directory created**, every install carrying
  `-c cache/constraints.txt` and **no `--target`**. The switch is fully reversible, measured on the
  startup compile: `=1` → 29 sources, **0** of them node paths; `=0` and auto → **130** sources, **101**
  of them node paths, i.e. exactly the pre-change set. Auto matches legacy because the pipeline has no
  isolated group. Still owed for 2B: a pipeline that **does** contain an isolated group must run
  single-process under `=0`, no error — the permanent opt-out (§4.15).
- **Lifecycle.** Purge, delete-with-nodes, and pipeline-delete reclaim the right `venvs/...` dirs and are
  **blocked while a run is active**. Image lanes cross a venv boundary (all-lane bridge). [2B]
- **Embedding invariant.** `server:run-engtest` (`python::config` + `webhook`) and `builder nodes:test`
  still pass — the no-move-binary overlay preserves `sys.prefix == exe dir == rootDir`. [2A]

## 9. Critical files (for implementation)
- **Reuse foundation:** `nodes/src/nodes/remote/client/prepare_pipeline.py` (transform → share/generalize);
  `remote/base/IInstance.py` (extract the bridge base; the new `venv`/`venv_server` add all lanes; WS
  `_send`/`_recv` live here = transport not separable in place); `packages/ai/src/ai/modules/remote/`
  (WS transport, reuse over loopback). `REMOTING` in
  `packages/client-python/src/rocketride/types/service.py` / services.json `noremote`.
- `packages/ai/src/ai/modules/task/task_engine.py` — partitioner hook after `_check_pipeline`; spawn N
  children; readiness; teardown; merge-back; metric/trace fan-in.
- `packages/ai/src/ai/modules/task/task_server.py` — active-task registry (gate purge/GC); `project_id`.
- `packages/ai/src/ai/modules/task/pipeline.py` — `resolve_implied_source` (source-in-venv guard).
- `packages/ai/src/ai/modules/data/data_conn.py` — canonical lane serialization to reuse in the bridge.
- **Testing:** `nodes/test/framework/pipeline.py` (declarative node tests are mini-pipelines → run
  through the same partitioner); `builder nodes:test` (per-node isolation); `server:run-engtest`
  (embedding invariant). New: `nodes/test/fixtures/nodes/vtest_alpha`/`vtest_beta` (the conflict fixture,
  §8.2). **Implemented (2A increment 1):** `.../rocketlib-python/lib/ast_deps.py` (provider→module
  resolution + transitive AST walk) with `test_ast_deps.py` — the §4.8 prototype is now a passing unit
  test (13 tests green).
- `packages/server/engine-lib/rocketlib-python/lib/depends.py` — `ensure_constraints` /
  `_find_requirement_files` / `_get_combined_path` / `_get_constraints_path` / `_get_site_packages` /
  `model_cache_dir` / `FileLock`; the AST **walk** (over the entry-module paths the partitioner
  resolves — `depends.py` itself never reads the `.pipe`) + per-env parameterization + overlay hook
  land here.
- UI: `packages/shared-ui/src/components/canvas/util/graph.ts` (`getProjectComponents`),
  `.../context/FlowGraphContext.tsx` (`onNodeDragStop`, `isValidConnection`),
  `.../node/node-group/NodeGroup.tsx`, `packages/client-typescript/src/client/types/pipeline.ts`,
  `apps/vscode/src/providers/views/Project/ProjectWebview.tsx`.
- Reference only (no edits): `packages/server/engine-lib/engLib/store/stack.cpp`,
  `.../endpoint/endpoint.pipes.cpp` — the `(from,to,lane)`/`(from,to,classType)` semantics the
  partitioner must reproduce. `init.cpp` — embedded-Python init (isolated `PyConfig`; `setPaths`).
  `.../store/services/services.cpp` (parses `protocol`→`logicalType` and `path`→`nodePath`) and
  `.../store/python/python-global.cpp` (imports `serviceDef.nodePath`, not `nodes.<provider>`) — the
  authoritative `provider → entry-module path` mapping the partitioner's AST discovery must reproduce
  (§4.8 Resolution rule); `binder.hpp` — the `Binder::MethodNames` lane list (§4.4).
  `packages/ai/src/ai/common/models/base.py` (`get_model_server_address`, `_ensure_dependencies`,
  `ModelClient`) and `.../common/models/gpu_guard.py` (the `import torch` blocker) — the model-server
  proxy/local branch the AST walk / model-server-aware pruning must model (§4.8 Model-server dimension);
  `.../common/torch/__init__.py` and `ai/common/models/**/requirements_*.txt` — where the heavy `ai/**`
  stack actually lives.
