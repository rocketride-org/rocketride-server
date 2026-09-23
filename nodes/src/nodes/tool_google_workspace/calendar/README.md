# Google Calendar tool node (`tool_calendar`)

Exposes the Google Calendar API v3 as agent tools: list, get, create, update,
move, quick-add, and delete events (including expanding recurring series into
instances); query free/busy; manage calendars; and read/insert/delete
access-control (ACL) rules.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is a
`@tool_function` an agent calls on demand. Operational targets (`calendarId`,
`eventId`, `ruleId`) are always tool-call parameters, never node config;
`calendarId` defaults to `primary`. Outputs are cleaned shapes (event
`id`/`status`/`start`/`end`/`attendees`, calendar metadata, ACL rules, free/busy
ranges), not raw API JSON.

## Configuration

| Field | Notes |
|-------|-------|
| `google.authType` | `service` (service account) or `user` (OAuth). |
| `google.serviceKey` / `google.adminEmail` | Service account JSON key; `adminEmail` enables domain-wide delegation (impersonate that user). |
| `google.oAuthButton` / `google.userToken` | User OAuth: sign in to populate the access token. |
| `calendar.access` | `readonly` or `write` (default). Resolved by the shared `CALENDAR` spec in `core/google_access.py`; scopes are never hand-entered. |
| `calendar.allowDelete` | Boolean, default **false**. When off, `event_delete` and `calendar_delete` are refused even at the write tier. Enable only to permit permanent, irreversible deletion. |
| `calendar.allowPublicSharing` | Boolean, default **false**. When off, `acl_insert` refuses rules that expose the calendar beyond individual grantees (scopeType `default` = anyone on the internet, `domain` = everyone in a domain). Grants to individual users/groups are not gated. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `calendar.readonly` | read events, calendars, ACLs, free/busy |
| `write` | `calendar` | full read/write (default) |

Deletion (`event_delete`, `calendar_delete`) requires the `write` tier **and**
`calendar.allowDelete` = true. The flag is off by default and, like gmail's
`allowHardDelete`, is absent from the default profile (absent means false).
Removing a sharing rule (`acl_delete`) is a write-tier operation and is **not**
gated by `allowDelete`.

## Tools

- **Read events:** `event_list` (with incremental sync — see below),
  `event_get`, `event_instances` (expand a recurring series), `freebusy_query`.
- **Read calendars/ACL:** `calendar_list`, `calendar_get`, `acl_list`.
- **Write events:** `event_create`, `event_update` (partial / patch semantics),
  `event_move`, `event_quick_add` (natural-language).
- **Write calendars/ACL:** `calendar_create`, `calendar_update` (patch),
  `acl_insert` (share; scopeType `default`/`domain` additionally requires
  `allowPublicSharing`), `acl_delete` (unshare).
- **Delete (write + `allowDelete`):** `event_delete`, `calendar_delete`.
- **Diagnostics:** `check_connection` probes the Calendar API with a live call;
  for user OAuth it also verifies that granted scopes cover the configured
  access tier (service-account auth has no per-user scope grant to check).

### Incremental sync (`syncToken`)

`event_list` and `calendar_list` return a `nextSyncToken` on the last page of a
fully-consumed listing. Store it, then pass it back as `syncToken` on the next
call to receive **only** the events/calendars that changed since — the efficient
way to keep a local view in sync. Do not combine `syncToken` with `timeMin` /
`timeMax` / `q`. Paginate with `nextPageToken` until it is absent; the
`nextSyncToken` appears on that final page.

### Attendee invitations (`sendUpdates`)

Event writes (`event_create`, `event_update`, `event_move`, `event_quick_add`,
`event_delete`) take a `sendUpdates` parameter — `all` (default), `externalOnly`,
or `none`. The node **always sends it explicitly**: Google's implicit default is
`none`, which would silently skip notifying attendees. Sending invitations is
normal write-tier behavior and is **not** gated separately — an agent with write
access can invite attendees, so scope the node accordingly.

`event_update` accepts an empty `description` or `location` to clear that field.
For `acl_insert`, `scopeType` must be `user`, `group`, `domain`, or `default`; `default` and `domain` rules require `calendar.allowPublicSharing` = true;
the first three require `scopeValue`.

## Setup

Authenticate with either a Google **service account** (`google.serviceKey` JSON,
optionally `google.adminEmail` for domain-wide delegation) or **user OAuth**
(click sign-in to populate `google.userToken`). The Google Calendar API must be
enabled on the Google Cloud project backing the credential.

## Limits

- `maxResults` on listings is clamped to `1..250` (default 50); page with
  `nextPageToken`.
- Free/busy queries return busy ranges per calendar plus any per-calendar errors
  (e.g. a calendar the credential cannot see).
- Rate limits are per Google project; the node retries `429`, rate-limit/quota
  `403`, and `5xx` responses with exponential backoff.

## Examples

An agent finds a free slot, then books it and invites a guest:

```text
freebusy_query  { "timeMin": "2026-07-11T09:00:00Z", "timeMax": "2026-07-11T17:00:00Z",
                  "calendarIds": ["primary"] }
event_create    { "summary": "Design sync", "start": {"dateTime": "2026-07-11T14:00:00Z"},
                  "end": {"dateTime": "2026-07-11T15:00:00Z"},
                  "attendees": [{"email": "sam@example.com"}] }
```

## Upstream docs

- Google Calendar API v3: https://developers.google.com/calendar/api/v3/reference
- Events: https://developers.google.com/calendar/api/v3/reference/events
- Sync (syncToken): https://developers.google.com/calendar/api/guides/sync
- FreeBusy: https://developers.google.com/calendar/api/v3/reference/freebusy/query

## Troubleshooting

- **Scope / 403 errors:** call `check_connection`; if scopes are missing,
  disconnect and reconnect the Google account at the required access tier.
- **`access` is read-only:** write operations raise `GoogleAccessError`; raise
  `calendar.access` to `write`.
- **Delete refused at write tier:** `event_delete` / `calendar_delete` also need
  `calendar.allowDelete` = true; it is off by default.
- **Attendees not notified:** pass `sendUpdates: "all"` (the node's default) —
  `none` suppresses invitations.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
