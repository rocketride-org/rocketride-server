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
Python code-execution tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` by exposing a
single ``execute`` tool that runs agent-supplied Python code in a restricted
in-process sandbox via ``exec()``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Set

from ai.common.tools import ToolsBase

from ai.common.sandbox import execute_sandboxed, _TIMEOUT, _DEFAULT_ALLOWED_MODULES

INPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['code'],
    'properties': {
        'code': {
            'type': 'string',
            'description': (
                'Python source code to execute. Use print() to produce output. '
                'Assign to a variable named "result" to return structured data. '
                'Only whitelisted modules can be imported — check the tool description for the list.'
            ),
        },
    },
}

OUTPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'properties': {
        'stdout': {
            'type': 'string',
            'description': 'Captured print() output from the script.',
        },
        'stderr': {
            'type': 'string',
            'description': 'Error traceback if the script raised an exception.',
        },
        'exit_code': {
            'type': 'integer',
            'description': 'Exit code (0 = success, 1 = exception, -1 = timeout).',
        },
        'timed_out': {
            'type': 'boolean',
            'description': 'True if the script was killed due to timeout.',
        },
        'result': {
            'description': 'Value of the "result" variable if set by the script.',
        },
    },
}


class PythonDriver(ToolsBase):

    def __init__(self, *, server_name: str, allowed_modules: Set[str] | None = None):
        self._server_name = (server_name or '').strip() or 'python'
        self._tool_name = 'execute'
        self._namespaced = f'{self._server_name}.{self._tool_name}'
        self._allowed_modules = allowed_modules

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        effective = _DEFAULT_ALLOWED_MODULES | (self._allowed_modules or set())
        imports_note = f'Allowed imports: {", ".join(sorted(effective))}. All other imports will raise ImportError.'
        return [
            {
                'name': self._namespaced,
                'description': (
                    'Execute Python code in a sandboxed environment and return stdout/stderr. '
                    'Use print() to produce visible output. '
                    'Assign to a variable named "result" to return structured data (dict, list, etc.). '
                    f'Timeout: {_TIMEOUT}s. '
                    f'{imports_note}'
                ),
                'inputSchema': INPUT_SCHEMA,
                'outputSchema': OUTPUT_SCHEMA,
            }
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        if tool_name != self._tool_name and tool_name != self._namespaced:
            raise ValueError(f'Unknown tool {tool_name!r} (expected {self._tool_name!r})')

        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

        code = input_obj.get('code')
        if not code or not isinstance(code, str) or not code.strip():
            raise ValueError('"code" is required and must be a non-empty string')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        return execute_sandboxed(input_obj['code'], allowed_modules=self._allowed_modules)
