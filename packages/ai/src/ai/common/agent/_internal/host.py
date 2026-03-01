"""
Framework-facing host services for agent framework drivers.

Wraps the engine control-plane invoke seam into a small interface:
  - host.llm.invoke(...)
  - host.tools.query/validate/invoke(...)
"""

from __future__ import annotations

from typing import Any

from rocketlib.types import IInvokeLLM, IInvokeTool


class AgentHostServices:
    class LLM:
        """LLM host interface backed by `invoke('llm', ...)`."""

        def __init__(self, invoker):
            """Create an LLM host service wrapper bound to an engine invoker."""
            self._invoker = invoker

        def invoke(self, param: IInvokeLLM) -> Any:
            """
            Invoke the host LLM control-plane operation.

            Args:
                param: An `IInvokeLLM` request object (e.g. op="ask").

            Returns:
                The engine-native response object.
            """
            return self._invoker('llm', param)

    class Tools:
        """Tool host interface backed by `invoke('tool', ...)`."""

        def __init__(self, invoker):
            """Create a Tools host service wrapper bound to an engine invoker."""
            self._invoker = invoker

        def query(self) -> Any:
            """
            Query the connected tool catalog (discovery).

            Returns:
                The engine-native tool catalog response.
            """
            return self._invoker('tool', IInvokeTool.Query())

        def validate(self, tool_name: str, input: Any) -> Any:
            """
            Validate tool input without executing the tool.

            Args:
                tool_name: Tool name as published by discovery.
                input: Tool input payload.
            """
            return self._invoker('tool', IInvokeTool.Validate(tool_name=tool_name, input=input))

        def invoke(self, tool_name: str, input: Any) -> Any:
            """
            Invoke a tool with the given input payload.

            Args:
                tool_name: Tool name as published by discovery.
                input: Tool input payload.

            Returns:
                The engine-native tool invocation response.
            """
            return self._invoker('tool', IInvokeTool.Invoke(tool_name=tool_name, input=input))

    def __init__(self, invoker):
        """Create host service wrappers bound to an engine invoker."""
        self.llm = AgentHostServices.LLM(invoker)
        self.tools = AgentHostServices.Tools(invoker)
