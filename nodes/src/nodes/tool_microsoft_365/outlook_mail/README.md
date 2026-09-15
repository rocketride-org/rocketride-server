# Outlook Mail tool node (`tool_outlook_mail`)

Exposes the Microsoft Graph mail API as agent tools: list, search, and read
messages, send mail and replies/forwards, manage drafts, move/organize
messages and folders, manage attachments, and mark read state. Operates on
the acting user's mailbox.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is
a `@tool_function` an agent calls on demand. Operational targets (message id,
folder id, attachment id) are always tool-call parameters, never node
config. Outputs are cleaned shapes (`id`, `subject`, `from`, `toRecipients`,
`receivedDateTime`, `bodyPreview`, `isRead`, `hasAttachments`,
`parentFolderId`, plus a readable `body` on `outlook_mail_get_message`), not
raw Graph JSON.

## Configuration

| Field | Notes |
|-------|-------|
| `microsoft.authType` | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | Entra app credentials for `service` auth. |
| `microsoft.userPrincipalName` | Acting user's UPN for `service` auth (app-only calls target `/users/{upn}`). |
| `microsoft.oAuthButton` / `microsoft.userToken` | User OAuth: sign in to populate the access token. |
| `outlook_mail.access` | `readonly`, `send`, or `modify` (default). Resolved by the shared `OUTLOOK_MAIL` spec in `core/microsoft_access.py`; scopes are never hand-entered. |
| `outlook_mail.allowHardDelete` | Off by default. When off, delete moves messages to Deleted Items; permanent delete is refused. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `Mail.Read` | list, search, and read messages/folders/attachments only |
| `send` | `Mail.Read`, `Mail.Send` | readonly plus sending mail, replies, and forwards |
| `modify` | `Mail.ReadWrite`, `Mail.Send` | full read/write (default) — drafts, moves, organizing, attachments, and permanent delete (when `allowHardDelete` is on), plus send |

The `send` tier is nominally "writable" (only `readonly` is treated as
read-only) but does **not** carry `Mail.ReadWrite`: sending is gated on the
`Mail.Send` scope, and every drafting/organizing/attachment tool is
separately gated on `Mail.ReadWrite`, so a `send`-tier node can send and
reply but cannot create drafts, move messages, or touch folders/attachments.

### Gate flags

- **`allowHardDelete`**: off by default. When off, `outlook_mail_delete_message`
  moves a message to Deleted Items (recoverable) and
  `outlook_mail_permanently_delete` is refused. Turn on to allow permanent,
  irreversible delete.

## Tools

- **Read:** `outlook_mail_list_messages` (a folder's messages, search or
  OData filter), `outlook_mail_get_message` (full body, HTML converted to
  readable text), `outlook_mail_list_folders`, `outlook_mail_list_attachments`,
  `outlook_mail_get_attachment`.
- **Send (send/modify tier):** `outlook_mail_send_message`, `outlook_mail_reply`,
  `outlook_mail_reply_all`, `outlook_mail_forward`.
- **Modify (modify tier):** `outlook_mail_create_draft`, `outlook_mail_move_message`,
  `outlook_mail_set_read`, `outlook_mail_set_categories`,
  `outlook_mail_delete_message` (soft delete), `outlook_mail_create_folder`,
  `outlook_mail_add_attachment` (drafts only).
- **Delete (modify tier + gate):** `outlook_mail_permanently_delete` (gated by
  `allowHardDelete`).
- **Diagnostics:** `outlook_mail_check_connection` verifies that granted
  OAuth scopes cover the configured access tier.

## Setup

Authenticate with either an **Entra app** (`microsoft.tenantId` /
`microsoft.clientId` / `microsoft.clientSecret` / `microsoft.userPrincipalName`,
client-credentials flow) or **user OAuth** (click sign-in to populate
`microsoft.userToken`). See `microsoft-oauth.md` for the Entra app / consent
setup shared by every Microsoft 365 tool service. The app must be granted the
Graph `Mail.Read`, `Mail.Send`, and/or `Mail.ReadWrite` permission
(application or delegated, matching the auth mode and the configured tier)
with admin consent.

## Limits

- `outlook_mail_list_messages`' `query` is treated as a full-text `$search`
  term unless it looks like an OData filter expression (contains `eq`, `ne`,
  `gt`, `lt`, `ge`, `le`, `startswith(`, or `contains(`), in which case it is
  passed through as `$filter`.
- `outlook_mail_add_attachment` only works against a draft message — create
  one with `outlook_mail_create_draft` first.
- Rate limits are per Entra app / tenant; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent drafts a reply and attaches a file:

```text
outlook_mail_create_draft  { "to": ["alex@contoso.com"], "subject": "Re: Q3",
                              "body": "See attached." }
outlook_mail_add_attachment { "message_id": "<draft id>", "name": "q3.pdf",
                               "content_base64": "..." }
```

## Upstream docs

- Microsoft Graph mail API: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview
- Message: https://learn.microsoft.com/en-us/graph/api/resources/message
- Send mail: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Search messages: https://learn.microsoft.com/en-us/graph/search-query-parameter

## Troubleshooting

- **Scope / 403 errors:** call `outlook_mail_check_connection`; if scopes are
  missing, disconnect and reconnect the Microsoft account (user auth) or
  grant/consent the Entra app permission (service auth) at the required tier.
- **`access` is `readonly`:** every write/send tool raises
  `MicrosoftAccessError`; raise `outlook_mail.access` to `send` or `modify`.
- **`access` is `send` but drafts/moves/attachments are refused:** the `send`
  tier lacks `Mail.ReadWrite`; raise `outlook_mail.access` to `modify`.
- **Permanent delete refused:** needs `outlook_mail.allowHardDelete` enabled;
  `outlook_mail_delete_message` (soft delete to Deleted Items) is always
  available at the `modify` tier.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
