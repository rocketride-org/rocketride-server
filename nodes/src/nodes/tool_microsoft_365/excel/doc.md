# Excel

Microsoft Excel workbook operations exposed as agent **tools**, backed by the
[Microsoft Graph workbook API](https://learn.microsoft.com/en-us/graph/api/resources/excel).
Operates on `.xlsx` files in the acting user's OneDrive.

## What it does

List worksheets and tables; read, write, and clear cell ranges; add
worksheets, tables, table rows, and charts; recalculate formulas; and create
new blank workbooks. Every call runs sessionless (no persisted
`workbook-session-id`) — Graph fully supports this, so no session lifecycle
needs to be managed around a sequence of edits.

## Agent tools

| Tool | Graph call | Purpose |
| --- | --- | --- |
| `excel_list_worksheets` | `GET /workbook/worksheets` | List a workbook's worksheets (tabs). |
| `excel_read_range` | `GET .../range(address=...)` | Read values/formulas in one A1 range. |
| `excel_read_used_range` | `GET .../usedRange` | Read a worksheet's populated area. |
| `excel_update_range` | `PATCH .../range(address=...)` | Overwrite values in an A1 range. |
| `excel_clear_range` | `POST .../range(address=...)/clear` | Clear an A1 range's contents. |
| `excel_add_worksheet` | `POST /workbook/worksheets/add` | Add a new worksheet (tab). |
| `excel_list_tables` | `GET /workbook/tables` | List a workbook's tables. |
| `excel_read_table` | `GET /workbook/tables/{table}/rows` | Read every row of a table. |
| `excel_add_table` | `POST .../tables/add` | Create a table over an A1 range. |
| `excel_add_table_rows` | `POST /workbook/tables/{table}/rows` | Append rows to a table. |
| `excel_add_chart` | `POST .../charts/add` | Add a chart plotting a source range. |
| `excel_calculate` | `POST /workbook/application/calculate` | Full recalculation of the workbook. |
| `excel_create_workbook` | `PUT /drive/root:/{path}:/content` | Create a new blank `.xlsx` workbook. |
| `excel_check_connection` | `GET /drive` + scope report | Diagnostics — connection and scope coverage. |

## Wiring

This is a `tool` node: wire it to an agent via `control` (class `tool`),
alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_excel_1",
  "provider": "tool_excel",
  "config": { "type": "tool_excel" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers the `excel_*` tools and calls them per its instructions.

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `microsoft.authType` | yes | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | for `service` | Entra app registration credentials. |
| `microsoft.userPrincipalName` | for `service` | Acting user's UPN — app-only calls target `/users/{upn}`. |
| `microsoft.userToken` | for `user` | Populated by the sign-in button; broker-refreshed. |
| `excel.access` | no | `readonly` or `write` (default). Resolved by the shared `EXCEL` access spec — scopes are never hand-entered. Both tiers request delegated `Files.ReadWrite` (the only scope Graph's workbook API accepts, reads included); `readonly` refuses the mutating tools node-side. |

## Where to get your credentials

Register an app in the **Entra admin center** (`entra.microsoft.com` → App
registrations), grant it the delegated Graph `Files.ReadWrite` permission and
admin consent. Graph's workbook API accepts only delegated `Files.ReadWrite`
(not `Files.Read`) and documents application-only tokens as not supported, so
user OAuth is the documented path. See
`microsoft-oauth.md` for the full setup shared by every Microsoft 365 tool
service (excel, word, onedrive, outlook mail, outlook calendar).

Never commit credentials; use node config (encrypted) or Entra app secret
rotation.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
