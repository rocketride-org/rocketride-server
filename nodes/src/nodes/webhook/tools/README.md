---
title: Tools
date: 2026-07-26
sidebar_position: 1
---

<head>
  <title>Tools - RocketRide Documentation</title>
</head>

## What it does

Source node that transfers no data: it exists to host tool nodes. Connect tools
to it through the tool invoke channel — exactly as tools connect to an agent —
and call them directly from a client with `client.tool()`. No agent, no LLM, no
data lanes.

Use it when a pipeline's whole purpose is exposing capabilities to an
application: file storage operations, vector store management, or third-party
integrations driven by your own code rather than by an LLM.

```json
{
	"source": "tools_1",
	"components": [
		{ "id": "tools_1", "provider": "tools", "config": {}, "input": [] },
		{
			"id": "toolfs_1",
			"provider": "tool_filesystem",
			"config": {},
			"input": [],
			"control": [{ "classType": "tool", "from": "tools_1" }]
		}
	]
}
```

```python
result = await client.use(pipeline=pipeline)
listing = await client.tool(
    token=result['token'],
    tool='list_directory',
    node_id='toolfs_1',
    input={'path': ''},
)
```

**Lanes:**

| Lane in | Lane out | Description                             |
| ------- | -------- | --------------------------------------- |
| -       | -        | No data lanes — pure tool-invoke host    |

## Configuration

None. The node holds the pipeline open until the task is terminated; connected
tool nodes handle `client.tool()` calls via the control plane.
