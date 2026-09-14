# tool_notion

A RocketRide tool node that gives an agent read and write access to a Notion workspace: search it, read pages and database rows, and create, update, or append to pages. Pick it when an agent's knowledge or its output lives in Notion rather than in files or a database.

## About Notion

Notion is a workspace product that combines documents, wikis, and lightweight databases in one place. Its pages are built from nested blocks, and its databases hold rows that are themselves pages with typed properties. Teams use it for notes, specs, and project tracking.

## What it does

The node has no data lanes; it exists only as an agent tool server, exposing eight Notion operations. An agent typically searches for a page or database id first, then reads properties or body text, and optionally writes back — creating a sub-page or database row, updating property values, or appending paragraphs. Pick it over a generic HTTP tool when you want Notion's block tree flattened into readable text and its database/data-source split handled for you.

Notion's current API splits what older documentation calls a "database" into a **database** (the container: title, parent, and a list of data sources) and a **data source** (the thing whose rows you query). This node targets that shape. Tools that take a `database_id` resolve it to a data source automatically when the database has exactly one, and need an explicit `data_source_id` only when there is more than one.

## As a tool

The server-name prefix is `notion`, producing these registered functions.

| Function | Description |
|---|---|
| `notion_search` | Search the workspace by title text across pages and databases the integration has been shared with. Use it to find an id before reading or writing. |
| `notion_get_database` | Return a database's title and its data sources (id and name). |
| `notion_query_database` | Query a database's rows with an optional Notion filter and sorts. |
| `notion_get_page` | Return a page's properties, `url`, and `in_trash` flag — not its body. |
| `notion_get_page_content` | Return a page's body as flattened plain text. |
| `notion_create_page` | Create a sub-page under a page, or a new row under a data source, with optional initial body text. |
| `notion_update_page` | Update a page's property values and/or move it to or from trash. |
| `notion_append_content` | Append text to the end of a page's or block's body, one paragraph per line. |

Every function returns `success`, plus its own fields on success (`results`/`has_more`/`next_cursor` for the two listing calls, `text` for page content, `page_id` and `url` for creation, `appended` for the append) and `error` on failure. Notion API failures are returned in that envelope rather than raised.

`notion_search` accepts `query`, an optional `filter_type` of `page` or `data_source`, and `page_size`. `notion_query_database` requires `database_id` and accepts `data_source_id`, `filter`, `sorts`, `page_size`, and `start_cursor`; page sizes are clamped to 1–100. `notion_get_page_content` requires `page_id` and accepts `max_depth` (default 4). `notion_create_page` requires `parent_id` and a `parent_type` of `page` or `data_source`, and accepts `title`, `properties`, and `content`. `notion_update_page` requires `page_id` and at least one of `properties` or `in_trash`. `notion_append_content` requires `block_id` and non-empty `text`.

Property values in `filter`, and in the `properties` of the two write calls, use Notion's own typed property-value shape (for example `{"Status": {"select": {"name": "Done"}}}`) and are passed through unchanged.

## Configuration

The node has a single field: the integration secret it authenticates with. There is nothing else to tune — everything an agent varies is a tool argument, not configuration.

### API Key

The Notion internal integration secret. It is stored encrypted and masked in the UI. Leave it empty only if you set `NOTION_API_KEY` on the engine host instead; the config field wins when both are present, and startup fails when neither yields a value.

## Authentication

Create an internal integration at <https://www.notion.so/my-integrations> and paste its secret into **API Key**, or set `NOTION_API_KEY` on the engine host. The key is sent as an `Authorization: Bearer` header.

Access is granted per page, not per scope: an integration sees only the pages and databases explicitly shared with it from a page's connection menu, and sharing a page also shares everything nested beneath it. A search that returns nothing usually means nothing has been shared yet.

## Notes

### Experimental

The node is marked `experimental`. Its request and response shapes are read from Notion's own API reference, but no live workspace has exercised it end to end, so the surface may change.

### Reading page content

A page's body is a block tree, not text. `notion_get_page_content` walks that tree and emits one line per block, indenting nested content (a toggle's children, a nested bullet) up to `max_depth` levels. Blocks with no text of their own — dividers, images, tables — contribute nothing rather than being guessed at. Raise `max_depth` for deeply nested pages; the default of 4 covers ordinary documents.

### Titles on new database rows

A database's title property is not always called "Name". When `notion_create_page` is given a `title` for a `data_source` parent and the caller's `properties` does not already name a title field, the node looks the real key up from the data source's schema. Supply the title inside `properties` yourself if you want to bypass that lookup.

### Retries and duplicate writes

Reads time out after 30 seconds and retry up to three times with exponential backoff on connection errors, rate limits (honoring `Retry-After` when it is longer than the computed delay), and 5xx responses. The three write functions are never retried, because Notion offers no idempotency key and a retried mutation could duplicate a page or its content — an agent that sees a connection error on a write should check the target before trying again.

### Request limits

`notion_append_content` sends at most 100 blocks per request, batching longer input. A line over 2000 characters is rejected outright rather than truncated, matching Notion's rich-text limit; shorten the line and retry.

## Upstream docs

- [Notion API reference](https://developers.notion.com/reference/intro)
- [Notion request limits](https://developers.notion.com/reference/request-limits)

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
