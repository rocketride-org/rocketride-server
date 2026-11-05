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

"""The write gate of the vector store tools. It fails closed.

The write tools (``upsert``, ``delete``, ``soft_delete`` and ``restore``) call
:func:`check_write` first, before they check their input or touch the store. The gate reads who is calling only from the context the
engine attached to the call (``ai.common.tool_context.current_tool_call()``);
nothing in the tool input is ever read as context.

It is the inner gate. The outer one is the node's ``expose_tools`` / ``allow_write``
pair (``VectorStoreToolMixin``, #2631): with ``allow_write`` off the write tools do
not exist for anyone, so a call never reaches this gate. ``allow_write`` alone
decides whether an agent may write, as on develop; the gate has no switch of its
own for agents. It checks, in order:

====================================================  ========================
Condition                                             Result
====================================================  ========================
any objectId is ``'schema'`` (the control record)     ``RESERVED_ID``
no context (or one the gate cannot read)              ``WRITES_UNKNOWN_CALLER``
an agent call                                         allowed
a DAP call and ``allow_writes`` off                   ``WRITES_DISABLED``
a DAP call from a source other than Tools             ``WRITES_SOURCE``
a DAP caller that is not an account or a task key     ``WRITES_PUBLIC``
a DAP call that does not name the node                ``WRITES_BROADCAST``
a DAP ``upsert`` that supplies its own embedding      ``INVALID_INPUT``
otherwise                                             allowed
====================================================  ========================

A refusal is a :class:`~ai.common.store.errors.ToolRefusal`, which the tool
wrapper turns into ``{success: false, code, error}``; nothing is written. On an
engine without ``ai.common.tool_context``, or one that does not attach a
context, every write is refused.

Reads have one rule, :func:`check_read`, which ``list_documents``, the DAP-only
read tools (``dialect``, ``chunks``, ``vectors``, ``sample``, ``project``,
``neighbors``) and the embedding nodes' ``embed`` run first: a DAP call from a
connection signed in with a task's public key (caller ``'public'``) is refused
with ``READS_PUBLIC`` before anything is read. Every other caller reads as
before, from any source of the task (a read-only card reads through the Chat
or Ingest source), and so does a call without a context or from an agent.

See ``docs/development/nodes/vector-tool-contract.md`` section 6.
"""

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence

from .errors import ToolRefusal
from .vx_types import CONTROL_OBJECT_ID

try:  # an engine without the module attaches no context: every write is refused
    import ai.common.tool_context as _tool_context
except ImportError:  # pragma: no cover - exercised by loading a copy without the module
    _tool_context = None


def _engine_current_tool_call() -> Any:
    """Read the context through the module at call time, so a rebinding of the reader is honoured."""
    return _tool_context.current_tool_call()


#: Reads the engine's context for the running call (None on an engine without it).
_current_tool_call = _engine_current_tool_call if _tool_context is not None else None

#: The tools that write and therefore run the gate (and that ``allow_write`` hides, the outer gate).
WRITE_TOOLS = ('upsert', 'delete', 'soft_delete', 'restore')

#: Caller kinds allowed to write through DAP.
WRITE_CALLER_AUTH = ('account', 'task')

#: The source type allowed to write through DAP.
WRITE_SOURCE_TYPE = 'tools'

#: Caller kinds the DAP-only read tools refuse: a connection signed in with a task's public key.
READ_REFUSED_CALLER_AUTH = ('public',)

_VERB = {
    'delete': 'remove documents',
    'soft_delete': 'move documents to the trash',
    'restore': 'restore documents',
    'upsert': 'add documents',
}
_DISABLED = {
    'delete': 'Removing documents is turned off on this store node (allow_writes).',
    'soft_delete': 'Moving documents to the trash is turned off on this store node (allow_writes).',
    'restore': 'Restoring documents is turned off on this store node (allow_writes).',
    'upsert': 'Adding documents through tool calls is turned off on this store node (allow_writes).',
}
_RESERVED = {
    'delete': "'schema' is the collection's control record and cannot be removed.",
    'soft_delete': "'schema' is the collection's control record and cannot be moved to the trash.",
    'restore': "'schema' is the collection's control record and cannot be restored.",
    'upsert': "'schema' is the collection's control record and cannot be written.",
}


@dataclass(frozen=True)
class GateContext:
    """The parts of a call context the gate reads."""

    origin: str
    source_type: Optional[str]
    targeted: bool
    caller: Mapping[str, Any]


@dataclass(frozen=True)
class GateDecision:
    """An allowed write: who asked, for the audit block."""

    origin: str
    #: ``{'auth', 'userId', 'teamId'}``; no other caller detail is kept.
    caller: Dict[str, Any]


def _read(ctx: Any) -> Optional[GateContext]:
    """Coerce a ``ToolCallContext`` (or its ``__dict__``) to :class:`GateContext`; None when unreadable."""
    if ctx is None:
        return None
    if isinstance(ctx, Mapping):
        get = ctx.get
    else:

        def get(name: str, default: Any = None) -> Any:
            return getattr(ctx, name, default)

    origin = get('origin')
    caller = get('caller')
    if origin not in ('dap', 'agent') or not isinstance(caller, Mapping):
        return None
    source_type = get('source_type')
    return GateContext(
        origin=origin,
        source_type=source_type if isinstance(source_type, str) else None,
        targeted=get('targeted') is True,
        caller=caller,
    )


def current_context() -> Any:
    """Return the engine's context for the running tool call, or None (no context, or the reader failed)."""
    reader = _current_tool_call
    if reader is None:
        return None
    try:
        return reader()
    except Exception:
        return None


_UNSET = object()


def check_write(
    tool: str,
    *,
    object_ids: Sequence[str],
    allow_writes: bool,
    supplies_embedding: bool = False,
    context: Any = _UNSET,
) -> GateDecision:
    """Decide whether ``tool`` may write ``object_ids``; raise a refusal when it may not.

    :param tool: One of :data:`WRITE_TOOLS`.
    :param object_ids: Every objectId the call would write or remove.
    :param allow_writes: The node's ``allow_writes`` switch (DAP calls); agents do not read it.
    :param supplies_embedding: True when an ``upsert`` carries caller-supplied embeddings.
    :param context: The call context; read from the engine when left out.
    :raises ToolRefusal: With the code of the first row of the gate that refuses.
    """
    if any(str(oid).strip() == CONTROL_OBJECT_ID for oid in object_ids):
        raise ToolRefusal('RESERVED_ID', _RESERVED.get(tool, _RESERVED['upsert']))

    ctx = _read(current_context() if context is _UNSET else context)
    if ctx is None:
        raise ToolRefusal(
            'WRITES_UNKNOWN_CALLER', 'The engine did not identify this request, so the store refused the write.'
        )

    # An agent reaches this gate only through a write tool the outer gate (allow_write) let it see.
    if ctx.origin == 'agent':
        return GateDecision(origin='agent', caller={'auth': 'agent', 'userId': None, 'teamId': None})

    if not allow_writes:
        raise ToolRefusal('WRITES_DISABLED', _DISABLED.get(tool, _DISABLED['upsert']))
    if ctx.source_type != WRITE_SOURCE_TYPE:
        raise ToolRefusal('WRITES_SOURCE', f'Only a Tools source may {_VERB.get(tool, "write documents")}.')
    if ctx.caller.get('auth') not in WRITE_CALLER_AUTH:
        raise ToolRefusal('WRITES_PUBLIC', 'The store refused this request.')
    if not ctx.targeted:
        raise ToolRefusal('WRITES_BROADCAST', 'The store refused this request: name the node the write is for.')
    if supplies_embedding:
        raise ToolRefusal(
            'INVALID_INPUT',
            'Tool calls cannot supply embeddings; leave out "embedding" and "embedding_model" and the store computes them.',
        )
    return GateDecision(
        origin='dap',
        caller={'auth': ctx.caller.get('auth'), 'userId': ctx.caller.get('userId'), 'teamId': ctx.caller.get('teamId')},
    )


def check_read(context: Any = _UNSET) -> None:
    """Refuse a DAP-only read tool called from a connection signed in with a task's public key.

    Reads are not limited to Tools sources or to calls that name the node, and a
    call without a context (an older engine) or from an agent reads as before.

    :param context: The call context; read from the engine when left out.
    :raises ToolRefusal: ``READS_PUBLIC`` for a DAP call whose caller is ``'public'``.
    """
    ctx = _read(current_context() if context is _UNSET else context)
    if ctx is not None and ctx.origin == 'dap' and ctx.caller.get('auth') in READ_REFUSED_CALLER_AUTH:
        raise ToolRefusal('READS_PUBLIC', 'The store refused this request.')


__all__ = ['GateDecision', 'READ_REFUSED_CALLER_AUTH', 'WRITE_TOOLS', 'check_read', 'check_write', 'current_context']
