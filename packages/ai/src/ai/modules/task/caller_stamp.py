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
CallerStamp: the ONE mint point of the per-binding caller context (plan 5.3).

Every data request (pipe open/write/close, tool) that EaaS forwards to an
engine carries ``_caller``: who is calling, through which control (its
``controlId`` on every subcommand; on the frame that STARTS a binding, the
OPEN and a standalone ``tool`` call naming no pipe, its resolved ``config``
by stack index, from which the engine builds that control's IGlobal set), with
which per-call parameters, environment, trace level and request id. Nodes
read it through ``self.settings`` and nothing else, so it is the whole trust
boundary between a client and the engine (plan 0 S2, 5.3). Its
``traceLevel`` is what the engine binds the pipe at (``getPipe(level)``,
plan 7.4) for the whole transaction, open to close: the level the OPEN
asked for (``pipelineTraceLevel``), else the control's own. A shared engine
serves every caller of a publication, so the level is the pipe's, never
the engine's.

- STRIP first: every reserved key a client sent (``_caller``, ``_ctx``,
  ``config``, ``controlId``) is deleted from the request's ``arguments``, at
  the top level AND inside the object info, on EVERY subcommand. The engine
  cannot tell a server-set key from a client-set one, so nothing
  identity-shaped is ever read from client arguments; a merge
  (``setdefault``) would let the client win.
- Then INJECT: ``_caller`` is set from the request's ``AccountInfo`` and the
  resolved ``TaskControl``, never from the request.

The ONE pass-through is a connection the server itself made
(``RequestContext.internal()``, a ``conn_id`` prefixed ``internal:``): it may
forward a context it already stamped. The test is the CONNECTION KIND, never
the ``internal`` permission bit, because the OSS ``local`` identity carries
that bit and a client connection must be stripped on every install (ALB seam 6
narrowed, 2026-11-12).

``cmd_data`` (the DAP door) and ``cmd_submit`` (the in-process door) both call
``prepare``; a second front end later calls the same function.
"""

import copy
from typing import TYPE_CHECKING, Any, Dict, Mapping, Optional

from .types import TaskError

if TYPE_CHECKING:
    from ai.account.models import AccountInfo

    from .task_control import TaskControl

# ==== Constants ===============================================================

#: The argument keys only the server may set (plan 5.3): the context, the
#: forwarded context, the control's config and its id.
RESERVED_KEYS = ('_caller', '_ctx', 'config', 'controlId')

#: The subcommands that may start a binding: their ``_caller`` carries the
#: control's config (the ``tool`` one only when it names no pipe).
OPEN_SUBCOMMAND = 'open'
TOOL_SUBCOMMAND = 'tool'

#: The open argument naming the pipe's trace level: the name ``use()`` and
#: ``submit()`` take it under
TRACE_LEVEL_ARGUMENT = 'pipelineTraceLevel'

#: The trace levels a binding may ask for (the engine's ``PIPELINE_TRACE_LEVEL``)
TRACE_LEVELS = ('none', 'metadata', 'summary', 'full')


def carries_config(subcommand: Optional[str], pipe_id: Any) -> bool:
    """
    Whether a frame starts a binding and so carries the control's config (plan 5.3, C.22).

    The OPEN does; a standalone ``tool`` call (no ``pipeId``) is its own
    binding and is the control's first frame on the engine as often as not,
    so it does too; write/close/cancel and a ``tool`` call on an open pipe
    carry the control id alone.

    Args:
        subcommand: The frame kind.
        pipe_id: The slot the frame names, or None.

    Returns:
        True for an open or a standalone tool call.
    """
    return subcommand == OPEN_SUBCOMMAND or (subcommand == TOOL_SUBCOMMAND and pipe_id is None)


#: The ``conn_id`` prefix of a connection the server itself made.
INTERNAL_CONN_PREFIX = 'internal:'


# ==== The stamp ==================================================================


def is_internal(conn: Any) -> bool:
    """
    Whether ``conn`` is a connection the server itself made (``RequestContext.internal()``).

    Args:
        conn: A command connection (``request_context()``).

    Returns:
        True for an ``internal:`` connection id; False for every client connection.
    """
    # Step 1: a connection without a request context is a client (test
    # stand-ins and bare DAP connections included): never trusted
    context = getattr(conn, 'request_context', None)
    if context is None:
        return False
    # Step 2: the connection KIND is the test, never the permission bit (the
    # OSS local identity carries 'internal' and is still a client)
    conn_id = str(getattr(context(), 'conn_id', '') or '')
    return conn_id.startswith(INTERNAL_CONN_PREFIX)


def strip_reserved(arguments: Mapping[str, Any]) -> Dict[str, Any]:
    """
    A deep copy of ``arguments`` with every reserved key removed, at the top level and inside the object info.

    Args:
        arguments: The request's ``arguments`` as the client sent them.

    Returns:
        The stripped copy; the input is never modified.
    """
    # Step 1: a deep copy, so the inbound request (logged, echoed) keeps what
    # the client sent and the engine sees only what the server allows
    stripped: Dict[str, Any] = copy.deepcopy(dict(arguments))
    # Step 2: the top level, on every subcommand (open/write/close/tool alike)
    for key in RESERVED_KEYS:
        stripped.pop(key, None)
    # Step 3: inside the object info too. It is 100% client-written and nodes
    # copy it into chunks and stored documents, so a smuggled context there
    # would persist identity into a vector store
    for holder in ('object', 'objinfo'):
        obj = stripped.get(holder)
        if isinstance(obj, dict):
            for key in RESERVED_KEYS:
                obj.pop(key, None)
    return stripped


def requested_trace_level(arguments: Mapping[str, Any]) -> Optional[str]:
    """
    The trace level an open asks its pipe to run at, or None when it names none.

    Read from the OPEN only: the engine binds the pipe at it there, and it
    holds for the whole transaction (open, writes, close), so no later frame
    can change it.

    Args:
        arguments: The request's ``arguments`` as the client sent them.

    Returns:
        ``none``, ``metadata``, ``summary`` or ``full``; None for any other
        frame, or an open that names no level (the control's own applies).

    Raises:
        TaskError: TASK_INVALID_ARGUMENT for an open naming a level the
            engine has not: refused, never dropped.
    """
    # Step 1: only the open sets the pipe's level
    if arguments.get('subcommand') != OPEN_SUBCOMMAND:
        return None
    level = arguments.get(TRACE_LEVEL_ARGUMENT)
    if level is None:
        return None
    # Step 2: one of the engine's levels
    if level not in TRACE_LEVELS:
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            f'{TRACE_LEVEL_ARGUMENT} must be one of {"|".join(TRACE_LEVELS)}, got {level!r}',
            field=TRACE_LEVEL_ARGUMENT,
        )
    return level


def mint(
    account_info: 'AccountInfo',
    control: 'TaskControl',
    *,
    correlation_id: str,
    params: Optional[Mapping[str, Mapping[str, Any]]] = None,
    subcommand: Optional[str] = None,
    pipe_id: Any = None,
    trace_level: Optional[str] = None,
) -> Dict[str, Any]:
    """
    The ``_caller`` context of one request through ``control`` (plan 5.3 item 1).

    Args:
        account_info: The request's account.
        control: The control the request resolved to.
        correlation_id: The server-minted request id (the open's; its frames reuse it).
        params: The admitted per-call params, per node (``{nodeId: {configKey: value}}``).
        subcommand: The frame kind.
        pipe_id: The slot the frame names, or None for a frame that starts its own binding.
        trace_level: The level the open asked for (``requested_trace_level``),
            or None for the control's own.

    Returns:
        ``{controlId, userId, teamId, orgId, address, rung, params, env,
        traceLevel, correlationId}``, plus ``config`` (the control's
        component config by stack index as the spec stores it, expanded for
        this control; the engine resolves it) on the frames that start a
        binding (``carries_config``): the open and a standalone tool call;
        write/close/cancel and an attached tool call carry the control id
        alone.
    """
    organization = getattr(account_info, 'organization', None) or {}
    stamp: Dict[str, Any] = {
        # Through which control: the handle the engine keys its IGlobal set by
        'controlId': control.control_id,
        # Who: the authenticated account, never a client field
        'userId': getattr(account_info, 'userId', '') or '',
        # The team whose environment applies (the caller's home team; a run
        # with no caller, the publication's team, plan 6.2); never billing,
        # which rides the control
        'teamId': control.env_team,
        'orgId': str(organization.get('id') or control.orgId or ''),
        # Through which control: the address and the rung that answered
        'address': control.address,
        'rung': control.rung,
        # Per node, by schema path: what IInstanceBase.settings overlays
        'params': {node: dict(values) for node, values in (params or {}).items()},
        # Only the ROCKETRIDE_* keys the resolved spec references (least
        # privilege, plan 6.2); the control resolves them once (C.10)
        'env': dict(control.env),
        # The level the engine binds the pipe at: the request's, else the
        # control's (a published agent's shared engine defaults to none)
        'traceLevel': trace_level or control.trace_level,
        'correlationId': correlation_id,
    }
    # The frame that starts a binding builds the control's IGlobal set: its
    # config rides it
    if carries_config(subcommand, pipe_id):
        stamp['config'] = control.caller_config()
    return stamp


def prepare(
    conn: Any,
    control: 'TaskControl',
    arguments: Mapping[str, Any],
    *,
    correlation_id: str,
    params: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Strip-then-inject: the arguments an engine may see for one request through ``control``.

    Args:
        conn: The command connection (``_account_info``, ``request_context()``).
        control: The resolved control.
        arguments: The request's ``arguments``.
        correlation_id: The server-minted request id.
        params: The admitted per-call params, per node.

    Returns:
        A copy of ``arguments`` with the server's ``_caller`` set and every
        client-sent reserved key removed. An open's requested trace level
        moves into ``_caller.traceLevel``: the engine reads it there only. An
        internal connection's arguments are returned as a plain copy: it
        stamped its own context.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT for a trace level the engine has not.
    """
    # Step 1: the one pass-through: a server-made connection forwards the
    # context it stamped itself
    if is_internal(conn):
        return copy.deepcopy(dict(arguments))
    # Step 2: the level an open asks for, checked before anything is sent
    trace_level = requested_trace_level(arguments)
    # Step 3: STRIP what the client sent, THEN set the server's context; the
    # order is the trust boundary (a merge would let the client win)
    prepared = strip_reserved(arguments)
    prepared.pop(TRACE_LEVEL_ARGUMENT, None)
    prepared['_caller'] = mint(
        conn._account_info,
        control,
        correlation_id=correlation_id,
        params=params,
        subcommand=arguments.get('subcommand'),
        pipe_id=arguments.get('pipeId'),
        trace_level=trace_level,
    )
    return prepared
