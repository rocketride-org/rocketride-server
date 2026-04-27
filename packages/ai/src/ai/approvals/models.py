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

"""Data models for human-in-the-loop approval requests and decisions."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


class ApprovalStatus(str, enum.Enum):
    """Lifecycle states of an approval request."""

    PENDING = 'pending'
    APPROVED = 'approved'
    REJECTED = 'rejected'
    TIMED_OUT = 'timed_out'


class TimeoutAction(str, enum.Enum):
    """What to do when a pending approval times out."""

    APPROVE = 'approve'
    REJECT = 'reject'
    ERROR = 'error'

    @classmethod
    def parse(cls, value: Any) -> TimeoutAction:
        """Coerce a user-supplied value into a valid TimeoutAction.

        Raises ValueError on unknown values; the silent-fallback behavior in
        PR #542 was a known issue called out by reviewers.
        """
        if isinstance(value, cls):
            return value
        if isinstance(value, str):
            try:
                return cls(value.strip().lower())
            except ValueError:
                pass
        allowed = ', '.join(m.value for m in cls)
        raise ValueError(f'timeout_action must be one of {{{allowed}}}; got {value!r}')


@dataclass
class ApprovalRequest:
    """A single approval request awaiting (or having received) a decision.

    Stored by ApprovalManager. Returned via REST. Persisted by ApprovalStore.
    """

    approval_id: str
    pipeline_id: Optional[str]
    node_id: Optional[str]
    payload: Dict[str, Any]
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: float = 0.0
    deadline_at: Optional[float] = None
    decided_at: Optional[float] = None
    decided_by: Optional[str] = None
    decision_reason: Optional[str] = None
    modified_payload: Optional[Dict[str, Any]] = None
    profile: str = 'auto'
    metadata: Dict[str, Any] = field(default_factory=dict)
    # When True, reject() must be called with a non-empty reason. Lets compliance
    # workflows enforce documented justification on every rejection.
    require_reason_on_reject: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for REST responses."""
        return {
            'approval_id': self.approval_id,
            'pipeline_id': self.pipeline_id,
            'node_id': self.node_id,
            'payload': self.payload,
            'status': self.status.value,
            'created_at': self.created_at,
            'deadline_at': self.deadline_at,
            'decided_at': self.decided_at,
            'decided_by': self.decided_by,
            'decision_reason': self.decision_reason,
            'modified_payload': self.modified_payload,
            'profile': self.profile,
            'metadata': self.metadata,
            'require_reason_on_reject': self.require_reason_on_reject,
        }


@dataclass
class ApprovalDecision:
    """Result of waiting for a decision on an approval request.

    ``payload`` is the request as registered (which may have been truncated
    for the reviewer's preview). ``modified_payload`` is set *only* when the
    reviewer explicitly supplied edits — keeping the two separate prevents
    a truncated preview from being mistakenly applied back onto the original
    answer downstream.
    """

    status: ApprovalStatus
    payload: Dict[str, Any]
    reason: Optional[str] = None
    decided_by: Optional[str] = None
    modified_payload: Optional[Dict[str, Any]] = None

    @property
    def was_modified(self) -> bool:
        """True when the reviewer supplied a modified payload."""
        return self.modified_payload is not None

    @property
    def approved(self) -> bool:
        """True when the decision authorizes downstream emission."""
        return self.status == ApprovalStatus.APPROVED

    @property
    def rejected(self) -> bool:
        """True when the decision blocks downstream emission."""
        return self.status == ApprovalStatus.REJECTED

    @property
    def timed_out(self) -> bool:
        """True when the decision was synthesized from a timeout policy."""
        return self.status == ApprovalStatus.TIMED_OUT
