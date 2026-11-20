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

"""Debugger support for engine-spawned threads (shared by source nodes)."""

from __future__ import annotations

import sys
import threading

# Thread idents already registered with a loaded debugger (see
# ``register_debugger_thread``). Failed registrations are recorded too, so a
# broken debugger produces one warning instead of one per rendered object.
_DEBUGGER_THREADS: set[int] = set()


def register_debugger_thread(node_name: str) -> None:
    """Register an engine-spawned thread with pydevd before traced code runs.

    The designer launches dev-mode tasks under debugpy, and ``renderObject``
    executes on the engine's C++ ThreadedQueue thread — a thread pydevd never
    saw get created. When line instrumentation fires on such an unregistered
    foreign thread, pydevd livelocks on its internal lock and the render
    wedges mid-object (objects stuck PROCESSING in the designer trace).
    Registering through the official ``settrace`` API happens outside the
    instrumentation callback, making the thread known to the debugger first.

    No-op when no debugger is loaded (task mode) — ``pydevd`` is only in
    ``sys.modules`` when debugpy/pydevd attached to this process. Call it at
    the top of a source node's ``renderObject``; ``node_name`` prefixes the
    one warning a failed registration emits.
    """
    pydevd = sys.modules.get('pydevd')
    if pydevd is None:
        return
    ident = threading.get_ident()
    if ident in _DEBUGGER_THREADS:
        return
    _DEBUGGER_THREADS.add(ident)
    try:
        pydevd.settrace(suspend=False)
    except Exception as e:
        from rocketlib import warning

        warning(f'{node_name}: pydevd thread registration failed (continuing untraced): {e}')
