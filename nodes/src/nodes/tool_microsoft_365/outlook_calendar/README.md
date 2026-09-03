# Outlook Calendar tool node (`tool_outlook_calendar`)

Exposes the Microsoft Graph calendar API as agent tools: list/read events
(including calendarView expansion of recurring series), create/update/delete
events, respond to invitations, find meeting times, get free/busy schedules,
list/create calendars, and delta-sync a calendar view. Operates on the
acting user's calendar.

## What it does

An agent-invocable tool node — no data flows through lanes. Each operation is
a `@tool_function` an agent calls on demand. Operational targets (event id,
calendar id) are always tool-call parameters, never node config. Outputs are
cleaned shapes (`id`, `subject`, `start`, `end`, `location`, `organizer`,
`attendees`, `isAllDay`, `isCancelled`, `seriesMasterId`, `recurrence`,
`onlineMeeting`, `webLink`, `bodyPreview` for events; `id`, `name`,
`isDefaultCalendar`, `canEdit`, `owner` for calendars), not raw Graph JSON.

## Configuration

| Field | Notes |
|-------|-------|
| `microsoft.authType` | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | Entra app credentials for `service` auth. |
| `microsoft.userPrincipalName` | Acting user's UPN for `service` auth (app-only calls target `/users/{upn}`). |
| `microsoft.oAuthButton` / `microsoft.userToken` | User OAuth: sign in to populate the access token. |
| `outlook_calendar.access` | `readonly` or `write` (default). Resolved by the shared `OUTLOOK_CALENDAR` spec in `core/microsoft_access.py`; scopes are never hand-entered. |

### Access tiers → scopes

| Tier | Scope | Capability |
|------|-------|------------|
| `readonly` | `Calendars.Read` | list/read events and calendars, find meeting times, get schedules, and delta-sync only |
| `write` | `Calendars.ReadWrite` | full read/write (default) — create/update/delete events, respond to invitations, and create calendars, plus everything `readonly` grants |

No gate flags — unlike Outlook Mail's hard-delete flag, event deletion here
needs only the `write` tier.

## Tools

- **Read:** `outlook_calendar_list_events` (calendarView, recurring series
  expanded), `outlook_calendar_get_event`, `outlook_calendar_find_meeting_times`,
  `outlook_calendar_get_schedule`, `outlook_calendar_list_calendars`,
  `outlook_calendar_delta_sync`.
- **Write:** `outlook_calendar_create_event`, `outlook_calendar_update_event`
  (PATCH — only provided fields change), `outlook_calendar_delete_event`,
  `outlook_calendar_respond` (accept/decline/tentativelyAccept),
  `outlook_calendar_create_calendar`.
- **Diagnostics:** `outlook_calendar_check_connection` verifies that granted
  OAuth scopes cover the configured access tier.

## Setup

Authenticate with either an **Entra app** (`microsoft.tenantId` /
`microsoft.clientId` / `microsoft.clientSecret` / `microsoft.userPrincipalName`,
client-credentials flow) or **user OAuth** (click sign-in to populate
`microsoft.userToken`). See `microsoft-oauth.md` for the Entra app / consent
setup shared by every Microsoft 365 tool service. The app must be granted the
Graph `Calendars.Read` and/or `Calendars.ReadWrite` permission (application or
delegated, matching the auth mode and the configured tier) with admin consent.

## Limits

- `outlook_calendar_create_event` / `outlook_calendar_update_event` accept
  `start`/`end` as either a plain `'YYYY-MM-DDTHH:MM:SS'` string (wrapped as
  UTC) or an already-shaped `{dateTime, timeZone}` object.
- `attendees` invites are sent by Graph itself as part of creating/updating
  the event — the `write` tier gates the Graph call, not a separate "send"
  step.
- `outlook_calendar_find_meeting_times` (`findMeetingTimes`) needs a
  delegated (signed-in user) context on Microsoft's side and may not be
  supported under app-only (client-credentials) authentication.
- `outlook_calendar_delta_sync` takes `start`/`end` on the first call; pass
  the returned `delta_link` back in on subsequent calls to fetch only what
  changed.
- Rate limits are per Entra app / tenant; the node retries `429`/`5xx` with
  exponential backoff.

## Examples

An agent creates a meeting and later syncs changes:

```text
outlook_calendar_create_event { "subject": "Sync", "start": "2026-08-11T14:00:00",
                                 "end": "2026-08-11T14:30:00",
                                 "attendees": ["alex@contoso.com"] }
outlook_calendar_delta_sync   { "start": "2026-08-01T00:00:00", "end": "2026-08-08T00:00:00" }
outlook_calendar_delta_sync   { "delta_link": "<deltaLink from the previous call>" }
```

## Upstream docs

- Microsoft Graph calendar API: https://learn.microsoft.com/en-us/graph/api/resources/calendar
- Event: https://learn.microsoft.com/en-us/graph/api/resources/event
- Find meeting times: https://learn.microsoft.com/en-us/graph/api/user-findmeetingtimes
- Get schedule: https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
- Delta query: https://learn.microsoft.com/en-us/graph/delta-query-events

## Troubleshooting

- **Scope / 403 errors:** call `outlook_calendar_check_connection`; if scopes
  are missing, disconnect and reconnect the Microsoft account (user auth) or
  grant/consent the Entra app permission (service auth) at the required tier.
- **`access` is `readonly`:** every write tool raises `MicrosoftAccessError`;
  raise `outlook_calendar.access` to `write`.
- **`outlook_calendar_find_meeting_times` fails under app-only auth:** this
  endpoint needs a delegated (signed-in user) context; switch to user OAuth
  or use `outlook_calendar_get_schedule` instead.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
