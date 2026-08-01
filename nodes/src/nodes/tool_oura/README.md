# tool_oura

A RocketRide agent tool node that exposes the [Oura API v2](https://cloud.ouraring.com/v2/docs) as read-only tools. Bind it to any agent (`agent_rocketride`, `agent_langchain`, `agent_crewai`, `agent_deepagent`) and the agent can query the token owner's Oura Ring data on demand.

## What it does

Wraps every current Oura v2 `usercollection` endpoint behind 21 tool functions (the deprecated `tag` endpoint is skipped in favor of its successor, `enhanced_tag`). All operations are **read-only** — the Oura v2 API offers no write endpoints for personal data, so an agent bound to this node can never modify anything.

Responses are compacted before they reach the agent: heavy time-series fields (`class_5_min`, `sleep_phase_5_min`, `hrv`, `heart_rate`, `met`, `movement_30_sec`, `motion_count`) are stripped unless the tool call passes `include_detail: true`. This keeps multi-day queries within sane token budgets while leaving full-resolution data one flag away.

Pagination is followed transparently (up to 10 pages per call). If a range is truncated, the response carries a `next_token` the agent can pass back to continue — Oura returns documents date-ascending, so the missing pages hold the most recent data. `daily_summary` cannot paginate; it instead flags a page-cap hit with a `truncated` key so the agent knows to narrow the range.

### Tools

| Tool | Oura collection | Description |
|---|---|---|
| `personal_info` | `personal_info` | Age, weight, height, biological sex, email |
| `ring_configuration` | `ring_configuration` | Ring color, design, firmware, hardware, size |
| `ring_battery_level` | `ring_battery_level` | Battery level samples over time (datetime-windowed) |
| `daily_summary` | (merged) | One record per day combining sleep, readiness, activity, and stress |
| `sleep_daily` | `daily_sleep` | Daily sleep scores and contributors |
| `readiness_daily` | `daily_readiness` | Daily readiness scores and contributors |
| `activity_daily` | `daily_activity` | Steps, calories, MET minutes, sedentary time |
| `stress_daily` | `daily_stress` | High-stress / high-recovery seconds, day summary |
| `resilience_daily` | `daily_resilience` | Resilience level and contributors |
| `spo2_daily` | `daily_spo2` | Blood oxygen averages, breathing disturbance index |
| `cardiovascular_age_daily` | `daily_cardiovascular_age` | Vascular age estimates |
| `sleep_periods` | `sleep` | Detailed sleep periods: stages, HR, HRV, respiratory rate |
| `heartrate` | `heartrate` | Raw heart rate samples (datetime-windowed) |
| `workouts` | `workout` | Logged workouts |
| `sessions` | `session` | Meditation / breathing / relaxation sessions |
| `tags` | `enhanced_tag` | User-logged events (caffeine, alcohol, sickness, custom) |
| `rest_mode_periods` | `rest_mode_period` | Rest mode windows |
| `sleep_time` | `sleep_time` | Recommended bedtime windows |
| `vo2_max` | `vO2_max` | VO2 max estimates |
| `collection_get` / `document_get` | (any) | Generic escape hatches: any date-filtered collection by name, any document by ID. `heartrate`, `ring_battery_level`, and `ring_configuration` are excluded where their filters don't apply — use the dedicated tools |

Date-range tools accept `start_date` / `end_date` (ISO `YYYY-MM-DD`); when omitted, `end_date` defaults to tomorrow (UTC) — Oura `day` fields use the wearer's local timezone, so UTC-today would drop the current local day for anyone ahead of UTC — and `start_date` to a per-tool sensible window (7 days for daily scores, 30 for workouts/sessions/tags, 90 for rest mode). `heartrate` and `ring_battery_level` filter on ISO datetimes (24-hour and 72-hour default windows respectively).

---

## Configuration

### Lanes

This is a `tool` node: it has **no data lanes**. Bind it to an agent's tool channel instead of wiring it into the data flow.

### Fields

| Field | Type | Description |
|---|---|---|
| `token` | string | Oura API bearer token — OAuth2 access token, or a legacy personal access token (secure field) |

---

## Authentication

The token is resolved in the following order:

1. `token` in the node config
2. `token` in the connection config
3. The `ROCKETRIDE_OURA_TOKEN` environment variable

The node sends the token as a standard `Authorization: Bearer` header, so any valid Oura API v2 bearer token works. Oura deprecated personal access tokens in December 2025 (previously issued ones still work); new tokens come from the OAuth2 flow of a registered API application:

1. Register an application at [cloud.ouraring.com](https://cloud.ouraring.com) (personal single-user apps need no Oura approval — the 10-user limit only applies beyond that). A `localhost` redirect URI is fine.
2. For quick personal use, run the implicit flow: open `https://cloud.ouraring.com/oauth/authorize?client_id=<CLIENT_ID>&redirect_uri=<REDIRECT_URI>&response_type=token` in a browser, approve, and copy the `access_token` from the redirect URL fragment. Implicit-flow tokens expire after ~30 days. **Omit the `scope` parameter** so the consent screen offers every scope enabled for your app — Oura's documented scope list (`email personal daily heartrate workout tag session spo2Daily`) is incomplete, and several of this node's tools need undocumented scopes (`ring_configuration`, `stress`, `heart_health`). A token minted with only the documented scopes gets `Oura scope not granted (401)` on ring configuration, battery level, stress, resilience, cardiovascular age, and VO2 max.
3. For renewable tokens, use the authorization-code flow (`response_type=code`, then exchange at `https://api.ouraring.com/oauth/token` with the client secret) and rotate via the returned single-use `refresh_token`.

If your pipeline only needs a subset of the data, you can still pass an explicit `scope` parameter to restrict the token. If no source provides a token, the pipeline fails at startup with `tool_oura: token is required`; the editor also surfaces a validation warning while configuring the node.

---

## Error handling

Oura HTTP errors are mapped to descriptive failures the agent can act on:

- **401**: `Oura authentication failed` — bad or expired token; when Oura's response mentions a scope, it is surfaced as `Oura scope not granted` instead (Oura reports missing OAuth scopes as 401, not 403), so re-authorize the app with that scope rather than replacing the token. `daily_summary` degrades gracefully: collections the token lacks scopes for are skipped and listed in `skipped_collections` instead of failing the whole call
- **403**: `Oura access denied` — token lacks the required scope
- **404**: `Oura resource not found` — wrong or stale document ID, or an ID from a different collection
- **422**: `Oura rejected the request parameters` — malformed dates or filters
- **426**: `Oura subscription required` — the data needs an active Oura membership
- **429**: `Oura rate limit exceeded` — Oura allows 5000 requests per 5-minute window
- Network timeout / connection failures raise with an explicit message

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `oura.token` | `string` | **Access Token**<br/>Oura API bearer token: an OAuth2 access token from a registered app at cloud.ouraring.com (personal access tokens were deprecated in Dec 2025; previously issued ones still work). Grants read-only access to the token owner's data. Falls back to the ROCKETRIDE_OURA_TOKEN environment variable when empty. | `""` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_oura)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
