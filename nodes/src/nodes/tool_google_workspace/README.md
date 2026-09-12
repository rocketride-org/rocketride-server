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

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Google Calendar (`services.calendar.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `calendar.access` | `string` | **Access level**<br/>Calendar scopes to request. readonly: read events, calendars, ACLs, and free/busy only. write: full read/write (create, update, move, quick-add events; manage calendars and ACLs). Deletion additionally requires the allowDelete flag; public/domain-wide ACL sharing requires allowPublicSharing. | `"write"` |
| `calendar.allowDelete` | `boolean` | **Allow event / calendar deletion**<br/>When off (the default), event_delete and calendar_delete are refused even at the write tier. Enable only if the agent should be able to permanently delete events and calendars — this is irreversible. | `false` |
| `calendar.allowPublicSharing` | `boolean` | **Allow public / domain-wide calendar sharing**<br/>Off by default. When off, acl_insert refuses rules that expose the calendar beyond individual grantees (scopeType 'default' = anyone on the internet, and 'domain' = everyone in a domain). Turn on to allow public or domain-wide sharing. Grants to individual users/groups are not gated. | `false` |

### Google Docs (`services.docs.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `docs.access` | `string` | **Access level**<br/>Docs scopes to request. readonly: read document text and metadata only. write: full read/write (create documents, append and replace text, insert images and tables, and run arbitrary batchUpdate requests). | `"write"` |

### Google Drive (`services.drive.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `drive.access` | `string` | **Access level**<br/>Drive scopes to request. readonly: list, read metadata, download, and export only. write: full read/write (create, update, copy, move, trash, folders, and sharing). | `"write"` |
| `drive.allowHardDelete` | `boolean` | **Allow permanent delete**<br/>Off by default. When off, file_delete (which permanently deletes a file, bypassing Trash and irreversibly) is refused. Turn on to allow permanent deletion; file_trash is the recoverable alternative. | `false` |
| `drive.allowPublicSharing` | `boolean` | **Allow public / external sharing**<br/>Off by default. When off, permission_create refuses anyone-with-link grants and grants to a domain or user outside the account's own domain. Turn on to allow sharing files publicly or with external parties. | `false` |

### Gmail (`services.gmail.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `gmail.access` | `string` | **Access level**<br/>Gmail scopes to request. readonly: read only. modify: read + label/organize. send: modify + send mail. settings: modify + filters/IMAP/POP/vacation/forwarding. settings_sharing: settings + sendAs/delegation/S⁠MIME. full: complete mailbox access, required for permanent delete. | `"modify"` |
| `gmail.allowHardDelete` | `boolean` | **Allow permanent delete**<br/>Enable permanent message/thread deletion (requires full access tier). Disabled by default to protect against accidental data loss. | `false` |

### Google Sheets (`services.sheets.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `sheets.access` | `string` | **Access level**<br/>Sheets scopes to request. readonly: read values and metadata only. write: full read/write (create, update, append, clear, and structure changes such as add/delete/duplicate sheet). | `"write"` |

## Dependencies

- `google-api-python-client`
- `google-auth`
- `google-auth-oauthlib`
- `google-auth-httplib2`
- `idna` `>=3.15`
- `protobuf` `>=5.29.6`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_google_workspace)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
