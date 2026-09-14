# Google Docs tool node (`tool_docs`)

Exposes the Google Docs API v1 as agent tools: read a document's text; create
documents; append and replace text; insert inline images and tables; and run
arbitrary `batchUpdate` requests (styling, named ranges, positioned inserts,
deletes).

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is a
`@tool_function` an agent calls on demand. Operational targets (`documentId`)
are always tool-call parameters, never node config. Outputs are cleaned shapes
(`documentId`, `title`, `revisionId`, `body_text`, `replies_count`,
`occurrencesChanged`), not raw API JSON.

## Configuration

| Field | Notes |
|-------|-------|
| `google.authType` | `service` (service account) or `user` (OAuth). |
| `google.serviceKey` / `google.adminEmail` | Service account JSON key; `adminEmail` enables domain-wide delegation (impersonate that user). |
| `google.oAuthButton` / `google.userToken` | User OAuth: sign in to populate the access token. |
| `docs.access` | `readonly` or `write` (default). Resolved by the shared `DOCS` spec in `core/google_access.py`; scopes are never hand-entered. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `documents.readonly` | read document text + metadata only |
| `write` | `documents` | full read/write (default) |

There are no destructive gate flags. Permanent document deletion is a Drive
operation and lives in `tool_drive`.

## Tools

- **Read:** `document_get` — returns `{documentId, title, revisionId,
  body_text}`, where `body_text` is the concatenated plain text of the
  paragraph text runs. Long documents are capped at 50,000 characters and
  flagged with `truncated: true`. Works at the `readonly` tier.
- **Write:** `document_create` (create a document, optionally seeding initial
  body text via a follow-up `insertText`), `batch_update` (the catch-all: pass
  the full Docs `batchUpdate` request list).
- **Convenience wrappers (write)** over `batch_update`, so an agent needn't do
  index math:
  - `text_append` — append text at the end of the body
    (`insertText` at `endOfSegmentLocation`).
  - `text_replace` — replace all occurrences of a string (`replaceAllText`);
    `matchCase` defaults to `false`. Returns `occurrencesChanged`.
  - `image_insert` — insert an inline image at the end of the body
    (`insertInlineImage`); the `uri` **must** be a public `https://` URL.
    Optional `width`/`height` in points (PT).
  - `table_insert` — insert an empty `rows`×`columns` table at the end of the
    body (`insertTable`); `rows` is clamped to 1..1000 and `columns` to 1..25.
- **Diagnostics:** `check_connection` probes the Docs API with a live call; for
  user OAuth it also verifies that granted scopes cover the configured access
  tier (service-account auth has no per-user scope grant to check).

The entire Docs v1 surface is `documents().get` / `create` / `batchUpdate`; the
wrappers are conveniences over `batch_update`.

## Setup

Authenticate with either a Google **service account** (`google.serviceKey` JSON,
optionally `google.adminEmail` for domain-wide delegation) or **user OAuth**
(click sign-in to populate `google.userToken`). The Google Docs API must be
enabled on the Google Cloud project backing the credential.

## Limits

- **Export is not a Docs operation.** Exporting a document to PDF or `.docx` is a
  Drive export, not a Docs API call — use `tool_drive`'s `file_export`
  (issue #1056), not this node.
- `document_get`'s `body_text` is capped at 50,000 characters (`truncated: true`
  when the document is longer) and covers paragraph text runs only — table
  cells, headers/footers, and footnotes are not concatenated. For full
  structure use `batch_update` reads or the raw document.
- `batch_update` request bodies follow Google's Docs `batchUpdate` limits.
- Rate limits are per Google project; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent creates a document, appends text, then inserts a table:

```
document_create { "title": "Weekly Report", "text": "Summary\n" }
text_append     { "documentId": "1AbC...", "text": "\nMetrics below:\n" }
table_insert    { "documentId": "1AbC...", "rows": 3, "columns": 2 }
```

Replace a placeholder throughout a template:

```
text_replace    { "documentId": "1AbC...", "containsText": "{{name}}",
                  "text": "Ada Lovelace", "matchCase": true }
```

## Upstream docs

- Google Docs API v1: https://developers.google.com/docs/api/reference/rest
- `documents.batchUpdate`: https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate
- Request types (insertText, replaceAllText, insertInlineImage, insertTable): https://developers.google.com/docs/api/reference/rest/v1/documents/request

## Troubleshooting

- **Scope / 403 errors:** call `check_connection`; if scopes are missing,
  disconnect and reconnect the Google account at the required access tier.
- **`access` is read-only:** write operations raise `GoogleAccessError`; raise
  `docs.access` to `write`.
- **`image_insert` rejects the URL:** the `uri` must be a public `https://` URL
  Google can fetch (not `http://`, a data URL, or a private/authenticated link).

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
