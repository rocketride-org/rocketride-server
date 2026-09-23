# Google Sheets tool node (`tool_sheets`)

Exposes the Google Sheets API v4 as agent tools: read, write, append, and clear
cell values; create spreadsheets; add, delete, duplicate, and copy sheets; and
run arbitrary `batchUpdate` requests (formatting, charts, conditional
formatting, sheet deletion).

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is a
`@tool_function` an agent calls on demand. Operational targets
(`spreadsheetId`, `sheetId`, ranges) are always tool-call parameters, never node
config. Outputs are cleaned shapes (`updatedRange`, `updatedRows`,
`updatedCells`, `values`, sheet properties), not raw API JSON.

## Configuration

| Field | Notes |
|-------|-------|
| `google.authType` | `service` (service account) or `user` (OAuth). |
| `google.serviceKey` / `google.adminEmail` | Service account JSON key; `adminEmail` enables domain-wide delegation (impersonate that user). |
| `google.oAuthButton` / `google.userToken` | User OAuth: sign in to populate the access token. |
| `sheets.access` | `readonly` or `write` (default). Resolved by the shared `SHEETS` spec in `core/google_access.py`; scopes are never hand-entered. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `spreadsheets.readonly` | read values + metadata only |
| `write` | `spreadsheets` | full read/write (default) |

There are no destructive gate flags. Note that sheet deletion and value clears
are NOT trash-recoverable — the Sheets API has no trash; recovery is only
possible through the spreadsheet's version history. Permanent spreadsheet
deletion is a Drive operation and lives in `tool_drive`.

## Tools

- **Read:** `spreadsheet_get` (metadata + sheet properties), `values_get`
  (one A1 range), `values_batch_get` (multiple ranges).
- **Write values:** `values_update`, `values_batch_update`, `values_append`,
  `values_clear`. Writes use `valueInputOption` (default `USER_ENTERED`, so
  `=SUM(...)` becomes a formula and `1,000` a number; pass `RAW` to store
  literally).
- **Structure (write):** `spreadsheet_create`, `sheet_add`, `sheet_delete`,
  `sheet_duplicate`, `sheet_copy_to` (copy a tab into another spreadsheet).
- **Catch-all (write):** `batch_update` accepts the full Sheets `batchUpdate`
  request list — formatting, charts, conditional formatting, protected ranges,
  and sheet deletion all go through it. `sheet_add` / `sheet_delete` /
  `sheet_duplicate` are convenience wrappers over the same endpoint;
  `sheet_copy_to` is the separate `spreadsheets.sheets.copyTo` endpoint.
- **Diagnostics:** `check_connection` probes the Sheets API with a live call;
  for user OAuth it also verifies that granted scopes cover the configured
  access tier (service-account auth has no per-user scope grant to check).

## Setup

Authenticate with either a Google **service account** (`google.serviceKey` JSON,
optionally `google.adminEmail` for domain-wide delegation) or **user OAuth**
(click sign-in to populate `google.userToken`). The Sheets API must be enabled
on the Google Cloud project backing the credential.

## Limits

- `batch_update` request bodies follow Google's Sheets `batchUpdate` limits.
- Value ranges use A1 notation; very large reads should be paged by range.
- Rate limits are per Google project; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent reads a range, then appends a row:

```
values_get      { "spreadsheetId": "1AbC...", "range": "Sheet1!A1:C10" }
values_append   { "spreadsheetId": "1AbC...", "range": "Sheet1!A1",
                  "values": [["2026-07-10", "Widget", 42]] }
```

## Upstream docs

- Google Sheets API v4: https://developers.google.com/sheets/api/reference/rest
- `spreadsheets.values`: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values
- `spreadsheets.batchUpdate`: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate

## Troubleshooting

- **Scope / 403 errors:** call `check_connection`; if scopes are missing,
  disconnect and reconnect the Google account at the required access tier.
- **`access` is read-only:** write operations raise `GoogleAccessError`; raise
  `sheets.access` to `write`.
- **Empty `values`:** the range may be outside the populated grid, or
  `valueRenderOption` may be filtering formulas — try `UNFORMATTED_VALUE`.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
