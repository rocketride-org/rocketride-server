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
# CMD DEPLOY — DAP router for the rrext_deploy command (the GENERIC rail door)
#
# rrext_deploy is the KIND-AGNOSTIC deploy interface: put any kind of object on
# the server, and read the rail. Over the account module's deployments_*
# interface (OSS: files; SaaS: DB — this layer never knows):
#
#   add           deploy any kind of object as an immutable org-registry
#                 version vN (kind='pipe' default: pipeline dict;
#                 kind='app': built-bundle zip, routed to app_deploy)
#   versions      the registry entries for a project (the version strip)
#   artifact      one immutable artifact's JSON, sha256-verified on load
#   history       the immutable audit trail (who/what/when)
#
# PIPE-specific deploy control — pointing a team at a version, its lifecycle,
# scheduling and running — lives on rrext_deploy_pipe (cmd_pipe.py). App
# publish control lives on rrext_deploy_app; the marketplace on rrext_app. The
# identity/permission/dispatch helpers shared by rrext_deploy and
# rrext_deploy_pipe live on _DeployBase, which both inherit.
#
# Permission model (checked HERE, at the command layer — the account module is
# mechanical). READS follow the VISIBILITY model: an org admin sees anything
# deployed anywhere (any team, any user's personal space); a regular user
# sees their own personal space and the teams they are a MEMBER of —
# membership alone grants sight. Registry rail reads (versions/artifact and
# unscoped history) need org membership only. MUTATIONS are the gated
# surface: add needs task.control on at least one membership team (the
# artifact is inert until a team is pointed at it), and pointing/controlling
# a team needs task.control on THAT team (cmd_pipe.py).
# =============================================================================

from typing import TYPE_CHECKING, Any, Dict, List

from ai.account import account
from ai.account.models import resolve_team_permissions
from ai.common.dap import DAPConn, TransportBase
from ai.common.list_rows import paginate_rows

from ..deploy_events import broadcast_deploy_changed

if TYPE_CHECKING:
    from ..task_scheduler import TaskScheduler
    from ..task_server import TaskServer


# =============================================================================
# SHARED DEPLOY BASE
# Identity, permissions, the scheduler accessor, subcommand dispatch, and the
# deploy-changed invalidation signal — shared by rrext_deploy (this file) and
# rrext_deploy_pipe (cmd_pipe.py). Carries no on_* command method of its own.
# =============================================================================


class _DeployBase(DAPConn):
    """
    Shared foundation for the deploy command mixins.

    Both ``DeployCommands`` (``rrext_deploy``) and ``DeployPipeCommands``
    (``rrext_deploy_pipe``) inherit this: caller identity/permission helpers,
    the scheduler accessor, the subcommand dispatcher, and the deploy-changed
    broadcast. Composed onto ``TaskConn`` via the two command mixins.
    """

    @property
    def _scheduler(self) -> 'TaskScheduler':
        """The deployment scheduler, created and stored in server state at module init."""
        return self._server._server.app.state.scheduler

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
        """Extract the REQUIRED deploy target and verify ``perm`` on it.

        Deploy targets are always explicit — there is deliberately no fallback
        to the caller's development team, so a user changing their profile
        assignment can never silently re-target a deployment.

        The sentinel ``teamId='@me'`` targets the CALLER's PERSONAL space:
        the returned owner key is ``user~{userId}``, which rides every
        ``team_id`` slot downstream (deployment records, scheduler keys,
        events) and can never collide with a real team id (team uuids never
        contain '~'). No team permission applies to your own space — the
        run's billing/secrets team is the ABSOLUTE stamp written at pointer
        time (``_billing_team_of``), never resolved at fire time.
        """
        team_id = args.get('teamId')
        if not team_id:
            raise ValueError('teamId is required')
        if team_id == '@me':
            if not self._account_info.userId:
                raise PermissionError('Personal (@me) deployments require an authenticated user')
            return f'user~{self._account_info.userId}'
        self.verify_team_permission(team_id, perm)
        return team_id

    def _is_org_admin(self) -> bool:
        """True for org.admin on the caller's org — and for the sys.admin /
        internal superusers (mirrors ``resolve_team_permissions``' rule).
        """
        sys_perms = getattr(self._account_info, 'sysPermissions', []) or []
        if 'sys.admin' in sys_perms or 'internal' in sys_perms:
            return True
        org = getattr(self._account_info, 'organization', None) or {}
        perms = org.get('permissions') if isinstance(org, dict) else getattr(org, 'permissions', None)
        return 'org.admin' in (perms or [])

    def _member_team_ids(self) -> List[str]:
        """Ids of every team the caller is a MEMBER of, permission-agnostic
        (an org.admin's account record already lists every org team).
        """
        org = getattr(self._account_info, 'organization', None) or {}
        teams = org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)
        out: List[str] = []
        for team in teams or []:
            team_id = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
            if team_id:
                out.append(team_id)
        return out

    def _billing_team_of(self, team_id: str) -> str:
        """The ABSOLUTE billing/secrets team stamped onto a publish at pointer time.

        A team audience bills itself — unambiguous by construction. A
        personal (``user~``) audience bills the PUBLISHER's dev team, which
        must be one of their membership teams in the session org; without
        one the @me publish REFUSES — billing never guesses, and runs only
        ever read the stamp (they never resolve).
        """
        if not team_id.startswith('user~'):
            return team_id
        dev_team = getattr(self._account_info, 'devTeam', '') or ''
        if not dev_team or dev_team not in self._member_team_ids():
            raise PermissionError(
                'Publishing to @me needs your development team set in this organization — pick one in your profile'
            )
        return dev_team

    def _visible_team_ref(self, args: Dict[str, Any]) -> str:
        """Extract a READ's addressed scope under the VISIBILITY model.

        An org admin can see anything deployed anywhere — any team, any
        user's personal space. A regular user can see their OWN personal
        space (``teamId='@me'``, mapped to ``user~{userId}``) and the teams
        they are a MEMBER of — membership alone grants read visibility; the
        task.* grants gate actions, not sight.
        """
        team_id = args.get('teamId')
        if not team_id:
            raise ValueError('teamId is required')
        if team_id == '@me':
            if not self._account_info.userId:
                raise PermissionError('Personal (@me) deployments require an authenticated user')
            return f'user~{self._account_info.userId}'
        team_id = str(team_id)
        if self._is_org_admin():
            return team_id
        if team_id.startswith('user~'):
            if team_id == f'user~{self._account_info.userId}':
                return team_id
            raise PermissionError("Another user's personal deployments are visible to org admins only")
        if team_id in self._member_team_ids():
            return team_id
        raise PermissionError(f'No membership in team {team_id!r}')

    async def _notify_deploy_changed(self, org_id: str, team_id: str, project_id: str, action: str) -> None:
        """Push an org-scoped invalidation event for a deployment mutation.

        Delegates to the ONE shared builder (``deploy_events``) so the
        event body can never drift from the scheduler's producer. Clients
        treat it as CACHE INVALIDATION, never as data — receivers re-fetch
        the record; this is what replaces the deploy surfaces' polling.
        Best-effort: a failed broadcast never fails the mutation.
        """
        await broadcast_deploy_changed(self._server, org_id, team_id, project_id, action)

    async def _dispatch_deploy(self, request: Dict[str, Any], handlers: Dict[str, Any], label: str) -> Dict[str, Any]:
        """Route ``arguments.subcommand`` to a handler in ``handlers``.

        Shared by ``on_rrext_deploy`` and ``on_rrext_deploy_pipe``. Permission
        checks live in each handler because they differ per subcommand and per
        addressed team.
        """
        try:
            args = request.get('arguments') or {}
            subcommand = args.get('subcommand')
            if not subcommand:
                raise ValueError('Subcommand is required')
            if handler := handlers.get(subcommand):
                return await handler(request, args)
            raise ValueError(f'Unknown subcommand: {subcommand}')
        except Exception as e:
            self.debug_message(f'{label} operation failed: {str(e)}')
            raise


# =============================================================================
# DEPLOY COMMANDS MIXIN — rrext_deploy (the generic rail door)
# =============================================================================


class DeployCommands(_DeployBase):
    """
    DAP router for the ``rrext_deploy`` command — the GENERIC, kind-agnostic
    rail door.

    ``add`` uploads a deployment (pipe|app|node) as an immutable registry
    version; ``versions``/``artifact``/``history`` read the rail. Every handler
    resolves the caller's org, verifies the team permission the action needs,
    then calls the account module's virtual ``deployments_*`` interface — so
    OSS and SaaS behave identically from here down.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the generic-rail subcommand handler lookup table."""
        # Only the kind-agnostic rail verbs live here; pipe control is on
        # DeployPipeCommands (cmd_pipe.py). All other state (account info,
        # server, transport) lives on TaskConn via the other mixins.
        self._deploy_subcommand_handlers = {
            'add': self._deploy_add,
            'versions': self._deploy_versions,
            'artifact': self._deploy_artifact,
            'history': self._deploy_history,
        }

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_deploy(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle DAP ``rrext_deploy`` — the GENERIC, kind-agnostic rail door.

        Subcommands: ``add`` (upload a pipe|app|node deployment) and the rail
        reads ``versions``/``artifact``/``history``. Pipe-specific control lives
        on ``rrext_deploy_pipe``; app control on ``rrext_deploy_app``.
        """
        return await self._dispatch_deploy(request, self._deploy_subcommand_handlers, 'Deploy')

    # =========================================================================
    # ADD (deploy code to the server)
    # =========================================================================

    async def _deploy_add(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The ONE rail door: deploy any kind of object onto the server.

        Kind dispatch: ``kind='pipe'`` (default — v0 clients send none) takes
        the pipeline-dict path below; ``kind='app'`` routes to the app branch
        (zip transport, unpacked at receipt) in ``ai.account.app_deploy``.
        """
        kind = str(args.get('kind') or 'pipe')
        if kind == 'app':
            from ai.account.app_deploy import handle_app_add

            return await handle_app_add(self, request)
        if kind != 'pipe':
            raise ValueError(f"Unknown deploy kind: {kind!r} (use 'pipe' or 'app')")
        return await self._deploy_add_pipe(request, args)

    async def _deploy_add_pipe(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Snapshot the pipeline into the org registry; optionally deploy in one step.

        ``deployTo`` (optional team id) is the OSS/two-man convenience: publish
        and point that team at the new version in a single call.
        """
        # Publishing puts an inert artifact in the org registry — gate it on
        # holding task.control SOMEWHERE (anyone who could deploy it anyway).
        if not self._teams_with('task.control'):
            raise PermissionError("Permission 'task.control' denied")

        pipeline = args.get('pipeline')
        # Shape first, then content: a missing/empty pipeline must report
        # itself, not a misleading "name is required".
        if not isinstance(pipeline, dict) or not pipeline:
            raise ValueError('pipeline is required and must be an object')
        # The pipe door only makes PIPES. A pipeline dict carrying kind:'app'
        # would otherwise be stamped as an app artifact by the backend and
        # skip the app-deploy namespace door — refuse the kind confusion at
        # the source (the publish-time namespace guard is the backstop).
        if str(pipeline.get('kind') or 'pipe') != 'pipe':
            raise ValueError("pipeline.kind must be 'pipe' — deploy apps via rrext_deploy add kind='app'")
        # A name is REQUIRED: pipelineName is what every deploy surface
        # (tabs, sidebar, version strip, grids) renders — a nameless
        # artifact would show as a project GUID forever, since artifacts
        # are immutable.
        if not str(pipeline.get('name') or '').strip():
            raise ValueError('pipeline.name is required — the registry renders it on every deploy surface')
        project_id = pipeline.get('project_id')
        if not project_id:
            raise ValueError('pipeline.project_id is required')

        org_id = self._org_id()
        metadata = args.get('metadata') if isinstance(args.get('metadata'), dict) else None
        entry = await account.deployments_publish(
            org_id, project_id, pipeline, self._actor(), comment=str(args.get('comment') or ''), metadata=metadata
        )
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_add',
            request_data={'projectId': project_id, 'version': entry['version']},
            org_id=org_id,
        )

        # The resolved org rides every deploy response (B1 transparency):
        # the caller always sees which organization the registry write
        # landed in — cross-org targeting goes through an org switch.
        body: Dict[str, Any] = {'artifact': entry, 'orgId': org_id}
        await self._notify_deploy_changed(org_id, '', project_id, 'add')
        if args.get('deployTo'):
            # One-step add+deploy — same checks as rrext_deploy_pipe deploy,
            # including the pointer-time billing stamp. _require_team owns the
            # @me resolution and the task.control check; reusing it keeps the
            # one authorization rule in a single place (it reads teamId off the
            # args mapping it is handed).
            team_id = self._require_team({'teamId': str(args['deployTo'])}, 'task.control')
            billing_team = self._billing_team_of(team_id)
            dep = await account.deployments_deploy(
                org_id, team_id, project_id, entry['version'], self._actor(), billing_team
            )
            self._scheduler.sync(org_id, dep)
            body['deployment'] = dep
            await self._notify_deploy_changed(org_id, team_id, project_id, 'deploy')
        return self.build_response(request, body=body)

    # =========================================================================
    # READS
    # =========================================================================

    async def _deploy_versions(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The org-registry versions of a project (the version strip)."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')

        # Registry reads need org membership only (_org_id raises without
        # one) — any user in the org can see what is deployed.
        versions = await account.deployments_versions(self._org_id(), project_id)
        # Envelope over the (per-project, bounded) registry list.
        body = paginate_rows(
            versions,
            args,
            searchable_keys=('pipelineName', 'comment'),
            default_sort=('version', 'desc'),
            tiebreak_key='version',
        )
        return self.build_response(request, body=body)

    async def _deploy_artifact(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """One immutable artifact's pipeline JSON, sha256-verified on load.

        The read-only DESIGN render and the file-less deployment tab are
        built from this: the registry is the source of truth for what a
        deployed version IS — never a local file, never a running task.
        """
        project_id = args.get('projectId')
        version = args.get('version')
        if not project_id:
            raise ValueError('projectId is required')
        if not isinstance(version, int):
            raise ValueError('version is required and must be an integer')

        # The artifact BODY is the full pipeline JSON — prompts and node
        # configuration that can carry literal sensitive values. The registry
        # is org+project scoped (one immutable version shared across teams via
        # per-team pointers), so there is no single owning team on the artifact
        # row. This gate requires task.monitor on SOME team (matches develop),
        # which blocks a teamless org member but does NOT stop a monitor on one
        # team from reading a project only ever deployed to another. Tightening
        # to owning-team visibility needs a meta.json deployments lookup.
        if not self._teams_with('task.monitor'):
            raise PermissionError("Permission 'task.monitor' denied")
        body = await account.deployments_artifact(self._org_id(), project_id, version)
        return self.build_response(request, body=body)

    async def _deploy_history(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The immutable audit trail for a project (optionally one team's)."""
        project_id = args.get('projectId')
        if not project_id:
            raise ValueError('projectId is required')
        # Unscoped history needs org membership only; a team-scoped trail
        # goes through the visibility model (admin: any scope; user: own
        # personal space + member teams).
        team_id = self._visible_team_ref(args) if args.get('teamId') else None

        # Paging happens in the BACKEND (SQL on saas): the trail is
        # append-only and unbounded, so it is never fully materialized here.
        body = await account.deployments_history(self._org_id(), project_id, team_id, args)
        return self.build_response(request, body=body)
