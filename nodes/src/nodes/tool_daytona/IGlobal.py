# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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
Daytona tool node - global (shared) state.

Reads the Daytona API key from config and creates a Daytona client.
The sandbox itself is created lazily on the first tool call (creating one
costs money and time, and a pipeline may never invoke the tool) and is
deleted in ``endGlobal``. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import threading

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig, Sandbox


def _int_or(value, default: int, *, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))


class IGlobal(IGlobalBase):
    """Global state for tool_daytona."""

    client: Daytona | None = None
    sandbox: Sandbox | None = None  # created lazily, deleted in endGlobal
    # Guards lazy sandbox creation: agents issue parallel tool calls (e.g.
    # deepagent's asyncio.gather fan-out), and an unsynchronized check-then-act
    # would create two billed sandboxes and orphan one.
    _sandbox_lock: threading.Lock | None = None
    # Safety bounds for agent-driven execution; overridable from config.
    snapshot: str = ''
    language: str = 'python'
    auto_stop_minutes: int = 5
    exec_timeout_secs: int = 120
    max_output_chars: int = 50000

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._sandbox_lock = threading.Lock()

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = str((cfg.get('apikey') or '')).strip()

        if not apikey:
            raise Exception('tool_daytona: apikey is required')

        api_url = str((cfg.get('api_url') or '')).strip()
        target = str((cfg.get('target') or '')).strip()
        self.snapshot = str((cfg.get('snapshot') or '')).strip()
        self.language = str((cfg.get('language') or 'python')).strip() or 'python'
        # auto_stop_interval=0 would disable the inactivity stop entirely;
        # floor at 1 minute so an abandoned sandbox always shuts itself down.
        self.auto_stop_minutes = _int_or(cfg.get('auto_stop_minutes'), 5, lo=1, hi=120)
        self.exec_timeout_secs = _int_or(cfg.get('exec_timeout_secs'), 120, lo=1, hi=1200)
        self.max_output_chars = _int_or(cfg.get('max_output_chars'), 50000, lo=1000, hi=1000000)

        config_kwargs = {'api_key': apikey}
        if api_url:
            config_kwargs['api_url'] = api_url
        if target:
            config_kwargs['target'] = target

        self.client = Daytona(DaytonaConfig(**config_kwargs))

    def get_sandbox(self) -> Sandbox:
        """Return the shared sandbox, creating it on first use.

        Ephemeral + auto-stop so the sandbox cleans itself up (and stops
        billing) even if endGlobal never runs, e.g. on a crashed engine.
        """
        sandbox = self.sandbox
        if sandbox is None:
            with self._sandbox_lock:
                if self.sandbox is None:
                    params_kwargs = {
                        'ephemeral': True,
                        'auto_stop_interval': self.auto_stop_minutes,
                        'language': self.language,
                    }
                    if self.snapshot:
                        params_kwargs['snapshot'] = self.snapshot
                    self.sandbox = self.client.create(CreateSandboxFromSnapshotParams(**params_kwargs))
                    debug(f'tool_daytona: created sandbox {getattr(self.sandbox, "id", "?")}')
                sandbox = self.sandbox
        return sandbox

    def drop_sandbox(self, sandbox: Sandbox) -> None:
        """Forget a sandbox the server reports gone.

        Being ephemeral, the sandbox is deleted server-side once the
        inactivity auto-stop fires; dropping the stale handle lets the next
        get_sandbox() call create a fresh one instead of failing forever.
        """
        with self._sandbox_lock:
            if self.sandbox is sandbox:
                self.sandbox = None

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str((cfg.get('apikey') or '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        if self.sandbox is not None:
            try:
                self.sandbox.delete()
            except Exception as e:
                # The sandbox is ephemeral with auto-stop, so a failed delete
                # only delays cleanup until the inactivity timer fires.
                warning(f'tool_daytona: sandbox delete failed: {e}')
            finally:
                self.sandbox = None
        self.client = None
