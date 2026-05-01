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
Shell tool node - global (shared) state.

Reads config and stores execution defaults (working dir, timeout, env vars,
output cap) and the command allowlist for IInstance tool methods.
"""

from __future__ import annotations

import re

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .config_parser import (
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_TIMEOUT,
    MAX_TIMEOUT,
    parse_command_patterns,
    parse_env_vars,
    parse_max_output,
    parse_timeout,
    parse_working_dir,
)


__all__ = ['IGlobal', 'DEFAULT_TIMEOUT', 'MAX_TIMEOUT', 'DEFAULT_MAX_OUTPUT_BYTES']


class IGlobal(IGlobalBase):
    """Global state for tool_shell."""

    working_dir: str | None = None
    timeout: int = DEFAULT_TIMEOUT
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES
    env_vars: dict[str, str] | None = None
    allow_external_env: bool = True
    command_patterns: list[re.Pattern] | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.working_dir = parse_working_dir(cfg)
        self.timeout = parse_timeout(cfg)
        self.max_output_bytes = parse_max_output(cfg)
        self.env_vars = parse_env_vars(cfg)
        self.allow_external_env = bool(cfg.get('allowExternalEnv', True))
        self.command_patterns = parse_command_patterns(cfg, on_invalid=warning)

    def endGlobal(self) -> None:
        self.working_dir = None
        self.timeout = DEFAULT_TIMEOUT
        self.max_output_bytes = DEFAULT_MAX_OUTPUT_BYTES
        self.env_vars = None
        self.allow_external_env = True
        self.command_patterns = None
