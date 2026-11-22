# tool_firecrawl

A RocketRide tool node that lets an AI agent search the web, scrape a known web page, or discover URLs on a site through Firecrawl.

## About Firecrawl

Firecrawl is a web-data service for searching, retrieving, and structuring website content. It is
used to find relevant web pages, turn web pages into agent-ready content, and discover a site's linked pages.

## What it does

This node exposes Firecrawl only as an agent tool and has no pipeline lanes. It provides one
web-search operation (`search_web`), one single-page scrape operation (`scrape_url`), and one
URL-map operation (`map_url`).

## As a tool

The tool server prefix is `firecrawl` by default. It registers these functions:

| Function | Description |
| --- | --- |
| `firecrawl.search_web` | Searches the web and returns matching results with optional scraped Markdown. |
| `firecrawl.scrape_url` | Scrapes one URL and returns its content and metadata. |
| `firecrawl.map_url` | Maps a site from a root URL and returns discovered links. |

`search_web` requires a non-empty `query` and accepts optional `limit` (1–20, defaulting to
the configured **Max Results**) and `scrape_markdown` (`false` by default). It returns
`{success, results}` where each item includes `url`, `title`, `description`, and `markdown`
when requested.

`scrape_url` and `map_url` require a truthy `url`. `scrape_url` accepts `format` of `markdown`
(default) or `html` and requests that format from Firecrawl; after scraping, the node selects
that attribute from the response, then falls back to Markdown and finally an empty string. Its
successful result is `{success, content, metadata}`; non-string content is JSON-encoded.
`map_url` returns `{success, links}`, retaining string links and URL fields from returned link
objects.

Invalid input and Firecrawl errors raise tool errors rather than returning an error
object. This lets the agent distinguish an empty successful response from a failed request.

## Configuration

Configure the API key and the default maximum number of search results. Per-call arguments on
`search_web` and `scrape_url` override the defaults when needed.

### API Key

Provide a non-empty key before starting the pipeline. Startup fails if it is absent, and
the configured key is the only credential source used by this node.

### Max Results

Sets the default number of results returned by `search_web` (1–20, default 5). Individual
`search_web` calls can override this value via the `limit` parameter.

## Authentication

Set **API Key** to a Firecrawl API key. The key is passed when the node creates its
`FirecrawlApp` client.

## Notes

### Retry behavior

The wrapper retries a matching rate-limit error indefinitely, waiting five seconds each
time. Recognized 5xx errors retry at most five times with the same delay; other errors
propagate immediately.

## Upstream docs

- [Firecrawl documentation](https://docs.firecrawl.dev)

<!-- Legacy pre-schema prose retained below only while the generated documentation is preserved. -->

### What it does

Gives an agent the ability to scrape web pages and map website structures using the
Firecrawl API. Useful for agents that need to read live web content or discover URLs
across a site.

Uses the **firecrawl-py** SDK (`FirecrawlApp`). The client is created once when the
pipeline starts; a non-empty `apikey` is required or startup fails.

All Firecrawl calls are wrapped with automatic retry handling: rate-limit responses
(HTTP 429) are retried indefinitely with a 5-second sleep between attempts, and server
errors (HTTP 5xx) are retried up to 5 times with the same delay before the error is
raised.

---

### Configuration


| Field | Type | Description |
|---|---|---|
| `apikey` | string | Default empty. Firecrawl API key |


The node ships a single `default` profile. It has no lanes; it registers as a tool
provider and is invoked by an agent node, not wired into data lanes.

---

### Available tools

Tools are registered under the `firecrawl` prefix.

### scrape_url

Scrape a single web page and return its content.


| Tool | Description |
|---|---|---|
| `scrape_url` | Scrape a single web page and return its content. |
| `map_url` | Map a website's structure and return all discovered URLs. |


Returns `{ success, content, metadata }`. If the requested format is unavailable in the
Firecrawl response, the node falls back to `markdown` content; non-string content is
JSON-encoded.

### map_url

Map a website's structure and return all discovered URLs.

| Parameter | Required | Description       |
|-----------|----------|-------------------|
| `url`     | yes      | Root URL to map   |

Returns `{ success, links }` where `links` is an array of discovered URL strings.

---

### Authentication

Set `apikey` to a Firecrawl API key (created at [firecrawl.dev](https://www.firecrawl.dev)).
The key is passed directly to `FirecrawlApp`, no other credentials are needed.

---

### Upstream docs

- [Firecrawl documentation](https://docs.firecrawl.dev)

---

-->

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_firecrawl.apikey` | `string` | **API Key**<br/>Firecrawl API key | `""` |
| `tool_firecrawl.maxResults` | `integer` | **Max Results**<br/>Maximum number of search results to return (1-20) | `5` |

## Dependencies

- `firecrawl-py`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_firecrawl)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
