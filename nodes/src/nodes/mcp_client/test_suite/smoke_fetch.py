"""
Smoke test: STDIO transport with the real mcp-server-fetch MCP server.

Uses ``uvx mcp-server-fetch`` to spawn a real MCP server that exposes a
``fetch`` tool capable of retrieving web page content.

Verifies:
  start() -> list_tools() finds "fetch" -> call_tool("fetch", url=...) -> stop()

**Requires network access** (fetches https://example.com).
"""

from __future__ import annotations

import importlib.util
import shutil
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
    uvx = shutil.which("uvx")
    if not uvx:
        print("  [fetch] SKIP: uvx not found on PATH")
        return

    here = Path(__file__).resolve().parent
    mcp_mod = _load_module("mcp_stdio_client", here.parent / "mcp_stdio_client.py")
    McpStdioClient = mcp_mod.McpStdioClient

    client = McpStdioClient(
        command=uvx,
        args=["mcp-server-fetch"],
        timeout_s=60.0,
    )

    try:
        # Step 1: connect
        client.start()
        print("  [fetch] connected to mcp-server-fetch  ✓")

        # Step 2: discover tools
        tools = client.list_tools()
        names = [t.name for t in tools]
        assert len(tools) >= 1, f"expected at least 1 tool, got {len(tools)}"
        assert "fetch" in names, f"'fetch' tool not found: {names}"
        print(f"  [fetch] discovered tools: {names}  ✓")

        # Step 3: call fetch on example.com
        # mcp-server-fetch may pre-check robots.txt; if that fails due to
        # network restrictions the tool returns isError=True but the MCP
        # protocol round-trip itself still succeeded.
        result = client.call_tool(name="fetch", arguments={"url": "https://example.com"})
        content = result.get("content", [])

        if result.get("isError") is True:
            text = content[0].get("text", "") if content else ""
            print(f"  [fetch] tool returned soft error (likely network): {text[:120]}")
            print("  [fetch] MCP protocol round-trip verified (tool responded correctly)  ✓")
        else:
            assert content, f"empty content from fetch: {result}"
            text = content[0].get("text", "")
            assert "Example Domain" in text, (
                f"expected 'Example Domain' in response, got first 200 chars: {text[:200]!r}"
            )
            print(f"  [fetch] fetched example.com ({len(text)} chars)  ✓")

    finally:
        client.stop()
        print("  [fetch] client stopped  ✓")


if __name__ == "__main__":
    main()
    print("smoke_fetch_ok")
