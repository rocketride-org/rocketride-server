# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Who is calling a node tool: the call context the engine attaches to every tool invoke.

A node tool that changes data (the vector store write tools) needs to know where
a call came from before it acts. The engine, never the client, sets that context:

1. The DAP tool path stamps the ``IInvokeTool.Invoke`` param it builds with
   ``param.__tool_context__`` (:data:`TOOL_CONTEXT_FIELD`): origin ``'dap'``, the
   calling task's source type, whether the call named a node, and the caller as
   the server sees it (the server replaces any caller the client sent). Nothing
   inside the tool ``input`` is ever read as context, and neither is a field of
   that name that arrived as data: only the plain instance attribute the engine
   sets counts, never a pydantic extra field (which is what validating a dict
   that carries the name produces) and never a key of a dict op.
2. The agent host stamps the params it builds with origin ``'agent'``.
3. ``IInstanceBase._dispatch_tool`` reads the field and runs the tool method
   inside :func:`tool_call`, so the method can read :func:`current_tool_call`.
   A call whose param carries no stamp runs with no context, even when it is
   made from inside another tool call: contexts are never inherited.

A tool that finds no context (an engine without this module, or a dispatcher
that did not stamp the call) must treat the caller as unknown and refuse writes.
A malformed stamp reads as no context too.

The context lives in a :class:`contextvars.ContextVar`, so it is per thread (and
per asyncio task): a thread a tool starts does not see it.

See ``docs/development/nodes/vector-tool-contract.md`` section 6.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, Iterator, Optional, Tuple

#: Name of the plain instance attribute on the ``IInvokeTool`` param that carries
#: the context. It is set with ``setattr`` (so it lands in the instance
#: ``__dict__``), never as a pydantic extra field: anything a client can get into
#: a param through validation lands in ``__pydantic_extra__`` and is not read.
TOOL_CONTEXT_FIELD = '__tool_context__'

#: ``ToolCallContext.origin`` values.
ORIGINS: Tuple[str, ...] = ('dap', 'agent')

#: ``ToolCallContext.caller['auth']`` values.
CALLER_AUTH_KINDS: Tuple[str, ...] = ('public', 'task', 'account', 'agent', 'unknown')

#: The keys a caller block keeps; anything else is dropped.
CALLER_KEYS: Tuple[str, ...] = ('auth', 'userId', 'teamId', 'orgId')


@dataclass(frozen=True)
class ToolCallContext:
    """Where one tool call came from, as the engine established it.

    :param origin: ``'dap'`` (an external tool call through the engine's DAP) or ``'agent'``
        (a tool call made by an agent node inside the pipeline).
    :param source_type: The provider of the calling task's source component (``'tools'``,
        ``'chat'``, ``'dropper'``, ...); None when unknown (always None for agent calls).
    :param targeted: True when the call named the target node explicitly.
    :param caller: ``{'auth': one of CALLER_AUTH_KINDS, 'userId', 'teamId', 'orgId'}`` as the
        server sees the caller. Ids may be absent or None.
    """

    origin: str
    source_type: Optional[str]
    targeted: bool
    caller: Dict[str, Any]


_CURRENT: ContextVar[Optional[ToolCallContext]] = ContextVar('rocketride_tool_call', default=None)


def current_tool_call() -> Optional[ToolCallContext]:
    """Return the context of the tool call running on this thread, or None when there is none."""
    return _CURRENT.get()


@contextmanager
def tool_call(ctx: ToolCallContext) -> Iterator[ToolCallContext]:
    """Run the body as the tool call described by ``ctx``.

    The dispatcher wraps each tool method call in this; the previous context
    (usually none) is restored when the body ends, also when it raises.

    :param ctx: The call context; must be a :class:`ToolCallContext`.
    :raises TypeError: When ``ctx`` is not a :class:`ToolCallContext`.
    """
    if not isinstance(ctx, ToolCallContext):
        raise TypeError(f'tool_call expects a ToolCallContext, got {type(ctx).__name__}')
    token = _CURRENT.set(ctx)
    try:
        yield ctx
    finally:
        _CURRENT.reset(token)


@contextmanager
def no_tool_call() -> Iterator[None]:
    """Run the body with no call context, restoring the previous one afterwards.

    The dispatcher uses this for a call whose param carries no (valid) stamp, so
    such a call never inherits the context of a tool call it is nested in.
    """
    token = _CURRENT.set(None)
    try:
        yield None
    finally:
        _CURRENT.reset(token)


# ---------------------------------------------------------------------------
# Building contexts
# ---------------------------------------------------------------------------


def _id_or_none(value: Any) -> Optional[str]:
    """Return an id as a non-empty string, or None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        text = str(value)
        return text or None
    return None


def normalize_caller(caller: Any) -> Dict[str, Any]:
    """Return a clean caller block: a known ``auth`` kind and string-or-None ids.

    Anything that is not a dict with a known ``auth`` kind becomes ``'unknown'``,
    which no write path accepts. Keys other than :data:`CALLER_KEYS` are dropped.
    """
    if not isinstance(caller, dict):
        caller = {}
    auth = caller.get('auth')
    if not isinstance(auth, str) or auth not in CALLER_AUTH_KINDS:
        auth = 'unknown'
    clean: Dict[str, Any] = {'auth': auth}
    for key in CALLER_KEYS[1:]:
        if key in caller or auth != 'agent':
            clean[key] = _id_or_none(caller.get(key))
    return clean


def caller_from_auth(
    auth: Optional[str],
    *,
    user_id: Any = None,
    team_id: Any = None,
    org_id: Any = None,
) -> Dict[str, Any]:
    """Return the caller block for a connection that signed in with ``auth``.

    The kind follows the key: a public task key (``pk_``) is ``'public'``, a task
    token (``tk_``) is ``'task'``, any other credential is ``'account'``; no
    credential is ``'unknown'``. The key itself is never copied into the block.
    """
    if not isinstance(auth, str) or not auth:
        kind = 'unknown'
    elif auth.startswith('pk_'):
        kind = 'public'
    elif auth.startswith('tk_'):
        kind = 'task'
    else:
        kind = 'account'
    return {'auth': kind, 'userId': _id_or_none(user_id), 'teamId': _id_or_none(team_id), 'orgId': _id_or_none(org_id)}


def dap_context(*, source_type: Any, node_id: Any, caller: Any) -> ToolCallContext:
    """Return the context of an external tool call through the DAP.

    :param source_type: The calling task's source provider: the provider of the
        component ``taskConfig.pipeline.source`` names (``DataConn._source_type``),
        not the target endpoint's logical type, which is the pipeline's Null
        endpoint for every task. Anything but a non-empty string is recorded as None.
    :param node_id: The node the call named; empty means a broadcast.
    :param caller: The caller block the server attached to the request.
    """
    if not isinstance(source_type, str) or not source_type:
        source_type = None
    return ToolCallContext(
        origin='dap', source_type=source_type, targeted=bool(node_id), caller=normalize_caller(caller)
    )


def agent_context() -> ToolCallContext:
    """Return the context of a tool call made by an agent node inside the pipeline."""
    return ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})


# ---------------------------------------------------------------------------
# Stamping and reading invoke params
# ---------------------------------------------------------------------------


def _as_stamp(ctx: ToolCallContext) -> Dict[str, Any]:
    """Return the plain-dict form of ``ctx`` (with its own copy of the caller)."""
    return {'origin': ctx.origin, 'source_type': ctx.source_type, 'targeted': ctx.targeted, 'caller': dict(ctx.caller)}


def stamp_param(param: Any, ctx: ToolCallContext) -> None:
    """Attach ``ctx`` to an invoke param the engine built (a pydantic op).

    The field is a plain instance attribute, so it never appears in
    ``model_dump()`` (which tracing serializes). A field of the same name that
    came in as a pydantic extra field (client data) is dropped first.

    :raises TypeError: When ``ctx`` is not a :class:`ToolCallContext`, or when
        ``param`` is a dict (a dict op may be built from client data, so a stamp
        on one is never read).
    """
    if not isinstance(ctx, ToolCallContext):
        raise TypeError(f'stamp_param expects a ToolCallContext, got {type(ctx).__name__}')
    if isinstance(param, dict):
        raise TypeError('stamp_param stamps engine-built invoke ops, not dicts')
    extra = getattr(param, '__pydantic_extra__', None)
    if isinstance(extra, dict):
        extra.pop(TOOL_CONTEXT_FIELD, None)
    setattr(param, TOOL_CONTEXT_FIELD, _as_stamp(ctx))


def context_from_stamp(value: Any) -> Optional[ToolCallContext]:
    """Parse a stamp value; None when it is absent or not a well-formed context.

    Accepts a :class:`ToolCallContext` or its dict form. The caller is normalized
    and copied, so the returned context shares nothing mutable with the stamp.
    """
    if isinstance(value, ToolCallContext):
        value = _as_stamp(value)
    if not isinstance(value, dict):
        return None
    origin = value.get('origin')
    source_type = value.get('source_type')
    targeted = value.get('targeted')
    caller = value.get('caller')
    if origin not in ORIGINS or not isinstance(targeted, bool):
        return None
    if source_type is not None and not isinstance(source_type, str):
        return None
    if not isinstance(caller, dict) or caller.get('auth') not in CALLER_AUTH_KINDS:
        return None
    return ToolCallContext(
        origin=origin, source_type=source_type or None, targeted=targeted, caller=normalize_caller(caller)
    )


def read_stamp(param: Any) -> Optional[ToolCallContext]:
    """Return the context stamped on an invoke param, or None.

    Only the plain instance attribute :func:`stamp_param` sets is read. The tool
    ``input`` is never looked at, a dict op never carries a context, and a
    pydantic extra field of the same name (``getattr`` would serve it from
    ``__pydantic_extra__``) is ignored, because validating a client dict puts a
    field there.
    """
    if param is None or isinstance(param, dict):
        return None
    try:
        own = object.__getattribute__(param, '__dict__')
    except AttributeError:
        return None
    if not isinstance(own, dict):
        return None
    return context_from_stamp(own.get(TOOL_CONTEXT_FIELD))


@contextmanager
def dispatch_scope(param: Any) -> Iterator[Optional[ToolCallContext]]:
    """Run the body inside the context stamped on ``param``, or with none.

    This is what the dispatcher wraps around a tool method call.
    """
    ctx = read_stamp(param)
    if ctx is None:
        with no_tool_call():
            yield None
    else:
        with tool_call(ctx):
            yield ctx


__all__ = [
    'CALLER_AUTH_KINDS',
    'CALLER_KEYS',
    'ORIGINS',
    'TOOL_CONTEXT_FIELD',
    'ToolCallContext',
    'agent_context',
    'caller_from_auth',
    'context_from_stamp',
    'current_tool_call',
    'dap_context',
    'dispatch_scope',
    'no_tool_call',
    'normalize_caller',
    'read_stamp',
    'stamp_param',
    'tool_call',
]
