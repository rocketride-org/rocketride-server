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
# CMD DEPLOY — DAP router for all rrext_deploy_* commands
#
# Handles server-side pipeline deployment lifecycle: add, remove, list,
# status, and update. Deployments are persisted via DeploymentStore and
# executed autonomously by the server (on-demand or cron-scheduled).
# =============================================================================

import time
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict

from croniter import croniter

from ai.account import DeploymentRecord
from ai.common.dap import DAPConn, TransportBase

if TYPE_CHECKING:
    from ..task_server import TaskServer
    from ..task_scheduler import TaskScheduler


# Cron preset aliases accepted in addition to 5-field expressions.
_CRON_PRESETS = frozenset(
    {
        '@yearly',
        '@annually',
        '@monthly',
        '@weekly',
        '@daily',
        '@midnight',
        '@hourly',
    }
)


def _validate_schedule(schedule: str) -> None:
    """Raise ValueError if schedule is not 'manual', a preset, or a valid 5-field cron expression."""
    if schedule == 'manual' or schedule in _CRON_PRESETS:
        return
    try:
        croniter(schedule, datetime.now())
        return
    except Exception:
        pass
    raise ValueError(
        f'Invalid schedule {schedule!r}. Expected "manual", a cron preset (@hourly etc.), or a 5-field cron expression.'
    )


# =============================================================================
# DEPLOY COMMANDS MIXIN
# =============================================================================


class DeployCommands(DAPConn):
    """DAP router for ``rrext_deploy_*`` commands."""

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """No-op — all state lives on TaskConn via the other mixins."""
        pass

    @property
    def _scheduler(self) -> 'TaskScheduler':
        """The deployment scheduler, created and stored in server state at module init."""
        return self._server._server.app.state.scheduler

    # ── rrext_deploy_add ─────────────────────────────────────────────────────

    async def on_rrext_deploy_add(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Accept a pipeline definition, persist it as a deployment, and activate it."""
        if not self._account_info.userToken:
            raise ValueError('Cannot deploy: no user token available for scheduled runs')

        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        pipeline = args.get('pipeline')
        if not pipeline:
            raise ValueError('pipeline is required')
        if not isinstance(pipeline, dict):
            raise ValueError('pipeline must be an object')

        project_id = pipeline.get('project_id')
        if not project_id:
            raise ValueError('pipeline.project_id is required')

        schedule = args.get('schedule', 'manual')
        _validate_schedule(schedule)

        record = DeploymentRecord(
            pipeline=pipeline,
            schedule=schedule,
            state='active',
            userId=self._account_info.userId,
            userToken=self._account_info.userToken,
            createdAt=time.time(),
            updatedAt=time.time(),
        )
        await self._server.deployments.save(self._account_info.userId, record, mode='create')
        self._scheduler.schedule(record)
        return self.build_response(request, body=record.to_client_record())

    # ── rrext_deploy_remove ──────────────────────────────────────────────────

    async def on_rrext_deploy_remove(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Undeploy and remove a pipeline from the server."""
        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        await self._server.deployments.delete(self._account_info.userId, project_id)
        self._scheduler.unschedule(project_id)
        return self.build_response(request, body={})

    # ── rrext_deploy_list ────────────────────────────────────────────────────

    async def on_rrext_deploy_list(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Return all deployments for the caller with their status and schedule config."""
        self.verify_permission('task.monitor')

        records = await self._server.deployments.list(self._account_info.userId)
        return self.build_response(
            request,
            body={
                'deployments': [r.to_client_record() for r in records],
            },
        )

    # ── rrext_deploy_status ──────────────────────────────────────────────────

    async def on_rrext_deploy_status(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Get detailed status of a specific deployment."""
        self.verify_permission('task.monitor')

        args = request.get('arguments') or {}
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        record = await self._server.deployments.get(self._account_info.userId, project_id)
        return self.build_response(request, body=record.to_client_record())

    # ── rrext_deploy_update ──────────────────────────────────────────────────

    async def on_rrext_deploy_update(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Modify schedule or pipeline config for an existing deployment."""
        if not self._account_info.userToken:
            raise ValueError('Cannot deploy: no user token available for scheduled runs')

        self.verify_permission('task.control')

        args = request.get('arguments') or {}
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        userId = self._account_info.userId
        record = await self._server.deployments.get(userId, project_id)

        if 'pipeline' in args:
            if not isinstance(args['pipeline'], dict):
                raise ValueError('pipeline must be an object')
            new_pipeline = dict(args['pipeline'])
            new_pipeline['project_id'] = project_id
            record.pipeline = new_pipeline
        if 'schedule' in args:
            _validate_schedule(args['schedule'])
            record.schedule = args['schedule']

        record.userId = self._account_info.userId
        record.userToken = self._account_info.userToken
        record.updatedAt = time.time()

        await self._server.deployments.save(userId, record)
        self._scheduler.schedule(record)
        return self.build_response(request, body={})
