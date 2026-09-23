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
# CMD PIPE — DAP router for the rrext_deploy_pipe command (pipe deploy control)
#
# rrext_deploy_pipe carries the PIPE-specific half of deployment, over the
# account module's deployments_* interface (OSS: files; SaaS: DB):
#
#   deploy        point a TEAM at a published version (promotion/rollback alike)
#   list/get      team deployments (registry-joined)
#   enable/disable  the whole-deployment kill switch (disabled = NOTHING runs)
#   remove        SOFT remove (history and artifacts retained)
#   schedule_set  per-source cron on a team deployment (paused flag untouched)
#   schedule_pause/schedule_resume  pause ONE source's schedule (cron/ttl kept)
#   source_config one source's execution settings (trace level + debug output)
#   run           start one deployed source NOW (the smoke-test / run-now path)
#   preview       THE single cron evaluator (validate + next-N occurrences)
#
# Scheduling and run dispatch are PIPE-only, which is why they live here and
# not on rrext_deploy (the generic rail door — add + rail reads). Uploading is
# rrext_deploy add; app publish control is rrext_deploy_app; the marketplace is
# rrext_app. The shared identity/permission/dispatch/broadcast helpers live on
# ``_DeployBase`` (cmd_deploy.py), which this mixin inherits.
#
# Permission model (checked HERE, at the command layer — the account module is
# mechanical). Reads follow the VISIBILITY model: an org admin sees anything
# deployed anywhere (any team, any user's personal space); a regular user
# sees their own personal space and the teams they are a MEMBER of.
# Mutations, runs, and scheduling need task.control on the TARGET team.
# =============================================================================

from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from croniter import croniter

from ai.account import account
from ai.common.dap import TransportBase
from ai.common.list_rows import paginate_rows

from .cmd_deploy import _DeployBase

if TYPE_CHECKING:
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
# PIPE DEPLOY COMMANDS MIXIN — rrext_deploy_pipe
# =============================================================================


class DeployPipeCommands(_DeployBase):
    """
    DAP router for the ``rrext_deploy_pipe`` command — PIPE-specific deploy
    control.

    Points a team at a published version and owns its lifecycle, scheduling,
    and run-now dispatch. Every handler resolves the caller's org, verifies the
    team permission the action needs, then calls the account module's virtual
    ``deployments_*`` interface. Inherits the shared identity/permission/
    dispatch/broadcast helpers from ``_DeployBase`` (cmd_deploy.py).
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the pipe-deploy subcommand handler lookup table."""
        # Only pipe-specific control lives here; the kind-agnostic rail door
        # (add + rail reads) is DeployCommands (cmd_deploy.py). All other state
        # lives on TaskConn via the other mixins.
        self._deploy_pipe_subcommand_handlers = {
            'deploy': self._deploy_deploy,
            'list': self._deploy_list,
            'get': self._deploy_get,
            'enable': self._deploy_enable,
            'disable': self._deploy_disable,
            'remove': self._deploy_remove,
            'schedule_set': self._deploy_schedule_set,
            'source_config': self._deploy_source_config,
            'schedule_pause': self._deploy_schedule_pause,
            'schedule_resume': self._deploy_schedule_resume,
            'preview': self._deploy_preview,
            'run': self._deploy_run,
        }

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_deploy_pipe(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle DAP ``rrext_deploy_pipe`` — PIPE-specific deploy control.

        Subcommands: ``deploy`` (point a team at a version), ``list``/``get``,
        ``enable``/``disable``/``remove``, the scheduling verbs
        (``schedule_set``/``schedule_pause``/``schedule_resume``/
        ``source_config``), ``preview`` and ``run``. Scheduling and run dispatch
        are pipe-only, which is why they live here and not on ``rrext_deploy``.
        """
        return await self._dispatch_deploy(request, self._deploy_pipe_subcommand_handlers, 'Pipe deploy')

    # =========================================================================
    # SHARED GUARD
    # =========================================================================

    async def _require_source_in_artifact(
        self, org_id: str, team_id: str, project_id: str, source_id: str
    ) -> Dict[str, Any]:
        """The team's deployment, after proving ``source_id`` is in its artifact.

        A schedule or per-source setting for a component id the deployed
        version does not contain would otherwise fail on every cron tick
        with nothing but a server log line — reject it at write time, where
        the caller gets a real error.
        """
        dep = await account.deployments_get(org_id, team_id, project_id)
        if dep is None or dep.get('state') == 'removed':
            raise ValueError(f'No deployment of {project_id} for team {team_id}')
        pipeline = await account.deployments_artifact(org_id, project_id, dep['version'])
        components = pipeline.get('components') or []
        if source_id not in {c.get('id') for c in components if isinstance(c, dict)}:
            raise ValueError(f'sourceId {source_id!r} is not a component of version {dep["version"]}')
        return dep

    # =========================================================================
    # DEPLOY (bind a team to a version)
    # =========================================================================

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

        # The billing decision happens HERE, at pointer time (absolute):
        # team audiences bill themselves; @me stamps the publisher's dev
        # team or refuses. Runs read the stamp and never resolve.
        billing_team = self._billing_team_of(team_id)
        dep = await account.deployments_deploy(org_id, team_id, project_id, version, self._actor(), billing_team)
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_deploy',
            request_data={'projectId': project_id, 'teamId': team_id, 'version': version},
            org_id=org_id,
        )
        await self._notify_deploy_changed(org_id, team_id, project_id, 'deploy')
        return self.build_response(request, body=dep)

    # =========================================================================
    # READS
    # =========================================================================

    async def _deploy_list(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Deployments for one addressed scope (``teamId``) or everything visible.

        Visibility model: an org admin sees the WHOLE org — every team and
        every user's personal space. A regular user sees their own personal
        space plus the teams they are a member of.
        """
        org_id = self._org_id()
        if args.get('teamId'):
            team_id = self._visible_team_ref(args)
            deployments = await account.deployments_list(org_id, team_id)
        else:
            # ONE org-wide query, then the caller's visible slice — admins
            # keep every row; users keep member teams + their own space.
            deployments = await account.deployments_list(org_id, None)
            if not self._is_org_admin():
                visible = set(self._member_team_ids())
                if self._account_info.userId:
                    visible.add(f'user~{self._account_info.userId}')
                deployments = [d for d in deployments if d.get('teamId') in visible]
        # Standard list-API envelope ({rows,total,page,pageSize}): rows are
        # already materialized (bounded per-org), so the shared in-Python
        # convention applies. History, by contrast, pages in the BACKEND
        # (unbounded audit trail).
        body = paginate_rows(
            deployments,
            args,
            searchable_keys=('projectId', 'pipelineName', 'teamId'),
            default_sort=('updatedAt', 'desc'),
            tiebreak_key='projectId',
        )
        return self.build_response(request, body=body)

    async def _deploy_get(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """One team deployment, registry-joined (visibility-gated scope)."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        team_id = self._visible_team_ref(args)

        dep = await account.deployments_get(self._org_id(), team_id, project_id)
        if dep is None:
            raise ValueError(f'No deployment of {project_id} for team {team_id}')
        return self.build_response(request, body=dep)

    # =========================================================================
    # STATE / REMOVE / SCHEDULES
    # =========================================================================

    async def _set_state(
        self, request: Dict[str, Any], args: Dict[str, Any], state: str, reason: str
    ) -> Dict[str, Any]:
        """Shared body of enable/disable/remove: flip state, resync, audit."""
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
        await self._notify_deploy_changed(org_id, team_id, project_id, state)
        return self.build_response(request, body=dep)

    async def _deploy_disable(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Disable a team deployment — the kill switch: NOTHING runs."""
        return await self._set_state(request, args, 'disabled', 'deploy_disable')

    async def _deploy_enable(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Enable a disabled team deployment."""
        return await self._set_state(request, args, 'enabled', 'deploy_enable')

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

        # Run window: None/absent = until the pipeline finishes; a positive
        # integer = seconds the task stays up (the 'fixed window' option).
        ttl = args.get('ttl')
        if ttl is not None and (not isinstance(ttl, int) or ttl <= 0):
            raise ValueError('ttl must be a positive integer (seconds) or omitted')

        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        # The source must exist in the deployed artifact — a schedule for a
        # phantom source would fail on every tick.
        await self._require_source_in_artifact(org_id, team_id, project_id, source_id)

        # The paused flag is NOT part of this call: editing cron/ttl keeps
        # it, and schedule_pause/schedule_resume own flipping it.
        dep = await account.deployments_schedule_set(org_id, team_id, project_id, source_id, cron, self._actor(), ttl)
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_schedule_set',
            request_data={'projectId': project_id, 'teamId': team_id, 'sourceId': source_id, 'schedule': cron},
            org_id=org_id,
        )
        await self._notify_deploy_changed(org_id, team_id, project_id, 'schedule')
        return self.build_response(request, body=dep)

    async def _set_schedule_paused(
        self, request: Dict[str, Any], args: Dict[str, Any], paused: bool, reason: str
    ) -> Dict[str, Any]:
        """Shared body of schedule_pause/schedule_resume: flip, resync, audit."""
        project_id = args.get('projectId')
        source_id = args.get('sourceId')
        if not project_id:
            raise ValueError('projectId is required')
        if not source_id:
            raise ValueError('sourceId is required')
        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        dep = await account.deployments_schedule_set_paused(
            org_id, team_id, project_id, source_id, paused, self._actor()
        )
        self._scheduler.sync(org_id, dep)
        await account.audit(
            self._account_info.userId,
            'deploy',
            reason,
            request_data={'projectId': project_id, 'teamId': team_id, 'sourceId': source_id},
            org_id=org_id,
        )
        await self._notify_deploy_changed(
            org_id, team_id, project_id, 'schedule_pause' if paused else 'schedule_resume'
        )
        return self.build_response(request, body=dep)

    async def _deploy_source_config(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Set one source's execution settings (trace level + debug output)."""
        project_id = args.get('projectId')
        source_id = args.get('sourceId')
        if not project_id:
            raise ValueError('projectId is required')
        if not source_id:
            raise ValueError('sourceId is required')

        # traceLevel: an explicit dev-run verbosity, or None = the deploy default (full).
        trace_level = args.get('traceLevel')
        if trace_level is not None and trace_level not in ('none', 'metadata', 'summary', 'full'):
            raise ValueError(
                'traceLevel must be one of none|metadata|summary|full, or omitted for the deploy default (full)'
            )
        debug_out = bool(args.get('debugOut', False))

        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        # Same artifact-membership guard as schedule_set (shared argument).
        await self._require_source_in_artifact(org_id, team_id, project_id, source_id)

        dep = await account.deployments_source_config_set(
            org_id, team_id, project_id, source_id, trace_level, debug_out, self._actor()
        )
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_source_config',
            request_data={
                'projectId': project_id,
                'teamId': team_id,
                'sourceId': source_id,
                'traceLevel': trace_level,
                'debugOut': debug_out,
            },
            org_id=org_id,
        )
        await self._notify_deploy_changed(org_id, team_id, project_id, 'source_config')
        return self.build_response(request, body=dep)

    async def _deploy_schedule_pause(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Pause ONE source's schedule (cron/ttl kept; it just stops firing)."""
        return await self._set_schedule_paused(request, args, True, 'deploy_schedule_pause')

    async def _deploy_schedule_resume(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Resume a paused source schedule."""
        return await self._set_schedule_paused(request, args, False, 'deploy_schedule_resume')

    # =========================================================================
    # RUN — manual trigger (the smoke-test / run-now path)
    # =========================================================================

    async def _deploy_run(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Start one deployed source NOW.

        The same trusted team dispatch the scheduler uses (no stored
        credential — the run executes AS THE TEAM and carries no human
        identity; billing attributes to org+team, and who fired it is
        recorded by the audit call below). Without this a deployment could
        only ever run from a cron tick — no way to smoke-test a version or
        fire an unscheduled source on demand.
        """
        project_id = args.get('projectId')
        source_id = args.get('sourceId')
        if not project_id:
            raise ValueError('projectId is required')
        if not source_id:
            raise ValueError('sourceId is required')
        team_id = self._require_team(args, 'task.control')
        org_id = self._org_id()

        # The deployment must exist and be runnable — a disabled or errored
        # deployment must not run "just this once" through the back door.
        # Same artifact-membership guard as schedule_set/source_config: a
        # sourceId the deployed version does not contain must fail HERE as a
        # validation error, not at launch with an engine-level message.
        dep = await self._require_source_in_artifact(org_id, team_id, project_id, source_id)
        if dep.get('state') != 'enabled':
            raise ValueError(f'Deployment is {dep.get("state")} — enable it first')

        # The manual path honors the SAME overlap guard as the cron loop:
        # two concurrent runs of one source would share the team storage
        # anchor (teams/<team>/files/tasks/<project>). RESERVE the slot now,
        # atomically (no await between check and claim) — checking here and
        # only registering the token after the awaits below let two concurrent
        # run-now requests both pass and both start. Everything after the
        # reservation runs under a try that releases the slot on any failure,
        # so a failed start never wedges the guard.
        if not self._scheduler.try_reserve_run(team_id, project_id, source_id):
            raise ValueError(f'A run of {project_id}/{source_id} is already active for team {team_id}')

        try:
            # The pointed-at artifact, sha256-verified: what was published is
            # what runs. The chosen source becomes the run's entry point.
            pipeline = dict(await account.deployments_artifact(org_id, project_id, dep['version']))
            pipeline['source'] = source_id

            # Function-level import: the facade imports TaskConn, and this
            # module is a TaskConn mixin — a top-level import would be circular.
            from ..task_server_facade import start_server_task_as_team

            # Owner rung: a 'user~{uid}' slot is a PERSONAL (@me) deployment —
            # the run is USER-owned (private storage/logs/visibility). Billing
            # is ABSOLUTE: every publish stamped its billing/secrets team at
            # pointer time, and runs only ever read the stamp — a missing one
            # (stamped team deleted, or a pre-stamp record) refuses loudly
            # instead of resolving anything.
            billing_team = str(dep.get('billingTeamId') or '')
            if team_id.startswith('user~'):
                owner_kind, owner_user = 'user', team_id[len('user~') :]
            else:
                owner_kind, owner_user = 'team', ''
                # Team records from before the stamp bill their own audience.
                billing_team = billing_team or team_id
            if not billing_team:
                raise ValueError(
                    'This deployment has no billing team — re-publish it after setting your development team'
                )

            # A manual run honors the source's execution settings but NOT its
            # run window: the ttl window belongs to scheduled fires — a run the
            # user started runs until it finishes or the user stops it.
            sched = (dep.get('schedules') or {}).get(source_id) or {}
            token = await start_server_task_as_team(
                self._server,
                pipeline,
                org_id=org_id,
                team_id=billing_team,
                trigger='manual',
                ttl=None,
                trace_level=sched.get('traceLevel') or 'full',
                debug_out=bool(sched.get('debugOut')),
                owner_kind=owner_kind,
                owner_user_id=owner_user,
            )
        except BaseException:
            # The start never completed — free the reservation so a retry (or
            # the cron tick) can dispatch. register_manual_run below is what
            # promotes the reservation to a real token on success.
            self._scheduler.release_run(team_id, project_id, source_id)
            raise

        # Register the token with the scheduler so the next cron tick sees
        # this run and skips instead of dispatching a second one (this
        # overwrites the reservation marker with the real run token).
        self._scheduler.register_manual_run(team_id, project_id, source_id, token)
        await account.deployments_mark_run(org_id, team_id, project_id, source_id)
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_run',
            request_data={'projectId': project_id, 'teamId': team_id, 'sourceId': source_id, 'version': dep['version']},
            org_id=org_id,
        )
        await self._notify_deploy_changed(org_id, team_id, project_id, 'run')
        return self.build_response(request, body={'token': token, 'version': dep['version']})

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
            # croniter accepts some calendar-impossible expressions at
            # construction and only fails in get_next — report those as
            # invalid schedules too, never as a DAP error.
            try:
                it = croniter(schedule, datetime.now())
                occurrences = [it.get_next(datetime).timestamp() for _ in range(count)]
            except Exception as e:
                return self.build_response(request, body={'valid': False, 'error': str(e), 'next': []})
        return self.build_response(request, body={'valid': True, 'next': occurrences})
