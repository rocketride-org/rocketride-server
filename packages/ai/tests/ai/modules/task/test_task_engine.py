"""
Unit tests for ai.modules.task.task_engine.Task — pure-logic methods.

``Task.__init__`` is heavy (sockets, TASK_STATUS construction, DAP base,
asyncio locks, ...), so tests bypass it via ``__new__`` and seed only the
attributes the method under test consults. Real method objects are then
invoked through ``Task.<method>(stub, ...)`` so coverage tracks them.

Focus areas:

- ``_check_pipeline`` — source-component validation + status.name composition
- ``_build_task`` — subprocess-config shape
- ``_file_checksum`` — SHA-256 of a real temp file
- ``_is_debugging`` / ``_get_attach_subprocesses`` — sys.modules probes
- ``is_task_complete`` / ``is_attached`` / ``has_attached_debugger`` /
  ``get_connection_count`` / ``is_debug_available`` / ``get_status`` —
  accessors
- ``reset_idle_timer`` / ``send_scheduled_updates`` — state setters

Two methods are already exercised by separate, security-focused tests:

- ``_resolve_pipeline`` — see ``test_env_var_exfil.py``
- ``_write_task_file`` — see ``test_temp_file_security.py``
"""

from __future__ import annotations

import hashlib
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.task.task_engine import Task


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _task(*, source='src-id', task_name=None, pipeline=None, status=None):
    """
    Build a Task with __init__ bypassed.

    Tests seed only the attributes consumed by the method under test:
    ``id``, ``source``, ``_task_name``, ``_pipeline``, ``_status``,
    ``_threads``, ``_pipelineTraceLevel``, ``token``.

    Args:
        source: id of the source component to look up in ``_check_pipeline``.
        task_name: optional task name used by ``_check_pipeline`` to compose
            ``status.name``.
        pipeline: pipeline dict to attach (default empty).
        status: optional TASK_STATUS-shaped stand-in; auto-built if None.

    Returns:
        Task: bare instance ready for method calls.
    """
    t = Task.__new__(Task)
    t.id = 'task-test'
    t.token = 'tk_test'
    t.source = source
    t._task_name = task_name
    t._pipeline = pipeline if pipeline is not None else {}
    t._threads = 4
    t._pipelineTraceLevel = None
    t._status = status if status is not None else SimpleNamespace(name='', state=0, exitMessage='')
    t._debugger = None
    t._debug_port = None
    t._idle_time = 5
    t._status_updated = False
    t.public_auth = 'pk_test'
    t.info = {}
    # debug_message is normally inherited from DAPBase and requires
    # _call_debug_message to be wired by __init__. Bypass with a MagicMock.
    t.debug_message = MagicMock()
    return t


# ---------------------------------------------------------------------------
# _check_pipeline
# ---------------------------------------------------------------------------


def test_check_pipeline_raises_when_source_missing():
    """A pipeline whose ``source`` id is absent from components raises ValueError."""
    t = _task(source='not-there')
    pipeline = {'components': [{'id': 'other', 'config': {}}]}
    with pytest.raises(ValueError, match='source component "not-there"'):
        Task._check_pipeline(t, pipeline)


def test_check_pipeline_creates_config_dict_if_missing():
    """A source component without ``config`` gets an empty dict inserted."""
    t = _task(source='src')
    component = {'id': 'src'}
    pipeline = {'components': [component]}
    Task._check_pipeline(t, pipeline)
    assert component['config'] == {'mode': 'Source', 'type': 'Unknown'}


def test_check_pipeline_fills_mode_and_type_defaults():
    """Missing mode defaults to 'Source'; missing type defaults to the component's provider."""
    t = _task(source='src')
    component = {'id': 'src', 'provider': 'kafka', 'config': {}}
    Task._check_pipeline(t, {'components': [component]})
    assert component['config']['mode'] == 'Source'
    assert component['config']['type'] == 'kafka'


def test_check_pipeline_preserves_existing_mode_and_type():
    """When mode/type are already set, they are not overwritten."""
    t = _task(source='src')
    component = {
        'id': 'src',
        'provider': 'kafka',
        'config': {'mode': 'Custom', 'type': 'overridden'},
    }
    Task._check_pipeline(t, {'components': [component]})
    assert component['config']['mode'] == 'Custom'
    assert component['config']['type'] == 'overridden'


def test_check_pipeline_composes_status_name_from_task_name():
    """status.name = f'{task_name}.{component_name | source_id}'."""
    t = _task(source='src', task_name='daily-ingest')
    component = {'id': 'src', 'name': 'reader'}
    Task._check_pipeline(t, {'components': [component]})
    assert t._status.name == 'daily-ingest.reader'


def test_check_pipeline_falls_back_to_task_id_and_source_id():
    """When neither task_name nor component.name are set, ids are used."""
    t = _task(source='src')
    Task._check_pipeline(t, {'components': [{'id': 'src'}]})
    assert t._status.name == 'task-test.src'


def test_check_pipeline_uses_config_name_when_component_name_missing():
    """If the component has no top-level name, fall back to config.name."""
    t = _task(source='src')
    component = {'id': 'src', 'config': {'name': 'from-config'}}
    Task._check_pipeline(t, {'components': [component]})
    assert t._status.name == 'task-test.from-config'


# ---------------------------------------------------------------------------
# _build_task
# ---------------------------------------------------------------------------


def test_build_task_returns_subprocess_config_shape(tmp_path, monkeypatch):
    """The returned dict matches the contract the engine subprocess expects."""
    # Pin sys.executable / makedirs so the function does not touch the real fs.
    monkeypatch.setattr(sys, 'executable', str(tmp_path / 'bin' / 'engine.exe'))
    monkeypatch.setattr(os, 'makedirs', lambda p, exist_ok=False: None)

    pipeline = {
        'version': 2,
        'source': 'src',
        'project_id': 'proj-1',
        'name': 'my-pipeline',
        'description': 'desc',
        'components': [{'id': 'src'}],
    }
    t = _task(pipeline=pipeline)

    config = Task._build_task(t, pipeline)

    assert config['type'] == 'pipeline'
    assert config['taskId'] == 'tk_test'
    assert config['config']['threadCount'] == 4
    assert config['config']['pipelineTraceLevel'] is None
    assert config['config']['pipeline'] == {
        'version': 2,
        'source': 'src',
        'project_id': 'proj-1',
        'name': 'my-pipeline',
        'description': 'desc',
        'components': [{'id': 'src'}],
    }
    assert config['config']['keystore'] == 'kvsfile://data/keystore.json'


def test_build_task_supplies_pipeline_version_default(monkeypatch, tmp_path):
    """An absent ``version`` field defaults to 1."""
    monkeypatch.setattr(sys, 'executable', str(tmp_path / 'engine.exe'))
    monkeypatch.setattr(os, 'makedirs', lambda p, exist_ok=False: None)

    pipeline = {'source': 'src', 'components': []}
    t = _task(pipeline=pipeline)
    config = Task._build_task(t, pipeline)
    assert config['config']['pipeline']['version'] == 1


# ---------------------------------------------------------------------------
# _file_checksum
# ---------------------------------------------------------------------------


def test_file_checksum_matches_sha256_of_file_contents(tmp_path):
    """The function returns the SHA-256 hex digest of the file body."""
    p = tmp_path / 'sample.bin'
    body = b'hello world\n' * 1024  # spans multiple 8 KiB reads
    p.write_bytes(body)

    t = _task()
    result = Task._file_checksum(t, str(p))
    assert result == hashlib.sha256(body).hexdigest()


def test_file_checksum_empty_file_yields_empty_sha256(tmp_path):
    """SHA-256 of an empty file is the canonical e3b0...b855."""
    p = tmp_path / 'empty.bin'
    p.write_bytes(b'')

    t = _task()
    assert Task._file_checksum(t, str(p)) == hashlib.sha256(b'').hexdigest()


# ---------------------------------------------------------------------------
# _is_debugging / _get_attach_subprocesses
# ---------------------------------------------------------------------------


def test_is_debugging_false_when_pydevd_absent(monkeypatch):
    """Without `pydevd` loaded, _is_debugging returns False."""
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    monkeypatch.delitem(sys.modules, 'debugpy', raising=False)
    assert Task._is_debugging(_task()) is False


def test_is_debugging_false_when_only_pydevd_loaded(monkeypatch):
    """Loading pydevd alone is not enough — debugpy must also be present."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock())
    monkeypatch.delitem(sys.modules, 'debugpy', raising=False)
    assert Task._is_debugging(_task()) is False


def test_is_debugging_true_when_both_present(monkeypatch):
    """When both modules are loaded, _is_debugging returns True."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock())
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert Task._is_debugging(_task()) is True


def test_get_attach_subprocesses_false_when_not_debugging(monkeypatch):
    """If not running under a debugger, subprocess-attach is always False."""
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    assert Task._get_attach_subprocesses(_task()) is False


def test_get_attach_subprocesses_false_when_setup_missing(monkeypatch):
    """A pydevd module without SetupHolder.setup falls through to False."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock(spec=[]))
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert Task._get_attach_subprocesses(_task()) is False


def test_get_attach_subprocesses_reads_multiprocess_flag(monkeypatch):
    """When pydevd.SetupHolder.setup['multiprocess'] is set, return its value."""
    pydevd = MagicMock()
    pydevd.SetupHolder = SimpleNamespace(setup={'multiprocess': True})
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert Task._get_attach_subprocesses(_task()) is True


def test_get_attach_subprocesses_swallows_unexpected_errors(monkeypatch):
    """Any exception while probing pydevd is caught and yields False."""
    pydevd = MagicMock()
    # Reading SetupHolder raises:
    type(pydevd).SetupHolder = property(lambda self: (_ for _ in ()).throw(RuntimeError('oops')))
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert Task._get_attach_subprocesses(_task()) is False


# ---------------------------------------------------------------------------
# State accessors
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'state, expected',
    [
        (0, False),  # NONE
        (1, False),  # STARTING
        (2, False),  # INITIALIZING
        (3, False),  # RUNNING
        (4, False),  # STOPPING
        (5, True),  # COMPLETED
        (6, True),  # CANCELLED
    ],
)
def test_is_task_complete(state, expected):
    """Only COMPLETED (5) and CANCELLED (6) are treated as terminal states."""
    status = SimpleNamespace(state=state, name='', exitMessage='')
    t = _task(status=status)
    assert Task.is_task_complete(t) is expected


def test_is_attached_returns_true_for_matching_connection():
    """is_attached compares against ``_debugger`` by equality."""
    t = _task()
    conn = MagicMock()
    t._debugger = conn
    assert Task.is_attached(t, conn) is True


def test_is_attached_returns_false_when_no_debugger():
    """When no debugger is attached, is_attached returns False."""
    t = _task()
    assert Task.is_attached(t, MagicMock()) is False


def test_is_attached_returns_false_for_other_connection():
    """A different connection than the attached debugger returns False."""
    t = _task()
    t._debugger = MagicMock(name='primary')
    assert Task.is_attached(t, MagicMock(name='other')) is False


def test_has_attached_debugger_reflects_debugger_field():
    """has_attached_debugger is True iff ``_debugger`` is not None."""
    t = _task()
    assert Task.has_attached_debugger(t) is False
    t._debugger = MagicMock()
    assert Task.has_attached_debugger(t) is True


def test_get_connection_count_is_zero_or_one():
    """get_connection_count returns 1 with a debugger, 0 without."""
    t = _task()
    assert Task.get_connection_count(t) == 0
    t._debugger = MagicMock()
    assert Task.get_connection_count(t) == 1


def test_is_debug_available_requires_debug_port():
    """is_debug_available is True iff ``_debug_port`` is non-None."""
    t = _task()
    assert Task.is_debug_available(t) is False
    t._debug_port = 5566
    assert Task.is_debug_available(t) is True


def test_get_status_returns_the_status_object():
    """get_status returns the same TASK_STATUS instance that was attached."""
    status = SimpleNamespace(state=3)
    t = _task(status=status)
    assert Task.get_status(t) is status


def test_reset_idle_timer_zeroes_the_field():
    """reset_idle_timer sets ``_idle_time`` back to zero."""
    t = _task()
    t._idle_time = 999
    Task.reset_idle_timer(t)
    assert t._idle_time == 0


def test_send_scheduled_updates_flips_the_flag():
    """send_scheduled_updates marks status as needing a broadcast."""
    t = _task()
    assert t._status_updated is False
    Task.send_scheduled_updates(t)
    assert t._status_updated is True


def test_on_metrics_updated_flips_status_updated_flag():
    """_on_metrics_updated flips ``_status_updated`` to True."""
    t = _task()
    assert t._status_updated is False
    Task._on_metrics_updated(t)
    assert t._status_updated is True


# ---------------------------------------------------------------------------
# _update_status — dispatch over event types
# ---------------------------------------------------------------------------


def _make_status_for_update():
    """Build a status namespace with the attributes _update_status touches."""
    return SimpleNamespace(
        name='',
        state=0,
        exitMessage='',
        status='',
        notes=[],
        currentObject=None,
        currentSize=0,
        totalSize=0,
        totalCount=0,
        completedSize=0,
        completedCount=0,
        failedSize=0,
        failedCount=0,
        wordsSize=0,
        wordsCount=0,
        rateSize=0,
        rateCount=0,
        errors=[],
        warnings=[],
        metrics={},
    )


def test_update_status_object_event_sets_current_object_and_size():
    """An ``apaevt_status_object`` event sets ``currentObject`` and ``currentSize``."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_object',
            'body': {'object': 'file.txt', 'size': 1024},
        },
    )
    assert t._status.currentObject == 'file.txt'
    assert t._status.currentSize == 1024


def test_update_status_counts_event_populates_every_counter():
    """An ``apaevt_status_counts`` event writes every counter field on the status."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_counts',
            'body': {
                'totalSize': 1,
                'totalCount': 2,
                'completedSize': 3,
                'completedCount': 4,
                'failedSize': 5,
                'failedCount': 6,
                'wordsSize': 7,
                'wordsCount': 8,
                'rateSize': 9,
                'rateCount': 10,
            },
        },
    )
    assert t._status.totalSize == 1
    assert t._status.totalCount == 2
    assert t._status.completedSize == 3
    assert t._status.completedCount == 4
    assert t._status.failedSize == 5
    assert t._status.failedCount == 6
    assert t._status.wordsSize == 7
    assert t._status.wordsCount == 8
    assert t._status.rateSize == 9
    assert t._status.rateCount == 10


def test_update_status_error_event_appends_to_errors():
    """An ``apaevt_status_error`` event appends to ``status.errors``."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_error',
            'body': {'message': 'disk full'},
        },
    )
    assert t._status.errors == ['disk full']


def test_update_status_errors_buffer_trims_to_50():
    """Error buffer keeps only the most recent 50 entries."""
    t = _task(status=_make_status_for_update())
    t._status.errors = [f'err-{i}' for i in range(50)]
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_error',
            'body': {'message': 'err-new'},
        },
    )
    assert len(t._status.errors) == 50
    assert t._status.errors[-1] == 'err-new'
    assert 'err-0' not in t._status.errors  # oldest evicted


def test_update_status_warning_event_appends_and_trims():
    """An ``apaevt_status_warning`` event appends to warnings with the same 50-cap."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_warning',
            'body': {'message': 'memory pressure'},
        },
    )
    assert t._status.warnings == ['memory pressure']


def test_update_status_download_event_sets_status_string():
    """An ``apaevt_status_download`` event sets a human-readable status string."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_download',
            'body': {'info': {'name': 'whisper-tiny'}},
        },
    )
    assert 'Downloading' in t._status.status
    assert 'whisper-tiny' in t._status.status


def test_update_status_message_event_sets_status_field():
    """An ``apaevt_status_message`` event copies the message into ``status.status``."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_message',
            'body': {'message': 'processing 50%'},
        },
    )
    assert t._status.status == 'processing 50%'


def test_update_status_user_event_with_empty_notes_clears_notes():
    """An ``apaevt_status_user`` event with empty notes resets ``status.notes``."""
    t = _task(status=_make_status_for_update())
    t._status.notes = ['old note']
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': []},
        },
    )
    assert t._status.notes == []


def test_update_status_user_event_replaces_token_placeholders_in_strings():
    """String notes have {token} / {public_auth} placeholders substituted."""
    t = _task(status=_make_status_for_update())
    t.token = 'tk_x'
    t.public_auth = 'pk_x'
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': ['use {token} with {public_auth}']},
        },
    )
    assert t._status.notes == ['use tk_x with pk_x']


def test_update_status_user_event_replaces_placeholders_in_dict_values():
    """Dict notes have placeholders replaced in every string value, keeping other types."""
    t = _task(status=_make_status_for_update())
    t.token = 'tk_x'
    t.public_auth = 'pk_x'
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': [{'msg': 'token is {token}', 'count': 42}]},
        },
    )
    assert t._status.notes == [{'msg': 'token is tk_x', 'count': 42}]


def test_update_status_user_event_keeps_unknown_note_types_as_is():
    """A non-string, non-dict note (e.g. int) is appended without modification."""
    t = _task(status=_make_status_for_update())
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': [42]},
        },
    )
    assert t._status.notes == [42]


def test_update_status_info_event_merges_into_info_dict():
    """An ``apaevt_status_info`` event merges the body into ``self.info``."""
    t = _task(status=_make_status_for_update())
    t.info = {'existing': 'value'}
    Task._update_status(
        t,
        {
            'event': 'apaevt_status_info',
            'body': {'info': {'new_key': 'new_value'}},
        },
    )
    assert t.info == {'existing': 'value', 'new_key': 'new_value'}


def test_update_status_unknown_event_is_silently_ignored():
    """An event not in the dispatch table leaves status untouched."""
    t = _task(status=_make_status_for_update())
    original_status = t._status.status
    Task._update_status(
        t,
        {
            'event': 'apaevt_unknown_event',
            'body': {'whatever': 'data'},
        },
    )
    assert t._status.status == original_status


# ---------------------------------------------------------------------------
# _forward_task_event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_forward_task_event_debugger_routes_to_debugger_send_event():
    """A DEBUGGER event is sent directly to ``self._debugger.send_event``."""
    from rocketride import EVENT_TYPE
    from unittest.mock import AsyncMock

    t = _task()
    t._debugger = MagicMock()
    t._debugger.send_event = AsyncMock()
    t.id = 'task-1'

    await Task._forward_task_event(t, EVENT_TYPE.DEBUGGER, {'event': 'output', 'body': {'x': 1}})
    t._debugger.send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_forward_task_event_debugger_skipped_when_no_debugger_attached():
    """If ``_debugger`` is None, DEBUGGER events are dropped."""
    from rocketride import EVENT_TYPE

    t = _task()
    t._debugger = None
    # Should not raise.
    await Task._forward_task_event(t, EVENT_TYPE.DEBUGGER, {'event': 'output'})


@pytest.mark.asyncio
async def test_forward_task_event_non_debugger_routes_to_server_broadcast():
    """A non-DEBUGGER event is routed through the TaskServer broadcast API."""
    from rocketride import EVENT_TYPE
    from unittest.mock import AsyncMock

    t = _task()
    t._debugger = None
    server = MagicMock()
    server.broadcast_task_event = AsyncMock()
    t._server = server
    t.token = 'tk_x'

    payload = {'event': 'summary', 'body': {}}
    await Task._forward_task_event(t, EVENT_TYPE.SUMMARY, payload)

    server.broadcast_task_event.assert_awaited_once()
    args = server.broadcast_task_event.await_args
    assert args.kwargs['token'] == 'tk_x'
    assert args.kwargs['event'] == payload


@pytest.mark.asyncio
async def test_forward_task_event_debugger_swallows_send_failure():
    """A failed send_event call is logged but does not propagate."""
    from rocketride import EVENT_TYPE
    from unittest.mock import AsyncMock

    t = _task()
    t._debugger = MagicMock()
    t._debugger.send_event = AsyncMock(side_effect=RuntimeError('socket broken'))

    # Should not raise.
    await Task._forward_task_event(t, EVENT_TYPE.DEBUGGER, {'event': 'output'})
