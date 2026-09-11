# Slack Events

## What it does

Slack Events is a `source` node (`slack://`) that receives Slack Events API HTTP callbacks at `/slack/events`. It authenticates callbacks, acknowledges them quickly, and injects approved event content into a RocketRide pipeline. It makes no outbound Slack API calls.

## Lanes and routing

The `_source` lane emits `text` and `json`. These are the only five approved
event routes:

| Slack callback | Output lane | Payload |
|---|---|---|
| `app_mention` | `text` | Exact `event.text` |
| `message.channels` | `text` | Exact `event.text` |
| `message.groups` | `text` | Exact `event.text` |
| `message.im` | `text` | Exact `event.text` |
| `reaction_added` | `json` | Exact inner `event` object |

Each emitted entry retains the complete outer Slack envelope as native
`Entry.metadata` (`IJson`); it is not serialized into either output lane.

Slack-marked bot/app text events are authenticated and acknowledged, then
ignored to prevent feedback loops. This applies when `event.bot_id` or
`event.app_id` is a nonempty string, or `event.subtype` is exactly
`bot_message`; it does not apply to `reaction_added` or other user-authored
message subtypes.
Unsupported or incomplete authenticated events are acknowledged and ignored.

## Setup

1. Create a Slack app and enable **Event Subscriptions**.
2. Set Slack's Request URL to the runtime-published `/slack/events` URL.
3. Subscribe to `app_mention`, `message.channels`, `message.groups`,
   `message.im`, and `reaction_added`. Grant their matching scopes:
   `app_mentions:read`, `channels:history`, `groups:history`, `im:history`,
   and `reactions:read`.
4. Copy the app's signing secret to the secure **Signing Secret** field, or set
   `SLACK_SIGNING_SECRET` in the runtime environment.

The listener is available only while the pipeline is running. Slack must be able to reach the published URL over HTTPS.

## Signing secret

The secure `slack.signingSecret` configuration takes precedence when nonempty.
Otherwise the node reads `SLACK_SIGNING_SECRET`. Requests are verified against
their exact raw body with Slack's HMAC-SHA256 signature and a five-minute
timestamp freshness window before their JSON is parsed.

## Queue and deduplication

Accepted events enter a bounded in-memory queue. `slack.queueCapacity` defaults
to 1000 events and accepts values from 1 through 10000. A full queue returns
`503` without recording the event ID, allowing Slack to retry.

Event IDs are deduplicated in process memory for 600 seconds by default.
`slack.dedupTtlSeconds` accepts values from 300 through 3600 seconds. The
deduplication cache holds at most 10000 IDs and is intentionally process-local:
a restart clears it, so a duplicate can be processed after a restart. IDs are
recorded only after successful enqueue.

## Acknowledgement, retries, and delivery behavior

Slack expects an acknowledgement within three seconds. After authenticating and
classifying a supported callback, the node queues it and responds without
waiting for pipeline processing. URL verification is authenticated before its
challenge is returned and is never emitted. Healthy and duplicate deliveries
receive an empty `200` response. Invalid signatures receive `401`, malformed
authenticated JSON receives `400`, and unavailable or saturated intake receives
`503`; request bodies larger than 1 MiB receive `413`. Slack can retry `503` responses.

After successful enqueue, the node does not provide a durable retry for
downstream pipe-emission failures: it records the failure and does not requeue
the delivery.

The queue and deduplication cache are process-local and not durable. On an
orderly shutdown, intake stops and the node waits up to five seconds for queued
and in-flight work, then allows up to five seconds for the consumer to exit
before cancelling it. After that cancellation window, shutdown still waits for
an already-running downstream pipe write before pipe teardown. An abrupt
process termination can lose accepted queued work, and a restart clears
deduplication state.

Only the five approved callback shapes are emitted. Socket Mode, OAuth app
installation or provisioning, subscription discovery or management, and
outbound Slack Web API calls are outside this node. All other Slack event types
and incomplete approved shapes are ignored after authentication.

## Example

[`examples/slack-events.pipe`](../../../../examples/slack-events.pipe) connects
the `text` lane to `response_text` and the `json` lane to `response_json`.
Configure the signing secret outside the pipeline file and source control.

## Upstream documentation

- [Slack Events API](https://api.slack.com/apis/events-api)
- [Request URLs](https://api.slack.com/apis/events-api/using-http-request-urls)
- [Signing secret verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [URL verification](https://api.slack.com/events/url_verification)
- [Events reference](https://api.slack.com/events)

## Troubleshooting

- **URL verification fails:** confirm the pipeline is running, the published
  `/slack/events` URL is reachable, and the signing secret is correct.
- **Invalid signature:** check that a proxy does not alter the raw request body and that the configured secret belongs to the same Slack app.
- **Stale local clock:** synchronize the runtime host's clock; Slack signatures
  outside the five-minute window are rejected.
- **Missing scopes:** confirm Event Subscriptions, all five individual event
  types, and their matching scopes are configured in Slack.
- **Queue saturation:** reduce downstream work or raise queue capacity within
  the 1--10000 limit; Slack retries `503` responses.
- **Duplicate deliveries:** duplicates are suppressed only while their event ID
  remains in this process's TTL cache; a restart resets that cache.
- **Pipeline is not running:** start the pipeline before Slack sends callbacks;
  the public listener exists only while the pipeline runs.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.source.parameters` |  | **Slack Events Configuration** |  |
| `slack.dedupTtlSeconds` | `integer` | **Deduplication TTL (seconds)**<br/>How long accepted Slack event IDs are retained to prevent duplicate emission. | `600` |
| `slack.queueCapacity` | `integer` | **Queue Capacity**<br/>Maximum accepted Slack events held in memory before Slack is asked to retry. | `1000` |
| `slack.signingSecret` | `string` | **Signing Secret**<br/>Slack signing secret. If empty, SLACK_SIGNING_SECRET is used. |  |

## Dependencies

- `fastapi`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/slack)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
