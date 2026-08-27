---
title: Error Handling
sidebar_position: 9
---

# Error Handling

What the SDK throws, when, and how to catch it.

## What actually throws

| Situation | Thrown |
| --- | --- |
| Bad API key / credentials during login or connect | `AuthenticationException` |
| Transport loss and connection failures (including during login) | `ConnectionException` |
| Data-pipe errors (open / write / close) | `PipeException` |
| A login superseded, logged out, or detached mid-flight | `LoginAttemptCancelledError` |
| Most argument and server-rejection errors (`use()`, `getService()`, DAP failures) | plain `Error` |
| `sendFiles` with a non-positive `maxConcurrent` | `RangeError` |
| `Answer.getJson()` on non-JSON content | throws |

```typescript
import { RocketRideClient, AuthenticationException, ConnectionException, LoginAttemptCancelledError } from 'rocketride';

try {
	await client.connect();
	const { token } = await client.use({ filepath: './pipeline.pipe' });
	await client.send(token, data);
} catch (e) {
	if (e instanceof AuthenticationException) {
		console.error('Bad credentials');
	} else if (e instanceof LoginAttemptCancelledError) {
		console.log('Login cancelled:', e.reason); // 'superseded' | 'logout' | 'detached'
	} else if (e instanceof ConnectionException) {
		console.error('Connection failed:', e.message);
	} else {
		console.error('Request failed:', e);
	}
}
```

`AuthenticationException` is thrown on DAP auth failure. In
[persist mode](/clients/typescript/configuration#reconnection) the client calls
`onConnectError` and does **not** retry authentication — fix credentials and call
`login()` or `connect()` again.

`LoginAttemptCancelledError` extends `Error` directly (intentionally not a
`RocketRideException`). Its `reason` is the `LoginAttemptCancellationReason` union
`'superseded' | 'logout' | 'detached'` — catch it when overlapping lifecycle
actions are expected. An unsolicited transport loss during login rejects with
`ConnectionException` instead. See
[Concurrent logins](/clients/typescript/connection#concurrent-logins).

## The hierarchy

The full hierarchy is exported from `rocketride`:

```text
DAPException                    # Base DAP protocol error
└── RocketRideException         # Base for all RocketRide errors
    ├── ConnectionException     # Connection/network issues
    │   └── AuthenticationException  # Bad API key or credentials
    ├── PipeException           # Data pipe errors
    ├── ExecutionException      # Reserved: defined but not currently thrown
    └── ValidationException     # Reserved: defined but not currently thrown

LoginAttemptCancelledError      # extends Error directly (by design)
```

Exceptions in the hierarchy expose a `dapResult` record with the server's error
context (mirroring Python's `dap_result`). In practice most failures outside the connection/pipe paths surface as plain
`Error` with a descriptive message — write handlers that catch the specific
classes above first and fall back to `Error`. `ExecutionException` and
`ValidationException` exist and are exported but the SDK does not currently throw
them; don't write handlers that rely on them.
