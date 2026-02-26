"""
Smoke test: STDIO transport with local mock MCP server.

Verifies the full MCP lifecycle over stdio:
  start() -> list_tools() -> call_tool("echo") -> call_tool("get_status") -> stop()

No external dependencies required.
"""

from __future__ import annotations

import importlib.util
import sys
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
    mcp_mod = _load_module("mcp_stdio_client", here.parent / "mcp_stdio_client.py")
    McpStdioClient = mcp_mod.McpStdioClient

    server_script = str((here / "mock_mcp_server.py").resolve())

    client = McpStdioClient(
        command=sys.executable,
        args=[server_script],
        env={"PYTHONUNBUFFERED": "1"},
        timeout_s=10.0,
    )

    try:
        # Step 1: connect + initialize
        client.start()
        print("  [stdio] connected to mock server  ✓")

        # Step 2: discover tools
        tools = client.list_tools()
        names = [t.name for t in tools]
        assert len(tools) == 2, f"expected 2 tools, got {len(tools)}: {names}"
        assert "get_status" in names, f"get_status not found: {names}"
        assert "echo" in names, f"echo not found: {names}"
        print(f"  [stdio] discovered tools: {names}  ✓")

        # Step 3: call echo
        echo_result = client.call_tool(name="echo", arguments={"text": "hello_stdio"})
        assert echo_result.get("isError") is False, f"echo returned error: {echo_result}"
        content = echo_result.get("content", [])
        assert content and content[0].get("text") == "echo:hello_stdio", (
            f"unexpected echo response: {echo_result}"
        )
        print(f"  [stdio] echo → {content[0]['text']!r}  ✓")

        # Step 4: call get_status
        status_result = client.call_tool(name="get_status", arguments={})
        assert status_result.get("isError") is False, f"get_status error: {status_result}"
        status_text = status_result.get("content", [{}])[0].get("text", "")
        assert status_text == "ok", f"expected 'ok', got {status_text!r}"
        print(f"  [stdio] get_status → {status_text!r}  ✓")

    finally:
        client.stop()
        print("  [stdio] client stopped  ✓")


if __name__ == "__main__":
    main()
    print("smoke_stdio_ok")
