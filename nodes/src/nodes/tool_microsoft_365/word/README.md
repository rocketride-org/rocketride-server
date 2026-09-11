# Word tool node (`tool_word`)

Exposes a docx round-trip over the Microsoft Graph drive content API as agent
tools: read text, create a document from paragraphs, append text, find/replace
text, and export to PDF. Operates on `.docx` files in the acting user's
OneDrive, editing them in-process with `python-docx`.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is
a `@tool_function` an agent calls on demand. Operational targets (file
path/id, new-document destination path) are always tool-call parameters,
never node config. Outputs are cleaned shapes (`id`, `name`, `webUrl`, text),
not raw Graph JSON and never the raw docx/PDF bytes.

There is no persisted Word Online editing session. Every write downloads the
current `.docx` (`GET` metadata for the eTag, then `GET .../content`), edits
it in-process, and re-uploads the whole file (`PUT .../content`) with an
`If-Match` header carrying that eTag — Graph rejects the write with
`409`/`412` if the file changed in between, which surfaces as a `GraphError`
naming the conflict rather than silently last-writer-wins overwriting someone
else's edit. On a conflict, re-read with `word_read_text` and retry.

## Configuration

| Field | Notes |
|-------|-------|
| `microsoft.authType` | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | Entra app credentials for `service` auth. |
| `microsoft.userPrincipalName` | Acting user's UPN for `service` auth (app-only calls target `/users/{upn}`). |
| `microsoft.oAuthButton` / `microsoft.userToken` | User OAuth: sign in to populate the access token. |
| `word.access` | `readonly` or `write` (default). Resolved by the shared `WORD` spec in `core/microsoft_access.py`; scopes are never hand-entered. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `Files.Read` | read document text only |
| `write` | `Files.ReadWrite` | full read/write (default) |

There are no destructive gate flags.

## Tools

- **Read:** `word_read_text` — every body paragraph plus every table cell's
  text, newline-joined.
- **Write:** `word_create_document` (new `.docx` from a paragraph list, no
  `If-Match` — nothing to conflict with yet), `word_append_text` (append
  paragraphs, `If-Match`-guarded), `word_replace_text` (find/replace across
  paragraphs and table cells, `If-Match`-guarded, returns a replacement
  count), `word_export_pdf` (server-side PDF conversion, uploaded beside the
  source; returns file metadata, never the PDF bytes).
- **Diagnostics:** `word_check_connection` verifies that granted OAuth scopes
  cover the configured access tier.

### `word_replace_text` approach

Replacement runs in a single pass per paragraph (body and table cells
alike), scanning each paragraph's *original* text exactly once:

- `original = paragraph.text` (the concatenation of all its runs) is
  scanned for `find` and the count and replacement are both computed from
  that one, never-mutated string. Scanning already-replaced text instead
  (a run-then-paragraph two-pass approach) is how a `replace` value that
  itself contains `find` would double-count and corrupt the result — e.g.
  `find='foo'`, `replace='foobar'` on `'foo is here'` would match once,
  rewrite it to `'foobar is here'`, then find `'foo'` again inside the
  freshly written `'foobar'` on a second pass, ending with a wrong count
  of 2 and corrupted text `'foobarbar is here'`. A single pass over the
  original text avoids this entirely.
- Paragraphs with **zero** matches are left completely untouched — no run
  is touched, no formatting is disturbed.
- Paragraphs with **at least one** match get their new text written into
  the first run, with every other run in that paragraph blanked. The
  first run's formatting wins for the whole merged text — a multi-run
  paragraph that matches loses its intra-paragraph formatting boundaries
  (bold/italic spans, etc.) on replacement. This is a known trade-off of a
  plain read-modify-write text replace, not a substitute for a real Word
  editing session.

## Setup

Authenticate with either an **Entra app** (`microsoft.tenantId` /
`microsoft.clientId` / `microsoft.clientSecret` / `microsoft.userPrincipalName`,
client-credentials flow) or **user OAuth** (click sign-in to populate
`microsoft.userToken`). See `microsoft-oauth.md` for the Entra app / consent
setup shared by every Microsoft 365 tool service. The Graph permission the
app needs depends on the auth mode:

| Auth mode | Tier | Graph permission |
| --- | --- | --- |
| User OAuth (delegated) | `readonly` | `Files.Read` |
| User OAuth (delegated) | `write` | `Files.ReadWrite` |
| Entra app (application, admin consent) | `readonly` | `Files.Read.All` |
| Entra app (application, admin consent) | `write` | `Files.ReadWrite.All` |

Application permissions always require admin consent. Unlike the Excel
workbook API, Word's drive-item download/upload/convert calls work app-only,
so both auth modes are fully supported.

## Limits

- Concurrency: round-trip edits (`word_append_text`, `word_replace_text`) use
  `If-Match`; a stale eTag (someone else edited the file since it was
  downloaded) surfaces as a `GraphError` naming the conflict. The tool does
  not retry automatically — re-read with `word_read_text` and retry the edit.
- `word_export_pdf` relies on Graph's server-side format conversion
  (`?format=pdf`); very large or exotic documents may take longer to convert
  or fail conversion upstream.
- `word_replace_text` writes a matched paragraph's new text into its first
  run and blanks the rest, collapsing per-run formatting in that paragraph to
  the first run's style — acceptable for plain text edits, not a substitute
  for a real Word editing session. Unmatched paragraphs are untouched.
- Rate limits are per Entra app / tenant; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent creates a report, then finds and replaces a placeholder:

```
word_create_document  { "path": "Docs/report.docx",
                         "paragraphs": ["Q3 Report", "Status: DRAFT"] }
word_replace_text      { "file": "Docs/report.docx", "find": "DRAFT",
                          "replace": "FINAL" }
```

## Upstream docs

- Microsoft Graph drive content API: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
- DriveItem format conversion: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format
- python-docx: https://python-docx.readthedocs.io/

## Troubleshooting

- **Scope / 403 errors:** call `word_check_connection`; if scopes are
  missing, disconnect and reconnect the Microsoft account (user auth) or
  grant/consent the Entra app permission (service auth) at the required tier.
- **`access` is read-only:** write tools raise `MicrosoftAccessError`; raise
  `word.access` to `write`.
- **Conflict / 409 / 412 errors:** the file changed since it was downloaded
  (someone else edited it, or a prior call's upload already advanced the
  eTag). Call `word_read_text` to get the current content and retry the edit.
- **`word_replace_text` returns 0:** confirm the exact text — `find` is a
  literal (case-sensitive) substring match, not a regex.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
