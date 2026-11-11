---
title: Use RocketRide from a coding agent
sidebar_label: Use from a coding agent
description: Start page for coding agents. Run the engine locally in Docker, check it is up, use it from the CLI, SDK or MCP, and find the machine-readable docs.
---

# Use RocketRide from a coding agent

This page is the shortest path for a coding agent (or the person driving one) to start using RocketRide. Each section is a few lines of copy-paste commands with a link to the page that has the detail.

## What RocketRide is

RocketRide is the leading AI meta-harness with the only enterprise-grade runtime built on C++. Designed for professional software developers and technical builders, whether solo or teams or organizations, to enable them to easily build, stage, test, publish and maintain agents and AI-enabled applications that scale in production. Leverage directly from an IDE with the VS Code extension, from the terminal with the CLI, from code with the Python or TypeScript SDK, or dynamically using the MCP server.

Open source, MIT licensed. 150+ nodes, 15+ LLM providers, 10+ vector stores.

## Run the engine locally

The engine ships as a container image. If a container named `rocketride-engine` already exists (the VS Code extension creates one with this name), do not remove it. Either use that engine and skip this step, or give this one another name and host port. Then run:

```bash
docker run -d --name rocketride-engine --platform linux/amd64 \
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  -e ROCKETRIDE_APIKEY=rr_local \
  -e ROCKETRIDE_URI=ws://127.0.0.1:5565 \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

To run it next to an existing engine, change only `--name` and the host side of `-p` (for example `127.0.0.1:5566:5565`). Leave `-e ROCKETRIDE_URI=ws://127.0.0.1:5565` in the Docker command as it is: that address is inside the container. Then use the new host port in the `ROCKETRIDE_URI` you export in your shell and in the MCP address below.

- The image is amd64 only. `--platform linux/amd64` is required on Apple Silicon (Docker runs it under emulation, and the port answers after about 25 seconds there) and harmless elsewhere.
- `ROCKETRIDE_APIKEY=rr_local` sets the key clients must send. The value can be any string that starts with `rr_`: the built-in MCP server refuses other values, and the CLI and SDK must send the same one.
- `ROCKETRIDE_URI=ws://127.0.0.1:5565` tells the engine's MCP server to run tool calls against this engine. Engine image 3.6.0 and earlier need it: without it (and without `MCP_RESOURCE_IDENTIFIER`), an engine that is not bound to localhost connects tool calls to RocketRide Cloud instead. Setting it is always safe (see [Use it over MCP locally](#use-it-over-mcp-locally)).

More: [Run the Engine in Docker](/operate/self-hosting/docker).

## Check it is up

```bash
curl http://localhost:5565/version
```

It answers 200 with `{"status":"OK","data":{"version":"..."}}` and needs no key. Every other unknown path, such as `/ping`, answers 401.

## Use it from the CLI or SDK

Install the Python package (Python 3.10 or newer) in a virtual environment. It installs the `rocketride` command while the environment is active. The first line stops with a clear message if `python3` is too old (the `python3` that ships with macOS is 3.9); if it stops, use a newer interpreter in both places, for example `python3.12`:

```bash
python3 -c "import sys; sys.exit(None if sys.version_info >= (3, 10) else 'RocketRide needs Python 3.10 or newer')"
python3 -m venv .venv
source .venv/bin/activate
pip install rocketride
```

For Node, use `npx rocketride`. `npm install rocketride` does not put the command on your path. Node users run every `rocketride` command on this page as `npx rocketride`.

Point the client at the engine. The key must match the one the engine was started with:

```bash
export ROCKETRIDE_URI=ws://localhost:5565
export ROCKETRIDE_APIKEY=rr_local
```

Save this pipeline as `code.pipe`. It splits source code into its parts and needs no model provider key and no account:

```bash
cat > code.pipe <<'EOF'
{
  "components": [
    { "id": "in", "provider": "webhook", "config": {} },
    { "id": "code", "provider": "preprocessor_code", "config": {}, "input": [{ "lane": "text", "from": "in" }] },
    { "id": "out", "provider": "response_documents", "config": {}, "input": [{ "lane": "documents", "from": "code" }] }
  ],
  "source": "in"
}
EOF
```

Validate it and start it:

```bash
rocketride validate code.pipe
rocketride start --pipeline ./code.pipe
```

`start` prints a task token and exits; the pipeline keeps running on the engine. Stop it before the next step with `rocketride stop --token <token>`. It does not print an address. The token is what you pass to `rocketride stop --token <token>`, `rocketride upload --token <token>`, and `client.send(token, ...)` in the SDK. Keep `"source": "in"`: this example's webhook has an empty config, so the engine cannot work out the source by itself. Without it, `start` fails with `Pipeline does not have a source component defined.` even though `validate` passes.

### Send code and read the reply

This script starts `code.pipe`, sends a short Python file, prints each part the pipeline found, checks the result and stops the task. It reads `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` from the environment, so run it in the same shell and folder:

```python
import asyncio
from rocketride import RocketRideClient

SOURCE = """import os


class Greeter:
    def hello(self, name):
        return "hi " + name


def add(a, b):
    return a + b
"""


async def main():
    async with RocketRideClient() as client:
        result = await client.use(filepath='code.pipe')
        token = result['token']
        out = await client.send(token, SOURCE, mimetype='text/plain')
        await client.terminate(token)

    parts = [doc['page_content'] for doc in out['documents']]
    for part in parts:
        print(repr(part))
    assert len(parts) == 4
    assert any(part.startswith('def add') for part in parts)
    print('ok')


asyncio.run(main())
```

`mimetype='text/plain'` is required. Without it the reply has no documents and no error.

It prints:

```text
'import os'
'class Greeter:\n    def hello(self, name):\n        return "hi " + name'
'def hello(self, name):\n        return "hi " + name'
'def add(a, b):\n    return a + b'
ok
```

There is one document for the import, one for the class, one for the method and one for the function. The method shows up twice, once inside the class and once on its own. Two checks keep a failure loud: the reply has 4 documents, and one of them starts with `def add`.

The pipeline needs no model provider key and no account. A first run on a fresh engine took about 10 seconds on a laptop, and later runs took 2 to 5 seconds. Starting the engine is separate and not counted.

More: [Run from the CLI](/quickstart/cli), [CLI Reference](/connect/cli), [Python SDK](/clients/python), [TypeScript SDK](/clients/typescript).

## Use it over MCP locally

A running engine serves MCP at `http://localhost:5565/mcp`. Send the key you started the engine with as a bearer token:

```text
Authorization: Bearer rr_local
```

Claude Code:

```bash
claude mcp add --transport http rocketride-local http://localhost:5565/mcp --header "Authorization: Bearer rr_local"
```

On engine image 3.6.0 and earlier, when neither `ROCKETRIDE_URI` nor `MCP_RESOURCE_IDENTIFIER` is set on a Docker engine (or any engine not bound to localhost), `initialize` and `tools/list` still work, but every tool call connects to RocketRide Cloud and fails with `Invalid or revoked API key`. Start the engine with the command above to avoid this. A local Docker engine offers 32 tools (`send_files` needs a loopback bind).

## Use the hosted server

The hosted MCP server is at `https://api.rocketride.ai/mcp`.

```bash
claude mcp add --transport http rocketride https://api.rocketride.ai/mcp
```

Claude Code then lists the server as needing authentication. Run `/mcp` in Claude Code and pick the server to finish the browser sign-in (OAuth). Clients that can send headers can use a RocketRide API key instead: `Authorization: Bearer rr_...`. For the CLI against RocketRide Cloud, `rocketride login --uri https://api.rocketride.ai` signs in through the browser and saves `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` (and the `ROCKETRIDE_DEPLOY_*` pair) to `.env`. Without a browser, create a key in the web app and run `rocketride login --uri https://api.rocketride.ai --apikey <key>`. Run `unset ROCKETRIDE_URI ROCKETRIDE_APIKEY` first if you exported them in the steps above: a value exported in the shell wins over the one `login` saves to `.env`, so the CLI would keep talking to the local engine.

More: [Connect a Client](/connect/mcp/http/connect) and [HTTP MCP Server](/connect/mcp/http).

## Environment variables

The SDKs and the CLI read the same two variables.

| Variable | Local engine | RocketRide Cloud |
| --- | --- | --- |
| `ROCKETRIDE_URI` | `ws://localhost:5565` | `wss://api.rocketride.ai` |
| `ROCKETRIDE_APIKEY` | the same value the engine was started with (any non-empty value if the engine has none) | your `rr_` API key |

## Component names

Take a pipeline's `provider` values from the MCP `list_components` tool or from the [component reference](/nodes), not from memory. For example, the MCP `validate_pipeline` tool accepts `response_text` as the response component.

## Machine-readable docs

- [`/llms.txt`](https://docs.rocketride.org/llms.txt): an index of every page with a one-line description.
- [`/llms-full.txt`](https://docs.rocketride.org/llms-full.txt): the full text of every page in one file.
- Any page as markdown: drop the trailing slash from its URL and add `.md`, for example `https://docs.rocketride.org/quickstart.md`.

## Go deeper

- [Quickstart](/quickstart): pick the IDE, SDK or CLI path.
- [Pipelines](/concepts/pipelines) and [Nodes](/concepts/nodes): the core concepts.
- [Agents & Tools](/concepts/agents-tools-skills): how agents are wired.
- [Pipeline JSON Reference](/reference/pipeline-reference): the `.pipe` format.
