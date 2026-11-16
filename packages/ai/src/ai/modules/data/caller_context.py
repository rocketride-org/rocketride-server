# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The caller of the binding a worker thread is about to open (plan 8.3, P9).

The engine's credit gate runs INSIDE ``getPipe`` on the thread that takes the
pipe, before the data path can stamp the caller on it. The data path names the
caller for its thread here first; the gate reads it and asks EaaS about that
caller's paying unit, not the engine starter's. One tiny module, imported by
both sides, so neither imports the other.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Optional

_pending = threading.local()


def set_pending_caller(caller: Optional[Dict[str, Any]]) -> None:
    """
    Name the caller of the binding the calling thread is about to open.

    Args:
        caller: The server-set ``_caller`` (``userId``, ``orgId``, ``address``,
            ``rung``), or None once the pipe is taken.
    """
    _pending.caller = caller


def pending_caller() -> Optional[Dict[str, Any]]:
    """
    The caller named for this thread's next ``getPipe``, if any.

    Returns:
        The caller dict, or None for a binding the engine opens itself (a scan
        source, a listener).
    """
    return getattr(_pending, 'caller', None)
