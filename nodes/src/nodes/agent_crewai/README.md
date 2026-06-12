# agent_crewai

Run [CrewAI](https://docs.crewai.com) agents inside RocketRide: solo, as a manager, or as managed workers.

## What it does

Three node variants share the same base driver:

- **CrewAI Agent** (`agent_crewai`): a standalone single agent. It assembles a CrewAI `Agent` + `Task` and runs it to answer the incoming question.
- **CrewAI Manager** (`agent_crewai_manager`): orchestrates a crew. It runs CrewAI's hierarchical process: fans out to the connected CrewAI Subagent nodes, assembles a Crew with the manager as delegator, and synthesizes their outputs into one answer.
- **CrewAI Subagent** (`agent_crewai_subagent`): a managed worker. Wired into a Manager via the `crewai` channel and delegated to by name (its `role`); it has no `questions` lane and cannot be invoked directly.

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
