---
title: Connection
sidebar_position: 2
---

# Connection

How the client attaches, authenticates, stays connected, and shuts down. The full
method tables live in the [API reference](/clients/python/reference#connection).

## The layered model

The connection has two layers you can drive together or separately:

- **Attach** opens the WebSocket without authenticating — enough for public
  operations like catalog browsing.
- **Login** performs the DAP auth handshake over an attached transport and returns a
  `ConnectResult` carrying your full identity (user, organizations, apps, teams).

`connect()` does both in one call; `disconnect()` logs out and detaches. The state
probes mirror the layers: `is_attached()` (socket open) and `is_authenticated()`
(auth handshake succeeded). `is_connected()` is a backward-compatible alias with
the same meaning as `is_attached()` — it does **not** imply authentication.

```python
result = await client.connect()  # attach + login
print(result['displayName'])

await client.logout()  # drop auth, keep the socket
await client.login('other-credential')  # re-auth on the same connection
await client.detach()  # tear down the socket
```

Calling `login()` with a different credential logs out first (best-effort); with the
same credential it is a no-op. `attach()` to a different URI detaches and
re-attaches.

## Context manager (recommended)

`async with` guarantees the connection closes even on exception — entering calls
`connect()`, exiting calls `disconnect()`:

```python
async with RocketRideClient(uri='wss://api.rocketride.ai', auth=os.environ['ROCKETRIDE_APIKEY']) as client:
    result = await client.use(filepath='pipeline.pipe')
    await client.send(result['token'], 'Hello, pipeline!')
```

> TypeScript's counterparts to the context manager are
> [`withConnection()` and `await using`](/clients/typescript/connection#scoped-disconnect).

## URI scheme

The scheme selects the transport. The client normalizes the `uri` to a WebSocket
address before connecting: `https://` and `wss://` both resolve to a secure `wss://`
connection, while `http://`, `ws://`, and a bare `host:port` resolve to plain
`ws://`. For RocketRide Cloud use `https://api.rocketride.ai` (or the equivalent
`wss://api.rocketride.ai`); for a local engine use `ws://localhost:5565`.

**Caution:** against a Cloud endpoint always use `https://` or `wss://` — an
`http://` or `ws://` URI (or a bare `host:port`) silently downgrades to an
unencrypted `ws://` connection.

## Staying connected

With `persist=True` the client survives drops: it reconnects with linear backoff
(+0.25 s per failure, 15 s cap) and never gives up, except on auth failure. Wire the
[lifecycle callbacks](/clients/python/configuration#callbacks) to observe it:

```python
async def on_connected(info):
    print('Connected:', info)


async def on_disconnected(reason, has_error):
    # Fires only after a successful connection drops.
    # Do NOT call disconnect() here if you want auto-reconnect.
    print('Disconnected:', reason, has_error)


async def on_connect_error(message):
    # Fires on each failed RECONNECT attempt; an initial connect() failure
    # raises to the caller instead.
    print('Connect error:', message)


client = RocketRideClient(
    uri='https://api.rocketride.ai',
    auth='my-key',
    persist=True,
    on_connected=on_connected,
    on_disconnected=on_disconnected,
    on_connect_error=on_connect_error,
)
await client.connect()
```

Use `on_disconnected` for "we were connected and then dropped"; use
`on_connect_error` for "failed to connect".

## Inspecting state

`get_connection_info()` returns `{'connected': bool, 'transport': str, 'uri': str}`
— useful for a "Connected to …" display. `get_apikey()` returns the key in use
(debugging only; avoid logging it). `set_env()` replaces the client's environment
map used for `${ROCKETRIDE_*}` substitution and credential lookup.
