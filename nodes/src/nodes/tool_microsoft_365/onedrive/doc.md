# OneDrive

Microsoft OneDrive file operations exposed as agent **tools**, backed by the
[Microsoft Graph drive API](https://learn.microsoft.com/en-us/graph/api/resources/onedrive).
Operates on the acting user's OneDrive.

## What it does

List and search files and folders; read metadata; download and upload
content; create folders; copy, move, and rename items; trash and restore;
and manage sharing (links, permission grants, and invites). Items are
addressed by drive-relative path or item id: the literal `root`, or a value of
15+ characters drawn only from `[A-Za-z0-9!]` (the shape of a Graph item id), is
treated as an item id; anything else — including a bare root-level filename
such as `report.pdf` — is treated as a path under the drive root.

## Agent tools

| Tool | Graph call | Purpose |
| --- | --- | --- |
| `onedrive_list_items` | `GET /drive/root(:/{folder}:)/children` | List a folder's items (root by default). |
| `onedrive_search` | `GET /drive/root/search(q=...)` | Search files and folders by name/content. |
| `onedrive_get_metadata` | `GET /drive/items/{item}` | Read one item's metadata. |
| `onedrive_download` | `GET .../content` | Download content (inline base64 ≤ 1 MiB, else a `downloadUrl`). |
| `onedrive_upload` | `PUT .../content` or `POST .../createUploadSession` | Upload/overwrite a file (chunked above 4 MB). |
| `onedrive_create_folder` | `POST .../children` | Create a folder inside a parent folder. |
| `onedrive_copy` | `POST .../copy` | Copy a file or folder (async). |
| `onedrive_move` | `PATCH /drive/items/{item}` | Move an item to another folder. |
| `onedrive_rename` | `PATCH /drive/items/{item}` | Rename an item in place. |
| `onedrive_trash` | `DELETE /drive/items/{item}` | Move an item to the recycle bin. |
| `onedrive_restore` | `POST /drive/items/{item}/restore` | Restore a trashed item. **OneDrive Personal only** (Graph limitation): refused under `service` auth; work/school accounts get Graph's error. |
| `onedrive_permanently_delete` | `POST .../permanentDelete` | Permanently delete an item (gated). |
| `onedrive_create_sharing_link` | `POST .../createLink` | Create a view/edit sharing link (anonymous scope gated). |
| `onedrive_list_permissions` | `GET .../permissions` | List sharing permissions on an item. |
| `onedrive_invite` | `POST .../invite` | Invite people by email (non-individual recipients gated via directory lookup). |
| `onedrive_delete_permission` | `DELETE .../permissions/{id}` | Revoke a sharing permission. |
| `onedrive_check_connection` | `GET /drive` + scope report | Diagnostics — connection and scope coverage. |

## Wiring

This is a `tool` node: wire it to an agent via `control` (class `tool`),
alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_onedrive_1",
  "provider": "tool_onedrive",
  "config": { "type": "tool_onedrive" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers the `onedrive_*` tools and calls them per its instructions.

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `microsoft.authType` | yes | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | for `service` | Entra app registration credentials. |
| `microsoft.userPrincipalName` | for `service` | Acting user's UPN — app-only calls target `/users/{upn}`. |
| `microsoft.userToken` | for `user` | Populated by the sign-in button; broker-refreshed. |
| `onedrive.access` | no | `readonly` or `write` (default). Resolved by the shared `ONEDRIVE` access spec — scopes are never hand-entered. |
| `onedrive.allowPublicSharing` | no | Off by default; gates anonymous sharing links and invites to non-individual recipients. |
| `onedrive.allowHardDelete` | no | Off by default; gates `onedrive_permanently_delete`. |

## Where to get your credentials

Register an app in the **Entra admin center** (`entra.microsoft.com` → App
registrations) and grant it the Graph permission matching the auth mode and
tier, then admin consent:

- **User OAuth (delegated):** `Files.Read` (`readonly`) or `Files.ReadWrite`
  (`write`); plus `User.ReadBasic.All` for the `onedrive_invite` directory
  lookup when `allowPublicSharing` is off (not available to personal accounts).
- **Entra app (application, admin consent required):** `Files.Read.All`
  (`readonly`) or `Files.ReadWrite.All` (`write`); plus `User.Read.All` for the
  invite directory lookup when `allowPublicSharing` is off.

See
`microsoft-oauth.md` for the full setup shared by every Microsoft 365 tool
service (excel, word, onedrive, outlook mail, outlook calendar).

Never commit credentials; use node config (encrypted) or Entra app secret
rotation.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
