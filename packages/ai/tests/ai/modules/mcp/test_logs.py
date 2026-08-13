# Copyright 2026 Aparavi Software AG. MIT License.
import asyncio

import pytest

from ai.modules.mcp.engine import LogNotFound
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import logs


def _registry():
    registry = ToolRegistry()
    logs.register(registry)
    return registry


def test_register_adds_four_log_tools():
    # Equality, not subset: _registry() registers only the logs group, so an
    # accidental extra registration must fail here.
    assert set(_registry().names()) == {'log_chapters', 'log_read', 'log_traces', 'log_trace'}


def test_register_binds_each_name_to_its_handler():
    """The behavior tests below call the private handlers directly, so this
    pins the name-to-handler wiring a mis-wired register() would break.
    """
    registry = _registry()
    assert registry.handler('log_chapters') is logs._log_chapters
    assert registry.handler('log_read') is logs._log_read
    assert registry.handler('log_traces') is logs._log_traces
    assert registry.handler('log_trace') is logs._log_trace


@pytest.mark.asyncio
async def test_log_chapters_happy_path(fake_engine):
    fake_engine.log_chapters_result = {
        'chapters': [{'beginTime': 1.0, 'beginSeq': 10, 'endTime': 2.0, 'outcome': 'completed'}],
        'horizonSeq': 0,
    }
    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is True
    assert result['chapters'][0]['outcome'] == 'completed'
    call = fake_engine.log_calls[0]
    assert call['method'] == 'chapters'
    assert (call['project_id'], call['source'], call['team_id']) == ('p1', 's1', '')


@pytest.mark.asyncio
async def test_log_chapters_requires_project_and_source(fake_engine):
    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1'})
    assert result['ok'] is False
    assert 'source' in result['message']
    assert result['error_type'] == 'BadRequest'
    assert 'run_pipeline' in result['hint'] and 'run_dropper_pipe' in result['hint']


@pytest.mark.asyncio
async def test_log_chapters_empty_returns_not_found(fake_engine):
    """Finding 2: an unknown projectId/source (no chapters at all) maps to
    error_type 'NotFound', not ok:True + note.
    """
    fake_engine.log_chapters_result = {'chapters': [], 'horizonSeq': 0}
    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'NotFound'
    assert 'no recorded runs' in result['message']
    assert 'run_pipeline' in result['hint'] and 'run_dropper_pipe' in result['hint']


@pytest.mark.asyncio
async def test_log_chapters_timeout_returns_timeout_envelope(fake_engine):
    fake_engine.log_chapters_result = asyncio.TimeoutError()
    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


@pytest.mark.asyncio
async def test_log_read_caps_page_and_forwards_cursor(fake_engine):
    fake_engine.log_read_result = {'events': [{'seq': 1}], 'nextSeq': 42}
    result = await logs._log_read(
        fake_engine,
        None,
        {'projectId': 'p1', 'source': 's1', 'cursor': 7, 'types': ['output'], 'maxEvents': 5000},
    )
    assert result['ok'] is True
    assert result['nextCursor'] == 42
    call = fake_engine.log_calls[0]
    assert call['method'] == 'read'
    assert call['max_events'] == logs.LOG_READ_MAX_EVENTS  # 5000 clamped to the cap
    # The byte bound always rides along — the event cap alone is not a size cap.
    assert call['max_bytes'] == logs.LOG_READ_MAX_BYTES


@pytest.mark.asyncio
async def test_log_read_floors_non_positive_max_events(fake_engine):
    """Finding 5: maxEvents is floored to >=1, still capped at LOG_READ_MAX_EVENTS."""
    fake_engine.log_read_result = {'events': [], 'nextSeq': None}
    result = await logs._log_read(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'maxEvents': -5})
    assert result['ok'] is True
    assert fake_engine.log_calls[0]['max_events'] == 1


@pytest.mark.asyncio
async def test_log_read_timeout_returns_timeout_envelope(fake_engine):
    fake_engine.log_read_result = asyncio.TimeoutError()
    result = await logs._log_read(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


@pytest.mark.asyncio
async def test_log_traces_populates_traces_from_closed_list(fake_engine):
    fake_engine.log_traces_result = {
        'open': [],
        'closed': [{'beginSeq': 10, 'outcome': 'completed'}],
    }
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is True
    assert result['traces'] == [{'beginSeq': 10, 'outcome': 'completed'}]
    assert result['open'] == []
    assert 'note' not in result


@pytest.mark.asyncio
async def test_log_traces_empty_hints_trace_level(fake_engine):
    fake_engine.log_traces_result = {'open': [], 'closed': []}
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is True
    assert result['traces'] == []
    assert result['open'] == []
    assert 'pipelineTraceLevel' in result['note']


@pytest.mark.asyncio
async def test_log_traces_open_only_does_not_trigger_empty_note(fake_engine):
    fake_engine.log_traces_result = {'open': [{'beginSeq': 11}], 'closed': []}
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is True
    assert result['traces'] == []
    assert result['open'] == [{'beginSeq': 11}]
    assert 'note' not in result


@pytest.mark.asyncio
async def test_log_traces_chapter_begin_seq_happy_path(fake_engine):
    """Finding 1: chapterBeginSeq is forwarded to the seam so a specific past
    chapter can be addressed, not just the latest/live run.
    """
    fake_engine.log_traces_result = {'open': [], 'closed': [{'beginSeq': 42, 'outcome': 'completed'}]}
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'chapterBeginSeq': 10})
    assert result['ok'] is True
    assert result['traces'] == [{'beginSeq': 42, 'outcome': 'completed'}]
    call = fake_engine.log_calls[0]
    assert call['method'] == 'traces'
    assert call['chapter_begin_seq'] == 10  # forwarded


@pytest.mark.asyncio
async def test_log_traces_unknown_chapter_begin_seq_maps_to_not_found(fake_engine):
    """Finding 3: a LogNotFound from the seam (unknown chapterBeginSeq) maps to
    a 'NotFound' envelope, mirroring log_trace's TraceExpired mapping.
    """
    fake_engine.log_traces_result = LogNotFound(999)
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'chapterBeginSeq': 999})
    assert result['ok'] is False
    assert result['error_type'] == 'NotFound'
    assert '999' in result['message']
    assert 'hint' in result


@pytest.mark.asyncio
async def test_log_traces_unrelated_keyerror_is_not_swallowed(fake_engine):
    """The narrowed catch: a plain KeyError from an incidental dict lookup in
    the seam must propagate (and be normalized by the dispatch layer), not be
    misreported as an expected retention condition.
    """
    fake_engine.log_traces_result = KeyError('incidental')
    with pytest.raises(KeyError):
        await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'chapterBeginSeq': 1})


@pytest.mark.asyncio
async def test_log_traces_clamps_n_to_valid_range(fake_engine):
    """Finding 5: n is clamped to 1..100 (default 20)."""
    fake_engine.log_traces_result = {'open': [], 'closed': []}
    await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'n': 5000})
    assert fake_engine.log_calls[0]['n'] == logs.LOG_TRACES_MAX_N

    fake_engine.log_calls.clear()
    await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'n': -5})
    assert fake_engine.log_calls[0]['n'] == logs.LOG_TRACES_MIN_N

    fake_engine.log_calls.clear()
    await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert fake_engine.log_calls[0]['n'] == logs.LOG_TRACES_DEFAULT_N


@pytest.mark.asyncio
async def test_log_traces_timeout_returns_timeout_envelope(fake_engine):
    fake_engine.log_traces_result = asyncio.TimeoutError()
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


@pytest.mark.asyncio
async def test_log_trace_maps_log_not_found_to_trace_expired(fake_engine):
    fake_engine.log_trace_result = LogNotFound(99)
    result = await logs._log_trace(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'beginSeq': 99})
    assert result['ok'] is False
    assert result['error_type'] == 'TraceExpired'


@pytest.mark.asyncio
async def test_log_trace_returns_summary_and_events(fake_engine):
    fake_engine.log_trace_result = {'summary': {'outcome': 'completed'}, 'events': [{'seq': 1}]}
    result = await logs._log_trace(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'beginSeq': 99})
    assert result['ok'] is True
    assert result['beginSeq'] == 99
    assert result['summary'] == {'outcome': 'completed'}
    assert result['events'] == [{'seq': 1}]


@pytest.mark.asyncio
async def test_log_trace_requires_begin_seq(fake_engine):
    result = await logs._log_trace(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_log_trace_timeout_returns_timeout_envelope(fake_engine):
    fake_engine.log_trace_result = asyncio.TimeoutError()
    result = await logs._log_trace(fake_engine, None, {'projectId': 'p1', 'source': 's1', 'beginSeq': 1})
    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


@pytest.mark.asyncio
async def test_log_chapters_wait_for_wraps_a_hung_seam_call(fake_engine, monkeypatch):
    """Unlike the scripted-TimeoutError tests above, this hangs the seam and
    shrinks the budget, proving the asyncio.wait_for wrap actually exists.
    """

    async def _hang(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(fake_engine, 'log_chapters', _hang)
    monkeypatch.setattr(logs, 'DEFAULT_TIMEOUT_SECONDS', 0.01)

    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


@pytest.mark.asyncio
async def test_log_chapters_log_not_found_maps_to_not_found(fake_engine):
    """The seam-exception branch of _log_chapters: LogNotFound gets the same
    NotFound envelope as the empty-chapters case.
    """
    fake_engine.log_chapters_result = LogNotFound('p1')

    result = await logs._log_chapters(fake_engine, None, {'projectId': 'p1', 'source': 's1'})

    assert result['ok'] is False
    assert result['error_type'] == 'NotFound'


@pytest.mark.asyncio
async def test_log_read_log_not_found_maps_to_not_found(fake_engine):
    fake_engine.log_read_result = LogNotFound('p1')

    result = await logs._log_read(fake_engine, None, {'projectId': 'p1', 'source': 's1'})

    assert result['ok'] is False
    assert result['error_type'] == 'NotFound'
    assert 'expired' in result['message']


@pytest.mark.asyncio
async def test_log_traces_echoes_keying_context(fake_engine):
    fake_engine.log_traces_result = {'open': [], 'closed': []}
    result = await logs._log_traces(fake_engine, None, {'projectId': 'p1', 'source': 's1'})
    assert result['context'] == {'projectId': 'p1', 'source': 's1'}


@pytest.mark.asyncio
async def test_log_trace_echoes_keying_context_with_team(fake_engine):
    fake_engine.log_trace_result = {'summary': {}, 'events': []}
    result = await logs._log_trace(
        fake_engine, None, {'projectId': 'p1', 'source': 's1', 'teamId': 't1', 'beginSeq': 5}
    )
    assert result['context'] == {'projectId': 'p1', 'source': 's1', 'teamId': 't1'}
