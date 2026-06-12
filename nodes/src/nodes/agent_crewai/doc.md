# agent_crewai

Run [CrewAI](https://docs.crewai.com) agents inside RocketRide — solo, as a manager, or as managed workers.

## What it does

Three node variants share the same base driver:

- **CrewAI Agent** (`agent_crewai`) — a standalone single agent. It assembles a CrewAI `Agent` + `Task` and runs it to answer the incoming question.
- **CrewAI Manager** (`agent_crewai_manager`) — orchestrates a crew. It runs CrewAI's hierarchical process: fans out to the connected CrewAI Subagent nodes, assembles a Crew with the manager as delegator, and synthesizes their outputs into one answer.
- **CrewAI Subagent** (`agent_crewai_subagent`) — a managed worker. Wired into a Manager via the `crewai` channel and delegated to by name (its `role`); it has no `questions` lane and cannot be invoked directly.

In data-flow terms, the Agent and Manager consume `questions` and produce `answers` (`"questions": ["answers"]`). Both also register as tools (`classType: ["agent", "tool"]`) and expose themselves as `<nodeId>.run_agent`, so a parent agent can delegate to them in hierarchical pipelines. Tools attach through the agent's `tool` invoke channel (control-plane invoke), not through lanes; the Subagent has its own `tool` channel too. Each variant requires exactly one `llm` channel (`min: 1`).

## Configuration

### CrewAI Agent

| Field             | Default       | Description                                                                              |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------- |
| Agent description | `""`          | What this agent does. Helps parent agents select and invoke it correctly.                |
| Instructions      | `[]`          | Additional instructions to guide the agent.                                              |
| Advanced Mode     | `Off`         | When On, exposes the CrewAI Agent and Task config fields below directly.                  |
| Role              | `"Assistant"` | Agent role name (e.g. "Financial Analyst"). Maps to CrewAI `Agent(role=...)`.            |
| Goal              | `""`          | What the agent is trying to achieve. Maps to `Agent(goal=...)`.                          |
| Backstory         | `""`          | Background context for the agent's persona. Maps to `Agent(backstory=...)`.              |
| Task              | `""`          | What the agent should do. If blank, the incoming question is used. Maps to `Task(description=...)`. |
| Expected Output   | `""`          | Description of the expected output format. Maps to `Task(expected_output=...)`.          |

### CrewAI Manager

| Field             | Default | Description                                                                                          |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------- |
| Agent description | `""`    | What this manager + its sub-agent crew does. Used by parent agents that call it as a tool.           |
| Instructions      | `[]`    | Additional instructions to guide the manager's delegation strategy.                                  |
| Advanced Mode     | `Off`   | When On, exposes the manager Agent config fields below directly.                                      |
| Manager Goal      | `""`    | What the manager is trying to achieve. Maps to `Agent(goal=...)`.                                    |
| Manager Backstory | `""`    | Background context for the manager's persona. Maps to `Agent(backstory=...)`.                        |

The Manager requires at least one connected CrewAI Subagent on the `crewai` channel (`min: 1`).

### CrewAI Subagent

| Field           | Default          | Description                                                                                       |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| Instructions    | `[]`             | Additional instructions for this sub-agent when the Manager delegates to it.                     |
| Advanced Mode   | `Off`            | When On, exposes the CrewAI Agent and Task config fields below directly.                          |
| Role            | `"Specialist"`   | Sub-agent role name. The Manager uses this name when routing delegation. Maps to `Agent(role=...)`. |
| Goal            | `""`             | What this sub-agent aims to achieve. Maps to `Agent(goal=...)`.                                   |
| Backstory       | `""`             | Background context / expertise. Maps to `Agent(backstory=...)`.                                   |
| Task            | `""`             | What this sub-agent does when delegated to; the request is passed as context. Maps to `Task(description=...)`. |
| Expected Output | `""`             | Description of the expected output format. Maps to `Task(expected_output=...)`.                   |

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

### Service: `agent`

- **Class type** — agent, tool
- **Capabilities** — invoke
- **Protocol** — `agent_crewai://`

**Data lanes**

- `questions` → `answers`

**Profiles**

- `default`

**Configuration sections**

- **CrewAI Agent** — `agent_crewai.default`

**Schema**

- **Agent description** (`agent_description`) — `string`. What does this agent do? Describe its purpose and capabilities — this helps parent agents select and invoke it correctly.
- **Instructions** (`instructions`) — `array`. Additional instructions to guide the agent.
- **Advanced Mode** (`advanced_mode`) — `boolean`, default `false`. Expose CrewAI Agent and Task configuration directly.
- **Agent Config** (`agent_crewai.agent_config_header`) — `null`, default ``
- **Role** (`role`) — `string`. Agent role name (e.g. 'Financial Analyst'). Maps to CrewAI Agent(role=...).
- **Goal** (`goal`) — `string`. What this agent is trying to achieve. Maps to CrewAI Agent(goal=...).
- **Backstory** (`backstory`) — `string`. Background context for this agent's persona. Maps to CrewAI Agent(backstory=...).
- **Task Config** (`agent_crewai.task_config_header`) — `null`, default ``
- **Task** (`task_description`) — `string`. What this agent should do. If blank, the incoming question is used. Maps to CrewAI Task(description=...).
- **Expected Output** (`expected_output`) — `string`. Description of the expected output format. Maps to CrewAI Task(expected_output=...).

### Service: `manager`

- **Class type** — agent, tool
- **Capabilities** — invoke
- **Protocol** — `agent_crewai_manager://`

**Data lanes**

- `questions` → `answers`

**Profiles**

- `default`

**Configuration sections**

- **CrewAI Manager** — `agent_crewai_manager.default`

**Schema**

- **Agent description** (`agent_description`) — `string`. What this manager + its sub-agent crew does. Used by parent agents that call this manager as a tool via `&lt;nodeId&gt;.run_agent` to decide when to invoke it.
- **Instructions** (`instructions`) — `array`. Additional instructions to guide the manager's delegation strategy.
- **Advanced Mode** (`advanced_mode`) — `boolean`, default `false`. Expose CrewAI manager Agent configuration directly.
- **Manager Goal** (`goal`) — `string`. What the manager is trying to achieve. Maps to CrewAI Agent(goal=...).
- **Manager Backstory** (`backstory`) — `string`. Background context for the manager's persona. Maps to CrewAI Agent(backstory=...).

### Service: `subagent`

- **Class type** — crewai
- **Capabilities** — invoke
- **Protocol** — `agent_crewai_subagent://`

**Profiles**

- `default`

**Configuration sections**

- **CrewAI Subagent** — `agent_crewai_subagent.default`

**Schema**

- **Instructions** (`instructions`) — `array`. Additional instructions to guide this sub-agent when the Manager delegates to it.
- **Advanced Mode** (`advanced_mode`) — `boolean`, default `false`. Expose CrewAI Agent and Task configuration directly.
- **Agent Config** (`agent_crewai_subagent.agent_config_header`) — `null`, default ``
- **Role** (`role`) — `string`. Sub-agent role name (e.g. 'Financial Analyst'). The Manager uses this name when routing delegation. Maps to CrewAI Agent(role=...).
- **Goal** (`goal`) — `string`. What this sub-agent aims to achieve when delegated to. Maps to CrewAI Agent(goal=...).
- **Backstory** (`backstory`) — `string`. Background context for this sub-agent's expertise. Helps the Manager and the sub-agent's own LLM reason about when it's the right choice. Maps to CrewAI Agent(backstory=...).
- **Task Config** (`agent_crewai_subagent.task_config_header`) — `null`, default ``
- **Task** (`task_description`) — `string`. What this sub-agent does when delegated to by the Manager. The user's request is passed as additional context at run time. Maps to CrewAI Task(description=...).
- **Expected Output** (`expected_output`) — `string`. Description of the expected output format. Maps to CrewAI Task(expected_output=...).

### Dependencies

- `crewai` `>=1.14.1`

### Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> GitHub/agent_crewai](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_crewai)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
