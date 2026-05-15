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
Python tool node instance.

Exposes a single ``execute`` tool that runs agent-supplied Python code in a
restricted in-process sandbox.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function
from ai.common.sandbox import execute_sandboxed, _TIMEOUT, _DEFAULT_ALLOWED_MODULES

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['code'],
            'properties': {
                'code': {
                    'type': 'string',
                    'description': 'Python source code to execute. Use print() to produce output. Assign to a variable named "result" to return structured data. Only whitelisted modules can be imported — check the tool description for the list.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'stdout': {'type': 'string', 'description': 'Captured print() output from the script.'},
                'stderr': {'type': 'string', 'description': 'Error traceback if the script raised an exception.'},
                'exit_code': {
                    'type': 'integer',
                    'description': 'Exit code (0 = success, 1 = exception, -1 = timeout).',
                },
                'timed_out': {'type': 'boolean', 'description': 'True if the script was killed due to timeout.'},
                'result': {'description': 'Value of the "result" variable if set by the script.'},
            },
        },
        description=lambda self: (
            f'Execute Python code in a sandboxed environment and return stdout/stderr. '
            f'Use print() to produce visible output. Assign to a variable named "result" '
            f'to return structured data (dict, list, etc.). '
            f'Timeout: {self.IGlobal.timeout if self.IGlobal.timeout is not None else _TIMEOUT}s. '
            f'Allowed imports: {", ".join(sorted(_DEFAULT_ALLOWED_MODULES | (self.IGlobal.allowed_modules or set())))}. '
            f'All other imports will raise ImportError.'
        ),
    )
    def execute(self, args):
        """Execute Python code in a sandboxed environment."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')
        code = args.get('code')
        if not code or not isinstance(code, str) or not code.strip():
            raise ValueError('"code" is required and must be a non-empty string')
        return execute_sandboxed(code, allowed_modules=self.IGlobal.allowed_modules, timeout=self.IGlobal.timeout)
