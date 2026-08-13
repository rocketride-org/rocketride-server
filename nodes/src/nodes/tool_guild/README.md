# tool_guild

A RocketRide node that runs [Guild.ai](https://www.guild.ai/) agents - as a step inside a
pipeline, or as a tool an AI agent can invoke.

> Not to be confused with `guildai.org`, an unrelated ML experiment-tracking tool.

## What it does

Guild.ai is a control plane for AI agents: agents are authored, versioned, and governed in a
Guild workspace, and the Guild runtime injects credentials so an agent never sees a raw API key.
Guild has no data-processing model of its own - no parsing, chunking, embedding, or vector
search.

That is the division of labour this node exists for. A RocketRide pipeline does the data work
(ingest, parse, chunk, embed, retrieve), then hands a well-formed payload to a governed Guild
agent to perform the action.

The node has two faces, both backed by the same three REST calls:

- **As a pipeline step**, lane input is sent to the agent configured on the node and its answer
  flows downstream. The step always runs exactly once - deterministic, no prompt tuning.
- **As a tool**, an agent decides when to invoke `run_agent` to delegate work, plus `get_session`
  / `get_session_events` to follow up on a session it started earlier.

Guild runs agents **asynchronously**: every call starts a session and this node polls it to
completion (there is no synchronous mode on Guild's side to expose).

## As a pipeline node

Lane input is flattened into the input for the **configured** agent, a session is started and
polled to completion, and the agent's answer is emitted downstream.

| Lane in     | Lane out                       | Description                                             |
| ----------- | ------------------------------ | ------------------------------------------------------- |
| `text`      | `text`, `answers`, `table`     | Sends the text to the configured agent; emits its answer |
| `questions` | `answers`, `text`, `table`     | Sends the question text; emits the answer                |
| `documents` | `documents`, `text`, `table`   | Sends the document text; emits the answer                |

The answer is written to whichever output lanes are connected; a `table` listener additionally
receives `{session_id, status, output}` for downstream DB/ETL nodes. An **Agent** must be
configured - the pipeline step raises if it is empty. Empty input starts no session.

Example: [`examples/guild-agent.pipe`](../../../../examples/guild-agent.pipe) (chat -> Guild.ai ->
response).

## As a tool

Exposes three functions to an agent. Tools are namespaced by the node's **id** in the pipeline,
not by the node's `prefix`: a node with id `tool_guild_1` exposes `tool_guild_1.run_agent`. Use
the fully namespaced form when instructing an agent to call them.

| Tool | Description |
|---|---|
| `run_agent` | Run a Guild agent on some input and return its answer. |
| `get_session` | Check whether a session is running, completed, or failed. |
| `get_session_events` | Read a session's transcript, including its final answer. |

### `run_agent`

| Parameter | Required | Description |
|---|---|---|
| `input` | yes | Text sent to the Guild agent as its input. |
| `agent` | no | Agent to run. Defaults to the agent configured on the node. |
| `wait` | no | Wait for the answer (default), or start the session and return only its id. |

Returns `{ success, session_id, status, output }`.

Each call starts a **billed** Guild session and is not idempotent - a successful call should
never be retried.

### `get_session`

| Parameter | Required | Description |
|---|---|---|
| `session_id` | yes | Id of the session to inspect. |

Returns `{ success, session_id, status }`, where `status` is `running`, `completed`, or `failed`.

### `get_session_events`

| Parameter | Required | Description |
|---|---|---|
| `session_id` | yes | Id of the session to read. |
| `limit` | no | Max events to return (default 100, capped at 1000). |

Returns `{ success, events, output }`. Events are oldest-first (the answer is last), so when the
transcript is longer than `limit` the **most recent** `limit` events are returned — the answer is
never dropped. The node follows the endpoint's pagination to reach the tail.

Errors are raised, never returned as error dicts: `ValueError` for bad input or missing
configuration, `RuntimeError` for API and transport failures. The engine converts a raised
exception into the structured error an agent sees, so an agent can still read the message and
correct itself.

Example: [`examples/guild-delegate-agent.pipe`](../../../../examples/guild-delegate-agent.pipe)
(a RocketRide agent with Guild.ai bound as a tool).

## Configuration

| Field | Type | Description |
|---|---|---|
| Guild Base URL | `string` | Default `https://app.guild.ai`. Override only for an enterprise or self-hosted deployment. |
| API Key ID | `string` | The id half of a Guild trigger API key - the HTTP Basic username. Stored as a secure field. |
| API Key Secret | `string` | The secret half - the Basic password. Shown once when the key is created. Stored as a secure field. |
| Workspace owner | `string` | The owner segment of the workspace URL (`app.guild.ai/<owner>/<workspace>`). |
| Workspace | `string` | The workspace segment of that URL. |
| Agent | `string` | Agent to run as the pipeline step, and the default for `run_agent`. Required for the pipeline step. |
| Result mode | `enum` | Default `wait`. `start` returns a session id without waiting - useful for fire-and-forget tool calls. The pipeline step always waits. |
| Session timeout (seconds) | `integer` | Default 300, range 5-3600. How long to poll before raising. |
| Max sessions per run | `integer` | Default 10, range 1-1000. Cap on billed Guild sessions per pipeline run. |
| Verify TLS certificate | `boolean` | Default on. Disable only for a self-hosted Guild with a self-signed certificate. |

The connection fields fall back to an environment variable when left empty: `ROCKETRIDE_GUILD_URL`
(Base URL), `ROCKETRIDE_GUILD_KEY_ID`, `ROCKETRIDE_GUILD_KEY_SECRET`, `ROCKETRIDE_GUILD_OWNER`,
`ROCKETRIDE_GUILD_WORKSPACE`, and `ROCKETRIDE_GUILD_AGENT`. The run options (result mode, session
timeout, max sessions, verify TLS) are read from the node config only.

Out-of-range or non-numeric timeouts fall back to their defaults rather than failing the run.

## Notes

- **Pipeline step vs tool.** The pipeline step runs the agent exactly once - deterministic, no
  prompt tuning. The tool lets an agent decide *whether* and *how often* to call; an agent that
  is not told to call once may start several sessions in one turn, each billed. When you bind
  this node as a tool, instruct the agent to call `run_agent` once and return its answer.
- **First session can be slow.** Guild sessions run on Guild's runtime; a cold start (notably on
  the free tier) can take tens of seconds before warming up. Set the session timeout with room to
  spare.
- **Result mode `start`** is only meaningful for the tool face (fire-and-forget). The pipeline
  step always waits, because a bare session id is of no use to downstream nodes.

## Safety limits

- **Max sessions per run** caps how many sessions one pipeline run may start. Guild bills per
  automation and the free tier allows only 100 per month, so this bounds a runaway agent loop.
  Reserved before the request is sent, so the cap gates the billable call itself.
- **Session timeout** bounds polling. A timeout here does **not** cancel the session on Guild -
  the session id is included in the error so the run stays traceable.
- **POSTs are never retried.** Replaying a session start would bill a second automation. Only
  idempotent GETs retry, at most twice, honouring `Retry-After`.
- **Agent-supplied identifiers** (`agent`, `session_id`) are validated as plain identifiers, so a
  tool call cannot smuggle a path or redirect the request off the configured host.
- **Error messages never echo response bodies**, which can contain the prompt that was sent.

## Authentication

Guild authenticates machine access with a **trigger API key** over HTTP Basic: the key id is the
username, the key secret the password. Create one on the trigger's page in the Guild app; the
secret is shown only once.

Both halves are required - setting only one raises a config warning. A `401` from Guild most
often means the key is scoped to a different trigger than the agent being run, since Guild
scopes trigger API keys per trigger.

See the [Guild triggers documentation](https://docs.guild.ai/platform/triggers) for how keys and
API triggers are set up.

## Limits

- Read and run only. The node cannot deploy, roll back, or fork agents, and cannot manage
  credentials or policies - those are governance surfaces that belong to Guild's own UI.
- No agent discovery: Guild publishes no REST endpoint for listing agents, so the agent name must
  be configured or passed by the caller.
- No streaming. Guild streams partial output over WebSocket; this node polls instead.
- Text only - binary lanes are not forwarded.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
