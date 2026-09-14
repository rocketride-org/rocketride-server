# OneDrive tool node (`tool_onedrive`)

Exposes the Microsoft Graph drive API as agent tools: list and search files
and folders, read metadata, download and upload content, create folders,
copy/move/rename items, trash/restore, and manage sharing (links and
permission grants). Operates on the acting user's OneDrive.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is
a `@tool_function` an agent calls on demand. Operational targets (item path
or id, folder, permission id) are always tool-call parameters, never node
config. Outputs are cleaned shapes (`id`, `name`, `size`, `webUrl`,
`folder`/`file`, `lastModifiedDateTime`, `parentReference.path`), not raw
Graph JSON.

Items are addressed by either a drive-relative path (`'Reports/q3.pdf'`) or a
drive item id — whichever the caller has on hand. The rule (shared
`looks_like_item_id()` in `client.py`): the literal `root`, or a value that is
**15+ characters drawn only from `[A-Za-z0-9!]`** (Graph item ids look like
`01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K`), is treated as an item id; anything else
— including a bare root-level filename such as `report.pdf` — is treated as a
path under the drive root.

## Configuration

| Field | Notes |
|-------|-------|
| `microsoft.authType` | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | Entra app credentials for `service` auth. |
| `microsoft.userPrincipalName` | Acting user's UPN for `service` auth (app-only calls target `/users/{upn}`). |
| `microsoft.oAuthButton` / `microsoft.userToken` | User OAuth: sign in to populate the access token. |
| `onedrive.access` | `readonly` or `write` (default). Resolved by the shared `ONEDRIVE` spec in `core/microsoft_access.py`; scopes are never hand-entered. |
| `onedrive.allowPublicSharing` | Off by default. Gates anonymous sharing links and invites to non-individual recipients. |
| `onedrive.allowHardDelete` | Off by default. Gates `onedrive_permanently_delete`; trash/restore are always available. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `Files.Read` | list, search, read metadata, and download only |
| `write` | `Files.ReadWrite` (+ requests `User.ReadBasic.All` at sign-in) | full read/write (default); the optional directory scope backs the invite gate and is unavailable to personal accounts |

### Gate flags

- **`allowPublicSharing`**: off by default. When off, `onedrive_create_sharing_link`
  refuses `scope="anonymous"` links, and `onedrive_invite` looks up every
  recipient in the directory (`GET /users/{email}`) and refuses the whole
  invite if any recipient fails to resolve to an individual directory user —
  distribution lists and unresolvable addresses included. Fails closed: a
  lookup permission error is treated the same as a non-user address.
- **`allowHardDelete`**: off by default. When off, `onedrive_permanently_delete`
  is refused; `onedrive_trash` is always available as the recoverable
  alternative (see the `onedrive_restore` limit below).

## Tools

- **Read:** `onedrive_list_items` (a folder's children), `onedrive_search`,
  `onedrive_get_metadata`, `onedrive_download` (inline base64 ≤ 1 MiB, else a
  `downloadUrl`).
- **Write:** `onedrive_upload` (simple PUT ≤ 4 MB, else a chunked resumable
  session), `onedrive_create_folder`, `onedrive_copy`, `onedrive_move`,
  `onedrive_rename`.
- **Trash / restore / delete (write):** `onedrive_trash`, `onedrive_restore`,
  `onedrive_permanently_delete` (gated by `allowHardDelete`).
- **Sharing (write):** `onedrive_create_sharing_link` (gated by
  `allowPublicSharing` for anonymous links), `onedrive_list_permissions`
  (read-only), `onedrive_invite` (gated by `allowPublicSharing`; recipients
  must resolve to individual directory users otherwise), `onedrive_delete_permission`.
- **Diagnostics:** `onedrive_check_connection` verifies that granted OAuth
  scopes cover the configured access tier.

## Setup

Authenticate with either an **Entra app** (`microsoft.tenantId` /
`microsoft.clientId` / `microsoft.clientSecret` / `microsoft.userPrincipalName`,
client-credentials flow) or **user OAuth** (click sign-in to populate
`microsoft.userToken`). See `microsoft-oauth.md` for the Entra app / consent
setup shared by every Microsoft 365 tool service. The Graph permissions differ
by auth mode:

| Auth mode | Tier | Graph permission | Invite directory lookup (`allowPublicSharing` off) |
|-----------|------|------------------|-----------------------------------------------------|
| User OAuth (delegated) | `readonly` | `Files.Read` | `User.ReadBasic.All` (requested at sign-in; unavailable to personal accounts) |
| User OAuth (delegated) | `write` | `Files.ReadWrite` | `User.ReadBasic.All` |
| Entra app (application, admin consent) | `readonly` | `Files.Read.All` | `User.Read.All` |
| Entra app (application, admin consent) | `write` | `Files.ReadWrite.All` | `User.Read.All` |

Application permissions always require admin consent. The directory-lookup
permission is only needed when `onedrive.allowPublicSharing` is off and the
agent calls `onedrive_invite`; without it the invite fails closed with a hint
naming the missing scope.

## Limits

- `onedrive_copy` runs asynchronously on Graph's side; the tool returns once
  the copy is accepted, not once it completes.
- `onedrive_upload` chunks large files at 5 MiB per PUT to the resumable
  upload session, per Graph's recommended chunk size.
- Rate limits are per Entra app / tenant; the node retries `429`/`5xx` with
  exponential backoff (chunked-upload PUTs included — they are idempotent by
  `Content-Range`).
- `onedrive_restore` is **OneDrive Personal only** — Microsoft Graph does not
  support `POST /drive/items/{id}/restore` for work or school accounts. The
  tool refuses up front under Entra app (service) auth; a work/school user
  OAuth account surfaces Graph's own error. Use the OneDrive web recycle bin
  instead.

## Examples

An agent uploads a report, then shares it with a named colleague:

```text
onedrive_upload  { "path": "Reports/q3.pdf", "content_base64": "..." }
onedrive_invite  { "item": "Reports/q3.pdf", "emails": ["alex@contoso.com"],
                    "role": "read" }
```

## Upstream docs

- Microsoft Graph OneDrive API: https://learn.microsoft.com/en-us/graph/api/resources/onedrive
- DriveItem: https://learn.microsoft.com/en-us/graph/api/resources/driveitem
- Upload large files: https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
- Sharing: https://learn.microsoft.com/en-us/graph/api/driveitem-createlink

## Troubleshooting

- **Scope / 403 errors:** call `onedrive_check_connection`; if scopes are
  missing, disconnect and reconnect the Microsoft account (user auth) or
  grant/consent the Entra app permission (service auth) at the required tier.
- **`access` is read-only:** write tools raise `MicrosoftAccessError`; raise
  `onedrive.access` to `write`.
- **Sharing/invite refused:** anonymous links, and invites to any recipient
  that doesn't resolve to an individual directory user (including a lookup
  permission error), need `onedrive.allowPublicSharing` enabled; permanent
  delete needs `onedrive.allowHardDelete` enabled.
- **Item not found:** confirm whether the caller meant a path or an item id —
  a value without `/` is always treated as an item id, never a bare
  root-level filename.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
