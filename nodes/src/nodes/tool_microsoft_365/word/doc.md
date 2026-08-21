# Word

Microsoft Word document operations exposed as agent **tools**, backed by the
[Microsoft Graph drive content API](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content)
and [`python-docx`](https://python-docx.readthedocs.io/). Operates on `.docx`
files in the acting user's OneDrive.

## What it does

Read a document's text (paragraphs and table cells); create a new document
from a list of paragraphs; append paragraphs; find and replace text; export a
document to PDF. There is no persisted Word Online editing session — every
write downloads the current `.docx`, edits it in-process with `python-docx`,
and re-uploads the whole file with an `If-Match` precondition so a concurrent
edit fails readably (a `409`/`412` conflict) instead of silently
last-writer-wins overwriting someone else's change.

## Agent tools

| Tool | Graph call | Purpose |
| --- | --- | --- |
| `word_read_text` | `GET .../content` | Read a document's paragraph and table-cell text, newline-joined. |
| `word_create_document` | `PUT /drive/root:/{path}:/content` | Create a new `.docx` from a list of paragraph texts. |
| `word_append_text` | `GET`/`PUT .../content` (`If-Match`) | Append paragraphs to the end of a document. |
| `word_replace_text` | `GET`/`PUT .../content` (`If-Match`) | Find/replace text across paragraphs and table cells; returns the replacement count. |
| `word_export_pdf` | `GET .../content?format=pdf`, `PUT .../content` | Convert to PDF and upload it beside the source. |
| `word_check_connection` | `GET /drive` + scope report | Diagnostics — connection and scope coverage. |

## Wiring

This is a `tool` node: wire it to an agent via `control` (class `tool`),
alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_word_1",
  "provider": "tool_word",
  "config": { "type": "tool_word" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers the `word_*` tools and calls them per its instructions.

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `microsoft.authType` | yes | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | for `service` | Entra app registration credentials. |
| `microsoft.userPrincipalName` | for `service` | Acting user's UPN — app-only calls target `/users/{upn}`. |
| `microsoft.userToken` | for `user` | Populated by the sign-in button; broker-refreshed. |
| `word.access` | no | `readonly` or `write` (default). Resolved by the shared `WORD` access spec — scopes are never hand-entered. |

## Where to get your credentials

Register an app in the **Entra admin center** (`entra.microsoft.com` → App
registrations), grant it the Graph permission matching the auth mode —
delegated `Files.Read` / `Files.ReadWrite` for user OAuth, or application
`Files.Read.All` / `Files.ReadWrite.All` (admin consent) for the Entra app
flow — and admin consent. See
`microsoft-oauth.md` for the full setup shared by every Microsoft 365 tool
service (excel, word, onedrive, outlook mail, outlook calendar).

Never commit credentials; use node config (encrypted) or Entra app secret
rotation.

## Concurrency

`word_append_text` and `word_replace_text` are read-modify-write round trips:
they download the current file (capturing its eTag), edit it in-process, and
re-upload with `If-Match: <etag>`. If the file was edited elsewhere between
the read and the write, Graph returns `409`/`412`; `graph_client.request`
turns that into a `GraphError` whose message names the conflict and tells the
caller to re-read and retry. `word_create_document` sends no `If-Match` — it
is creating (or intentionally overwriting) a file, not merging with a prior
version.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
