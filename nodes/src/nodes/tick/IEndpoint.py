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

"""Tick — a one-shot timer source (#2107).

Why it exists: the scheduler and manual ``deploy run`` both start a deployed
pipeline with no payload, and every other source in the catalogue is passive —
it scans a directory or blocks waiting for external input. Pointing a cron at a
prompt lane therefore produced a task that sat idle until its ttl. The tick is
the node that knocks on the door: one object, one text, done.

Why it writes a text rather than an empty open/close: since #2252 the ``prompt``
node's ``closing`` returns early when no input was received, so an empty object
would wake nothing downstream. The single text is what lets a per-close
aggregator build and emit its question.

Engine contract (DIRECT pipeline mode, finite source):
1. ``scanObjects`` reports the one entry through ``scanCallback`` — reporting it
   is what feeds the scanner's counter, so the run does not end with the
   engine's "Files not found" warning.
2. For that entry the engine opens the target pipe and calls
   ``IInstance.renderObject``, which delegates to :meth:`IEndpoint.renderTick`
   with ``instance.send*`` bound to the open pipe.
3. Returning from the scan ends it; the engine drains the pipe and the task
   completes, so the scheduler's overlap guard clears on its own.
"""

from datetime import datetime, timezone
from typing import Any, Callable, Dict

from rocketlib import IEndpointBase, debug


class IEndpoint(IEndpointBase):
    """One-shot source endpoint: reports a single entry, renders a single text."""

    _text: str = ''
    _fired_at: str = ''

    def _params(self) -> Dict[str, Any]:
        """Flat config block; the engine strips the 'tick.' field prefix."""
        try:
            return self.endpoint.serviceConfig['parameters'] or {}
        except Exception:
            return {}

    def scanObjects(self, path: str, scanCallback: Callable[[Dict[str, Any]], int]) -> None:
        """Report exactly one object to the engine, then return.

        The entry's payload is resolved here — the configured Message, or the
        fire time in ISO 8601 UTC when it is empty — so ``size`` matches what
        :meth:`renderTick` will write. Returning ends the scan: the engine
        renders the one entry, drains the pipe, and the task completes.
        """
        now = datetime.now(timezone.utc)
        self._fired_at = now.isoformat(timespec='seconds')  # 2026-09-13T08:00:00+00:00
        self._text = str(self._params().get('text') or '').strip() or self._fired_at
        # No colons in the name: the engine treats it as a path.
        name = f'tick-{now.strftime("%Y%m%dT%H%M%SZ")}'
        debug(f'Tick: firing {name}')
        scanCallback({'name': name, 'size': len(self._text.encode('utf-8')), 'isContainer': False})

    def renderTick(self, entry, instance) -> None:
        """Write the tick's one text into the already-open pipe.

        Called by ``IInstance.renderObject``. Errors propagate so the engine
        marks the entry failed. The explicit ``sendClose`` is what dispatches
        the ``close`` lifecycle lane in dev-mode runs (which leave closure to
        the source); the engine's own close is a no-op on an already-closed
        pipe, so task mode is unaffected.
        """
        instance.sendText(self._text)
        instance.sendClose()
