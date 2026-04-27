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

"""Process-wide singleton accessor for ApprovalManager.

The approval node and the REST module need to share a single manager so that
a REST call on one thread can resolve a wait blocked on another. We expose a
small registry rather than a module-level global so tests can swap or reset
the instance cleanly.
"""

from __future__ import annotations

import threading
from typing import Optional

from .manager import ApprovalManager


_lock = threading.Lock()
_manager: Optional[ApprovalManager] = None


def get_manager() -> ApprovalManager:
    """Return the shared ApprovalManager, creating a default on first access."""
    global _manager
    with _lock:
        if _manager is None:
            _manager = ApprovalManager()
        return _manager


def set_manager(manager: ApprovalManager) -> None:
    """Replace the shared ApprovalManager (used by initModule and tests)."""
    global _manager
    with _lock:
        _manager = manager


def reset_manager() -> None:
    """Drop the shared ApprovalManager. Mostly for test isolation."""
    global _manager
    with _lock:
        _manager = None
