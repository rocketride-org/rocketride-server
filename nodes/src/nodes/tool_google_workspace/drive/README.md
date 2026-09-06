# Google Drive tool node (`tool_drive`)

Exposes the Google Drive API v3 as agent tools: list and search files, read
metadata, download binary files and export native Docs/Sheets/Slides,
create/update/copy/move files and folders, manage sharing (permissions),
trash/untrash, track changes, and permanently delete. Works across My Drive and
shared drives.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is a
`@tool_function` an agent calls on demand. Operational targets (`fileId`,
`folderId`, `permissionId`) are always tool-call parameters, never node config.
Outputs are cleaned shapes (`id`, `name`, `mimeType`, `parents`, `webViewLink`,
`modifiedTime`, `size`, `trashed`, `driveId`), not raw API JSON. Every file
operation sets `supportsAllDrives` so shared-drive items work transparently.

## Configuration

| Field | Notes |
|-------|-------|
| `google.authType` | `service` (service account) or `user` (OAuth). |
| `google.serviceKey` / `google.adminEmail` | Service account JSON key; `adminEmail` enables domain-wide delegation (impersonate that user) and sets the account's own domain for the sharing gate. |
| `google.oAuthButton` / `google.userToken` | User OAuth: sign in to populate the access token. |
| `drive.access` | `readonly` or `write` (default). Resolved by the shared `DRIVE` spec in `core/google_access.py`; scopes are never hand-entered. |
| `drive.allowPublicSharing` | Off by default. Gate for anyone-with-link and external-domain grants (see Sharing gate). |
| `drive.allowHardDelete` | Off by default. Gate for `file_delete` (permanent delete, bypasses Trash, irreversible). |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `drive.readonly` | list/search, read metadata and permissions, download, export |
| `write` | `drive` | full read/write (default) |

## Tools

- **Read:** `file_list` (optional query `q`), `file_search` (query required),
  `file_get` (metadata), `file_download` (non-native binary → base64),
  `file_export` (native Docs/Sheets/Slides → base64 in a chosen format),
  `drives_list` (shared drives), `changes_list` (change tracking),
  `permission_list` (sharing entries).
- **Write:** `file_create`, `file_update`, `file_copy`, `file_move`,
  `file_trash`, `file_untrash`, `folder_create`, `permission_update`,
  `permission_delete`, `permission_create`.
- **Gated:** `file_delete` (permanent delete).
- **Diagnostics:** `check_connection` probes the Drive API with a live call;
  for user OAuth it also verifies that granted scopes cover the configured
  access tier (service-account auth has no per-user scope grant to check).

### Download vs. export (native files)

Google-native files (Docs, Sheets, Slides — `mimeType`
`application/vnd.google-apps.*`) have **no binary blob**. `file_download`
**refuses** them with a pointer to `file_export`. Use `file_export` with a
target `mimeType` (e.g. `application/pdf`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` for
`.docx`, `text/csv` for Sheets) to render native files into a real format. Both
return `{fileId, mimeType, size, data_base64}`. `file_download` caps at 10 MiB
(checked via metadata first); `file_export` is capped at ~10 MiB by Google.
`file_export`'s PDF/`.docx` output is what feeds the `tool_docs` / #1058 export
workflow.

### Sharing gate (`permission_create` + `allowPublicSharing`)

Granting access is gated so an agent cannot silently make files public or share
them externally. The account's **own domain** is resolved from `adminEmail`
(service auth) or from the user token's `hd`/`email` claim (user auth); when it
can't be determined it is **unknown**.

| Grant `type` | Requires `allowPublicSharing`? |
|--------------|--------------------------------|
| `anyone` (public link) | Always. |
| `domain` == account's own domain | No. |
| `domain` != own domain (or unknown) | Yes. |
| `user` / `group`, same domain as account | No. |
| `user` / `group`, different domain (account domain known) | Yes. |
| `user` / `group`, account domain **unknown** | No — treated as internal. |

Both the public-link and external-party cases are gated by the single
`allowPublicSharing` flag. When it is off, a gated grant raises
`GoogleAccessError` naming the flag. `user`/`group` grants always send a
notification email by default (`sendNotificationEmail`, default `true`).

Moving or copying a file into an already-public folder inherits that folder's
ACL, which is a sharing path this gate cannot see.

### Hard-delete gate (`file_delete` + `allowHardDelete`)

`file_delete` **permanently** removes a file, bypassing Trash — **irreversible**.
It requires the `write` tier **and** the `allowHardDelete` flag. `file_trash`
(recoverable) is the safe alternative and needs only `write`.

### Shared drives

Every file operation passes `supportsAllDrives=True` (and reads pass
`includeItemsFromAllDrives=True`), so files on shared drives are visible and
mutable. `file_list`/`file_search` accept `driveId` + `corpora` to scope a
search to one shared drive; `drives_list` enumerates accessible shared drives;
`changes_list` accepts a `driveId` to track a specific shared drive.

## Setup

Authenticate with either a Google **service account** (`google.serviceKey` JSON,
optionally `google.adminEmail` for domain-wide delegation) or **user OAuth**
(click sign-in to populate `google.userToken`). The Drive API must be enabled on
the Google Cloud project backing the credential.

## Limits

- `file_download` caps at 10 MiB (checked from metadata before fetching);
  `file_export` at Google's ~10 MiB export limit.
- List calls page with `pageToken`; `pageSize` clamps to 1–100 (default 25).
- Rate limits are per Google project; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

```text
file_search   { "q": "name contains 'invoice' and trashed = false" }
file_get      { "fileId": "1AbC..." }
file_export   { "fileId": "1Doc...", "mimeType": "application/pdf" }
file_trash    { "fileId": "1AbC..." }
```

## Upstream docs

- Google Drive API v3: https://developers.google.com/drive/api/reference/rest/v3
- Search query syntax: https://developers.google.com/drive/api/guides/search-files
- Exporting native files: https://developers.google.com/drive/api/guides/manage-downloads

## Troubleshooting

- **Scope / 403 errors:** call `check_connection`; if scopes are missing,
  disconnect and reconnect the Google account at the required access tier.
- **`access` is read-only:** write operations raise `GoogleAccessError`; raise
  `drive.access` to `write`.
- **Sharing refused:** the grant is public/external and `allowPublicSharing` is
  off — enable it, or grant to an internal user/domain.
- **Delete refused:** `file_delete` needs `allowHardDelete`; use `file_trash`
  for a recoverable delete.
- **`file_download` refused:** the file is Google-native — use `file_export`.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
