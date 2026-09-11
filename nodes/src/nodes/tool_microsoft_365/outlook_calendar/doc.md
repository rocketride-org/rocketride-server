# Outlook Calendar

Microsoft Outlook Calendar operations exposed as agent **tools**, backed by the
[Microsoft Graph calendar API](https://learn.microsoft.com/en-us/graph/api/resources/calendar).
Operates on the acting user's calendar.

## What it does

List and read events (including calendarView expansion of recurring series
into occurrences), create/update/delete events, respond to invitations, find
meeting times, get free/busy schedules, list/create calendars, and
delta-sync a calendar view. Two access tiers gate the surface — `readonly`
and `write` (default).

## Agent tools

| Tool | Graph call | Purpose |
| --- | --- | --- |
| `outlook_calendar_list_events` | `GET [/calendars/{id}]/calendarView` | List events in a window (recurring series expanded). |
| `outlook_calendar_get_event` | `GET /events/{id}` | Get a single event by id. |
| `outlook_calendar_create_event` | `POST [/calendars/{id}]/events` | Create an event, optionally inviting attendees (write tier). |
| `outlook_calendar_update_event` | `PATCH /events/{id}` | Update an event — only provided fields change (write tier). |
| `outlook_calendar_delete_event` | `DELETE /events/{id}` | Delete an event (write tier). |
| `outlook_calendar_respond` | `POST /events/{id}/{accept\|decline\|tentativelyAccept}` | Respond to a meeting invitation (write tier). |
| `outlook_calendar_find_meeting_times` | `POST /findMeetingTimes` | Suggest meeting times for a set of attendees. |
| `outlook_calendar_get_schedule` | `POST /calendar/getSchedule` | Get free/busy schedule information for mailboxes. |
| `outlook_calendar_list_calendars` | `GET /calendars` | List the mailbox's calendars. |
| `outlook_calendar_create_calendar` | `POST /calendars` | Create a new calendar (write tier). |
| `outlook_calendar_delta_sync` | `GET /calendarView/delta` | Incrementally sync a calendar view via a caller-provided delta link. |
| `outlook_calendar_check_connection` | `GET /calendar` + scope report | Diagnostics — connection and scope coverage. |

## Wiring

This is a `tool` node: wire it to an agent via `control` (class `tool`),
alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_outlook_calendar_1",
  "provider": "tool_outlook_calendar",
  "config": { "type": "tool_outlook_calendar" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers the `outlook_calendar_*` tools and calls them per its instructions.

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `microsoft.authType` | yes | `service` (Entra app, client credentials) or `user` (OAuth). |
| `microsoft.tenantId` / `microsoft.clientId` / `microsoft.clientSecret` | for `service` | Entra app registration credentials. |
| `microsoft.userPrincipalName` | for `service` | Acting user's UPN — app-only calls target `/users/{upn}`. |
| `microsoft.userToken` | for `user` | Populated by the sign-in button; broker-refreshed. |
| `outlook_calendar.access` | no | `readonly` or `write` (default). Resolved by the shared `OUTLOOK_CALENDAR` access spec — scopes are never hand-entered. |

## Where to get your credentials

Register an app in the **Entra admin center** (`entra.microsoft.com` → App
registrations), grant it the Graph `Calendars.Read` and/or
`Calendars.ReadWrite` application permission (or delegated, for user OAuth)
matching the configured tier, with admin consent. See `microsoft-oauth.md`
for the full setup shared by every Microsoft 365 tool service (excel, word,
onedrive, outlook mail, outlook calendar).

Never commit credentials; use node config (encrypted) or Entra app secret
rotation.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
