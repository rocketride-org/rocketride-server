# Excel tool node (`tool_excel`)

Exposes the Microsoft Graph workbook API as agent tools: list worksheets and
tables; read, write, and clear ranges; add worksheets, tables, table rows,
and charts; recalculate; and create new workbooks. Operates on `.xlsx` files
in the acting user's OneDrive.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is
a `@tool_function` an agent calls on demand. Operational targets (file
path/id, sheet, range, table) are always tool-call parameters, never node
config. Outputs are cleaned shapes (`address`, `values`, `rowCount`, sheet/
table properties), not raw Graph JSON.

Every call is sessionless — no persisted workbook session (`workbook-session-id`)
is opened or closed. Graph fully supports this; the tradeoff is one extra
recalculation round trip per call versus a session, deferred until usage shows
the need for sessions.

## Configuration

| Field | Notes |
|-------|-------|
| `microsoft.authType` | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | Entra app credentials for `service` auth. |
| `microsoft.userPrincipalName` | Acting user's UPN for `service` auth (app-only calls target `/users/{upn}`). |
| `microsoft.oAuthButton` / `microsoft.userToken` | User OAuth: sign in to populate the access token. |
| `excel.access` | `readonly` or `write` (default). Resolved by the shared `EXCEL` spec in `core/microsoft_access.py`; scopes are never hand-entered. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `Files.ReadWrite` | read worksheets, ranges, and tables only (writes refused node-side) |
| `write` | `Files.ReadWrite` | full read/write (default) |

Both tiers request `Files.ReadWrite`: Graph's workbook API documents delegated
`Files.ReadWrite` as the least-privileged scope for every endpoint, reads
included (`Files.Read` is not accepted), and lists application permissions as
not supported.

There are no destructive gate flags.

## Tools

- **Read:** `excel_list_worksheets`, `excel_read_range` (one A1 range),
  `excel_read_used_range` (the populated area), `excel_list_tables`,
  `excel_read_table`.
- **Write ranges:** `excel_update_range` (overwrites), `excel_clear_range`
  (contents only, formatting preserved).
- **Structure (write):** `excel_add_worksheet`, `excel_add_table`,
  `excel_add_table_rows`, `excel_add_chart`.
- **Workbook (write):** `excel_calculate` (full recalculation),
  `excel_create_workbook` (new blank `.xlsx` at a OneDrive path).
- **Diagnostics:** `excel_check_connection` verifies that granted OAuth
  scopes cover the configured access tier.

## Setup

Authenticate with either an **Entra app** (`microsoft.tenantId` /
`microsoft.clientId` / `microsoft.clientSecret` / `microsoft.userPrincipalName`,
client-credentials flow) or **user OAuth** (click sign-in to populate
`microsoft.userToken`). See `microsoft-oauth.md` for the Entra app / consent
setup shared by every Microsoft 365 tool service. The app must be granted the
delegated Graph `Files.ReadWrite` permission with admin consent — Graph's
workbook API accepts only delegated `Files.ReadWrite` (not `Files.Read`) and
documents application-only tokens as not supported, so user OAuth is the
documented path.

## Limits

- Range/table operations use A1 notation and Graph's workbook function
  addressing (`range(address='...')`); very large reads should be paged by
  range.
- `excel_create_workbook` writes a minimal blank workbook (one empty
  "Sheet1"); it does not clone an existing file or template.
- Rate limits are per Entra app / tenant; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent reads a worksheet's used range, then appends rows to a table:

```
excel_read_used_range  { "file": "Reports/q3.xlsx", "sheet": "Sheet1" }
excel_add_table_rows   { "file": "Reports/q3.xlsx", "table": "Table1",
                          "rows": [["2026-07-10", "Widget", 42]] }
```

## Upstream docs

- Microsoft Graph Excel API: https://learn.microsoft.com/en-us/graph/api/resources/excel
- Workbook range: https://learn.microsoft.com/en-us/graph/api/range-get
- Workbook tables: https://learn.microsoft.com/en-us/graph/api/resources/table

## Troubleshooting

- **Scope / 403 errors:** call `excel_check_connection`; if scopes are
  missing, disconnect and reconnect the Microsoft account (user auth) or
  grant/consent the Entra app permission (service auth) at the required tier.
- **`access` is read-only:** write tools raise `MicrosoftAccessError`; raise
  `excel.access` to `write`.
- **Empty `values`:** the range may be outside the used range, or the file
  path/sheet name may not match exactly — call `excel_list_worksheets` to
  confirm names.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
