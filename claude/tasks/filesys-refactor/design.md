# Design: Split `tool_filesystem` into three node variants

**Date:** 2026-07-29
**Status:** Approved (design review with Dylan, 2026-07-29)
**Executor skill:** superpowers:subagent-driven-development (see `plan.md`)
**Follow-up to:** PR #1651 (`feat(nodes): tool_filesystem pipeline-sink lanes`, merged to `develop` as `f862d814`)

## Problem

PR #1651 bolted pipeline-sink lanes onto the `tool_filesystem` agent tool, making one
node that is both a tool and a store sink (`classType: ["store", "tool"]`). These are
different products with different config surfaces, and the sink currently emits its
persisted-file references on the `documents` lane, which is the wrong lane for
plain-reference payloads. There is also no way to use the account file store as a
pipeline *source*.

## Decision

Keep one node folder and one shared driver; split the surface into three
`services*.json` variants (established multi-variant pattern: `webhook/`, `response/`).
All three live in `nodes/src/nodes/tool_filesystem/`.

### 1. `services.json` — "File System" (tool, reverted)

- Protocol `tool_filesystem://` unchanged; `classType: ["tool"]`; `lanes: {}`.
- Fields revert to the pre-#1651 surface: the six `allow*` toggles + `pathWhitelist`.
- Sink-only fields (`targetDir`, `emitUrl`, `urlExpiresIn`) removed.
- Description reverts to the tool-only wording.
- Existing tool pipelines keep working. Pipelines that wired lanes into the tool
  (PR merged one day before this design; none known) must switch to File Store.

### 2. `services.store.json` — "File Store" (sink)

- New protocol `filestore://`; title "File Store"; `classType: ["store"]`;
  `register: "filter"`.
- Input lanes: `documents`, `text`, `table`, `image`, `audio`, `video` (same as
  #1651). Output lane: `json` (changed from `documents`).
- Fields: `targetDir`, `emitUrl`, `urlExpiresIn`, `pathWhitelist`. No `allow*`
  toggles; no tool interface.
- Emission: one JSON ref per persisted file via `instance.writeJson(...)`:
  `{"path": "<store-relative path>", "url": "<signed url>"}` — `url` present only
  when `emitUrl` is on. The `chunkId` bookkeeping from `_sink_emit` drops; the JSON
  lane has no chunk semantics.

### 3. `services.source.json` — "File Store Source"

- New protocol `filestore_source://`; title "File Store Source";
  `classType: ["source"]`; `register: "endpoint"`; `capabilities: ["noinclude"]`
  (webhook/telegram source pattern).
- Fields:
  - `filesystem.path` (string) — file **or** folder, relative to the account store
    root `users/<client_id>/files/`. A folder processes every file directly in it.
  - `filesystem.recursive` (boolean, default `false`) — when the path is a folder,
    also descend into subfolders.
- New `IEndpoint.py` implements `scanObjects(path, callback)`: resolve the configured
  path against the account store, enumerate the single file or the folder's files
  (recursing when toggled), and feed each into the pipeline as a raw object so any
  downstream node (parse, etc.) can consume it — same shape as the local-filesystem
  (`filesys://`) source's output. Exact byte-delivery mechanics (engine-driven read
  vs. `send*` push) follow the existing python-source contract and are pinned during
  implementation planning (see open-questions.md).

## Driver changes (shared `IGlobal.py` / `IInstance.py`)

Minimal by design. Variant behavior is driven by what each services.json declares:
no lanes declared → no lane traffic reaches the instance; no `tool` classType → no
tool discovery. Code changes are limited to:

- `_sink_emit` rewritten to emit JSON refs on the `json` lane (`writeJson`).
- New `IEndpoint.py` for the source variant.
- Any variant gating that turns out to be necessary beyond services-declaration
  (verify during implementation; expectation is none).

## Error handling

- Source: empty configured path → `validateConfig` failure; nonexistent path →
  raises at `scanObjects` time (existence needs store access, which config-time
  validation doesn't have — see open-questions.md). Empty folder → clean
  zero-object run.
- Sink and tool: unchanged from #1651 behavior (path whitelist, size caps, media
  stream abort handling all stay).

## Testing

- Existing `nodes/test/tool_filesystem/` sink tests updated to assert json-lane refs
  instead of documents-lane `Doc`s.
- New source tests: single file, folder (non-recursive), folder + recursive.
- Tool surface: existing read-size-cap tests unchanged.
- Contract suite `./builder nodes:test` stays at 310+ passing.

## Docs

Co-located node doc updates ride in the same change (co-located documentation rule).

## Out of scope

- `pathWhitelist` on the source variant (the explicit `path` field already scopes it).
- Renaming the node folder (rename was proposed and reverted in #1651 review).
- Any change to the tool method surface or the file-store backend.

## Branch

Fresh branch off `develop`: `feat/filestore-node`.
