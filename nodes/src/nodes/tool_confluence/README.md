# tool_confluence

A RocketRide tool node that gives an agent access to Confluence Cloud: search with CQL, read a page as plain text, and create or update pages. Pick it when an agent's knowledge or output lives in a Confluence wiki.

## About Confluence

Confluence is Atlassian's team wiki. Content lives in spaces (identified by a key such as `ENG`) and is stored as pages in an XHTML "storage format". Pages are versioned, and every update must submit the next version number.

## What it does

The node has no data lanes; it exists only as an agent tool server, exposing four operations. An agent typically searches with CQL to find a page id, reads the page, and optionally writes back by creating a page or replacing a page's body.

## As a tool

The server-name prefix is `confluence`.

| Function | Description |
|---|---|
| `confluence_search` | Run a CQL query (`cql`, optional `limit` 1–100 and `start`); returns id, type, title, space, url and excerpt per hit. |
| `confluence_get_page` | Return a page's title, space id, current version and body flattened to plain text. |
| `confluence_create_page` | Create a page from `title`, `space_key` (or `space_id`), optional `parent_id` and `content`. |
| `confluence_update_page` | Change a page's `title` and/or replace its whole body; the current version is fetched and incremented for you. |

Every function returns `success` plus its own fields, and `error` on failure; API failures are returned in that envelope, not raised. `content` is plain text by default (blank line = new paragraph, HTML-escaped); pass `content_format: "storage"` to send storage-format XHTML unchanged. Update replaces the entire body, so read the page first to edit it. Search uses the v1 CQL endpoint; page operations use the v2 API.

## Configuration

| Field | Description |
|---|---|
| Site URL | Base URL including `/wiki`, e.g. `https://your-site.atlassian.net/wiki` (env `CONFLUENCE_BASE_URL`). |
| Account Email | Email of the Atlassian account owning the token (env `CONFLUENCE_EMAIL`). |
| API Token | Token from <https://id.atlassian.com/manage-profile/security/api-tokens> (env `CONFLUENCE_API_TOKEN`). Stored encrypted. |

The account's own Confluence permissions bound what the agent can read or write. The node is marked `experimental`: it has been tested against faked HTTP only, not a live site.
