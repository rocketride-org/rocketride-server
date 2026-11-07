# tool_fxmacrodata

A RocketRide tool node that gives an agent macroeconomic and FX data from FXMacroData: latest releases, indicator history, the release calendar, the indicator catalogue and FX reference rates. Pick it when an agent needs official macro figures or release timing rather than news coverage of them.

## About FXMacroData

FXMacroData is a REST API for macroeconomic and FX data collected from official publishers such as central banks and statistics offices. It covers major and emerging-market currencies with indicators such as policy rates, inflation, GDP, labour-market data and bond yields, each stamped with the time it was released, plus a release calendar and daily FX reference rates.

## What it does

The node has no data lanes and exposes five read-only functions to an agent. They validate their arguments (three-letter currency codes, indicator slugs, real `YYYY-MM-DD` dates, page sizes), call the FXMacroData REST API, and return compact rows with the release time, value and previous value rather than the full API payload. Prefer it over `tool_http_request` when an agent needs these semantics handled for it: pagination, the keyless-tier notices, and the difference between a release's reference period and its release time.

## As a tool

The server-name prefix is `fxmacrodata`, producing these registered functions.

| Function | Description |
|---|---|
| `fxmacrodata.latest_announcements` | Latest released value of every indicator for one currency, with the previous value and percentage changes. |
| `fxmacrodata.indicator_history` | Release history of one indicator for one currency, newest first, with optional date window and pagination. |
| `fxmacrodata.release_calendar` | Scheduled releases for one currency, optionally for one indicator and a release-date window. |
| `fxmacrodata.data_catalogue` | Indicator slugs served for one currency, with name, unit and frequency. |
| `fxmacrodata.fx_rates` | Daily official FX reference rates for a currency pair. Requires an API key. |

Every function takes a `currency` (or `base` and `quote` for `fx_rates`) as a three-letter code such as `USD`. `indicator_history` also requires `indicator`, a slug from `data_catalogue` such as `inflation`, `policy_rate` or `non_farm_payrolls`. Optional `start_date` and `end_date` are `YYYY-MM-DD` and `start_date` must not be after `end_date`.

`indicator_history` and `fx_rates` are paginated. `limit` is the page size (1 to 100, default 20), `offset` is where to start (default 0) and `max_pages` (1 to 5, default 1) lets one call follow `next_offset` across several pages. When the response has `has_more: true`, call again with `offset` set to the returned `next_offset`. `release_calendar` is not paginated by the API; its `limit` (1 to 100, default 50) caps the events returned and `truncated` says whether more were available.

In history rows, `date` is the period the value refers to and `announcement_datetime` (Unix seconds, UTC) is when it was released. Calendar events follow the same rule: `reference_period` is the period covered and `announcement_datetime` is the scheduled release time.

Every call returns an object with `success`. Failures (invalid arguments, HTTP errors, an error body on a successful status, a non-JSON body, an unexpected response shape, invalid pagination fields, or a redirect) come back as `success: false` with an `error` string, so the agent sees a failure as data rather than as a raised exception. Responses served without an API key include a `notices` array with the keyless-tier window and delay messages; the agent should relay them rather than present delayed data as current.

## Configuration

One optional field, the API key. Leave it empty to use the keyless tier, or supply a key to unlock every currency, FX rates and real-time releases.

### API Key

Optional. The node reads it from this field, falling back to the `ROCKETRIDE_FXMACRODATA_KEY` environment variable. An empty value means keyless access. A value containing whitespace inside it or non-printable characters stops the node at startup without echoing the value. See `## Authentication` for what each mode can reach.

## Authentication

Without a key, USD announcements (the most recent 90 days, each release readable 15 minutes after publication), the USD release calendar and the data catalogue for every currency are available, with a fair-use allowance of 100 requests per day. Other currencies, FX rates, real-time releases and full history need a key from <https://fxmacrodata.com/subscribe>. A keyless call to one of those returns `success: false` with an error that says a key is needed; `fx_rates` returns that error without making a request.

Put the key in the **API Key** field, where it is encrypted at rest and masked in the UI, or set `ROCKETRIDE_FXMACRODATA_KEY` on the engine host; the configured field wins when both are present. The key is sent as an `X-API-Key` header, and only when one is configured.

## Notes

### Request handling

Calls go out through `requests` via the shared `get_with_retry` helper; no vendor SDK is used. Each request times out after 30 seconds and is retried with exponential backoff (up to three attempts) on timeouts, connection errors, HTTP 429 and 5xx responses. Other 4xx responses fail immediately.

Redirects are never followed. `requests` forwards custom headers such as `X-API-Key` to whatever host a redirect points at, so a 3xx answer is reported as an error instead. The key is held in an object that never prints its value, and it is removed from any error message and any returned string.

## Upstream docs

- [FXMacroData API documentation](https://fxmacrodata.com/documentation)
- [FXMacroData OpenAPI schema](https://api.fxmacrodata.com/openapi.json)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_fxmacrodata.apikey` | `string` | **API Key**<br/>Optional FXMacroData API key (from https://fxmacrodata.com/subscribe). Leave empty for keyless USD access. | `""` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_fxmacrodata)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
