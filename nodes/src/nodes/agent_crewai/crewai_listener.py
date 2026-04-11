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

"""
Persistent CrewAI event listener that forwards bus events to SSE.

Replaces the prior `with crewai_event_bus.scoped_handlers(): ...` pattern
which was unsafe under concurrent kickoffs (two worker threads in
`scoped_handlers()` clobber each other's handler set on the singleton bus).

Architecture:
  - One `CrewListener` instance is constructed per Python process, exactly
    once, on the first call to `crewai_runner.get_shared_runner()`.
  - Its `setup_listeners` walks the `BaseEvent` subclass tree and registers
    a single `_dispatch` function on every relevant event class.
  - `_dispatch` reads the originating run's `AgentContext` from the
    `crewContext` ContextVar (set per-task by `CrewRunner.submit`) and
    forwards a `thinking` SSE message to that run's invoker.

The contextvar-based routing works because CrewAI's bus uses
`contextvars.copy_context().run(...)` when dispatching sync handlers to its
`_sync_executor`, which propagates `crewContext` from the kickoff coroutine's
task into the handler worker thread automatically.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

# Force-import the lazy `agent_events` module so that AgentExecutionStartedEvent
# and friends are present in the BaseEvent subclass tree before we walk it.
# Without this, our listener silently misses agent execution events.
import crewai.events.types.agent_events  # noqa: F401

from crewai.events import BaseEventListener
from crewai.events.base_events import BaseEvent
from crewai.events.types.llm_events import LLMStreamChunkEvent
from crewai.events.types.logging_events import (
    AgentLogsExecutionEvent,
    AgentLogsStartedEvent,
)

from .crewai_runner import crewContext


# ── Event filtering and labeling ──────────────────────────────────────────────

# Event classes we never forward as 'thinking' updates -- streaming chunks
# would flood the UI, and the "agent logs" events are formatter-only noise
# from CrewAI's terminal-tree output path.
_SKIP_EVENT_TYPES = {
    LLMStreamChunkEvent,
    AgentLogsStartedEvent,
    AgentLogsExecutionEvent,
}

# Maps CrewAI event type strings to human-friendly status labels surfaced in
# the chat UI's "thinking" panel.  Anything not in this map falls back to a
# title-cased version of the type string.
_EVENT_LABELS: Dict[str, str] = {
    'crew_kickoff_started': 'Crew started',
    'crew_kickoff_completed': 'Crew completed',
    'crew_kickoff_failed': 'Crew failed',
    'task_started': 'Task started',
    'task_completed': 'Task completed',
    'task_failed': 'Task failed',
    'agent_execution_started': 'Agent thinking...',
    'agent_execution_completed': 'Agent done',
    'agent_execution_error': 'Agent error',
    'tool_usage_finished': 'Tool complete',
    'tool_usage_error': 'Tool error',
    'tool_execution_error': 'Tool execution error',
    'tool_selection_error': 'Tool selection error',
    'tool_validate_input_error': 'Tool input error',
    'llm_call_started': 'LLM call started',
    'llm_call_completed': 'LLM call completed',
    'llm_call_failed': 'LLM call failed',
}


# ── Subclass walker ───────────────────────────────────────────────────────────


def _all_subclasses(base: type) -> List[type]:
    """Recursively collect every subclass of `base`, including indirect ones."""
    result: List[type] = []
    for cls in base.__subclasses__():
        result.append(cls)
        result.extend(_all_subclasses(cls))
    return result


# ── Singleton dispatcher ──────────────────────────────────────────────────────


def _dispatch(source: Any, event: Any) -> None:
    """
    Singleton handler registered on every relevant event class.

    Reads the originating run's AgentContext from the `crewContext` contextvar
    and forwards a 'thinking' SSE message to that run's invoker.  Events
    emitted from outside our `CrewRunner.submit()` (e.g. CrewAI library
    internals during initialization) resolve to `crewContext = None` and are
    silently dropped -- they aren't ours to route.

    Runs on a worker thread of `crewai_event_bus._sync_executor`.  CrewAI's
    bus uses `contextvars.copy_context().run(...)` when submitting handlers,
    so the contextvar set by `CrewRunner.submit` propagates here automatically.
    """
    context = crewContext.get()
    if context is None:
        return

    event_type = getattr(event, 'type', '') or ''
    if event_type == 'tool_usage_started':
        tool_name = getattr(event, 'tool_name', '') or 'tool'
        message = f'Calling {tool_name}...'
    else:
        message = _EVENT_LABELS.get(event_type) or event_type.replace('_', ' ').capitalize()

    try:
        data = event.to_json(exclude={'timestamp', 'source_fingerprint', 'fingerprint_metadata', 'source_type'})
    except Exception:
        data = None

    # CrewAI event payloads include a `type` field (the event type string) which
    # collides with the positional `type` parameter on `instance.sendSSE(type, ...)`.
    # Strip it before splatting so we don't get "multiple values for argument 'type'".
    if isinstance(data, dict) and 'type' in data:
        data = {k: v for k, v in data.items() if k != 'type'}

    invoker = getattr(context, 'invoker', None)
    instance = getattr(invoker, 'instance', None)
    if instance is None:
        return
    try:
        instance.sendSSE('thinking', message=message, **(data or {}))
    except Exception:
        # Never let an SSE write failure bubble up into CrewAI internals.
        pass


# ── CrewListener ──────────────────────────────────────────────────────────────


class CrewListener(BaseEventListener):
    """
    Process-wide CrewAI event listener.  Constructed exactly once per Python
    interpreter via `ensure_registered()`.  Its `setup_listeners` walks the
    `BaseEvent` subclass tree and registers `_dispatch` on every event class
    we care about.
    """

    def setup_listeners(self, crewai_event_bus: Any) -> None:
        """
        Register the singleton `_dispatch` handler on every relevant event class.

        Called automatically by `BaseEventListener.__init__`.
        """
        for event_cls in _all_subclasses(BaseEvent):
            if event_cls in _SKIP_EVENT_TYPES:
                continue
            crewai_event_bus.register_handler(event_cls, _dispatch)


# ── Lazy install ──────────────────────────────────────────────────────────────

_listener: Optional[CrewListener] = None
_listener_lock = threading.Lock()


def ensure_registered() -> None:
    """
    Idempotently install the persistent `CrewListener` on the bus.

    Called by `crewai_runner.get_shared_runner()` (lazy import to avoid the
    `crewai_runner` <-> `crewai_listener` cycle), never directly by drivers
    or `IGlobal`.  Multiple calls are no-ops after the first.
    """
    global _listener
    if _listener is not None:
        return
    with _listener_lock:
        if _listener is None:
            # BaseEventListener.__init__ calls setup_listeners(crewai_event_bus)
            # automatically, which registers our handlers.
            _listener = CrewListener()
