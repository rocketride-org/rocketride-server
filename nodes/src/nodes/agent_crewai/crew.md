# CrewAI Nodes — Topology Guide

## Node Types

### `agent_crewai` (Sub-Agent / Standalone)

Channels: `llm` (required), `tool` (optional)

**Standalone mode** (no orchestrator above): receives questions on the pipeline lane and runs a single-agent CrewAI Crew.

**Sub-agent mode** (connected to an orchestrator via `crewai` channel): responds to `crewai.describe` with its role, task description, and LLM/tool invoke handle. The orchestrator assembles it into a hierarchical Crew.

Config:
- `role` — short role name shown to the manager (e.g. `Financial Analyst`). Default: `Assistant`.
- `task_description` — what this agent should do. If blank, the full incoming question is used as the task.
- `instructions` — optional additional instructions (applied to every question).

---

### `agent_crewai_orchestrator` (Orchestrator)

Channels: `llm` (required), `crewai` (required, min 1), `tool` (optional)

Always the top-level driver. On each question:
1. Fans out `crewai.describe` to all nodes on the `crewai` channel
2. Builds a hierarchical CrewAI Crew with each connected sub-agent
3. Kicks off all sub-tasks with `async_execution=True`
4. The manager (this node's own LLM) synthesizes sub-agent outputs
5. Emits the final answer on the pipeline

Config:
- `instructions` — optional delegation guidance appended to every question.

**Does NOT respond to `crewai.describe`** — orchestrators cannot be wired as sub-agents of another orchestrator.

---

## Topology Map

### Flat Crew (standard use)

```
[Orchestrator A] ──crewai──► [Sub-agent B]  (own llm + tools)
                 ──crewai──► [Sub-agent C]  (own llm + tools)
                 ──llm────► [LLM_A]
```

- A receives a question → fans out `crewai.describe` → B and C respond
- A builds hierarchical Crew: B and C as async sub-agents, A's LLM as manager
- B and C tasks run in parallel; each uses its own `llm`/`tool` channels
- Manager synthesizes outputs → answer emitted on A's pipeline lane

---

### Depth via tool channel

```
[Orchestrator A] ──crewai──► [Sub-agent B] ──tool──► [Orchestrator C]
                                                           ──crewai──► [Sub-agent D]
                                                           ──crewai──► [Sub-agent E]
```

- B's task can invoke C as a tool during execution
- Calling C triggers C's full `_run()`, which fans out its own `crewai.describe` to D and E
- C assembles D and E into its own hierarchical Crew and returns a synthesized result to B as a tool call string
- C does NOT emit to the pipeline answers lane (`emit_answers_lane=False` for tool invocations)
- D and E's LLM/tool calls are routed through their own engine channels

---

### What a sub-agent cannot do

```
[Sub-agent B] ──crewai──► ???   ← IMPOSSIBLE
```

`agent_crewai` has no `crewai` invoke channel. Sub-agents cannot directly have CrewAI sub-agents. To add depth, put an orchestrator on their `tool` channel instead (see above).

---

## A→B→C Reference Cases

| Wiring | What happens |
|--------|-------------|
| A(orch) → B(sub) via crewai, B(sub) → C(sub) via crewai | **IMPOSSIBLE** — B has no `crewai` channel |
| A(orch) → B(sub) via crewai, B(sub) → C(sub) via tool | C runs as a standalone single-agent Crew when B invokes it as a tool |
| A(orch) → B(sub) via crewai, B(sub) → C(orch) via tool | C assembles its own hierarchical Crew of its sub-agents when B calls it as a tool |
| A(orch) → C(orch) via crewai | C silently skipped (orchestrator has no `describe()`) — A sees 0 descriptors → RuntimeError |
| A(orch) → B(sub) via crewai, B(sub) → A via tool | Circular — A re-enters `run_agent`, overwrites `_current_pSelf`. Undefined behavior. |

---

## Known Constraints

1. **One level of CrewAI sub-agents per Crew.** `crewai.describe` fan-out is one level deep — only nodes directly on the orchestrator's `crewai` channel are discovered. Multi-level orchestration requires the `tool` channel.

2. **Sub-agent tasks run in parallel, tool calls are serial.** `async_execution=True` applies within one Crew's flat sub-agent list. Tool-channel depth is blocking — each nested Crew must complete before the calling sub-agent continues.

3. **No orchestrator-as-sub-agent.** Wiring an orchestrator to another orchestrator's `crewai` channel produces no result (no `describe()` method). The outer orchestrator raises `RuntimeError: no sub-agents connected` if no valid sub-agents respond. Use the `tool` channel for nested orchestrators.

4. **Empty `task_description`.** If a sub-agent has no configured task, the full incoming question becomes its task. All such sub-agents receive identical work — differentiate them with explicit `task_description` values.

5. **Defensive tool filter.** If a sub-agent node is accidentally wired to both the `crewai` and `tool` channels of the same orchestrator, its `run_agent` tool is automatically excluded from the manager's tool repertoire. The orchestrator uses `crewai` channel only for Crew assembly and never calls sub-agents directly as tools.

6. **Circular tool wiring causes undefined behavior.** Do not wire a node as a tool to an orchestrator that is already above it in the Crew chain.

7. **Nested orchestrator output size.** When an orchestrator returns as a tool result, its full synthesized answer enters the calling sub-agent's LLM context as a tool response. Deep nesting with verbose outputs can bloat context rapidly.
