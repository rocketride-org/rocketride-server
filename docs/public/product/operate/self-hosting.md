---
title: Self-hosting
---

# Self-hosting

Run the RocketRide [engine](/concepts/runtime-engine) on your own machine when you
want full control over where data and model calls go. It is the same engine that
powers [Cloud](/operate/cloud); only the operator changes.

> **Fastest path:** the [VS Code extension](/ide-extensions/overview) manages a
> local runtime for you while you build, with no manual setup. Use the steps below
> when you want to run the engine as a standalone service.

## Get the engine

Download a release build, no build toolchain required.

1. Open the
   [releases page](https://github.com/rocketride-org/rocketride-server/releases)
   and choose the latest **RocketRide Server** release (tags look like
   `server-v3.2.2`; ignore the client and extension releases).
2. Download the archive for your platform:

   | Platform              | Asset                                          |
   | --------------------- | ---------------------------------------------- |
   | Linux (x64)           | `rocketride-server-<version>-linux-x64.tar.gz` |
   | macOS (Apple Silicon) | `rocketride-server-<version>-darwin-arm64.tar.gz` |
   | Windows (x64)         | `rocketride-server-<version>-win64.zip`        |

3. Extract it. The folder is your **runtime directory**: it contains the `engine`
   binary and its `ai/` runtime.

```bash
tar -xzf rocketride-server-<version>-linux-x64.tar.gz -C rocketride-engine
cd rocketride-engine
```

> **Building from source instead?** That path is for contributors and is documented
> in the repository's development guide
> ([`docs/development/index.md`](https://github.com/rocketride-org/rocketride-server/blob/develop/docs/development/index.md)),
> which also covers the Docker Compose stack that bundles the engine with its data
> stores. The steps below apply to the runtime directory either way.

## Set up and start listening

The extracted archive is your runtime directory.

On Linux, install the runtime dependencies (`libc++1`, `libc++abi1`, `libgomp1`)
before starting:

```bash
# Debian / Ubuntu
sudo apt install libc++1 libc++abi1 libgomp1
# Fedora / RHEL
sudo dnf install libcxx libcxxabi libgomp
# Alpine
sudo apk add libc++ libgomp
```

From inside the runtime directory, start the engine. This binds to `127.0.0.1`
(localhost only) by default:

```bash
# Linux / macOS
./engine ./ai/eaas.py --host=127.0.0.1

# Windows
engine.exe ./ai/eaas.py --host=127.0.0.1
```

The engine now listens for the [WebSocket protocol](/protocols/websocket) on port
**5565**. Only pass `--host=0.0.0.0` (all interfaces) once the engine sits behind
TLS and authentication — see [Connect a client](#connect-a-client) below.

## Verify it is running

The engine serves a health endpoint on port 5565:

```bash
curl http://localhost:5565/ping
```

## Connect a client

Point any [SDK](/develop/typescript) or the [CLI](/reference/cli) at the engine. A local
engine typically needs no auth token:

```bash
ROCKETRIDE_URI=ws://localhost:5565
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ uri: 'ws://localhost:5565' });
await client.connect();
```

Expose the engine beyond localhost and you should put it behind TLS and
authentication (set `ROCKETRIDE_APIKEY`). For a clustered deployment, see the Helm
chart under `deploy/helm/rocketride/`.

## Provider credentials

Pipelines that call external models or stores need those providers' API keys.
Supply them as environment variables in the engine's environment (never committed);
a node's `config` references the variable rather than the literal secret. See
[Nodes](/nodes) for each provider's required keys.

## Related

- [Cloud](/operate/cloud): the managed alternative.
- [WebSocket protocol](/protocols/websocket): what clients speak to the engine.
- [Runtime & engine](/concepts/runtime-engine): what the engine does with a
  pipeline.
