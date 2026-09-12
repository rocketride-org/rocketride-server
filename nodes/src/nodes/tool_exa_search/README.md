# tool_exa_search

A RocketRide tool node that gives an AI agent live semantic web search through Exa when it needs fresher or broader results than its built-in knowledge.

## About Exa

Exa is a search product built for finding and retrieving web content. It is known for
semantic search, which matches a query by meaning as well as by keywords.

## What it does

This node exposes Exa search only as an agent tool; it has no pipeline lanes. Choose it
when an agent needs focused web research with domain or publication-date filters, rather
than page extraction from a URL it already knows. Each search returns compact result
metadata and can include retrieved text.

## As a tool

The tool server prefix is `exa` by default. It registers exactly one function:

| Function | Description |
| --- | --- |
| `exa.exa_search` | Searches Exa for web pages matching a natural-language or keyword query. |

`query` is required and must be non-empty. Optional `num_results` is clamped to 1–50;
`type` accepts `auto`, `neural`, or `keyword`; `use_autoprompt` and `include_text`
override the node defaults. Calls may also pass domain include/exclude lists and ISO 8601
start/end publication dates.

On success the function returns `success`, the query, the number returned, and result
objects containing title, URL, score, publication date, author, and text when available.
A blank query or an HTTP failure returns `success: false`, an empty result list, and an
error message instead of raising an exception.

## Configuration

Configure the API key first, then use the remaining values as sensible defaults for tool
calls. An agent can override the result count, search type, autoprompt choice, and text
inclusion on an individual search.

### Number of Results

The default is 10 and the accepted range is 1–50. Raise it when a broad comparison needs
more candidates; lower it when the agent only needs the most likely sources and should
avoid spending context on a long result list.

### Search Type

`auto` is the default. Use `neural` for concept-oriented questions and `keyword` when
exact terms matter. An unsupported per-call value falls back to `auto`, so use one of the
three accepted values when a particular retrieval style is required.

### Autoprompt and text content

Autoprompt and full text both default to enabled. Keep autoprompt on when the query can
benefit from Exa's query optimization; turn it off when the agent must preserve an exact
phrase. Keep text on when the agent needs material to read, but turn it off for lightweight
URL discovery because returned text can substantially enlarge the result payload.

## Authentication

Set **API Key**, or provide `EXA_API_KEY` on the engine host when the field is empty. A
key is required at startup and is sent in the `x-api-key` header for each search.

## Notes

### Retries

Requests use a 30-second timeout. Rate limits, server errors, and timeouts retry up to
three times with 2-, 4-, and 8-second waits before the failure is returned to the agent.

## Upstream docs

- [Exa documentation](https://docs.exa.ai)

<!-- Legacy pre-schema prose retained below only while the generated documentation is preserved. -->

> Experimental: this node is marked `experimental` and may change.

### What it does

When an agent calls the `exa_search` tool, the node runs a real-time search against the
Exa `/search` REST API and hands back structured results: title, URL, text content,
relevance score, published date, and author.

Implemented with the **requests** library, no Exa SDK is used. Requests time out after
30 seconds and are retried up to 3 times with exponential backoff (2 s base delay) on
rate limits (HTTP 429), server errors (5xx), and timeouts. Failures are returned to the
agent as a structured `{"success": false, "error": ...}` result rather than raised.

The node has no pipeline lanes (`lanes` is `{}`). Only agent runtimes reach it, through
the `invoke` capability.

---

### Configuration


| Field | Type | Description |
|---|---|---|
| `apikey` | string | Default empty. Exa API key (from https://exa.ai) |
| `numResults` | integer | Default 10. Maximum number of search results to return (1-50) |
| `useAutoprompt` | boolean | Default true. Let Exa optimize the query for better results |
| `searchType` | string | Default "auto". Type of search to perform |
| `includeText` | boolean | Default true. Include full text content in results |


The config values act as defaults, the agent can override `num_results`, `type`,
`use_autoprompt`, and `include_text` per call.

---

### Available tools

### `exa_search`

Search the web using Exa semantic search. `query` is the only required parameter.


| Tool | Description |
|---|---|---|
| `exa_search` | Search the web using Exa semantic search. Provide a natural language query to find relevant web pages. Returns structured results with title, URL, text content, relevance score, and published date. |


Returns an object with `success`, `query`, `num_results`, `results` (array of
`{title, url, score, published_date, author, text?}`, `text` only when content was
requested and returned), and `error` on failure.

---

### Authentication

Drop your Exa API key into the **API Key** config field (grab one at https://exa.ai).
The field is encrypted at rest and masked in the UI. Alternatively, set the
`EXA_API_KEY` environment variable on the engine host, the config field takes
precedence when both are set. The key is sent to the Exa API in the `x-api-key`
request header.

---

-->

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_exa_search.apikey` | `string` | **API Key**<br/>Exa API key (from https://exa.ai) | `""` |
| `tool_exa_search.includeText` | `boolean` | **Include Text Content**<br/>Include full text content in results | `true` |
| `tool_exa_search.numResults` | `integer` | **Number of Results**<br/>Maximum number of search results to return (1-50) | `10` |
| `tool_exa_search.searchType` | `string` | **Search Type**<br/>Type of search to perform | `"auto"` |
| `tool_exa_search.useAutoprompt` | `boolean` | **Use Autoprompt**<br/>Let Exa optimize the query for better results | `true` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_exa_search)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
