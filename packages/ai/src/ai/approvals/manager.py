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

"""Thread-safe orchestrator for human-in-the-loop approval requests.

The manager coordinates three concerns:
  1. Lifecycle: create -> wait -> resolve (approve/reject) or time out.
  2. Storage: delegated to an ``ApprovalStore``.
  3. Cross-thread signalling: a ``threading.Event`` per request lets the
     pipeline thread block in ``writeAnswers`` while a REST request on a
     different thread calls ``approve`` / ``reject``.

The blocking gate is the central mechanism missing from PR #542 — without it,
the approval node emitted a ``status: pending`` payload that downstream nodes
ignored, defeating the point of the approval.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from .models import (
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    TimeoutAction,
)
from .store import ApprovalStore, InMemoryStore


class ApprovalManagerError(Exception):
    """Base class for ApprovalManager-specific errors."""


class PendingCapacityError(ApprovalManagerError):
    """Raised when accepting another pending request would exceed the cap."""


class _PendingEntry:
    """Internal coupling of an event signal to a request id.

    Kept private because callers should never see the event directly.
    """

    __slots__ = ('event', 'approval_id')

    def __init__(self, approval_id: str) -> None:
        """Bind a fresh threading.Event to ``approval_id``."""
        self.event = threading.Event()
        self.approval_id = approval_id


class ApprovalManager:
    """Process-wide registry of approval requests with blocking wait semantics.

    Typical flow from a node:

        decision = manager.create_and_wait(payload, timeout=300)
        if decision.approved:
            self.instance.writeAnswers(...)
        elif decision.rejected:
            ...  # do not emit downstream

    Typical flow from REST:

        manager.approve(approval_id, modified_payload=..., decided_by=...)
        manager.reject(approval_id, reason=..., decided_by=...)
    """

    def __init__(
        self,
        *,
        store: Optional[ApprovalStore] = None,
        pending_cap: int = 1000,
        default_timeout: float = 300.0,
        default_timeout_action: TimeoutAction = TimeoutAction.REJECT,
    ) -> None:
        """Configure the manager.

        Args:
            store: persistence backend; defaults to a fresh InMemoryStore.
            pending_cap: maximum number of simultaneously pending requests.
                ``create_and_wait`` raises PendingCapacityError above the cap.
            default_timeout: seconds before a pending request is auto-resolved.
            default_timeout_action: what to do when a wait times out.
        """
        if pending_cap <= 0:
            raise ValueError(f'pending_cap must be positive; got {pending_cap}')
        if default_timeout <= 0:
            raise ValueError(f'default_timeout must be positive; got {default_timeout}')
        # parse() raises on invalid values, surfacing misconfig instead of silently falling back.
        default_timeout_action = TimeoutAction.parse(default_timeout_action)

        self._store = store or InMemoryStore()
        self._pending_cap = pending_cap
        self._default_timeout = default_timeout
        self._default_timeout_action = default_timeout_action

        self._lock = threading.Lock()
        self._pending: Dict[str, _PendingEntry] = {}

    @property
    def pending_count(self) -> int:
        """Number of requests currently awaiting a decision."""
        with self._lock:
            return len(self._pending)

    @property
    def store(self) -> ApprovalStore:
        """Underlying persistence backend (read-only)."""
        return self._store

    def create(
        self,
        payload: Dict[str, Any],
        *,
        pipeline_id: Optional[str] = None,
        node_id: Optional[str] = None,
        timeout: Optional[float] = None,
        profile: str = 'auto',
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ApprovalRequest:
        """Register a new pending approval request.

        Returns the stored ``ApprovalRequest`` (deep-copied — safe to mutate).
        Raises PendingCapacityError if the pending cap is exceeded.
        """
        if not isinstance(payload, dict):
            raise TypeError(f'payload must be a dict; got {type(payload).__name__}')

        timeout = float(timeout) if timeout is not None else self._default_timeout
        if timeout <= 0:
            raise ValueError(f'timeout must be positive; got {timeout}')

        approval_id = str(uuid.uuid4())
        now = time.monotonic()

        request = ApprovalRequest(
            approval_id=approval_id,
            pipeline_id=pipeline_id,
            node_id=node_id,
            payload=payload,
            status=ApprovalStatus.PENDING,
            created_at=now,
            deadline_at=now + timeout,
            profile=profile,
            metadata=dict(metadata) if metadata else {},
        )

        with self._lock:
            if len(self._pending) >= self._pending_cap:
                raise PendingCapacityError(f'cannot accept more than {self._pending_cap} pending approvals; tighten timeout, increase pending_cap, or wait for resolution')
            self._pending[approval_id] = _PendingEntry(approval_id)
            self._store.put(request)

        return self._store.get(approval_id)  # deep copy from store

    def wait(
        self,
        approval_id: str,
        *,
        timeout: Optional[float] = None,
        timeout_action: Optional[TimeoutAction] = None,
    ) -> ApprovalDecision:
        """Block until ``approval_id`` is resolved or the timeout elapses.

        Args:
            approval_id: the id returned by create().
            timeout: seconds to wait. If None, derived from request.deadline_at.
            timeout_action: how to synthesize a decision on timeout. If None,
                the manager's default is used. ``ERROR`` raises TimeoutError.

        Returns:
            ApprovalDecision describing the final state.
        """
        with self._lock:
            entry = self._pending.get(approval_id)
            stored = self._store.get(approval_id)

        if stored is None:
            raise KeyError(f'unknown approval_id {approval_id!r}')

        if stored.status != ApprovalStatus.PENDING:
            return self._decision_from_request(stored)

        if entry is None:
            # Stored as pending but no event registered (e.g., loaded from
            # persistent store on boot). Treat as timed-out so callers don't
            # block forever; PR B will replace this with replay-on-boot.
            return self._apply_timeout(stored, timeout_action or self._default_timeout_action)

        wait_seconds = self._compute_wait_seconds(stored, timeout)
        signalled = entry.event.wait(timeout=wait_seconds)

        if signalled:
            resolved = self._store.get(approval_id)
            return self._decision_from_request(resolved)

        # Timeout path
        return self._apply_timeout(stored, timeout_action or self._default_timeout_action)

    def create_and_wait(
        self,
        payload: Dict[str, Any],
        *,
        pipeline_id: Optional[str] = None,
        node_id: Optional[str] = None,
        timeout: Optional[float] = None,
        timeout_action: Optional[TimeoutAction] = None,
        profile: str = 'auto',
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ApprovalDecision:
        """Create a request and block until decided. Convenience over create + wait."""
        request = self.create(
            payload,
            pipeline_id=pipeline_id,
            node_id=node_id,
            timeout=timeout,
            profile=profile,
            metadata=metadata,
        )
        return self.wait(
            request.approval_id,
            timeout=timeout,
            timeout_action=timeout_action,
        )

    def approve(
        self,
        approval_id: str,
        *,
        modified_payload: Optional[Dict[str, Any]] = None,
        decided_by: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> ApprovalRequest:
        """Approve a pending request and unblock any waiter."""
        return self._resolve(
            approval_id,
            ApprovalStatus.APPROVED,
            modified_payload=modified_payload,
            decided_by=decided_by,
            reason=reason,
        )

    def reject(
        self,
        approval_id: str,
        *,
        decided_by: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> ApprovalRequest:
        """Reject a pending request and unblock any waiter."""
        return self._resolve(
            approval_id,
            ApprovalStatus.REJECTED,
            decided_by=decided_by,
            reason=reason,
        )

    def get_request(self, approval_id: str) -> Optional[ApprovalRequest]:
        """Return a deep copy of the stored request, or None.

        Always returns an isolated copy — mutating it never affects manager state.
        """
        return self._store.get(approval_id)

    def list_requests(self, status: Optional[ApprovalStatus] = None) -> List[ApprovalRequest]:
        """Return deep-copied requests, optionally filtered by status."""
        return self._store.list(status)

    def discard_resolved(self, approval_id: str) -> bool:
        """Permanently delete a resolved request from the store.

        Used by callers that want explicit cleanup; PR B will add an automatic
        TTL sweeper that calls this on resolved requests past their TTL.
        """
        request = self._store.get(approval_id)
        if request is None:
            return False
        if request.status == ApprovalStatus.PENDING:
            raise ApprovalManagerError(f'cannot discard pending approval {approval_id!r}; resolve it first')
        return self._store.delete(approval_id)

    def _resolve(
        self,
        approval_id: str,
        new_status: ApprovalStatus,
        *,
        modified_payload: Optional[Dict[str, Any]] = None,
        decided_by: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> ApprovalRequest:
        with self._lock:
            entry = self._pending.pop(approval_id, None)
            stored = self._store.get(approval_id)

            if stored is None:
                raise KeyError(f'unknown approval_id {approval_id!r}')

            if stored.status != ApprovalStatus.PENDING:
                # Already resolved (e.g., timed-out then a late approval comes in).
                # Don't overwrite — first decision wins.
                raise ApprovalManagerError(f'approval {approval_id!r} is already {stored.status.value}; cannot transition to {new_status.value}')

            stored.status = new_status
            stored.decided_at = time.monotonic()
            stored.decided_by = decided_by
            stored.decision_reason = reason
            if new_status == ApprovalStatus.APPROVED and modified_payload is not None:
                if not isinstance(modified_payload, dict):
                    raise TypeError(f'modified_payload must be a dict; got {type(modified_payload).__name__}')
                stored.modified_payload = modified_payload
            self._store.put(stored)

        if entry is not None:
            entry.event.set()
        return self._store.get(approval_id)

    def _apply_timeout(self, stored: ApprovalRequest, timeout_action: TimeoutAction) -> ApprovalDecision:
        """Synthesize a decision from a timeout policy and persist it."""
        timeout_action = TimeoutAction.parse(timeout_action)

        if timeout_action == TimeoutAction.ERROR:
            # Mark as timed-out then surface to the caller.
            self._mark_timed_out(stored)
            raise TimeoutError(f'approval {stored.approval_id!r} timed out before a decision was made')

        with self._lock:
            entry = self._pending.pop(stored.approval_id, None)
            current = self._store.get(stored.approval_id)
            if current is None:
                # Was discarded — synthesize an ephemeral decision.
                return ApprovalDecision(
                    status=ApprovalStatus.TIMED_OUT,
                    payload=stored.payload,
                    reason='request not found in store',
                )
            if current.status == ApprovalStatus.PENDING:
                current.status = ApprovalStatus.TIMED_OUT
                current.decided_at = time.monotonic()
                current.decision_reason = f'auto-{timeout_action.value} on timeout'
                self._store.put(current)
            stored = current

        if entry is not None:
            entry.event.set()

        # Map timeout policy to a downstream-actionable status.
        if timeout_action == TimeoutAction.APPROVE:
            decision_status = ApprovalStatus.APPROVED
        else:
            decision_status = ApprovalStatus.REJECTED

        return ApprovalDecision(
            status=decision_status,
            payload=stored.modified_payload or stored.payload,
            reason=f'auto-{timeout_action.value} on timeout',
            decided_by='timeout-policy',
        )

    def _mark_timed_out(self, stored: ApprovalRequest) -> None:
        """Persist a timed-out status and signal any waiter."""
        with self._lock:
            entry = self._pending.pop(stored.approval_id, None)
            current = self._store.get(stored.approval_id)
            if current is not None and current.status == ApprovalStatus.PENDING:
                current.status = ApprovalStatus.TIMED_OUT
                current.decided_at = time.monotonic()
                current.decision_reason = 'timeout with action=error'
                self._store.put(current)
        if entry is not None:
            entry.event.set()

    @staticmethod
    def _decision_from_request(request: ApprovalRequest) -> ApprovalDecision:
        """Build an ``ApprovalDecision`` from a resolved ``ApprovalRequest``."""
        payload = request.modified_payload or request.payload
        return ApprovalDecision(
            status=request.status,
            payload=payload,
            reason=request.decision_reason,
            decided_by=request.decided_by,
        )

    @staticmethod
    def _compute_wait_seconds(request: ApprovalRequest, override: Optional[float]) -> Optional[float]:
        """Resolve the wait deadline from an explicit override or the stored deadline.

        ``None`` means "wait indefinitely", matching threading.Event.wait semantics.
        Negative or zero values are clamped to a tiny non-zero value so the wait
        returns immediately rather than blocking forever.
        """
        if override is not None:
            return max(0.0, float(override))
        if request.deadline_at is None:
            return None
        remaining = request.deadline_at - time.monotonic()
        return max(0.0, remaining)
