"""
Smoke test: Agent-to-MCP integration pipeline.

Simulates the agent integration seam using a FakeHost that wires
host.tools.query() and host.tools.invoke() through the McpStdioClient,
then runs a multi-step flow:

  1. Discover tools via host.tools.query()
  2. Extract namespaced tool names
  3. Invoke mock.echo with test payload
  4. Invoke mock.get_status for liveness
  5. Chain: pass status into a second echo call
  6. Verify call log for idempotency (no state bleed)

No engine runtime (rocketlib/crewai) needed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, List


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module spec from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


SERVER_NAME = "mock"


class _FakeTools:
    """Mimics AgentHostServices.Tools backed by a live McpStdioClient."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._call_log: List[Dict] = []

    def query(self) -> Dict[str, Any]:
        raw_tools = self._client.list_tools()
        return {
            "tools": [
                {
                    "name": f"{SERVER_NAME}.{t.name}",
                    "description": t.description,
                    "inputSchema": t.inputSchema,
                }
                for t in raw_tools
            ]
        }

    def invoke(self, tool_name: str, input: Any) -> Dict[str, Any]:
        prefix = f"{SERVER_NAME}."
        bare_name = tool_name[len(prefix):] if tool_name.startswith(prefix) else tool_name

        if isinstance(input, dict) and list(input.keys()) == ["input"]:
            input = input["input"]
        if not isinstance(input, dict):
            input = {}

        result = self._client.call_tool(name=bare_name, arguments=input)
        self._call_log.append({"tool": tool_name, "input": input, "result": result})
        return result


class FakeHost:
    def __init__(self, client: Any) -> None:
        self.tools = _FakeTools(client)


def _extract_text(result: Dict) -> str:
    content = result.get("content", [])
    if content and isinstance(content[0], dict):
        return content[0].get("text", "")
    return ""


def main() -> None:
    here = Path(__file__).resolve().parent
    mcp_mod = _load_module("mcp_stdio_client_agent", here.parent / "mcp_stdio_client.py")
    McpStdioClient = mcp_mod.McpStdioClient

    server_script = str((here / "mock_mcp_server.py").resolve())

    client = McpStdioClient(
        command=sys.executable,
        args=[server_script],
        env={"PYTHONUNBUFFERED": "1"},
        timeout_s=10.0,
    )

    try:
        client.start()
        host = FakeHost(client)

        # Step 1: discover tools via host.tools.query()
        catalog = host.tools.query()
        assert isinstance(catalog, dict), f"catalog should be dict, got {type(catalog)}"
        assert "tools" in catalog, f"catalog missing 'tools' key: {catalog}"

        tool_list: List[Dict] = catalog["tools"]
        assert len(tool_list) == 2, f"expected 2 tools, got {len(tool_list)}: {tool_list}"

        # Step 2: extract namespaced tool names
        names = [t["name"] for t in tool_list]
        assert "mock.get_status" in names, f"mock.get_status not found: {names}"
        assert "mock.echo" in names, f"mock.echo not found: {names}"
        print(f"  [agent] discovered tools: {names}  ✓")

        # Step 3: invoke mock.echo
        echo_result = host.tools.invoke("mock.echo", {"text": "agent_hello"})
        assert echo_result.get("isError") is False, f"echo error: {echo_result}"
        echo_text = _extract_text(echo_result)
        assert echo_text == "echo:agent_hello", f"unexpected echo: {echo_text!r}"
        print(f"  [agent] echo → {echo_text!r}  ✓")

        # Step 4: get_status liveness check
        status_result = host.tools.invoke("mock.get_status", {})
        assert status_result.get("isError") is False, f"get_status error: {status_result}"
        status_text = _extract_text(status_result)
        assert status_text == "ok", f"expected 'ok', got {status_text!r}"
        print(f"  [agent] get_status → {status_text!r}  ✓")

        # Step 5: chain — pass status into echo
        chained = f"status={status_text}"
        chain_result = host.tools.invoke("mock.echo", {"text": chained})
        assert chain_result.get("isError") is False, f"chained echo error: {chain_result}"
        chain_text = _extract_text(chain_result)
        assert chain_text == f"echo:{chained}", f"chained echo mismatch: {chain_text!r}"
        print(f"  [agent] chained echo → {chain_text!r}  ✓")

        # Step 6: verify call log (3 calls, no state bleed)
        call_log = host.tools._call_log
        assert len(call_log) == 3, f"expected 3 logged calls, got {len(call_log)}"
        assert call_log[0]["tool"] == "mock.echo"
        assert call_log[1]["tool"] == "mock.get_status"
        assert call_log[2]["tool"] == "mock.echo"
        assert call_log[0]["input"] != call_log[2]["input"], "echo inputs should differ"
        print(f"  [agent] call log verified ({len(call_log)} calls, no state bleed)  ✓")

    finally:
        client.stop()
        print("  [agent] client stopped  ✓")


if __name__ == "__main__":
    main()
    print("smoke_agent_mcp_pipeline_ok")
