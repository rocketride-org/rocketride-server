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
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

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
- **Platform:** `linux/amd64` only. On Apple Silicon add
  `--platform linux/amd64` (Docker runs it under emulation — fine for
  development; the VS Code extension does the same).
- **Runs as non-root** (user `rocketride`), listens on **5565**, and starts
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

## Persistence

The engine writes runtime data to `/opt/data` (declared as a volume). Mount a
named volume or host path there — it's the only path that needs to survive
container replacement, and the one to back up.

## Health and upgrades

The image has a built-in healthcheck against the engine's public version
endpoint, so `docker ps` shows real health:

```bash
curl http://localhost:5565/version
```

(Use `/version`, not `/ping` — `/version` is the engine's only public health
endpoint. `/ping` sits behind the auth gate and returns 401 to a bare curl
even when no API key is configured.)

Upgrading is pull-and-replace; state lives in the volume:

```bash
docker pull ghcr.io/rocketride-org/rocketride-engine:latest
docker rm -f rocketride-engine
# re-run the docker run command above
```

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
