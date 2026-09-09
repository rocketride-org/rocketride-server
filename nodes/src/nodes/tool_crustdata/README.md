# tool_crustdata

A RocketRide tool node that gives an agent filter-based search over Crustdata's B2B company and people index. Pick it when an agent needs to discover accounts or contacts matching criteria, rather than to look up one company or person it already knows.

## About Crustdata

Crustdata is a B2B data provider that maintains an indexed database of companies and people — firmographics, funding, headcount and hiring signals on the company side; work history, education and contact details on the people side. It sells access through a REST API aimed at sales, recruiting and market-research teams rather than through an application of its own.

## What it does

The node has no data lanes and exposes two search functions to an agent: one over Crustdata's company index, one over its people index. Each takes a flat list of `{field, type, value}` conditions, wraps them into the `{op, conditions}` group form Crustdata's API expects, and returns the records the service sends back. Results are cursor-paginated, so an agent can walk a large result set across several calls. Prefer this node over a generic HTTP tool when an agent needs Crustdata's filter grammar, limits and pagination already handled; reach for a web-search or scraping node instead when the target is open-web content rather than an indexed B2B record.

The node is marked `experimental`. Its request and response shapes are read from Crustdata's published API reference, but no live account has exercised it end to end — see `## Notes`.

## As a tool

The server-name prefix is `crustdata`, producing these registered functions.

| Function | Description |
|---|---|
| `crustdata.company_search` | Search Crustdata for companies matching one or more filters (industry, region, headcount, funding, current company, and more). Returns structured company records: firmographics, funding history, headcount, and hiring signals. Use it to find prospects or research accounts by criteria, not to look up one already-known company by name. |
| `crustdata.person_search` | Search Crustdata for people matching one or more filters (current company, current title, region, and more). Returns structured profiles: name, title, work history, education, and verified contact info where available. Use it to find or enrich people by criteria. |

Both functions take the same arguments. `filters` is required and must be a non-empty array of `{field, type, value}` conditions. `field` is a dotted path such as `basic_info.primary_domain` (company) or `experience.employment_details.current.title` (person). `type` is one of `=`, `!=`, `<`, `=<`, `>`, `=>`, `in`, `not_in`, `is_null`, `is_not_null`, `(.)` (fuzzy/contains), `[.]` (exact list membership), `geo_distance`, or `geo_exclude` — note `=<` and `=>` rather than `<=` and `>=`, and that the two geo operators take a `{location, distance, unit}` object as their `value`.

The optional arguments are `match` (`and` or `or`, defaulting to `and`), `sorts` (an array of `{field, order}` objects, `order` being `asc` or `desc`), `limit` (1–1000, defaulting to the node's configured Default Result Limit), and `cursor` (a `next_cursor` from an earlier call; omit it for the first page).

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

Pass a response's `next_cursor` back as the next call's `cursor`. Keep `filters` and `sorts` identical across pages — changing either invalidates the cursor — which is why an explicit `sorts` is worth passing whenever an agent intends to paginate.

### Why `match` has only two values

`match` accepts `and` or `or`, and anything else is treated as `and`. Person search's third operator, `all_of`, is not a general combinator: it constrains its conditions to a single nested-array path such as employment or education, so it does not fit a flat "combine these conditions" parameter and is not exposed.

### Request handling

Calls go out through `requests`; no Crustdata SDK is used. Each request times out after 30 seconds and is retried with exponential backoff (up to four attempts) on timeouts, connection errors, HTTP 429 and 5xx responses. Other 4xx responses fail immediately without a retry.

## Upstream docs

- [Crustdata company search reference](https://docs.crustdata.com/company-docs/search/reference)
- [Crustdata person search reference](https://docs.crustdata.com/person-docs/search/reference)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
