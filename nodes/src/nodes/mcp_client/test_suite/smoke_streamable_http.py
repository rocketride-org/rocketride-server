"""
Smoke test: Streamable HTTP transport with local mock MCP server.

Starts the mock HTTP server on a random port in a background thread, then
connects via McpStreamableHttpClient and runs the standard lifecycle:
  start() -> list_tools() -> call_tool("echo") -> call_tool("get_status") -> stop()

No external dependencies required.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
from pathlib import Path
from typing import Any


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module spec from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    here = Path(__file__).resolve().parent

    http_client_mod = _load_module(
        "mcp_streamable_http_client", here.parent / "mcp_streamable_http_client.py"
    )
    mock_server_mod = _load_module(
        "mock_streamable_http_server", here / "mock_streamable_http_server.py"
    )

    McpStreamableHttpClient = http_client_mod.McpStreamableHttpClient

    # Start mock server on a random port
    server = mock_server_mod.start_server(port=0)
    port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"  [http] mock server started on port {port}")

    endpoint = f"http://127.0.0.1:{port}/mcp"
    client = McpStreamableHttpClient(endpoint=endpoint, timeout_s=10.0)

    try:
        # Step 1: connect + initialize
        client.start()
        print("  [http] connected to mock server  ✓")

        # Step 2: discover tools
        tools = client.list_tools()
        names = [t.name for t in tools]
        assert len(tools) == 2, f"expected 2 tools, got {len(tools)}: {names}"
        assert "get_status" in names, f"get_status not found: {names}"
        assert "echo" in names, f"echo not found: {names}"
        print(f"  [http] discovered tools: {names}  ✓")

        # Step 3: call echo
        echo_result = client.call_tool(name="echo", arguments={"text": "hello_http"})
        assert echo_result.get("isError") is False, f"echo returned error: {echo_result}"
        content = echo_result.get("content", [])
        assert content and content[0].get("text") == "echo:hello_http", (
            f"unexpected echo response: {echo_result}"
        )
        print(f"  [http] echo → {content[0]['text']!r}  ✓")

        # Step 4: call get_status
        status_result = client.call_tool(name="get_status", arguments={})
        assert status_result.get("isError") is False, f"get_status error: {status_result}"
        status_text = status_result.get("content", [{}])[0].get("text", "")
        assert status_text == "ok", f"expected 'ok', got {status_text!r}"
        print(f"  [http] get_status → {status_text!r}  ✓")

    finally:
        client.stop()
        server.shutdown()
        print("  [http] client + server stopped  ✓")


if __name__ == "__main__":
    main()
    print("smoke_streamable_http_ok")
