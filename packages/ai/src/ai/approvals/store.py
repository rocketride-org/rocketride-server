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

"""Persistence backends for approval requests.

The abstract ``ApprovalStore`` decouples the manager from a particular backend.
PR A ships only the in-memory store; a SQLite-backed store will follow in PR B
to satisfy the compliance / restart-survivability requirements in issue #635.
"""

from __future__ import annotations

import abc
import copy
import threading
from typing import Dict, List, Optional

from .models import ApprovalRequest, ApprovalStatus


class ApprovalStore(abc.ABC):
    """Abstract persistence backend for ``ApprovalRequest``."""

    @abc.abstractmethod
    def put(self, request: ApprovalRequest) -> None:
        """Insert or replace a request."""

    @abc.abstractmethod
    def get(self, approval_id: str) -> Optional[ApprovalRequest]:
        """Retrieve a request by id, or None if absent."""

    @abc.abstractmethod
    def delete(self, approval_id: str) -> bool:
        """Remove a request by id. Returns True if it existed."""

    @abc.abstractmethod
    def list(self, status: Optional[ApprovalStatus] = None) -> List[ApprovalRequest]:
        """Return all requests, optionally filtered by status."""


class InMemoryStore(ApprovalStore):
    """Thread-safe in-memory implementation.

    Lost on process restart. Suitable for development and the auto profile;
    SQLite-backed store will be added in PR B for production use.
    """

    def __init__(self) -> None:
        """Initialize an empty store."""
        self._lock = threading.Lock()
        self._items: Dict[str, ApprovalRequest] = {}

    def put(self, request: ApprovalRequest) -> None:
        """Insert or replace ``request``. Stored copy is independent of caller's reference."""
        with self._lock:
            self._items[request.approval_id] = copy.deepcopy(request)

    def get(self, approval_id: str) -> Optional[ApprovalRequest]:
        """Return a deep copy of the stored request, or None.

        Deep-copying on read prevents callers from mutating internal state — a
        bug PR #542 reviewers flagged in the original ApprovalManager.
        """
        with self._lock:
            request = self._items.get(approval_id)
            return copy.deepcopy(request) if request is not None else None

    def delete(self, approval_id: str) -> bool:
        """Remove and return whether a record existed."""
        with self._lock:
            return self._items.pop(approval_id, None) is not None

    def list(self, status: Optional[ApprovalStatus] = None) -> List[ApprovalRequest]:
        """Return a list of deep-copied requests, optionally filtered by status."""
        with self._lock:
            items = list(self._items.values())
        if status is not None:
            items = [r for r in items if r.status == status]
        return [copy.deepcopy(r) for r in items]
