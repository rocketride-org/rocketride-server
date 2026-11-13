---
title: Use RocketRide from a coding agent
sidebar_label: Use from a coding agent
description: Start page for coding agents. Run the engine locally in Docker, check it is up, use it from the CLI, SDK or MCP, and find the machine-readable docs.
---

# Use RocketRide from a coding agent

This page is the shortest path for a coding agent (or the person driving one) to start using RocketRide. Each section is a few lines of copy-paste commands with a link to the page that has the detail.

## What RocketRide is

RocketRide is the leading AI meta-harness with the only enterprise-grade runtime built on C++. Designed for professional software developers and technical builders, whether solo or teams or organizations, to enable them to easily build, stage, test, publish and maintain agents and AI-enabled applications that scale in production. Leverage directly from an IDE with the VS Code extension, from the terminal with the CLI, from code with the Python or TypeScript SDK, or dynamically using the MCP server.

Open source, MIT licensed. Nodes cover LLM providers, vector stores, OCR, NER, PII anonymization and more.

## Run the engine locally

There are four ways to run the engine. Pick one:

- [VS Code extension](/clients/vscode): for people working in an editor. It downloads and manages a local engine for you. See [Build in your IDE](/quickstart/ide-walkthrough).
- [Native download](/operate/self-hosting): for machines without Docker. Download the engine archive for Linux, macOS or Windows and run it directly.
- [RocketRide Cloud](#use-the-hosted-server): for when you do not want to run anything locally. Skip to the hosted section below.
- [Docker](/operate/self-hosting/docker): for any machine that runs Docker. The rest of this page uses it, because the command is the same everywhere.

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

To run it next to an existing engine, change only `--name` and the host side of `-p` (for example `127.0.0.1:5566:5565`). Leave `-e ROCKETRIDE_URI=ws://127.0.0.1:5565` in the Docker command as it is: that address is inside the container. Then use the new host port everywhere below that shows `localhost:5565`: the health check, the `ROCKETRIDE_URI` you export in your shell, and the MCP address.

- The command is the same on every machine. The image is amd64 only: `--platform linux/amd64` is required on Apple Silicon (Docker runs it under emulation, and the port can take 15 seconds or more to answer there) and has no effect on Intel or AMD machines.
- `ROCKETRIDE_APIKEY=rr_local` sets the key clients must send. The value can be any string that starts with `rr_`: the built-in MCP server refuses other values, and the CLI and SDK must send the same one.
- `ROCKETRIDE_URI=ws://127.0.0.1:5565` tells the engine's MCP server to run tool calls against this engine. Engine image 3.6.0 and earlier need it: without it (and without `MCP_RESOURCE_IDENTIFIER`), an engine that is not bound to localhost connects tool calls to RocketRide Cloud instead. Setting it is always safe (see [Use it over MCP locally](#use-it-over-mcp-locally)).

More: [Run the Engine in Docker](/operate/self-hosting/docker).

## Check it is up

```bash
curl http://localhost:5565/version
```

It answers 200 with `{"status":"OK","data":{"version":"..."}}` and needs no key. Every other unknown path, such as `/ping`, answers 401.

## Use it from the CLI or SDK

Install the Python package (Python 3.10 or newer) in a virtual environment. It installs the `rocketride` command while the environment is active. The commands are joined with `&&`, so the block stops at the first line with a clear message if `python3` is too old (the `python3` that ships with macOS is 3.9); if it stops, use a newer interpreter in both places, for example `python3.12`:

```bash
python3 -c "import sys; sys.exit(None if sys.version_info >= (3, 10) else 'RocketRide needs Python 3.10 or newer')" &&
python3 -m venv .venv &&
source .venv/bin/activate &&
pip install rocketride
```

For Node, use `npx rocketride`. `npm install rocketride` does not put the command on your path. Node users run every `rocketride` command on this page as `npx rocketride`.

Point the client at the engine. The key must match the one the engine was started with:

```bash
export ROCKETRIDE_URI=ws://localhost:5565
export ROCKETRIDE_APIKEY=rr_local
```

Save this pipeline as `code.pipe`. It reads a source file, splits it into its functions and classes, and fingerprints it, all in two branches from one input. It needs no model provider key and no account:

```bash
cat > code.pipe <<'EOF'
{
  "components": [
    { "id": "in", "provider": "webhook", "config": {} },
    { "id": "parse", "provider": "parse", "config": {}, "input": [{ "lane": "tags", "from": "in" }] },
    { "id": "code", "provider": "preprocessor_code", "config": {}, "input": [{ "lane": "text", "from": "parse" }] },
    { "id": "parts", "provider": "response_documents", "config": {}, "input": [{ "lane": "documents", "from": "code" }] },
    { "id": "text", "provider": "response_text", "config": {}, "input": [{ "lane": "text", "from": "parse" }] },
    { "id": "hash", "provider": "hash", "config": {}, "input": [{ "lane": "tags", "from": "in" }] },
    { "id": "sum", "provider": "response_hash", "config": {}, "input": [{ "lane": "tags", "from": "hash" }] }
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

`start` prints a task token and exits; the pipeline keeps running on the engine. Stop it before the next step with `rocketride stop --token <token>`. It does not print an address. The token is what you pass to `rocketride stop --token <token>`, `rocketride upload --token <token>`, and `client.send(token, ...)` in the SDK. Keep `"source": "in"`: this example's webhook has an empty config, so the engine cannot work out the source by itself. Without it, `start` fails even though `validate` passes. The error is `Pipeline has no source. Select a source component or add a node configured as a source.` (on engine 3.6.0 and earlier: `Pipeline does not have a source component defined`). Engines newer than 3.6.0 also warn at `validate`: `Pipeline has no source component: ...`.

### Send code and read the reply

This script starts `code.pipe`, sends a short Python file, prints each result, checks all three and stops the task. It reads `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` from the environment, so run it in the same shell and folder:

```python
import asyncio
import hashlib
from rocketride import RocketRideClient

SOURCE = b"""import os


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
        out = await client.send(token, SOURCE, objinfo={'name': 'greeter.py'})
        await client.terminate(token)

    parts = [doc['page_content'] for doc in out['documents']]
    for part in parts:
        print(repr(part))
    print(repr(out['text'][0]))
    print(out['hash'][0][:16] + '...')

    assert len(parts) == 4
    assert any(part.startswith('def add') for part in parts)
    assert SOURCE.decode() in out['text'][0]
    assert out['hash'][0] == hashlib.sha512(SOURCE).hexdigest()
    print('ok')


asyncio.run(main())
```

It prints:

```text
'import os'
'class Greeter:\n    def hello(self, name):\n        return "hi " + name'
'def hello(self, name):\n        return "hi " + name'
'def add(a, b):\n    return a + b'
'import os\n\n\nclass Greeter:\n    def hello(self, name):\n        return "hi " + name\n\n\ndef add(a, b):\n    return a + b\n\n\n\n'
9b3ea02fd87ae7bd...
ok
```

The reply has three results, each from its own node:

- `documents` (`response_documents`, after `preprocessor_code`): one document for the import, the class, the method and the function. The method shows up twice, once inside the class and once on its own. The check is 4 documents and one starts with `def add`.
- `text` (`response_text`, after `parse`): the text the parser read from the file, which holds the source you sent (with a few extra newlines at the end). The check is that the source is inside it.
- `hash` (`response_hash`, after `hash`): the SHA-512 fingerprint of the bytes you sent. The check recomputes it with `hashlib` and compares.

Both branches start from the `tags` lane of the webhook. A branch that reads another lane of the same source can return nothing for the other branch, with no error.

The pipeline needs no model provider key and no account. A first run on a fresh engine took about 13 seconds on a laptop, and later runs took 5 to 9 seconds. Starting the engine is separate and not counted.

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
