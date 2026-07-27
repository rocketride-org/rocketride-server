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
# Teams-as-environments deployment lifecycle over the account module's
# deployments_* interface (OSS: files; SaaS: DB — this layer never knows):
#
#   publish       snapshot the pipeline as immutable org-registry version vN
#   deploy        point a TEAM at a version (promotion and rollback alike)
#   list/get      team deployments (registry-joined)
#   versions      the registry entries for a project (the version strip)
#   history       the immutable audit trail (who/what/when)
#   pause/resume  state flips on a team deployment
#   remove        SOFT remove (history and artifacts retained)
#   schedule_set  per-source cron on a team deployment
#   preview       THE single cron evaluator (validate + next-N occurrences)
#
# Permission model (checked HERE, at the command layer — the account module
# is mechanical): reads need task.monitor on the addressed team; mutations
# need task.control on the TARGET team; publish needs task.control on at
# least one membership team (the artifact is inert until deployed).
# =============================================================================

from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from croniter import croniter

from ai.account import account
from ai.account.models import resolve_team_permissions
from ai.common.dap import DAPConn, TransportBase

if TYPE_CHECKING:
    from ..task_scheduler import TaskScheduler
    from ..task_server import TaskServer


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

# How many upcoming occurrences preview returns by default (and at most).
_PREVIEW_DEFAULT = 5
_PREVIEW_MAX = 50


def _validate_schedule(schedule: str) -> None:
    """Raise ValueError unless schedule is 'manual', a preset, or valid 5-field cron."""
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

    Dispatches ``arguments.subcommand`` to the matching ``_deploy_*`` handler.
    Every handler resolves the caller's org, verifies the team permission the
    action needs, then calls the account module's virtual ``deployments_*``
    interface — so OSS and SaaS behave identically from here down.
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
            'publish': self._deploy_publish,
            'deploy': self._deploy_deploy,
            'list': self._deploy_list,
            'get': self._deploy_get,
            'versions': self._deploy_versions,
            'history': self._deploy_history,
            'pause': self._deploy_pause,
            'resume': self._deploy_resume,
            'remove': self._deploy_remove,
            'schedule_set': self._deploy_schedule_set,
            'preview': self._deploy_preview,
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
        they differ per subcommand and per addressed team.

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
    # IDENTITY / PERMISSION HELPERS
    # =========================================================================

    def _org_id(self) -> str:
        """The caller's organisation id — every deployment call is org-scoped."""
        org = getattr(self._account_info, 'organization', None)
        org_id = (org or {}).get('id') if isinstance(org, dict) else getattr(org, 'id', None)
        if not org_id:
            raise PermissionError('Deployments require an organisation membership')
        return org_id

    def _actor(self) -> Dict[str, str]:
        """The audit identity persisted with every action (denormalized)."""
        return {
            'userId': self._account_info.userId,
            'display': getattr(self._account_info, 'displayName', '') or '',
            'email': getattr(self._account_info, 'email', '') or '',
        }

    def _teams_with(self, perm: str) -> List[str]:
        """Ids of the caller's teams that grant ``perm`` (resolver-expanded)."""
        org = getattr(self._account_info, 'organization', None) or {}
        teams = org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)
        out: List[str] = []
        for team in teams or []:
            team_id = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
            if team_id and perm in resolve_team_permissions(self._account_info, team_id):
                out.append(team_id)
        return out

    def _require_team(self, args: Dict[str, Any], perm: str) -> str:
        """Extract ``teamId`` (default: the caller's defaultTeam) and verify ``perm`` on it."""
        team_id = args.get('teamId') or self._account_info.defaultTeam
        if not team_id:
            raise ValueError('teamId is required')
        self.verify_team_permission(team_id, perm)
        return team_id

    # =========================================================================
    # PUBLISH / DEPLOY
    # =========================================================================

    async def _deploy_publish(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Snapshot the pipeline into the org registry; optionally deploy in one step.

        ``deployTo`` (optional team id) is the OSS/two-man convenience: publish
        and point that team at the new version in a single call.
        """
        # Publishing puts an inert artifact in the org registry — gate it on
        # holding task.control SOMEWHERE (anyone who could deploy it anyway).
        if not self._teams_with('task.control'):
            raise PermissionError("Permission 'task.control' denied")

        pipeline = args.get('pipeline')
        if not isinstance(pipeline, dict) or not pipeline:
            raise ValueError('pipeline is required and must be an object')
        project_id = pipeline.get('project_id')
        if not project_id:
            raise ValueError('pipeline.project_id is required')

        org_id = self._org_id()
        entry = await account.deployments_publish(
            org_id, project_id, pipeline, self._actor(), comment=str(args.get('comment') or '')
        )
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_publish',
            request_data={'projectId': project_id, 'version': entry['version']},
            org_id=org_id,
        )

        body: Dict[str, Any] = {'artifact': entry}
        if args.get('deployTo'):
            # One-step publish+deploy — same checks as the deploy subcommand.
            team_id = str(args['deployTo'])
            self.verify_team_permission(team_id, 'task.control')
            dep = await account.deployments_deploy(org_id, team_id, project_id, entry['version'], self._actor())
            self._scheduler.sync(org_id, dep)
            body['deployment'] = dep
        return self.build_response(request, body=body)

    async def _deploy_deploy(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Point a team at a published version — promotion and rollback alike."""
        project_id = args.get('projectId')
        version = args.get('version')
        if not project_id:
            raise ValueError('projectId is required')
        if not isinstance(version, int):
            raise ValueError('version is required and must be an integer')

        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        dep = await account.deployments_deploy(org_id, team_id, project_id, version, self._actor())
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_deploy',
            request_data={'projectId': project_id, 'teamId': team_id, 'version': version},
            org_id=org_id,
        )
        return self.build_response(request, body=dep)

    # =========================================================================
    # READS
    # =========================================================================

    async def _deploy_list(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Deployments for one team (``teamId``) or every monitor-able team."""
        org_id = self._org_id()
        if args.get('teamId'):
            team_id = self._require_team(args, 'task.monitor')
            team_ids = [team_id]
        else:
            team_ids = self._teams_with('task.monitor')

        deployments: List[Dict[str, Any]] = []
        for team_id in team_ids:
            deployments.extend(await account.deployments_list(org_id, team_id))
        return self.build_response(request, body={'deployments': deployments})

    async def _deploy_get(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """One team deployment, registry-joined."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        team_id = self._require_team(args, 'task.monitor')

        dep = await account.deployments_get(self._org_id(), team_id, project_id)
        if dep is None:
            raise ValueError(f'No deployment of {project_id} for team {team_id}')
        return self.build_response(request, body=dep)

    async def _deploy_versions(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The org-registry versions of a project (the version strip)."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        # Registry reads are org-level: any team monitor grant suffices.
        if not self._teams_with('task.monitor'):
            raise PermissionError("Permission 'task.monitor' denied")

        versions = await account.deployments_versions(self._org_id(), project_id)
        return self.build_response(request, body={'versions': versions})

    async def _deploy_history(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The immutable audit trail for a project (optionally one team's)."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        team_id = args.get('teamId')
        if team_id:
            self.verify_team_permission(team_id, 'task.monitor')
        elif not self._teams_with('task.monitor'):
            raise PermissionError("Permission 'task.monitor' denied")

        rows = await account.deployments_history(self._org_id(), project_id, team_id)
        return self.build_response(request, body={'history': rows})

    # =========================================================================
    # STATE / REMOVE / SCHEDULES
    # =========================================================================

    async def _set_state(
        self, request: Dict[str, Any], args: Dict[str, Any], state: str, reason: str
    ) -> Dict[str, Any]:
        """Shared body of pause/resume/remove: flip state, resync, audit."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        dep = await account.deployments_set_state(org_id, team_id, project_id, state, self._actor())
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            reason,
            request_data={'projectId': project_id, 'teamId': team_id},
            org_id=org_id,
        )
        return self.build_response(request, body=dep)

    async def _deploy_pause(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Pause a team deployment (schedules stop firing)."""
        return await self._set_state(request, args, 'paused', 'deploy_pause')

    async def _deploy_resume(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Resume a paused team deployment."""
        return await self._set_state(request, args, 'active', 'deploy_resume')

    async def _deploy_remove(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """SOFT-remove a team deployment — history and artifacts remain."""
        return await self._set_state(request, args, 'removed', 'deploy_remove')

    async def _deploy_schedule_set(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Set (or clear) one source's schedule on a team deployment."""
        project_id = args.get('projectId')
        source_id = args.get('sourceId')
        if not project_id:
            raise ValueError('projectId is required')
        if not source_id:
            raise ValueError('sourceId is required')
        cron: Optional[str] = args.get('schedule')
        if cron is not None:
            _validate_schedule(cron)
            if cron == 'manual':
                # 'manual' means "no schedule row" — normalize to a clear.
                cron = None
        enabled = bool(args.get('enabled', True))

        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        dep = await account.deployments_schedule_set(
            org_id, team_id, project_id, source_id, cron, enabled, self._actor()
        )
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_schedule_set',
            request_data={'projectId': project_id, 'teamId': team_id, 'sourceId': source_id, 'schedule': cron},
            org_id=org_id,
        )
        return self.build_response(request, body=dep)

    # =========================================================================
    # PREVIEW — the single cron evaluator
    # =========================================================================

    async def _deploy_preview(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Validate a schedule and return its next occurrences.

        THE one evaluator: panel validation, "next:" lines, and DVR ghost
        tracks all render from this — nothing client-side parses cron, so the
        preview can never disagree with what the scheduler actually fires.
        """
        schedule = args.get('schedule')
        if not isinstance(schedule, str) or not schedule:
            raise ValueError('schedule is required')

        count = args.get('count', _PREVIEW_DEFAULT)
        if not isinstance(count, int) or count < 1:
            raise ValueError('count must be a positive integer')
        count = min(count, _PREVIEW_MAX)

        try:
            _validate_schedule(schedule)
        except ValueError as e:
            return self.build_response(request, body={'valid': False, 'error': str(e), 'next': []})

        occurrences: List[float] = []
        if schedule != 'manual':
            it = croniter(schedule, datetime.now())
            occurrences = [it.get_next(datetime).timestamp() for _ in range(count)]
        return self.build_response(request, body={'valid': True, 'next': occurrences})
