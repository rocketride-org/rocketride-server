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
IEndpoint for the Listener source node.

Starts the configured adapter on the process-wide event loop and blocks for the
pipeline's lifetime (telegram lifecycle). The adapter delivers items; each is
run through the pipeline on a worker thread by ``engine.run_item``.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Callable, Dict

from rocketlib import IEndpointBase, debug, monitorOther, monitorStatus

from .adapters import get_adapter
from .engine import run_item

_START_TIMEOUT = 60
_STOP_TIMEOUT = 10


class IEndpoint(IEndpointBase):
    """Listener source: an adapter delivers items, the pipeline answers them."""

    target: IEndpointBase | None = None

    def _config(self) -> Dict[str, Any]:
        """Flat node parameters (the engine strips the ``listener.`` prefix)."""
        try:
            return dict(self.endpoint.serviceConfig['parameters'])
        except Exception as exc:
            debug(f'listener: config read failed: {exc}')
            return {}

    async def _handle(self, text: str, name: str) -> str:
        """Adapter callback: run one item through the pipeline off the event loop."""
        return await asyncio.to_thread(run_item, self.target, text, name)

    def _run(self) -> None:
        """Start the adapter, publish the monitor status, and block until shutdown."""
        from ai.node import server_loop

        adapter = get_adapter(self._config())
        asyncio.run_coroutine_threadsafe(adapter.start(self._handle), server_loop).result(timeout=_START_TIMEOUT)
        inbox = getattr(adapter, 'inbox', '')
        monitorOther('usr', json.dumps([{'url-text': 'Listening on', 'url-link': inbox}]))
        monitorStatus(f'Listener ready: {inbox}')

        # Like telegram: nothing sets this in production; the subprocess is
        # killed when the pipeline stops, and un-acked items are redelivered.
        self._shutdown_event = threading.Event()
        self._shutdown_event.wait()
        try:
            asyncio.run_coroutine_threadsafe(adapter.stop(), server_loop).result(timeout=_STOP_TIMEOUT)
        except Exception as exc:
            debug(f'listener: stop raised: {exc}')

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Engine entry point: store the target and run until the pipeline stops."""
        self.target = self.endpoint.target
        self._run()
