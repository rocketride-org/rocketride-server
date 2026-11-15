"""
DataCommands: DAP Data Processing Interface for Task Communication.

This module implements a DAP-based data processing interface that enables clients
to send data processing requests to active computational tasks. It serves as the
communication bridge for data exchange between DAP clients and running task instances,
facilitating real-time data processing and response handling.

Primary Responsibilities:
--------------------------
1. Handles DAP 'rrext_process' commands for data processing requests
2. Manages authentication and task identification for data access
3. Ensures tasks are in running state before processing data requests
4. Forwards data processing requests to appropriate task instances
5. Returns processed results back to requesting clients via DAP protocol
6. Provides error handling and logging for data processing operations

Use Cases:
----------
- Real-time data analysis requests to running computational tasks
- Interactive data processing sessions with task instances
- Client-server data exchange in distributed computing environments
- Dynamic data queries and transformations on active tasks

Architecture:
-------------
This module works in conjunction with TaskServer to:
- Authenticate clients using API keys
- Locate and validate target task instances
- Ensure task readiness before data processing
- Facilitate bidirectional data communication
- Handle processing errors and edge cases
"""

import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Optional

from ai.account.base import OutOfCreditsError
from ai.common.dap import DAPConn, TransportBase

from .. import caller_stamp
from ..task_control import OpenPipe
from .engine_access import engine_for, wait_running

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_control import TaskControl
    from ..task_engine import TaskEngine
    from ..task_server import TaskServer


# ==== The binding a frame belongs to ===============================================


@dataclass
class _Frame:
    """
    Where one data frame runs and under which request id.

    Attributes:
        engine: The engine the frame goes to (the control's hold for a new
            binding; the recorded engine for a frame of an open pipe).
        correlation_id: The server-minted request id of the binding.
        params: The admitted per-call params, per node (an open only).
    """

    engine: 'TaskEngine'
    correlation_id: str
    params: Optional[Dict[str, Dict[str, Any]]] = None
    record: Optional[OpenPipe] = None


class DataCommands(DAPConn):
    """
    DAP command handler for data processing requests to computational tasks.

    This class processes DAP 'rrext_process' commands to facilitate data exchange
    between clients and running task instances. It handles authentication,
    task validation, and data forwarding while maintaining DAP protocol
    compliance for seamless integration with debugging and monitoring tools.

    Key Features:
    - Authenticated data processing requests using API keys
    - Task state validation before processing (ensures tasks are running)
    - Direct data forwarding to target task instances
    - Error handling with comprehensive logging
    - DAP-compliant request/response handling

    Workflow:
    1. Receive 'rrext_process' DAP command from client
    2. Extract authentication credentials and task identification
    3. Validate task exists and is in running state
    4. Forward data processing request to target task
    5. Return processed results to client
    6. Handle and log any processing errors

    Attributes:
        _server: Reference to TaskServer for task lookup and management
        connection_id: Unique identifier for this data processing connection
        transport: Underlying transport mechanism for DAP communication
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new DataCommands instance for data processing operations.

        Sets up the data processing command handler with connection to the
        task management server and establishes the DAP communication transport.

        Args:
            connection_id (int): Unique identifier for this data processing connection
            server (TaskServer): The server instance managing task lifecycle and access
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_rrext_process(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_process': one frame of the data path (open, write, close, tool).

        Every frame belongs to a BINDING. An ``open`` (or a standalone ``tool``
        call that names no pipe) starts one: it resolves the caller's control,
        takes the engine under its hold and mints the request id. A frame that
        names a ``pipe_id`` attaches to a binding this control already has
        open, through the control's open-pipe record (plan 3.1 P1/P2).

        Args:
            request: The DAP request; ``arguments.subcommand`` selects the frame
                kind, ``arguments.pipe_id`` names an open binding.

        Returns:
            The engine's response body in an envelope keyed off this request.

        Raises:
            PermissionError: The caller has no access, or names a pipe that is
                not open on their control.
            TaskError: The engine could not start, or the params were rejected.
            OutOfCreditsError: The control's paying unit is out of credit.
        """
        try:
            arguments = request.get('arguments')
            if not isinstance(arguments, dict):
                raise ValueError('arguments must be an object')
            subcommand = arguments.get('subcommand')
            pipe_id = arguments.get('pipe_id')

            # Step 1: the caller's control for the address
            control = await self._control_for(request, subcommand)

            # Step 2: the binding this frame belongs to: a new one, or the one
            # the named pipe was opened on
            if pipe_id is None:
                frame = await self._new_binding(control, arguments)
            else:
                frame = self._attached_binding(control, pipe_id)

            # Step 3: forward with the caller stamped, as activity of this control;
            # a close retires its record whatever the engine answered
            succeeded = False
            try:
                body = await self._forward(control, frame, request, arguments)
                succeeded = True
            finally:
                if subcommand == 'close' and pipe_id is not None:
                    self._retire(control, pipe_id, succeeded)

            # Step 4: a successful open is a binding the control now has open;
            # a standalone tool call was a binding that opened and closed
            if subcommand == 'open':
                self._record_open(control, frame, body)
            elif subcommand == 'tool' and pipe_id is None:
                self._note_borrowed(control, body)

            # The envelope is keyed off the INBOUND request so the inbound
            # DAPConn correlates it to the originating client (_send_data
            # builds its own outbound packet with a fresh seq)
            return self.build_response(request, body=body)
        except Exception as e:
            # The context for debugging; the client gets the original error
            self.debug_message(f'Failed to process data request: {str(e)}')
            raise

    # ==== The steps ===================================================================

    async def _control_for(self, request: Dict[str, Any], subcommand: Optional[str]) -> 'TaskControl':
        """
        The caller's control for the request's address.

        An OPEN resolves the way submit() does: the live run on the first rung
        that answers, or the publication started from its artifact (plan 3.2,
        one resolver for every verb). Every other frame ATTACHES only: it must
        land on the control the open found, never start a publication a
        colder rung could not.

        Args:
            request: The DAP request.
            subcommand: The frame kind.

        Returns:
            The resolved control.
        """
        if subcommand == 'open':
            return await self.resolve_control_or_start(request, 'task.data')
        return self.get_control(request, 'task.data')

    async def _new_binding(self, control: 'TaskControl', arguments: Dict[str, Any]) -> '_Frame':
        """
        Start a binding: an open, or a standalone tool call.

        Args:
            control: The caller's control.
            arguments: The frame's arguments; ``params`` is consumed here.

        Returns:
            The frame: the engine under the control's hold, a fresh request id,
            and the admitted per-call params.

        Raises:
            TaskError: TASK_PARAM_REJECTED, or the engine could not start.
            OutOfCreditsError: The paying unit is out of credit.
        """
        # Step 1: the engine under the control's hold, started again when it
        # stopped on its inactivity timer (plan 7.2) after the caller's team
        # access is re-checked
        engine = await engine_for(self, control, 'task.data')

        # Step 2: per-call params enter by the open: admitted by public name
        # against the control's parameters map, then by value against the
        # node's descriptors (plan 5.4 item 5); a rejected key never reaches
        # the engine
        params = control.resolve_params(control.check_params(arguments.pop('params', None)))

        # Step 3: credit, on the control's paying unit, before any bytes reach
        # the subprocess (plan 0 S9); the engine-side gate stays for the
        # bindings EaaS never sees
        await self._require_credit(control)

        # Step 4: a server-minted request id; a client never names another
        # request's binding (ALB seam 7)
        return _Frame(engine=engine, correlation_id=uuid.uuid4().hex, params=params)

    @staticmethod
    def _attached_binding(control: 'TaskControl', pipe_id: Any) -> '_Frame':
        """
        The binding a write/close/tool frame names, from the control's open-pipe record.

        The record is the ownership check and the engine pin (plan 3.1 P1/P2):
        a slot that is not open on the CALLER's control is refused here, never
        forwarded (on a shared engine the slot number alone must never reach
        the subprocess), and the frame goes to the engine the pipe opened on,
        whatever the control holds now.

        Args:
            control: The caller's control.
            pipe_id: The slot the frame names.

        Returns:
            The frame on the recorded engine, under the open's request id.

        Raises:
            PermissionError: The slot is not open on this control.
        """
        record = control.open_pipes.get(pipe_id)
        if record is None:
            raise PermissionError(f'Pipe {pipe_id} is not open on your control for {control.address!r}')
        return _Frame(engine=record.engine, correlation_id=record.correlation_id, record=record)

    async def _forward(
        self, control: 'TaskControl', frame: '_Frame', request: Dict[str, Any], arguments: Dict[str, Any]
    ) -> Any:
        """
        Send one frame to its engine with the caller stamped; return the engine's body.

        Args:
            control: The caller's control.
            frame: The binding the frame belongs to.
            request: The inbound DAP request (its envelope is reused).
            arguments: The frame's arguments as the client sent them.

        Returns:
            The engine's response body.
        """
        # Step 1: strip-then-inject the caller context (plan 5.3): every
        # reserved key the client sent is removed, the server's _caller set
        stamped = caller_stamp.prepare(
            self, control, arguments, correlation_id=frame.correlation_id, params=frame.params
        )
        # An open carries its request id in the clear too: the engine's
        # idempotent open keys on it (ALB seam 7)
        if arguments.get('subcommand') == 'open':
            stamped['correlationId'] = frame.correlation_id
        # The bytes a write carries count toward this control's own totals
        if arguments.get('subcommand') == 'write' and frame.record is not None:
            frame.record.bytes += len(arguments.get('data') or b'')
        forwarded = dict(request)
        forwarded['arguments'] = stamped

        # Step 2: the request is activity of THIS control only, and in flight
        # through it until the answer comes back: its idle clock is held
        # meanwhile, so a request longer than the ttl is never expired
        # mid-flight; another holder of the engine keeps aging
        control.begin_request()
        try:
            # A start that never confirms running is engine_start_failed
            await wait_running(frame.engine)
            response = await frame.engine._send_data(forwarded)
        finally:
            control.end_request()
        return response.get('body')

    def _record_open(self, control: 'TaskControl', frame: '_Frame', body: Any) -> None:
        """
        Record a successful open on the control: the slot, its engine and its request tree.

        The tree is CLAIMED for the control (plan 7.5): its pipe-tagged events
        route to this control only, the opener connection first.

        Args:
            control: The caller's control.
            frame: The binding the open started.
            body: The engine's open response (``pipe_id``, wire ``traceId``).
        """
        if not isinstance(body, dict) or body.get('pipe_id') is None:
            return
        trace_id = str(body.get('traceId') or '')
        control.open_pipes[body['pipe_id']] = OpenPipe(
            engine=frame.engine, trace_id=trace_id, correlation_id=frame.correlation_id
        )
        control.stats.totalCount += 1
        self._server.trace_owners.claim(trace_id, control.key, self._connection_id)

    def _retire(self, control: 'TaskControl', pipe_id: Any, succeeded: bool) -> None:
        """
        A close went through (or failed): the slot's record is retired and the binding counted.

        Args:
            control: The caller's control.
            pipe_id: The closed slot.
            succeeded: Whether the engine accepted the close.
        """
        record = control.open_pipes.pop(pipe_id, None)
        if record is None:
            return
        # Step 1: the control's own counts (plan 7.5): what its bindings did
        if succeeded:
            control.stats.completedCount += 1
            control.stats.completedSize += record.bytes
        else:
            control.stats.failedCount += 1
            control.stats.failedSize += record.bytes
        # Step 2: the tree is released; it lingers for the grace, then is forgotten
        self._server.trace_owners.release(record.trace_id)

    def _note_borrowed(self, control: 'TaskControl', body: Any) -> None:
        """
        A standalone tool call opened and closed a binding in one frame: claim and release its tree.

        Its events may still arrive within the grace, so the owner is recorded
        for that long and nothing else.

        Args:
            control: The caller's control.
            body: The tool response (``traceId`` of the borrowed pipe).
        """
        trace_id = str((body or {}).get('traceId') or '') if isinstance(body, dict) else ''
        if not trace_id:
            return
        control.stats.totalCount += 1
        control.stats.completedCount += 1
        self._server.trace_owners.claim(trace_id, control.key, self._connection_id)
        self._server.trace_owners.release(trace_id)

    async def _require_credit(self, control: 'TaskControl') -> None:
        """
        Refuse a request on a control whose paying unit is out of credit (plan 0 S9).

        One ledger question per control per allow window, not one per request:
        an allow is trusted for ``CONST_SPEND_ALLOW_SECONDS`` (the engine's
        own gate uses the same window); a refusal is never cached, so a topped
        up account is admitted on its next request.

        Args:
            control: The resolved control; its org is the paying unit.

        Raises:
            OutOfCreditsError: The account refused the spend.
        """
        from ai.account import account

        # Step 1: a recent allow answers without asking
        now = time.monotonic()
        if control.credit_allowed(now):
            return
        # Step 2: ask the account for the paying unit; remember an allow only
        refusal = await account.check_spend(control.billing.org_id)
        if refusal:
            raise OutOfCreditsError(f'{refusal} ({control.address})')
        control.credit_allowed_at = now
