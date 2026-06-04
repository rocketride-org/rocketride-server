# tool_pipe

Exposes an inline pipeline as an agent tool node.

## What it does

Agents invoke this node via the tool invoke channel. When the agent calls the tool, the input is routed to every connected output lane, the inline pipeline runs, and the configured response value is returned to the agent.

Unlike the other `tool_*` nodes, `tool_pipe` does have output lanes (`text`, `questions`, `documents`, `table`, `answers`) on its `_source` channel. Connect these to any pipeline nodes on the same canvas to build the tool's behavior. End each connected branch with a response node so results can be returned. The agent binding itself still happens through the `invoke` capability.

## Config fields

| Field            | Default | Description                                                                 |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| Tool Description | *(empty)* | Natural-language description the agent uses to decide when to call this tool. |
| Return Type      | `text`  | Which response lane value to return to the agent: `text`, `answers`, `documents`, or `table`. |
