---
title: Self-hosting
---

# Self-hosting

Run the RocketRide [engine](/concepts/runtime-engine) on your own machine when you
want full control over where data and model calls go. It is the same engine that
powers [Cloud](/cloud); only the operator changes.

> **Fastest path:** the [VS Code extension](/ide-extensions/overview) manages a
> local runtime for you while you build, with no manual setup. Use the steps below
> when you want to run the engine as a standalone service.

Pick one way to get the engine, then follow [Set up and start
listening](#set-up-and-start-listening).

## Get the engine

### Option A: Download a release build

No build toolchain required, grab a prebuilt runtime.

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

### Option B: Clone and build from source

1. Clone the repository:

   ```bash
   git clone https://github.com/rocketride-org/rocketride-server.git
   cd rocketride-server
   ```

2. Install dependencies (the repo is a pnpm workspace; this also wires up the
   `./builder` CLI):

   ```bash
   pnpm install
   ```

3. Build (or fetch) the engine. This populates `dist/server/`, which is your
   **runtime directory**:

   ```bash
   ./builder build server
   ```

## Set up and start listening

Both options leave you with a runtime directory (the extracted archive, or
`dist/server/`).

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

From inside the runtime directory, start the engine:

```bash
# Linux / macOS
./engine ./ai/eaas.py --host=0.0.0.0

# Windows
engine.exe ./ai/eaas.py --host=0.0.0.0
```

The engine now listens for the [WebSocket protocol](/protocols/websocket) on port
**5565**. Use `--host=127.0.0.1` to bind to localhost only.

### Alternative: full stack with Docker (Option B only)

If you cloned the repo and want the engine plus its bundled data stores
(PostgreSQL, Milvus, ChromaDB) in one command, use the Compose stack instead of
running the binary directly. Requires Docker Engine >= 24.0 and Docker Compose v2
>= 2.17:

```bash
./builder build server       # the Compose image is built from dist/server/
cd docker
cp .env.example .env         # change every password before non-local use
docker compose up engine     # engine + its required PostgreSQL
```

`docker compose up` (no service) starts all vector stores too.

## Verify it is running

The engine serves a health endpoint on port 5565:

```bash
curl http://localhost:5565/ping
```

## Connect a client

Point any [SDK](/develop/typescript) or the [CLI](/cli) at the engine. A local
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

- [Cloud](/cloud): the managed alternative.
- [WebSocket protocol](/protocols/websocket): what clients speak to the engine.
- [Runtime & engine](/concepts/runtime-engine): what the engine does with a
  pipeline.
