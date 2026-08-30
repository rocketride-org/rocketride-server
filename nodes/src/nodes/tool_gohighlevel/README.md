# tool_gohighlevel

A RocketRide tool node that exposes the GoHighLevel (LeadConnector) v2 REST API to an AI agent.

## What it does

Gives an agent one GoHighLevel sub-account: contacts, contact notes and tasks,
opportunities, pipelines, conversations, messages, calendars, appointments and
appointment notes, custom fields, custom values, tags, businesses, locations and users.
101 tools in all, plus a generic `request` tool for any v2 endpoint that has no dedicated
tool here. Useful for lead nurture, appointment booking, CRM reporting, and pipelines
that read from or write to a sub-account.

Uses the **requests** library against `https://services.leadconnectorhq.com` with a
30-second timeout, and **tenacity** to retry GoHighLevel's burst rate limit. There is no
response envelope to unwrap: each endpoint names its own key, and the key does not always
match the resource (`GET /contacts/{id}/appointments` returns `events`), so every tool
names the key it reads. Records come back trimmed to the fields the node documents, and
custom fields are projected into one object keyed by field id.

Authentication is a sub-account **Private Integration Token**, and both the token and the
**location id** are required: the pipeline fails to start without them. Write operations
are **allowed by default**; enable **read-only mode** to hide every mutating tool from the
agent.

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `privateIntegrationToken` | string | Default empty. Sub-account Private Integration Token (Settings -> Private Integrations), sent as `Authorization: Bearer`. Observed tokens start with `pit-`. Stored encrypted. |
| `locationId` | string | Default empty. The sub-account this node operates on, from Settings -> Business Profile. Required: the token is opaque, so the location cannot be derived from it. |
| `readOnly` | boolean | Default false. When enabled, every create, update and delete tool is hidden from the agent, and `request` accepts only GET. |
| `toolGroups` | array | Default empty, which publishes the recommended set of 71 tools. Name groups to change that, or use `["all"]` for all 101. |
| `allowRawRequest` | boolean | Default true. Publishes the generic `request` tool. |

### Tool groups

Full coverage here is 101 tools across 18 groups. That is more than an LLM can choose
between reliably, so the node publishes only the groups named in **Tool groups**. Leaving
the field empty publishes the default set: **71 tools** across `appointments`,
`calendars`, `contact_notes`, `contact_tasks`, `contacts`, `conversations`,
`custom_fields`, `messages`, `opportunities`, `pipelines` and `users`, which is everything
an agent needs to run lead nurture and appointment booking end to end. `users` is in the
default set despite being administrative: it is three read-only tools, and it is the only
way to resolve the user ids that `assignedTo`, `followers` and `assignedUserId` need.
`message_sending` is deliberately not: reading messages is default, but originating one
from an unattended pipeline cannot be recalled, so sending is an explicit opt-in.

Available groups:

`appointment_notes`, `appointments`, `businesses`, `calendar_groups`, `calendars`,
`contact_notes`, `contact_tasks`, `contacts`, `conversations`, `custom_fields`,
`custom_values`, `location_tags`, `locations`, `message_sending`, `messages`,
`opportunities`, `pipelines`, `users`.

A tool in a group that is not published is invisible to the agent and refused if invoked
anyway. Group names are matched case-insensitively. A name this node does not implement is
reported as a warning in the editor; at runtime it is dropped from the selection with a
warning in the job log, and a `toolGroups` value that names *only* unknown groups stops
the pipeline at startup. Falling back to the defaults there would publish more tools than
the misspelled config asked for.

### Pagination

Every list tool returns the same envelope: `{items, count, total, next, has_more}`. Ask
for another page only while `has_more` is true, and pass `next` back as the parameter the
tool's description names. `next` is null when there is no next page. `total` is null on
most endpoints, and null there means unknown rather than zero.

**18 list tools always report `total: null`, by design rather than by defect.** Their
endpoints send no record count at all, so there is nothing to report and the node does not
synthesise one. Measured by running the live suite against a real sub-account, not inferred
from the specs:

`appointment_list`, `appointment_notes_list`, `blocked_slot_list`, `business_list`,
`calendar_group_list`, `calendar_list`, `contact_appointments_list`,
`contact_list_by_business`, `contact_notes_list`, `contact_tasks_list`,
`custom_field_list`, `custom_value_list`, `location_tags_list`, `location_tasks_search`,
`lost_reason_list`, `message_list`, `pipeline_list`, `user_list_by_location`.

Do not treat a null `total` from any of them as an empty result or as a bug: page with
`has_more` instead. The tools that do report a count are `contact_list`, `contact_search`,
`conversation_search`, `message_export`, `opportunity_search`,
`opportunity_search_advanced` and `user_search`. Two additional tools,
`contact_list_by_business` and `lost_reason_list`, read a count field their endpoints
document, but no observed live response ever carried it, which is why they stay in the
null list above.

GoHighLevel does not have one pagination style. The contacts list pages on a
`startAfter` plus `startAfterId` pair, the searches page on an opaque `searchAfter` value,
and several endpoints page on a `skip` offset. GoHighLevel also carries its cursors on the
records rather than on the response root, so the last page has one too. The node compares
the page size it received against the size it asked for instead of trusting cursor
presence, which is what keeps `has_more` from claiming a page that does not exist.

Maximum page size is per endpoint, not global: `appointment_notes_list` caps at 20,
`message_export` at 500, and the rest at 100, which is the node's own ceiling on the
endpoints where GoHighLevel publishes no maximum. Sending a larger value is a hard 400
rather than a silent clamp, so the node clamps before the request goes out.

### Custom fields

Read and write use opposite shapes, and GoHighLevel rejects the wrong one. Reads return
custom fields as one object keyed by field id (`{"<field id>": <value>}`). Creates and
updates take an array (`[{"id": "<field id>", "field_value": <value>}]`). A record from a
get tool cannot be passed back to an update unchanged. Use `custom_field_list` (group
`custom_fields`) to discover field ids.

Several write tools, including the contact, opportunity and custom field creates and
updates, accept an `extra` object. It is merged into the request body after the typed
parameters, so it reaches any API field this node does not model explicitly:

```json
{ "firstName": "Ada", "extra": { "someUndocumentedField": "value" } }
```

`tags` cannot be smuggled through `extra` on an update or an upsert. GoHighLevel replaces
the whole tag array rather than adding to it, so sending it there would delete the tags you
did not list; use `contact_tags_add` and `contact_tags_remove` instead. `contact_create`
takes `tags` as a normal parameter, since a contact being created has none to lose.

### Tags have a sub-account-level side effect

`contact_tags_add` is not only a per-contact write. Adding a tag name that does not exist
yet **defines that tag on the whole sub-account**, where it shows up in `location_tags_list`
and in the GoHighLevel UI from then on. `contact_tags_remove` takes the tag off the contact
and leaves the definition behind. Only `location_tags_delete` (group `location_tags`, opt
in) removes a definition.

This matters for anything that loops. An agent that tags a few thousand contacts with
generated names, then removes the tags again, leaves a few thousand tag definitions on the
sub-account, and nothing in the contacts group can clean them up. Reuse the names
`location_tags_list` already reports, or publish `location_tags` alongside `contacts` so
whatever creates definitions can also remove them. Confirmed live against a real sub-account,
not read out of the spec: the specs describe neither half of this.

---

## Authentication

The node accepts exactly one credential: a **sub-account Private Integration Token**.
Create it under Settings -> Private Integrations, pick the scopes, and copy the token when
it is shown. There is no way to read it again afterwards.

Three consequences are worth knowing before you deploy this node.

**One credential reaches exactly one sub-account.** A location token authenticates that
location and nothing else. There is no fan-out: minting per-location tokens from an agency
credential runs through `POST /oauth/locationToken`, which is OAuth-only and refuses a
Private Integration Token. N sub-accounts need N node instances, each with its own token
and its own `locationId`. Agency-scoped endpoints answer `403 Forbidden resource` to a
sub-account token, and no configuration change grants access.

**Rotation is a silent cliff.** Rotating with "expire later" keeps the old token working
for exactly 7 days and then stops it, with nothing in the API signalling the deadline
beforehand. Rotating with "expire now" breaks it immediately. A 401 raised by this node
carries that explanation rather than a bare "unauthorized", because a rotation about a week
earlier is the most likely cause.

**Editing scopes does not mint a new token.** The existing token keeps working, so nothing
looks broken, but calls that need a scope you removed start failing while the credential
still authenticates. GoHighLevel answers those with `401 The token is not authorized for
this scope`, which the node passes through with a note that scopes are edited on the
Private Integration itself.

### A 401 is not always a credential problem

Four error shapes are worth naming, because all four look like auth failures and none of
them is one.

- A missing or mismatched `locationId` returns `403 The token does not have access to this
  location`, which blames the token for a missing parameter.
- A mis-cased path returns 401 rather than 404.
- A missing required parameter can return 401 too. `GET /users/search` called bare answers
  `401 E01 - Unauthorized request`, and the same call answers 422 naming the parameter once
  a `locationId` is supplied. The status depends on what else you sent, not on the token.
- The gateway in front of the API answers 401 for its own failures. One was captured live
  carrying the body text `Command timed out`, which is a timeout rather than anything to do
  with the credential.

The node rewrites all four into messages that name the real cause, and its 401 fall-through
claims a credential problem only when the body actually complains about one or carries no
message at all. A timeout is reported as a timeout and is worth retrying; nothing there
should send anyone to rotate a working token.

### Errors carry more than a message

Some GoHighLevel errors name the record that caused them, and the id is the way out of the
error. `conversation_create` for a contact that already has a conversation answers HTTP 400
with `{"message": "Conversation already exists", "canonicalCode":
"CONVERSATIONS_CONVERSATION_ALREADY_EXISTS", "conversationId": "..."}`, and that is the
common case rather than an edge one: creating a contact through the API creates its
conversation too. The node carries every id the body names, plus `canonicalCode` and
`traceId`, into the raised message and onto the exception, so the agent can use the existing
conversation instead of stopping at "already exists".

### Why there is no OAuth option

GoHighLevel's OAuth access tokens last about 24 hours, and its refresh tokens are
single-use: the moment you spend one, the old refresh token is dead and a new one comes
back in the response. A node's only credential store is static config, which it cannot
write to, so the new refresh token would be thrown away. The pipeline would work for
roughly a day, refresh once successfully, work for another day, then present an
invalidated refresh token and die. That failure is delayed, silent, and unrecoverable
without a browser consent flow, and pasting the original refresh token back in does not
fix it. Supporting OAuth needs a durable secret store the node can write to on every
refresh, with a lock so concurrent runs cannot race. Until that exists, the Private
Integration Token is the only credential in this API that static config is the correct
store for.

The legacy v1 API key is not accepted either. v1 reached end of support on 31 December
2025, new keys can no longer be generated, and a v1 key will never authenticate against
`services.leadconnectorhq.com`.

## Rate limits

Measured against a sub-account Private Integration Token, not assumed from the docs: **25
requests per 10 seconds** and **10,000 per day**. The 100 per 10 seconds published for
marketplace apps does not apply here. Every response carries `x-ratelimit-max`,
`x-ratelimit-remaining`, `x-ratelimit-interval-milliseconds`, `x-ratelimit-limit-daily`,
`x-ratelimit-daily-remaining` and `x-ratelimit-daily-reset`.

GoHighLevel sends no `Retry-After`, not even on the 429 itself, so the client computes its
own wait: one burst window (`x-ratelimit-interval-milliseconds`, 10000 on every observed
response), up to three attempts. If the wait would exceed the 30-second request timeout
the call fails immediately with the wait time in the message rather than blocking the
pipeline. `x-ratelimit-daily-reset` is deliberately never used as a sleep: it is a
duration in milliseconds, about 24 hours, and treating it as a timestamp would produce a
sleep of roughly 55 years. Exhausting the daily budget is a circuit break rather than
something to retry, so the node reports it and stops.

## Read-only mode

With **Read-only mode** enabled, every tool that creates, updates or deletes is dropped
from the published set: the agent does not see it in `tool.query`, and invoking it anyway
is refused. The `request` tool stays published, because it is still a working read tool,
but accepts only GET.

Hiding rather than refusing is a deliberate departure from `tool_pipedrive`, which
publishes its write tools in read-only mode and blocks them at invoke time. An agent
cannot tell in advance that a published tool is blocked, so it spends a turn finding out,
and roughly 40 tools it can only ever fail on are 40 tools' worth of wasted context.

---

## Available tools

Tools are published as `gohighlevel.<tool>`. The **Writes** column marks the tools that
read-only mode hides.

### `appointment_notes` (4 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `appointment_notes_create` | yes | Write a note on an appointment. |
| `appointment_notes_delete` | yes | Delete a note from an appointment. |
| `appointment_notes_list` |  | List the notes written on one appointment. |
| `appointment_notes_update` | yes | Replace the text of a note on an appointment. |

### `appointments` (9 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `appointment_create` | yes | Book an appointment for a contact on a calendar. |
| `appointment_delete` | yes | Delete a calendar event by id. |
| `appointment_free_slots_list` |  | Find the times a calendar can be booked, before calling appointment_create. |
| `appointment_get` |  | Get one appointment by id. |
| `appointment_list` |  | List the appointments and other events on a calendar, a user or a calendar group inside a time window. |
| `appointment_update` | yes | Update an appointment: reschedule it, reassign it, or change its status. |
| `blocked_slot_create` | yes | Block a period on a calendar or on a user so it cannot be booked. |
| `blocked_slot_list` |  | List the blocked time on a calendar, a user or a calendar group inside a time window: the periods that are deliberately unavailable rather than booked. |
| `blocked_slot_update` | yes | Move or retitle a blocked slot. |

### `businesses` (5 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `business_create` | yes | Create a business on the configured sub-account. |
| `business_delete` | yes | Delete a business by id. |
| `business_get` |  | Get one business by id. |
| `business_list` |  | List the businesses on the configured sub-account. |
| `business_update` | yes | Update a business. |

### `calendar_groups` (6 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `calendar_group_create` | yes | Create a calendar group in the configured sub-account. |
| `calendar_group_delete` | yes | Delete a calendar group. |
| `calendar_group_list` |  | List the calendar groups in the configured sub-account. |
| `calendar_group_slug_check` |  | Check whether a calendar group slug is free in the configured sub-account, before creating or renaming a group. |
| `calendar_group_status_set` | yes | Enable or disable a calendar group without deleting it. |
| `calendar_group_update` | yes | Replace the name, description and slug of a calendar group. |

### `calendars` (5 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `calendar_create` | yes | Create a calendar in the configured sub-account. |
| `calendar_delete` | yes | Delete a calendar by id. |
| `calendar_get` |  | Get one calendar by id, with its whole configuration: team members, slot sizing, booking window, open hours and custom availabilities. |
| `calendar_list` |  | List the calendars in the configured sub-account. |
| `calendar_update` | yes | Update a calendar. |

### `contact_notes` (5 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `contact_notes_create` | yes | Write a note on a contact. |
| `contact_notes_delete` | yes | Delete a note. |
| `contact_notes_get` |  | Get one note by id. |
| `contact_notes_list` |  | List the notes on a contact. |
| `contact_notes_update` | yes | Update a note. |

### `contact_tasks` (6 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `contact_tasks_create` | yes | Create a task on a contact: a follow-up call, a document to send, anything a person has to do next. |
| `contact_tasks_delete` | yes | Delete a task. |
| `contact_tasks_get` |  | Get one task by id. |
| `contact_tasks_list` |  | List the tasks on a contact, open and completed alike. |
| `contact_tasks_set_completed` | yes | Mark a task done, or reopen one, without touching its title, due date or assignee. |
| `contact_tasks_update` | yes | Update a task. |

### `contacts` (16 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `contact_appointments_list` |  | List the calendar appointments booked for a contact. |
| `contact_create` | yes | Create a contact in the configured sub-account. |
| `contact_delete` | yes | Delete a contact by id. |
| `contact_duplicate_check` |  | Check whether a phone number or email already belongs to a contact, before creating one. |
| `contact_followers_add` | yes | Add users as followers of a contact. |
| `contact_followers_remove` | yes | Remove followers from a contact, by user id. |
| `contact_get` |  | Get one contact by id. |
| `contact_list` |  | List contacts in the configured sub-account. |
| `contact_list_by_business` |  | List the contacts assigned to a business. |
| `contact_search` |  | Find contacts in the configured sub-account by email, phone, name, tag or any other field. |
| `contact_tags_add` | yes | Add tags to a contact. |
| `contact_tags_remove` | yes | Remove tags from a contact. |
| `contact_update` | yes | Update a contact. |
| `contact_upsert` | yes | Create a contact, or update the existing one when its email or phone already belongs to a contact. |
| `contact_workflow_add` | yes | Enrol a contact in a workflow. |
| `contact_workflow_remove` | yes | Remove a contact from a workflow. |

### `conversations` (5 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `conversation_create` | yes | Open a conversation with a contact in the configured sub-account. |
| `conversation_delete` | yes | Delete a conversation and every message in it. |
| `conversation_get` |  | Get one conversation by id, including how many of its messages are unread and who it is assigned to. |
| `conversation_search` |  | Find conversations in the configured sub-account, by contact, owner, channel, read state or free text. |
| `conversation_update` | yes | Update a conversation read state, star or feedback. |

### `custom_fields` (5 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `custom_field_create` | yes | Create a custom field definition on the configured sub-account. |
| `custom_field_delete` | yes | Delete a custom field definition from the configured sub-account. |
| `custom_field_get` |  | Get one custom field definition. |
| `custom_field_list` |  | List the custom field definitions on the configured sub-account. |
| `custom_field_update` | yes | Update a custom field definition. |

### `custom_values` (5 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `custom_value_create` | yes | Create a custom value on the configured sub-account. |
| `custom_value_delete` | yes | Delete a custom value from the configured sub-account. |
| `custom_value_get` |  | Get one custom value by id. |
| `custom_value_list` |  | List the custom values on the configured sub-account. |
| `custom_value_update` | yes | Replace a custom value. |

### `location_tags` (5 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `location_tags_create` | yes | Define a new tag on the configured sub-account and return it with its id. |
| `location_tags_delete` | yes | Delete a tag definition from the sub-account. |
| `location_tags_get` |  | Get one tag definition by id. |
| `location_tags_list` |  | List every tag defined on the configured sub-account, with the id of each. |
| `location_tags_update` | yes | Rename a tag definition. |

### `locations` (2 tools, opt in)

| Tool | Writes | Description |
|---|---|---|
| `location_get` |  | Get the configured sub-account, which GoHighLevel also calls a location. |
| `location_tasks_search` |  | Search tasks across the whole sub-account, optionally narrowed by contact, assignee, business, completion state or free text. |

### `message_sending` (3 tools, opt in)

Opt-in on purpose, and not part of the default set: these are the only tools whose write
path has never been exercised against the live API (a trial sub-account has no phone or
email provider to send through), and a send from an unattended pipeline cannot be
recalled. Enable the group only on a sub-account where the send path has been proven.

| Tool | Writes | Description |
|---|---|---|
| `message_email_schedule_cancel` | yes | Cancel a scheduled email that has not gone out yet. |
| `message_schedule_cancel` | yes | Cancel a message that was scheduled but has not gone out yet. |
| `message_send` | yes | Send a message to a contact on any channel: SMS, email, WhatsApp, Instagram, Facebook, RCS, TikTok, live chat or a custom provider. |

### `messages` (5 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `message_email_get` |  | Get one email message by id, with its subject, sender, to, cc and bcc lists, thread id and attachment URLs. |
| `message_export` |  | Export messages across the whole configured sub-account, rather than one conversation at a time. |
| `message_get` |  | Get one message by id, including its body, direction, delivery status and attachment URLs. |
| `message_list` |  | Read the messages in one conversation. |
| `message_transcription_get` |  | Get the speech-to-text transcription of a recorded call or voicemail. |

### `opportunities` (10 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `opportunity_create` | yes | Create an opportunity in the configured sub-account, against a pipeline and a contact. |
| `opportunity_delete` | yes | Delete an opportunity by id. |
| `opportunity_followers_add` | yes | Add users as followers of an opportunity, so they are notified as it moves. |
| `opportunity_followers_remove` | yes | Remove followers from an opportunity, by user id, or clear them all with isRemoveAllFollowers. |
| `opportunity_get` |  | Get one opportunity by id. |
| `opportunity_search` |  | Find opportunities in the configured sub-account, filtered by pipeline, stage, contact, status, assignee or free text. |
| `opportunity_search_advanced` |  | Search opportunities in the configured sub-account by free text, and optionally pull their notes, tasks, calendar events and unread conversation counts back in the same call. |
| `opportunity_status_update` | yes | Move an opportunity to won, lost, abandoned or back to open. |
| `opportunity_update` | yes | Update an opportunity. |
| `opportunity_upsert` | yes | Update an opportunity when you pass its id, or create one when you do not. |

### `pipelines` (2 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `lost_reason_list` |  | List the reasons this sub-account records for a lost deal. |
| `pipeline_list` |  | List the opportunity pipelines on the configured sub-account, each with its stages. |

### `users` (3 tools, default)

| Tool | Writes | Description |
|---|---|---|
| `user_get` |  | Get one user by id, including the permissions map and the scopes string that the two list tools leave out. |
| `user_list_by_location` |  | List every user of the configured sub-account in one response. |
| `user_search` |  | Find users of the configured sub-account by name, email, phone or role. |

### `request` (1 tool, gated by `allowRawRequest`)

| Tool | Writes | Description |
|---|---|---|
| `request` | GET only in read-only mode | Call any GoHighLevel v2 endpoint at https://services.leadconnectorhq.com directly, by method and path. |

`request` is the escape hatch for endpoints with no dedicated tool. It sends what you give
it and returns the raw response body, where the typed tools validate their input, put the
sub-account id wherever the endpoint wants it, and return a compact result. The
`Authorization` and `Version` headers are added for you, and rate-limit retries and
read-only enforcement apply the same way. Writes under `/conversations/messages`
additionally require the `message_sending` tool group, the same opt-in the typed send
tools sit behind. Two things it does not do for you: the
sub-account id is not injected (most endpoints want `locationId`, but
`GET /opportunities/search` spells it `location_id`), and a trailing slash and the exact
casing of the path are both load-bearing, since GoHighLevel answers a mis-cased path with
401 rather than 404.

---

## Running the tests

```bash
# Stubbed suite: no credentials, no network
python -m pytest nodes/test/tool_gohighlevel/test_gohighlevel.py -v

# Live suite, reads only
export GHL_PIT=<sub-account Private Integration Token>
export GHL_LOCATION_ID=<the sub-account the token is scoped to>
python -m pytest nodes/test/tool_gohighlevel/test_tools.py -v

# Live suite including the create and delete lifecycles
export GHL_ALLOW_WRITES=1
python -m pytest nodes/test/tool_gohighlevel/test_tools.py -v
```

The live suite calls the real API. Point it at a trial or sandbox sub-account: the write
tests create real records, and they remove them in a `finally` block. Do not run it under
pytest-xdist, since parallel workers share one rate-limit budget but pace themselves
independently.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `gohighlevel.allowRawRequest` | `boolean` | **Allow raw API requests**<br/>Publishes the generic <b>request</b> tool, which can call any GoHighLevel v2 endpoint by method and path. It uses the same authentication, version header, rate-limit handling and read-only enforcement as the typed tools. Message-send paths under /conversations/messages additionally require the message_sending tool group. Disable to restrict the agent to the typed tools only. | `true` |
| `gohighlevel.locationId` | `string` | **Location ID**<br/>The sub-account (location) this node operates on, from Settings -> Business Profile. The token is opaque, so the location cannot be derived from it. Without this value GoHighLevel answers <code>403</code> with a message that blames the token rather than the missing parameter. | `""` |
| `gohighlevel.privateIntegrationToken` | `string` | **Private Integration Token**<br/>Sub-account Private Integration Token (Settings -> Private Integrations), sent as <code>Authorization: Bearer</code>. It starts with <code>pit-</code>. Agency tokens, OAuth access tokens and v1 API keys are not supported: one token reaches exactly one sub-account, so N sub-accounts need N node instances. | `""` |
| `gohighlevel.readOnly` | `boolean` | **Read-only mode**<br/>When enabled, every create, update and delete tool is hidden from the agent rather than merely refused, and the generic request tool only accepts GET. Safe for agents that should only inspect the account. | `false` |
| `gohighlevel.toolGroups` | `array` | **Tool groups**<br/>Which groups of GoHighLevel tools this node publishes to the agent. This node implements 101 tools across 18 groups, far more than an LLM can choose between reliably, so only the listed groups are exposed. <b>Leave this empty for the recommended set</b>: the 71 tools marked default below, which is everything an agent needs to run lead nurture and appointment booking end to end. Use <b>all</b> to publish all 101. Naming groups replaces the default set rather than adding to it, and a value that names only unknown groups stops the pipeline at startup rather than widening back to the defaults. <b>message_sending</b> (send a message, cancel a scheduled send) is a deliberate opt-in: sends from an unattended pipeline cannot be recalled. | `[]` |

## Dependencies

- `requests` `>=2.34.2`
- `tenacity`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_gohighlevel)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
