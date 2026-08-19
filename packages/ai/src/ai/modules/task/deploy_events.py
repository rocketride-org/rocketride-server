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
# DEPLOY EVENTS — the ONE builder of each deploy-rail event body
# =============================================================================
"""The single sender of the deploy rail's server events.

Two event names ride the org-scoped ``EVENT_TYPE.DEPLOY`` subscription, with
OPPOSITE contracts — which is exactly why they are separate names (receivers
filter on ``event``, so neither can be mistaken for the other):

- ``apaevt_deploy`` — CACHE INVALIDATION, never data. Every deployment
  mutation (DAP handlers in cmd_deploy, the scheduler's dispatch
  bookkeeping, the app build worker's status transitions) pushes the same
  body: only the identity of what changed; receivers re-fetch the record.
  This is what replaces the deploy surfaces' polling.
- ``apaevt_build`` — PROGRESS DATA: batched lines of the app build worker's
  toolchain output (pnpm/tsc/rsbuild), the live compile feed for the org
  that owns the app. Inherently payload-carrying — the deliberate exception
  to the invalidation-only rule, quarantined under its own name so
  invalidation listeners never storm on it.
- ``apaevt_build_status`` — the CARD TICKER: one short display word per
  build-lifecycle transition ('uploaded', 'preparing', 'installing',
  'checking', 'building', 'publishing', 'failed', 'queued'), with '' as the
  terminal clear on success. Scoped org/appId/version so a version card can
  bind it directly, no re-fetch. Coarse by design — the line feed above is
  the detail channel.

One builder per body exists so no shape can drift between producers.

Review-state transitions (submit/withdraw/approve/reject) additionally push
the typed ``app:statusChanged`` shell event DIRECTLY to the connections that
care (the owning org + cross-org reviewers) via
:func:`broadcast_review_state` — see its docstring for why the org-scoped
subscription above cannot serve the reviewer audience.
"""

from typing import Any, Dict, List, Optional

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


async def broadcast_review_state(
    server: Any, org_id: str, app_id: str, version: Optional[int], state: str, notes: str = ''
) -> None:
    """Push BOTH signals of one review-state transition.

    A review transition (submit/withdraw/approve/reject/failed flip — and
    the review thread's 'reply' liveness ping, which rides the same walk
    because its audience is identical) has two audiences with different
    reach, served by two existing wire contracts:

    - ``apaevt_deploy`` (org-scoped, via :func:`broadcast_deploy_changed`):
      cache invalidation for the OWNING org's deploy surfaces — version
      rails re-fetch and render the new state.
    - ``app:statusChanged`` (direct, targeted): the typed shell event for
      the review loop's humans. Sent to every connection of the owning org
      (developer badges + the verdict toast) AND every connection holding
      the sys.app/sys.admin reviewer permission in ANY org (the admin
      queue's live badge). Reviewers are cross-org by design, so the
      org-scoped subscription above can never reach them — hence the
      direct send, mirroring push_org_update's connection walk.

    Best-effort by contract, like every deploy event: a failed push must
    never fail the state transition that triggered it.

    Args:
        server: The DAP server (connection registry + broadcast provider).
        org_id: The org OWNING the app (the deployment's home org).
        app_id: The app whose version transitioned.
        version: The registry version that transitioned; None for
            subject-level thread pings (a versionless reply) — omitted from
            the body (the typed map's ``version`` is optional).
        state: The new review state
            ('submit'|'private'|'ready'|'rejected'|'failed'), or 'reply'
            for a thread liveness ping (consumers toast only on explicit
            'ready'/'rejected' and re-fetch on everything else).
        notes: Reviewer notes riding a rejection ('' = none).
    """
    # ── Rail invalidation: the owning org's deploy surfaces re-fetch ──────
    await broadcast_deploy_changed(server, org_id, '', app_id, state)

    # ── Typed status push: owning org + cross-org reviewers ──────────────
    body: Dict[str, Any] = {'appId': app_id, 'status': state}
    if version is not None:
        body['version'] = version
    if notes:
        body['notes'] = notes
    for conn in list(getattr(server, '_connections', {}).values()):
        info = getattr(conn, '_account_info', None)
        if not info:
            continue
        # Task-scoped sockets (pk_/tk_) carry the launching user's identity
        # but never receive user-facing pushes (mirrors push_org_update).
        if (getattr(info, 'auth', '') or '').startswith(('pk_', 'tk_')):
            continue
        org = getattr(info, 'organization', None)
        conn_org = (org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')) if org else ''
        perms = getattr(info, 'sysPermissions', None) or []
        if conn_org != org_id and 'sys.app' not in perms and 'sys.admin' not in perms:
            continue
        try:
            await conn.send_event('app:statusChanged', body=body)
        except Exception as e:
            error(f'[DEPLOY] {app_id} v{version}: status push failed: {e}')


async def broadcast_build_output(
    server: Any, org_id: str, app_id: str, version: int, phase: str, lines: List[str]
) -> None:
    """Push one org-scoped ``apaevt_build`` batch of build-output lines.

    The app build worker's live compile feed: batched (the worker throttles;
    this helper never rate-limits) pnpm/tsc/rsbuild output for the org that
    owns the app. Progress DATA by contract — the deliberate exception to
    the invalidation-only rule, under its own event name so ``apaevt_deploy``
    listeners never see it. Best-effort like every deploy event: a failed
    broadcast must never fail the build.

    Args:
        server: The DAP server (``broadcast_server_event`` provider).
        org_id: The app's owning org — the event's audience.
        app_id: The building app.
        version: The building registry version.
        phase: The build phase the lines came from
            ('bootstrap'|'install'|'typecheck'|'bundle').
        lines: The output lines of this batch, oldest first.
    """
    try:
        # Local import: rocketride is the client SDK package — imported
        # lazily so module import never depends on it.
        from rocketride import EVENT_TYPE

        await server.broadcast_server_event(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_build',
                'body': {'orgId': org_id, 'appId': app_id, 'version': version, 'phase': phase, 'lines': list(lines)},
            },
            org_id=org_id,
        )
    except Exception as e:
        error(f'[DEPLOY] {app_id} v{version}: build-output broadcast failed: {e}')


async def broadcast_build_status(server: Any, org_id: str, app_id: str, version: int, status: str) -> None:
    """Push one org-scoped ``apaevt_build_status`` card-ticker word.

    One short DISPLAY word per build-lifecycle transition — the version
    card renders it verbatim; ``''`` clears it (the success terminal).
    Best-effort like every deploy event: a failed broadcast must never
    fail the receipt or the build.

    Args:
        server: The DAP server (``broadcast_server_event`` provider).
        org_id: The app's owning org — the event's audience.
        app_id: The app whose version transitioned.
        version: The registry version the word belongs to.
        status: The display word ('uploaded'|'preparing'|'installing'|
            'checking'|'building'|'publishing'|'failed'|'queued'|'' to clear).
    """
    try:
        # Local import: rocketride is the client SDK package — imported
        # lazily so module import never depends on it.
        from rocketride import EVENT_TYPE

        await server.broadcast_server_event(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_build_status',
                'body': {'orgId': org_id, 'appId': app_id, 'version': version, 'status': status},
            },
            org_id=org_id,
        )
    except Exception as e:
        error(f'[DEPLOY] {app_id} v{version}: build-status broadcast failed: {e}')
