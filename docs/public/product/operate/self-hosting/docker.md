---
title: Docker
---

# Run the Engine in Docker

The engine ships as a published container image — the same one the
[VS Code extension's Docker mode](/clients/vscode) pulls:

```text
ghcr.io/rocketride-org/rocketride-engine
```

## Quickstart

```bash
docker run -d --name rocketride-engine --platform linux/amd64 \
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

This command is enough for the CLI and SDK. For the built-in MCP server use the
command in [MCP on this engine](#mcp-on-this-engine) instead, which adds one `-e`
setting. Both commands carry `--platform linux/amd64`, which Apple Silicon needs
and Intel and AMD machines ignore (see [The image](#the-image)).

Point any client at it and go. A client needs a non-empty key, and an engine
started without one (no `RR_APIKEY`) accepts any value:

```bash
export ROCKETRIDE_URI=ws://localhost:5565
export ROCKETRIDE_APIKEY=rr_local
```

The `127.0.0.1:` prefix keeps the engine reachable only from the machine
itself — the right default, since an engine started without a key accepts any
non-empty one. Widen it only behind TLS and authentication (see
[Security](/operate/security)).

## The image

- **Tags:** each release publishes its version tag plus `latest`; prerelease
  builds carry a `-prerelease` suffix. Pin a version tag in production.
- **Platform:** `linux/amd64` only. On Apple Silicon add
  `--platform linux/amd64` (Docker runs it under emulation — fine for
  development; the VS Code extension does the same).
- **Runs as non-root** (user `rocketride`, uid 1000), listens on **5565**, and starts
  the engine bound to all container interfaces — the port mapping above is
  what controls actual exposure.
- **Signed:** images are cosign-signed from CI. Verify keyless:

  ```bash
  cosign verify \
    --certificate-identity-regexp 'https://github.com/rocketride-org/rocketride-server/' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    ghcr.io/rocketride-org/rocketride-engine:latest
  ```

## Configuration

The engine reads configuration from its environment — pass variables with
`-e`/`--env-file`:

- **Provider credentials** for your pipelines (OpenAI, Anthropic, database
  DSNs, …): set them in the engine's environment and reference them from
  node config as `${VAR}` — see
  [Self-hosting](/operate/self-hosting#provider-credentials).
- **MCP OAuth settings** if AI assistants will connect to `/mcp` on this
  engine: `MCP_EXPECTED_AUDIENCE` and friends — see
  [MCP self-hosting](/connect/mcp/http/self-hosting).

## MCP on this engine

The image binds all container interfaces, so the engine treats itself as a
public bind. For the built-in MCP server at `http://localhost:5565/mcp` to work,
start the container with a key that starts with `rr_`. The engine reads its own
key from `RR_APIKEY`. If you already ran the quickstart command, remove that
container first with `docker rm -f rocketride-engine`; the `rocketride-data`
volume is kept.

```bash
docker run -d --name rocketride-engine --platform linux/amd64 \
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  -e RR_APIKEY=rr_local \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

MCP clients then send `Authorization: Bearer rr_local`. The key must start with
`rr_`. The CLI and SDK must send the same key; they read it from
`ROCKETRIDE_APIKEY`. On the container the name is `RR_APIKEY`: an engine that
has `ROCKETRIDE_APIKEY` but not `RR_APIKEY` refuses to start.

When neither `RR_MCP_ENGINE_URI` nor `MCP_RESOURCE_IDENTIFIER` is set, the
engine runs MCP tool calls against itself (`ws://127.0.0.1:<port>`). Engine image
3.6.0 and earlier read `ROCKETRIDE_APIKEY` and `ROCKETRIDE_URI` instead, and
without `ROCKETRIDE_URI=ws://127.0.0.1:5565` they connect tool calls to RocketRide
Cloud, where they fail with `Invalid or revoked API key`. See
[MCP self-hosting](/connect/mcp/http/self-hosting).

## Persistence

The engine writes runtime data to `/opt/data` (declared as a volume). Mount a
named volume or host path there — it's the only path that needs to survive
container replacement, and the one to back up. It must be writable by uid 1000;
the engine checks at startup and refuses to start, naming the fix, if it is not.

## Health and upgrades

The image has a built-in healthcheck against the engine's public version
endpoint, so `docker ps` shows real health:

```bash
curl http://localhost:5565/version
```

(Use `/version`, not `/ping`: `/version` is the address that answers without
a key. Every unknown path, including `/ping`, `/health` and `/healthz`,
answers 401.)

Upgrading is pull-and-replace; state lives in the volume:

```bash
docker pull --platform linux/amd64 ghcr.io/rocketride-org/rocketride-engine:latest
docker rm -f rocketride-engine
# re-run the docker run command you started it with (see the note below first)
```

Upgrading from an image before 4.0: two of the engine's own settings were
renamed, and the old names no longer work on the container.

- `-e ROCKETRIDE_APIKEY=...` becomes `-e RR_APIKEY=...`. An engine that has
  `ROCKETRIDE_APIKEY` without `RR_APIKEY` refuses to start.
- `-e ROCKETRIDE_URI=...` becomes `-e RR_MCP_ENGINE_URI=...`, if you set the
  address MCP tool calls use. It is no longer needed for an engine that runs
  its own tool calls.

Clients keep `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`: those names are theirs.

Upgrading from an image that ran as a system user (uid 999): the existing volume
still belongs to that user, so the new engine cannot write to it and exits with
`/opt/data is not writable by uid 1000`. Hand the volume over once, before
starting the new image:

```bash
docker run --rm -v rocketride-data:/opt/data alpine chown -R 1000:1000 /opt/data
```

For a host path, run `sudo chown -R 1000:1000 <path>` instead.

## Compose

A minimal production compose file:

```yaml
services:
  engine:
    image: ghcr.io/rocketride-org/rocketride-engine:latest
    platform: linux/amd64
    ports:
      - '127.0.0.1:5565:5565'
    volumes:
      - rocketride-data:/opt/data
    env_file: .env # provider credentials
    restart: unless-stopped

volumes:
  rocketride-data:
```

> The repository's own `docker/docker-compose.yml` is a **development stack**:
> it builds the image from a local source build and bundles Postgres, Milvus,
> and Chroma with default passwords. Use it for hacking on RocketRide, not
> for serving it.

## Next

- [Kubernetes](/operate/self-hosting/kubernetes): the Helm chart, for
  clustered deployments.
- [Production](/operate/self-hosting/production): topology and sizing.
- [Security](/operate/security): TLS, authentication, and exposure.
