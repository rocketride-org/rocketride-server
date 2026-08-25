# tool_google_workspace

A RocketRide tool family that exposes Google Calendar, Docs, Drive, Gmail, and Sheets to an agent. Pick the service-specific tool matching the Google Workspace resource the agent must operate, rather than using a general HTTP tool.

## About Google Workspace

Google Workspace is a collection of cloud productivity services including mail, calendars, documents, file storage, and spreadsheets. Organizations use its services for collaboration and administrative work.

## What it does

This parent groups five no-lane tool services: Calendar, Docs, Drive, Gmail, and Sheets. Each service authenticates through the shared Google lifecycle, builds only its own Google API client, and registers functions under its own server-name prefix. Select a service according to the resource the agent needs; the individual variant READMEs document their service-specific calls in depth.

## As a tool

Each service registers exactly the functions below. A function name is prefixed by its service name; `check_connection` checks that service's configured access and connection. Individual operation arguments and return shapes are exposed in each function's registered schema.

| Function | Description |
|---|---|
| `calendar.check_connection` | Google Calendar operation registered by this service. |
| `calendar.event_list` | Google Calendar operation registered by this service. |
| `calendar.event_get` | Google Calendar operation registered by this service. |
| `calendar.event_instances` | Google Calendar operation registered by this service. |
| `calendar.freebusy_query` | Google Calendar operation registered by this service. |
| `calendar.calendar_list` | Google Calendar operation registered by this service. |
| `calendar.calendar_get` | Google Calendar operation registered by this service. |
| `calendar.acl_list` | Google Calendar operation registered by this service. |
| `calendar.event_create` | Google Calendar operation registered by this service. |
| `calendar.event_update` | Google Calendar operation registered by this service. |
| `calendar.event_move` | Google Calendar operation registered by this service. |
| `calendar.event_quick_add` | Google Calendar operation registered by this service. |
| `calendar.calendar_create` | Google Calendar operation registered by this service. |
| `calendar.calendar_update` | Google Calendar operation registered by this service. |
| `calendar.acl_insert` | Google Calendar operation registered by this service. |
| `calendar.acl_delete` | Google Calendar operation registered by this service. |
| `calendar.event_delete` | Google Calendar operation registered by this service. |
| `calendar.calendar_delete` | Google Calendar operation registered by this service. |
| `docs.check_connection` | Google Docs operation registered by this service. |
| `docs.document_get` | Google Docs operation registered by this service. |
| `docs.document_create` | Google Docs operation registered by this service. |
| `docs.batch_update` | Google Docs operation registered by this service. |
| `docs.text_append` | Google Docs operation registered by this service. |
| `docs.text_replace` | Google Docs operation registered by this service. |
| `docs.image_insert` | Google Docs operation registered by this service. |
| `docs.table_insert` | Google Docs operation registered by this service. |
| `drive.check_connection` | Google Drive operation registered by this service. |
| `drive.file_list` | Google Drive operation registered by this service. |
| `drive.file_search` | Google Drive operation registered by this service. |
| `drive.file_get` | Google Drive operation registered by this service. |
| `drive.file_download` | Google Drive operation registered by this service. |
| `drive.file_export` | Google Drive operation registered by this service. |
| `drive.drives_list` | Google Drive operation registered by this service. |
| `drive.changes_list` | Google Drive operation registered by this service. |
| `drive.file_create` | Google Drive operation registered by this service. |
| `drive.file_update` | Google Drive operation registered by this service. |
| `drive.file_copy` | Google Drive operation registered by this service. |
| `drive.file_move` | Google Drive operation registered by this service. |
| `drive.file_trash` | Google Drive operation registered by this service. |
| `drive.file_untrash` | Google Drive operation registered by this service. |
| `drive.folder_create` | Google Drive operation registered by this service. |
| `drive.permission_list` | Google Drive operation registered by this service. |
| `drive.permission_update` | Google Drive operation registered by this service. |
| `drive.permission_delete` | Google Drive operation registered by this service. |
| `drive.permission_create` | Google Drive operation registered by this service. |
| `drive.file_delete` | Google Drive operation registered by this service. |
| `gmail.check_connection` | Gmail operation registered by this service. |
| `gmail.message_list` | Gmail operation registered by this service. |
| `gmail.message_search` | Gmail operation registered by this service. |
| `gmail.message_get` | Gmail operation registered by this service. |
| `gmail.message_modify` | Gmail operation registered by this service. |
| `gmail.message_batch_modify` | Gmail operation registered by this service. |
| `gmail.label_apply` | Gmail operation registered by this service. |
| `gmail.label_remove` | Gmail operation registered by this service. |
| `gmail.thread_get` | Gmail operation registered by this service. |
| `gmail.thread_list` | Gmail operation registered by this service. |
| `gmail.label_list` | Gmail operation registered by this service. |
| `gmail.label_create` | Gmail operation registered by this service. |
| `gmail.label_update` | Gmail operation registered by this service. |
| `gmail.label_delete` | Gmail operation registered by this service. |
| `gmail.draft_list` | Gmail operation registered by this service. |
| `gmail.draft_get` | Gmail operation registered by this service. |
| `gmail.draft_create` | Gmail operation registered by this service. |
| `gmail.draft_update` | Gmail operation registered by this service. |
| `gmail.draft_send` | Gmail operation registered by this service. |
| `gmail.draft_delete` | Gmail operation registered by this service. |
| `gmail.message_send` | Gmail operation registered by this service. |
| `gmail.message_trash` | Gmail operation registered by this service. |
| `gmail.message_untrash` | Gmail operation registered by this service. |
| `gmail.attachment_get` | Gmail operation registered by this service. |
| `gmail.history_list` | Gmail operation registered by this service. |
| `gmail.message_delete` | Gmail operation registered by this service. |
| `gmail.messages_batchDelete` | Gmail operation registered by this service. |
| `gmail.thread_modify` | Gmail operation registered by this service. |
| `gmail.thread_trash` | Gmail operation registered by this service. |
| `gmail.thread_untrash` | Gmail operation registered by this service. |
| `gmail.thread_delete` | Gmail operation registered by this service. |
| `gmail.message_archive` | Gmail operation registered by this service. |
| `gmail.message_mark_read` | Gmail operation registered by this service. |
| `gmail.message_mark_unread` | Gmail operation registered by this service. |
| `gmail.message_star` | Gmail operation registered by this service. |
| `gmail.message_unstar` | Gmail operation registered by this service. |
| `gmail.message_get_body` | Gmail operation registered by this service. |
| `gmail.filter_list` | Gmail operation registered by this service. |
| `gmail.filter_create` | Gmail operation registered by this service. |
| `gmail.filter_delete` | Gmail operation registered by this service. |
| `gmail.watch_start` | Gmail operation registered by this service. |
| `gmail.watch_stop` | Gmail operation registered by this service. |
| `gmail.send_as_list` | Gmail operation registered by this service. |
| `gmail.send_as_get` | Gmail operation registered by this service. |
| `gmail.send_as_create` | Gmail operation registered by this service. |
| `gmail.send_as_update` | Gmail operation registered by this service. |
| `gmail.send_as_delete` | Gmail operation registered by this service. |
| `gmail.imap_get` | Gmail operation registered by this service. |
| `gmail.imap_update` | Gmail operation registered by this service. |
| `gmail.pop_get` | Gmail operation registered by this service. |
| `gmail.pop_update` | Gmail operation registered by this service. |
| `gmail.vacation_get` | Gmail operation registered by this service. |
| `gmail.vacation_update` | Gmail operation registered by this service. |
| `gmail.forwarding_address_list` | Gmail operation registered by this service. |
| `gmail.forwarding_address_create` | Gmail operation registered by this service. |
| `gmail.forwarding_address_delete` | Gmail operation registered by this service. |
| `gmail.delegate_list` | Gmail operation registered by this service. |
| `gmail.delegate_create` | Gmail operation registered by this service. |
| `gmail.delegate_delete` | Gmail operation registered by this service. |
| `gmail.smime_list` | Gmail operation registered by this service. |
| `gmail.smime_set_default` | Gmail operation registered by this service. |
| `gmail.smime_delete` | Gmail operation registered by this service. |
| `sheets.check_connection` | Google Sheets operation registered by this service. |
| `sheets.values_get` | Google Sheets operation registered by this service. |
| `sheets.values_batch_get` | Google Sheets operation registered by this service. |
| `sheets.spreadsheet_get` | Google Sheets operation registered by this service. |
| `sheets.values_update` | Google Sheets operation registered by this service. |
| `sheets.values_batch_update` | Google Sheets operation registered by this service. |
| `sheets.values_append` | Google Sheets operation registered by this service. |
| `sheets.values_clear` | Google Sheets operation registered by this service. |
| `sheets.spreadsheet_create` | Google Sheets operation registered by this service. |
| `sheets.sheet_add` | Google Sheets operation registered by this service. |
| `sheets.sheet_delete` | Google Sheets operation registered by this service. |
| `sheets.sheet_duplicate` | Google Sheets operation registered by this service. |
| `sheets.sheet_copy_to` | Google Sheets operation registered by this service. |
| `sheets.batch_update` | Google Sheets operation registered by this service. |

Write, delete, and sharing calls can be refused by the configured access tier or explicit safety flags. Connection and Google API failures surface through the tool call; call the relevant `check_connection` function when a scope or permission error needs diagnosis.

## Configuration

Choose the authentication mode and the narrowest access tier for each service. The five services are independently configured, so setting a high tier for one does not broaden another service.

### Google authentication

Each service has `authType` with `service` as the default and supports a service-account key, optional administrator email, or a user OAuth token. Use service authentication when the service account has the intended resource access; use user OAuth when the calls must act as the signed-in user. Missing service credentials or a user token whose scopes do not cover the selected tier produce configuration warnings.

### Google Calendar

Calendar defaults to the `write` access tier; `readonly` allows only event, calendar, ACL, and free/busy reads. Deleting events or calendars remains refused until `allowDelete` is enabled. Public or domain-wide ACL inserts require `allowPublicSharing`; keep both safety flags off unless the agent has an explicit destructive or sharing responsibility.

### Google Docs

Docs defaults to `write`, which permits document creation, text and structural updates. Use `readonly` for an agent that should only read document text and metadata. In particular, reserve `batch_update` for agents that intentionally issue structured Docs update requests.

### Google Drive

Drive defaults to `write`; `readonly` supports listing, metadata, downloading, and export without modifications. Public or external sharing is blocked until `allowPublicSharing` is on. Permanent `file_delete` bypasses Trash and is separately blocked until `allowHardDelete` is on; prefer trashing for recoverable removal.

### Gmail

Gmail defaults to `modify`, permitting reads and organization but not sending. Select `readonly` for an inspection agent, `send` when it must send mail, `settings` or `settings_sharing` only for the corresponding administrative operations, and `full` only when permanent deletion is intended. Even at the full tier, hard deletion is blocked until `allowHardDelete` is enabled.

### Google Sheets

Sheets defaults to `write`, covering spreadsheet creation, values operations, sheet structure changes, and batch updates. Select `readonly` when the agent should only retrieve values and metadata.

## Authentication

Google user mode relies on the stored user OAuth token; service mode uses the configured service account material, optionally with an administrator identity for delegated access. Select access tiers through the service configuration rather than hand-entering scopes. The connection-check tool verifies whether granted OAuth scopes cover the selected tier.

## Notes

### Separate server names

Calendar, Docs, Drive, Gmail, and Sheets use the `calendar`, `docs`, `drive`, `gmail`, and `sheets` prefixes respectively. They are distinct tool servers even though they share authentication lifecycle code.

## Upstream docs

- [Google Workspace developer documentation](https://developers.google.com/workspace)
