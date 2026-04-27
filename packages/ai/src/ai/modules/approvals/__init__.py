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

"""Approvals Module for RocketRide Web Services.

Exposes REST endpoints used by external reviewers to act on pending approval
requests. Mounted dynamically via ``server.use('approvals')``.

Routes:
    GET    /approvals                    list requests (optional ?status= filter)
    GET    /approvals/{approval_id}      fetch a single request
    POST   /approvals/{approval_id}/approve   { modified_payload?, decided_by?, reason? }
    POST   /approvals/{approval_id}/reject    { decided_by?, reason? }
"""

from typing import TYPE_CHECKING, Any, Dict

from ai.approvals import get_manager, set_manager, ApprovalManager

from .endpoints import build_routes

if TYPE_CHECKING:  # pragma: no cover — type-only import to avoid pulling uvicorn at import time
    from ai.web import WebServer


def initModule(server: 'WebServer', config: Dict[str, Any]) -> None:
    """Register the approvals API on ``server``.

    Optional ``config['manager']`` can supply a pre-configured ApprovalManager;
    by default the process-wide registry instance is used.
    """
    manager: ApprovalManager
    supplied = config.get('manager') if config else None
    if supplied is not None:
        if not isinstance(supplied, ApprovalManager):
            raise TypeError("config['manager'] must be an ApprovalManager")
        set_manager(supplied)
        manager = supplied
    else:
        manager = get_manager()

    for path, handler, methods in build_routes(manager):
        server.add_route(path, handler, methods)
