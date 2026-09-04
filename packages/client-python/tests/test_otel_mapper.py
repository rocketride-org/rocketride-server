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
Unit tests for rocketride.otelbridge.mapper (FlowSpanMapper / MetricsMapper).

Pure in-memory tests: monitor event bodies (from the live-captured fixture
file and synthetic edge cases) are fed to the mappers and the resulting span
forest / metric points are asserted via the OpenTelemetry SDK's in-memory
exporters. Skipped gracefully when the optional 'otel' extra is absent (the
base CI matrix does not install it).
"""

import json
import time
from pathlib import Path

import pytest

pytest.importorskip('opentelemetry')
pytest.importorskip('opentelemetry.sdk')

from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

import rocketride.otelbridge.mapper as mapper_module
from rocketride.otelbridge.mapper import (
    ATTR_COMPONENT,
    ATTR_FLOW_RESULT,
    ATTR_LANE,
    ATTR_PIPE_ID,
    ATTR_PROJECT_ID,
    ATTR_SOURCE,
    ATTR_SPAN_IMPLICIT,
    ATTR_SPAN_UNCLOSED,
    ATTR_TASK_RESTARTED,
    ATTR_UNMATCHED_LEAVES,
    GENERIC_ERROR_DESCRIPTION,
    MAX_CONTENT_LENGTH,
    FlowSpanMapper,
    MetricsMapper,
)

FIXTURE_PATH = Path(__file__).parent / 'fixtures' / 'otel_bridge_events.json'

RUN_ID = '1b4bbac0.webhook_1'
PROJECT_ID = 'e612b741-748c-4b35-a8b7-186797a8ea42'
SOURCE = 'webhook_1'

DEPRECATED_GENAI_ATTRS = (
    'gen_ai.system',
    'gen_ai.usage.prompt_tokens',
    'gen_ai.usage.completion_tokens',
    'gen_ai.prompt',
    'gen_ai.completion',
)


# =========================================================================
# HELPERS
# =========================================================================


def make_mapper(**kwargs):
    """Build a FlowSpanMapper wired to an InMemorySpanExporter."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    mapper = FlowSpanMapper(provider.get_tracer('test'), **kwargs)
    return mapper, exporter


def make_metrics_mapper():
    """Build a MetricsMapper wired to an InMemoryMetricReader."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    return MetricsMapper(provider.get_meter('test')), reader


def flow(op, component, pipe=0, trace=None, pipes=None, run_id=RUN_ID):
    """Build an apaevt_flow body matching the captured wire shape."""
    return {
        'id': pipe,
        'op': op,
        'pipes': pipes if pipes is not None else [],
        'component': component,
        'trace': trace if trace is not None else {},
        'project_id': PROJECT_ID,
        'source': SOURCE,
        '__id': run_id,
    }


def task(action, run_id=RUN_ID, **extra):
    """Build an apaevt_task body (camelCase projectId per the wire)."""
    body = {'action': action, 'projectId': PROJECT_ID, 'source': SOURCE, '__id': run_id}
    body.update(extra)
    return body


def spans_by_name(exporter, name):
    return [span for span in exporter.get_finished_spans() if span.name == name]


def span_contains(span, needle):
    """Scan every user-visible surface of a finished span for a payload string."""
    if needle in span.name:
        return True
    for key, value in (span.attributes or {}).items():
        if needle in str(key) or needle in str(value):
            return True
    for event in span.events:
        if needle in event.name:
            return True
        for key, value in (event.attributes or {}).items():
            if needle in str(key) or needle in str(value):
                return True
    if span.status is not None and span.status.description and needle in span.status.description:
        return True
    return False


def any_span_contains(exporter, needle):
    return any(span_contains(span, needle) for span in exporter.get_finished_spans())


def collect_metrics(reader):
    """
    Collect all metric data points ONCE, keyed by metric name.

    Gauge last-value aggregations are consumed by a collection cycle, so each
    test must collect a single snapshot and assert against it.
    """
    data = reader.get_metrics_data()
    points = {}
    if data is None:
        return points
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                points.setdefault(metric.name, []).extend(metric.data.data_points)
    return points


def metric_value(points, name):
    assert points.get(name), f'no data points for metric {name!r}'
    return points[name][-1].value


def load_fixture():
    return json.loads(FIXTURE_PATH.read_text())


# =========================================================================
# FLOW SPAN PAIRING
# =========================================================================


def test_begin_enter_leave_end_cycle():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'response_1', trace={'data': None, 'lane': 'open'}))
    mapper.handle_event(
        'apaevt_flow', flow('leave', 'response_1', trace={'data': None, 'lane': 'open', 'result': 'continue'})
    )
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt', trace={'name': 'probe.txt'}))

    spans = exporter.get_finished_spans()
    assert [span.name for span in spans] == ['response_1', 'probe.txt']
    child, root = spans
    assert root.parent is None
    assert child.parent is not None and child.parent.span_id == root.context.span_id
    assert child.attributes[ATTR_COMPONENT] == 'response_1'
    assert child.attributes[ATTR_LANE] == 'open'
    assert child.attributes[ATTR_FLOW_RESULT] == 'continue'
    assert child.attributes[ATTR_PIPE_ID] == 0
    assert child.attributes[ATTR_PROJECT_ID] == PROJECT_ID
    assert child.attributes[ATTR_SOURCE] == SOURCE
    assert mapper.open_span_count() == 0


def test_real_fixture_flow_cycle():
    """The verbatim wire-captured cycle: begin + one enter/leave per lane + end."""
    mapper, exporter = make_mapper()
    for record in load_fixture():
        if record['event'] == 'apaevt_flow' and not record.get('_synthesized'):
            mapper.handle_event('apaevt_flow', record['body'])

    spans = exporter.get_finished_spans()
    assert len(spans) == 5
    roots = spans_by_name(exporter, 'probe.txt')
    assert len(roots) == 1
    children = spans_by_name(exporter, 'response_1')
    assert len(children) == 4
    assert {span.attributes[ATTR_LANE] for span in children} == {'open', 'text', 'closing', 'close'}
    for child in children:
        assert child.parent.span_id == roots[0].context.span_id
    assert mapper.open_span_count() == 0


def test_nested_enters_stack_parentage():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'obj.txt', pipes=['obj.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'outer_1', trace={'lane': 'text'}))
    mapper.handle_event('apaevt_flow', flow('enter', 'inner_1', trace={'lane': 'text'}))
    mapper.handle_event('apaevt_flow', flow('leave', 'inner_1', trace={'lane': 'text', 'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('leave', 'outer_1', trace={'lane': 'text', 'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'obj.txt'))

    inner = spans_by_name(exporter, 'inner_1')[0]
    outer = spans_by_name(exporter, 'outer_1')[0]
    root = spans_by_name(exporter, 'obj.txt')[0]
    assert inner.parent.span_id == outer.context.span_id
    assert outer.parent.span_id == root.context.span_id


def test_leave_pairs_by_component_identity_not_stack_position():
    """An out-of-order leave must close the span with the matching component."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'obj.txt', pipes=['obj.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_a_1'))
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_b_1'))
    # comp_a leaves while comp_b is on top of the stack.
    mapper.handle_event('apaevt_flow', flow('leave', 'comp_a_1', trace={'result': 'continue'}))
    assert [span.name for span in exporter.get_finished_spans()] == ['comp_a_1']
    mapper.handle_event('apaevt_flow', flow('leave', 'comp_b_1', trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'obj.txt'))

    for span in exporter.get_finished_spans():
        assert ATTR_SPAN_UNCLOSED not in (span.attributes or {})
    root = spans_by_name(exporter, 'obj.txt')[0]
    assert ATTR_UNMATCHED_LEAVES not in (root.attributes or {})


def test_unknown_leave_is_tolerated_and_counted():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'obj.txt', pipes=['obj.txt']))
    mapper.handle_event('apaevt_flow', flow('leave', 'ghost_1', trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'obj.txt'))

    root = spans_by_name(exporter, 'obj.txt')[0]
    assert root.attributes[ATTR_UNMATCHED_LEAVES] == 1


def test_end_closes_open_components_as_unclosed():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'obj.txt', pipes=['obj.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_a_1'))
    mapper.handle_event('apaevt_flow', flow('end', 'obj.txt'))

    dangling = spans_by_name(exporter, 'comp_a_1')[0]
    assert dangling.attributes[ATTR_SPAN_UNCLOSED] is True
    assert dangling.status.status_code == StatusCode.UNSET
    root = spans_by_name(exporter, 'obj.txt')[0]
    assert ATTR_SPAN_UNCLOSED not in (root.attributes or {})


def test_enter_without_begin_opens_implicit_root():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_a_1'))
    mapper.handle_event('apaevt_flow', flow('leave', 'comp_a_1', trace={'result': 'continue'}))
    mapper.close_all()

    root = spans_by_name(exporter, 'pipe 0')[0]
    assert root.attributes[ATTR_SPAN_IMPLICIT] is True
    child = spans_by_name(exporter, 'comp_a_1')[0]
    assert child.parent.span_id == root.context.span_id


def test_begin_for_already_open_pipe_recycles_root():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'first.txt', pipes=['first.txt']))
    mapper.handle_event('apaevt_flow', flow('begin', 'second.txt', pipes=['second.txt']))
    mapper.close_all()

    first = spans_by_name(exporter, 'first.txt')[0]
    assert first.attributes[ATTR_SPAN_UNCLOSED] is True
    assert len(spans_by_name(exporter, 'second.txt')) == 1


def _feed_error_leave(mapper, error_text):
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'llm_openai_1', trace={'lane': 'questions'}))
    mapper.handle_event(
        'apaevt_flow', flow('leave', 'llm_openai_1', trace={'data': None, 'lane': 'questions', 'error': error_text})
    )
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))


def test_error_leave_with_content_exports_error_text():
    mapper, exporter = make_mapper(include_content=True)
    error_text = 'OpenAI API error: 401 Unauthorized'
    _feed_error_leave(mapper, error_text)

    span = spans_by_name(exporter, 'chat')[0]
    assert span.status.status_code == StatusCode.ERROR
    assert error_text in span.status.description
    assert span.attributes['error.type'] == '_OTHER'
    exception_events = [event for event in span.events if event.name == 'exception']
    assert exception_events and exception_events[0].attributes['exception.message'] == error_text


def test_error_leave_by_default_exports_signal_but_not_error_text():
    """Wire error strings can embed payload; without include_content only the
    structural error signal (status, error.type, exception event) exports.
    """
    mapper, exporter = make_mapper()
    _feed_error_leave(mapper, f'prompt rejected: {SENTINEL}')

    span = spans_by_name(exporter, 'chat')[0]
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description == GENERIC_ERROR_DESCRIPTION
    assert span.attributes['error.type'] == '_OTHER'
    exception_events = [event for event in span.events if event.name == 'exception']
    assert exception_events and not (exception_events[0].attributes or {})
    assert not any_span_contains(exporter, SENTINEL)


def test_error_leave_with_content_truncates_string_errors_to_cap():
    mapper, exporter = make_mapper(include_content=True)
    _feed_error_leave(mapper, 'e' * (MAX_CONTENT_LENGTH * 2))

    span = spans_by_name(exporter, 'chat')[0]
    exception_events = [event for event in span.events if event.name == 'exception']
    assert len(exception_events[0].attributes['exception.message']) <= MAX_CONTENT_LENGTH
    assert len(span.status.description) <= MAX_CONTENT_LENGTH


# =========================================================================
# SSE EVENTS
# =========================================================================


def test_sse_becomes_event_on_innermost_span():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'agent_rocketride_1'))
    mapper.handle_event('apaevt_sse', {'pipe_id': 0, 'type': 'thinking', 'data': {'message': 'hmm'}, '__id': RUN_ID})
    mapper.handle_event('apaevt_flow', flow('leave', 'agent_rocketride_1', trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))

    agent_span = spans_by_name(exporter, 'invoke_agent')[0]
    events = [event for event in agent_span.events if event.name == 'thinking']
    assert events and events[0].attributes['rocketride.sse.type'] == 'thinking'
    root = spans_by_name(exporter, 'probe.txt')[0]
    assert not [event for event in root.events if event.name == 'thinking']


def test_sse_without_id_routes_to_sole_active_run():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    # No __id, 'data' key omitted entirely (wire truth): must not KeyError.
    mapper.handle_event('apaevt_sse', {'pipe_id': 0, 'type': 'tool_call'})
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))

    root = spans_by_name(exporter, 'probe.txt')[0]
    assert [event for event in root.events if event.name == 'tool_call']


def test_sse_unroutable_is_dropped():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_sse', {'pipe_id': 0, 'type': 'thinking'})  # no runs at all
    mapper.close_all()
    assert exporter.get_finished_spans() == ()


# =========================================================================
# PRIVACY GATE
# =========================================================================

SENTINEL = 'SECRET_PAYLOAD_a4f1c2'


def _feed_content_events(mapper):
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event(
        'apaevt_flow', flow('enter', 'llm_openai_1', trace={'lane': 'text', 'data': {'text': SENTINEL}})
    )
    mapper.handle_event('apaevt_sse', {'pipe_id': 0, 'type': 'thinking', 'data': {'message': SENTINEL}, '__id': RUN_ID})
    mapper.handle_event(
        'apaevt_flow',
        flow('leave', 'llm_openai_1', trace={'lane': 'text', 'data': {'text': SENTINEL}, 'result': 'continue'}),
    )
    # Error text is a payload surface too: node errors can quote the input.
    mapper.handle_event('apaevt_flow', flow('enter', 'llm_openai_2', trace={'lane': 'text'}))
    mapper.handle_event(
        'apaevt_flow', flow('leave', 'llm_openai_2', trace={'lane': 'text', 'error': f'bad prompt: {SENTINEL}'})
    )
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt', trace={'name': 'probe.txt', 'text': [SENTINEL]}))


def test_privacy_default_no_payload_reaches_spans():
    """Grep-provable default: without include_content no payload text is exported."""
    mapper, exporter = make_mapper()
    _feed_content_events(mapper)
    assert exporter.get_finished_spans()
    assert not any_span_contains(exporter, SENTINEL)


def test_include_content_exposes_payloads():
    mapper, exporter = make_mapper(include_content=True)
    _feed_content_events(mapper)
    assert any_span_contains(exporter, SENTINEL)


def test_include_content_truncates_to_cap():
    mapper, exporter = make_mapper(include_content=True)
    big = 'x' * (MAX_CONTENT_LENGTH * 2)
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_a_1', trace={'lane': 'text', 'data': {'text': big}}))
    mapper.handle_event('apaevt_flow', flow('leave', 'comp_a_1', trace={'lane': 'text', 'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))

    span = spans_by_name(exporter, 'comp_a_1')[0]
    assert len(span.attributes['rocketride.trace.data']) <= MAX_CONTENT_LENGTH


# =========================================================================
# TASK LIFECYCLE
# =========================================================================


def test_task_span_wraps_pipe_roots():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', name='demo.My webhook'))
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))
    mapper.handle_event('apaevt_task', task('end', name='demo.My webhook'))

    task_span = spans_by_name(exporter, 'task demo.My webhook')[0]
    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.parent.span_id == task_span.context.span_id
    assert task_span.parent is None
    assert task_span.attributes['rocketride.task.name'] == 'demo.My webhook'
    assert mapper.open_span_count() == 0


def test_running_snapshot_is_idempotent():
    """Reconnects re-seed the running snapshot; spans must not duplicate."""
    mapper, exporter = make_mapper()
    running = {
        'action': 'running',
        'tasks': [{'id': RUN_ID, 'name': 'demo.My webhook', 'projectId': PROJECT_ID, 'source': SOURCE}],
        '__id': '',
    }
    mapper.handle_event('apaevt_task', running)
    mapper.handle_event('apaevt_task', running)
    mapper.handle_event('apaevt_task', task('begin', name='demo.My webhook'))
    mapper.close_all()

    assert len(spans_by_name(exporter, 'task demo.My webhook')) == 1


def test_late_canonical_id_promotes_fallback_keyed_run():
    """A run first seen through no-__id events must be promoted, not duplicated,
    when its canonical id arrives (regression: second _RunState + implicit
    duplicate roots + fallback state kept alive forever by snapshots).
    """
    mapper, exporter = make_mapper()
    # Flow events before any task announcement, without __id -> fallback key.
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt'], run_id=''))
    mapper.handle_event('apaevt_flow', flow('enter', 'response_1', run_id=''))
    # The canonical run id arrives via the seeded running snapshot.
    mapper.handle_event(
        'apaevt_task',
        {
            'action': 'running',
            'tasks': [{'id': RUN_ID, 'name': 'demo', 'projectId': PROJECT_ID, 'source': SOURCE}],
            '__id': '',
        },
    )
    # Subsequent flow events carry the canonical id and must hit the SAME run.
    mapper.handle_event('apaevt_flow', flow('leave', 'response_1', trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))
    mapper.handle_event('apaevt_task', task('end'))

    assert mapper.open_span_count() == 0  # nothing stranded under the fallback key
    assert len(spans_by_name(exporter, 'task demo')) == 1
    assert len(spans_by_name(exporter, 'probe.txt')) == 1
    assert not spans_by_name(exporter, 'pipe 0')  # no implicit duplicate root
    leave_span = spans_by_name(exporter, 'response_1')[0]
    assert ATTR_SPAN_UNCLOSED not in (leave_span.attributes or {})
    # Open spans of the promoted run are re-stamped with the canonical id.
    assert leave_span.attributes['rocketride.run_id'] == RUN_ID
    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.attributes['rocketride.run_id'] == RUN_ID


def test_promotion_never_merges_distinct_canonical_runs():
    """Two runs with different canonical ids for the same project/source stay separate."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', run_id='aaaa1111.webhook_1', name='first'))
    mapper.handle_event('apaevt_task', task('begin', run_id='bbbb2222.webhook_1', name='second'))
    mapper.close_all()

    assert len(spans_by_name(exporter, 'task first')) == 1
    assert len(spans_by_name(exporter, 'task second')) == 1


def test_fallback_state_absorbed_when_canonical_state_already_exists():
    """SSE-first ordering: an SSE __id seeds the canonical state WITHOUT
    project/source (SSE bodies carry neither), so no alias exists and id-less
    flow events open a parallel fallback-keyed state. When the canonical id
    and the project/source identity finally meet on one event, the fallback
    state must be absorbed — not left stranded next to the canonical one.
    """
    mapper, exporter = make_mapper()
    # 1. SSE with __id creates the canonical run (implicit root for pipe 5).
    mapper.handle_event('apaevt_sse', {'pipe_id': 5, 'type': 'thinking', '__id': RUN_ID})
    # 2. Id-less flow events for the same run: no alias -> fallback state.
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt'], run_id=''))
    mapper.handle_event('apaevt_flow', flow('enter', 'response_1', run_id=''))
    # 3. Canonical id + project/source meet on the task begin event.
    mapper.handle_event('apaevt_task', task('begin', name='demo'))
    # 4. Later canonical-id flow events must hit the one surviving state.
    mapper.handle_event('apaevt_flow', flow('leave', 'response_1', trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))
    mapper.handle_event('apaevt_task', task('end'))

    assert mapper.open_span_count() == 0  # nothing stranded under the fallback key
    assert len(spans_by_name(exporter, 'task demo')) == 1
    assert len(spans_by_name(exporter, 'probe.txt')) == 1
    assert not spans_by_name(exporter, 'pipe 0')  # no duplicate root for pipe 0
    leave_span = spans_by_name(exporter, 'response_1')[0]
    assert ATTR_SPAN_UNCLOSED not in (leave_span.attributes or {})
    # Migrated spans are re-stamped with the canonical id.
    assert leave_span.attributes['rocketride.run_id'] == RUN_ID
    assert spans_by_name(exporter, 'probe.txt')[0].attributes['rocketride.run_id'] == RUN_ID


def test_fallback_absorption_closes_colliding_pipes_as_unclosed():
    """When both states opened the same pipe id, the canonical segment wins
    and the fallback duplicate is closed as unclosed rather than merged.
    """
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_sse', {'pipe_id': 0, 'type': 'thinking', '__id': RUN_ID})
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt'], run_id=''))
    mapper.handle_event('apaevt_task', task('begin', name='demo'))  # reconciles: pipe 0 collides
    mapper.handle_event('apaevt_task', task('end'))

    assert mapper.open_span_count() == 0
    # The fallback duplicate for pipe 0 was closed as unclosed at absorption.
    stray_root = spans_by_name(exporter, 'probe.txt')[0]
    assert stray_root.attributes[ATTR_SPAN_UNCLOSED] is True
    # The canonical implicit root (carrying the SSE event) survived until task end.
    implicit = spans_by_name(exporter, 'pipe 0')[0]
    assert [event for event in implicit.events if event.name == 'thinking']


def test_task_restart_closes_and_reopens():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', name='demo.My webhook'))
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_task', task('restart', name='demo.My webhook'))
    mapper.close_all()

    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.attributes[ATTR_SPAN_UNCLOSED] is True
    task_spans = spans_by_name(exporter, 'task demo.My webhook')
    assert len(task_spans) == 2
    assert sum(1 for span in task_spans if (span.attributes or {}).get(ATTR_TASK_RESTARTED)) == 1


def test_close_all_closes_everything_and_is_reentrant():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', name='demo'))
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'comp_a_1'))
    assert mapper.open_span_count() == 3
    mapper.close_all()
    assert mapper.open_span_count() == 0
    spans = exporter.get_finished_spans()
    assert len(spans) == 3
    assert all(span.end_time is not None for span in spans)
    assert all((span.attributes or {}).get(ATTR_SPAN_UNCLOSED) for span in spans)
    mapper.close_all()  # re-entrant no-op
    assert len(exporter.get_finished_spans()) == 3


# =========================================================================
# BOUNDED STATE (missed 'end' events must not leak open spans forever)
# =========================================================================


def test_running_snapshot_reconciles_runs_with_missed_ends():
    """A seeded snapshot that no longer announces a tracked run closes it."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', name='demo.My webhook'))
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    # Bridge reconnects; the run ended while disconnected, so the re-seeded
    # snapshot only announces a different, still-running task.
    mapper.handle_event(
        'apaevt_task',
        {
            'action': 'running',
            'tasks': [{'id': 'aa11bb22.other_1', 'name': 'other', 'projectId': 'p-other', 'source': 'other_1'}],
            '__id': '',
        },
    )

    stale_root = spans_by_name(exporter, 'probe.txt')[0]
    assert stale_root.attributes[ATTR_SPAN_UNCLOSED] is True
    stale_task = spans_by_name(exporter, 'task demo.My webhook')[0]
    assert stale_task.attributes[ATTR_SPAN_UNCLOSED] is True
    # Only the announced task remains tracked/open.
    assert mapper.open_span_count() == 1
    mapper.close_all()
    assert spans_by_name(exporter, 'task other')


def test_running_snapshot_keeps_announced_runs_open():
    """Reconciliation must not touch runs the snapshot still announces."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', name='demo.My webhook'))
    mapper.handle_event(
        'apaevt_task',
        {
            'action': 'running',
            'tasks': [{'id': RUN_ID, 'name': 'demo.My webhook', 'projectId': PROJECT_ID, 'source': SOURCE}],
            '__id': '',
        },
    )

    assert exporter.get_finished_spans() == ()
    assert mapper.open_span_count() == 1


def test_tracked_run_cap_evicts_least_recently_eventful_run(monkeypatch):
    monkeypatch.setattr(mapper_module, 'MAX_TRACKED_RUNS', 2)
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', task('begin', run_id='run1.s', name='one'))
    mapper.handle_event('apaevt_task', task('begin', run_id='run2.s', name='two'))
    # Touch run1 so run2 becomes the least recently eventful...
    mapper.handle_event('apaevt_flow', flow('begin', 'obj.txt', pipes=['obj.txt'], run_id='run1.s'))
    # ...then a third run must evict run2, closing its span as unclosed.
    mapper.handle_event('apaevt_task', task('begin', run_id='run3.s', name='three'))

    evicted = spans_by_name(exporter, 'task two')[0]
    assert evicted.attributes[ATTR_SPAN_UNCLOSED] is True
    assert not spans_by_name(exporter, 'task one')
    assert not spans_by_name(exporter, 'task three')
    assert mapper.open_span_count() == 3  # run1 task + pipe root, run3 task


def test_tracked_pipe_cap_evicts_least_recently_eventful_pipe(monkeypatch):
    """A run that keeps receiving events is never evicted; its pipes still must be."""
    monkeypatch.setattr(mapper_module, 'MAX_TRACKED_PIPES_PER_RUN', 2)
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'one.txt', pipe=1, pipes=['one.txt']))
    mapper.handle_event('apaevt_flow', flow('begin', 'two.txt', pipe=2, pipes=['two.txt']))
    # Touch pipe 1 so pipe 2 becomes the least recently eventful. Insertion
    # order alone would have made pipe 1 the victim instead.
    mapper.handle_event('apaevt_flow', flow('enter', 'step', pipe=1, trace={}))
    # A third pipe must evict pipe 2, closing its root as unclosed.
    mapper.handle_event('apaevt_flow', flow('begin', 'three.txt', pipe=3, pipes=['three.txt']))

    evicted = spans_by_name(exporter, 'two.txt')
    assert len(evicted) == 1
    assert evicted[0].attributes[ATTR_SPAN_UNCLOSED] is True
    assert not spans_by_name(exporter, 'one.txt')
    assert not spans_by_name(exporter, 'three.txt')
    assert set(mapper._runs[RUN_ID].pipes) == {1, 3}


def test_tracked_pipe_cap_bounds_a_never_ending_run(monkeypatch):
    """Pipes that never emit 'end' cannot grow without bound."""
    monkeypatch.setattr(mapper_module, 'MAX_TRACKED_PIPES_PER_RUN', 4)
    mapper, _exporter = make_mapper()
    for pipe_id in range(50):
        mapper.handle_event('apaevt_flow', flow('begin', f'p{pipe_id}.txt', pipe=pipe_id, pipes=[f'p{pipe_id}.txt']))

    assert len(mapper._runs[RUN_ID].pipes) == 4


def test_metrics_last_counts_bounded_lru(monkeypatch):
    monkeypatch.setattr(mapper_module, 'MAX_TRACKED_METRIC_RUNS', 2)
    mapper, reader = make_metrics_mapper()
    template = next(body for body in _status_records() if body['totalCount'] == 1)
    for run in ('a.s', 'b.s', 'a.s', 'c.s'):  # refresh 'a.s' before 'c.s' arrives
        mapper.handle_status(dict(template, __id=run))

    assert set(mapper._last_counts) == {'a.s', 'c.s'}  # 'b.s' was the LRU entry
    collect_metrics(reader)  # drain so other tests see a clean reader


def test_genai_llm_component_attributes():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('enter', 'llm_openai_1', trace={'lane': 'questions'}))
    mapper.handle_event('apaevt_flow', flow('leave', 'llm_openai_1', trace={'lane': 'questions', 'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))

    span = spans_by_name(exporter, 'chat')[0]
    assert span.kind == SpanKind.CLIENT
    assert span.attributes['gen_ai.operation.name'] == 'chat'
    assert span.attributes['gen_ai.provider.name'] == 'openai'
    assert span.attributes[ATTR_COMPONENT] == 'llm_openai_1'
    for deprecated in DEPRECATED_GENAI_ATTRS:
        assert deprecated not in span.attributes


def test_genai_unknown_provider_is_omitted_not_invented():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('enter', 'llm_ollama_1'))
    mapper.close_all()

    span = spans_by_name(exporter, 'chat')[0]
    assert span.attributes['gen_ai.operation.name'] == 'chat'
    assert 'gen_ai.provider.name' not in span.attributes


def test_genai_tool_agent_and_embedding_components():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    for component in ('tool_python_1', 'agent_rocketride_1', 'embedding_openai_1'):
        mapper.handle_event('apaevt_flow', flow('enter', component))
        mapper.handle_event('apaevt_flow', flow('leave', component, trace={'result': 'continue'}))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))

    tool = spans_by_name(exporter, 'execute_tool python')[0]
    assert tool.kind == SpanKind.INTERNAL
    assert tool.attributes['gen_ai.operation.name'] == 'execute_tool'
    assert tool.attributes['gen_ai.tool.name'] == 'python'

    agent = spans_by_name(exporter, 'invoke_agent')[0]
    assert agent.kind == SpanKind.INTERNAL
    assert agent.attributes['gen_ai.operation.name'] == 'invoke_agent'

    embedding = spans_by_name(exporter, 'embeddings')[0]
    assert embedding.kind == SpanKind.CLIENT
    assert embedding.attributes['gen_ai.operation.name'] == 'embeddings'
    assert embedding.attributes['gen_ai.provider.name'] == 'openai'


def test_plain_component_has_no_genai_attributes():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('enter', 'response_1'))
    mapper.close_all()

    span = spans_by_name(exporter, 'response_1')[0]
    assert span.kind == SpanKind.INTERNAL
    assert not [key for key in span.attributes if key.startswith('gen_ai.')]


# =========================================================================
# METRICS
# =========================================================================


def _status_records():
    return [record['body'] for record in load_fixture() if record['event'] == 'apaevt_status_update']


def test_metrics_from_status_fixture():
    mapper, reader = make_metrics_mapper()
    counted = next(body for body in _status_records() if body['totalCount'] == 1)
    mapper.handle_status(counted)

    points = collect_metrics(reader)
    assert metric_value(points, 'rocketride.objects.total') == 1
    assert metric_value(points, 'rocketride.objects.completed') == 1
    assert metric_value(points, 'rocketride.objects.failed') == 0
    assert metric_value(points, 'rocketride.memory.cpu_mb') == pytest.approx(301.2265625)
    assert metric_value(points, 'rocketride.cpu.percent.peak') == pytest.approx(61.45)
    point = points['rocketride.objects.total'][-1]
    assert point.attributes['rocketride.project_id'] == PROJECT_ID
    assert point.attributes['rocketride.source'] == SOURCE


def test_metrics_counts_use_deltas_not_resums():
    mapper, reader = make_metrics_mapper()
    counted = next(body for body in _status_records() if body['totalCount'] == 1)
    mapper.handle_status(counted)
    mapper.handle_status(counted)  # identical snapshot: cumulative sum must not double
    assert metric_value(collect_metrics(reader), 'rocketride.objects.total') == 1

    grown = dict(counted, totalCount=3, completedCount=2, failedCount=1)
    mapper.handle_status(grown)
    points = collect_metrics(reader)
    assert metric_value(points, 'rocketride.objects.total') == 3
    assert metric_value(points, 'rocketride.objects.completed') == 2
    assert metric_value(points, 'rocketride.objects.failed') == 1


def test_metrics_all_zero_snapshot_still_emits_gauges():
    """Wire truth: metrics can legitimately be all zero; gauges must still export."""
    mapper, reader = make_metrics_mapper()
    zero = next(body for body in _status_records() if body['state'] == 1)
    mapper.handle_status(zero)

    points = collect_metrics(reader)
    for name in (
        'rocketride.rate.count',
        'rocketride.rate.size',
        'rocketride.cpu.percent',
        'rocketride.memory.cpu_mb',
        'rocketride.memory.gpu_mb',
    ):
        assert metric_value(points, name) == 0.0


# =========================================================================
# FULL FIXTURE REPLAY
# =========================================================================


def test_full_fixture_replay_produces_coherent_span_forest():
    """Feed all 24 captured/synthesized records end to end; no crashes, all spans closed."""
    mapper, exporter = make_mapper()
    metrics_mapper, reader = make_metrics_mapper()

    for record in load_fixture():
        if record['event'] == 'apaevt_status_update':
            metrics_mapper.handle_status(record['body'])
        else:
            mapper.handle_event(record['event'], record['body'])
    mapper.close_all()

    spans = exporter.get_finished_spans()
    assert mapper.open_span_count() == 0
    assert all(span.end_time is not None for span in spans)
    assert len(spans) == 10

    # First run: task span wrapping the probe.txt pipe root and 4 lane spans.
    task_spans = [span for span in spans if span.name.startswith('task ')]
    assert len(task_spans) == 3  # begin/end run, seeded running task, post-restart task
    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.parent is not None
    assert len(spans_by_name(exporter, 'response_1')) == 4

    # Post-task-end SSE + flow re-attach on an implicit root; error maps to status.
    implicit = spans_by_name(exporter, 'pipe 0')[0]
    assert implicit.attributes[ATTR_SPAN_IMPLICIT] is True
    assert [event for event in implicit.events if event.name == 'thinking']
    chat = spans_by_name(exporter, 'chat')[0]
    assert chat.status.status_code == StatusCode.ERROR
    assert chat.parent.span_id == implicit.context.span_id

    # Privacy default: real result payload, SSE text, and the wire error text
    # (free-form, can embed payload) never exported.
    assert not any_span_contains(exporter, 'hello otel bridge')
    assert not any_span_contains(exporter, 'Analyzing your request')
    assert not any_span_contains(exporter, '401 Unauthorized')

    # No deprecated GenAI attribute anywhere.
    for span in spans:
        for deprecated in DEPRECATED_GENAI_ATTRS:
            assert deprecated not in (span.attributes or {})

    # Metrics ingested from the same replay.
    points = collect_metrics(reader)
    assert metric_value(points, 'rocketride.objects.total') == 1
    assert metric_value(points, 'rocketride.memory.cpu_mb.peak') == pytest.approx(322.24609375)


# =========================================================================
# ENGINE EVENT TIME (body.eventTime -> span timestamps)
# =========================================================================

# Fixed epoch seconds well in the past, so a fallback to the SDK clock is
# always distinguishable from an engine stamp.
T0 = 1_750_000_000.0


def at(body, offset_seconds):
    """Return a copy of an event body stamped with eventTime = T0 + offset."""
    stamped = dict(body)
    stamped['eventTime'] = T0 + offset_seconds
    return stamped


def ns(offset_seconds):
    return int((T0 + offset_seconds) * 1_000_000_000)


def test_event_time_ns_rejects_unusable_values():
    assert mapper_module._event_time_ns({}) is None
    assert mapper_module._event_time_ns({'eventTime': None}) is None
    assert mapper_module._event_time_ns({'eventTime': '1750000000'}) is None
    assert mapper_module._event_time_ns({'eventTime': True}) is None
    assert mapper_module._event_time_ns({'eventTime': 0}) is None
    assert mapper_module._event_time_ns({'eventTime': -1.0}) is None
    assert mapper_module._event_time_ns({'eventTime': float('nan')}) is None
    assert mapper_module._event_time_ns({'eventTime': float('inf')}) is None
    assert mapper_module._event_time_ns({'eventTime': T0}) == ns(0)


def test_span_timestamps_come_from_event_time():
    """Engine-measured durations: start/end are the wire's eventTime, not arrival."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_task', at(task('begin', name='demo.My webhook'), 0))
    mapper.handle_event('apaevt_flow', at(flow('begin', 'probe.txt', pipes=['probe.txt']), 1))
    mapper.handle_event('apaevt_flow', at(flow('enter', 'llm_openai_1'), 2))
    mapper.handle_event('apaevt_flow', at(flow('leave', 'llm_openai_1', trace={'result': 'continue'}), 5))
    mapper.handle_event('apaevt_flow', at(flow('end', 'probe.txt'), 6))
    mapper.handle_event('apaevt_task', at(task('end'), 7))

    component = spans_by_name(exporter, 'chat')[0]
    assert (component.start_time, component.end_time) == (ns(2), ns(5))
    assert component.end_time - component.start_time == 3_000_000_000

    pipe_root = spans_by_name(exporter, 'probe.txt')[0]
    assert (pipe_root.start_time, pipe_root.end_time) == (ns(1), ns(6))

    task_span = spans_by_name(exporter, 'task demo.My webhook')[0]
    assert (task_span.start_time, task_span.end_time) == (ns(0), ns(7))


def test_sse_span_event_uses_event_time():
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', at(flow('begin', 'probe.txt', pipes=['probe.txt']), 0))
    mapper.handle_event('apaevt_flow', at(flow('enter', 'agent_rocketride_1'), 1))
    mapper.handle_event('apaevt_sse', at({'pipe_id': 0, 'type': 'thinking', '__id': RUN_ID}, 2))
    mapper.handle_event('apaevt_flow', at(flow('leave', 'agent_rocketride_1'), 3))
    mapper.handle_event('apaevt_flow', at(flow('end', 'probe.txt'), 4))

    agent_span = spans_by_name(exporter, 'invoke_agent')[0]
    thinking = [event for event in agent_span.events if event.name == 'thinking'][0]
    assert thinking.timestamp == ns(2)


def test_unstamped_events_still_use_the_sdk_clock():
    """Pre-continuum engines (no eventTime) keep the original arrival-time behaviour."""
    before = time.time_ns()
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', flow('end', 'probe.txt'))
    after = time.time_ns()

    root = spans_by_name(exporter, 'probe.txt')[0]
    assert before <= root.start_time <= root.end_time <= after


def test_close_outside_an_event_falls_back_to_the_sdk_clock():
    """close_all has no event body, so its end stamp is the bridge clock, not T0."""
    mapper, exporter = make_mapper()
    mapper.handle_event('apaevt_flow', at(flow('begin', 'probe.txt', pipes=['probe.txt']), 0))
    mapper.close_all()

    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.start_time == ns(0)
    assert root.end_time > ns(0)
    assert root.end_time >= time.time_ns() - 60_000_000_000
    assert root.attributes[ATTR_SPAN_UNCLOSED] is True


def test_end_is_never_stamped_before_its_own_span_start():
    """A run that mixes stamped and unstamped events cannot get a negative duration."""
    mapper, exporter = make_mapper()
    # begin has no eventTime -> SDK clock (now); end carries an ancient stamp.
    mapper.handle_event('apaevt_flow', flow('begin', 'probe.txt', pipes=['probe.txt']))
    mapper.handle_event('apaevt_flow', at(flow('end', 'probe.txt'), 0))

    root = spans_by_name(exporter, 'probe.txt')[0]
    assert root.end_time == root.start_time
    assert root.end_time > ns(0)


def test_fixture_replay_with_engine_stamps_yields_engine_durations():
    """Replay the captured wire capture as a post-continuum engine would emit it."""
    mapper, exporter = make_mapper()
    for index, record in enumerate(load_fixture()):
        if record['event'] == 'apaevt_status_update':
            continue
        mapper.handle_event(record['event'], at(record['body'], index))
    mapper.close_all()

    spans = exporter.get_finished_spans()
    assert spans
    for span in spans:
        assert span.end_time >= span.start_time
        # Every span opened by a stamped event starts on the engine clock.
        assert span.start_time >= ns(0)
        if not span.attributes.get(ATTR_SPAN_UNCLOSED):
            # Closed by a stamped event too -> the whole span is engine-timed.
            assert span.end_time <= ns(len(load_fixture()))
