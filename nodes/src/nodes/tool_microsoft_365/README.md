# tool_microsoft_365

A RocketRide tool family that exposes Excel, OneDrive, Outlook Calendar, Outlook Mail, and Word to an agent. Use the service whose resource the agent needs, rather than a general HTTP tool.

## About Microsoft 365

Microsoft 365 is Microsoft's cloud productivity suite, bundling Word, Excel, Outlook, and OneDrive with Exchange and SharePoint under one subscription. Organizations use it for document authoring, spreadsheets, email, calendaring, and file storage, accessed from desktop, web, and mobile clients. The Microsoft Graph API exposes these services under one authentication and permissions model.

## What it does

This parent groups five no-lane tool services: Excel, OneDrive, Outlook Calendar, Outlook Mail, and Word. Each service authenticates through the shared Microsoft Graph credential and request machinery in `graph_client.py`, builds only its own Graph client, and registers `<service>_*` functions as agent tools. Operational targets (file path/id, message id, event id) are always tool-call parameters, never node config, and outputs are cleaned shapes rather than raw Graph JSON. Select a service according to the Microsoft 365 resource the agent needs.

## As a tool

Each service registers exactly the functions below, every name prefixed with the service name; `<service>_check_connection` checks that service's configured access and connection. Individual operation arguments and return shapes are exposed in each function's registered schema.

### Excel

| Function | Description |
|---|---|
| `excel_list_worksheets` | List a workbook's worksheets (tabs). |
| `excel_read_range` | Read values/formulas in one A1 range. |
| `excel_read_used_range` | Read a worksheet's populated area. |
| `excel_update_range` | Overwrite values in an A1 range. |
| `excel_clear_range` | Clear an A1 range's contents. |
| `excel_add_worksheet` | Add a new worksheet (tab). |
| `excel_list_tables` | List a workbook's tables. |
| `excel_read_table` | Read every row of a table. |
| `excel_add_table` | Create a table over an A1 range. |
| `excel_add_table_rows` | Append rows to a table. |
| `excel_add_chart` | Add a chart plotting a source range. |
| `excel_calculate` | Full recalculation of the workbook. |
| `excel_create_workbook` | Create a new blank `.xlsx` workbook. |
| `excel_check_connection` | Diagnostics — connection and scope coverage. |

### OneDrive

| Function | Description |
|---|---|
| `onedrive_list_items` | List a folder's items (root by default). |
| `onedrive_search` | Search files and folders by name/content. |
| `onedrive_get_metadata` | Read one item's metadata. |
| `onedrive_download` | Download content (inline base64 ≤ 1 MiB, else a `downloadUrl`). |
| `onedrive_upload` | Upload/overwrite a file (chunked above 4 MB). |
| `onedrive_create_folder` | Create a folder inside a parent folder. |
| `onedrive_copy` | Copy a file or folder (async). |
| `onedrive_move` | Move an item to another folder. |
| `onedrive_rename` | Rename an item in place. |
| `onedrive_trash` | Move an item to the recycle bin. |
| `onedrive_restore` | Restore a trashed item. OneDrive Personal only (Graph limitation): refused under `service` auth; work/school accounts get Graph's error. |
| `onedrive_permanently_delete` | Permanently delete an item (gated). |
| `onedrive_create_sharing_link` | Create a view/edit sharing link (anonymous scope gated). |
| `onedrive_list_permissions` | List sharing permissions on an item. |
| `onedrive_invite` | Invite people by email (non-individual recipients gated via directory lookup). |
| `onedrive_delete_permission` | Revoke a sharing permission. |
| `onedrive_check_connection` | Diagnostics — connection and scope coverage. |

### Outlook Calendar

| Function | Description |
|---|---|
| `outlook_calendar_list_events` | List events in a window (recurring series expanded). |
| `outlook_calendar_get_event` | Get a single event by id. |
| `outlook_calendar_create_event` | Create an event, optionally inviting attendees (write tier). |
| `outlook_calendar_update_event` | Update an event — only provided fields change (write tier). |
| `outlook_calendar_delete_event` | Delete an event (write tier). |
| `outlook_calendar_respond` | Respond to a meeting invitation (write tier). |
| `outlook_calendar_find_meeting_times` | Suggest meeting times for a set of attendees. |
| `outlook_calendar_get_schedule` | Get free/busy schedule information for mailboxes. |
| `outlook_calendar_list_calendars` | List the mailbox's calendars. |
| `outlook_calendar_create_calendar` | Create a new calendar (write tier). |
| `outlook_calendar_delta_sync` | Incrementally sync a calendar view via a caller-provided delta link. |
| `outlook_calendar_check_connection` | Diagnostics — connection and scope coverage. |

### Outlook Mail

| Function | Description |
|---|---|
| `outlook_mail_list_messages` | List a folder's messages (inbox by default), search or OData filter. |
| `outlook_mail_get_message` | Get one message with its full body (HTML converted to readable text). |
| `outlook_mail_send_message` | Send an email immediately (send/modify tier). |
| `outlook_mail_create_draft` | Create a draft message (modify tier). |
| `outlook_mail_reply` | Reply to the sender only (send/modify tier). |
| `outlook_mail_reply_all` | Reply to all recipients (send/modify tier). |
| `outlook_mail_forward` | Forward to new recipients (send/modify tier). |
| `outlook_mail_move_message` | Move a message to another folder (modify tier). |
| `outlook_mail_set_read` | Mark a message read/unread (modify tier). |
| `outlook_mail_set_categories` | Replace a message's category labels (modify tier). |
| `outlook_mail_delete_message` | Soft delete — move to Deleted Items (modify tier). |
| `outlook_mail_permanently_delete` | Permanently delete (modify tier + `allowHardDelete` gate). |
| `outlook_mail_list_folders` | List the mailbox's mail folders. |
| `outlook_mail_create_folder` | Create a mail folder (modify tier). |
| `outlook_mail_list_attachments` | List attachment metadata on a message. |
| `outlook_mail_get_attachment` | Download an attachment's content (base64). |
| `outlook_mail_add_attachment` | Attach a file to a draft message (modify tier). |
| `outlook_mail_check_connection` | Diagnostics — connection and scope coverage. |

### Word

| Function | Description |
|---|---|
| `word_read_text` | Read a document's paragraph and table-cell text, newline-joined. |
| `word_create_document` | Create a new `.docx` from a list of paragraph texts. |
| `word_append_text` | Append paragraphs to the end of a document. |
| `word_replace_text` | Find/replace text across paragraphs and table cells; returns the replacement count. |
| `word_export_pdf` | Convert to PDF and upload it beside the source. |
| `word_check_connection` | Diagnostics — connection and scope coverage. |

Write, delete, and sharing calls can be refused by the configured access tier or explicit safety flags. Connection and Graph API failures surface through the tool call; call the relevant `check_connection` function when a scope or permission error needs diagnosis.

## Configuration

Choose the authentication mode and the narrowest access tier for each service. The five services are independently configured, so setting a high tier for one does not broaden another service.

### Microsoft authentication

Every service exposes `microsoft.authType`, defaulting to `service`: an Entra app using the client-credentials flow (`microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret`), acting as `microsoft.userPrincipalName` (app-only calls target `/users/{upn}`). The `user` mode is OAuth via the RocketRide broker: the `microsoft.oAuthButton` sign-in populates `microsoft.userToken`, which the broker refreshes automatically. Application (`service`) permissions always require admin consent.

### Excel

Excel defaults to the `write` access tier; `readonly` refuses the mutating tools node-side. Both tiers request the same delegated `Files.ReadWrite` scope — Graph's workbook API accepts no narrower scope and documents application-only tokens as not supported, so user OAuth is the documented auth path even though `service` auth is configurable. There are no destructive gate flags.

### OneDrive

OneDrive defaults to `write`; `readonly` supports listing, search, metadata, and download without modification. Public or non-individual-recipient sharing is refused until `onedrive.allowPublicSharing` is on — with it off, `onedrive_invite` resolves every recipient against the directory and fails closed on any recipient (or lookup error) that isn't an individual user. Permanent delete bypasses the recycle bin and stays refused until `onedrive.allowHardDelete` is on; prefer `onedrive_trash` for recoverable removal.

### Outlook Calendar

Outlook Calendar defaults to `write`; `readonly` allows only event/calendar reads, meeting-time suggestions, free/busy schedules, and delta-sync. There are no destructive gate flags — unlike Outlook Mail's hard-delete flag, event deletion needs only the `write` tier.

### Outlook Mail

Outlook Mail defaults to `modify`, the tier needed for drafts, moves, organizing, and attachments; `send` adds only sending and replying (`Mail.Send`) without `Mail.ReadWrite`, and `readonly` allows reads only. Permanent deletion stays refused until `outlook_mail.allowHardDelete` is on; with it off, `outlook_mail_delete_message` still moves messages to Deleted Items.

### Word

Word defaults to `write`; `readonly` allows only `word_read_text`. There are no destructive gate flags — every write is a read-modify-write round trip guarded by Graph's own `If-Match` precondition rather than a node-side gate.

## Authentication

Every service authenticates through the shared Microsoft Graph credential and request machinery in `graph_client.py` — the one copy every service's `client.py` binds via `functools.partial`. Credential construction validates its token endpoint against Microsoft's own Entra ID (Azure AD) host (`login.microsoftonline.com`) only, and validates the broker refresh URL against `https` plus a trusted broker host (`oauth2.rocketride.ai` / `oauth.rocketride.ai`, or `RR_OAUTH_BROKER_URL` for a self-hosted broker) — so a tampered stored token can never redirect credentials elsewhere. The broker-backed refresh fails loud on HTTP rejection, connection errors, malformed bodies, and 200 responses without an access token, and clears a stale expiry so a fresh token is never re-refreshed per call. Scope diagnostics (`token_scope_report`) back each service's `validateConfig`, its `check_connection` tool, and `build_auth`, so the three checks cannot drift. Requests retry `429`/`5xx` with exponential backoff; permission `401`/`403` and other errors fail fast with an agent-readable message.

Register the app in the Entra admin center (`entra.microsoft.com` → App registrations) and grant the Graph permission each service's Configuration section names, with admin consent required for application (`service`) permissions.

## Notes

### Excel

- Every call is sessionless — no persisted workbook session (`workbook-session-id`) is opened or closed. Graph fully supports this; the tradeoff is one extra recalculation round trip per call versus a session, deferred until usage shows the need for sessions.
- `excel_create_workbook` writes a minimal blank workbook (one empty "Sheet1"); it does not clone an existing file or template.
- Range/table operations use A1 notation and Graph's workbook function addressing; very large reads should be paged by range.
- Troubleshooting: scope/403 errors — call `excel_check_connection`; if scopes are missing, reconnect the Microsoft account (user auth) or grant/consent the Entra app permission (service auth). `access` is read-only — write tools raise `MicrosoftAccessError`; raise `excel.access` to `write`. Empty `values` — the range may be outside the used range, or the file path/sheet name may not match exactly; call `excel_list_worksheets` to confirm names.

### OneDrive

- `onedrive_copy` runs asynchronously on Graph's side; the tool returns once the copy is accepted, not once it completes.
- `onedrive_upload` chunks large files at 5 MiB per PUT to the resumable upload session, per Graph's recommended chunk size.
- `onedrive_restore` is OneDrive Personal only — Microsoft Graph does not support restore for work or school accounts. The tool refuses up front under Entra app (service) auth; a work/school user OAuth account surfaces Graph's own error. Use the OneDrive web recycle bin instead.
- Troubleshooting: scope/403 errors — call `onedrive_check_connection`. Sharing/invite refused — anonymous links, and invites to any recipient that doesn't resolve to an individual directory user (including a lookup permission error), need `onedrive.allowPublicSharing` enabled; permanent delete needs `onedrive.allowHardDelete` enabled. Item not found — confirm whether the caller meant a path or an item id; a value without `/` is always treated as an item id, never a bare root-level filename.

### Outlook Calendar

- `outlook_calendar_create_event` / `outlook_calendar_update_event` accept `start`/`end` as either a plain `'YYYY-MM-DDTHH:MM:SS'` string (wrapped as UTC) or an already-shaped `{dateTime, timeZone}` object.
- `attendees` invites are sent by Graph itself as part of creating/updating the event — the `write` tier gates the Graph call, not a separate "send" step.
- `outlook_calendar_find_meeting_times` needs a delegated (signed-in user) context on Microsoft's side and may not be supported under app-only (client-credentials) authentication.
- `outlook_calendar_delta_sync` takes `start`/`end` on the first call; pass the returned `delta_link` back in on subsequent calls to fetch only what changed.
- Troubleshooting: scope/403 errors — call `outlook_calendar_check_connection`. `access` is `readonly` — every write tool raises `MicrosoftAccessError`; raise `outlook_calendar.access` to `write`. `outlook_calendar_find_meeting_times` fails under app-only auth — this endpoint needs a delegated (signed-in user) context; switch to user OAuth or use `outlook_calendar_get_schedule` instead.

### Outlook Mail

- `outlook_mail_list_messages`'s `query` is treated as a full-text `$search` term unless it looks like an OData filter expression (contains `eq`, `ne`, `gt`, `lt`, `ge`, `le`, `startswith(`, or `contains(`), in which case it is passed through as `$filter`.
- `outlook_mail_add_attachment` only works against a draft message — create one with `outlook_mail_create_draft` first.
- Troubleshooting: scope/403 errors — call `outlook_mail_check_connection`. `access` is `readonly` — every write/send tool raises `MicrosoftAccessError`; raise `outlook_mail.access` to `send` or `modify`. `access` is `send` but drafts/moves/attachments are refused — the `send` tier lacks `Mail.ReadWrite`; raise `outlook_mail.access` to `modify`. Permanent delete refused — needs `outlook_mail.allowHardDelete` enabled; `outlook_mail_delete_message` (soft delete to Deleted Items) is always available at the `modify` tier.

### Word

- Concurrency: round-trip edits (`word_append_text`, `word_replace_text`) use `If-Match`; a stale eTag (someone else edited the file since it was downloaded) surfaces as a `GraphError` naming the conflict. The tool does not retry automatically — re-read with `word_read_text` and retry the edit. `word_create_document` sends no `If-Match` — nothing to conflict with yet.
- `word_replace_text` scans each paragraph's original, never-mutated text exactly once, so a `replace` value containing `find` cannot double-count. Paragraphs with zero matches are left completely untouched; paragraphs with at least one match get their new text written into the first run with every other run blanked, so the first run's formatting wins for the whole merged text.
- `word_export_pdf` relies on Graph's server-side format conversion (`?format=pdf`); very large or exotic documents may take longer to convert or fail conversion upstream.
- Troubleshooting: scope/403 errors — call `word_check_connection`. `access` is read-only — raise `word.access` to `write`. Conflict / 409 / 412 errors — the file changed since it was downloaded; call `word_read_text` to get the current content and retry the edit. `word_replace_text` returns 0 — confirm the exact text; `find` is a literal (case-sensitive) substring match, not a regex.

### Rate limits

All five services are subject to per Entra app / tenant rate limits; the node retries `429`/`5xx` responses with exponential backoff.

## Upstream docs

- Microsoft Graph Excel API: https://learn.microsoft.com/en-us/graph/api/resources/excel
- Workbook range: https://learn.microsoft.com/en-us/graph/api/range-get
- Workbook tables: https://learn.microsoft.com/en-us/graph/api/resources/table
- Microsoft Graph OneDrive API: https://learn.microsoft.com/en-us/graph/api/resources/onedrive
- DriveItem: https://learn.microsoft.com/en-us/graph/api/resources/driveitem
- Upload large files: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- Sharing: https://learn.microsoft.com/en-us/graph/api/driveitem-createlink
- Microsoft Graph calendar API: https://learn.microsoft.com/en-us/graph/api/resources/calendar
- Event: https://learn.microsoft.com/en-us/graph/api/resources/event
- Find meeting times: https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes
- Get schedule: https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
- Delta query: https://learn.microsoft.com/en-us/graph/delta-query-events
- Microsoft Graph mail API: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview
- Message: https://learn.microsoft.com/en-us/graph/api/resources/message
- Send mail: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Search messages: https://learn.microsoft.com/en-us/graph/search-query-parameter
- Microsoft Graph drive content API: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
- DriveItem format conversion: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format
- python-docx: https://python-docx.readthedocs.io/

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Excel (`services.excel.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `excel.access` | `string` | **Access level**<br/>Graph scopes to request. readonly: read worksheets, ranges, and tables only. write: full read/write (update ranges, add worksheets/tables/charts, create workbooks). | `"write"` |

### OneDrive (`services.onedrive.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `onedrive.access` | `string` | **Access level**<br/>Graph scopes to request. readonly: list, search, read metadata, and download only. write: full read/write (upload, create folders, copy/move/rename, trash/restore, and sharing). | `"write"` |
| `onedrive.allowHardDelete` | `boolean` | **Allow permanent delete**<br/>Off by default. When off, only trash/restore are available; permanent delete is refused. | `false` |
| `onedrive.allowPublicSharing` | `boolean` | **Allow public / org-wide sharing**<br/>Off by default. When off, create_sharing_link refuses 'anonymous' links and invite only accepts recipients that resolve to individual directory users (distribution lists and unresolvable addresses are refused). Turn on to allow public links and unrestricted invites. | `false` |

### Outlook Calendar (`services.outlook_calendar.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `outlook_calendar.access` | `string` | **Access level**<br/>Graph scopes to request. readonly: list and read events/calendars, find meeting times, get schedules, and delta-sync only. write: full read/write (default) — create/update/delete events, respond to invitations, and create calendars. | `"write"` |

### Outlook Mail (`services.outlook_mail.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `outlook_mail.access` | `string` | **Access level**<br/>Graph scopes to request. readonly: list, search, and read messages/folders/attachments only. send: readonly plus sending mail, replies, and forwards. modify: full read/write (default) — drafts, moves, organizing, attachments, and permanent delete (when allowHardDelete is on), plus send. | `"modify"` |
| `outlook_mail.allowHardDelete` | `boolean` | **Allow permanent delete**<br/>Off by default. When off, delete moves messages to Deleted Items; permanent delete is refused. Turn on to allow permanent delete. | `false` |

### Word (`services.word.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `word.access` | `string` | **Access level**<br/>Graph scopes to request. readonly: read document text only. write: full read/write (create, append, replace text, export PDF). | `"write"` |

## Dependencies

- `python-docx`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_microsoft_365)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
