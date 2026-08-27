---
title: Configuration
sidebar_position: 1
---

# Configuration

Everything `RocketRideClientConfig` accepts, the environment variables the client
reads, and how its timeouts, reconnection, and debug hooks behave.

## Constructor

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'https://api.rocketride.ai',
	persist: true,
});
```

`new RocketRideClient(config = {})` creates the instance; it does **not** open a
connection until you call `attach()`, `login()`, or
[`connect()`](/clients/typescript/connection).

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `auth` | `string` | — | Initial API key. Optional: omit and use `env.ROCKETRIDE_APIKEY`, or pass a credential directly to `login()`/`connect()`. |
| `uri` | `string` | RocketRide Cloud | Initial server URI (e.g. `https://api.rocketride.ai` or `ws://localhost:5565`). Optional: omit and use `env.ROCKETRIDE_URI` or the built-in Cloud default; `attach()`, `login()`, and `connect()` accept URI overrides. |
| `env` | `Record<string, string>` | `process.env` strings | Environment override used for `${ROCKETRIDE_*}` substitution and credential/URI defaults. In Node the SDK copies string values from `process.env`; it does **not** load `.env` files. |
| `persist` | `boolean` | `false` | Automatic reconnection with capped linear backoff. See [Reconnection](#reconnection). |
| `maxRetryTime` | `number` | — | Accepted for backward compatibility but **ignored**. Reconnection has no time limit; stop it explicitly with `detach()` or `disconnect()` (`logout()` keeps the anonymous attachment reconnecting). |
| `requestTimeout` | `number` | — | Default timeout in **ms** per request; overridable per `request()` call. |
| `module` | `string` | `CLIENT-0`, `CLIENT-1`, … | Client name for logging. |
| `wsPath` | `string` | `'/task/service'` | WebSocket path override. Model-server clients pass `'/models'`. |
| `clientName` / `clientVersion` | `string` | SDK name/version | Display identity reported to the server. |
| `public` | `boolean` | `false` | Reserved: declared but not currently consumed by the client. For unauthenticated public calls, [`attach()`](/clients/typescript/connection) without logging in. |

## Callbacks

| Property | Signature | Description |
| --- | --- | --- |
| `onConnected` | `(info?: string) => Promise<void>` | Called exactly once per accepted authenticated connection generation, after authentication and best-effort monitor restoration. |
| `onDisconnected` | `(reason?: string, hasError?: boolean) => Promise<void>` | Called at most once per generation, and only if that generation previously published `onConnected`. A failed or cancelled pre-authentication attempt does not call it. Do not call `disconnect()` here if you want persistent reconnection. |
| `onConnectError` | `(error: ConnectionException) => void \| Promise<void>` | Called for automatic reconnect failures; the next retry waits for this callback. Foreground `login()`/`connect()` failures reject their promises directly. Authentication failure stops automatic retries. |
| `onEvent` | `(event: DAPMessage) => Promise<void>` | Called for each server event (upload progress, task status, …). Event type is `event.event`, payload in `event.body`. Subscribe per-task with [`addMonitor`](/clients/typescript/pipelines#events). |
| `onTrace` | `(type: TraceType, message: DAPMessage) => void` | Called around high-level SDK requests with a credential-redacted message copy — for logging or telemetry. |
| `onProtocolMessage` | `(message: string) => void` | Credential-redacted DAP messages, for protocol debugging. |
| `onDebugMessage` | `(message: string) => void` | Debug output. |

```typescript
const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'wss://api.rocketride.ai',
	persist: true,
	requestTimeout: 30000,
	onConnected: async () => setStatus('connected'),
	onDisconnected: async () => setStatus('disconnected'),
	onConnectError: (error) => setStatus('error', error.message),
	onEvent: async (e) => handleServerEvent(e),
});
```

## Reconnection

With `persist: true`, an unexpected loss schedules a background reconnect using
**linear backoff**: 250 ms, 500 ms, 750 ms, and so on to a 15-second cap — and it
**never gives up**. A successful foreground login resets the delay. Foreground
`attach()`, `login()`, or `connect()`, URI changes, `logout()`, `detach()`, and
`disconnect()` invalidate stale timers, so stale callbacks cannot publish state.
Authentication failures are **not** retried automatically — fix credentials and call
`login()`/`connect()` again.

## Environment variables

| Variable | Description |
| --- | --- |
| `ROCKETRIDE_URI` | Server URI (e.g. `wss://api.rocketride.ai` or `ws://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key, consulted by `login()` when no explicit credential is supplied |
| `ROCKETRIDE_TOKEN` | User token, accepted by the [CLI](/connect/cli) as an alternative credential |

The same map drives `${ROCKETRIDE_*}` substitution inside pipeline configs passed to
`use()` (`validate()` does not substitute). Replace it at runtime with `setEnv()`.

## Timeouts

`requestTimeout` (config) sets the default for every DAP request;
[`request(..., timeout)`](/clients/typescript/reference#advanced-low-level-dap)
overrides it per call. `attach()`, `login()`, and `connect()` accept a per-call
`{ timeout }` for the handshake. All timeouts are in milliseconds.
