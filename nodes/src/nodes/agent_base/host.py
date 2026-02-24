# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Framework-facing host services for agent framework nodes.

This module wraps the engine control-plane invoke seam into a small interface:
  - host.llm.invoke(...)
  - host.tools.query/validate/invoke(...)
"""

from __future__ import annotations

from typing import Any

from aparavi.types import IInvokeLLM, IInvokeTool


class AgentHostServices:
    """
    Framework-facing host services.

    Agents should call host services rather than importing provider SDKs directly.
    Under the hood, we use the existing pipeline control-plane invoke seam.
    """

    class LLM:
        """LLM host interface backed by `invoke('llm', ...)`."""

        def __init__(self, invoker):
            """Create an LLM host service wrapper bound to an engine invoker."""
            self._invoker = invoker

        def invoke(self, param: IInvokeLLM) -> Any:
            """Invoke the host LLM control-plane operation."""
            return self._invoker('llm', param)

    class Tools:
        """Tool host interface backed by `invoke('tool', ...)`."""

        def __init__(self, invoker):
            """Create a Tools host service wrapper bound to an engine invoker."""
            self._invoker = invoker

        def query(self) -> Any:
            """Query the connected tool catalog (discovery)."""
            return self._invoker('tool', IInvokeTool.Query())

        def validate(self, tool_name: str, input: Any) -> Any:
            """Validate tool input without executing the tool."""
            return self._invoker('tool', IInvokeTool.Validate(tool_name=tool_name, input=input))

        def invoke(self, tool_name: str, input: Any) -> Any:
            """Invoke a tool with the given input payload."""
            return self._invoker('tool', IInvokeTool.Invoke(tool_name=tool_name, input=input))

    def __init__(self, invoker):
        """Create host service wrappers bound to an engine invoker."""
        self.llm = AgentHostServices.LLM(invoker)
        self.tools = AgentHostServices.Tools(invoker)

