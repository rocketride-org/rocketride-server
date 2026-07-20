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
# CMD DEPLOY — DAP router for the rrext_deploy command
#
# Handles server-side pipeline deployment lifecycle via a single ``rrext_deploy``
# command that dispatches on ``arguments.subcommand`` (add, remove, list,
# status, update) — mirroring the rrext_store / rrext_account_* pattern.
# Deployments are persisted via DeploymentStore and executed autonomously by
# the server (on-demand or cron-scheduled).
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
    """
    DAP router for the ``rrext_deploy`` command.

    Provides ``on_rrext_deploy`` which dispatches on ``arguments.subcommand``
    (``add``, ``remove``, ``list``, ``status``, ``update``) to the matching
    ``_deploy_*`` handler — the same subcommand shape as ``rrext_store``.
    Unlike ``rrext_store``, permissions differ per subcommand (``task.control``
    for mutations, ``task.monitor`` for reads), so each handler verifies its own
    permission rather than the dispatcher hoisting a single check.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the deploy subcommand handler lookup table."""
        # Map of deploy subcommand names to handler methods. All other state
        # (account info, server, transport) lives on TaskConn via the other
        # mixins, so nothing else is set up here.
        self._deploy_subcommand_handlers = {
            'add': self._deploy_add,
            'remove': self._deploy_remove,
            'list': self._deploy_list,
            'status': self._deploy_status,
            'update': self._deploy_update,
        }

    @property
    def _scheduler(self) -> 'TaskScheduler':
        """The deployment scheduler, created and stored in server state at module init."""
        return self._server._server.app.state.scheduler

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_deploy(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the DAP ``rrext_deploy`` command — unified deployment lifecycle.

        Extracts ``arguments.subcommand`` and routes to the matching
        ``_deploy_*`` handler. Permission checks live in each handler because
        they differ per subcommand.

        Args:
            request: DAP request with ``arguments.subcommand`` and
                subcommand-specific arguments.

        Returns:
            DAP response (shape depends on the subcommand).
        """
        try:
            # Extract the subcommand selector.
            args = request.get('arguments') or {}
            subcommand = args.get('subcommand')

            if not subcommand:
                raise ValueError('Subcommand is required')

            # Dispatch to the appropriate handler, passing the pre-extracted args.
            if handler := self._deploy_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Deploy operation failed: {str(e)}')
            raise

    # =========================================================================
    # SUBCOMMAND HANDLERS
    # =========================================================================

    # ── add ──────────────────────────────────────────────────────────────────

    async def _deploy_add(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Accept a pipeline definition, persist it as a deployment, and activate it."""
        if not self._account_info.userToken:
            raise ValueError('Cannot deploy: no user token available for scheduled runs')

        self.verify_permission('task.control')

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

    # ── remove ───────────────────────────────────────────────────────────────

    async def _deploy_remove(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Undeploy and remove a pipeline from the server."""
        self.verify_permission('task.control')

        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        await self._server.deployments.delete(self._account_info.userId, project_id)
        self._scheduler.unschedule(project_id)
        return self.build_response(request, body={})

    # ── list ─────────────────────────────────────────────────────────────────

    async def _deploy_list(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Return all deployments for the caller with their status and schedule config."""
        self.verify_permission('task.monitor')

        records = await self._server.deployments.list(self._account_info.userId)
        return self.build_response(
            request,
            body={
                'deployments': [r.to_client_record() for r in records],
            },
        )

    # ── status ───────────────────────────────────────────────────────────────

    async def _deploy_status(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Get detailed status of a specific deployment."""
        self.verify_permission('task.monitor')

        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        record = await self._server.deployments.get(self._account_info.userId, project_id)
        return self.build_response(request, body=record.to_client_record())

    # ── update ───────────────────────────────────────────────────────────────

    async def _deploy_update(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Modify schedule or pipeline config for an existing deployment."""
        if not self._account_info.userToken:
            raise ValueError('Cannot deploy: no user token available for scheduled runs')

        self.verify_permission('task.control')

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
