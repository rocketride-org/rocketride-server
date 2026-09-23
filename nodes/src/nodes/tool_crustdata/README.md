# tool_crustdata

A RocketRide tool node that gives an agent filter-based search over Crustdata's B2B company and people index. Pick it when an agent needs to discover accounts or contacts matching criteria, rather than to look up one company or person it already knows.

## About Crustdata

Crustdata is a B2B data provider that maintains an indexed database of companies and people — firmographics, funding, headcount and hiring signals on the company side; work history, education and contact details on the people side. It sells access through a REST API aimed at sales, recruiting and market-research teams rather than through an application of its own.

## What it does

The node has no data lanes and exposes two search functions to an agent: one over Crustdata's company index, one over its people index. Each takes filter conditions, wraps them into the `{op, conditions}` group form Crustdata's API expects, and returns the records the service sends back. Person search also supports bounded `all_of` groups over nested arrays such as employment history. Results are cursor-paginated, and callers can project the returned record with `fields`. Prefer this node over a generic HTTP tool when an agent needs Crustdata's filter grammar, limits and pagination already handled; reach for a web-search or scraping node instead when the target is open-web content rather than an indexed B2B record.

The node is marked `experimental`. Its request and response shapes are read from Crustdata's published API reference, but no live account has exercised it end to end — see `## Notes`.

## As a tool

The server-name prefix is `crustdata`, producing these registered functions.

| Function | Description |
|---|---|
| `crustdata.company_search` | Search Crustdata for companies matching one or more filters (industry, region, headcount, funding, current company, and more). Returns structured company records: firmographics, funding history, headcount, and hiring signals. Use it to find prospects or research accounts by criteria, not to look up one already-known company by name. |
| `crustdata.person_search` | Search Crustdata for people matching one or more filters (current company, current title, region, and more). Returns structured profiles: name, title, work history, education, and verified contact info where available. Use it to find or enrich people by criteria. |

Both functions require `filters`, a non-empty array whose ordinary conditions have `{field, type, value}`. `field` is a dotted path such as `basic_info.primary_domain` (company) or `experience.employment_details.current.title` (person). Company operators are `=`, `!=`, `<`, `=<`, `>`, `=>`, `in`, `not_in`, `is_null`, `is_not_null`, `(.)` (fuzzy all-words with typo tolerance), `[.]` (exact phrase), `geo_distance`, and `geo_exclude`. Person search additionally exposes `has_all` and `(!)`; its `(.)` match is all-words without typo tolerance. Note `=<` and `=>` rather than `<=` and `>=`, and that the geo operators take a `{location, distance, unit}` object as their `value`.

Person `filters` may also contain an `{"op": "all_of", "conditions": [...]}` group. Each direct child may match a different element of the nested array. To require several predicates on the same element, wrap them in one `and` or `or` subgroup inside `all_of`; for example, put title and company-name conditions in an `and` subgroup to bind both to one employment entry. Nested `all_of`, `has_all`, `(!)`, `!=`, `not_in`, `is_null`, and `geo_exclude` are not supported inside it.

The optional arguments are `match` (`and` or `or`, defaulting to `and`), `sorts` (an array of `{field, order}` objects, `order` being `asc` or `desc`), `fields` (a non-empty array of sections or dotted paths to return), `limit` (1–1000, defaulting to the node's configured Default Result Limit), and `cursor` (a `next_cursor` from an earlier call; omit it for the first page). Omitting `fields`, or passing it as `null`, returns the full company record for company search and Crustdata's default sections for person search. Returned fields and searchable fields are separate vendor-defined sets, so unsupported projections are left for the API to reject.

Every call returns an object carrying `success`, `filters` (the conditions echoed back), `count`, and `results` — the Crustdata records passed through as received, with no per-record remapping. `next_cursor` and `total_count` are added when Crustdata's response includes them. Missing or empty `filters`, a failed request, and a non-JSON response body all come back as `success: false` with an `error` string; the agent sees a failure as data rather than as a raised exception.

## Configuration

Two fields: the API key and a default result limit. Supply the key (or its environment fallback) and leave the limit alone unless agents routinely need larger pages.

### API Key

Required. The node reads it from this field, falling back to the `CRUSTDATA_API_KEY` environment variable; if neither supplies a value the node fails to start. See `## Authentication`.

### Default Result Limit

The `limit` applied to any search where the agent does not pass one of its own. It defaults to 10 and accepts 1–1000; a value outside that range is clamped into it, and a non-numeric value falls back to 10. An agent's per-call `limit` overrides it and is clamped the same way, falling back to this configured value when it cannot be read as a number.

Keep it small when responses feed straight into an agent's context — raw Crustdata records are wide, and a large page burns tokens quickly. Raise it when an agent sweeps broad filters and would otherwise have to paginate repeatedly; beyond the limit, an agent can page through the rest with `cursor` instead.

## Authentication

The node needs a Crustdata API key, issued from <https://crustdata.com>. Put it in the **API Key** field, where it is encrypted at rest and masked in the UI, or set `CRUSTDATA_API_KEY` on the engine host; the configured field wins when both are present. The key is sent as an `Authorization: Bearer <key>` header, alongside the `x-api-version: 2025-11-01` header that every request to this API carries.

## Notes

### Experimental status

The endpoints, condition schema and cursor pagination implemented here come from Crustdata's own versioned API reference rather than from a live integration. What is not verified: the complete searchable-field list for each entity, and whether a given key's plan includes the real-time variants Crustdata also advertises alongside its indexed search. Tracked as [issue #2129](https://github.com/rocketride-org/rocketride-server/issues/2129).

### Pagination

Pass a response's `next_cursor` back as the next call's `cursor`. For company search, keep `filters`, `sorts`, and `fields` identical across pages. For person search, keep `filters` and `sorts` identical; Crustdata permits `fields` and `limit` to change between pages. An explicit `sorts` is worth passing whenever an agent intends to paginate.

### Why `match` has only two values

`match` accepts `and` or `or`, and anything else is treated as `and`. Person search's `all_of` is not a top-level general combinator: it constrains its children to predicates on a nested-array path such as employment or education. It is therefore exposed only as a bounded group inside `filters`, never as a `match` value.

### Request handling

Calls go out through `requests`; no Crustdata SDK is used. Each request times out after 30 seconds and is retried with exponential backoff (up to four attempts) on timeouts, connection errors, HTTP 429 and 5xx responses. Other 4xx responses fail immediately without a retry.

## Upstream docs

- [Crustdata company search reference](https://docs.crustdata.com/company-docs/search/reference)
- [Crustdata person search reference](https://docs.crustdata.com/person-docs/search/reference)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_crustdata.apikey` | `string` | **API Key**<br/>Crustdata API key (from https://crustdata.com) | `""` |
| `tool_crustdata.defaultLimit` | `integer` | **Default Result Limit**<br/>Default maximum number of results per search (1-1000) | `10` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_crustdata)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
