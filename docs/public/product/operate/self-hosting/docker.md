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
docker run -d --name rocketride-engine \
  --platform linux/amd64 \
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

The image is `linux/amd64`; the `--platform` flag is required on Apple Silicon
and on every arm64 host. On Apple Silicon the VS Code extension adds the
override for you automatically, so only terminal use needs it; on Linux arm64,
set the override yourself whether you use the extension or a terminal.

Point any client at it and go:

```bash
export ROCKETRIDE_URI=ws://localhost:5565
```

The `127.0.0.1:` prefix keeps the engine reachable only from the machine
itself — the right default, since a fresh engine accepts unauthenticated
connections. Widen it only behind TLS and authentication (see
[Security](/operate/security)).

## The image

- **Tags:** each release publishes its version tag plus `latest`; prerelease
  builds carry a `-prerelease` suffix. Pin a version tag in production.
- **Platform:** `linux/amd64` only. The VS Code extension adds
  `--platform linux/amd64` automatically on Apple Silicon; on a Linux arm64
  host, set the override yourself whether you use the extension or a
  terminal (emulation either way — fine for development).
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
- **`ROCKETRIDE_URI`** — the engine address that upload links and widget
  connections the engine hands out point at. A local engine uses the usual
  `ws://localhost:5565`. A remote deployment needs a client-reachable
  `wss://` address, because the links and widget connections use this value.
  Setting it also routes tool calls from MCP clients to this engine instead
  of RocketRide Cloud. See
  [MCP self-hosting](/connect/mcp/http/self-hosting) for how the lookup works.

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

(Use `/version`, not `/ping`: the engine entrypoint starts its web server
without the standard endpoints, so `/ping` is never registered and returns
404. `/version` is always registered and public.)

Upgrading is pull-and-replace; state lives in the volume:

```bash
docker pull ghcr.io/rocketride-org/rocketride-engine:latest
docker rm -f rocketride-engine
# re-run the docker run command above
```

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
