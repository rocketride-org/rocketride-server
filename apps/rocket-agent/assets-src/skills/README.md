# Skills

RocketRide agent skills — hand-curated direction sets that tell an assistant how
to drive a specific connector or workflow.

Skills are authored by hand, not derived from other documentation. A skill is a
set of directions for an agent, so it is written for that reader and reviewed as
such, the same way the sibling `ROCKETRIDE_*.md` files are.

## The pipeline-builder skill set

Five skills that take a plain-language request to a valid, running RocketRide
pipeline — designed so even a weak/cheap model performs reliably, because
verification comes from tools (the engine validates, the run result is the
proof) and from hard process gates, not model intelligence.

| Skill | Owns |
|---|---|
| `rocketride-building-pipelines/` | The orchestrator: lifecycle phases, gate discipline (Waiting = STOP), tool ladder, `GATE_PROTOCOL.md` with the 17 forcing functions |
| `rocketride-designing-pipelines/` | Node selection from the bundled L1 index + DAG wiring with typed lanes (Gates A/B) |
| `rocketride-configuring-pipelines/` | Schema-driven config, anti-pattern checklist, validate + re-validate loop (Gate C), cost approval (Gate C.5) |
| `rocketride-running-pipelines/` | The run lifecycle over the HTTP MCP tools (dropper file ingress, `monitor` polling), SDK fallback, Gate D save/deploy |
| `rocketride-debugging-pipelines/` | Evidence-first diagnosis: `monitor` snapshot, then the DVR run-log tools (`log_chapters`/`log_read`/`log_traces`/`log_trace`) |

`MCP_TOOL_CONTRACT.md` (this directory) freezes the tool-name/result-shape
contract between the skills and the HTTP MCP server
(`packages/ai/src/ai/modules/mcp/`): the 27 tool names, `{ok, ...}` result
envelopes, run-log keying, and the server gaps the skills compensate for. The
skills reference only names in that file. When the MCP surface changes, update
the contract and the skills together.

Each skill directory is self-contained: `SKILL.md` plus its reference files,
worked examples, and offline shims under `tools/`. The bundled
`LAYER1_NODE_INDEX.json` (167 nodes, corpus-reconciled) regenerates from a live engine via
`rocketride-building-pipelines`' ladder — the engine remains the authority.

Not exported: `docs:export` copies only the `.md` files sitting directly in
`docs/agents/` to `.rocketride/docs/`, so this subdirectory is excluded, as
`stubs/` is. Wire up an export path here when there is a consumer to export
these to (e.g. the VS Code extension installing them as agent skills).
