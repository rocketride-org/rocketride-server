---
title: Configuration
sidebar_position: 1
---

# Configuration

Everything the `RocketRideClient` constructor accepts, the environment variables it
reads, and how its timeouts, reconnection, and debug hooks behave.

## Constructor

```python
from rocketride import RocketRideClient

client = RocketRideClient(
    uri='https://api.rocketride.ai',
    auth='my-key',
    persist=True,
)
```

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `uri` | `str` | RocketRide Cloud (`https://api.rocketride.ai`) | Server URI. Falls back to `ROCKETRIDE_URI` from the environment, then to the Cloud endpoint. See [URI scheme](/clients/python/connection#uri-scheme). |
| `auth` | `str` | `None` | API key. Falls back to `ROCKETRIDE_APIKEY`. Omitting it leaves the client unauthenticated until [`connect(credential)`](/clients/python/connection) or `login()` supplies one. |
| `env` | `dict` | — | Override the environment map used for `${ROCKETRIDE_*}` substitution and credential lookup. If omitted, the client copies `os.environ` and then merges `.env` underneath it — **process environment wins** over `.env` values. |
| `module` | `str` | `CLIENT-0`, `CLIENT-1`, … | Client name for logging. |
| `request_timeout` | `float` | — | Default timeout in **ms** for DAP requests. Prevents a single call from hanging. |
| `max_retry_time` | `float` | — | Deprecated: accepted but **ignored** — reconnection never gives up. See [Reconnection](#reconnection). |
| `persist` | `bool` | `False` | Automatic reconnection. Set `True` for long-lived scripts or UIs. See [Reconnection](#reconnection). |
| `public` | `bool` | `False` | Reserved: declared but not currently consumed by the client. For unauthenticated public calls, [`attach()`](/clients/python/connection) without logging in. |
| `ws_path` | `str` | `'/task/service'` | WebSocket path override. Model-server clients pass `'/models'`. |
| `client_name` | `str` | `'Python SDK'` | Display name reported to the server. |
| `client_version` | `str` | package version | Display version reported to the server. |

There is no "missing uri/auth" error at construction time: an empty `uri` resolves to
RocketRide Cloud and an empty `auth` stays `None`. The only constructor-time
`ValueError` is a URI with no hostname.

## Callbacks

All lifecycle callbacks are **awaited** — pass `async` functions (a plain `lambda`
raises `TypeError` when the client awaits it).

| Argument | Called | Description |
| --- | --- | --- |
| `on_event` | per server event | Receives each event `dict`. Subscribe per-task with [`add_monitor`](/clients/python/pipelines#events). |
| `on_connected` | connection established | Receives connection info. |
| `on_disconnected` | connection lost **after** being connected | Args: `reason`, `has_error`. Do not call `disconnect()` here if you want auto-reconnect. |
| `on_connect_error` | each failed **reconnect** attempt (persist mode) | Args: `message: str`. An initial `connect()` failure raises to the caller instead. On auth failure the client stops retrying. |
| `on_protocol_message` | per raw DAP message | Plain callable; for protocol debugging. |
| `on_debug_message` | per debug line | Plain callable; for debug output. |
| `on_trace` | around high-level SDK requests | Plain callable (NOT awaited): `(type, message)`. Unlike the TypeScript `onTrace`, the message is not credential-redacted. |

```python
async def handle_event(event):
    print(event.get('event'), event.get('body'))


async def handle_connect_error(message):
    print('Connect error:', message)


client = RocketRideClient(
    uri='https://api.rocketride.ai',
    auth='my-key',
    persist=True,
    on_event=handle_event,
    on_connect_error=handle_connect_error,
)
```

## Reconnection

With `persist=True` the client reconnects with **linear backoff**: the delay grows by
0.25 s per consecutive failure, capped at 15 s, and reconnection **never gives up** —
`on_connect_error` fires on each failed attempt so you can surface "still
connecting…" in a UI. The one exception is an authentication failure: the client
stops retrying so the app can fix credentials and call `connect()` again.

`max_retry_time` is accepted for backward compatibility but **ignored**.

## Environment variables

| Variable | Description |
| --- | --- |
| `ROCKETRIDE_URI` | Server URI (e.g. `wss://api.rocketride.ai` or `ws://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key for authentication |
| `ROCKETRIDE_TOKEN` | User token, accepted by the [CLI](/connect/cli) as an alternative credential |

The same map drives `${ROCKETRIDE_*}` substitution inside pipeline configs: the raw
pipeline is sent to the server, which resolves variables from its merged environment.

## Timeouts

`request_timeout` (constructor) sets the default for every DAP request;
[`request(..., timeout=...)`](/clients/python/reference#advanced-low-level-dap) overrides it
per call. [`connect(timeout=...)`](/clients/python/connection) bounds the connect +
auth handshake in non-persist mode. All timeouts are in milliseconds.
