# tool_google_workspace

A RocketRide tool node that exposes Google Workspace operations to an AI agent.

## What it does

Registers five separate tool surfaces an agent can call. Each ships its own service
definition and its own access controls, so a pipeline can enable only what it needs:

| Service | File | What the agent can do |
|---|---|---|
| **Gmail** | `services.gmail.json` | Read, search, label, draft, send, and organize mail |
| **Drive** | `services.drive.json` | List and search files, read metadata, download binaries, export native Docs/Sheets/Slides, create/update/copy/move files and folders, manage sharing, trash and untrash, track changes. Supports My Drive and shared drives |
| **Calendar** | `services.calendar.json` | List, get, create, update, move, and delete events (including recurring-series instances and natural-language quick-add); query free/busy; manage calendars and ACL rules. Supports incremental sync via `syncToken` |
| **Docs** | `services.docs.json` | Read document text; create documents; append and replace text; insert images and tables; run arbitrary `batchUpdate` requests |
| **Sheets** | `services.sheets.json` | Read, write, append, and clear cell values; create spreadsheets; add, delete, duplicate, and copy sheets; run arbitrary `batchUpdate` requests |

Authenticates via a **Google service account** or **user OAuth**.

This is a tool node, not a filter: it has no image or text lanes. It is invoked by an
agent rather than placed in a streaming path.

### What is gated, and what is not

Two different mechanisms, and only one of them defaults to safe.

**Irreversible and public-facing operations are opt-in.** Permanent deletion
(`allowHardDelete` on Gmail and Drive, `allowDelete` on Calendar) and public or
domain-wide sharing (`allowPublicSharing` on Drive and Calendar) are separate booleans,
each defaulting to `false`. They must be turned on deliberately.

**Ordinary writes are not.** The per-service `access` field defaults to `write` on
Drive, Calendar, Docs, and Sheets, and to `modify` (read + organize) on Gmail. So an
agent can create, update, and move files, edit documents, and create calendar events
without any flag being enabled — and calendar writes send invitations to attendees,
which is externally visible. Gmail is the exception in one direction: `send` is a
higher level than the `modify` default, so sending mail does require raising `access`.

Set `access` to `readonly` for any service the pipeline only needs to read from. That
field, not the boolean flags, is what bounds the agent's day-to-day reach.

---

## Configuration

### Fields

| Field | Type | Description |
|---|---|---|
| `gmail.access` | string | Default `"modify"`. Gmail access level |
| `gmail.allowHardDelete` | boolean | Default false. Allow permanent deletion of mail |
| `drive.access` | string | Default `"write"`. Drive access level |
| `drive.allowPublicSharing` | boolean | Default false. Allow public / external sharing |
| `drive.allowHardDelete` | boolean | Default false. Allow permanent delete |
| `calendar.access` | string | Default `"write"`. Calendar access level |
| `calendar.allowDelete` | boolean | Default false. Allow event / calendar deletion |
| `calendar.allowPublicSharing` | boolean | Default false. Allow public / domain-wide calendar sharing |
| `docs.access` | string | Default `"write"`. Docs access level |
| `sheets.access` | string | Default `"write"`. Sheets access level |
