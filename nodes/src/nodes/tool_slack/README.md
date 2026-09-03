# tool_slack

A RocketRide tool node that lets an AI agent act on a Slack workspace.

## What it does

Gives an agent the core Slack operations: post messages to channels or threads,
list public channels, read channel history, and verify the connection. Useful for
agents that announce results, notify a team channel, or read recent discussion
before answering.

Uses the official **slack_sdk** package — `WebClient` for the Slack Web API in
bot-token mode, `WebhookClient` in incoming-webhook mode. API responses are
stripped down to compact, agent-useful fields (channel ids and names, message
`ts`/`user`/`text`) instead of raw Slack JSON.

Exactly one of the two auth modes must be configured; the pipeline fails to
start with both or neither:

| Mode | Configured with | Tools available |
|---|---|---|
| **Bot token** | `token` (starts with `xoxb-`) | all four tools |
| **Incoming webhook** | `webhookUrl` | `message_post` only |

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `token` | string | Default empty. Bot User OAuth Token from the app's **OAuth & Permissions** page. Needs `chat:write` to post, `channels:read` to list channels, and `channels:history` to read history. Leave empty when using a webhook URL. |
| `webhookUrl` | string | Default empty. Slack incoming-webhook URL for zero-scope, post-only setups. Messages always go to the channel the webhook was created for. Configure either this or a bot token, not both. |

Both fields are secure (masked in the UI). Reference secrets with the engine's
environment substitution instead of pasting literals, e.g.
`"token": "${ROCKETRIDE_SLACK_TOKEN}"`. When **neither** field is set, the node
falls back to the `ROCKETRIDE_SLACK_TOKEN` / `ROCKETRIDE_SLACK_WEBHOOK_URL`
environment variables; explicitly configured values always win, so a stray
environment variable can never override the configured mode.

---

## Available tools

| Tool | Description |
|---|---|
| `check_connection` | Verify the credentials via `auth.test`. Returns the workspace (`team`, `team_id`, `url`) and bot identity (`user`, `user_id`, `bot_id`). |
| `message_post` | Post a message via `chat.postMessage`. `text` is required; `channel` is required in token mode. Optional `thread_ts` replies in a thread; `unfurl_links` (default `true`) controls link previews. Returns `channel`/`ts` (plus `thread_ts` when replying in a thread). |
| `channels_list` | List **public** channels via `conversations.list`. `limit` 1–1000 (default 200); cursor pagination is handled internally with a hard cap of 1000 channels. Returns `id`, `name`, `is_private`, `is_archived`, and `num_members` per channel. |
| `channel_history` | Read recent messages via `conversations.history`, newest first. `channel` is required (the bot must be a member); `limit` 1–200 (default 50); optional `oldest`/`latest` timestamps bound the window. Returns `ts`, `user`, and `text` per message, plus `thread_ts` for threaded messages. Also returns `subtype` when Slack classifies the entry — system events such as `channel_join`, `channel_leave` and `channel_topic`, and `bot_message` for bot-authored posts — and `bot_id` identifying which bot posted. Both are absent on ordinary user messages: use `subtype` to filter join/leave noise, and `bot_id` to skip your own posts by comparing it against the one `check_connection` reports. |

Channel parameters accept a channel ID (e.g. `C0123ABCDEF`) or a name (e.g.
`#general`). If a call fails with `channel_not_found` for a name, resolve the ID
with `channels_list` first — some Slack endpoints only accept IDs.

### Webhook mode

With `webhookUrl` configured, only `message_post` is available. `channel` and
`thread_ts` are ignored — the message always goes to the channel the webhook was
created for — and the result carries an explicit `note` saying so. The other
three tools fail with a `SlackBadRequestError` explaining that they require a
bot token.

---

## Authentication

### Bot token

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (**From scratch**).
2. Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add the scopes below.
3. **Install App** to the workspace and copy the **Bot User OAuth Token**
   (starts with `xoxb-`) into `token`.
4. Invite the bot to every channel it should post to or read: `/invite @your-bot`.

| Tool | Required scope |
|---|---|
| `message_post` | `chat:write` |
| `channels_list` | `channels:read` |
| `channel_history` | `channels:history` |
| `check_connection` | none (any valid bot token) |

A missing scope surfaces as a `SlackMissingScopeError` naming the exact scope to
add. The node only lists public channels; reading a channel's history requires
the bot to be a member of it.

### Incoming webhook

For post-only setups without granting any OAuth scopes: in the app, open
**Incoming Webhooks**, activate them, click **Add New Webhook to Workspace**,
pick the target channel, and copy the generated URL into `webhookUrl`. Treat the
webhook URL itself as a secret — anyone holding it can post to the channel.

---

## Errors

Failures are raised as a typed hierarchy (all subclasses of `SlackError`), named
so retry/circuit-breaker heuristics can classify them:

| Error | Raised on | Retryable |
|---|---|---|
| `SlackAuthenticationError` | `invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`; webhook `invalid_token`/`forbidden` | no — fix the token or webhook URL |
| `SlackMissingScopeError` | `missing_scope` — the message names the missing OAuth scope from Slack's `needed` field | no — add the scope and reinstall the app |
| `SlackRateLimitError` | `ratelimited` / HTTP 429 — `retry_after` carries the wait in seconds from Slack's `Retry-After` header | yes, after `retry_after` |
| `SlackBadRequestError` | invalid requests, e.g. `channel_not_found` (check the ID or name), `not_in_channel` (invite the bot), `is_archived`; also any non-post tool in webhook mode | no — fix the request |
| `SlackServerError` | `internal_error`, `service_unavailable`, `fatal_error`, HTTP 5xx, and unexpected failures | yes |

Error messages are built exclusively from Slack's structured response fields
(error code, `needed` scope, `Retry-After` header) — never from raw exception
text — so the configured token or webhook URL can never leak into an error or
log message.

---

## Example

[`examples/slack-agent.pipe`](../../../../examples/slack-agent.pipe) wires
`chat → agent_rocketride → response` with this node attached on the tool
channel, so the agent can post its answers to a channel, list channels, and read
recent history.

---

## Running the tests

```bash
# Self-contained unit tests (no credentials, no network)
pytest nodes/test/tool_slack/test_slack.py -v
```

The dynamic services test (part of `builder nodes:test-full`) needs no
credentials: in mock mode (`ROCKETRIDE_MOCK`) the test framework injects a
placeholder token and the canonical mock under `nodes/test/mocks/slack_sdk/`
answers the API calls. With a real `ROCKETRIDE_SLACK_TOKEN` exported and mock
mode off, the same test runs against the live Slack API via the node's
env-var fallback.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `slack.token` | `string` | **Bot User OAuth Token**<br/>Slack bot token (starts with xoxb-) from your app's OAuth & Permissions page. Needs chat:write to post, channels:read to list channels, and channels:history to read history. Leave empty when using a webhook URL. | `""` |
| `slack.webhookUrl` | `string` | **Incoming Webhook URL**<br/>Slack incoming-webhook URL for zero-scope setups. Enables ONLY message_post, and messages always go to the channel the webhook was created for. Configure either this or a bot token, not both. | `""` |

## Dependencies

- `slack_sdk` `>=3.27.0,<4.0.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_slack)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
