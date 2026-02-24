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
CrewAI tool adapter + discovery for Aparavi host services.

Important: this module must NOT import crewai at module import time.
We expose factory functions that lazily import CrewAI types after
node dependencies are installed via IGlobal.beginGlobal().
"""

from __future__ import annotations

import json
from typing import Any, Callable, List


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''


def query_tool_catalog(*, host: Any) -> Any:
    """Best-effort host tool discovery."""
    try:
        return host.tools.query()
    except Exception as e:
        return {'error': str(e), 'type': type(e).__name__}


def extract_tool_names(tool_catalog: Any) -> List[str]:
    """Extract tool names from host.tools.query response (best-effort)."""
    try:
        tools_obj = None
        if hasattr(tool_catalog, 'tools'):
            tools_obj = getattr(tool_catalog, 'tools')
        elif isinstance(tool_catalog, dict):
            tools_obj = tool_catalog.get('tools')

        if not isinstance(tools_obj, list):
            return []

        names: List[str] = []
        for t in tools_obj:
            if isinstance(t, str):
                names.append(t.strip())
                continue
            if isinstance(t, dict):
                n = t.get('name') or t.get('tool_name') or t.get('toolName')
                if isinstance(n, str):
                    names.append(n.strip())
                continue
            if hasattr(t, 'name'):
                n = getattr(t, 'name')
                if isinstance(n, str):
                    names.append(n.strip())

        # de-dupe preserving order
        out: List[str] = []
        seen = set()
        for n in names:
            if n and n not in seen:
                seen.add(n)
                out.append(n)
        return out
    except Exception:
        return []


def make_host_tools(
    *,
    host: Any,
    tool_names: List[str],
    log_tool_call: Callable[..., None],
) -> List[Any]:
    """
    Build CrewAI BaseTool wrappers for each tool name.

    - `log_tool_call` is expected to be compatible with RunMemory.log_tool_call(...)
    - Lazy imports CrewAI + Pydantic to keep module import safe before depends().
    """
    from crewai.tools import BaseTool  # type: ignore
    from pydantic import BaseModel, ConfigDict, Field  # type: ignore

    class _ToolInput(BaseModel):
        """Generic tool input schema: accept either `input` or arbitrary kwargs."""

        input: Any = Field(default=None, description='Tool input payload')
        model_config = ConfigDict(extra='allow')

    class HostTool(BaseTool):
        """CrewAI tool wrapper that invokes an Aparavi host tool by name."""

        name: str
        description: str
        # Pydantic v2 requires a type annotation when overriding BaseModel fields.
        args_schema: type[BaseModel] = _ToolInput

        def _run(self, input: Any = None, **kwargs: Any) -> str:
            # CrewAI may pass either:
            # - input=<dict> (when args_schema has an `input` field)
            # - kwargs (when args_schema allows extra fields)
            # - nothing (model forgot args)
            payload: Any
            if input is not None:
                payload = input
            elif kwargs:
                payload = kwargs
            else:
                payload = {}

            # Best-effort: unwrap pydantic models.
            if hasattr(payload, 'model_dump'):
                try:
                    payload = payload.model_dump()
                except Exception:
                    pass

            try:
                out = host.tools.invoke(self.name, payload)
            except Exception as e:
                out = {'error': str(e), 'type': type(e).__name__}

            try:
                log_tool_call(tool_name=self.name, input=payload, output=out)
            except Exception:
                # Logging must never break tool execution.
                pass

            # CrewAI expects string results for many flows; return a stable string form.
            try:
                return json.dumps(out, default=str) if isinstance(out, (dict, list)) else _safe_str(out)
            except Exception:
                return _safe_str(out)

    return [HostTool(name=tool_name, description=f'Invoke host tool: {tool_name}') for tool_name in tool_names]

