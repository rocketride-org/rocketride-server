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

# ------------------------------------------------------------------------------
# ApprovalManager — thread-safe in-memory approval request tracker.
#
# Production deployments would back this with Redis or a database; the
# in-memory dict + threading.Lock is sufficient for single-process pipelines.
# ------------------------------------------------------------------------------

import threading
import time
import uuid
from typing import Any, Dict, List, Optional


# Hard cap on pending requests to prevent unbounded memory growth
MAX_PENDING_REQUESTS = 10_000


class ApprovalManager:
    """Manage human-in-the-loop approval requests.

    Each request transitions through: pending -> approved | rejected | timeout.
    All public methods are thread-safe.
    """

    def __init__(self, timeout_seconds: int = 3600, timeout_action: str = 'approve') -> None:
        """Initialise the approval manager.

        Args:
            timeout_seconds: Seconds before a pending request times out.
            timeout_action: Action on timeout -- 'approve' or 'reject'.
        """
        self._requests: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._timeout_seconds = timeout_seconds
        self._timeout_action = timeout_action  # 'approve' or 'reject'
        self._pending_count: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def request_approval(self, item_id: str, content: Any, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Create a new pending approval request.

        Args:
            item_id: Unique identifier for the pipeline item.
            content: The content to be reviewed (preview stored as str).
            metadata: Arbitrary metadata attached to the request.

        Returns:
            The newly created approval request dict.

        Raises:
            ValueError: If *item_id* is empty or the pending limit is reached.
        """
        if not item_id:
            raise ValueError('item_id must be a non-empty string')

        approval_id = str(uuid.uuid4())
        content_preview = str(content)[:500] if content is not None else ''

        request: Dict[str, Any] = {
            'approval_id': approval_id,
            'item_id': item_id,
            'content_preview': content_preview,
            'metadata': metadata or {},
            'status': 'pending',
            'created_at': time.monotonic(),
            'timeout_seconds': self._timeout_seconds,
            'timeout_action': self._timeout_action,
            'reviewer': None,
            'review_comment': None,
            'reviewed_at': None,
        }

        with self._lock:
            if self._pending_count >= MAX_PENDING_REQUESTS:
                raise ValueError(f'Maximum pending requests ({MAX_PENDING_REQUESTS}) reached')
            self._requests[approval_id] = request
            self._pending_count += 1

        return request

    def check_status(self, approval_id: str) -> str:
        """Return the current status of an approval request.

        Automatically resolves timed-out requests before returning.

        Returns:
            One of 'pending', 'approved', 'rejected', 'timeout'.

        Raises:
            KeyError: If *approval_id* is not found.
        """
        with self._lock:
            if approval_id not in self._requests:
                raise KeyError(f'Approval request {approval_id} not found')
            self._check_timeout(approval_id)
            return self._requests[approval_id]['status']

    def approve(self, approval_id: str, reviewer: str, comment: Optional[str] = None) -> Dict[str, Any]:
        """Mark a request as approved.

        Args:
            approval_id: The approval request identifier.
            reviewer: Identity of the reviewer.
            comment: Optional reviewer comment.

        Returns:
            The updated approval request dict.

        Raises:
            KeyError: If *approval_id* is not found.
            ValueError: If the request is not in 'pending' status.
        """
        with self._lock:
            request = self._get_request(approval_id)
            self._check_timeout(approval_id)
            if request['status'] != 'pending':
                raise ValueError(f'Cannot approve request in status: {request["status"]}')
            request['status'] = 'approved'
            request['reviewer'] = reviewer
            request['review_comment'] = comment
            request['reviewed_at'] = time.monotonic()
            self._pending_count -= 1
            return dict(request)

    def reject(self, approval_id: str, reviewer: str, reason: Optional[str] = None) -> Dict[str, Any]:
        """Mark a request as rejected.

        Args:
            approval_id: The approval request identifier.
            reviewer: Identity of the reviewer.
            reason: Optional rejection reason.

        Returns:
            The updated approval request dict.

        Raises:
            KeyError: If *approval_id* is not found.
            ValueError: If the request is not in 'pending' status.
        """
        with self._lock:
            request = self._get_request(approval_id)
            self._check_timeout(approval_id)
            if request['status'] != 'pending':
                raise ValueError(f'Cannot reject request in status: {request["status"]}')
            request['status'] = 'rejected'
            request['reviewer'] = reviewer
            request['review_comment'] = reason
            request['reviewed_at'] = time.monotonic()
            self._pending_count -= 1
            return dict(request)

    def list_pending(self) -> List[Dict[str, Any]]:
        """Return all requests still in 'pending' status.

        Timeout checks are applied lazily so results are accurate.
        """
        with self._lock:
            # Check timeouts first so stale entries are resolved
            for aid in list(self._requests):
                self._check_timeout(aid)
            return [dict(r) for r in self._requests.values() if r['status'] == 'pending']

    def get_request(self, approval_id: str) -> Dict[str, Any]:
        """Return a copy of the full request dict (thread-safe public accessor)."""
        with self._lock:
            return dict(self._get_request(approval_id))

    # ------------------------------------------------------------------
    # Internal helpers (must be called while holding self._lock)
    # ------------------------------------------------------------------

    def _get_request(self, approval_id: str) -> Dict[str, Any]:
        """Retrieve a request or raise KeyError."""
        if approval_id not in self._requests:
            raise KeyError(f'Approval request {approval_id} not found')
        return self._requests[approval_id]

    def _check_timeout(self, approval_id: str) -> None:
        """Transition a pending request to 'timeout' if its deadline has passed.

        Uses ``time.monotonic()`` so the clock is immune to wall-clock adjustments.
        """
        request = self._requests.get(approval_id)
        if request is None or request['status'] != 'pending':
            return

        elapsed = time.monotonic() - request['created_at']
        if elapsed >= request['timeout_seconds']:
            if request['timeout_action'] == 'approve':
                request['status'] = 'approved'
            else:
                request['status'] = 'rejected'
            request['reviewer'] = '__timeout__'
            request['review_comment'] = f'Auto-{request["status"]} after {request["timeout_seconds"]}s timeout'
            request['reviewed_at'] = time.monotonic()
            self._pending_count -= 1
