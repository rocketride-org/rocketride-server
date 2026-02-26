# Minimal mock MCP server over stdio (no external deps).
#
# Implements:
# - initialize -> result with serverInfo and tools capability
# - notifications/initialized -> ignored
# - tools/list -> returns two tools
# - tools/call -> returns predictable result
#
# This is used for smoke tests without requiring the MCP Python SDK.

from __future__ import annotations

import json
import sys


TOOLS = [
    {
        "name": "get_status",
        "description": "Return mock status",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "echo",
        "description": "Echo input text",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue

        if not isinstance(msg, dict):
            continue

        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}

        # Notifications have no id; ignore.
        if method == "notifications/initialized" and msg_id is None:
            continue

        if msg_id is None:
            continue

        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "MockMcpServer", "version": "0.1.0"},
                    },
                }
            )
            continue

        if method == "tools/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS, "nextCursor": None}})
            continue

        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "get_status":
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {"content": [{"type": "text", "text": "ok"}], "isError": False},
                    }
                )
            elif name == "echo":
                text = args.get("text", "")
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {
                            "content": [{"type": "text", "text": f"echo:{text}"}],
                            "isError": False,
                        },
                    }
                )
            else:
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {"code": -32602, "message": f"Unknown tool: {name}"},
                    }
                )
            continue

        send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    main()
