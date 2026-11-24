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
#                 version vN (kind='pipe' default: pipeline dict, optionally
#                 with its folder zip as ``data`` (the store block's files);
#                 kind='app': built-bundle zip, routed to app_deploy)
#   versions      the registry entries for a project (the version strip);
#                 each row says whether it is ``deletable`` right now
#   artifact      one immutable artifact's JSON, sha256-verified on load
#   history       the immutable audit trail (who/what/when)
#   delete        remove one deployed version's storage from the server
#                 (apps and pipes alike) while nothing points at it: refused
#                 when a rung pins it, it is in review, or its build runs
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

import json
from typing import TYPE_CHECKING, Any, Dict, List

from rocketlib import debug

from ai.account import account
from ai.account.app_deploy import _assert_owns_namespace, _developer_id_of, developer_id_required, publish_block_of
from ai.account.audience import (
    PUBLIC_AUDIENCE,
    Audience,
    compose_audience,
    compose_handle,
    describe,
    org_audience,
    parse_audience,
    parse_target,
    team_audience,
    user_audience,
)
from ai.account.deployment_backend import DEFAULT_REVIEW_STATE, audience_handle
from ai.account.models import resolve_team_permissions, team_id_of_name
from ai.account.pipe_bundle import (
    default_store_block,
    pipe_manifest,
    read_pipe_bundle,
    validate_store_block,
    write_pipe_content,
)
from ai.common.dap import DAPConn, TransportBase
from ai.common.list_rows import paginate_rows

from ..address import validate_component_ids, validate_segment
from ..deploy_events import broadcast_deploy_changed, broadcast_review_state, release_deployment_holds

if TYPE_CHECKING:
    from ..task_scheduler import TaskScheduler
    from ..task_server import TaskServer


def _canonical_json(value: Any) -> Any:
    """A pipeline dict with integer-valued floats as ints, for comparing a client's dict with the bundle's text.

    JavaScript has no integer type: a TypeScript client sends ``1.0`` as
    ``1``, while the bundle's ``.pipe`` text parses to the Python float
    ``1.0``. Both describe one pipeline; the comparison must say so. The
    caller compares the sorted JSON of the result, never Python equality:
    ``True == 1`` there, and a boolean is not a number in the file.
    """
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: _canonical_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canonical_json(item) for item in value]
    return value


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

    def _registry_id(self, project_id: Any) -> str:
        """
        The registry name a client's ``projectId`` argument addresses.

        A ``.pipe`` file carries only the SHORT pipe id; the name a pipe is
        registered, published and resolved under is ``developerId.pipeId``,
        the developer id being the one the PUBLISHING organization holds
        (plan 2.3, B37: one namespace per developer id across apps, pipes
        and nodes). Clients therefore send the short id and this door
        composes the stored name from the caller's organization; an id that
        already carries its namespace (an app id, or a pipe name a client
        read back from a registry row) is checked against the caller's
        namespace and passed through.

        Args:
            project_id: The client's ``projectId`` argument.

        Returns:
            The two-segment registry name.

        Raises:
            ValueError: No ``projectId``, or the organization has no developer
                id yet (``developer_id_required`` names the ways to claim one),
                or the name is outside the caller's namespace.
            TaskError: ``TASK_INVALID_ARGUMENT`` when a segment breaks the
                address grammar.
        """
        if not project_id:
            raise ValueError('projectId is required')
        # No organization, no namespace: the membership refusal comes first
        self._org_id()
        developer_id = _developer_id_of(self)
        if '.' in str(project_id):
            full_name = str(project_id)
        else:
            if not developer_id:
                raise ValueError(developer_id_required('Deploying or publishing a pipeline'))
            full_name = f'{developer_id}.{validate_segment(project_id, "projectId")}'
        _assert_owns_namespace(self, full_name)
        return full_name

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

    def _team_names(self) -> Dict[str, str]:
        """The caller's team names by team id (what a handle may name)."""
        org = getattr(self._account_info, 'organization', None) or {}
        teams = org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)
        out: Dict[str, str] = {}
        for team in teams or []:
            team_id = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
            name = team.get('name') if isinstance(team, dict) else getattr(team, 'name', None)
            if team_id and name:
                out[str(team_id)] = str(name)
        return out

    def _describe(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """
        A deployment row as THIS caller reads it: its ``audience``, ``rung`` and ``handle`` (plan 2.5).

        The backend's row carries the audience as ``teamId``; the rung
        (``me`` or ``personal`` for a personal space) and the handle (a team
        by the name the caller knows it by) depend on who reads, so they are
        composed here. A client shows the handle and passes the audience
        back unchanged; it parses neither.

        Args:
            row: A deployment row whose ``teamId`` is an audience.

        Returns:
            A copy of the row with the three fields.
        """
        org = getattr(self._account_info, 'organization', None) or {}
        org_id = (org.get('id') if isinstance(org, dict) else getattr(org, 'id', None)) or ''
        described = describe(
            str(row.get('teamId') or ''),
            caller_id=str(self._account_info.userId or ''),
            team_names=self._team_names(),
            org_id=str(org_id),
        )
        return {**row, **described}

    def _with_audience_handle(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """
        A history row whose ``data.audience`` pair carries THIS reader's handle.

        Publish rows store the audience pair and its display name, never a
        handle (``deployment_backend.audience_display``); a handle an older
        row stored is never shown: every reader sees the one the server
        composes for them (``deployment_backend.audience_handle``), or none
        where the pair names no audience.

        Args:
            row: A history row.

        Returns:
            The row, with ``data.audience.handle`` composed when it has an
            audience pair, and a stored handle dropped when the pair decodes
            to no audience; unchanged when it has no ``data.audience``.
        """
        # Step 1: the stored pair, without any handle an older row stored
        data = row.get('data')
        audience = data.get('audience') if isinstance(data, dict) else None
        if not isinstance(audience, dict):
            return row
        pair = {key: value for key, value in audience.items() if key != 'handle'}
        if not pair.get('type'):
            # No type: no audience to compose a handle for
            return {**row, 'data': {**data, 'audience': pair}}

        # Step 2: this reader's handle for the pair
        org = getattr(self._account_info, 'organization', None) or {}
        org_id = (org.get('id') if isinstance(org, dict) else getattr(org, 'id', None)) or ''
        try:
            handle = audience_handle(pair, str(self._account_info.userId or ''), self._team_names(), str(org_id))
        except ValueError:
            # A pair no audience decodes (a legacy row): shown without a handle
            return {**row, 'data': {**data, 'audience': pair}}
        return {**row, 'data': {**data, 'audience': {**pair, 'handle': handle}}}

    def _audience_arg(self, args: Dict[str, Any]) -> Audience:
        """
        Read the ``teamId`` argument of a deploy verb as the audience it names.

        ``teamId`` takes exactly the targets of plan 2.5: ``@me`` (the
        caller's personal space), ``@public`` (the store), ``@<team>`` (one
        of the caller's teams by name, ignoring case: what a person types,
        passed through by the SDKs), or any audience a row or the
        ConnectResult carried (``=team/<tid>``, ``=user/<uid>``, passed back
        unchanged). A bare team id is refused like every other bare word, as
        are the retired ``@team/<...>`` and ``@user`` (each names its
        replacement). ``@org`` and ``=org/<oid>`` name the caller's ACTIVE
        org only. This is the ONE place the door reads the argument;
        everything after it holds a decoded audience.

        Args:
            args: The verb's arguments.

        Returns:
            The decoded audience (``@me`` and a team name already resolved).

        Raises:
            ValueError: No ``teamId``, a form that is no target (a bare team
                id included), or a retired spelling.
            PermissionError: ``@me`` with no authenticated user, a team name
                that names none (or more than one) of the caller's teams, or
                an org other than the active one.
        """
        value = args.get('teamId')
        if not value:
            raise ValueError('teamId is required')
        target = parse_target(str(value))
        if target.kind == 'me':
            if not self._account_info.userId:
                raise PermissionError('Personal (@me) deployments require an authenticated user')
            return parse_audience(user_audience(self._account_info.userId))
        if target.kind == 'public':
            return parse_audience(PUBLIC_AUDIENCE)
        if target.kind == 'org':
            org_id = self._org_id()
            if not org_id or (target.by_id and target.ref != org_id):
                raise PermissionError('An org target names your active organization only')
            return Audience('org', org_id)
        if not target.by_id:
            # A team by name: the caller's own membership, ignoring case
            team_id = team_id_of_name(self._account_info, target.ref)
            if not team_id:
                raise PermissionError(f'You are not a member of a team named {target.ref!r}')
            return Audience('team', team_id)
        return Audience(target.kind, target.ref)

    def _require_team(self, args: Dict[str, Any], perm: str, *, unattended: bool = False) -> str:
        """Extract the REQUIRED deploy target and verify ``perm`` on it.

        Deploy targets are always explicit — there is deliberately no fallback
        to the caller's development team, so a user changing their profile
        assignment can never silently re-target a deployment.

        The returned value is the target's AUDIENCE (plan 2.5), which rides
        every ``team_id`` slot downstream (deployment records, scheduler
        keys, events) under the wire's name for it, ``teamId``.

        ``@me`` (or the caller's own ``=user/<uid>``) is the CALLER's
        PERSONAL space. No team permission applies to your own space — the
        run's billing/secrets team is the ABSOLUTE stamp written at pointer
        time (``_billing_team_of``), never resolved at fire time. Another
        user's space is never a target.

        ``@public`` targets the store (plan 10.1), the audience the
        resolver's ``@public`` rung reads. Who may act on it is the app
        door's rule for the store (``app_deploy._resolve_target``): an
        organization registered as a developer, on a name in its own
        namespace (``_registry_id``); no team grant applies.

        ``@org`` (or the active org's ``=org/<oid>``) targets the org rung
        (plan 3.2): published, disabled, removed and scheduled by org admins
        only, whatever ``perm`` says.

        A team (``=team/<tid>`` or its id) needs ``perm`` on that team.

        ``unattended`` marks the verbs that start or plan a run with no
        caller (a schedule, a run-now): on ``@public`` those are org admins'
        only too, because such a run is the org's (plan 8.3).
        """
        audience = self._audience_arg(args)
        if audience.kind == 'user':
            if audience.id != self._account_info.userId:
                raise PermissionError("Another user's personal space is not a deploy target")
            return user_audience(audience.id)
        if audience.kind == 'public':
            if not _developer_id_of(self):
                raise ValueError('Public publishing requires the organization to be registered as a developer')
            if unattended and not self._is_org_admin():
                raise PermissionError('Only org admins schedule or run a @public publication')
            return PUBLIC_AUDIENCE
        if audience.kind == 'org':
            if not self._is_org_admin():
                raise PermissionError('The org rung is published, disabled, removed and scheduled by org admins only')
            return org_audience(audience.id)
        if audience.kind != 'team':
            raise ValueError(f'Not a deploy target: {compose_audience(*audience)}')
        self.verify_team_permission(audience.id, perm)
        return team_audience(audience.id)

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

    async def _require_store_publishable(self, org_id: str, project_id: str, version: int) -> None:
        """Refuse pointing the store at ``version`` unless the store gate passes.

        The gate is the app door's (``app_deploy.publish_block_of``), read off
        the version's review state, tightened to what the pipe serving gate
        serves: the store serves a pipe only a 'ready' version on every server
        (``pipe_serving_block_of``). With a review ladder that is the approved
        version; without one the pipe door promotes each version to 'ready' as
        it is stored, so a version in any other state never finished its
        deploy. Only a pipe version takes this door: an app reaches the store
        through the app door, which keeps its manifest. Every door that can
        point ``@public`` calls this first (``rrext_deploy_pipe deploy`` and
        ``add``'s ``deployTo``).

        Raises:
            ValueError: The version is not on the rail, is an app's, declares
                roots, or the gate refuses it.
        """
        entries = await account.deployments_versions(org_id, project_id)
        entry = next((e for e in entries if int(e.get('version', 0)) == version), None)
        if entry is None:
            raise ValueError(f'version {version} is not published for {project_id}')
        if str(entry.get('kind') or 'pipe') != 'pipe':
            raise ValueError(
                f'Version {version} of {project_id} is an app: point the store at an app with the app door '
                '(rrext_deploy_app publish), which keeps its manifest'
            )
        state = str(entry.get('state') or DEFAULT_REVIEW_STATE)
        refusal = publish_block_of(project_id, version, state, True, bool(account.review_ladder))
        if not refusal and state != 'ready':
            refusal = (
                f'Version {version} of {project_id} is not ready for the store (state {state!r}): '
                'its deploy did not finish, so deploy it again'
            )
        if refusal:
            raise ValueError(refusal)

        # A pipeline that declares roots reaches team or org trees of its
        # publisher's org: the store serves callers of every org, so it is
        # refused there (plan 2.5)
        artifact = await account.deployments_artifact(org_id, project_id, version)
        if isinstance(artifact, dict) and artifact.get('roots'):
            raise ValueError(
                f'Version {version} of {project_id} declares roots ({", ".join(map(str, artifact["roots"]))}): '
                'a pipeline that reaches team or org files cannot be published to @public'
            )

    def _billing_team_of(self, team_id: str) -> str:
        """The ABSOLUTE billing team stamped onto a publish at pointer time (plan 8.3).

        A team audience bills itself — unambiguous by construction. A
        personal (@me) audience bills the PUBLISHER's development team, which
        must be one of their membership teams in the session org; without one
        the @me publish REFUSES — billing never guesses, and runs only ever
        read the stamp (they never resolve). The org rung and the store bill
        no team (their runs are the org's, and every caller of them pays for
        their own calls with no ledger team), so they carry no stamp.

        Args:
            team_id: The target's audience (``_require_team``'s result).

        Returns:
            The stamp; '' for an org or store audience.
        """
        audience = parse_audience(team_id)
        if audience.kind == 'team':
            return audience.id
        if audience.kind in ('org', 'public'):
            return ''
        dev_team = getattr(self._account_info, 'devTeam', '') or ''
        if not dev_team or dev_team not in self._member_team_ids():
            handle = compose_handle(team_id, caller_id=str(self._account_info.userId or ''))
            raise PermissionError(
                f'Publishing to {handle} needs your development team set in this organization — pick one in your profile'
            )
        return dev_team

    def _visible_team_ref(self, args: Dict[str, Any]) -> str:
        """Extract a READ's addressed scope under the VISIBILITY model.

        An org admin can see anything deployed anywhere — any team, any
        user's personal space. A regular user can see their OWN personal
        space (``teamId='@me'`` or their own ``=user/<uid>``), the
        organization's store publications (``teamId='@public'``) and the
        teams they are a MEMBER of — membership alone grants read
        visibility; the task.* grants gate actions, not sight.

        Returns:
            The addressed audience.
        """
        audience = self._audience_arg(args)
        if audience.kind == 'public':
            return PUBLIC_AUDIENCE
        if audience.kind == 'org':
            return org_audience(audience.id)
        if audience.kind == 'user':
            if audience.id == self._account_info.userId or self._is_org_admin():
                return user_audience(audience.id)
            raise PermissionError("Another user's personal deployments are visible to org admins only")
        if audience.kind != 'team':
            raise ValueError(f'Not a deployment scope: {compose_audience(*audience)}')
        if self._is_org_admin() or audience.id in self._member_team_ids():
            return team_audience(audience.id)
        raise PermissionError(f'No membership in team {audience.id!r}')

    async def _notify_deploy_changed(self, org_id: str, team_id: str, project_id: str, action: str) -> None:
        """Push an org-scoped invalidation event for a deployment mutation.

        Delegates to the ONE shared builder (``deploy_events``) so the
        event body can never drift from the scheduler's producer. Clients
        treat it as CACHE INVALIDATION, never as data — receivers re-fetch
        the record; this is what replaces the deploy surfaces' polling.
        Best-effort: a failed broadcast never fails the mutation.
        """
        # Disable/remove is the kill switch: every run resolved through the
        # deployment releases its hold before anyone is told
        await release_deployment_holds(self._server, org_id, team_id, project_id, action)
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
            'delete': self._deploy_delete,
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

        Every version carries a ``store`` block: a pipeline sent without one
        is stored with the default block (``default_store_block``), so its
        version has a listing manifest like any other.

        ``deployTo`` (an optional target, as ``teamId`` takes on ``deploy``:
        ``@me``, ``@<team>``, ``=team/<tid>``, ``@public``) is the
        OSS/two-man convenience: publish and point that target at the new
        version in a single call. The target is read and authorized before
        anything is written, so a refused target leaves the registry
        untouched; only the store's gate on ``@public``, which reads the new
        version's review state, runs after the write.
        """
        # Publishing puts an inert artifact in the org registry — gate it on
        # holding task.control SOMEWHERE (anyone who could deploy it anyway).
        if not self._teams_with('task.control'):
            raise PermissionError("Permission 'task.control' denied")

        # The BUNDLE (plan 9, C.17b): the binary ``data`` frame is the zip of
        # the pipeline folder — the pipe at its root plus the files its store
        # block declares and the readme references. The pipe inside it IS the
        # artifact; a ``pipeline`` dict sent beside it must be the same pipe.
        # Without a zip the dict is the artifact alone (the SDK and CI door).
        bundle = None
        data = args.get('data')
        if data is not None:
            if not isinstance(data, (bytes, bytearray)):
                raise ValueError('data must be the pipeline bundle zip (binary frame), not text')
            bundle = read_pipe_bundle(bytes(data))
        pipeline = args.get('pipeline')
        if bundle is not None:
            # The packers fill a missing display name (pipe, then stem) with
            # plain truthiness; the server fills the same way BEFORE the
            # comparison so both sides change together
            if not bundle.pipeline.get('name'):
                bundle.pipeline['name'] = bundle.stem
            if pipeline is None:
                pipeline = bundle.pipeline
            elif json.dumps(_canonical_json(pipeline), sort_keys=True) != json.dumps(
                _canonical_json(bundle.pipeline), sort_keys=True
            ):
                raise ValueError("pipeline differs from the bundle's .pipe - deploy the bundle as it is on disk")
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
        # The file carries only the SHORT id; the registry name is DERIVED
        # from the actor's developer namespace, never read from the file, so
        # no org can produce another's namespace (plan S7). The namespace
        # guarantee is the same one apps pass; the grammar (dot-free short
        # id, dot-free component ids) is the address grammar. Every registry
        # row below is keyed by the full name; the artifact keeps the short id.
        validate_segment(project_id, 'project_id')
        validate_component_ids(pipeline)
        # The store block (plan 9): every pipe version carries one. A pipe
        # sent without it gets the default block here, after the comparison
        # with the bundle's pipe, so the stored artifact, the manifest and
        # the content stage all see one pipeline. An authored block is
        # checked before any registry write so an unknown key or a bad mode
        # refuses the deploy by name.
        if 'store' not in pipeline:
            pipeline = {**pipeline, 'store': default_store_block()}
        store_block = validate_store_block(pipeline)
        full_name = self._registry_id(project_id)
        project_id = full_name

        # The one-step deploy's target, read and authorized BEFORE the
        # registry write (the same checks as rrext_deploy_pipe deploy, the
        # pointer-time billing stamp included): a retired or foreign target
        # must not leave a new version, withdrawn reviews and a change
        # notification behind. _require_team owns the @me resolution and the
        # task.control check (it reads teamId off the mapping it is handed)
        deploy_team = billing_team = ''
        if args.get('deployTo'):
            deploy_team = self._require_team({'teamId': str(args['deployTo'])}, 'task.control')
            billing_team = self._billing_team_of(deploy_team)

        org_id = self._org_id()
        caller_meta = args.get('metadata') if isinstance(args.get('metadata'), dict) else {}
        # metadata.build is the SERVER's build lifecycle (stamped by the build
        # worker / seeder; it gates serving). The app door overwrites it; a
        # pipe has no build, so a caller-supplied one is dropped, never stored.
        caller_meta = {k: v for k, v in caller_meta.items() if k != 'build'}
        # The listing manifest the publish row snapshots (plan 9): the store
        # block plus the pipe's own root keys; never a publisher or author
        # (derived, plan S7). It replaces a caller-supplied one: the block is
        # the ONE source of a listing, and `is_listed` reads the manifest's
        # `mode`.
        metadata = {**caller_meta, 'manifest': pipe_manifest(pipeline, store_block)}
        # Born state (plan S8): every version is born 'private' (team and
        # personal rungs serve it; @public needs 'ready' after review). On a
        # server WITHOUT a review ladder the developer IS the admin, so the
        # version is promoted to 'ready' below, once its content is stored:
        # born 'private' first so a failed content write can always land on
        # 'failed' (there is no edge out of 'ready').
        entry = await account.deployments_publish(
            org_id,
            project_id,
            pipeline,
            self._actor(),
            comment=str(args.get('comment') or ''),
            metadata=metadata,
        )
        # The content beside the artifact: the files the block declares and
        # the readme references, in their layout. The registry row was
        # allocated first because the version names the content paths; a
        # declared file the zip lacks, or a failed write, flips the row
        # 'failed' (the rail refuses to serve that state) and surfaces the
        # cause by name, as the app door does.
        try:
            await write_pipe_content(org_id, self._account_info.userId, entry, bundle, store_block)
        except Exception as exc:
            try:
                await account.set_artifact_state(org_id, project_id, entry['version'], 'failed', self._actor())
                marked = 'marked failed'
            except Exception as flip_exc:
                debug(f'[DEPLOY] could not flip {project_id} v{entry["version"]} to failed: {flip_exc}')
                marked = f'could not be marked failed: {flip_exc}'
            raise ValueError(
                f'deploy failed while storing the bundle content (version {entry["version"]} {marked}): {exc}'
            ) from exc
        if not account.review_ladder:
            # No reviewer exists: the deployer's version is approved as it is
            # stored, the same posture the app door takes on OSS
            entry = await account.set_artifact_state(org_id, project_id, entry['version'], 'ready', self._actor())
        await self._withdraw_stale_submissions(org_id, project_id, int(entry['version']))
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
        body: Dict[str, Any] = {'artifact': entry, 'orgId': org_id, 'fullName': full_name}
        await self._notify_deploy_changed(org_id, '', project_id, 'add')
        if deploy_team:
            # One-step add+deploy onto the target read above. The store takes
            # its gate on this door too: on a review-ladder server the version
            # just added is a draft, so it cannot go public
            if deploy_team == PUBLIC_AUDIENCE:
                await self._require_store_publishable(org_id, project_id, int(entry['version']))
            dep = await account.deployments_deploy(
                org_id, deploy_team, project_id, entry['version'], self._actor(), billing_team
            )
            self._scheduler.sync(org_id, dep)
            body['deployment'] = self._describe(dep)
            await self._notify_deploy_changed(org_id, deploy_team, project_id, 'deploy')
        return self.build_response(request, body=body)

    async def _withdraw_stale_submissions(self, org_id: str, project_id: str, new_version: int) -> None:
        """Withdraw every OLDER version of the name still in review (submit -> private).

        Deploying supersedes pending reviews (plan S8, the app door's rule):
        a new version makes older submissions stale by definition, and
        leaving them queued spends review effort on code that is already
        replaced, or approves a version the publisher moved past. Best-effort
        per row: the deploy itself already succeeded.
        """
        try:
            rail = await account.deployments_versions(org_id, project_id)
        except Exception:
            rail = []
        for row in rail:
            row_version = int(row.get('version', 0))
            if row_version >= new_version or str(row.get('state') or '') != 'submit':
                continue
            try:
                await account.set_artifact_state(org_id, project_id, row_version, 'private', self._actor())
                debug(
                    f'[DEPLOY] withdrew the stale review of {project_id} v{row_version} (superseded by v{new_version})'
                )
                # The stale version left the queue: reviewer badges drop it live
                await broadcast_review_state(self._server, org_id, project_id, row_version, 'private')
            except Exception as exc:
                debug(f'[DEPLOY] could not withdraw {project_id} v{row_version}: {exc}')

    # =========================================================================
    # DELETE (remove one deployed version from the server)
    # =========================================================================

    async def _deploy_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The ONE delete door: remove a deployed version of any kind (plan 2.3).

        Apps and pipes alike address the registry name + version. The
        account layer refuses while anything points at the version (a rung
        pins it, it is in review, its build is queued/running) and
        otherwise removes ALL of its storage — the registry JSON, the whole
        sibling content dir, the registry entry — leaving the history's
        deploy line plus a delete line; the number is never reused.

        Permission: the deploy permission on the artifact's org, i.e. the
        gate ``add`` applies — ``task.control`` on at least one membership
        team (an org admin holds it on every team). Deleting is destructive
        for every rung that could later be pointed at the version, so the
        org-open posture the app add verb takes is deliberately NOT enough
        here.
        """
        project_id = self._registry_id(args.get('projectId'))
        version = args.get('version')
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValueError('version is required and must be a positive integer')
        if not self._teams_with('task.control'):
            raise PermissionError("Permission 'task.control' denied")
        org_id = self._org_id()

        body = await account.deployments_delete_version(org_id, project_id, version, self._actor())
        await account.audit(
            self._account_info.userId,
            'deploy',
            'deploy_delete',
            request_data={'projectId': project_id, 'version': version},
            org_id=org_id,
        )
        # Registry rails re-fetch on the org-scoped signal (nothing served
        # the version, so there is no hold to release and no scheduler row)
        await self._notify_deploy_changed(org_id, '', project_id, 'delete')
        body = {**body, 'orgId': org_id}
        return self.build_response(request, body=body)

    # =========================================================================
    # READS
    # =========================================================================

    async def _deploy_versions(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The org-registry versions of a project (the version strip)."""
        project_id = self._registry_id(args.get('projectId'))

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
        project_id = self._registry_id(args.get('projectId'))
        version = args.get('version')
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
        project_id = self._registry_id(args.get('projectId'))
        # Unscoped history needs org membership only; a team-scoped trail
        # goes through the visibility model (admin: any scope; user: own
        # personal space + member teams).
        team_id = self._visible_team_ref(args) if args.get('teamId') else None

        # Paging happens in the BACKEND (SQL on saas): the trail is
        # append-only and unbounded, so it is never fully materialized here.
        body = await account.deployments_history(self._org_id(), project_id, team_id, args)

        # A pointer row names its audience: it carries the reader's rung and
        # handle like a deployment row; an org-wide row ('' teamId) none. A
        # publish row's own audience pair gets this reader's handle too
        if isinstance(body, dict) and isinstance(body.get('rows'), list):
            rows = [self._describe(r) if r.get('teamId') else r for r in body['rows']]
            body = {**body, 'rows': [self._with_audience_handle(r) for r in rows]}
        return self.build_response(request, body=body)
