# tool_filesystem Three-Way Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `tool_filesystem` node into three services variants — tool-only (reverted), "File Store" pipeline sink emitting on the `json` lane, and "File Store Source" that streams account-store files into the pipeline.

**Architecture:** One shared Python driver in `nodes/src/nodes/tool_filesystem/`; three `services*.json` files (multi-variant pattern like `webhook/`). Gating is purely declarative (verified: undeclared lanes are rejected at pipeline build, `pipeline_config.cpp:298`; tool discovery rides the `"tool"` control channel; classType `"store"` is an inert UI super-type). The source variant adds `IEndpoint.py` using the proven telegram push pattern: `target.getPipe()` → `pipe.open(entry)` → `writeTag*` → `close()` → `putPipe()` (`nodes/src/nodes/telegram/IEndpoint.py:443-511`).

**Tech Stack:** Python 3.10+, rocketlib (engine bridge), `ai.account.store.Store`/`FileStore`, pytest with the stub harness in `nodes/test/tool_filesystem/test_sink_naming.py`.

## Global Constraints

- **Work in the worktree** `/Users/dylansavage/Desktop/rr-filesys-node` on branch `feat/filestore-node` (already created off `origin/develop`). All paths below are relative to that worktree root.
- **Commits need gitleaks on PATH**: prefix commit commands with `PATH="/opt/homebrew/bin:$PATH"` or the lefthook pre-commit hook fails with `gitleaks: command not found`.
- MIT license header (Copyright 2026 Aparavi Software AG) on all new source files — copy the header block verbatim from `nodes/src/nodes/tool_filesystem/IInstance.py:1-22` (full 22-line version for `.py` drivers; the 4-line short form used in `nodes/test/tool_filesystem/test_sink_lanes.py:1-4` for test files).
- Python: single quotes, ruff (`python -m ruff check`, `python -m ruff format`).
- Conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Unit tests run with `python -m pytest nodes/test/tool_filesystem/ -v` from the worktree root. Contract suite `./builder nodes:test` must stay ≥310 passing (run once, in Task 5 — it is slow).
- JSON services files use TABS for indentation (match the existing `services.json`).
- Do not touch `packages/ai/` (FileStore backend) or any C++.

---

### Task 1: Services contract — revert tool variant, add File Store sink variant

**Files:**
- Modify: `nodes/src/nodes/tool_filesystem/services.json` (revert to pre-#1651)
- Create: `nodes/src/nodes/tool_filesystem/services.store.json`
- Test: `nodes/test/tool_filesystem/test_sink_naming.py:23-53` (`_load_services` + `TestServicesContract`)

**Interfaces:**
- Produces: `services.json` with `classType ["tool"]`, `lanes {}`; `services.store.json` with `protocol "filestore://"`, `classType ["store"]`, all six input lanes → `["json"]`, fields `filesystem.targetDir/emitUrl/urlExpiresIn/pathWhitelist` (+ the `filesystem.whitelistPattern` row field). Task 2's runtime tests and Task 5's docs rely on exactly these contracts.

- [ ] **Step 1: Update the contract tests to describe the split (failing first)**

In `nodes/test/tool_filesystem/test_sink_naming.py`, replace `_load_services` (line 23) and the whole `TestServicesContract` class (lines 27-53) with:

```python
def _load_services(name='services.json'):
    return json.loads((_NODE_DIR / name).read_text())


class TestServicesContract:
    def test_tool_variant_reverted_to_tool_only(self):
        d = _load_services()
        assert d['classType'] == ['tool']
        assert d['lanes'] == {}
        assert d['protocol'] == 'tool_filesystem://'
        # Sink config must be gone from the tool surface.
        for key in ('filesystem.targetDir', 'filesystem.emitUrl', 'filesystem.urlExpiresIn'):
            assert key not in d['fields']
            assert key not in d['shape'][0]['properties']

    def test_store_variant_identity(self):
        d = _load_services('services.store.json')
        assert d['protocol'] == 'filestore://'
        assert d['title'] == 'File Store'
        assert d['classType'] == ['store']
        assert d['register'] == 'filter'
        assert d['path'] == 'nodes.tool_filesystem'

    def test_store_variant_lanes_all_emit_json(self):
        d = _load_services('services.store.json')
        assert d['lanes'] == {
            'documents': ['json'],
            'text': ['json'],
            'table': ['json'],
            'image': ['json'],
            'audio': ['json'],
            'video': ['json'],
        }

    def test_store_variant_fields(self):
        d = _load_services('services.store.json')
        f = d['fields']
        assert f['filesystem.targetDir']['type'] == 'string'
        assert f['filesystem.targetDir']['default'] == 'output/'
        assert f['filesystem.emitUrl']['type'] == 'boolean'
        assert f['filesystem.emitUrl']['default'] is False
        assert f['filesystem.urlExpiresIn']['type'] == 'integer'
        assert f['filesystem.urlExpiresIn']['default'] == 3600
        assert f['filesystem.urlExpiresIn']['minimum'] == 1
        assert f['filesystem.urlExpiresIn']['maximum'] == 3600
        # No agent-tool toggles on the store surface.
        assert not any(k.startswith('filesystem.allow') for k in f)
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `python -m pytest nodes/test/tool_filesystem/test_sink_naming.py -v -k TestServicesContract`
Expected: FAIL — `test_tool_variant_reverted_to_tool_only` (classType is still `['store', 'tool']`) and the three store-variant tests (FileNotFoundError for `services.store.json`).

- [ ] **Step 3: Revert the tool services.json to its pre-#1651 content**

The pre-PR file is bit-exact in git; restore it rather than hand-editing:

```bash
git show f862d814^:nodes/src/nodes/tool_filesystem/services.json > nodes/src/nodes/tool_filesystem/services.json
```

(`f862d814` is the #1651 squash-merge; `^` is its parent on develop. Result: `classType ["tool"]`, `lanes {}`, tool-only fields/shape/description.)

- [ ] **Step 4: Create services.store.json**

Create `nodes/src/nodes/tool_filesystem/services.store.json` (tabs for indentation) with exactly:

```json
{
	"title": "File Store",
	"protocol": "filestore://",
	"classType": ["store"],
	"capabilities": [],
	"register": "filter",
	"node": "python",
	"path": "nodes.tool_filesystem",
	"prefix": "fs",
	"icon": "file-system.svg",
	"documentation": "https://docs.rocketride.org",
	"description": ["File Store pipeline sink. Persists incoming lane data (documents, text, tables, and streamed image/audio/video) to the account-scoped RocketRide file store (the same store exposed via the client SDK's fs_* methods).", "All writes are scoped to users/<client_id>/files/, resolved from the ROCKETRIDE_CLIENT_ID env var injected by the task engine.", "For each persisted file a JSON reference {path, url?} is emitted on the json lane; the signed url is included when 'Emit download URL' is enabled."],
	"lanes": {
		"documents": ["json"],
		"text": ["json"],
		"table": ["json"],
		"image": ["json"],
		"audio": ["json"],
		"video": ["json"]
	},
	"preconfig": {
		"default": "default",
		"profiles": {
			"default": {
				"title": "Default"
			}
		}
	},
	"fields": {
		"filesystem.targetDir": {
			"type": "string",
			"title": "Target directory",
			"description": "Base directory (relative to the account file store root) that lane-written files are placed under.",
			"default": "output/"
		},
		"filesystem.emitUrl": {
			"type": "boolean",
			"title": "Emit download URL",
			"description": "Also include a time-limited signed download URL in the emitted JSON reference.",
			"default": false,
			"enum": [
				[true, "Yes"],
				[false, "No"]
			]
		},
		"filesystem.urlExpiresIn": {
			"type": "integer",
			"title": "URL expiry (seconds)",
			"description": "TTL for the signed URL when 'Emit download URL' is on. Max 3600.",
			"default": 3600,
			"minimum": 1,
			"maximum": 3600
		},
		"filesystem.whitelistPattern": {
			"type": "string",
			"title": "Path Pattern (regex)",
			"default": ""
		},
		"filesystem.pathWhitelist": {
			"title": "Path Whitelist",
			"description": "Regex patterns applied to the relative path of every write using re.search semantics: a partial match anywhere in the path is enough, so a pattern like 'secret' will also match 'notsecret/file.txt'. Anchor with ^ and $ if you need a full-path match (e.g. '^docs/.*$'). If non-empty, a path must match at least one pattern. If empty, all paths under users/<client_id>/files/ are allowed.",
			"type": "array",
			"optional": true,
			"minItems": 0,
			"items": {
				"type": "object",
				"properties": ["filesystem.whitelistPattern"]
			}
		}
	},
	"shape": [
		{
			"section": "Pipe",
			"title": "File Store",
			"properties": ["type", "filesystem.targetDir", "filesystem.emitUrl", "filesystem.urlExpiresIn", "filesystem.pathWhitelist"]
		}
	]
}
```

Notes: no `allow*` fields (no tool surface); `capabilities` is empty — the tool variant's `["invoke"]` belongs to the tool channel only. The driver's `IGlobal.beginGlobal` reads `allowWrite` with default `True` (`IGlobal.py:71`), so the sink writes without the field being present.

- [ ] **Step 5: Run the contract tests to verify they pass**

Run: `python -m pytest nodes/test/tool_filesystem/test_sink_naming.py -v -k TestServicesContract`
Expected: PASS (all 4).

Also run the FULL node suite to see what Task 2 owns: `python -m pytest nodes/test/tool_filesystem/ -v`
Expected: the `TestSinkConfig` and `test_read_size_cap` tests still PASS. Lane tests in `test_sink_lanes.py` still pass at this point (they exercise the driver, not services.json) — they change in Task 2.

- [ ] **Step 6: Commit**

```bash
git add nodes/src/nodes/tool_filesystem/services.json nodes/src/nodes/tool_filesystem/services.store.json nodes/test/tool_filesystem/test_sink_naming.py
PATH="/opt/homebrew/bin:$PATH" git commit -m "feat(nodes): split File Store sink services variant out of tool_filesystem

Reverts services.json to the pre-#1651 tool-only surface and adds
services.store.json (filestore://, classType [store]) carrying the sink
lanes and config. Shared driver, declarative gating.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Sink emits JSON refs on the `json` lane

**Files:**
- Modify: `nodes/src/nodes/tool_filesystem/IInstance.py:444-480` (`_sink_emit`, `open`)
- Test: `nodes/test/tool_filesystem/test_sink_lanes.py`, `nodes/test/tool_filesystem/test_sink_naming.py:256-300` (`_sink_instance` harness)

**Interfaces:**
- Consumes: `_sink_ref()` dicts `{'storePath': str, 'url': str|None, 'name': str, 'mime': str|None}` (`IInstance.py:424-429`, unchanged).
- Produces: per persisted file, one `self.instance.writeJson(payload)` call with `payload = {'path': <storePath>}` plus `'url'` key only when a signed URL was resolved. Emission is skipped when `'json'` is not in `self.instance.getListeners()`. `Doc`/`DocMetadata` and `_sink_chunk_id` are gone from the emit path; `open()` keeps only the media-stream abort.

- [ ] **Step 1: Update the harness default listener**

In `nodes/test/tool_filesystem/test_sink_naming.py`, in `_sink_instance(...)` change the keyword default (line 267):

```python
    listeners=('json',),
```

- [ ] **Step 2: Rewrite the lane tests' emission assertions (failing first)**

In `nodes/test/tool_filesystem/test_sink_lanes.py` apply these edits:

Replace `test_documents_multi_doc_index_disambiguates_and_chunkids_increment` (lines 36-48) with:

```python
def test_documents_multi_doc_emits_one_json_ref_per_file():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-x')
    result = inst.writeDocuments([MagicMock(page_content='one'), MagicMock(page_content='two')])
    assert result == 'PREVENT_DEFAULT'
    paths = [c.args[0] for c in fs.write.await_args_list]
    assert paths == ['output/a_0.txt', 'output/a_1.txt']
    payloads = [c.args[0] for c in inst.instance.writeJson.call_args_list]
    assert payloads == [{'path': 'output/a_0.txt'}, {'path': 'output/a_1.txt'}]
```

Replace `test_documents_persists_without_listener_but_does_not_emit` (lines 59-64) with:

```python
def test_documents_persists_without_listener_but_does_not_emit():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', listeners=())
    inst.writeDocuments([MagicMock(page_content='hello')])
    fs.write.assert_awaited_once()  # still persisted
    inst.instance.writeJson.assert_not_called()  # nothing to emit to
```

In `test_image_streams_to_store_and_emits_on_end` (lines 105-122), replace the last two lines with:

```python
    (payload,), _ = inst.instance.writeJson.call_args
    assert payload == {'path': 'output/img1.png'}
```

In `test_empty_media_stream_writes_no_file` (line 162) and `test_open_discards_stream_the_previous_object_left_unfinished` (line 188), change `inst.instance.writeDocuments.assert_not_called()` to `inst.instance.writeJson.assert_not_called()`.

Replace `test_open_restarts_chunk_ids_for_the_next_object` (lines 191-199) with:

```python
def test_open_does_not_leak_state_between_objects():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-a')
    inst.writeText('one')
    inst.open(MagicMock())  # engine opens the next object
    inst.writeText('two')
    payloads = [c.args[0]['path'] for c in inst.instance.writeJson.call_args_list]
    # _fs() reports no existing paths, so both writes resolve the same name.
    assert payloads == ['output/a.md', 'output/a.md']
```

Replace `test_emit_url_lands_on_emitted_doc_metadata` (lines 246-251) with:

```python
def test_emit_url_lands_in_json_payload():
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-1', emit_url=True)
    inst.writeText('# heading')
    (payload,), _ = inst.instance.writeJson.call_args
    assert payload == {'path': 'output/report.md', 'url': 'https://x/task/fetch?token=t'}


def test_no_url_key_when_emit_url_off():
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-1', emit_url=False)
    inst.writeText('# heading')
    (payload,), _ = inst.instance.writeJson.call_args
    assert 'url' not in payload
```

- [ ] **Step 3: Run to verify the rewritten tests fail**

Run: `python -m pytest nodes/test/tool_filesystem/test_sink_lanes.py -v`
Expected: the rewritten tests FAIL (driver still calls `instance.writeDocuments`, and the `'json'` listener check doesn't exist yet).

- [ ] **Step 4: Rewrite `_sink_emit` and `open` in IInstance.py**

Replace `_sink_emit` (lines 444-467) with:

```python
    def _sink_emit(self, refs: list[dict]) -> None:
        """Emit one JSON reference per persisted file on the ``json`` lane.

        The payload is ``{'path': <store-relative path>}`` plus a ``'url'`` key
        when a signed download URL was resolved (``emitUrl`` on). Plain JSON —
        no Doc/chunkId semantics — so downstream JSON consumers get the refs
        without vector-store metadata riding along.
        """
        if not refs:
            return
        if 'json' not in self.instance.getListeners():
            return
        for ref in refs:
            payload = {'path': ref['storePath']}
            if ref.get('url'):
                payload['url'] = ref['url']
            self.instance.writeJson(payload)
```

Replace `open` (lines 471-480) with:

```python
    def open(self, object: Entry):
        """Per-object reset: stale media streams are dropped.

        A stream aborted before END (upstream error, dropped object) would
        otherwise keep its write handle and half-written file alive, and the
        next object's chunks would land in it.
        """
        for kind in list(getattr(self, '_media_streams', None) or {}):
            self._media_abort(kind)
```

Then delete the now-stale sink-section comment reference to "a reference Doc is emitted downstream" (line 370) — change that line to `# the account-scoped FileStore and a JSON reference is emitted downstream.` Also update the module docstring if it mentions the documents-lane emission (check `IInstance.py:24-42`).

- [ ] **Step 5: Run the full node unit suite**

Run: `python -m pytest nodes/test/tool_filesystem/ -v`
Expected: ALL PASS.

- [ ] **Step 6: Lint and commit**

```bash
python -m ruff check nodes/src/nodes/tool_filesystem/ nodes/test/tool_filesystem/ && python -m ruff format --check nodes/src/nodes/tool_filesystem/ nodes/test/tool_filesystem/
git add nodes/src/nodes/tool_filesystem/IInstance.py nodes/test/tool_filesystem/test_sink_lanes.py nodes/test/tool_filesystem/test_sink_naming.py
PATH="/opt/homebrew/bin:$PATH" git commit -m "feat(nodes): File Store sink emits JSON refs on the json lane

Per persisted file: {path, url?} via writeJson, replacing the
documents-lane Doc emission; chunkId bookkeeping drops with it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: File Store Source services contract

**Files:**
- Create: `nodes/src/nodes/tool_filesystem/services.source.json`
- Test: `nodes/test/tool_filesystem/test_sink_naming.py` (`TestServicesContract`)

**Interfaces:**
- Produces: `services.source.json` — `protocol "filestore_source://"`, `classType ["source"]`, `register "endpoint"`, `lanes {"_source": ["tags"]}`, fields `filesystem.path` (string, default "") and `filesystem.recursive` (boolean, default false). Task 4's `IEndpoint` reads these as flat `parameters` keys `path` / `recursive` (the engine strips the `filesystem.` prefix — same mechanism as telegram, `nodes/src/nodes/telegram/IEndpoint.py:67-79`).

- [ ] **Step 1: Add contract tests (failing first)**

Append to `TestServicesContract` in `nodes/test/tool_filesystem/test_sink_naming.py`:

```python
    def test_source_variant_identity(self):
        d = _load_services('services.source.json')
        assert d['protocol'] == 'filestore_source://'
        assert d['title'] == 'File Store Source'
        assert d['classType'] == ['source']
        assert d['register'] == 'endpoint'
        assert d['capabilities'] == ['noinclude']
        assert d['path'] == 'nodes.tool_filesystem'
        # Raw objects go out on the tags lane for a downstream Parser.
        assert d['lanes'] == {'_source': ['tags']}

    def test_source_variant_fields(self):
        d = _load_services('services.source.json')
        f = d['fields']
        assert f['filesystem.path']['type'] == 'string'
        assert f['filesystem.recursive']['type'] == 'boolean'
        assert f['filesystem.recursive']['default'] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest nodes/test/tool_filesystem/test_sink_naming.py -v -k source_variant`
Expected: FAIL — FileNotFoundError for `services.source.json`.

- [ ] **Step 3: Create services.source.json**

Create `nodes/src/nodes/tool_filesystem/services.source.json` (tabs) with exactly:

```json
{
	"title": "File Store Source",
	"protocol": "filestore_source://",
	"classType": ["source"],
	"capabilities": ["noinclude"],
	"register": "endpoint",
	"node": "python",
	"path": "nodes.tool_filesystem",
	"prefix": "fs",
	"icon": "file-system.svg",
	"documentation": "https://docs.rocketride.org",
	"description": ["File Store source. Streams files from the account-scoped RocketRide file store (users/<client_id>/files/) into the pipeline as raw objects for downstream processing.", "Point it at a file to process just that file, or at a folder to process every file in it; enable 'Recursive' to also descend into subfolders.", "The client id is resolved from the ROCKETRIDE_CLIENT_ID env var injected by the task engine."],
	"tile": ["Path: ${parameters.filesystem.path}"],
	"lanes": {
		"_source": ["tags"]
	},
	"preconfig": {
		"default": "default",
		"profiles": {
			"default": {
				"title": "Default"
			}
		}
	},
	"fields": {
		"filesystem.path": {
			"type": "string",
			"title": "Path",
			"description": "File or folder to process, relative to the account file store root. A folder processes every file directly inside it.",
			"default": ""
		},
		"filesystem.recursive": {
			"type": "boolean",
			"title": "Recursive",
			"description": "When the path is a folder, also process all files in its subfolders.",
			"default": false,
			"enum": [
				[true, "Yes"],
				[false, "No"]
			]
		}
	},
	"shape": [
		{
			"section": "Pipe",
			"title": "File Store Source",
			"properties": ["type", "filesystem.path", "filesystem.recursive"]
		}
	]
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest nodes/test/tool_filesystem/test_sink_naming.py -v -k TestServicesContract`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add nodes/src/nodes/tool_filesystem/services.source.json nodes/test/tool_filesystem/test_sink_naming.py
PATH="/opt/homebrew/bin:$PATH" git commit -m "feat(nodes): File Store Source services variant (path + recursive)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: File Store Source endpoint implementation

**Files:**
- Create: `nodes/src/nodes/tool_filesystem/IEndpoint.py`
- Modify: `nodes/src/nodes/tool_filesystem/__init__.py`
- Test: Create `nodes/test/tool_filesystem/test_source_endpoint.py`

**Interfaces:**
- Consumes: `self.endpoint.serviceConfig['parameters']` (flat keys `path`, `recursive`); `self.endpoint.target` (populated by the engine before `scanObjects`, see `nodes/src/nodes/webhook/IEndpoint.py:50`); `ai.account.store.Store.create().get_file_store(client_id)` returning the async `FileStore` (`stat/list_dir/read`, shapes at `packages/ai/src/ai/account/file_store.py:344,519,268`); rocketlib `IEndpointBase`, `getObject`, `monitorCompleted`, `monitorFailed`, `warning`.
- Produces: `IEndpoint` with `validateConfig(syntaxOnly)` and `scanObjects(path, scanCallback)`; module-level `async def _collect(store, rel, recursive) -> list[tuple[str, int]]`. Per file it runs the telegram push sequence and completes when `scanObjects` returns (finite source — no blocking server).

- [ ] **Step 1: Write the endpoint tests (failing first)**

Create `nodes/test/tool_filesystem/test_source_endpoint.py`:

```python
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the File Store Source endpoint (scan + push)."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from test_sink_naming import _install_stubs, _NODE_DIR


def _install_endpoint_stubs():
    """Extend the shared stubs with the endpoint-side rocketlib surface."""
    _install_stubs()
    rl = sys.modules['rocketlib']
    if not hasattr(rl, 'IEndpointBase'):
        rl.IEndpointBase = type('IEndpointBase', (), {})
    rl.getObject = getattr(rl, 'getObject', lambda obj=None, **k: types.SimpleNamespace(**(obj or {})))
    rl.monitorCompleted = getattr(rl, 'monitorCompleted', lambda n: None)
    rl.monitorFailed = getattr(rl, 'monitorFailed', lambda n: None)
    rl.debug = getattr(rl, 'debug', lambda *a, **k: None)


def _load_endpoint_module():
    _install_endpoint_stubs()
    spec = importlib.util.spec_from_file_location('tfs_iendpoint_real', str(_NODE_DIR / 'IEndpoint.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeStore:
    """Async FileStore stub over a dict of {relative_path: bytes}."""

    def __init__(self, files):
        self.files = dict(files)

    async def stat(self, path):
        p = path.strip('/')
        if p in self.files:
            return {'exists': True, 'type': 'file', 'size': len(self.files[p])}
        if any(k.startswith(p + '/') for k in self.files):
            return {'exists': True, 'type': 'dir'}
        return {'exists': False}

    async def list_dir(self, path=''):
        p = path.strip('/')
        prefix = f'{p}/' if p else ''
        names = {}
        for k in self.files:
            if not k.startswith(prefix):
                continue
            rest = k[len(prefix):]
            head = rest.split('/')[0]
            if '/' in rest:
                names[head] = {'name': head, 'type': 'dir'}
            else:
                names.setdefault(head, {'name': head, 'type': 'file', 'size': len(self.files[k])})
        return {'entries': [names[n] for n in sorted(names)], 'count': len(names)}

    async def read(self, path, connection_id=0, max_size=None):
        return self.files[path.strip('/')]


class _FakePipe:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args):
            self.calls.append((name, args))

        return record


def _endpoint(mod, files, *, path='inbox', recursive=False, client_id='c1', monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', client_id)
    store = _FakeStore(files)
    mod.Store = MagicMock()
    mod.Store.create.return_value.get_file_store.return_value = store
    ep = mod.IEndpoint()
    pipes = []

    def get_pipe():
        p = _FakePipe()
        pipes.append(p)
        return p

    target = MagicMock()
    target.getPipe.side_effect = get_pipe
    ep.endpoint = types.SimpleNamespace(
        serviceConfig={'parameters': {'path': path, 'recursive': recursive}},
        target=target,
    )
    return ep, pipes, target


def _pushed_paths(pipes):
    return [dict(p.calls)['open'][0].name for p in pipes]


def test_single_file_pushed_with_tag_stream_sequence(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, target = _endpoint(mod, {'inbox/a.pdf': b'PDFDATA'}, path='inbox/a.pdf', monkeypatch=monkeypatch)
    ep.scanObjects('', lambda e: 0)
    assert len(pipes) == 1
    names = [c[0] for c in pipes[0].calls]
    assert names == [
        'open',
        'writeTagBeginObject',
        'writeTagBeginStream',
        'writeTagData',
        'writeTagEndStream',
        'writeTagEndObject',
        'close',
    ]
    assert dict(pipes[0].calls)['writeTagData'] == (b'PDFDATA',)
    entry = dict(pipes[0].calls)['open'][0]
    assert entry.name == 'inbox/a.pdf'
    assert entry.url == 'filestore://inbox/a.pdf'
    assert entry.size == 7
    assert entry.mimeType == 'application/pdf'
    target.putPipe.assert_called_once_with(pipes[0])


def test_folder_non_recursive_skips_subfolders(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, _t = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B'},
        path='inbox',
        recursive=False,
        monkeypatch=monkeypatch,
    )
    ep.scanObjects('', lambda e: 0)
    assert _pushed_paths(pipes) == ['inbox/a.txt']


def test_folder_recursive_descends(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, _t = _endpoint(
        mod,
        {'inbox/a.txt': b'A', 'inbox/sub/b.txt': b'B', 'inbox/sub/deep/c.txt': b'C'},
        path='inbox',
        recursive=True,
        monkeypatch=monkeypatch,
    )
    ep.scanObjects('', lambda e: 0)
    assert _pushed_paths(pipes) == ['inbox/a.txt', 'inbox/sub/b.txt', 'inbox/sub/deep/c.txt']


def test_missing_path_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {}, path='nope', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='does not exist'):
        ep.scanObjects('', lambda e: 0)


def test_missing_client_id_raises(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {'inbox/a.txt': b'A'}, path='inbox', monkeypatch=monkeypatch)
    monkeypatch.delenv('ROCKETRIDE_CLIENT_ID', raising=False)
    with pytest.raises(ValueError, match='ROCKETRIDE_CLIENT_ID'):
        ep.scanObjects('', lambda e: 0)


def test_read_failure_continues_with_next_file(monkeypatch):
    mod = _load_endpoint_module()
    ep, pipes, target = _endpoint(
        mod, {'inbox/a.txt': b'A', 'inbox/b.txt': b'B'}, path='inbox', monkeypatch=monkeypatch
    )
    store = mod.Store.create.return_value.get_file_store.return_value
    orig_read = store.read

    async def flaky_read(path, connection_id=0, max_size=None):
        if path.endswith('a.txt'):
            raise RuntimeError('boom')
        return await orig_read(path)

    store.read = flaky_read
    ep.scanObjects('', lambda e: 0)
    # a.txt failed but b.txt still made it through; every acquired pipe returned.
    assert _pushed_paths(pipes) == ['inbox/b.txt']
    assert target.putPipe.call_count == len(pipes)


def test_validate_config_requires_path(monkeypatch):
    mod = _load_endpoint_module()
    ep, _p, _t = _endpoint(mod, {}, path='', monkeypatch=monkeypatch)
    with pytest.raises(ValueError, match='path'):
        ep.validateConfig(False)
```

Note on `test_read_failure_continues_with_next_file`: a pipe is acquired per *successful* read (read happens before `getPipe`), so only `b.txt` appears in `pipes`.

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest nodes/test/tool_filesystem/test_source_endpoint.py -v`
Expected: FAIL — `IEndpoint.py` does not exist.

- [ ] **Step 3: Implement IEndpoint.py**

Create `nodes/src/nodes/tool_filesystem/IEndpoint.py` (full 22-line MIT header from `IInstance.py:1-22` first):

```python
"""
File Store source endpoint.

Streams files from the account-scoped RocketRide file store into the pipeline
as raw objects. The configured ``path`` (relative to ``users/<client_id>/files/``)
may be a single file or a folder; with ``recursive`` on, subfolders are
descended as well.

Delivery uses the engine's target-pipe push contract (the same sequence the
telegram source uses): per file, ``target.getPipe()`` -> ``pipe.open(entry)``
-> ``writeTagBeginObject/BeginStream`` -> ``writeTagData(bytes)`` ->
``EndStream/EndObject`` -> ``pipe.close()``. The raw bytes ride the ``tags``
lane to a downstream Parser. The task completes when ``scanObjects`` returns —
this is a finite source, not a long-running server.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
from typing import Any, Callable, Dict

from ai.account.store import Store
from rocketlib import IEndpointBase, getObject, monitorCompleted, monitorFailed, warning


async def _collect(store, rel: str, recursive: bool) -> list[tuple[str, int]]:
    """Resolve ``rel`` to a sorted list of ``(path, size)`` files to process.

    A file path yields itself; a folder yields its files (breadth-first into
    subfolders when ``recursive``). Raises if the path does not exist.
    """
    st = await store.stat(rel)
    if not st.get('exists'):
        raise ValueError(f'File Store Source: path {rel!r} does not exist in the account file store')
    if st.get('type') == 'file':
        return [(rel, int(st.get('size', 0)))]

    out: list[tuple[str, int]] = []
    folders = [rel]
    while folders:
        folder = folders.pop(0)
        listing = await store.list_dir(folder)
        for entry in listing.get('entries', []):
            child = f'{folder}/{entry["name"]}' if folder else entry['name']
            if entry.get('type') == 'dir':
                if recursive:
                    folders.append(child)
            else:
                out.append((child, int(entry.get('size', 0))))
    return sorted(out)


class IEndpoint(IEndpointBase):
    """Finite source endpoint over the account FileStore."""

    target = None

    def _params(self) -> Dict[str, Any]:
        try:
            return self.endpoint.serviceConfig['parameters'] or {}
        except Exception:
            return {}

    def validateConfig(self, syntaxOnly: bool) -> None:
        if not str(self._params().get('path') or '').strip():
            raise ValueError('File Store Source: "path" is required')

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], None]) -> None:
        """Enumerate the configured path and push each file into the pipeline.

        The engine's scan callback is not used: content is pushed through the
        target pipe directly (telegram pattern), so enumeration and delivery
        happen in one pass and the task completes on return.
        """
        params = self._params()
        rel = str(params.get('path') or '').strip().strip('/')
        recursive = bool(params.get('recursive', False))

        client_id = os.environ.get('ROCKETRIDE_CLIENT_ID', '').strip()
        if not client_id:
            raise ValueError(
                'File Store Source: ROCKETRIDE_CLIENT_ID env var is missing; this source must run inside the task engine'
            )
        store = Store.create().get_file_store(client_id)
        self.target = self.endpoint.target

        for file_path, size in asyncio.run(_collect(store, rel, recursive)):
            self._push_file(store, file_path, size)

    def _push_file(self, store, file_path: str, size: int) -> None:
        """Read one file and stream it through a target pipe as a raw object."""
        try:
            data = asyncio.run(store.read(file_path))
        except Exception as e:
            monitorFailed(size)
            warning(f'File Store Source: failed to read {file_path!r}: {e}')
            return

        mime = mimetypes.guess_type(file_path)[0] or 'application/octet-stream'
        entry = getObject(
            obj={
                'url': f'filestore://{file_path}',
                'name': file_path,
                'size': len(data),
                'mimeType': mime,
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            pipe.writeTagBeginObject()
            pipe.writeTagBeginStream()
            pipe.writeTagData(data)
            pipe.writeTagEndStream()
            pipe.writeTagEndObject()
            pipe.close()
            monitorCompleted(len(data))
        except Exception as e:
            monitorFailed(len(data))
            warning(f'File Store Source: failed to push {file_path!r}: {e}')
        finally:
            self.target.putPipe(pipe)
```

Implementation notes:
- `FileStore.read` caps at 100 MB (`file_store.py:268`); oversized files surface as a per-file `monitorFailed` + warning, and the scan continues — matches the read-failure test.
- `asyncio.run` per call matches the driver's `_run_async` contract (`IInstance.py:622-647`): the engine dispatches `scanObjects` synchronously on a thread with no running loop.
- The header MIT block from `IInstance.py:1-22` goes ABOVE the module docstring.

- [ ] **Step 4: Export IEndpoint from the package**

In `nodes/src/nodes/tool_filesystem/__init__.py`, update the docstring list and imports (webhook pattern, `nodes/src/nodes/webhook/__init__.py`):

```python
from .IEndpoint import IEndpoint
from .IGlobal import IGlobal
from .IInstance import IInstance

__all__ = ['IEndpoint', 'IGlobal', 'IInstance']
```

Add `- IEndpoint: File Store source endpoint` to the docstring bullet list.

- [ ] **Step 5: Run the endpoint tests, then the full node suite**

Run: `python -m pytest nodes/test/tool_filesystem/test_source_endpoint.py -v`
Expected: PASS (all 8).
Run: `python -m pytest nodes/test/tool_filesystem/ -v`
Expected: ALL PASS (no regressions from the `__init__` change — note the sink harness stubs `tool_filesystem` as a namespace package, so the real `__init__` import of `IEndpoint` is not exercised there; the contract suite in Task 5 covers the real import).

- [ ] **Step 6: Lint and commit**

```bash
python -m ruff check nodes/src/nodes/tool_filesystem/ nodes/test/tool_filesystem/ && python -m ruff format --check nodes/src/nodes/tool_filesystem/ nodes/test/tool_filesystem/
git add nodes/src/nodes/tool_filesystem/IEndpoint.py nodes/src/nodes/tool_filesystem/__init__.py nodes/test/tool_filesystem/test_source_endpoint.py
PATH="/opt/homebrew/bin:$PATH" git commit -m "feat(nodes): File Store Source endpoint — scan account store, push raw objects

Finite source: enumerates the configured file/folder (recursive toggle),
reads each file from the scoped FileStore, and pushes it through the
target pipe as tagged raw bytes (telegram push pattern).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, contract suite, final verification

**Files:**
- Modify: `nodes/src/nodes/tool_filesystem/README.md`

**Interfaces:**
- Consumes: everything above. Produces the verified branch ready for review/PR.

- [ ] **Step 1: Update the node README for the three variants**

Read `nodes/src/nodes/tool_filesystem/README.md` and rework it to document the three variants (keep its existing tone/structure; this is the co-located doc gathered by `builder docs:build`):
- **File System (`tool_filesystem://`)** — agent tool: read/write/delete/list/mkdir/stat with allow-toggles and path whitelist. Remove any sink-lane documentation #1651 added to the tool section.
- **File Store (`filestore://`)** — pipeline sink: six input lanes, per-file JSON ref `{path, url?}` emitted on the `json` lane, `targetDir`/`emitUrl`/`urlExpiresIn`/`pathWhitelist` config, per-lane filename rules (text/table → `.md`, documents → `.txt`, media → mime-derived extension).
- **File Store Source (`filestore_source://`)** — source: `path` (file or folder, store-relative) + `recursive` toggle; streams raw objects onto the `tags` lane for a downstream parser; 100 MB per-file read cap (larger files are skipped with a warning).

- [ ] **Step 2: Run the contract suite and lint**

Run from the worktree root:

```bash
python -m pytest nodes/test/tool_filesystem/ -v
python -m ruff check nodes/src/nodes/tool_filesystem/ nodes/test/tool_filesystem/
./builder nodes:test
```

Expected: node suite all pass; ruff clean; contract suite ≥310 passing, zero failures. (If the engine build hits the codesign SIGKILL / exit 137 issue, `codesign --force -s -` the engine binary per `engine_codesign_sigkill` memory and retry.)

- [ ] **Step 3: Verify docs build**

Run: `./builder docs:build`
Expected: completes without errors; the File Store / File Store Source pages assemble from the updated README.

- [ ] **Step 4: Commit**

```bash
git add nodes/src/nodes/tool_filesystem/README.md
PATH="/opt/homebrew/bin:$PATH" git commit -m "docs(nodes): document File System / File Store / File Store Source variants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Final review gate**

Confirm `git log --oneline origin/develop..HEAD` shows the five commits (spec + four implementation commits), diff contains no `pipelines/` files, and report back for PR creation (base `develop`). Do NOT push or open the PR without the user's go-ahead.
