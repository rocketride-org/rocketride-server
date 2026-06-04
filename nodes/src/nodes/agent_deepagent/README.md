# agent_deepagent

A planning-capable agent for RocketRide, with optional managed sub-agents.

## What it does

[Deep Agents](https://github.com/langchain-ai/deepagents) (built on LangChain/LangGraph) come in two node variants:

- **Deep Agent** (`agent_deepagent`) — a single agent that adds strategic planning, persistent state, and long-context management on top of a normal LangChain tool-calling loop. It answers the incoming question via `deepagents.create_deep_agent`.
- **Deep Agent Subagent** (`agent_deepagent_subagent`) — a managed worker. Wired into a Deep Agent via the `deepagent` channel; the orchestrator delegates to it based on its `description`. It has no `questions` lane and cannot be invoked directly.

In data-flow terms, the Deep Agent consumes `questions` and produces `answers` (`"questions": ["answers"]`). It also registers as a tool (`classType: ["agent", "tool"]`) and exposes itself as `<nodeId>.run_agent`, so a parent agent can delegate to it in hierarchical pipelines. Connect Deep Agent Subagent nodes on the optional `deepagent` channel (`min: 0`) and it becomes a hierarchical orchestrator that delegates to them. Tools attach through the `tool` invoke channel (control-plane invoke), not through lanes; the Subagent has its own `tool` channel. Each variant requires exactly one `llm` channel (`min: 1`).

## Configuration

### Deep Agent

| Field             | Default | Description                                                                                    |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| Advanced Mode     | `Off`   | When Off, edit the agent through the Instructions list. When On, expose Agent Description and System Prompt for full control. |
| Instructions      | `[]`    | Additional instructions to guide the agent. Each line is appended to the system prompt. (Advanced Mode Off) |
| Agent description | `""`    | What this agent does. Helps parent agents select and invoke it correctly. (Advanced Mode On)   |
| System prompt     | `""`    | Instructions that define the agent's role and behaviour. Leave blank to use the default. (Advanced Mode On) |

### Deep Agent Subagent

| Field         | Default | Description                                                                                       |
| ------------- | ------- | ------------------------------------------------------------------------------------------------ |
| Advanced Mode | `Off`   | When Off, edit through the Instructions list. When On, expose the System Prompt for full control. |
| Description   | `""`    | The orchestrator reads this to decide when to delegate. Keep it specific and action-oriented — it is the only signal used to pick a sub-agent. |
| Instructions  | `[]`    | Additional instructions for this sub-agent. Each line is appended to the system prompt. (Advanced Mode Off) |
| System prompt | `""`    | Instructions that define this sub-agent's role and behaviour. Leave blank to use the default. (Advanced Mode On) |
