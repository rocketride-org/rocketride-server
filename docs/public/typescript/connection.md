---
title: Connection
sidebar_position: 2
---

# Connection

How the client attaches, authenticates, stays connected, and shuts down. The full
method tables live in the [API reference](/clients/typescript/reference#connection).

## The layered model

The connection has two layers you can drive together or separately:

- **Attach** opens the WebSocket without authenticating — public `rrext_public_*`
  requests are available on an anonymous attachment.
- **Login** authenticates over the attachment, restores monitor subscriptions, and
  returns a `ConnectResult` carrying your full identity (user, organizations, apps,
  teams).

`connect()` performs attach + login as one foreground operation; `disconnect()` does
a best-effort logout, cancels pending work, and detaches. The state probes mirror
the layers: `isAttached()` (socket open), `isAuthenticated()` (auth succeeded), and
`isConnected()` — a compatibility **alias for `isAttached()`**; it does not imply
authentication.

```typescript
const result = await client.connect();
console.log(result.displayName);

await client.logout(); // drop auth, keep an anonymous attachment
await client.login('other-credential'); // re-auth on the same connection
await client.detach(); // tear down the socket
```

For UIs that need anonymous public calls before sign-in: `attach()`, then
`login()`, and `logout()` to return to a fresh anonymous attachment. `login()` also
accepts an OAuth code exchange (`{ code, verifier, redirectUri }`) as the
credential.

## Concurrent logins

Concurrent foreground `login()`/`connect()` calls for the same endpoint and
credential **join** one operation: one attachment, one auth request, one result. A
different foreground login **supersedes** the earlier one, and foreground work
always supersedes background reconnects (never the reverse). Superseded waiters
reject with `LoginAttemptCancelledError('superseded')`; the error's `reason` is
exactly `'superseded'`, `'logout'`, or `'detached'`. An unsolicited transport loss
during login rejects with `ConnectionException` instead. See
[Error Handling](/clients/typescript/errors).

## Scoped disconnect

The client supports `await using` (`Symbol.asyncDispose`) for automatic disconnect
when leaving scope, and `RocketRideClient.withConnection()` for one-off scripts:

```typescript
const status = await RocketRideClient.withConnection({ auth: 'my-key', uri: 'wss://api.rocketride.ai' }, async (client) => {
	const { token } = await client.use({ pipeline: myPipelineConfig });
	await client.send(token, JSON.stringify({ data: 1 }));
	return await client.getTaskStatus(token);
});
```

> Python's counterpart to scoped disconnect is the
> [async context manager](/clients/python/connection#context-manager-recommended).

## URI scheme

The scheme selects the transport: `https://` and `wss://` resolve to a secure
`wss://` connection, while `http://`, `ws://`, and a bare `host:port` resolve to
plain `ws://`. For RocketRide Cloud use `https://api.rocketride.ai` (or
`wss://api.rocketride.ai`); for a local engine use `ws://localhost:5565`.

**Caution:** against a Cloud endpoint always use `https://` or `wss://` — an
`http://` or `ws://` URI (or a bare `host:port`) silently downgrades to an
unencrypted `ws://` connection.

## Staying connected

With `persist: true` the client survives drops — linear backoff (250 ms steps,
15 s cap), never gives up, auth failures excepted. Wire the
[lifecycle callbacks](/clients/typescript/configuration#callbacks) to observe it:

```typescript
const client = new RocketRideClient({
	auth: apiKey,
	uri: serverUri,
	persist: true,
	onConnected: async () => updateUI({ state: 'connected' }),
	onDisconnected: async (reason, hasError) => updateUI({ state: 'disconnected', reason, hasError }),
	onConnectError: (error) => updateUI({ state: 'error', message: error.message }),
});
await client.connect();
```

Use `onDisconnected` for "we were connected and then dropped"; use
`onConnectError` for "failed to connect". Only call `detach()` or `disconnect()`
when reconnection should stop.

## Inspecting state

`getConnectionInfo()` returns `{ connected, transport, uri }` — useful for a
"Connected to …" display. `getApiKey()` returns the key in use (debugging only;
avoid logging it). `setEnv()` replaces the environment map used for
`${ROCKETRIDE_*}` substitution and credential lookup.
