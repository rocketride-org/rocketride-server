# Incorrect pipelines (rejected at open)

Every `.pipe` here is **intentionally invalid**. The engine rejects each one when the
pipeline is opened (`client.use(...)` raises immediately — this is validation time, before
any data flows), so a bad wiring fails fast instead of silently producing a partial result.

The rule behind most of these: **a control node's sub-pipeline must be exclusively its
own.** Each node a control node (e.g. `tool_pipe`) drives must belong only to that
sub-pipeline — never shared with the main pipeline, a second start, or another control
node. Otherwise the shared node's single lifecycle (`open`/`closing`/`close`) would be
driven by two owners with conflicting timing.

> **Not here on purpose:** a single `tool_pipe` invoked from two places (two agents calling
> the *same* tool) is **valid** — it is one invoked node with one sub-pipeline, driven once
> per invocation. Only *sharing sub-pipeline nodes* is wrong, not sharing the tool.

## The examples

| File | Wrong pattern | Engine error (verbatim) |
|---|---|---|
| `incorrect-second-start-feeds-subpipe.pipe` | A second start (`chat_1`) also feeds the sub-pipeline's head node `sub_head`, so the whole sub-pipeline becomes main-flow-owned. | `Control node "Pipeline Tool" (pipe_tool_1) reaches node "Prompt" (sub_head) that the main flow owns; a control node's sub-pipeline must not be shared with the main pipeline or another start` |
| `incorrect-second-start-feeds-subpipe-node.pipe` | A second start feeds a *middle* sub-pipeline node `sub_mid`. | same "…must not be shared with the main pipeline or another start" |
| `incorrect-subpipe-merges-into-main.pipe` | The sub-pipeline flows back into a main-flow node `main_node` (the tool pipeline intersects the main pipeline). | same "…must not be shared…" |
| `incorrect-shared-subpipe-node.pipe` | Two `tool_pipe`s (`pipe_tool_1`, `pipe_tool_2`) whose sub-pipelines both include `shared_node`. | `Pipeline node "Prompt" (shared_node) is reachable from two control roots ( "Pipeline Tool" (pipe_tool_1) and "Pipeline Tool" (pipe_tool_2) ) - a node has exactly one lifecycle owner` |
| `incorrect-data-fed-tool-pipe.pipe` | A data input wired into `tool_pipe` (which also drives a sub-pipeline). | `Component pipe_tool_1 input lane questions not found in service definition` |

The first three map to the topologies discussed as **#1, #2, #4**. (#3 — the same
`tool_pipe` invoked from two starts — is valid, so it is not here.)

### A note on the last one

`tool_pipe` is **invoke-only**: its `services.json` declares only `_source` *output*
lanes, no input lane. So wiring a data input into it is rejected earlier, by lane
validation, with the message above — you cannot data-feed a `tool_pipe` at all. The
engine's separate "drives a sub-pipeline and is also data-fed" guard is a safety net for a
*future* invoke-capable node that does accept a data input.

## Reading the error

The engine names each node by its **service title** (the label on the canvas) plus your
**component id** — e.g. `Control node "Pipeline Tool" (pipe_tool_1) reaches node "Prompt"
(sub_mid) …` — so the message points straight at the wiring to fix.

## To reproduce

Start an engine built from this branch, then:

```bash
python ../../_scripts/run_tool_pipe_diamond.py examples/incorrect/incorrect-second-start-feeds-subpipe.pipe
```

`client.use()` raises a `RuntimeError` carrying the engine message — the pipeline never
runs.
