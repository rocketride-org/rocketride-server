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
# Dispatches on ``arguments.subcommand`` (chapters / read / segment / delete),
# the same shape as rrext_store and rrext_deploy. Streams are addressed by the plain
# identity tuple (projectId + source + runKind) — NEVER by token: tokens are
# credentials and appear nowhere in the log system.
# =============================================================================

from typing import TYPE_CHECKING, Any, Dict

from ai.account import Store
from ai.common.dap import DAPConn, TransportBase
from ai.modules.task.run_log import RunLogReader

if TYPE_CHECKING:
    from ..task_server import TaskServer

# Run kinds a stream may be addressed by (separate continua per kind).
_VALID_RUN_KINDS = frozenset({'dev', 'deploy'})


# =============================================================================
# LOG COMMANDS MIXIN
# =============================================================================


class LogCommands(DAPConn):
    """
    DAP router for the ``rrext_log`` command.

    Provides ``on_rrext_log`` which dispatches on ``arguments.subcommand`` to
    the matching ``_log_*`` handler. Permissions differ per subcommand
    (``task.monitor`` for reads, ``task.control`` for the destructive
    delete), so each handler verifies its own permission. All access is
    scoped to the authenticated user's own streams in v1 — the store paths
    are derived from ``self._account_info.userId``, never from caller input.
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

    def _reader_for(self, args: Dict[str, Any]) -> RunLogReader:
        """
        Build a reader for the stream named by the identity-tuple arguments.

        Args:
            args: Must contain ``projectId``, ``source``, ``runKind``.

        Returns:
            A RunLogReader scoped to the CALLER's user id.

        Raises:
            ValueError: On missing/invalid identity arguments.
        """
        project_id = args.get('projectId')
        source = args.get('source')
        run_kind = args.get('runKind')

        if not project_id:
            raise ValueError('projectId is required')
        if not source:
            raise ValueError('source is required')
        if run_kind not in _VALID_RUN_KINDS:
            raise ValueError(f'runKind must be one of {sorted(_VALID_RUN_KINDS)}')

        # Store scoping comes from the AUTHENTICATED user, never from input:
        # v1 serves each caller their own streams only. .logs is a SYSTEM
        # TREE — the file API denies it to every session identity — so the
        # reader acts through an INTERNAL identity anchored at the caller's
        # namespace. The DOMAIN permission gate is this command layer's own
        # verify_permission('task.monitor'/'task.control') checks above.
        from ai.account import RequestContext

        return RunLogReader(
            Store.file_store(RequestContext.internal('log-reader'), client_id=self._account_info.userId),
            self._account_info.userId,
            project_id,
            source,
            run_kind,
        )

    # =========================================================================
    # SUBCOMMAND HANDLERS
    # =========================================================================

    # ── chapters ─────────────────────────────────────────────────────────────

    async def _log_chapters(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        List a stream's chapters (tracks) + activity-bar metadata.

        Each chapter carries begin date/time, end date/time, and the starting
        seq (+ outcome); segments contribute the activity spans; stream
        start/end + horizon complete the timeline — everything the UI needs
        from ONE small read, no segment access.
        """
        self.verify_permission('task.monitor')

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
        self.verify_permission('task.monitor')

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
        self.verify_permission('task.monitor')

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
        self.verify_permission('task.control')

        before_time = args.get('beforeTime')
        delete_all = bool(args.get('all'))
        if before_time is None and not delete_all:
            raise ValueError('Either beforeTime or all is required')

        try:
            body = await self._reader_for(args).delete(before_time=before_time, delete_all=delete_all)
        except FileNotFoundError:
            body = {'deletedSegments': 0}
        return self.build_response(request, body=body)
