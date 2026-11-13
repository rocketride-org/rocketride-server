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

"""
ProcessCommands: the DAP ``process`` command (plan section 3).

``process()`` is ``use()`` plus one request, sharing one resolver:

1. resolve to a control: a NAME walks the rungs (``@dev`` attach-only, then
   ``@me``, ``@team`` in the caller's team order, ``@public``) and starts a
   published rung from its artifact when nothing is live; a SPEC addresses
   the caller's own ``@dev`` presence, created when absent and otherwise
   reused, refused or REPOINTED per ``onChange`` (plan 3.4);
2. hold the control's engine (started again if it stopped);
3. with ``data`` (at most ``CONST_PROCESS_INLINE_MAX`` bytes): open a pipe,
   write, close it, all in process through the engine's data path, and
   return the close body; without ``data`` return the address so the SDK
   streams through the ordinary pipe open/write/close (a large payload, or
   any call with ``on_sse``, which ALWAYS streams so the SDK can subscribe
   by ``traceId`` before the first event);
4. leave the hold in place: the control expires on its own idle ttl.

The result carries the stamps of plan 3.1: ``token`` (the address),
``resolved`` (the rung, ``team`` names the answering team), ``version``
(absent on ``@dev``), ``engineKey``, ``specMatch``, ``converged``
(``none``/``started``/``repointed``), ``ignored`` (server-controlled
arguments a NAME call passed: ``threads``, ``args``, ``env``, ``ttl``) and
``warnings`` (``address_collision``, ``repoint_storm``) when any.

``timeout`` covers the request only, open to close. The server adds no
deadline of its own (plan 3.1).
"""

import asyncio
import uuid
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from ai.common.dap import DAPConn, TransportBase
from .engine_access import engine_for
from ai.constants import CONST_PROCESS_CLOSE_SECONDS, CONST_PROCESS_INLINE_MAX

from ..address import build_address, parse_address
from ..task_control import control_key
from ..types import TaskError

if TYPE_CHECKING:
    from ..task_control import TaskControl
    from ..task_server import TaskServer


# ==== Shapes ===================================================================

#: Arguments a NAME call may not set: the artifact and policy decide them (plan 1)
SERVER_CONTROLLED = ('threads', 'args', 'env', 'ttl')


class ProcessCommands(DAPConn):
    """
    DAP handler for ``process``: resolve, hold, deliver one request.

    The data path is the engine's own (``TaskEngine._send_data``), reached in
    process: the request never goes back through the client socket.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """No-op: all state lives on TaskConn via the other mixins."""
        pass

    # ==== The command ============================================================

    async def on_process(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle ``process``: one request to a named or inline pipeline.

        Args:
            request: The DAP request. ``arguments`` carry exactly one of
                ``name`` (the address) or ``pipeline`` (an inline spec), and
                optionally ``source``, ``team``, ``data`` (inline payload),
                ``objinfo``, ``mimetype``, ``timeout`` (seconds, open to
                close), ``onChange`` (spec calls), ``origin`` (spec calls),
                ``pipelineTraceLevel``, and the spec-only ``threads``/
                ``args``/``env``/``ttl``.

        Returns:
            The response: the close body (inline delivery) plus the stamps,
            or the stamps alone when the SDK streams.

        Raises:
            TaskError: TASK_INVALID_ARGUMENT, TASK_NOT_REGISTERED,
                TASK_SOURCE_REQUIRED, TASK_SPEC_CHANGED, TASK_PAYLOAD_TOO_LARGE,
                TASK_TIMEOUT, TASK_ENGINE_UNAVAILABLE.
            PermissionError: No permission, or outside a scoped key's endpoints.
        """
        # Step 1: exactly one of name / pipeline
        if not self._account_info:
            raise PermissionError('Not authenticated')
        args = request.get('arguments') or {}
        name, pipeline = args.get('name'), args.get('pipeline')
        if (name is None) == (pipeline is None):
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                'Pass exactly one of name, pipeline or filepath',
                field='name',
            )

        # Step 2: the inline payload fits, or the SDK streams it
        data = args.get('data')
        if isinstance(data, str):
            data = data.encode('utf-8')
        if data is not None and len(data) > CONST_PROCESS_INLINE_MAX:
            raise TaskError(
                TaskError.PAYLOAD_TOO_LARGE,
                f'Inline process() data is limited to {CONST_PROCESS_INLINE_MAX} bytes; stream it instead',
                limit=CONST_PROCESS_INLINE_MAX,
            )

        # Step 3: resolve to a control
        if name is not None:
            control, stamps = await self._resolve_name(args)
        else:
            control, stamps = await self._resolve_spec(request, args)

        # Step 4: deliver inline, or hand the address back for streaming
        body: Dict[str, Any] = {}
        if data is not None:
            body = await self._deliver(control, args, data, stamps['converged'])
        body.update(stamps)
        return self.build_response(request, body=body)

    # ==== Resolution =============================================================

    async def _resolve_name(self, args: Dict[str, Any]) -> 'tuple[TaskControl, Dict[str, Any]]':
        """
        A NAME call: the rungs, attach-only on ``@dev``, published rungs started when needed.

        Server-controlled arguments are not applied; they are listed in
        ``ignored`` so the same source runs unchanged in dev and production.
        """
        # Step 1: the address, with source= overriding its third segment
        parsed = parse_address(str(args.get('name')))
        source = args.get('source') or parsed.source
        address = build_address(parsed.developer_id, parsed.pipe_id, source)

        # Step 2: the rungs (team= overrides the caller's team order)
        control, started = await self._server.resolve_name(
            address, self._account_info, 'task.data', team=args.get('team') or None
        )

        # Step 3: the stamps
        ignored = [key for key in SERVER_CONTROLLED if args.get(key) is not None]
        return control, self._stamps(control, converged='started' if started else 'none', ignored=ignored)

    async def _resolve_spec(
        self, request: Dict[str, Any], args: Dict[str, Any]
    ) -> 'tuple[TaskControl, Dict[str, Any]]':
        """
        A SPEC call: the caller's ``@dev`` presence for the spec's address (plan 3.3).

        Runs the ordinary dev execute path (dev team, plans, env, the address
        grammar) with ``onChange`` (default ``'error'``), so an existing
        presence is reused, refused or repointed, never replaced.
        """
        # Step 1: execute as a dev run, onChange deciding over a live presence
        execute_args = {key: value for key, value in args.items() if key not in ('name', 'data', 'team')}
        execute_args['onChange'] = args.get('onChange') or 'error'
        execute = {**request, 'command': 'execute', 'arguments': execute_args}
        response = await self.on_execute(execute)
        result = response.get('body') or {}

        # Step 2: the caller's own @dev control under that address
        control = self._server.control_by_key(control_key('dev', self._account_info.userId, result['token']))
        stamps = self._stamps(
            control,
            converged=result.get('converged', 'none'),
            spec_match=result.get('specMatch', True),
            warnings=result.get('warnings'),
        )
        return control, stamps

    @staticmethod
    def _stamps(
        control: 'TaskControl',
        *,
        converged: str,
        spec_match: bool = True,
        ignored: Optional[List[str]] = None,
        warnings: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """The ``PROCESS_RESULT`` stamps of plan 3.1 for ``control``."""
        stamps: Dict[str, Any] = {
            'token': control.address,
            'resolved': f'@{control.rung}',
            'engineKey': control.task.engine_key if control.task is not None else '',
            'specMatch': spec_match,
            'converged': converged,
            'ignored': list(ignored or []),
        }
        if control.rung == 'team':
            stamps['team'] = control.owner_id
        if control.version is not None:
            stamps['version'] = control.version
        if warnings:
            stamps['warnings'] = list(warnings)
        return stamps

    # ==== Delivery ===============================================================

    async def _deliver(
        self, control: 'TaskControl', args: Dict[str, Any], data: bytes, converged: str
    ) -> Dict[str, Any]:
        """
        Open a pipe, write ``data``, close it, in process; the close body.

        The clock of ``timeout`` starts at the open and stops at the close.
        The open carries a server-minted ``correlationId`` (idempotent open,
        ALB seam 7). A failure after the open closes the pipe before raising.

        Raises:
            TaskError: TASK_TIMEOUT with ``address`` and ``converged``.
        """
        # Step 1: the engine (started again if it stopped, after the team
        # re-check), ready; the request is in flight through this control
        # until it returns, so its ttl cannot expire it mid-flight
        task = await engine_for(self, control, 'task.data')
        control.begin_request()
        await task.wait_for_running()

        async def _round_trip() -> Dict[str, Any]:
            """Open, write and close through the engine data path."""
            opened = await task._send_data(
                self._data_request(
                    {
                        'subcommand': 'open',
                        'object': self._objinfo(args.get('objinfo'), len(data)),
                        'mimeType': args.get('mimetype') or 'application/octet-stream',
                        'correlationId': uuid.uuid4().hex,
                    }
                )
            )
            pipe_id = (opened.get('body') or {}).get('pipe_id')
            try:
                await task._send_data(self._data_request({'subcommand': 'write', 'pipe_id': pipe_id, 'data': data}))
            except BaseException:
                await self._close_quietly(task, pipe_id)
                raise
            closed = await task._send_data(self._data_request({'subcommand': 'close', 'pipe_id': pipe_id}))
            return dict(closed.get('body') or {})

        # Step 2: the request, bounded only by the caller's timeout
        timeout = args.get('timeout')
        try:
            if timeout is None:
                return await _round_trip()
            return await asyncio.wait_for(_round_trip(), float(timeout))
        except asyncio.TimeoutError:
            raise TaskError(
                TaskError.TIMEOUT,
                f'process() on {control.address!r} exceeded its timeout of {timeout}s',
                address=control.address,
                converged=converged,
            ) from None
        finally:
            control.end_request()

    async def _close_quietly(self, task: Any, pipe_id: Any) -> None:
        """
        Close a pipe after a failed write, bounded, never raising.

        The failure that got here (a timeout cancelling the write, a refused
        write) is what the caller sees; the close is cleanup and gets
        ``CONST_PROCESS_CLOSE_SECONDS`` at most, so a cancelled request is
        never held open by an engine that does not answer the close.
        """
        close = self._data_request({'subcommand': 'close', 'pipe_id': pipe_id})
        try:
            await asyncio.wait_for(asyncio.shield(task._send_data(close)), CONST_PROCESS_CLOSE_SECONDS)
        except BaseException as exc:  # noqa: BLE001 - cleanup must not replace the original failure
            self.debug_message(f'process(): closing pipe {pipe_id} after a failed write did not complete: {exc!r}')

    def _data_request(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """One ``rrext_process`` request for the engine's data path."""
        return self.build_request('rrext_process', arguments=arguments)

    @staticmethod
    def _objinfo(objinfo: Optional[Dict[str, Any]], size: int) -> Dict[str, Any]:
        """The object info with its size (never 0: the parse filter skips "empty")."""
        out = dict(objinfo or {})
        out['size'] = size or 1
        return out
