# tool_filesystem

One node directory providing three RocketRide services — an agent file tool, a pipeline sink, and a pipeline source — all backed by the account-scoped RocketRide file store.

## What it does

All three services operate on RocketRide file storage — the account-scoped store used
by the platform and its client SDK `fs_*` methods. All paths are plain and relative to
the task's **storage anchor**, which the task file provides: the owning user's file
tree (`users/<client_id>/files/`) for development runs, or a task-specific subtree of
the deployment team's storage (`teams/<teamId>/files/tasks/<projectId>/`) for deployed
runs. Files written here are visible in the file browser and vice versa, and node
behavior is identical in both modes. Identity and the anchor are resolved
automatically from the running task (`rocketlib.getTask()`), never from the
environment; no account configuration is needed on any of the three services.

Three services share this node's code:

| Service | Protocol | Role |
|---|---|---|
| **File System** | `tool_filesystem://` | agent tool — read/write/delete/list/mkdir/stat |
| **File Store** | `filestore://` | pipeline sink — persist lane data to the store |
| **File Store Source** | `filestore_source://` | pipeline source — stream stored files into a pipeline |

Choose **File System** when an agent must read or produce files that should remain
available in the account file store. Choose **File Store** when a pipeline needs to
persist lane data there, and **File Store Source** when stored files should feed a
pipeline — it is a finite source: the task completes once the configured path has been
fully scanned, not a long-running server.

## Lanes

File Store (`filestore://`), the pipeline sink:

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | `json` | Persist each document's `page_content` (parsed text, always `.txt`); emit one reference per document. |
| `text` | `json` | Persist as Markdown (`.md`); emit a reference. |
| `table` | `json` | Persist the table as Markdown (`.md`); emit a reference. |
| `image` | `json` | Stream chunks to the store, commit on end; emit a reference. |
| `audio` | `json` | Stream chunks to the store, commit on end; emit a reference. |
| `video` | `json` | Stream chunks to the store, commit on end; emit a reference. |

File Store Source (`filestore_source://`), the pipeline source:

| Lane in | Lane out | Description |
| --- | --- | --- |
| `_source` | `tags` | Read each scanned file in full and send it as a raw object for a downstream parser. |

## As a tool

The File System service exposes the account file store to an agent as a set of
callable tools, namespaced by the node id (an agent sees `tool_filesystem_1.read_file`).
If no task identity is available or the account store fails to initialise, a warning is
logged and **all** tool methods are hidden from the agent.

Every operation is gated by a per-operation allow toggle. Read, write, list, mkdir, and
stat are **on by default**; **delete is off by default**. Tools whose toggle is disabled
are hidden from the agent at discovery time (`tool.query`), not just blocked at
invocation, and the allow-flag is re-checked at invocation as defence-in-depth.

| Tool | Description |
|---|---|
| `read_file` | Read a file and return its contents as a decoded string. Required: `path`. Optional: `encoding` (default `utf-8`), `maxBytes` (default 256 KB, max 4 MB). Returns `{path, content, size}`; files larger than `maxBytes` are rejected. |
| `list_directory` | List the immediate children of a directory. Optional: `path` (defaults to the account root). Returns `{entries: [{name, type, size?, modified?}], count}`. |
| `stat_file` | Get metadata for a file or directory. Required: `path`. Returns `{exists, type?, size?, modified?}`. |
| `write_file` | Create or overwrite a file with text content. Required: `path`, `content`. Optional: `encoding` (default `utf-8`). Returns `{path, bytesWritten}`. |
| `create_directory` | Create a directory; intermediate segments are created as needed. Required: `path`. Returns `{path, created: true}`. |
| `delete_file` | Delete a file. Only available when `allowDelete` is enabled. Required: `path`. Returns `{path, deleted: true}`. |

## Configuration

### File System (`tool_filesystem://`)

Leave the allow toggles at their defaults unless the pipeline calls for less: disable
write access for read-only analysis agents, and enable `allowDelete` only when the
agent is trusted to delete account files.

**Path Whitelist** (`pathWhitelist`): if non-empty, the relative path of **every**
operation must match at least one pattern. Patterns use `re.search` semantics — a
partial match anywhere in the path is enough, so a pattern like `secret` also matches
`notsecret/file.txt`. Anchor with `^` and `$` for a full-path match (e.g. `^docs/.*$`).
Invalid regexes are skipped with a logged warning. An empty `path` on `list_directory`
means the account root and bypasses the whitelist check (an empty string can't match a
non-trivial regex).

**Read size cap**: `read_file` accepts `maxBytes` (default **256 KB**, hard ceiling
**4 MB**). Files larger than the cap are **rejected with an error**, not truncated —
use a smaller `maxBytes` for sampling, or split the file. The cap exists because the
underlying store defaults to 100 MB per read, which could blow the agent's context
window or OOM the engine subprocess long before the LLM ever sees the result.

### File Store (`filestore://`)

**Where it writes**: **Target directory** (`targetDir`, default `output/`) + the
object's original name stem, with the lane's extension rule applied — e.g.
`output/report.txt` (nameless inputs fall back to the object id). When one object
emits several documents they also carry an index (`report_0.txt`, `report_1.txt`, …).
Each lane owns its extension rule, keyed to what the lane actually carries:
`text`/`table` carry markdown, so they always store `.md`; `documents` carries parsed
text (`page_content`), so it always stores `.txt` — a parsed `report.pdf` stores as
`report.txt`, keeping the extension truthful about the bytes; media derive it from the
stream's mime type, then the source extension, then `.bin`.

**When the file already exists** (`onConflict`, default `unique`): with `unique` the
sink appends `_1`, `_2`, …, giving up with an error after 100 attempts rather than
probing indefinitely. With `skip` it leaves the existing file alone, logs a warning,
and emits no reference for it. With `overwrite` it replaces the file — and skips the
existence probe entirely, which also saves a store round-trip per stream.
**`overwrite` can lose data**: filenames derive from the source object's *basename*,
so two inputs at `a/1.jpg` and `b/1.jpg` both resolve to the same target in a flat
`targetDir` and the second silently replaces the first — `unique` stays the default
for exactly that reason. A streamed write that is cut off part-way never leaves a
partial file behind: under `unique` and `skip` the sink deletes what it wrote; under
`overwrite` the stream goes to a `.part-<objectId>` sibling and only replaces the
target once complete, so an interrupted run leaves the existing file exactly as it
was. `skip` compares against an existing **file** — a directory sharing the name does
not by itself cause a skip.

**What it emits**: on the `json` lane, one `{path, url?}` object per persisted file —
`path` is the store-relative path; `url` is a time-limited signed download URL, only
present when **Emit download URL** (`emitUrl`) is on. Plain JSON, no Doc/chunkId
metadata. The signed URL is minted server-side via the store's `get_url` (no agent
`task.store` permission needed); **URL expiry (seconds)** (`urlExpiresIn`, default
3600, max 3600) sets its TTL.

**Guards**: the sink honours the account's `allowWrite` setting and the same path
whitelist as the File System tool's `write_file`. Every candidate path is
whitelist-checked *before* it is probed, so a path the whitelist would reject never
reveals whether files exist in the store. Media chunks stream straight to the store,
so memory stays bounded regardless of file size; the file is created only once the
first non-empty chunk arrives — an empty stream writes nothing.

### File Store Source (`filestore_source://`)

**Path** (`path`, required): file or folder to process, relative to the account file
store root. If it resolves to a file, only that file is streamed; a folder streams
every file directly inside it, and with **Recursive** (`recursive`, default off)
subfolders are descended too (breadth-first). A `path` that doesn't exist in the store
fails the task.

The scan reports each file to the engine (name + size), which queues it and calls back
into the node to render it: the file is read in full and sent downstream as a raw
object for a parser node to interpret (the parser sniffs the file type from the
extension in the entry name). Because delivery rides the engine's scan/render
contract, per-object completed/failed accounting and the task exit code are handled by
the engine — a successful run ends with exit code 0. A file that cannot be read
(including one over the store's default 100 MB per-read cap) is **marked failed with a
warning**; the scan continues with the remaining files, and the failure is reflected
in the task's failed-object count.

## Notes

### Storage location

Files land under the configured storage backend (defaults to `~/.rocketlib/store/`).
For the default filesystem backend the absolute path is the task's storage anchor
plus the relative path:

```text
<store>/users/<client_id>/files/<path>                    # development runs
<store>/teams/<teamId>/files/tasks/<projectId>/<path>     # deployed runs
```

The anchor comes from the task file the engine wrote at spawn; the node picks up
the current task automatically, no configuration needed.

### Running the tests

```bash
pytest nodes/test/tool_filesystem/ -v
```

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `filesystem.allowDelete` | `boolean` | **Delete files**<br/>Destructive: enable only when the agent is trusted to delete account files. | `false` |
| `filesystem.allowList` | `boolean` | **List directories** | `true` |
| `filesystem.allowMkdir` | `boolean` | **Create directories** | `true` |
| `filesystem.allowRead` | `boolean` | **Read files** | `true` |
| `filesystem.allowStat` | `boolean` | **Stat (metadata)** | `true` |
| `filesystem.allowWrite` | `boolean` | **Write files** | `true` |
| `filesystem.pathWhitelist` | `array` | **Path Whitelist**<br/>Regex patterns applied to the relative path of every operation using re.search semantics: a partial match anywhere in the path is enough, so a pattern like 'secret' will also match 'notsecret/file.txt'. Anchor with ^ and $ if you need a full-path match (e.g. '^docs/.*$'). If non-empty, a path must match at least one pattern. If empty, all paths under users/<client_id>/files/ are allowed. |  |
| `filesystem.whitelistPattern` | `string` | **Path Pattern (regex)** | `""` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_filesystem)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
