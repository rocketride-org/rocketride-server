# Gmail tool node (`tool_gmail`)

Exposes the Gmail v1 API as agent tools: read/search/organize mail, manage
labels and drafts, send (including in-thread replies), and—when explicitly
enabled—permanently delete.

## Configuration

| Field | Notes |
|-------|-------|
| `google.authType` | `service` (service account) or `user` (OAuth). |
| `google.serviceKey` / `google.adminEmail` | Service account JSON key; adminEmail enables domain-wide delegation (impersonate that user). |
| `google.oAuthButton` / `google.userToken` | User OAuth: sign in to populate the access token. |
| `gmail.access` | `readonly` → `modify` → `send` → `full`. Resolved by the shared `GMAIL` spec in `core/google_access.py`; scopes are never hand-entered. |
| `gmail.allowHardDelete` | Off by default. Gate for permanent delete; only effective with `access: full`. |

## Access tiers → scopes

| Tier | Scope(s) | Capability |
|------|----------|------------|
| `readonly` | `gmail.readonly` | read/search only |
| `modify` | `gmail.modify` | read + label/organize (default) |
| `send` | `gmail.modify`, `gmail.send` | + send mail |
| `full` | `https://mail.google.com/` | + permanent delete (with `allowHardDelete`) |

## Tools

- **Read/sync:** `message_list`, `message_get`, `message_search`, `thread_get`,
  `thread_list`, `label_list`, `draft_list`, `draft_get`, `attachment_get`,
  `history_list`.
- **Organize (write):** `message_modify`, `message_batch_modify`, `label_apply`,
  `label_remove`, `label_create`, `label_update`, `label_delete`. Change read
  state by adding/removing the `UNREAD` label via `message_modify` /
  `message_batch_modify`.
- **Write:** `message_send` (reply in-thread via `threadId`), `message_trash`,
  `message_untrash`, `draft_create`, `draft_update`, `draft_send`,
  `draft_delete`. Sending requires the `send` or `full` tier.
- **Permanent delete (gated):** `message_delete`, `messages_batchDelete` —
  require `allowHardDelete` **and** the `full` tier; batch ops take an explicit
  id list (never a query), capped at 1000 per call.

Operational targets (`messageId`, `threadId`, `labelId`, `query`) are always
tool-call parameters, never node config. Outputs are cleaned shapes (ids,
labelIds, snippet, headers, threadId, historyId), not raw API JSON.
