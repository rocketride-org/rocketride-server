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
RocketRide monitor-event to OpenTelemetry mappers.

This module translates the engine's WebSocket monitor events (``apaevt_flow``,
``apaevt_task``, ``apaevt_sse``, ``apaevt_status_update``) into OpenTelemetry
spans and metrics. It is a pure consumer of the OpenTelemetry API: no network
I/O and no asyncio live here, so the mappers can be unit-tested with the SDK's
in-memory exporters.

Span hierarchy (documented contract):
    - ``apaevt_task`` ``begin`` (or a seeded ``running`` snapshot) opens one
      task-level root span per run. Runs are keyed primarily by the wire
      correlation id ``body['__id']`` (``'<token8hex>.<source>'``), falling
      back to ``(project_id, source)``. A run first observed through
      fallback-keyed events is reconciled when its canonical id becomes
      known: PROMOTED to the canonical key, or ABSORBED into an
      already-tracked canonical state (duplicate segments closed as
      unclosed) — never tracked twice. Runs already tracked under a
      different canonical id are distinct runs and are never merged.
    - ``apaevt_flow`` ``op='begin'`` opens a pipe root span for that
      ``(run, pipe id)`` segment, parented to the run's task span when one is
      open (else it is a standalone root).
    - ``op='enter'`` opens a child component span whose parent is the nearest
      open component span on that pipe's stack (else the pipe root);
      ``op='leave'`` closes the span paired BY COMPONENT IDENTITY, never by
      stack position.
    - ``op='end'`` closes the pipe root. Component spans still open are closed
      first with status UNSET and ``rocketride.span.unclosed=true``.
    - ``apaevt_sse`` becomes a span event on the innermost open span of the
      target pipe (or its root). Events for runs/pipes that were never
      announced (e.g. the bridge attached mid-run) open implicit roots marked
      ``rocketride.span.implicit=true``.

Bounded state (long-lived bridge guarantee): a run whose ``end`` is never
observed (missed during a disconnect, or an implicit run that never
terminates) cannot hold spans open forever. Open runs are closed — spans
flagged ``rocketride.span.unclosed=true`` — by whichever comes first:
    - the seeded ``running`` snapshot on (re)subscribe, which is authoritative
      for which tasks are still alive: tracked runs it does not announce are
      closed and dropped;
    - the ``MAX_TRACKED_RUNS`` cap, which evicts the least-recently-eventful
      run when a new one would exceed it;
    - the ``MAX_TRACKED_PIPES_PER_RUN`` cap, the same rule one level down:
      a run that keeps receiving events is never evicted, so its open pipes
      need their own bound for runs whose ``end`` events never arrive;
    - :meth:`FlowSpanMapper.close_all` at shutdown.
A deliberately idle-but-alive run (e.g. a webhook service task) is never
expired by a clock: it stays announced in every snapshot, so no TTL heuristic
is used. ``MetricsMapper`` similarly caps its per-run delta bookkeeping at
``MAX_TRACKED_METRIC_RUNS`` entries (least-recently-updated evicted first).

Timestamps: every forwarded event body carries ``eventTime`` — the engine's
emission time in epoch seconds, stamped at ingress by the run-log continuum
(``TaskEngine.stamp_log_event``). Spans and span events are stamped with it, so
durations are ENGINE-measured and exclude WebSocket transport latency. Bodies
without a usable ``eventTime`` (an older engine, or a span closed by a
non-event path — shutdown, snapshot reconciliation, cap eviction) fall back to
the bridge's own ``time.time_ns()`` clock — the same source the OpenTelemetry
SDK would use — at that moment, i.e. arrival time. A close is
never stamped earlier than its own span's start, so a run that mixes both
sources cannot produce a negative duration. Metric instruments take no explicit
timestamp in the OTel API, so metric points remain arrival-timed.

Privacy: payload content (``trace.data``, lane payloads, the run-segment
result delivered in ``end.trace``, SSE ``data``, and the free-form
``trace.error`` text, which can itself embed payload) never reaches span
attributes, events, or status descriptions unless the mapper is built with
``include_content=True``, and is then truncated to ``MAX_CONTENT_LENGTH``
characters. The error SIGNAL (span status ERROR, ``error.type``, and the
``exception`` span event) is structural and always exports; by default the
status description is the generic ``GENERIC_ERROR_DESCRIPTION``.

GenAI semantic conventions: component spans for ``llm_*`` / ``embedding_*`` /
``agent_*`` / ``tool_*`` nodes carry ``gen_ai.operation.name`` (and
``gen_ai.provider.name`` / ``gen_ai.tool.name`` when derivable from the
component id). Attribute names follow the open-telemetry/semantic-conventions-genai
repository snapshot of July 2026 (Development stability, no tagged release);
deprecated names (``gen_ai.system``, ``gen_ai.usage.prompt_tokens``, ...) are
never emitted. Flow events at trace level ``summary`` carry no model names or
token counts, so ``gen_ai.request.model`` / ``gen_ai.usage.*`` are omitted
rather than invented. NOTE: ``apaevt_status_update`` ``tokens.*`` are compute
credits, NOT LLM tokens, and are deliberately never mapped to ``gen_ai.usage.*``.
"""

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .setup import OtelNotInstalledError, missing_otel_message

logger = logging.getLogger(__name__)

# Maximum characters of payload content copied into a span attribute or event
# attribute when include_content is enabled. Content beyond this is truncated.
MAX_CONTENT_LENGTH = 8192

# Upper bound on concurrently tracked runs (open span state). When a new run
# would exceed it, the least-recently-eventful run is closed (spans flagged
# rocketride.span.unclosed=true) and dropped, so a bridge that never observes
# some runs' 'end' events still has bounded memory. Generous: the engine does
# not run thousands of concurrent tasks per API key.
MAX_TRACKED_RUNS = 1024

# Upper bound on concurrently tracked PIPES within a single run. MAX_TRACKED_RUNS
# alone does not bound memory: a run that keeps receiving events is re-inserted
# as most-recently-eventful on every one of them, so it is never evicted, while
# every apaevt_flow 'begin' (or an event for a never-begun pipe) adds a
# _PipeState that only a matching 'end' removes. A reconnect resubscribes the
# monitors but does not replay the 'end' events missed while disconnected, so a
# long-lived task can strand pipe roots indefinitely. When the cap is reached
# the least-recently-eventful pipe is closed (spans flagged
# rocketride.span.unclosed=true) and dropped.
MAX_TRACKED_PIPES_PER_RUN = 256

# Upper bound on MetricsMapper's per-run last-count entries (delta
# bookkeeping); the least-recently-updated entry is evicted first. Evicting a
# run that later reports again re-counts its totals once, so the cap is
# generous relative to realistic concurrent-run counts.
MAX_TRACKED_METRIC_RUNS = 4096

# ---------------------------------------------------------------------------
# Attribute name constants.
#
# rocketride.* names are bridge-defined. gen_ai.* names are centralized here
# and follow the open-telemetry/semantic-conventions-genai registry snapshot
# of July 2026 (all gen_ai.* attributes are Development stability; error.type
# is the only Stable attribute referenced).
# ---------------------------------------------------------------------------
ATTR_PROJECT_ID = 'rocketride.project_id'
ATTR_SOURCE = 'rocketride.source'
ATTR_RUN_ID = 'rocketride.run_id'
ATTR_COMPONENT = 'rocketride.component'
ATTR_PIPE_ID = 'rocketride.pipe_id'
ATTR_LANE = 'rocketride.lane'
ATTR_TASK_NAME = 'rocketride.task.name'
ATTR_TASK_RESTARTED = 'rocketride.task.restarted'
ATTR_OBJECT_NAME = 'rocketride.object'
ATTR_FLOW_RESULT = 'rocketride.flow.result'
ATTR_TRACE_DATA = 'rocketride.trace.data'
ATTR_RESULT_CONTENT = 'rocketride.result'
ATTR_SPAN_UNCLOSED = 'rocketride.span.unclosed'
ATTR_SPAN_IMPLICIT = 'rocketride.span.implicit'
ATTR_UNMATCHED_LEAVES = 'rocketride.flow.unmatched_leaves'
ATTR_SSE_TYPE = 'rocketride.sse.type'
ATTR_SSE_DATA = 'rocketride.sse.data'
ATTR_ERROR_TYPE = 'error.type'

GEN_AI_OPERATION_NAME = 'gen_ai.operation.name'
GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name'
GEN_AI_TOOL_NAME = 'gen_ai.tool.name'

# error.type is low-cardinality by spec; the wire only gives a free-form error
# string, so the semconv fallback value '_OTHER' is used.
ERROR_TYPE_FALLBACK = '_OTHER'

# Span status description used in place of the wire's free-form error text
# when include_content is False (error text can embed payload/credentials).
GENERIC_ERROR_DESCRIPTION = 'component error'

# Well-known gen_ai.provider.name values, keyed by RocketRide node provider
# (the component id minus its trailing '_<n>' instance suffix). Only values
# from the semconv well-known list are emitted; unmapped providers omit the
# attribute rather than inventing a value.
_GENAI_PROVIDERS: Dict[str, str] = {
    'llm_openai': 'openai',
    'llm_openai_api': 'openai',
    'llm_vision_openai': 'openai',
    'llm_anthropic': 'anthropic',
    'llm_bedrock': 'aws.bedrock',
    'llm_gemini': 'gcp.gemini',
    'llm_vision_gemini': 'gcp.gemini',
    'llm_mistral': 'mistral_ai',
    'llm_vision_mistral': 'mistral_ai',
    'llm_deepseek': 'deepseek',
    'llm_perplexity': 'perplexity',
    'llm_xai': 'x_ai',
    'llm_ibm_watson': 'ibm.watsonx.ai',
    'embedding_openai': 'openai',
}

_INSTANCE_SUFFIX = re.compile(r'_\d+$')


def _serialize_content(value: Any) -> str:
    """Serialize a payload value to a JSON string capped at MAX_CONTENT_LENGTH."""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, default=str)
        except (TypeError, ValueError):
            text = str(value)
    return text[:MAX_CONTENT_LENGTH]


def _event_time_ns(body: dict) -> Optional[int]:
    """
    Return the event's engine emission time in nanoseconds, or None.

    ``body.eventTime`` is epoch SECONDS as a float, stamped on every forwarded
    event by the engine's run-log continuum. None means "no usable stamp" and
    every caller then falls back to the bridge clock, which is the
    pre-continuum behaviour (arrival time).
    """
    value = body.get('eventTime')
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0 or value != value or value in (float('inf'), float('-inf')):
        return None
    return int(value * 1_000_000_000)


@dataclass
class _ComponentSpan:
    """One open component span on a pipe's stack."""

    component: str
    span: Any
    start_ns: int = 0


@dataclass
class _PipeState:
    """Open span state for one (run, pipe id)."""

    root: Any
    stack: List[_ComponentSpan] = field(default_factory=list)
    unmatched_leaves: int = 0
    start_ns: int = 0


@dataclass
class _RunState:
    """Open span state for one engine run (task)."""

    key: str
    project_id: str = ''
    source: str = ''
    name: str = ''
    task_span: Any = None
    task_start_ns: int = 0
    pipes: Dict[int, _PipeState] = field(default_factory=dict)


class FlowSpanMapper:
    """
    Maps apaevt_flow / apaevt_task / apaevt_sse monitor events to OTel spans.

    Pure consumer of an injected OpenTelemetry ``Tracer``: no network and no
    asyncio. Feed it raw DAP event bodies via :meth:`handle_event` and close
    any remaining open spans with :meth:`close_all` at shutdown. Tracked-run
    state is bounded (see "Bounded state" in the module docstring): runs whose
    'end' is never observed are closed by seeded-snapshot reconciliation or
    by the ``MAX_TRACKED_RUNS`` least-recently-eventful eviction and, within
    each run, by the ``MAX_TRACKED_PIPES_PER_RUN`` cap on open pipes.

    Args:
        tracer: An ``opentelemetry.trace.Tracer`` (SDK or API no-op).
        include_content: When True, payload content (trace.data, end-of-run
            results, SSE data) is copied into span attributes, truncated to
            ``MAX_CONTENT_LENGTH`` characters. Default False: no payload text
            ever reaches a span.
    """

    def __init__(self, tracer: Any, *, include_content: bool = False) -> None:
        try:
            from opentelemetry import trace as trace_api
            from opentelemetry.trace import SpanKind, Status, StatusCode
        except ImportError as exc:  # pragma: no cover - exercised via subprocess test
            raise OtelNotInstalledError(missing_otel_message()) from exc

        self._tracer = tracer
        self._include_content = include_content
        self._trace_api = trace_api
        self._span_kind = SpanKind
        self._status = Status
        self._status_code = StatusCode
        self._runs: Dict[str, _RunState] = {}
        # (project_id, source) -> run key, for events that carry no __id.
        self._aliases: Dict[Tuple[str, str], str] = {}
        # Engine emission time (ns) of the event currently being handled;
        # None outside handle_event and for bodies with no usable eventTime,
        # in which case the bridge clock (arrival time) is used instead.
        self._event_ns: Optional[int] = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def handle_event(self, event_name: str, body: dict) -> None:
        """Dispatch one monitor event body by its DAP event name."""
        if not isinstance(body, dict):
            return
        # Stamp this event's spans with the engine's emission time. Reset in
        # finally so any span closed OUTSIDE an event (shutdown, snapshot
        # reconciliation, cap eviction) falls back to the bridge clock.
        self._event_ns = _event_time_ns(body)
        try:
            if event_name == 'apaevt_flow':
                self._handle_flow(body)
            elif event_name == 'apaevt_task':
                self._handle_task(body)
            elif event_name == 'apaevt_sse':
                self._handle_sse(body)
            # Other event types (status updates, output, ...) are not span-shaped.
        finally:
            self._event_ns = None

    def _now_ns(self) -> int:
        """Return the current event's engine time, or the bridge clock (arrival)."""
        return self._event_ns if self._event_ns is not None else time.time_ns()

    def _end_span(self, span: Any, start_ns: int) -> None:
        """
        End a span at the current event's engine time, never before its start.

        Clamping matters for a run that mixes stamped and unstamped events: a
        span opened on the bridge clock (arrival) must not be closed at an
        engine emission time that precedes it.
        """
        span.end(end_time=max(self._now_ns(), start_ns))

    def close_all(self) -> None:
        """Close every open span (components, pipe roots, task spans) as unclosed."""
        for run in list(self._runs.values()):
            self._close_run_spans(run, unclosed_task=True)
        self._runs.clear()
        self._aliases.clear()

    def open_span_count(self) -> int:
        """Return the number of currently open spans (for tests/diagnostics)."""
        count = 0
        for run in self._runs.values():
            if run.task_span is not None:
                count += 1
            for pipe in run.pipes.values():
                count += 1 + len(pipe.stack)
        return count

    # ------------------------------------------------------------------
    # Run correlation
    # ------------------------------------------------------------------

    @staticmethod
    def _identity(body: dict) -> Tuple[str, str, str]:
        """Extract (run_id, project_id, source) tolerating the wire's naming split."""
        run_id = body.get('__id') or ''
        # apaevt_task uses camelCase projectId; flow/status use project_id.
        project_id = body.get('project_id') or body.get('projectId') or ''
        source = body.get('source') or ''
        return run_id, project_id, source

    def _resolve_key(self, run_id: str, project_id: str, source: str) -> str:
        if run_id:
            return run_id
        alias = self._aliases.get((project_id, source))
        if alias:
            return alias
        return f'{project_id}|{source}'

    def _get_run(self, run_id: str, project_id: str, source: str) -> _RunState:
        key = self._resolve_key(run_id, project_id, source)
        run = self._runs.pop(key, None)
        if run_id and (project_id or source):
            # Reconcile, never duplicate: a run first observed through events
            # without a correlation id lives under the '<project>|<source>'
            # fallback key. That state can exist NEXT TO a canonical one when
            # no alias was registered yet — e.g. the canonical state was
            # seeded by an SSE __id, which carries no project/source. When
            # the canonical id and the project/source identity finally meet
            # on one event, a fallback-keyed state for the pair is PROMOTED
            # to the canonical key (no canonical state yet) or ABSORBED into
            # the existing canonical state — otherwise its open spans are
            # stranded (kept alive by every snapshot that announces the same
            # project/source pair) and later flow events spawn duplicate
            # implicit roots. Only the fallback-format key is touched; a run
            # tracked under a DIFFERENT canonical id is a distinct run and
            # is never merged.
            stray = self._runs.pop(f'{project_id}|{source}', None)
            if stray is not None:
                if run is None:
                    logger.debug('promoting fallback-keyed run %s to canonical id %s', stray.key, key)
                    run = stray
                    run.key = key
                    self._restamp_run_id(run, key)
                else:
                    logger.debug('absorbing fallback-keyed run %s into canonical run %s', stray.key, key)
                    self._absorb_fallback_run(run, stray)
        if run is None:
            # Evict before inserting so the new run itself is never a victim.
            self._evict_runs_above(MAX_TRACKED_RUNS - 1)
            run = _RunState(key=key, project_id=project_id, source=source)
        # (Re)insert last: dict order stays least-recently-eventful first,
        # so cap eviction always hits the longest-idle run.
        self._runs[key] = run
        if project_id or source:
            run.project_id = run.project_id or project_id
            run.source = run.source or source
            self._aliases[(run.project_id, run.source)] = key
        return run

    @staticmethod
    def _restamp_run_id(run: _RunState, key: str) -> None:
        """Update ATTR_RUN_ID on a promoted run's still-open spans to the canonical id."""
        if run.task_span is not None:
            run.task_span.set_attribute(ATTR_RUN_ID, key)
        for pipe in run.pipes.values():
            pipe.root.set_attribute(ATTR_RUN_ID, key)
            for entry in pipe.stack:
                entry.span.set_attribute(ATTR_RUN_ID, key)

    def _absorb_fallback_run(self, run: _RunState, stray: _RunState) -> None:
        """
        Merge a stranded fallback-keyed state into the already-tracked canonical run.

        The canonical state is authoritative: stray pipes it does not track
        migrate over (their open spans re-stamped with the canonical run id);
        a stray pipe whose id the canonical state already tracks is a
        duplicate segment and is closed as unclosed, like any other state the
        wire abandoned. A stray task span is adopted only when the canonical
        run has none; otherwise it too is closed as unclosed.
        """
        for pipe_id in list(stray.pipes):
            if pipe_id in run.pipes:
                self._close_pipe(stray, pipe_id, unclosed=True)
            else:
                state = stray.pipes.pop(pipe_id)
                run.pipes[pipe_id] = state
                self._evict_pipes_above(run, MAX_TRACKED_PIPES_PER_RUN)
                state.root.set_attribute(ATTR_RUN_ID, run.key)
                for entry in state.stack:
                    entry.span.set_attribute(ATTR_RUN_ID, run.key)
        if stray.task_span is not None:
            if run.task_span is None:
                run.task_span = stray.task_span
                run.task_start_ns = stray.task_start_ns
                run.task_span.set_attribute(ATTR_RUN_ID, run.key)
            else:
                stray.task_span.set_attribute(ATTR_SPAN_UNCLOSED, True)
                self._end_span(stray.task_span, stray.task_start_ns)
            stray.task_span = None
            stray.task_start_ns = 0
        run.name = run.name or stray.name
        run.project_id = run.project_id or stray.project_id
        run.source = run.source or stray.source

    def _evict_runs_above(self, max_size: int) -> None:
        """Close and drop least-recently-eventful runs until at most max_size remain."""
        while len(self._runs) > max_size:
            oldest = next(iter(self._runs.values()))
            logger.debug('tracked-run cap reached; closing idle run %s as unclosed', oldest.key)
            self._close_run_spans(oldest, unclosed_task=True)
            self._drop_run(oldest)

    def _drop_run(self, run: _RunState) -> None:
        self._runs.pop(run.key, None)
        for alias_key, target in list(self._aliases.items()):
            if target == run.key:
                del self._aliases[alias_key]

    # ------------------------------------------------------------------
    # apaevt_task: task lifecycle -> task-level root spans
    # ------------------------------------------------------------------

    def _handle_task(self, body: dict) -> None:
        action = body.get('action')
        if action == 'running':
            # Seeded snapshot (re-sent on every reconnect): idempotently ensure
            # a task span per announced task, never duplicating open ones.
            announced_keys = set()
            announced_pairs = set()
            for task in body.get('tasks') or []:
                if not isinstance(task, dict):
                    continue
                run_id, project_id, source = self._identity(task)
                run_id = task.get('id') or run_id
                if not (run_id or project_id or source):
                    continue
                run = self._get_run(run_id, project_id, source)
                self._ensure_task_span(run, task.get('name') or '')
                announced_keys.add(run.key)
                announced_pairs.add((run.project_id, run.source))
            # The snapshot is authoritative for which tasks are still alive:
            # any tracked run it does not announce (by key or by its
            # project/source identity) ended while its 'end' event was missed
            # (e.g. during a disconnect). Close it as unclosed and drop it so
            # a long-lived bridge does not accrue zombie runs.
            for run in list(self._runs.values()):
                if run.key in announced_keys or (run.project_id, run.source) in announced_pairs:
                    continue
                logger.debug('run %s missing from seeded running snapshot; closing as unclosed', run.key)
                self._close_run_spans(run, unclosed_task=True)
                self._drop_run(run)
            return

        run_id, project_id, source = self._identity(body)
        if not (run_id or project_id or source):
            return
        run = self._get_run(run_id, project_id, source)
        name = body.get('name') or ''

        if action == 'begin':
            self._ensure_task_span(run, name)
        elif action == 'end':
            self._close_run_spans(run, unclosed_task=False)
            self._drop_run(run)
        elif action == 'restart':
            # The engine restarted the task: close the previous segment's open
            # spans and open a fresh task span flagged as a restart.
            self._close_run_spans(run, unclosed_task=False)
            self._ensure_task_span(run, name)
            run.task_span.set_attribute(ATTR_TASK_RESTARTED, True)

    def _ensure_task_span(self, run: _RunState, name: str) -> None:
        if run.task_span is not None:
            return  # already announced (seeded 'running' snapshots repeat on reconnect)
        run.name = name or run.name
        attributes = {
            ATTR_PROJECT_ID: run.project_id,
            ATTR_SOURCE: run.source,
            ATTR_RUN_ID: run.key,
        }
        if run.name:
            attributes[ATTR_TASK_NAME] = run.name
        run.task_start_ns = self._now_ns()
        run.task_span = self._tracer.start_span(
            name=f'task {run.name}' if run.name else 'task',
            kind=self._span_kind.INTERNAL,
            attributes=attributes,
            start_time=run.task_start_ns,
        )

    def _close_run_spans(self, run: _RunState, *, unclosed_task: bool) -> None:
        """
        Close all open pipe/component spans of a run, then its task span.

        Pipe/component spans still open here always count as unclosed (their
        flow leave/end never arrived). The task span is only flagged unclosed
        when no lifecycle signal justified the close (bridge shutdown,
        seeded-snapshot reconciliation, or tracked-run cap eviction); a task
        'end'/'restart' event is an authoritative close.
        """
        for pipe_id in list(run.pipes):
            self._close_pipe(run, pipe_id, unclosed=True)
        if run.task_span is not None:
            if unclosed_task:
                run.task_span.set_attribute(ATTR_SPAN_UNCLOSED, True)
            self._end_span(run.task_span, run.task_start_ns)
            run.task_span = None
            run.task_start_ns = 0

    # ------------------------------------------------------------------
    # apaevt_flow: pipe segments and component spans
    # ------------------------------------------------------------------

    def _handle_flow(self, body: dict) -> None:
        run_id, project_id, source = self._identity(body)
        run = self._get_run(run_id, project_id, source)
        pipe_id = body.get('id')
        if not isinstance(pipe_id, int):
            return
        op = body.get('op')
        trace = body.get('trace') if isinstance(body.get('trace'), dict) else {}
        component = body.get('component') or ''

        if op == 'begin':
            self._flow_begin(run, pipe_id, component, body)
        elif op == 'enter':
            self._flow_enter(run, pipe_id, component, trace)
        elif op == 'leave':
            self._flow_leave(run, pipe_id, component, trace)
        elif op == 'end':
            self._flow_end(run, pipe_id, trace)

    def _pipe_attributes(self, run: _RunState, pipe_id: int) -> Dict[str, Any]:
        return {
            ATTR_PROJECT_ID: run.project_id,
            ATTR_SOURCE: run.source,
            ATTR_RUN_ID: run.key,
            ATTR_PIPE_ID: pipe_id,
        }

    def _context_for(self, parent_span: Any) -> Any:
        if parent_span is None:
            return None
        return self._trace_api.set_span_in_context(parent_span)

    def _open_root(self, run: _RunState, pipe_id: int, name: str, *, implicit: bool = False) -> _PipeState:
        attributes = self._pipe_attributes(run, pipe_id)
        if implicit:
            attributes[ATTR_SPAN_IMPLICIT] = True
        start_ns = self._now_ns()
        root = self._tracer.start_span(
            name=name,
            kind=self._span_kind.INTERNAL,
            context=self._context_for(run.task_span),
            attributes=attributes,
            start_time=start_ns,
        )
        state = _PipeState(root=root, start_ns=start_ns)
        # Evict before inserting so the new pipe is never its own victim.
        self._evict_pipes_above(run, MAX_TRACKED_PIPES_PER_RUN - 1)
        run.pipes[pipe_id] = state
        return state

    def _evict_pipes_above(self, run: _RunState, max_size: int) -> None:
        """Close and drop this run's least-recently-eventful pipes until at most max_size remain."""
        while len(run.pipes) > max_size:
            oldest_id = next(iter(run.pipes))
            logger.debug('tracked-pipe cap reached for run %s; closing idle pipe %s as unclosed', run.key, oldest_id)
            self._close_pipe(run, oldest_id, unclosed=True)

    @staticmethod
    def _touch_pipe(run: _RunState, pipe_id: int) -> None:
        """Move a pipe to the most-recently-eventful end of run.pipes.

        Insertion order alone is not a recency order: without this, a pipe that
        keeps emitting enter/leave events would still be evicted before a pipe
        that has been silent since it began.
        """
        state = run.pipes.pop(pipe_id, None)
        if state is not None:
            run.pipes[pipe_id] = state

    def _get_pipe(self, run: _RunState, pipe_id: int) -> _PipeState:
        """Return the pipe state, opening an implicit root for never-begun pipes."""
        state = run.pipes.get(pipe_id)
        if state is None:
            logger.debug('flow event for pipe %s of run %s before begin; opening implicit root', pipe_id, run.key)
            state = self._open_root(run, pipe_id, f'pipe {pipe_id}', implicit=True)
        else:
            self._touch_pipe(run, pipe_id)
        return state

    def _flow_begin(self, run: _RunState, pipe_id: int, component: str, body: dict) -> None:
        existing = run.pipes.get(pipe_id)
        if existing is not None:
            # A new object segment began before the previous one ended.
            self._close_pipe(run, pipe_id, unclosed=True)
        # On begin/end 'component' is the OBJECT name (== pipes[0]), not a
        # pipeline component id.
        pipes = body.get('pipes') or []
        object_name = component or (pipes[0] if pipes else f'pipe {pipe_id}')
        state = self._open_root(run, pipe_id, object_name)
        state.root.set_attribute(ATTR_OBJECT_NAME, object_name)

    def _flow_enter(self, run: _RunState, pipe_id: int, component: str, trace: dict) -> None:
        state = self._get_pipe(run, pipe_id)
        parent = state.stack[-1].span if state.stack else state.root
        name, kind, genai_attrs = self._classify_component(component)
        attributes = self._pipe_attributes(run, pipe_id)
        attributes[ATTR_COMPONENT] = component
        attributes.update(genai_attrs)
        lane = trace.get('lane')
        if isinstance(lane, str):
            attributes[ATTR_LANE] = lane
        if self._include_content and trace.get('data') is not None:
            attributes[ATTR_TRACE_DATA] = _serialize_content(trace['data'])
        start_ns = self._now_ns()
        span = self._tracer.start_span(
            name=name,
            kind=kind,
            context=self._context_for(parent),
            attributes=attributes,
            start_time=start_ns,
        )
        state.stack.append(_ComponentSpan(component=component, span=span, start_ns=start_ns))

    def _flow_leave(self, run: _RunState, pipe_id: int, component: str, trace: dict) -> None:
        state = self._get_pipe(run, pipe_id)
        # Pair by component identity (innermost matching entry), never by
        # stack position: leave's 'pipes' is already popped on the wire.
        index = None
        for i in range(len(state.stack) - 1, -1, -1):
            if state.stack[i].component == component:
                index = i
                break
        if index is None:
            state.unmatched_leaves += 1
            logger.debug('unmatched leave for component %r on pipe %s of run %s', component, pipe_id, run.key)
            return
        entry = state.stack.pop(index)
        span = entry.span
        result = trace.get('result')
        if isinstance(result, str):
            # Flow-control verdict ('continue', ...), not payload content.
            span.set_attribute(ATTR_FLOW_RESULT, result)
        if self._include_content and trace.get('data') is not None:
            span.set_attribute(ATTR_TRACE_DATA, _serialize_content(trace['data']))
        error = trace.get('error')
        if error:
            span.set_attribute(ATTR_ERROR_TYPE, ERROR_TYPE_FALLBACK)
            # exception.type is omitted: the wire carries no exception class
            # name, and the '_OTHER' fallback is defined only for error.type.
            if self._include_content:
                error_text = _serialize_content(error)
                span.add_event('exception', {'exception.message': error_text}, timestamp=self._event_ns)
                span.set_status(self._status(self._status_code.ERROR, error_text))
            else:
                # The wire error is a free-form string that can embed payload
                # (prompts, document text, credentialed URLs), so its text is
                # content-gated like every other payload surface. The error
                # SIGNAL — ERROR status, error.type, and the exception span
                # event — always exports; only the message text is withheld.
                span.add_event('exception', timestamp=self._event_ns)
                span.set_status(self._status(self._status_code.ERROR, GENERIC_ERROR_DESCRIPTION))
        self._end_span(span, entry.start_ns)

    def _flow_end(self, run: _RunState, pipe_id: int, trace: dict) -> None:
        state = run.pipes.get(pipe_id)
        if state is None:
            logger.debug('flow end for unknown pipe %s of run %s; ignoring', pipe_id, run.key)
            return
        # WIRE TRUTH: at level=summary the PIPELINE_RESULT arrives INSIDE
        # body.trace (there is no top-level 'result' field), and it contains
        # actual content -- it is gated behind include_content.
        if self._include_content and trace:
            state.root.set_attribute(ATTR_RESULT_CONTENT, _serialize_content(trace))
        self._close_pipe(run, pipe_id, unclosed=False)

    def _close_pipe(self, run: _RunState, pipe_id: int, *, unclosed: bool) -> None:
        state = run.pipes.pop(pipe_id, None)
        if state is None:
            return
        # Missing leave at end/shutdown: status stays UNSET, flagged unclosed.
        while state.stack:
            entry = state.stack.pop()
            entry.span.set_attribute(ATTR_SPAN_UNCLOSED, True)
            self._end_span(entry.span, entry.start_ns)
        if state.unmatched_leaves:
            state.root.set_attribute(ATTR_UNMATCHED_LEAVES, state.unmatched_leaves)
        if unclosed:
            state.root.set_attribute(ATTR_SPAN_UNCLOSED, True)
        self._end_span(state.root, state.start_ns)

    # ------------------------------------------------------------------
    # apaevt_sse: node-emitted custom messages -> span events
    # ------------------------------------------------------------------

    def _handle_sse(self, body: dict) -> None:
        pipe_id = body.get('pipe_id')
        sse_type = body.get('type') or 'sse'
        run_id = body.get('__id') or ''
        # SSE bodies carry no project_id/source; __id presence is unverified
        # on the wire. Route by __id when present (creating an implicit run if
        # the bridge attached mid-run), fall back to the sole active run, else
        # drop with a debug log.
        if run_id:
            run = self._get_run(run_id, '', '')
        elif len(self._runs) == 1:
            run = next(iter(self._runs.values()))
        else:
            logger.debug('cannot route apaevt_sse (type=%r) to a run; dropping', sse_type)
            return

        attributes: Dict[str, Any] = {ATTR_SSE_TYPE: sse_type}
        # 'data' is OMITTED (not null) on the wire when empty.
        if self._include_content and body.get('data') is not None:
            attributes[ATTR_SSE_DATA] = _serialize_content(body['data'])

        if isinstance(pipe_id, int):
            state = self._get_pipe(run, pipe_id)
            target = state.stack[-1].span if state.stack else state.root
        elif run.task_span is not None:
            target = run.task_span
        else:
            logger.debug('apaevt_sse without pipe_id and no task span for run %s; dropping', run.key)
            return
        target.add_event(sse_type, attributes, timestamp=self._event_ns)

    # ------------------------------------------------------------------
    # GenAI semantic conventions (Development stability, July 2026 snapshot)
    # ------------------------------------------------------------------

    def _classify_component(self, component: str) -> Tuple[str, Any, Dict[str, Any]]:
        """
        Derive (span name, span kind, gen_ai attributes) for a component id.

        RocketRide component ids are '<node provider>_<n>' (e.g. 'llm_openai_1').
        LLM/embedding nodes call remote model services -> SpanKind CLIENT with
        the spec span name '{operation} {model}' degraded to the bare operation
        because flow events carry no model name. Tool/agent nodes execute
        in-process -> INTERNAL. Everything else is a plain INTERNAL span named
        by the component id.
        """
        base = _INSTANCE_SUFFIX.sub('', component)
        genai: Dict[str, Any] = {}
        if base.startswith('llm_'):
            genai[GEN_AI_OPERATION_NAME] = 'chat'
            provider = _GENAI_PROVIDERS.get(base)
            if provider:
                genai[GEN_AI_PROVIDER_NAME] = provider
            return 'chat', self._span_kind.CLIENT, genai
        if base.startswith('embedding_'):
            genai[GEN_AI_OPERATION_NAME] = 'embeddings'
            provider = _GENAI_PROVIDERS.get(base)
            if provider:
                genai[GEN_AI_PROVIDER_NAME] = provider
            return 'embeddings', self._span_kind.CLIENT, genai
        if base.startswith('agent_'):
            # In-process agent frameworks are INTERNAL per gen-ai-agent-spans;
            # bare 'invoke_agent' because no agent name is available.
            genai[GEN_AI_OPERATION_NAME] = 'invoke_agent'
            return 'invoke_agent', self._span_kind.INTERNAL, genai
        if base.startswith('tool_'):
            tool_name = base[len('tool_') :]
            genai[GEN_AI_OPERATION_NAME] = 'execute_tool'
            genai[GEN_AI_TOOL_NAME] = tool_name
            return f'execute_tool {tool_name}', self._span_kind.INTERNAL, genai
        return component or 'component', self._span_kind.INTERNAL, genai


class MetricsMapper:
    """
    Maps apaevt_status_update snapshots to OpenTelemetry metrics.

    Pure consumer of an injected OpenTelemetry ``Meter``. Object counts are
    emitted as non-monotonic up-down counters fed with per-run deltas between
    snapshots (counts reset on restart, so deltas may be negative); rates and
    resource metrics are instantaneous gauges. All instruments carry
    ``rocketride.project_id`` / ``rocketride.source`` attributes.

    NOTE: the snapshot's ``tokens.*`` block is compute credits (100 = $1), NOT
    LLM tokens; it is intentionally not exported as ``gen_ai.usage.*``.
    Zero-valued metrics snapshots are exported as-is (all-zero is legitimate).

    Delta bookkeeping is bounded: at most ``MAX_TRACKED_METRIC_RUNS`` per-run
    entries are kept, evicting the least-recently-updated first, so a
    long-lived bridge does not grow with the number of runs ever observed.
    """

    def __init__(self, meter: Any) -> None:
        self._meter = meter
        self._last_counts: Dict[str, Tuple[int, int, int]] = {}
        self._objects_total = meter.create_up_down_counter(
            'rocketride.objects.total', unit='{object}', description='Objects seen by the pipeline run'
        )
        self._objects_completed = meter.create_up_down_counter(
            'rocketride.objects.completed', unit='{object}', description='Objects completed by the pipeline run'
        )
        self._objects_failed = meter.create_up_down_counter(
            'rocketride.objects.failed', unit='{object}', description='Objects failed by the pipeline run'
        )
        self._rate_count = meter.create_gauge(
            'rocketride.rate.count', unit='{object}/s', description='Instantaneous object processing rate'
        )
        self._rate_size = meter.create_gauge(
            'rocketride.rate.size', unit='By/s', description='Instantaneous byte processing rate'
        )
        self._cpu_percent = meter.create_gauge('rocketride.cpu.percent', unit='%', description='Engine CPU utilization')
        self._cpu_percent_peak = meter.create_gauge(
            'rocketride.cpu.percent.peak', unit='%', description='Peak engine CPU utilization'
        )
        self._cpu_memory = meter.create_gauge(
            'rocketride.memory.cpu_mb', unit='MBy', description='Engine CPU memory usage'
        )
        self._cpu_memory_peak = meter.create_gauge(
            'rocketride.memory.cpu_mb.peak', unit='MBy', description='Peak engine CPU memory usage'
        )
        self._gpu_memory = meter.create_gauge(
            'rocketride.memory.gpu_mb', unit='MBy', description='Engine GPU memory usage'
        )
        self._gpu_memory_peak = meter.create_gauge(
            'rocketride.memory.gpu_mb.peak', unit='MBy', description='Peak engine GPU memory usage'
        )

    def handle_status(self, body: dict) -> None:
        """Record metrics from one apaevt_status_update (TASK_STATUS) snapshot."""
        if not isinstance(body, dict):
            return
        project_id = body.get('project_id') or body.get('projectId') or ''
        source = body.get('source') or ''
        attributes = {ATTR_PROJECT_ID: project_id, ATTR_SOURCE: source}
        run_key = body.get('__id') or f'{project_id}|{source}'

        total = int(body.get('totalCount') or 0)
        completed = int(body.get('completedCount') or 0)
        failed = int(body.get('failedCount') or 0)
        # pop + reinsert keeps dict order least-recently-updated first, so the
        # cap below always evicts the run that has been silent the longest.
        # (A snapshot can arrive after the task's 'end' event, so entries are
        # NOT dropped on task end — that would re-count the final totals.)
        last_total, last_completed, last_failed = self._last_counts.pop(run_key, (0, 0, 0))
        self._objects_total.add(total - last_total, attributes)
        self._objects_completed.add(completed - last_completed, attributes)
        self._objects_failed.add(failed - last_failed, attributes)
        self._last_counts[run_key] = (total, completed, failed)
        while len(self._last_counts) > MAX_TRACKED_METRIC_RUNS:
            del self._last_counts[next(iter(self._last_counts))]

        self._rate_count.set(float(body.get('rateCount') or 0), attributes)
        self._rate_size.set(float(body.get('rateSize') or 0), attributes)

        metrics = body.get('metrics') if isinstance(body.get('metrics'), dict) else {}
        self._cpu_percent.set(float(metrics.get('cpu_percent') or 0.0), attributes)
        self._cpu_percent_peak.set(float(metrics.get('peak_cpu_percent') or 0.0), attributes)
        self._cpu_memory.set(float(metrics.get('cpu_memory_mb') or 0.0), attributes)
        self._cpu_memory_peak.set(float(metrics.get('peak_cpu_memory_mb') or 0.0), attributes)
        self._gpu_memory.set(float(metrics.get('gpu_memory_mb') or 0.0), attributes)
        self._gpu_memory_peak.set(float(metrics.get('peak_gpu_memory_mb') or 0.0), attributes)
