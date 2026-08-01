# tool_pipedrive

A RocketRide tool node that exposes the Pipedrive CRM to an AI agent.

## What it does

Gives an agent the full Pipedrive REST API v1: deals, persons, organizations,
activities, pipelines, stages, notes, leads, products, files, users, roles, teams,
goals, filters, webhooks, subscriptions, mail, call logs and projects — 255 tools in
all, plus a generic `request` tool for anything Pipedrive adds later. Useful for
sales automation, lead triage, CRM reporting, and RAG pipelines that read from a CRM.

Uses the **requests** library against `https://api.pipedrive.com/api/v1` (or your
company domain) with a 30-second timeout, and **tenacity** to retry Pipedrive's
rate limits. Responses are unwrapped from Pipedrive's `{"success", "data",
"additional_data"}` envelope and stripped of noise — the wide `*_flat` duplicates,
picture blobs and raw custom-field hashes are dropped, and custom fields are grouped
under a `custom_fields` key.

An API token is **required**: the pipeline fails to start without one. Write
operations are **allowed by default**; enable **read-only mode** to block every
mutating tool.

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `apiToken` | string | Default empty. Pipedrive API token (Settings -> Personal preferences -> API), or an OAuth access token. Stored encrypted. |
| `companyDomain` | string | Default empty. The "acme" in `https://acme.pipedrive.com`. When set, requests go to `https://{domain}.pipedrive.com/api/v1`; otherwise `https://api.pipedrive.com/api/v1`. |
| `readOnly` | boolean | Default false. When enabled, every create, update and delete tool is blocked and `request` only accepts GET. |
| `toolGroups` | array | Default `["deals", "persons", "organizations", "activities", "pipelines", "stages", "notes", "search"]`. Which groups of tools to publish, shown as a multi-select dropdown with per-group tool counts. Select **All groups** for everything. |
| `allowRawRequest` | boolean | Default true. Publishes the generic `request` tool. |

### Tool groups

Full v1 coverage is 255 tools. That is more than an LLM can choose between reliably,
and more than some providers accept in one request, so the node only publishes the
groups listed in **Tool groups**. The default eight groups publish 108 tools — the
everyday CRM surface. Add group names to reach further, or use `all`.

Available groups, with the number of tools each publishes:

`deals` (27), `projects` (22), `organizations` (18), `persons` (18), `products` (16),
`activities` (13), `roles` (13), `leads` (12), `users` (12), `notes` (11),
`subscriptions` (9), `files` (8), `misc` (8), `pipelines` (8), `teams` (8),
`filters` (7), `stages` (7), `fields` (6), `mailbox` (6), `call_logs` (5),
`goals` (5), `org_relationships` (5), `search` (4), `permission_sets` (3),
`webhooks` (3).

The config panel renders these as a multi-select dropdown. RJSF picks that widget for
an array carrying `uniqueItems: true` and an `items.enum`; **All groups** is the last
option.

A tool in a group that is not published is invisible to the agent and refused if
invoked anyway.

### Tool-count guard rail

Group sizes are uneven — `deals` is 27 tools, `permission_sets` is 3 — so counting
groups tells you little. The node counts **published tools** instead and warns when
a selection exceeds **120**, both in the config panel and at pipeline start:

```
toolGroups publishes 148 tools, above the recommended 120. Agents pick the wrong
tool more often at this size, and some providers reject more than 128 tools in one
request. Drop a group, or use "all" if this is deliberate.
```

It is a warning, not a block: the tools are still published and the pipeline still
runs. Silently dropping tools an operator asked for fails later and more
confusingly than a noisy config panel. `all` is exempt, since it is already an
explicit opt-in to the full 255-tool surface and suits scripted callers that do not
route through an LLM.

### Pagination

List tools take `start` (offset, default 0) and `limit` (1-500, default 100), and
return `{items, count, more_items_in_collection, next_start}`. Pass `next_start` back
as `start` for the next page. `file_list` is the exception: `/files` documents a
maximum `limit` of 100, so that tool advertises and clamps to 100. The project tools
use Pipedrive's cursor pagination instead: pass `cursor` and read `next_cursor`.

### Custom fields

Pipedrive stores custom fields under 40-character hex keys. Use `field_list` (group
`fields`) to discover them, then write them through the `extra` object that every
create and update tool accepts:

```json
{ "title": "New deal", "extra": { "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678": "Gold" } }
```

`extra` is merged into the request body after the typed parameters, so it also
reaches any API parameter this node does not model explicitly.

---

## Authentication

Personal API tokens are sent as the `api_token` query parameter; OAuth access tokens
(JWTs, anything longer than 64 characters, or a value prefixed with `Bearer `) are
sent as an `Authorization: Bearer` header. Both go in the same **API Token** field.

## Rate limits

Pipedrive uses a daily token budget plus a short burst window, and answers `429` when
either is exhausted (escalating to `403` if a client keeps hammering). The client
retries up to three times, honouring `Retry-After` first and then `x-ratelimit-reset`
— which, unlike GitHub's header of a similar name, is **seconds remaining in the
window, not an epoch timestamp**. If the required wait is longer than the 30-second
request timeout the call fails immediately with the wait time in the error message
rather than blocking the pipeline.

## Read-only mode

With **Read-only mode** enabled, every `*_create`, `*_update`, `*_delete`, `*_add`,
`*_merge`, `*_set` and bulk-delete tool raises before making a request, and `request`
accepts only `GET` and `HEAD`. Listing, getting, searching and reporting tools are
unaffected.

---

## Available tools

Tools are published as `pipedrive.<tool>`.

#### `activities` — 13 tools

| Tool | Description |
|---|---|
| `activity_create` | Create an activity (call, meeting, task, ...) and optionally link it to a deal, person or organization. |
| `activity_delete` | Delete an activity. |
| `activity_delete_bulk` | Delete multiple activities in one call. |
| `activity_field_list` | List the activity fields, including custom fields and their 40-character keys. |
| `activity_get` | Get a single activity by id. |
| `activity_list` | List activities, optionally filtered by owner, type, completion state or due-date range. |
| `activity_mark_done` | Mark an activity as done (or reopen it with done="0"). |
| `activity_type_create` | Create a custom activity type. |
| `activity_type_delete` | Delete an activity type. |
| `activity_type_delete_bulk` | Delete multiple activity types in one call. |
| `activity_type_list` | List the activity types configured in this Pipedrive account, with the key to pass as activity "type". |
| `activity_type_update` | Update an activity type. |
| `activity_update` | Update an activity. Pass done=1 to mark it complete. |

#### `call_logs` — 5 tools

| Tool | Description |
|---|---|
| `call_log_create` | Log a phone call. |
| `call_log_delete` | Delete a call log. |
| `call_log_get` | Get a single call log. |
| `call_log_list` | List the call logs of the authenticated user. |
| `call_log_recording_add` | Attach an audio recording to a call log. |

#### `deals` — 27 tools

| Tool | Description |
|---|---|
| `deal_activities_list` | List activities associated with a deal. |
| `deal_create` | Create a deal. |
| `deal_delete` | Delete a deal. Pipedrive keeps it recoverable for 30 days. |
| `deal_delete_bulk` | Delete multiple deals in one call. |
| `deal_duplicate` | Duplicate a deal. |
| `deal_files_list` | List files attached to a deal. |
| `deal_follower_add` | Add a follower to a deal. |
| `deal_follower_delete` | Remove a follower from a deal. |
| `deal_followers_list` | List followers of a deal. |
| `deal_get` | Get a single deal by id, including its custom fields. |
| `deal_list` | List deals, optionally filtered by owner, stage, status or a saved filter. |
| `deal_mail_messages_list` | List email messages associated with a deal. |
| `deal_merge` | Merge one deal into another. The source deal is removed. |
| `deal_participant_add` | Add a person as a participant of a deal. |
| `deal_participant_delete` | Remove a participant from a deal. |
| `deal_participants_list` | List participants (persons) of a deal. |
| `deal_permitted_users_list` | List users who have permission to see or edit a deal. |
| `deal_persons_list` | List persons linked to a deal, either directly or through its organization. |
| `deal_product_add` | Attach a product to a deal. |
| `deal_product_delete` | Detach a product from a deal. |
| `deal_product_update` | Update a product already attached to a deal. |
| `deal_products_list` | List products attached to a deal, with their quantities and prices. |
| `deal_search` | Search deals by title, notes or custom field values. |
| `deal_summary` | Get a summary of deals: total count and value, grouped by currency. |
| `deal_timeline` | Get deals grouped into time periods, with per-period totals. Useful for pipeline trend questions. |
| `deal_update` | Update a deal. Only the fields you pass are changed. |
| `deal_updates_list` | Get the update history (flow) of a deal: field changes, notes, activities and emails. |

#### `fields` — 6 tools

| Tool | Description |
|---|---|
| `field_create` | Create a custom field on deals, persons, organizations or products. |
| `field_delete` | Delete a custom field. The data stored in it is lost. |
| `field_delete_bulk` | Delete multiple custom fields in one call. |
| `field_get` | Get a single field definition, including its options for enum and set fields. |
| `field_list` | List the fields of deals, persons, organizations or products, including custom fields and the 40-character keys used to read and write them. |
| `field_update` | Update a custom field. Field type cannot be changed after creation. |

#### `files` — 8 tools

| Tool | Description |
|---|---|
| `file_create` | Upload a file and attach it to a deal, person, organization, product, activity or lead. |
| `file_create_remote` | Create a new empty remote document (Google Drive) and attach it to a record. |
| `file_delete` | Delete a file. |
| `file_download` | Download a file. Returns base64 content by default, or decoded text with as_text="1". |
| `file_get` | Get the metadata of a single file. |
| `file_link_remote` | Link an existing remote file (Google Drive) to a record. |
| `file_list` | List files stored in Pipedrive. |
| `file_update` | Rename a file or change its description. |

#### `filters` — 7 tools

| Tool | Description |
|---|---|
| `filter_create` | Create a saved filter. |
| `filter_delete` | Delete a saved filter. |
| `filter_delete_bulk` | Delete multiple saved filters in one call. |
| `filter_get` | Get a single filter, including its condition tree. |
| `filter_helpers_get` | Get the field ids, operators and value formats that filter conditions accept. Call this before building a filter. |
| `filter_list` | List saved filters. Pass a returned filter id as filter_id to the list tools to reuse a filter the user already built in the UI. |
| `filter_update` | Update a saved filter. |

#### `goals` — 5 tools

| Tool | Description |
|---|---|
| `goal_create` | Create a goal. |
| `goal_delete` | Delete a goal. |
| `goal_find` | Find goals by title, assignee, type or period. |
| `goal_results_get` | Get the progress of a goal over a period: how much of the target has been reached. |
| `goal_update` | Update a goal. |

#### `leads` — 12 tools

| Tool | Description |
|---|---|
| `lead_create` | Create a lead. Link it to a person or an organization (at least one is required). |
| `lead_delete` | Delete a lead. |
| `lead_get` | Get a single lead by its uuid. |
| `lead_label_create` | Create a lead label. |
| `lead_label_delete` | Delete a lead label. |
| `lead_label_list` | List the lead labels configured in this account, with the uuids to pass as label_ids. |
| `lead_label_update` | Update a lead label. |
| `lead_list` | List leads from the Leads Inbox. |
| `lead_permitted_users_list` | List users who have permission to see or edit a lead. |
| `lead_search` | Search leads by title, notes or custom field values. |
| `lead_source_list` | List the lead sources available in this account. |
| `lead_update` | Update a lead. Only the fields you pass are changed. |

#### `mailbox` — 6 tools

| Tool | Description |
|---|---|
| `mail_message_get` | Get a single mail message, optionally with its body. |
| `mail_thread_delete` | Delete a mail thread. |
| `mail_thread_get` | Get a single mail thread. |
| `mail_thread_list` | List mail threads in a mailbox folder. |
| `mail_thread_messages_list` | List the messages in a mail thread. |
| `mail_thread_update` | Link a mail thread to a deal or lead, or change its shared, read and archived flags. |

#### `misc` — 8 tools

| Tool | Description |
|---|---|
| `billing_addons_list` | List the billing add-ons the company has subscribed to. |
| `channel_conversation_delete` | Delete a conversation from a messaging channel. |
| `channel_create` | Register a messaging channel so an external inbox can appear in Pipedrive. |
| `channel_delete` | Delete a messaging channel. |
| `channel_message_receive` | Deliver an inbound message from an external messaging provider into a Pipedrive channel. |
| `currency_list` | List the currencies supported by the account, with their ids and decimal precision. |
| `meeting_link_create` | Link a Pipedrive user to a video-calling provider so meeting links can be generated. |
| `meeting_link_delete` | Remove the link between a Pipedrive user and a video-calling provider. |

#### `notes` — 11 tools

| Tool | Description |
|---|---|
| `note_comment_create` | Add a comment to a note. |
| `note_comment_delete` | Delete a comment from a note. |
| `note_comment_get` | Get a single comment on a note. |
| `note_comment_list` | List comments on a note. |
| `note_comment_update` | Update a comment on a note. |
| `note_create` | Create a note. Attach it by passing at least one of deal_id, person_id, org_id, lead_id or project_id. |
| `note_delete` | Delete a note. |
| `note_field_list` | List the note fields available in this account. |
| `note_get` | Get a single note by id. |
| `note_list` | List notes, optionally filtered by the record they are attached to or by date. |
| `note_update` | Update a note. |

#### `org_relationships` — 5 tools

| Tool | Description |
|---|---|
| `org_relationship_create` | Create a relationship between two organizations. |
| `org_relationship_delete` | Delete an organization relationship. |
| `org_relationship_get` | Get a single organization relationship. |
| `org_relationship_list` | List parent/child relationships of an organization. |
| `org_relationship_update` | Update an organization relationship. |

#### `organizations` — 18 tools

| Tool | Description |
|---|---|
| `organization_activities_list` | List activities associated with an organization. |
| `organization_create` | Create an organization. |
| `organization_deals_list` | List deals associated with an organization. |
| `organization_delete` | Delete an organization. |
| `organization_delete_bulk` | Delete multiple organizations in one call. |
| `organization_files_list` | List files attached to an organization. |
| `organization_follower_add` | Add a follower to an organization. |
| `organization_follower_delete` | Remove a follower from an organization. |
| `organization_followers_list` | List followers of an organization. |
| `organization_get` | Get a single organization by id, including its custom fields. |
| `organization_list` | List organizations (companies), optionally filtered by owner, saved filter or first letter. |
| `organization_mail_messages_list` | List email messages associated with an organization. |
| `organization_merge` | Merge one organization into another. The source organization is removed. |
| `organization_permitted_users_list` | List users who have permission to see or edit an organization. |
| `organization_persons_list` | List persons that belong to an organization. |
| `organization_search` | Search organizations by name, address, notes or custom field values. |
| `organization_update` | Update an organization. Only the fields you pass are changed. |
| `organization_updates_list` | Get the update history (flow) of an organization. |

#### `permission_sets` — 3 tools

| Tool | Description |
|---|---|
| `permission_set_assignments_list` | List the users assigned to a permission set. |
| `permission_set_get` | Get a single permission set. |
| `permission_set_list` | List the permission sets available in the account. |

#### `persons` — 18 tools

| Tool | Description |
|---|---|
| `person_activities_list` | List activities associated with a person. |
| `person_create` | Create a person (contact). |
| `person_deals_list` | List deals associated with a person. |
| `person_delete` | Delete a person. |
| `person_delete_bulk` | Delete multiple persons in one call. |
| `person_files_list` | List files attached to a person. |
| `person_follower_add` | Add a follower to a person. |
| `person_follower_delete` | Remove a follower from a person. |
| `person_followers_list` | List followers of a person. |
| `person_get` | Get a single person by id, including emails, phones and custom fields. |
| `person_list` | List persons (contacts), optionally filtered by owner, saved filter or first letter. |
| `person_mail_messages_list` | List email messages associated with a person. |
| `person_merge` | Merge one person into another. The source person is removed. |
| `person_permitted_users_list` | List users who have permission to see or edit a person. |
| `person_products_list` | List products associated with a person through their deals. |
| `person_search` | Search persons by name, email, phone, notes or custom field values. |
| `person_update` | Update a person. Only the fields you pass are changed; passing email or phone replaces the whole list. |
| `person_updates_list` | Get the update history (flow) of a person. |

#### `pipelines` — 8 tools

| Tool | Description |
|---|---|
| `pipeline_conversion_stats` | Get stage-to-stage conversion rates and win/lost rates for a pipeline over a date range. |
| `pipeline_create` | Create a pipeline. |
| `pipeline_deals_list` | List deals in a pipeline. |
| `pipeline_delete` | Delete a pipeline. |
| `pipeline_get` | Get a single pipeline, including per-stage deal totals. |
| `pipeline_list` | List all pipelines. Start here to find the pipeline_id and stage layout of the account. |
| `pipeline_movement_stats` | Get how deals moved into, through and out of each stage of a pipeline over a date range. |
| `pipeline_update` | Update a pipeline. |

#### `products` — 16 tools

| Tool | Description |
|---|---|
| `product_create` | Create a product in the catalogue. |
| `product_deals_list` | List deals a product is attached to. |
| `product_delete` | Delete a product from the catalogue. |
| `product_files_list` | List files attached to a product. |
| `product_follower_add` | Add a follower to a product. |
| `product_follower_delete` | Remove a follower from a product. |
| `product_followers_list` | List followers of a product. |
| `product_get` | Get a single product by id, including its prices. |
| `product_list` | List products from the catalogue. |
| `product_permitted_users_list` | List users who have permission to see or edit a product. |
| `product_search` | Search products by name, code or custom field values. |
| `product_update` | Update a product. |
| `product_variation_create` | Create a product variation. |
| `product_variation_delete` | Delete a product variation. |
| `product_variation_list` | List the variations of a product. |
| `product_variation_update` | Update a product variation. |

#### `projects` — 22 tools

| Tool | Description |
|---|---|
| `project_activities_list` | List the activities of a project. |
| `project_archive` | Archive a project. |
| `project_board_get` | Get a single project board. |
| `project_board_list` | List project boards. Board ids are needed to create a project. |
| `project_create` | Create a project. |
| `project_delete` | Delete a project. |
| `project_get` | Get a single project. |
| `project_groups_list` | List the groups of a project. |
| `project_list` | List projects. |
| `project_phase_get` | Get a single project phase. |
| `project_phase_list` | List the phases of a project board. Phase ids are needed to create a project. |
| `project_plan_activity_update` | Move an activity to another phase or group within a project plan. |
| `project_plan_get` | Get the plan of a project: its tasks and activities with their scheduled dates. |
| `project_plan_task_update` | Move a task to another phase or group within a project plan. |
| `project_task_create` | Create a project task. |
| `project_task_delete` | Delete a project task. |
| `project_task_get` | Get a single project task. |
| `project_task_list` | List project tasks. |
| `project_task_update` | Update a project task. Pass done=1 to complete it. |
| `project_template_get` | Get a single project template. |
| `project_template_list` | List project templates. |
| `project_update` | Update a project. |

#### `request` — 1 tools

| Tool | Description |
|---|---|
| `request` | Call any Pipedrive REST API v1 endpoint directly. Use this only for endpoints that have no dedicated tool here — the typed tools validate their inputs and return compact results, this one returns the raw API payload. Authentication, rate-limit retries and read-only enforcement still apply. See https://developers.pipedrive.com/docs/api/v1 for the endpoint reference. |

#### `roles` — 13 tools

| Tool | Description |
|---|---|
| `role_assignment_add` | Assign a user to a role. |
| `role_assignment_delete` | Remove a user from a role. |
| `role_assignments_list` | List the users assigned to a role. |
| `role_create` | Create a role. |
| `role_delete` | Delete a role. |
| `role_get` | Get a single role. |
| `role_list` | List the roles configured in the account. |
| `role_pipelines_list` | List which pipelines a role can see. |
| `role_pipelines_set` | Set which pipelines a role can see. |
| `role_setting_set` | Change one visibility setting of a role. |
| `role_settings_get` | Get the visibility settings of a role. |
| `role_sub_roles_list` | List the sub-roles of a role. |
| `role_update` | Update a role. |

#### `search` — 4 tools

| Tool | Description |
|---|---|
| `item_search` | Search across every Pipedrive item type at once — deals, persons, organizations, products, leads, files and projects. Use this when you do not know which record type holds the answer. |
| `item_search_by_field` | Search a single field for a value — for example find every deal whose custom "Contract number" field starts with a string. Returns distinct field values by default. |
| `lookup` | Quick global lookup that returns just the id, type and name of each match. Cheaper than item_search when you only need to resolve a name to an id. |
| `recents_list` | List every record created or changed since a timestamp. Use this to sync a CRM snapshot incrementally instead of re-listing everything. |

#### `stages` — 7 tools

| Tool | Description |
|---|---|
| `stage_create` | Create a stage in a pipeline. |
| `stage_deals_list` | List deals sitting in a stage. |
| `stage_delete` | Delete a stage. |
| `stage_delete_bulk` | Delete multiple stages in one call. |
| `stage_get` | Get a single stage. |
| `stage_list` | List stages, optionally restricted to a single pipeline. |
| `stage_update` | Update a stage. |

#### `subscriptions` — 9 tools

| Tool | Description |
|---|---|
| `subscription_delete` | Delete a subscription and detach it from its deal. |
| `subscription_find_by_deal` | Find the subscription attached to a deal. |
| `subscription_get` | Get a single revenue subscription. |
| `subscription_installment_create` | Create an installment subscription on a deal. |
| `subscription_installment_update` | Replace the payment schedule of an installment subscription. |
| `subscription_payments_list` | List the payments of a subscription. |
| `subscription_recurring_cancel` | Cancel a recurring subscription. |
| `subscription_recurring_create` | Create a recurring revenue subscription on a deal. |
| `subscription_recurring_update` | Update a recurring subscription from a given date onward. |

#### `teams` — 8 tools

| Tool | Description |
|---|---|
| `team_create` | Create a team. |
| `team_get` | Get a single team. |
| `team_list` | List all teams. |
| `team_list_for_user` | List the teams a user belongs to. |
| `team_update` | Update a team. |
| `team_user_add` | Add users to a team. |
| `team_user_delete` | Remove users from a team. |
| `team_users_list` | List the user ids that belong to a team. |

#### `users` — 12 tools

| Tool | Description |
|---|---|
| `user_connections_list` | List the third-party accounts (Google, Microsoft, ...) connected to the authenticated user. |
| `user_create` | Invite a new user to the Pipedrive account. |
| `user_find` | Find users by name or email. |
| `user_followers_list` | List the followers of a user. |
| `user_get` | Get a single user by id. |
| `user_list` | List all users in the Pipedrive account. Use this to resolve a user name to the user_id needed by owner filters. |
| `user_me` | Get the user the API token belongs to, including the company id, domain and default currency. |
| `user_permissions_get` | List the effective permissions of a user (what they can see, add, edit and delete). |
| `user_role_assignments_list` | List the role assignments of a user. |
| `user_role_settings_get` | Get the role settings that apply to a user. |
| `user_settings_get` | Get the authenticated user settings: timezone, currency, date format and feature flags. |
| `user_update` | Activate or deactivate a user. |

#### `webhooks` — 3 tools

| Tool | Description |
|---|---|
| `webhook_create` | Create a webhook subscription. |
| `webhook_delete` | Delete a webhook subscription. |
| `webhook_list` | List the webhooks registered by this API token. |

---

## Running the tests

```bash
# Unit tests — no credentials, no network
python -m pytest nodes/test/tool_pipedrive/test_pipedrive.py -v

# Live suite — reads only
export PIPEDRIVE_API_TOKEN=<sandbox token>
export PIPEDRIVE_COMPANY_DOMAIN=<yourcompany>   # optional
python -m pytest nodes/test/tool_pipedrive/test_tools.py -v

# Live suite including tests that create and delete records
export PIPEDRIVE_ALLOW_WRITES=1
python -m pytest nodes/test/tool_pipedrive/test_tools.py -v
```

The live suite writes to a real Pipedrive account. Point it at a sandbox.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `pipedrive.allowRawRequest` | `boolean` | **Allow raw API requests**<br/>Publishes the generic <b>request</b> tool, which can call any Pipedrive v1 endpoint by method and path. It uses the same authentication, rate-limit handling and read-only enforcement as the typed tools. Disable to restrict the agent to the typed tools only. | `true` |
| `pipedrive.apiToken` | `string` | **API Token**<br/>Pipedrive API token (Settings -> Personal preferences -> API), or an OAuth access token. Tokens starting with a JWT-style prefix are sent as a Bearer header; everything else is sent as the api_token query parameter. | `""` |
| `pipedrive.companyDomain` | `string` | **Company Domain**<br/>Your Pipedrive company domain, i.e. the "acme" in https://acme.pipedrive.com. When set, requests go to https://{domain}.pipedrive.com/api/v1; otherwise https://api.pipedrive.com/api/v1 is used. | `""` |
| `pipedrive.readOnly` | `boolean` | **Read-only mode**<br/>When enabled, every create, update and delete tool is blocked, and the generic request tool only accepts GET. Safe for agents that should only inspect the CRM. | `false` |
| `pipedrive.toolGroups` | `array` | **Tool groups**<br/>Which groups of Pipedrive tools this node publishes to the agent. The full API is 255 tools, which is more than an LLM can choose between reliably, so only the selected groups are exposed. Pick one or more from the list; tool counts are shown per group, and selections totalling more than 120 log a warning but still run. Selecting <b>All groups</b> publishes everything and skips that warning. | `["deals","persons","organizations","activities","pipelines","stages","notes","search"]` |

## Dependencies

- `requests` `>=2.34.2`
- `tenacity`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_pipedrive)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
