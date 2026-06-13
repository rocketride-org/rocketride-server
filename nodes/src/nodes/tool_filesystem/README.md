# tool_filesystem

A RocketRide tool node that gives an AI agent read/write access to the account-scoped RocketRide file store.

## What it does

Exposes the account file store, the same storage area the client SDK reaches via its
`fs_*` methods, to an agent as a set of callable tools. All paths are relative to
`users/<client_id>/files/`, so files written by the agent are visible to the client SDK
and vice versa. The account is resolved automatically from the `ROCKETRIDE_CLIENT_ID`
env var injected by the task engine, no account configuration is needed on the node.
If that env var is missing or the account store fails to initialise, a warning is logged
and **all** tool methods are hidden from the agent.

The node has no pipeline lanes: it is connected to agents via the `tool` invoke channel.

Every operation is gated by a per-operation allow toggle. Read, write, list, mkdir, and
stat are **on by default**; **delete is off by default**. Tools whose toggle is disabled
are hidden from the agent at discovery time (`tool.query`), not just blocked at
invocation. An optional regex path whitelist further restricts which paths any operation
may touch.

---

## Configuration


| Field | Type | Description |
|---|---|---|
| `allowRead` | boolean | Default true.  |
| `allowWrite` | boolean | Default true.  |
| `allowList` | boolean | Default true.  |
| `allowMkdir` | boolean | Default true.  |
| `allowStat` | boolean | Default true.  |
| `allowDelete` | boolean | Default false. Destructive, enable only when the agent is trusted to delete account files. |
| `whitelistPattern` | string | Default empty.  |
| `pathWhitelist` | array | Regex patterns applied to the relative path of every operation using re.search semantics, a partial match anywhere in the path is enough, so a pattern like 'secret' will also match 'notsecret/file.txt'. Anchor with ^ and $ if you need a full-path match (e.g. '^docs/.*$'). If non-empty, a path must match at least one pattern. If empty, all paths under users/<client_id>/files/ are allowed. |


### Path whitelist

If `pathWhitelist` is non-empty, the relative path of **every** operation must match at
least one pattern. Patterns use `re.search` semantics, a partial match anywhere in the
path is enough, so a pattern like `secret` will also match `notsecret/file.txt`. Anchor
with `^` and `$` if you need a full-path match (e.g. `^docs/.*$`).

Invalid regexes are skipped with a logged warning. An empty `path` on `list_directory`
means the account root and bypasses the whitelist check (an empty string can't match a
non-trivial regex).

---

## Available tools

Each tool is namespaced by the node id: e.g. an agent sees `tool_filesystem_1.read_file`.
Disabled tools are filtered out of discovery, and the allow-flag is re-checked at
invocation as defence-in-depth.

### Read & inspect


| Tool | Description |
|---|---|---|
| `read_file` | Read a file from the account file store and return its contents as a decoded string. Required: "path" (relative path). Optional: "encoding" (default "utf-8"), "maxBytes" (default 256 KB, max 4 MB). Returns: {path, content, size} where size is the byte length before decoding. Files larger than maxBytes are rejected. |
| `write_file` | Write (or overwrite) a file in the account file store. Required: "path", "content". Optional: "encoding" (default "utf-8"). Returns: {path, bytesWritten}. |
| `delete_file` | Delete a file from the account file store. Only available when the operator has enabled "allowDelete" on this node. Required: "path". Returns: {path, deleted: true}. |
| `list_directory` | List the immediate children of a directory in the account file store. Optional: "path" (defaults to the account root). Returns: {entries: [{name, type, size?, modified?}], count}. |
| `create_directory` | Create a directory in the account file store. Intermediate segments are created as needed. Required: "path". Returns: {path, created: true}. |
| `stat_file` | Get metadata for a file or directory in the account file store. Required: "path". Returns: {exists, type?, size?, modified?}. |


### Write

| Tool               | Description                                                          |
|--------------------|----------------------------------------------------------------------|
| `write_file`       | Create or overwrite a file with text content. Required: `path`, `content`. Optional: `encoding` (default `utf-8`). Returns `{path, bytesWritten}`. |
| `create_directory` | Create a directory; intermediate segments are created as needed. Required: `path`. Returns `{path, created: true}`. |

### Delete

| Tool          | Description                                                                |
|---------------|-----------------------------------------------------------------------------|
| `delete_file` | Delete a file. Only available when `allowDelete` is enabled. Required: `path`. Returns `{path, deleted: true}`. |

### Read size cap

`read_file` accepts `maxBytes` (default **256 KB**, hard ceiling **4 MB**). Files larger
than the cap are **rejected with an error**, not truncated, use a smaller `maxBytes`
for sampling, or split the file. The cap exists because the underlying store defaults to
100 MB per read, which could blow the agent's context window or OOM the engine
subprocess long before the LLM ever sees the result.

---

## Storage location

Files land under the configured storage backend (defaults to `~/.rocketlib/store/`). For
the default filesystem backend the absolute path is:

```text
<store>/users/<client_id>/files/<path>
```

Each account gets its own isolated `files/` directory, the node picks up the current
account automatically, no configuration needed.

---

## Running the tests

```bash
pytest nodes/test/tool_filesystem/test_read_size_cap.py -v
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
