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
Shell tool node instance.

Exposes a single ``execute`` tool that runs a shell command on the host and
returns stdout, stderr, and exit code.
"""

from __future__ import annotations

import os

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal, MAX_TIMEOUT
from .shell_executor import build_environment, execute_command


class IInstance(IInstanceBase):
    """Per-call instance for the shell tool; exposes the ``execute`` tool function."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['command'],
            'properties': {
                'command': {
                    'type': 'string',
                    'description': 'Shell command to execute (interpreted by the host shell). Example: "npm run build" or "ls -la /tmp".',
                },
                'working_dir': {
                    'type': 'string',
                    'description': 'Optional working directory for this call. Overrides the node-level default. Must be an existing directory.',
                },
                'env': {
                    'type': 'object',
                    'description': 'Optional environment variables to inject for this call. Layered over the host environment; node-configured vars take precedence.',
                    'additionalProperties': {'type': 'string'},
                },
                'timeout': {
                    'type': 'integer',
                    'description': 'Optional timeout in seconds for this call. Capped by the node configuration.',
                    'minimum': 1,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'stdout': {'type': 'string', 'description': 'Captured stdout (UTF-8, possibly truncated).'},
                'stderr': {'type': 'string', 'description': 'Captured stderr (UTF-8, possibly truncated).'},
                'exit_code': {
                    'type': 'integer',
                    'description': 'Process exit code. -1 indicates a timeout, 127 indicates the shell could not be launched.',
                },
                'timed_out': {'type': 'boolean', 'description': 'True if the command was killed due to timeout.'},
                'truncated': {
                    'type': 'boolean',
                    'description': 'True if stdout or stderr was truncated to fit the size cap.',
                },
            },
        },
        description=lambda self: (
            'Execute a shell command on the host and return stdout, stderr, and exit code. '
            'Use for build scripts (npm/pip/make), package management, file operations, process management, '
            'environment inspection, and host-installed git operations. '
            f'Timeout: {self.IGlobal.timeout}s (max {MAX_TIMEOUT}s). '
            f'Default working directory: {self.IGlobal.working_dir or "host process CWD"}. '
            'For portable git operations that do not depend on the host having git installed, prefer the Git node.'
        ),
    )
    def execute(self, args):
        """Execute a shell command on the host."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        command = args.get('command')
        if not isinstance(command, str) or not command.strip():
            raise ValueError('"command" is required and must be a non-empty string')

        self._validate_command(command)

        cwd = self._resolve_cwd(args.get('working_dir'))
        timeout = self._resolve_timeout(args.get('timeout'))
        call_env = args.get('env')
        if call_env is not None and not isinstance(call_env, dict):
            raise ValueError('"env" must be a JSON object of string values')

        env = build_environment(
            base_env=None,
            config_env=self.IGlobal.env_vars or {},
            call_env=call_env,
            allow_external_env=self.IGlobal.allow_external_env,
        )

        return execute_command(
            command,
            cwd=cwd,
            env=env,
            timeout=timeout,
            max_output_bytes=self.IGlobal.max_output_bytes,
        )

    def _validate_command(self, command: str) -> None:
        """Reject commands that don't fully match any configured allowlist regex."""
        # Use fullmatch (not search) so that an unanchored pattern like
        # "git status" cannot be smuggled past via "git status; rm -rf /".
        patterns = self.IGlobal.command_patterns or []
        if patterns and not any(p.fullmatch(command) for p in patterns):
            raise ValueError('Command is not permitted by the configured allowlist.')

    def _resolve_cwd(self, override: object) -> str | None:
        """Pick the per-call cwd override (validated) or fall back to the configured default."""
        if override is None:
            return self._validated_default_cwd()
        if not isinstance(override, str):
            raise ValueError('"working_dir" must be a string')
        path = override.strip()
        if not path:
            return self._validated_default_cwd()
        if not os.path.isdir(path):
            raise ValueError(f'working_dir does not exist or is not a directory: {path!r}')
        return path

    def _validated_default_cwd(self) -> str | None:
        """Return the configured default cwd after verifying it exists, or None if unset."""
        default = self.IGlobal.working_dir
        if default is None:
            return None
        if not os.path.isdir(default):
            raise ValueError(f'working_dir does not exist or is not a directory: {default!r}')
        return default

    def _resolve_timeout(self, override: object) -> int:
        """Coerce a per-call timeout override and clamp it to the configured maximum."""
        if override is None:
            return self.IGlobal.timeout
        try:
            value = int(override)
        except (TypeError, ValueError) as exc:
            raise ValueError('"timeout" must be an integer (seconds)') from exc
        if value <= 0:
            raise ValueError('"timeout" must be a positive integer')
        return min(value, self.IGlobal.timeout)
