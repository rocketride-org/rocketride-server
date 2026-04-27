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

"""HTTP route handlers for the approvals module.

The handlers are built as a factory (``build_routes``) so the manager can be
injected — this keeps the handlers fully unit-testable on a bare FastAPI app
without going through ``ai.web``.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException, Query
from pydantic import BaseModel, ConfigDict

from ai.approvals.manager import ApprovalManager, ApprovalManagerError
from ai.approvals.models import ApprovalStatus


class ApproveBody(BaseModel):
    """Request body for POST /approvals/{id}/approve."""

    model_config = ConfigDict(extra='forbid')

    modified_payload: Optional[Dict[str, Any]] = None
    decided_by: Optional[str] = None
    reason: Optional[str] = None


class RejectBody(BaseModel):
    """Request body for POST /approvals/{id}/reject."""

    model_config = ConfigDict(extra='forbid')

    decided_by: Optional[str] = None
    reason: Optional[str] = None


def build_routes(
    manager: ApprovalManager,
) -> List[Tuple[str, Callable, List[str]]]:
    """Return ``[(path, handler, methods)]`` for ``server.add_route``.

    Bound to ``manager`` via closure — each handler reads/writes the same
    instance. The mounting layer is responsible for path uniqueness.
    """

    def list_approvals(status: Optional[str] = Query(default=None)) -> Dict[str, Any]:
        status_filter: Optional[ApprovalStatus] = None
        if status is not None:
            try:
                status_filter = ApprovalStatus(status)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f'invalid status filter {status!r}; allowed: {", ".join(s.value for s in ApprovalStatus)}',
                ) from exc

        items = [r.to_dict() for r in manager.list_requests(status_filter)]
        return {'status': 'OK', 'data': {'approvals': items, 'count': len(items)}}

    def get_approval(approval_id: str) -> Dict[str, Any]:
        request = manager.get_request(approval_id)
        if request is None:
            raise HTTPException(status_code=404, detail=f'approval {approval_id!r} not found')
        return {'status': 'OK', 'data': request.to_dict()}

    def approve(approval_id: str, body: ApproveBody) -> Dict[str, Any]:
        try:
            updated = manager.approve(
                approval_id,
                modified_payload=body.modified_payload,
                decided_by=body.decided_by,
                reason=body.reason,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ApprovalManagerError as exc:
            # Already-resolved transition.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {'status': 'OK', 'data': updated.to_dict()}

    def reject(approval_id: str, body: RejectBody) -> Dict[str, Any]:
        try:
            updated = manager.reject(
                approval_id,
                decided_by=body.decided_by,
                reason=body.reason,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ApprovalManagerError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {'status': 'OK', 'data': updated.to_dict()}

    return [
        ('/approvals', list_approvals, ['GET']),
        ('/approvals/{approval_id}', get_approval, ['GET']),
        ('/approvals/{approval_id}/approve', approve, ['POST']),
        ('/approvals/{approval_id}/reject', reject, ['POST']),
    ]
