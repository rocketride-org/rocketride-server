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
# CMD LOG — DAP router for the rrext_log command
#
# ONE read path over the per-task run-log continuum: EaaS serves every log
# read (live and completed alike) by composing store segments + local spool
# via the stream's control file — clients never touch storage directly.
# Dispatches on ``arguments.subcommand`` (streams / chapters / read / segment /
# delete), the same shape as rrext_store and rrext_deploy. Streams are addressed by the plain
# identity pair (projectId + source) — NEVER by token: tokens are
# credentials and appear nowhere in the log system. The SCOPE IS THE OWNER:
# ``owner`` (the string a task row carries) names the tree the run lives in;
# without it ``teamId`` names a deployment's audience, and absent both the
# caller's own tree, ``runKind`` picking its dev or @me continuum. A pinned
# version's run (``version``) is a stream of its own.
# =============================================================================

import asyncio
from typing import TYPE_CHECKING, Any, Dict, Optional, Tuple

from ai.account import Store
from ai.account.audience import compose_owner, deploy_scope_of, parse_audience, parse_owner
from ai.account.models import resolve_org_permissions, resolve_task_permissions
from ai.account.roots import KIND_ORG, KIND_TEAM, KIND_USER
from ai.common.dap import DAPConn, TransportBase
from ai.modules.task.run_log import RunLogReader

from ..address import in_endpoint_scope

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# LOG COMMANDS MIXIN
# =============================================================================


class LogCommands(DAPConn):
    """
    DAP router for the ``rrext_log`` command.

    Provides ``on_rrext_log`` which dispatches on ``arguments.subcommand`` to
    the matching ``_log_*`` handler. Permissions differ per subcommand
    (``task.monitor`` for reads, ``task.control`` for the destructive
    delete), so each handler verifies its own permission. Unscoped requests
    serve the caller their OWN streams; ``owner`` (or a deployment's
    audience in ``teamId``) targets another owner's tree, gated by the
    watchers of plan 8.3 (``_verify_log_access``).
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """Initialise the log subcommand handler lookup table."""
        # Map of log subcommand names to handler methods. All other state
        # (account info, server, transport) lives on TaskConn via the other
        # mixins, so nothing else is set up here.
        self._log_subcommand_handlers = {
            'streams': self._log_streams,
            'chapters': self._log_chapters,
            'read': self._log_read,
            'segment': self._log_segment,
            'delete': self._log_delete,
        }

    # =========================================================================
    # DISPATCHER
    # =========================================================================

    async def on_rrext_log(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the DAP ``rrext_log`` command — run-log continuum access.

        Extracts ``arguments.subcommand`` and routes to the matching
        ``_log_*`` handler. Permission checks live in each handler because
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

            # Dispatch to the appropriate handler, passing pre-extracted args.
            if handler := self._log_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Log operation failed: {str(e)}')
            raise

    # =========================================================================
    # SHARED RESOLUTION
    # =========================================================================

    def _scope_for(self, args: Dict[str, Any]) -> Tuple[str, str]:
        """
        Resolve the stream scope from the addressing arguments: the run's OWNER and its continuum.

        ``owner`` is the owner string a task row carried (``=user/<uid>``,
        ``=team/<tid>`` or ``=org/<oid>``, plan 2.5), passed back unchanged:
        the tree the run's log lives in, whatever team it was billed to (an
        ``@me`` deploy run's row names its billing team in ``teamId``, its
        logs live in its owner's tree). A team or org owner is always the
        deploy continuum; a user owner's continuum is ``runKind`` (absent:
        dev).

        Without ``owner``, ``teamId`` names a publication's audience the way a
        deployment row carries it: ``=team/<tid>`` (or a bare team id) is that
        team's continuum, the caller's own ``=user/<uid>`` their personal
        deploy continuum, ``=org/<oid>`` the org's. Absent both, the scope is
        the caller's OWN tree, where ``runKind`` picks the continuum:
        absent/'dev' is the dev stream, 'deploy' the caller's personal @me
        deploy stream.

        Args:
            args: The subcommand arguments.

        Returns:
            ``(owner, run_kind)``.

        Raises:
            ValueError: An owner or audience this reader cannot address (the
                store, a malformed string).
        """
        caller = str(self._account_info.userId or '')
        owner = str(args.get('owner') or '')
        run_kind = 'deploy' if args.get('runKind') == 'deploy' else 'dev'
        if owner:
            decoded = parse_owner(owner)
            return compose_owner(decoded.kind, decoded.id), (run_kind if decoded.kind == KIND_USER else 'deploy')
        team_id = str(args.get('teamId') or '')
        if team_id.startswith(('@', '=')):
            decoded = parse_audience(team_id)
            if decoded.kind == KIND_ORG:
                return compose_owner(KIND_ORG, decoded.id), 'deploy'
            team, kind = deploy_scope_of(team_id, caller)
            return (compose_owner(KIND_TEAM, team) if team else compose_owner(KIND_USER, caller)), kind
        if team_id:
            return compose_owner(KIND_TEAM, team_id), 'deploy'
        if not caller:
            raise PermissionError('Not authenticated')
        return compose_owner(KIND_USER, caller), run_kind

    def _verify_log_access(self, args: Dict[str, Any], perm: str) -> None:
        """
        The permission gate for every log subcommand: the watchers of plan 8.3.

        A user-owned run's log is its owner's alone (sys.admin and internal
        identities pass); a team-owned run's is read with ``perm`` on THAT
        team — membership is the read/write right, exactly the deployment
        model; an org-owned run's is the active org's admins'. Denials are
        uniform: a foreign or unknown owner reads the same as a permission
        miss (no existence leak).

        Args:
            args: The subcommand arguments (``owner``, ``teamId``, ``runKind``).
            perm: 'task.monitor' for reads, 'task.control' for delete.

        Raises:
            PermissionError: Caller lacks ``perm`` in the resolved scope, or
                the key's endpoints scope excludes the stream's address.
        """
        # Step 1: resolve the owner the request addresses
        owner, _ = self._scope_for(args)
        decoded = parse_owner(owner)

        # Step 2: the owner's watchers
        sys_perms = self._account_info.sysPermissions or []
        operator = 'sys.admin' in sys_perms or 'internal' in sys_perms
        if decoded.kind == KIND_TEAM:
            self.verify_team_permission(decoded.id, perm)
        elif decoded.kind == KIND_ORG:
            org = self._account_info.organization or {}
            if not operator and (
                str(org.get('id') or '') != decoded.id or not resolve_org_permissions(self._account_info)
            ):
                raise PermissionError("Access denied: the org's run logs are its admins'")
        elif decoded.id == self._account_info.userId:
            self.verify_permission(perm)
        elif not operator:
            raise PermissionError("Access denied: a personal run log is its owner's")

        # Step 3: a key with an endpoints scope reaches only the streams of
        # the addresses inside it.
        self._verify_log_endpoint_scope(args)

    def _verify_log_endpoint_scope(self, args: Dict[str, Any]) -> None:
        """
        Apply the API key's ``endpoints`` scope to the stream a request names.

        Team permissions say WHOSE logs the caller may read; the scope says
        WHICH addresses this credential may reach at all, and the permission
        resolvers never look at it. A stream is the log of the address
        ``developerId.projectId.source``: every run in the caller's own tree
        and in its org's teams was started under the org's developer id. A
        stream outside the scope (or an address that does not parse, such as
        a missing projectId) is denied exactly like a permission miss, so a
        scoped key holding ``task.monitor`` cannot replay other runs.

        Args:
            args: The subcommand arguments (``projectId`` and ``source``).

        Raises:
            PermissionError: The key's endpoints scope excludes the stream.
        """
        # Step 1: an unscoped key reaches every stream its permissions allow.
        endpoints = getattr(self._account_info, 'endpoints', None)
        if endpoints is None:
            return

        # Step 2: the stream's address under the caller's developer namespace.
        org = self._account_info.organization or {}
        address = f'{org.get("developerId") or ""}.{args.get("projectId") or ""}.{args.get("source") or ""}'

        # Step 3: outside the scope reads the same as any other denial.
        if not in_endpoint_scope(endpoints, address):
            raise PermissionError('This API key is scoped to other endpoints')

    def _reader_for(self, args: Dict[str, Any]) -> RunLogReader:
        """
        Build a reader for the stream named by the addressing arguments.

        Args:
            args: Must contain ``projectId`` and ``source``; ``owner`` (or
                ``teamId``) and ``runKind`` select the continuum (see
                ``_scope_for``); ``version`` a pinned version's stream.

        Returns:
            A RunLogReader over the OWNER's tree (permission-checked by the
            handler).

        Raises:
            ValueError: On missing/invalid identity arguments.
        """
        project_id = args.get('projectId')
        source = args.get('source')

        if not project_id:
            raise ValueError('projectId is required')
        if not source:
            raise ValueError('source is required')
        owner, run_kind = self._scope_for(args)
        version = args.get('version')
        if version is not None and (isinstance(version, bool) or not isinstance(version, int) or version < 1):
            raise ValueError('version must be a positive integer')

        # The owner is permission-checked at the handler before this runs.
        # .logs is a SYSTEM TREE — the file API denies it to every session
        # identity — so the reader acts through an INTERNAL identity; the
        # reader's scope helper turns the owner into its '=<kind>/<id>/'
        # prefix, the same one the writer wrote under. The DOMAIN permission
        # gate is _verify_log_access above.
        from ai.account import RequestContext

        return RunLogReader(
            Store.file_store(RequestContext.internal('log-reader'), client_id=parse_owner(owner).id),
            owner,
            project_id,
            source,
            run_kind,
            version=version,
        )

    # =========================================================================
    # SUBCOMMAND HANDLERS
    # =========================================================================

    def _scope(self, run_kind: str, team: Optional[Dict[str, Any]] = None, org: str = '') -> Dict[str, Any]:
        """One place a stream can live: a team's tree, the org's, or the caller's own."""
        if org:
            kind, ident = KIND_ORG, org
        elif team:
            kind, ident = KIND_TEAM, str(team['id'])
        else:
            kind, ident = KIND_USER, str(self._account_info.userId or '')
        return {
            'teamId': team['id'] if team else '',
            'teamName': team.get('name', '') if team else '',
            'runKind': run_kind,
            'ownerKind': kind,
            'owner': compose_owner(kind, ident),
        }

    # ── streams ──────────────────────────────────────────────────────────────

    async def _log_streams(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """The published-version continuum of one source in each scope the caller may read, with its
        chapters: own dev, own @me deploy, each team deploy the caller can monitor, then the org's for an
        org admin. A pinned version's continuum (C.36) is not listed: a reader opens it with ``version``.
        Never-logged scopes are left out.
        """
        self.verify_permission('task.monitor')
        self._verify_log_endpoint_scope(args)

        # Own tree first (dev run, @me deploy), then the deploy stream of each team the caller can monitor.
        org = self._account_info.organization or {}
        scopes = [self._scope(kind) for kind in ('dev', 'deploy')]
        scopes += [
            self._scope('deploy', team)
            for team in org.get('teams', [])
            # Same resolver as verify_team_permission: nothing listed here could be denied on a direct read.
            if 'task.monitor' in resolve_task_permissions(self._account_info, team['id'])
        ]
        if org.get('id') and resolve_org_permissions(self._account_info):
            scopes.append(self._scope('deploy', org=str(org['id'])))

        identity = {'projectId': args.get('projectId'), 'source': args.get('source')}
        # One control-file read per scope, a few at a time: an org admin can monitor every team.
        limit = asyncio.Semaphore(8)

        async def chapters_of(scope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            async with limit:
                try:
                    return await self._reader_for(
                        {**identity, 'owner': scope['owner'], 'runKind': scope['runKind']}
                    ).chapters()
                except FileNotFoundError:
                    return None

        bodies = await asyncio.gather(*(chapters_of(scope) for scope in scopes))
        streams = [{**scope, **body} for scope, body in zip(scopes, bodies) if body is not None]
        return self.build_response(request, body={'streams': streams})

    # ── chapters ─────────────────────────────────────────────────────────────

    async def _log_chapters(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        List a stream's chapters (tracks) + activity-bar metadata.

        Each chapter carries begin date/time, end date/time, and the starting
        seq (+ outcome); segments contribute the activity spans; stream
        start/end + horizon complete the timeline — everything the UI needs
        from ONE small read, no segment access.
        """
        self._verify_log_access(args, 'task.monitor')

        try:
            body = await self._reader_for(args).chapters()
        except FileNotFoundError:
            # A never-logged stream is an empty timeline, not an error.
            body = {
                'chapters': [],
                'segments': [],
                'startTime': None,
                'endTime': None,
                'horizonSeq': 0,
                'completed': True,
            }
        return self.build_response(request, body=body)

    # ── read ─────────────────────────────────────────────────────────────────

    async def _log_read(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Ranged, paged event read over the continuum.

        Range forms: ``fromSeq``/``toSeq``, ``fromTime``/``toTime`` (omit the
        upper bound for "to now"), ``fromTime``→``toSegment``. ``cursor``
        continues a previous page. ``types`` filters server-side. Responses
        carry ``nextSeq`` when paged and ``truncatedAtSeq`` when the request
        reached below the retention horizon.
        """
        self._verify_log_access(args, 'task.monitor')

        reader = self._reader_for(args)
        try:
            body = await reader.read(
                from_seq=args.get('fromSeq'),
                to_seq=args.get('toSeq'),
                from_time=args.get('fromTime'),
                to_time=args.get('toTime'),
                to_segment=args.get('toSegment'),
                cursor=args.get('cursor'),
                max_events=args.get('maxEvents') or 0,
                max_bytes=args.get('maxBytes') or 0,
                types=args.get('types'),
            )
        except FileNotFoundError:
            body = {'events': []}
        return self.build_response(request, body=body)

    # ── segment ──────────────────────────────────────────────────────────────

    async def _log_segment(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Raw JSONL bytes of ONE segment, chunked by byte offset.

        The DVR v2 bulk path: no server-side line scanning, filtering, or
        parsing — the immutable segment content is handed over as-is in
        whole-line-aligned chunks (each response ends on a newline, so the
        client parses every chunk standalone). Repeat with the returned
        ``nextOffset`` until ``final``. The active segment is served up to
        its current length; the live subscription covers growth past that.
        """
        self._verify_log_access(args, 'task.monitor')

        segment = args.get('segment')
        if segment is None:
            raise ValueError('segment is required')

        try:
            body = await self._reader_for(args).segment_raw(
                int(segment),
                offset=int(args.get('offset') or 0),
                max_bytes=int(args.get('maxBytes') or 0),
            )
        except FileNotFoundError:
            # A missing segment (evicted / never existed) is an empty final
            # chunk, not an error — the client's coverage map handles it.
            body = {
                'segment': int(segment),
                'offset': 0,
                'data': '',
                'size': 0,
                'nextOffset': None,
                'final': True,
            }
        return self.build_response(request, body=body)

    # ── delete ───────────────────────────────────────────────────────────────

    async def _log_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete log data for a stream (destructive — ``task.control``).

        ``beforeTime``: drop segments wholly older than the cutoff (control
        file consulted for what to delete), trim chapters, advance the
        horizon. ``all: true``: remove every segment and the control file.
        Deletes hit BOTH locations (store + spool) with the lease/ordering
        disciplines; a live stream's mutation routes through its writer.
        """
        self._verify_log_access(args, 'task.control')

        before_time = args.get('beforeTime')
        delete_all = bool(args.get('all'))
        if before_time is None and not delete_all:
            raise ValueError('Either beforeTime or all is required')

        try:
            body = await self._reader_for(args).delete(before_time=before_time, delete_all=delete_all)
        except FileNotFoundError:
            body = {'deletedSegments': 0}
        return self.build_response(request, body=body)
