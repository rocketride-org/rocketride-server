---
title: Agents & Tools
sidebar_position: 4
---

# Agents & tools

Most [nodes](/concepts/nodes) pass data along a lane and move on. An
**agent** is different: it reasons in a loop, deciding which model to call,
which tools to use, and when it is done. To do that it needs a few helpers wired
to it: an LLM, optionally tools, and (for some agent types) memory.

## Data lanes vs. control connections

Agents introduce a second kind of wiring alongside data lanes:

- **Data lanes** carry data _into_ and _out of_ the agent, a question arrives
  on an input lane, an answer leaves on an output lane.
- **Control (`invoke`) connections** attach the agent's _capabilities_: the
  LLM it thinks with, the tools it can call, the memory it reads and writes.

See the [Execution model](/concepts/execution-model) for how the two interact.

## Wiring: `control` lives on the helper

The connection between an agent and its helpers is declared on the **helper**,
not on the agent. Each LLM, tool, or memory node carries a `control` array whose
`from` points back at the agent that invokes it. The agent itself has no
`control` array, only its input lanes.

```json
// The agent: input lanes only, no control array.
{ "id": "agent_1", "provider": "agent_rocketride",
  "input": [{ "lane": "questions", "from": "chat_1" }] }

// The LLM declares it is controlled BY the agent.
{ "id": "llm_1", "provider": "llm_openai",
  "control": [{ "classType": "llm", "from": "agent_1" }] }

// The tool, likewise.
{ "id": "tool_1", "provider": "tool_http_request",
  "control": [{ "classType": "tool", "from": "agent_1" }] }
```

A single LLM, tool, or memory node can serve several invokers: list each one as
its own entry in the helper's `control` array.

## Tools

A **tool** (class type `tool`) is a capability an agent can invoke at runtime:
an HTTP request, a web search, a shell command, a filesystem or git operation,
another pipeline, and many more. Tools have **no data lanes**: nothing streams
through them. They sit idle until an agent decides to call one, then return a
result to that agent. A tool joins a pipeline purely through its `control`
connection.

## Memory

Some agents keep state across turns through a **memory** node (`memory_internal`
or `memory_persistent`), wired the same way as any other helper.

| Agent              | LLM                  | Memory               | Tools    |
| ------------------ | -------------------- | -------------------- | -------- |
| `agent_rocketride` | Required (exactly 1) | Required (exactly 1) | Optional |
| `agent_crewai`     | Required (min 1)     | Not supported        | Optional |
| `agent_langchain`  | Required (min 1)     | Not supported        | Optional |

Only `agent_rocketride` has a memory port. Do not wire memory to `agent_crewai`
or `agent_langchain`.

## Multi-agent pipelines

An agent can invoke **another agent as a tool**. The sub-agent declares
`control: [{ "classType": "tool", "from": "<parent_agent_id>" }]` and takes no
input lanes of its own, it is driven by its parent. The sub-agent's own
helpers (its LLM and memory) point their `control` at the sub-agent, not at the
parent. This lets you compose specialists under a coordinator.

> The same `invoke`/`control` pattern applies beyond agents, any node whose
> catalog entry declares an `invoke` field (for example `summarization` or
> `extract_data`) is wired to its LLM the same way.

## Next steps

- [Nodes](/nodes): every agent, tool, LLM, and memory
  provider, with its `invoke` requirements.
- [Execution model](/concepts/execution-model): how control connections run
  alongside data lanes.
- [Pipeline JSON reference](/pipeline-reference): the `control` and `invoke`
  fields in full.
