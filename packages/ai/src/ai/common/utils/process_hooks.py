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
Process-wide hooks a node needs but may not reach for itself.

The node contract (plan 4.3) keeps node code away from ``sys.modules`` of
another package and from module state written per call: both are shared by
every control in the engine. These two hooks are process facts, not control
state, so they live here, once, and nodes call them.
"""

from __future__ import annotations

import sys
import threading
import types

from rocketlib import warning

# ==== matplotlib =============================================================


def stub_matplotlib_pyplot() -> None:
    """
    Stub ``matplotlib.pyplot`` before importing a library that drags it in.

    MediaPipe (``drawing_utils``) and supervision (pulled by rfdetr) import
    ``matplotlib.pyplot`` at module load. matplotlib >= 3.10 ships ft2font as a
    pybind11 extension whose attribute probe aborts the embedded engine
    (SIGABRT, "module 'matplotlib.ft2font' has no attribute '__path__'"), a C++
    terminate no ``except`` can catch. pyplot is only used by plotting helpers
    nobody calls, so an empty module stands in for it. Idempotent: a real or
    stub pyplot already loaded is left alone.
    """
    sys.modules.setdefault('matplotlib.pyplot', types.ModuleType('matplotlib.pyplot'))


# ==== debugger ===============================================================

#: Per-thread mark: set once the thread has registered with a loaded debugger.
#: It lives and dies with its thread, so a later thread that reuses an exited
#: thread's ident still registers. A failed registration is marked too, so a
#: broken debugger produces one warning per thread instead of one per call.
_DEBUGGER_REGISTERED = threading.local()


def register_debugger_thread() -> None:
    """
    Register an engine-spawned thread with pydevd before traced code runs.

    The designer launches dev-mode tasks under debugpy, and some node calls run
    on the engine's C++ ThreadedQueue threads, which pydevd never saw created.
    When line instrumentation fires on such an unregistered foreign thread,
    pydevd livelocks on its internal lock and the call wedges. Registering
    through the official ``settrace`` API happens outside the instrumentation
    callback, making the thread known to the debugger first.

    No-op when no debugger is loaded (task mode): ``pydevd`` is only in
    ``sys.modules`` when debugpy/pydevd attached to this process.
    """
    # Step 1: nothing to do unless a debugger is attached.
    pydevd = sys.modules.get('pydevd')
    if pydevd is None:
        return

    # Step 2: once per thread, for the life of that thread.
    if getattr(_DEBUGGER_REGISTERED, 'done', False):
        return
    _DEBUGGER_REGISTERED.done = True

    # Step 3: register; a failure is reported once and the call runs untraced.
    try:
        pydevd.settrace(suspend=False)
    except Exception as e:
        warning(f'pydevd thread registration failed (continuing untraced): {e}')
