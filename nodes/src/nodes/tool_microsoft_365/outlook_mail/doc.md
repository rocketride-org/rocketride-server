# Outlook Mail

Microsoft Outlook Mail operations exposed as agent **tools**, backed by the
[Microsoft Graph mail API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview).
Operates on the acting user's mailbox.

## What it does

List, search, and read messages; send mail and replies/forwards; manage
drafts; move and organize messages and folders; manage attachments; and mark
read state / category labels. Three access tiers gate the surface —
`readonly`, `send`, and `modify` (default) — with sending and mutation each
checked against the Graph scope that actually backs them, not just the
tier's write/read-only label.

## Agent tools

| Tool | Graph call | Purpose |
| --- | --- | --- |
| `outlook_mail_list_messages` | `GET /mailFolders/{folder}/messages` | List a folder's messages (inbox by default), search or OData filter. |
| `outlook_mail_get_message` | `GET /messages/{id}` | Get one message with its full body (HTML converted to readable text). |
| `outlook_mail_send_message` | `POST /sendMail` | Send an email immediately (send/modify tier). |
| `outlook_mail_create_draft` | `POST /messages` | Create a draft message (modify tier). |
| `outlook_mail_reply` | `POST /messages/{id}/reply` | Reply to the sender only (send/modify tier). |
| `outlook_mail_reply_all` | `POST /messages/{id}/replyAll` | Reply to all recipients (send/modify tier). |
| `outlook_mail_forward` | `POST /messages/{id}/forward` | Forward to new recipients (send/modify tier). |
| `outlook_mail_move_message` | `POST /messages/{id}/move` | Move a message to another folder (modify tier). |
| `outlook_mail_set_read` | `PATCH /messages/{id}` | Mark a message read/unread (modify tier). |
| `outlook_mail_set_categories` | `PATCH /messages/{id}` | Replace a message's category labels (modify tier). |
| `outlook_mail_delete_message` | `POST /messages/{id}/move` (to `deleteditems`) | Soft delete — move to Deleted Items (modify tier). |
| `outlook_mail_permanently_delete` | `DELETE /messages/{id}` | Permanently delete (modify tier + `allowHardDelete` gate). |
| `outlook_mail_list_folders` | `GET /mailFolders` | List the mailbox's mail folders. |
| `outlook_mail_create_folder` | `POST /mailFolders[/{parent}/childFolders]` | Create a mail folder (modify tier). |
| `outlook_mail_list_attachments` | `GET /messages/{id}/attachments` | List attachment metadata on a message. |
| `outlook_mail_get_attachment` | `GET /messages/{id}/attachments/{id}` | Download an attachment's content (base64). |
| `outlook_mail_add_attachment` | `POST /messages/{id}/attachments` | Attach a file to a draft message (modify tier). |
| `outlook_mail_check_connection` | `GET /mailFolders/inbox` + scope report | Diagnostics — connection and scope coverage. |

## Wiring

This is a `tool` node: wire it to an agent via `control` (class `tool`),
alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_outlook_mail_1",
  "provider": "tool_outlook_mail",
  "config": { "type": "tool_outlook_mail" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers the `outlook_mail_*` tools and calls them per its instructions.

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `microsoft.authType` | yes | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | for `service` | Entra app registration credentials. |
| `microsoft.userPrincipalName` | for `service` | Acting user's UPN — app-only calls target `/users/{upn}`. |
| `microsoft.userToken` | for `user` | Populated by the sign-in button; broker-refreshed. |
| `outlook_mail.access` | no | `readonly`, `send`, or `modify` (default). Resolved by the shared `OUTLOOK_MAIL` access spec — scopes are never hand-entered. |
| `outlook_mail.allowHardDelete` | no | Off by default; gates `outlook_mail_permanently_delete`. |

## Where to get your credentials

Register an app in the **Entra admin center** (`entra.microsoft.com` → App
registrations), grant it the Graph `Mail.Read`, `Mail.Send`, and/or
`Mail.ReadWrite` application permission (or delegated, for user OAuth)
matching the configured tier, with admin consent. See `microsoft-oauth.md`
for the full setup shared by every Microsoft 365 tool service (excel, word,
onedrive, outlook mail, outlook calendar).

Never commit credentials; use node config (encrypted) or Entra app secret
rotation.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
