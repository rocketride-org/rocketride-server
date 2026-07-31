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

# =============================================================================
# DEPLOY EVENTS — the ONE builder of the apaevt_deploy invalidation event
# =============================================================================
"""The single sender of ``apaevt_deploy`` deployment-change events.

Every deployment mutation (DAP handlers in cmd_deploy AND the scheduler's
dispatch bookkeeping) pushes the SAME org-scoped invalidation event through
this helper. Clients treat the body as CACHE INVALIDATION, never as data:
it carries only the identity of what changed, and receivers re-fetch the
record — this is what replaces the deploy surfaces' polling. One builder
exists so the body can never drift between the two producers.
"""

from typing import Any

from rocketlib import error


async def broadcast_deploy_changed(server: Any, org_id: str, team_id: str, project_id: str, action: str) -> None:
    """Push the org-scoped ``apaevt_deploy`` invalidation event.

    Best-effort by contract: a failed broadcast must never fail the
    mutation or the scheduler's bookkeeping — the failure is logged and
    swallowed.

    Args:
        server: The DAP server (``broadcast_server_event`` provider).
        org_id: The org whose connections receive the event (the scope).
        team_id: The mutated deployment's team ('' for registry-only
            actions such as publish).
        project_id: The mutated deployment's project.
        action: What changed ('publish', 'deploy', 'run', 'errored',
            a state name, ...) — advisory; receivers re-fetch either way.
    """
    try:
        # Local import: rocketride is the client SDK package — imported
        # lazily so module import never depends on it.
        from rocketride import EVENT_TYPE

        await server.broadcast_server_event(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_deploy',
                'body': {'orgId': org_id, 'teamId': team_id, 'projectId': project_id, 'action': action},
            },
            org_id=org_id,
        )
    except Exception as e:
        error(f'[DEPLOY] {team_id}/{project_id}: deploy-change broadcast failed: {e}')
