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
(`packages/ai/src/ai/modules/mcp/`): the 33 tool names registered by `register_all` (32 on an engine that is not
bound to localhost, where `send_files` is not offered), `{ok, ...}` result
envelopes, run-log keying, and the server gaps the skills compensate for. The
skills reference only names in that file. When the MCP surface changes, update
the contract and the skills together.

## Install in Claude Code

This repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`).
The plugin root is `docs/agents/`, so the skills install in place. The plugin also
registers the hosted MCP server (`https://api.rocketride.ai/mcp`) as `rocketride`.

```bash
claude plugin marketplace add rocketride-org/rocketride-server
claude plugin install rocketride@rocketride
```

Self-hosted engines serve the same MCP at `http://<host>:5565/mcp`.

## Install in Codex

The same plugin is listed for Codex (`.agents/plugins/marketplace.json`, plugin
manifest at `docs/agents/.codex-plugin/plugin.json`):

```bash
codex plugin marketplace add rocketride-org/rocketride-server
codex plugin add rocketride@rocketride
```

## Install in other coding agents

Any agent that reads the open `SKILL.md` format (Cursor, GitHub Copilot, Codex,
Claude Code, and others) can take just the five skills with the `skills` installer.
It finds them under `docs/agents/skills/` from the repository root:

```bash
npx skills add rocketride-org/rocketride-server
```

Add `-a <agent>` to choose agents (for example `-a cursor github-copilot`) and
`-y` to skip prompts. Install all five skills together, because they refer to
each other (for example the building skill's `tools/` and the node index in the
designing skill). This installs the skills only; add the MCP server
(`https://api.rocketride.ai/mcp`) in your agent's own MCP settings.

This installer copies skill folders only, so the shared `MCP_TOOL_CONTRACT.md`
(the frozen MCP tool names and result shapes) is not included. Read it in this
repository at `docs/agents/skills/MCP_TOOL_CONTRACT.md`. The Claude Code and
Codex plugin installs include everything.

Each skill directory holds `SKILL.md` plus its reference files, worked examples,
and offline shims under `tools/`; the skills point to each other and to
`MCP_TOOL_CONTRACT.md` one level up. The bundled
`LAYER1_NODE_INDEX.json` (167 nodes, corpus-reconciled) regenerates from a live engine via
`rocketride-building-pipelines`' ladder — the engine remains the authority.

Not part of the `/client/docs` bundle: `client-docs:agent` packs only
`docs/agents/context/ROCKETRIDE_*.md` and `docs/agents/context/stubs/*` into
`docs.zip`, so this subdirectory is excluded. Wire up a bundle path here when
there is a consumer to ship these to (e.g. the VS Code extension installing
them as agent skills).
