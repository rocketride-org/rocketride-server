# tool_notion

A RocketRide tool node that gives an AI agent read/write access to a
[Notion](https://notion.so) workspace: search, read pages and database rows, and
create or update content.

> Experimental: this node is marked `experimental` and may change. The endpoints and
> request/response shapes here are read directly from Notion's own API reference
> (`Notion-Version: 2026-03-11`), but no live workspace has exercised it end-to-end.

## What it does

Notion's 2025-09-03 API version split what older docs call a "database" into two
concepts: a **database** (the container — title, parent, and a list of data sources)
and a **data source** (the thing you actually query for rows). This node targets that
current shape. Most tools that take a `database_id` resolve it to a data source
automatically — if the database has exactly one, which is the common case — and only
need an explicit `data_source_id` when there's more than one to disambiguate.

Page content (the body under a page's title) is stored as a tree of blocks, not plain
text. `notion_get_page_content` walks that tree and flattens it into one line of plain
text per block, indenting nested blocks (a toggle's contents, a nested bullet) up to a
configurable depth. Block types with no text of their own (dividers, images, tables,
...) are silently skipped rather than guessed at.

A new page's title property key must match its parent's schema — a database's title
column isn't always called "Name" (e.g. it might be "Task"). `notion_create_page`
looks the real key up from the data source's schema rather than guessing, when the
parent is a database row and the caller didn't already supply one in `properties`.

Implemented with the **requests** library, no Notion SDK is used. Read requests time
out after 30 seconds and are retried up to 3 times with exponential backoff (2 s base
delay) on connection errors, rate limits (HTTP 429, honoring Notion's `Retry-After`
header when present), and server errors (5xx). Writes (`notion_create_page`,
`notion_update_page`, `notion_append_content`) are never retried: Notion has no
idempotency key for these endpoints, so retrying a mutation whose response was lost to
a connection error risks creating a duplicate page or duplicate content. Failures are
returned to the agent as a structured `{"success": false, "error": ...}` result rather
than raised.

`notion_append_content` batches into groups of at most 100 blocks per request and
rejects (rather than silently truncating) any line over 2000 characters, matching
Notion's documented request limits.

The node has no pipeline lanes (`lanes` is `{}`). Only agent runtimes reach it, through
the `invoke` capability.

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `apikey` | string | Default empty. Notion internal integration secret (from https://www.notion.so/my-integrations) |

An integration only sees pages and databases it has been explicitly shared with inside
Notion — sharing a page also shares everything nested under it.

---

## Available tools

| Tool | Description |
|---|---|
| `notion_search` | Search the workspace by title text across pages and databases the integration can see. Use this to find a page or database id before reading or writing it. |
| `notion_get_database` | Get a database's title and its data sources (id + name). |
| `notion_query_database` | Query a database's rows, with an optional Notion filter/sort object. |
| `notion_get_page` | Get a page's properties (its database row values, if any) and metadata — not its body content. |
| `notion_get_page_content` | Get a page's body as flattened plain text. |
| `notion_create_page` | Create a page, either as a sub-page under another page or as a new row in a database, with optional initial body text. |
| `notion_update_page` | Update a page's property values and/or move it to/from trash. |
| `notion_append_content` | Append text to the end of a page's (or block's) body, one paragraph per line. |

All eight return `success` plus tool-specific fields, and `error` on failure — see each
tool's schema for exact shapes. Property values (in `notion_query_database` filters,
`notion_create_page`/`notion_update_page` properties) use Notion's own typed property
value shape (e.g. `{"Status": {"select": {"name": "Done"}}}`); this node passes them
through as-is rather than reinventing a simplified format.

---

## Authentication

Drop your Notion internal integration secret into the **API Key** config field. The
field is encrypted at rest and masked in the UI. Alternatively, set the
`NOTION_API_KEY` environment variable on the engine host — the config field takes
precedence when both are set. The key is sent to Notion as `Authorization: Bearer
<key>`, alongside a required `Notion-Version: 2026-03-11` header on every request.

Create an integration secret at https://www.notion.so/my-integrations, then share each
page or database it should access from that page's "..." menu → Connections.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_notion.apikey` | `string` | **API Key**<br/>Notion internal integration secret (from https://www.notion.so/my-integrations) | `""` |

## Dependencies

- `requests` `>=2.34.2`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_notion)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
