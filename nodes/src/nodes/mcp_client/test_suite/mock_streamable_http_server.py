# Minimal mock MCP server over Streamable HTTP (no external deps).
#
# Implements the MCP Streamable HTTP transport:
# - POST /mcp  with JSON-RPC body
# - Responds with Content-Type: application/json
#
# Handles: initialize, notifications/initialized, tools/list, tools/call
# Exposes the same get_status + echo tools as mock_mcp_server.py.
#
# Usage:
#   python mock_streamable_http_server.py          # default port 0 (random)
#   python mock_streamable_http_server.py 8765     # explicit port

from __future__ import annotations

import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, Dict, Optional


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


def _handle_jsonrpc(msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Process a single JSON-RPC message; return response dict or None for notifications."""
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if msg_id is None:
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "MockStreamableHttpServer", "version": "0.1.0"},
            },
        }

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": TOOLS, "nextCursor": None},
        }

    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "get_status":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": "ok"}], "isError": False},
            }
        if name == "echo":
            text = args.get("text", "")
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"echo:{text}"}],
                    "isError": False,
                },
            }
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32602, "message": f"Unknown tool: {name}"},
        }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": "Method not found"},
    }


class McpHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/mcp":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            msg = json.loads(body.decode("utf-8"))
        except Exception:
            self.send_error(400, "Invalid JSON")
            return

        if not isinstance(msg, dict):
            self.send_error(400, "Expected JSON object")
            return

        response = _handle_jsonrpc(msg)

        if response is None:
            self.send_response(202)
            self.end_headers()
            return

        payload = json.dumps(response, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        pass


def start_server(port: int = 0) -> HTTPServer:
    """Start the mock server and return the HTTPServer instance.

    If port is 0, the OS picks a free port.  The actual port is available
    via ``server.server_address[1]``.
    """
    server = HTTPServer(("127.0.0.1", port), McpHandler)
    return server


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = start_server(port)
    actual_port = server.server_address[1]
    print(f"Mock Streamable HTTP MCP server listening on http://127.0.0.1:{actual_port}/mcp")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
