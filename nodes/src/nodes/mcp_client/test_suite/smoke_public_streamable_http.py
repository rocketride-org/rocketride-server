"""
Smoke test: Streamable HTTP transport against public MCP servers.

Connects to free, no-auth public MCP servers to validate the
McpStreamableHttpClient against real-world endpoints:

  1. Echo server  — https://echo.mcp.inevitable.fyi/mcp
  2. Time server  — https://time.mcp.inevitable.fyi/mcp

**Requires network access.**
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, List


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module spec from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _test_echo_server(McpStreamableHttpClient: Any) -> None:
    """Test the public echo MCP server."""
    endpoint = "https://echo.mcp.inevitable.fyi/mcp"
    print(f"  [public-http] connecting to echo server: {endpoint}")

    client = McpStreamableHttpClient(endpoint=endpoint, timeout_s=30.0)
    try:
        client.start()
        print("  [public-http] echo: connected  ✓")

        tools = client.list_tools()
        names = [t.name for t in tools]
        assert len(tools) >= 1, f"expected at least 1 tool, got {len(tools)}"
        print(f"  [public-http] echo: discovered {len(tools)} tools: {names}  ✓")

        # Try to call the first available tool with a simple payload
        tool = tools[0]
        print(f"  [public-http] echo: calling tool '{tool.name}'...")
        result = client.call_tool(name=tool.name, arguments={"message": "hello from rocketride"})
        assert isinstance(result, dict), f"expected dict result, got {type(result)}"
        print(f"  [public-http] echo: tool call returned successfully  ✓")

    finally:
        client.stop()
        print("  [public-http] echo: client stopped  ✓")


def _test_time_server(McpStreamableHttpClient: Any) -> None:
    """Test the public time MCP server."""
    endpoint = "https://time.mcp.inevitable.fyi/mcp"
    print(f"  [public-http] connecting to time server: {endpoint}")

    client = McpStreamableHttpClient(endpoint=endpoint, timeout_s=30.0)
    try:
        client.start()
        print("  [public-http] time: connected  ✓")

        tools = client.list_tools()
        names = [t.name for t in tools]
        assert len(tools) >= 1, f"expected at least 1 tool, got {len(tools)}"
        print(f"  [public-http] time: discovered {len(tools)} tools: {names}  ✓")

        # Call the first tool to get the current time
        tool = tools[0]
        print(f"  [public-http] time: calling tool '{tool.name}'...")
        result = client.call_tool(name=tool.name, arguments={})
        assert isinstance(result, dict), f"expected dict result, got {type(result)}"

        content = result.get("content", [])
        if content:
            text = content[0].get("text", "")
            print(f"  [public-http] time: response → {text[:100]!r}  ✓")
        else:
            print(f"  [public-http] time: tool call returned (no content field)  ✓")

    finally:
        client.stop()
        print("  [public-http] time: client stopped  ✓")


def main() -> None:
    here = Path(__file__).resolve().parent
    http_client_mod = _load_module(
        "mcp_streamable_http_client", here.parent / "mcp_streamable_http_client.py"
    )
    McpStreamableHttpClient = http_client_mod.McpStreamableHttpClient

    passed = 0
    failed: List[str] = []
    skipped: List[str] = []

    for label, test_fn in [("echo", _test_echo_server), ("time", _test_time_server)]:
        try:
            test_fn(McpStreamableHttpClient)
            passed += 1
        except (OSError, TimeoutError) as e:
            # Network/DNS failures are expected in sandboxed environments
            skipped.append(f"{label}: {e}")
            print(f"  [public-http] {label}: SKIPPED (network unavailable) — {e}")
        except Exception as e:
            failed.append(f"{label}: {e}")
            print(f"  [public-http] {label}: FAILED — {e}")

    print(f"\n  Results: {passed} passed, {len(failed)} failed, {len(skipped)} skipped")
    if skipped:
        for s in skipped:
            print(f"    SKIP: {s}")
    if failed:
        for f in failed:
            print(f"    FAIL: {f}")
        sys.exit(1)
    if passed == 0 and skipped:
        print("  (all tests skipped due to network — run from a terminal with internet access)")
        sys.exit(0)


if __name__ == "__main__":
    main()
    print("smoke_public_streamable_http_ok")
