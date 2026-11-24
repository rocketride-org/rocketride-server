"""
Unit tests for ai.modules.task.task_engine.Task — pure-logic methods.

``TaskEngine.__init__`` is heavy (sockets, TASK_STATUS construction, DAP base,
asyncio locks, ...), so tests bypass it via ``__new__`` and seed only the
attributes the method under test consults. Real method objects are then
invoked through ``TaskEngine.<method>(stub, ...)`` so coverage tracks them.

Focus areas:

- ``_check_pipeline`` — source-component validation + status.name composition
- ``_build_task`` — subprocess-config shape
- ``_file_checksum`` — SHA-256 of a real temp file
- ``_is_debugging`` / ``_get_attach_subprocesses`` — sys.modules probes
- ``is_task_complete`` / ``is_live`` / ``get_status`` — accessors
- ``note_activity`` / ``idle_since`` / ``idle_seconds`` / ``ages`` — the engine's own inactivity timer
- ``send_scheduled_updates`` — state setter

Two methods are already exercised by separate, security-focused tests:

- ``_resolve_pipeline`` — see ``test_env_var_exfil.py``
- ``_write_task_file`` — see ``test_temp_file_security.py``
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from rocketride import TASK_STATE

from ai.constants import CONST_STATUS_HISTORY_LIMIT
from ai.modules.task.task_engine import (
    CONST_PARAM_TOKEN_SECRET_ENV,
    CONST_TRACE_PAYLOAD_CAP,
    CONST_TRACE_PREVIEW_BYTES,
    TaskEngine,
    cap_trace_payload,
    db_access,
    filter_subprocess_env,
    merge_status_notes,
    resolve_parameter_tokens,
    saas_pipeline_violation,
)
from ai.modules.task.trace_owner import TraceOwners
from ai.modules.task.types import EngineState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _task(*, source='src-id', task_name=None, pipeline=None, status=None):
    """
    Build a Task with __init__ bypassed.

    Tests seed only the attributes consumed by the method under test:
    ``id``, ``source``, ``_task_name``, ``_pipeline``, ``_status``,
    ``_threads``, ``_pipelineTraceLevel``, ``engine_key``, ``shared``,
    ``_holds``, ``address``.

    Args:
        source: id of the source component to look up in ``_check_pipeline``.
        task_name: optional task name used by ``_check_pipeline`` to compose
            ``status.name``.
        pipeline: pipeline dict to attach (default empty).
        status: optional TASK_STATUS-shaped stand-in; auto-built if None.

    Returns:
        Task: bare instance ready for method calls.
    """
    t = TaskEngine.__new__(TaskEngine)
    # the server hands out engine ids and records which control owns each request tree
    t._server = SimpleNamespace(next_engine_id=lambda: 1, node_id=1, trace_owners=TraceOwners())
    t.id = 'task-test'
    t.engine_key = 'enginehash:user-1'
    t.engine_id = 1
    t.shared = False
    # One hold: the control that started it
    t._holds = {'dev.user-1.acme.proj-test.src-id': 900}
    t.dormant_reason = None
    t.state = EngineState.STARTING
    t.address = 'acme.proj-test.src-id'
    t._data_token = 'dt_test'
    t.client_id = 'user-1'
    t.team_id = 'team-1'
    t.org_id = 'org-1'
    t.source = source
    # Real tasks always carry their project id; _forward_task_event stamps
    # it into every forwarded body (identity safety net).
    t.project_id = 'proj-test'
    t._task_name = task_name
    t._pipeline = pipeline if pipeline is not None else {}
    t._threads = 4
    t._pipelineTraceLevel = None
    t._run_kind = 'dev'
    t._owner_kind = 'user'
    t._status = status if status is not None else SimpleNamespace(name='', state=0, exitMessage='')
    t._last_activity = 0.0
    t._last_pipeline_event = 0.0
    t._status_updated = False
    t.info = {}
    # Run-log continuum state consulted by _forward_task_event's stamping
    # safety net (see TaskEngine.stamp_log_event): fresh-stream counter + no writer.
    t._log_seq_next = 1
    t._run_logs = {}
    t._run_log_open_lock = asyncio.Lock()
    t._run_log_failed = set()
    # debug_message is normally inherited from DAPBase and requires
    # _call_debug_message to be wired by __init__. Bypass with a MagicMock.
    t.debug_message = MagicMock()
    # Channel state __init__ would have set
    TaskEngine._reset_channel_state(t)
    return t


# ---------------------------------------------------------------------------
# _check_pipeline
# ---------------------------------------------------------------------------


def test_check_pipeline_raises_when_source_missing():
    """A pipeline whose ``source`` id is absent from components raises ValueError."""
    t = _task(source='not-there')
    pipeline = {'components': [{'id': 'other', 'config': {}}]}
    with pytest.raises(ValueError, match='source component "not-there"'):
        TaskEngine._check_pipeline(t, pipeline)


def test_check_pipeline_creates_config_dict_if_missing():
    """A source component without ``config`` gets an empty dict inserted."""
    t = _task(source='src')
    component = {'id': 'src'}
    pipeline = {'components': [component]}
    TaskEngine._check_pipeline(t, pipeline)
    assert component['config'] == {'mode': 'Source', 'type': 'Unknown'}


def test_check_pipeline_fills_mode_and_type_defaults():
    """Missing mode defaults to 'Source'; missing type defaults to the component's provider."""
    t = _task(source='src')
    component = {'id': 'src', 'provider': 'kafka', 'config': {}}
    TaskEngine._check_pipeline(t, {'components': [component]})
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
    TaskEngine._check_pipeline(t, {'components': [component]})
    assert component['config']['mode'] == 'Custom'
    assert component['config']['type'] == 'overridden'


def test_check_pipeline_composes_status_name_from_task_name():
    """status.name = f'{task_name}.{component_name | source_id}'."""
    t = _task(source='src', task_name='daily-ingest')
    component = {'id': 'src', 'name': 'reader'}
    TaskEngine._check_pipeline(t, {'components': [component]})
    assert t._status.name == 'daily-ingest.reader'


def test_check_pipeline_falls_back_to_task_id_and_source_id():
    """When neither task_name nor component.name are set, ids are used."""
    t = _task(source='src')
    TaskEngine._check_pipeline(t, {'components': [{'id': 'src'}]})
    assert t._status.name == 'task-test.src'


def test_check_pipeline_uses_config_name_when_component_name_missing():
    """If the component has no top-level name, fall back to config.name."""
    t = _task(source='src')
    component = {'id': 'src', 'config': {'name': 'from-config'}}
    TaskEngine._check_pipeline(t, {'components': [component]})
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

    config = TaskEngine._build_task(t, pipeline)

    assert config['type'] == 'pipeline'
    # The task file names the ENGINE, never a control (plan 7.2)
    assert config['taskId'] == 'enginehash:user-1'
    assert config['config']['threadCount'] == 4
    assert config['config']['pipelineTraceLevel'] is None
    # The SHAPE of the spec (C.22): the components with empty configs, the parameters map beside them
    assert config['config']['pipeline'] == {
        'version': 2,
        'source': 'src',
        'project_id': 'proj-1',
        'name': 'my-pipeline',
        'description': 'desc',
        'components': [{'id': 'src', 'config': {}}],
        'parameters': {},
    }
    assert config['config']['keystore'] == 'kvsfile://data/keystore.json'
    # No identity and no storage anchor ride the task file: a node's state and
    # files are stamped by the server per binding (plan 5.7)
    assert 'identity' not in config and 'storage' not in config
    # The channel token stays with the engine; nothing of it is in the task file.
    assert 'dt_test' not in json.dumps(config)


def test_build_task_supplies_pipeline_version_default(monkeypatch, tmp_path):
    """An absent ``version`` field defaults to 1."""
    monkeypatch.setattr(sys, 'executable', str(tmp_path / 'engine.exe'))
    monkeypatch.setattr(os, 'makedirs', lambda p, exist_ok=False: None)

    pipeline = {'source': 'src', 'components': []}
    t = _task(pipeline=pipeline)
    config = TaskEngine._build_task(t, pipeline)
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
    result = TaskEngine._file_checksum(t, str(p))
    assert result == hashlib.sha256(body).hexdigest()


def test_file_checksum_empty_file_yields_empty_sha256(tmp_path):
    """SHA-256 of an empty file is the canonical e3b0...b855."""
    p = tmp_path / 'empty.bin'
    p.write_bytes(b'')

    t = _task()
    assert TaskEngine._file_checksum(t, str(p)) == hashlib.sha256(b'').hexdigest()


# ---------------------------------------------------------------------------
# _is_debugging / _get_attach_subprocesses
# ---------------------------------------------------------------------------


def test_is_debugging_false_when_pydevd_absent(monkeypatch):
    """Without `pydevd` loaded, _is_debugging returns False."""
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    monkeypatch.delitem(sys.modules, 'debugpy', raising=False)
    assert TaskEngine._is_debugging(_task()) is False


def test_is_debugging_false_when_only_pydevd_loaded(monkeypatch):
    """Loading pydevd alone is not enough — debugpy must also be present."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock())
    monkeypatch.delitem(sys.modules, 'debugpy', raising=False)
    assert TaskEngine._is_debugging(_task()) is False


def test_is_debugging_true_when_both_present(monkeypatch):
    """When both modules are loaded, _is_debugging returns True."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock())
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert TaskEngine._is_debugging(_task()) is True


def test_get_attach_subprocesses_false_when_not_debugging(monkeypatch):
    """If not running under a debugger, subprocess-attach is always False."""
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    assert TaskEngine._get_attach_subprocesses(_task()) is False


def test_get_attach_subprocesses_false_when_setup_missing(monkeypatch):
    """A pydevd module without SetupHolder.setup falls through to False."""
    monkeypatch.setitem(sys.modules, 'pydevd', MagicMock(spec=[]))
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert TaskEngine._get_attach_subprocesses(_task()) is False


def test_get_attach_subprocesses_reads_multiprocess_flag(monkeypatch):
    """When pydevd.SetupHolder.setup['multiprocess'] is set, return its value."""
    pydevd = MagicMock()
    pydevd.SetupHolder = SimpleNamespace(setup={'multiprocess': True})
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert TaskEngine._get_attach_subprocesses(_task()) is True


def test_get_attach_subprocesses_swallows_unexpected_errors(monkeypatch):
    """Any exception while probing pydevd is caught and yields False."""
    pydevd = MagicMock()
    # Reading SetupHolder raises:
    type(pydevd).SetupHolder = property(lambda self: (_ for _ in ()).throw(RuntimeError('oops')))
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setitem(sys.modules, 'debugpy', MagicMock())
    assert TaskEngine._get_attach_subprocesses(_task()) is False


# ---------------------------------------------------------------------------
# State accessors
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'state, complete, live',
    [
        (EngineState.NEW, False, False),
        (EngineState.STARTING, False, True),
        (EngineState.RUNNING, False, True),
        (EngineState.STOPPING, False, False),
        (EngineState.STOPPED, True, False),
        (EngineState.FAILED, True, False),
    ],
)
def test_is_task_complete(state, complete, live):
    """STOPPED and FAILED are terminal; STARTING and RUNNING are live; STOPPING is neither."""
    t = _task()
    t.state = state
    assert TaskEngine.is_task_complete(t) is complete
    assert TaskEngine.is_live.fget(t) is live


def test_get_status_returns_the_status_object():
    """get_status returns the same TASK_STATUS instance that was attached."""
    status = SimpleNamespace(state=3)
    t = _task(status=status)
    assert TaskEngine.get_status(t) is status


def test_note_activity_only_moves_the_clock_forward():
    """Activity through a hold dates the engine's idle time; an older stamp never rewinds it."""
    t = _task()
    TaskEngine.note_activity(t, 100.0)
    TaskEngine.note_activity(t, 40.0)
    assert t._last_activity == 100.0


def test_a_held_engine_ages_on_its_own_timer():
    """A hold does not keep the engine running: it ages from its last activity like any engine."""
    t = _task()
    t._last_activity = 10.0
    assert TaskEngine.idle_seconds(t, 10_000.0) == 9990.0


def test_a_ttl_zero_holder_keeps_the_engine_from_aging():
    """An engine ages only while every holder has an idle ttl; a ttl-0 holder (a listener) pins it."""
    t = _task()
    assert TaskEngine.ages.fget(t) is True
    t._holds = {'dev.user-1.acme.proj-test.src-id': 900, 'dev.user-2.acme.proj-test.src-id': 0}
    assert TaskEngine.ages.fget(t) is False


def test_an_unheld_engine_ages_from_its_last_activity_or_pipeline_event():
    """The engine is idle since the later of its last activity and last dev pipeline event."""
    t = _task()
    t._holds = {}
    t._last_activity = 100.0
    t._last_pipeline_event = 160.0
    assert TaskEngine.idle_seconds(t, 400.0) == 240.0


def test_send_scheduled_updates_flips_the_flag():
    """send_scheduled_updates marks status as needing a broadcast."""
    t = _task()
    assert t._status_updated is False
    TaskEngine.send_scheduled_updates(t)
    assert t._status_updated is True


def test_on_metrics_updated_flips_status_updated_flag():
    """_on_metrics_updated flips ``_status_updated`` to True."""
    t = _task()
    assert t._status_updated is False
    TaskEngine._on_metrics_updated(t)
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
    TaskEngine._update_status(
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
    TaskEngine._update_status(
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
    # Rates are never copied: the status body is counts and bytes only (plan 7.5)
    assert t._status.rateSize == 0
    assert t._status.rateCount == 0


def test_update_status_error_event_appends_to_errors():
    """An ``apaevt_status_error`` event appends to ``status.errors``."""
    t = _task(status=_make_status_for_update())
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_error',
            'body': {'message': 'disk full'},
        },
    )
    assert t._status.errors == ['disk full']


def test_update_status_errors_buffer_trims_to_limit():
    """Error buffer keeps only the most recent CONST_STATUS_HISTORY_LIMIT entries."""
    t = _task(status=_make_status_for_update())
    t._status.errors = [f'err-{i}' for i in range(CONST_STATUS_HISTORY_LIMIT)]
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_error',
            'body': {'message': 'err-new'},
        },
    )
    assert len(t._status.errors) == CONST_STATUS_HISTORY_LIMIT
    assert t._status.errors[-1] == 'err-new'
    assert 'err-0' not in t._status.errors  # oldest evicted


def test_update_status_warning_event_appends_to_warnings():
    """An ``apaevt_status_warning`` event appends to ``status.warnings``."""
    t = _task(status=_make_status_for_update())
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_warning',
            'body': {'message': 'memory pressure'},
        },
    )
    assert t._status.warnings == ['memory pressure']


def test_update_status_warnings_buffer_trims_to_limit():
    """Warning buffer keeps only the most recent CONST_STATUS_HISTORY_LIMIT entries."""
    t = _task(status=_make_status_for_update())
    t._status.warnings = [f'warn-{i}' for i in range(CONST_STATUS_HISTORY_LIMIT)]
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_warning',
            'body': {'message': 'warn-new'},
        },
    )
    assert len(t._status.warnings) == CONST_STATUS_HISTORY_LIMIT
    assert t._status.warnings[-1] == 'warn-new'
    assert 'warn-0' not in t._status.warnings  # oldest evicted


def test_update_status_download_event_sets_status_string():
    """An ``apaevt_status_download`` event sets a human-readable status string."""
    t = _task(status=_make_status_for_update())
    TaskEngine._update_status(
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
    TaskEngine._update_status(
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
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': []},
        },
    )
    assert t._status.notes == []


def test_update_status_user_event_stores_notes_as_emitted():
    """Notes keep their identity placeholders ({token}, {address}, {project_id},
    {source}) in the ENGINE's status: one engine may serve several controls, and
    TaskControl.project_status expands them per holder (plan 7.5). Strings,
    dicts and other types ride through unchanged.
    """
    t = _task(status=_make_status_for_update())
    t.address = 'acme.proj-x.src-x'
    notes = ['send to {token}', {'url-link': '{host}/webhook/{address}', 'address': '{address}', 'count': 42}, 42]
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': notes},
        },
    )
    assert t._status.notes == notes
    assert t._status.notes is not notes


def test_update_status_user_event_keeps_unknown_note_types_as_is():
    """A non-string, non-dict note (e.g. int) is appended without modification."""
    t = _task(status=_make_status_for_update())
    TaskEngine._update_status(
        t,
        {
            'event': 'apaevt_status_user',
            'body': {'notes': [42]},
        },
    )
    assert t._status.notes == [42]


def test_update_status_user_event_merges_notes_by_node_id():
    """Every node writes the one notes slot: a database node's `open-tool` note
    (keyed by nodeId) joins the source's note instead of replacing it, and a
    repeat from the same node replaces only its own (plan 3.6).
    """
    t = _task(status=_make_status_for_update())
    source = {'button-text': 'Open Chat', 'open-tool': 'rocketride.chat', 'nodeId': '{source}', 'address': '{address}'}
    db = {'button-text': 'Explore', 'open-tool': 'rocketride.sql', 'nodeId': 'postgres_1', 'address': '{address}'}
    for notes in ([source], [db]):
        TaskEngine._update_status(t, {'event': 'apaevt_status_user', 'body': {'notes': notes}})
    assert t._status.notes == [source, db]
    # The same node again: its note is replaced where it stands, nothing else moves
    db2 = dict(db, **{'button-text': 'Explore again'})
    TaskEngine._update_status(t, {'event': 'apaevt_status_user', 'body': {'notes': [db2]}})
    assert t._status.notes == [source, db2]
    # An empty message (a source's shutdown) clears the slot, as before
    TaskEngine._update_status(t, {'event': 'apaevt_status_user', 'body': {'notes': []}})
    assert t._status.notes == []


def test_merge_status_notes_unkeyed_notes_keep_the_replace_semantics():
    """A note without a nodeId (the webhook's door, free text) replaces every
    earlier unkeyed note and leaves the keyed ones alone; keyed notes never
    disturb the unkeyed ones. The inputs are not modified.
    """
    webhook = {'url-link': '{host}/webhook/{address}', 'address': '{address}'}
    db = {'open-tool': 'rocketride.sql', 'nodeId': 'postgres_1', 'address': '{address}'}
    existing = [webhook, 'free text', db]
    merged = merge_status_notes(existing, [{'url-link': 'new door'}])
    assert merged == [{'url-link': 'new door'}, db]
    assert merge_status_notes(existing, [{'open-tool': 'x', 'nodeId': 'other'}]) == [
        webhook,
        'free text',
        db,
        {'open-tool': 'x', 'nodeId': 'other'},
    ]
    assert existing == [webhook, 'free text', db]
    # A nodeId that is not a non-empty string does not key the note
    assert merge_status_notes([webhook], [{'nodeId': '', 'x': 1}]) == [{'nodeId': '', 'x': 1}]
    # Two keyed notes of one node in one message: one note per node, the first
    assert merge_status_notes([], [{'nodeId': 'a', 'v': 1}, {'nodeId': 'a', 'v': 2}]) == [{'nodeId': 'a', 'v': 1}]


def test_update_status_info_event_merges_into_info_dict():
    """An ``apaevt_status_info`` event merges the body into ``self.info``."""
    t = _task(status=_make_status_for_update())
    t.info = {'existing': 'value'}
    TaskEngine._update_status(
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
    TaskEngine._update_status(
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
async def test_forward_task_event_non_debugger_routes_to_server_broadcast():
    """A non-DEBUGGER event is routed through the TaskServer broadcast API."""
    from rocketride import EVENT_TYPE
    from unittest.mock import AsyncMock

    t = _task()
    server = MagicMock()
    server.broadcast_task_event = AsyncMock()
    t._server = server
    t._holds = {'dev.user-1.acme.proj-x.src-x': 900}

    payload = {'event': 'summary', 'body': {}}
    await TaskEngine._forward_task_event(t, EVENT_TYPE.SUMMARY, payload)

    server.broadcast_task_event.assert_awaited_once()
    args = server.broadcast_task_event.await_args
    assert args.kwargs['key'] == 'dev.user-1.acme.proj-x.src-x'
    # The holder's copy carries its controlId and the engine's key (ALB seam 3)
    sent = args.kwargs['event']
    assert sent['event'] == 'summary'
    assert sent['body']['controlId'] == 'dev.user-1.acme.proj-x.src-x'
    assert sent['body']['engineKey'] == t.engine_key
    assert 'controlId' not in payload['body']


# ---------------------------------------------------------------------------
# db_access
# ---------------------------------------------------------------------------


def test_db_access_detects_each_provider():
    """Each of the three RocketRide cloud DB providers asks for its database
    (the org one by default); the chat source makes the pipeline public.
    """
    for provider in ('rocketride_sql', 'rocketride_vector', 'rocketride_graph'):
        pipeline = {'components': [{'id': 'a', 'provider': 'chat'}, {'id': 'b', 'provider': provider}]}
        assert db_access(pipeline) == ([('org', '')], True), provider


def test_db_access_empty_without_db_nodes():
    """Ordinary pipelines never trigger provisioning."""
    pipeline = {'components': [{'id': 'a', 'provider': 'chat'}, {'id': 'b', 'provider': 'db_postgres'}]}
    assert db_access(pipeline) == ([], True)


def test_db_access_resolves_a_db_node_only_eaas_serves(monkeypatch):
    """A DB node the server does not carry is resolved with the schema the node store keeps for it."""
    import ai.modules.task.task_engine as engine
    from ai.common import node_config

    served = node_config.node_schema('rocketride_sql')
    assert served is not None
    pipeline = {'components': [{'id': 'db', 'provider': 'rocketride_sql'}]}

    # The engine no longer knows the node; EaaS serves it
    monkeypatch.setattr(node_config, 'getServiceSchema', lambda provider: None)
    monkeypatch.setattr(engine.node_store, '_schemas', {'rocketride_sql': served})
    assert db_access(pipeline) == ([('org', '')], False)

    # Neither knows it: the run cannot be authorized for a database it cannot read the target of
    monkeypatch.setattr(engine.node_store, '_schemas', {})
    with pytest.raises(Exception, match='was not found'):
        db_access(pipeline)


def test_db_access_tolerates_malformed_components():
    """Missing components / non-dict entries must not raise at task start."""
    assert db_access({}) == ([], False)
    assert db_access({'components': ['not-a-dict', {'no-provider': True}]}) == ([], False)


# ---------------------------------------------------------------------------
# _build_subprocess_env — RocketRide DB credential hygiene
# ---------------------------------------------------------------------------

_DB_PIPELINE = {'components': [{'id': 'db', 'provider': 'rocketride_sql'}]}


def _env_task(pipeline=None):
    t = _task(pipeline=pipeline if pipeline is not None else {})
    t.client_id = 'client-env-test'
    return t


async def _build_env(t):
    """Build the env the way start_task does: from db_access of the pipeline."""
    return await TaskEngine._build_subprocess_env(t, db_access(t._pipeline))


def _patch_resolve(monkeypatch, fake):
    import ai.account

    monkeypatch.setattr(ai.account.account, 'resolve_db_dsn', fake)


@pytest.mark.asyncio
async def test_subprocess_env_scrubs_broker_credentials(monkeypatch):
    """The broker credential can mint ANY tenant's DSN — it must never reach
    node subprocesses, and neither may a parent-level DSN or stale error.
    """
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', 'https://broker.example')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', 'super-secret')
    monkeypatch.setenv('ROCKETRIDE_DB_DSN', 'postgresql://stale@parent/db')
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', '{"org": "postgresql://stale@parent/db"}')
    monkeypatch.setenv('ROCKETRIDE_DB_RESOLVE_ERROR', 'stale reason')

    env = await _build_env(_env_task())  # no DB nodes

    assert 'ROCKETRIDE_DB_BROKER_URL' not in env
    assert 'ROCKETRIDE_DB_BROKER_TOKEN' not in env
    assert 'ROCKETRIDE_DB_DSN' not in env
    assert 'ROCKETRIDE_DB_DSNS' not in env
    assert 'ROCKETRIDE_DB_RESOLVE_ERROR' not in env
    # Identity rides the task file (#1686), never the environment.
    assert 'ROCKETRIDE_CLIENT_ID' not in env


@pytest.mark.asyncio
async def test_subprocess_env_injects_resolved_dsn(monkeypatch):
    # Capture the tenant OUTSIDE the stub and assert after: _build_subprocess_env
    # converts resolver exceptions into ROCKETRIDE_DB_RESOLVE_ERROR, so an
    # AssertionError raised inside fake_resolve would be swallowed and surface
    # as a missing DSN key here instead of the real tenant mismatch.
    seen = {}

    async def fake_resolve(tenant_id):
        # The tenant is the ORG (B6) — the user is only the OSS fallback.
        seen['tenant'] = tenant_id
        return 'postgresql://tenant@pooler/db?sslmode=require'

    _patch_resolve(monkeypatch, fake_resolve)
    env = await _build_env(_env_task(pipeline=_DB_PIPELINE))
    assert json.loads(env['ROCKETRIDE_DB_DSNS']) == {'org': 'postgresql://tenant@pooler/db?sslmode=require'}
    assert seen['tenant'] == 'org-1'


@pytest.mark.asyncio
async def test_subprocess_env_dsn_tenant_is_the_org(monkeypatch):
    """The DB tenant is the ORG, not the user: a deploy run (client_id='')
    still resolves, and an org switch cannot silently re-point a user's DB
    nodes at another database.
    """
    seen = {}

    async def fake_resolve(tenant_id):
        seen['tenant'] = tenant_id
        return 'postgresql://tenant@pooler/db'

    _patch_resolve(monkeypatch, fake_resolve)
    # A deploy-shaped task: no client identity at all, org present.
    t = _env_task(pipeline=_DB_PIPELINE)
    t.client_id = ''
    env = await _build_env(t)
    assert json.loads(env['ROCKETRIDE_DB_DSNS']) == {'org': 'postgresql://tenant@pooler/db'}
    assert seen['tenant'] == 'org-1'


@pytest.mark.asyncio
async def test_subprocess_env_dsn_falls_back_to_client_without_an_org(monkeypatch):
    """OSS/single-user (no org concept): the user stays the tenant."""
    seen = {}

    async def fake_resolve(tenant_id):
        seen['tenant'] = tenant_id
        return 'postgresql://tenant@pooler/db'

    _patch_resolve(monkeypatch, fake_resolve)
    t = _env_task(pipeline=_DB_PIPELINE)
    t.org_id = ''
    await _build_env(t)
    assert seen['tenant'] == 'client-env-test'


@pytest.mark.asyncio
async def test_subprocess_env_stale_dsn_does_not_survive_broker_failure(monkeypatch):
    """A parent-env DSN must not become the node's DSN when resolution fails —
    it could point at another tenant. The failure reason is passed down instead.
    """
    monkeypatch.setenv('ROCKETRIDE_DB_DSN', 'postgresql://stale@parent/other-tenant')

    async def fake_resolve(client_id):
        raise RuntimeError('DB broker request failed: HTTP 503')

    _patch_resolve(monkeypatch, fake_resolve)
    t = _env_task(pipeline=_DB_PIPELINE)
    env = await _build_env(t)

    assert 'ROCKETRIDE_DB_DSN' not in env
    assert (
        env['ROCKETRIDE_DB_RESOLVE_ERROR'] == 'the org database failed to resolve: DB broker request failed: HTTP 503'
    )
    t.debug_message.assert_called_once()


@pytest.mark.asyncio
async def test_subprocess_env_unconfigured_account_reports_missing_cloud_db(monkeypatch):
    """No broker on this engine (#2463): still non-fatal, but the node gets a
    reason that names the missing cloud database, so it does not fall back to
    the ROCKETRIDE_CLIENT_ID message nothing documents.
    """

    async def fake_resolve(client_id):
        raise NotImplementedError('no RocketRide cloud database is configured on this server')

    _patch_resolve(monkeypatch, fake_resolve)
    monkeypatch.setattr('ai.modules.task.task_engine._is_saas_engine', lambda: False)
    warn = MagicMock()
    monkeypatch.setattr('ai.modules.task.task_engine.warning', warn)
    t = _env_task(pipeline=_DB_PIPELINE)
    env = await _build_env(t)
    assert 'ROCKETRIDE_DB_DSN' not in env
    assert env['ROCKETRIDE_DB_RESOLVE_ERROR'] == TaskEngine._NO_CLOUD_DB_REASON
    assert 'this server has no RocketRide cloud database' in env['ROCKETRIDE_DB_RESOLVE_ERROR']
    assert 'ROCKETRIDE_CLIENT_ID' not in env['ROCKETRIDE_DB_RESOLVE_ERROR']
    # Missing broker config is normal on a local engine: debug only.
    t.debug_message.assert_called_once()
    assert 'no database broker' in t.debug_message.call_args.args[0]
    warn.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('hosted_signal', ['flag', 'capability'])
async def test_subprocess_env_hosted_missing_broker_warns_and_directs_to_operator(monkeypatch, hosted_signal):
    import ai.account
    import ai.modules.task.task_engine as engine

    async def fake_resolve(client_id):
        raise NotImplementedError('broker not configured')

    _patch_resolve(monkeypatch, fake_resolve)
    monkeypatch.setattr(engine, 'startup_args', lambda: ['--saas'] if hosted_signal == 'flag' else [])
    monkeypatch.setattr(ai.account.account, 'capabilities', ['saas'] if hosted_signal == 'capability' else [])
    warn = MagicMock()
    monkeypatch.setattr(engine, 'warning', warn)
    monkeypatch.setenv('ROCKETRIDE_DB_DSN', 'postgresql://stale@parent/other-tenant')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', 'https://broker.example/provision')
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', 'secret-test-token')
    t = _env_task(pipeline=_DB_PIPELINE)
    env = await _build_env(t)
    reason = env['ROCKETRIDE_DB_RESOLVE_ERROR']
    assert reason == TaskEngine._CLOUD_DB_CONFIG_ERROR_REASON
    assert 'Contact the server operator' in reason
    assert 'db_postgres' not in reason
    for name in ('ROCKETRIDE_DB_DSN', 'ROCKETRIDE_DB_BROKER_URL', 'ROCKETRIDE_DB_BROKER_TOKEN'):
        assert name not in env
    warn.assert_called_once_with(f'RocketRide DB DSN not resolved: {reason}')
    t.debug_message.assert_not_called()


# ---------------------------------------------------------------------------
# _build_subprocess_env — per-scope authorization and the DSN map (SDD 4.6)
# ---------------------------------------------------------------------------

# One component per node type, in the shape the canvas saves: a tree addressed
# by the schema paths (these nodes' properties all live at the root), with the
# unset keys left to their defaults (sql: the org database).
_SCOPED_PIPELINE = {
    'components': [
        {'id': 'chat_1', 'provider': 'chat', 'config': {'mode': 'Source'}},
        {'id': 'sql_1', 'provider': 'rocketride_sql', 'config': {'table': 't'}},
        {'id': 'vec_1', 'provider': 'rocketride_vector', 'config': {'scope': 'team'}},
        {'id': 'graph_1', 'provider': 'rocketride_graph', 'config': {'scope': 'user', 'target': 'user-2'}},
    ]
}


def _fake_db_account(monkeypatch, deny=None, owner=None):
    """Swap the account's authorize/resolve for recorders. ``deny(target)``
    returns a reason to refuse that target, or None to allow it. An allow
    names the requested team or user id as its owner_id, as the SaaS
    account does, unless ``owner(target)`` names another.
    """
    import ai.account
    from ai.account.base import DbDecision

    calls = {'authorize': [], 'resolve': []}

    async def authorize(identity, target=None):
        calls['authorize'].append((identity, target))
        reason = deny(target) if deny else None
        if reason:
            return DbDecision(False, reason, True)
        approved = owner(target) if owner else target.get('team_id') or target.get('user_id') or ''
        return DbDecision(True, 'ok', False, approved)

    async def resolve(client_id, scope='org', owner_id=''):
        calls['resolve'].append((client_id, scope, owner_id))
        return f'postgresql://{scope}-{owner_id or client_id}@pooler/db'

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize)
    monkeypatch.setattr(ai.account.account, 'resolve_db_dsn', resolve)
    return calls


@pytest.mark.asyncio
async def test_db_dsn_map_has_one_entry_per_scope(monkeypatch):
    calls = _fake_db_account(monkeypatch)
    env = await _build_env(_env_task(pipeline=_SCOPED_PIPELINE))

    assert json.loads(env['ROCKETRIDE_DB_DSNS']) == {
        'org': 'postgresql://org-org-1@pooler/db',
        'team': 'postgresql://team-team-1@pooler/db',
        'user:user-2': 'postgresql://user-user-2@pooler/db',
    }
    # The map is the only delivery: no single-DSN variable.
    assert 'ROCKETRIDE_DB_DSN' not in env
    assert [target for _, target in calls['authorize']] == [
        {'scope': 'org'},
        {'scope': 'team', 'team_id': 'team-1'},
        {'scope': 'user', 'user_id': 'user-2'},
    ]
    # The org call is the unchanged single-tenant one; team and user are scoped.
    assert calls['resolve'] == [('org-1', 'org', ''), ('org-1', 'team', 'team-1'), ('org-1', 'user', 'user-2')]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('client_id', 'run_kind', 'owner_kind', 'expected_user'),
    [
        ('user-1', 'dev', 'user', 'user-1'),  # builder run, store app, address-fed dev run
        ('', 'deploy', 'team', ''),  # @team deploy: no user
        ('user-1', 'deploy', 'user', 'user-1'),  # @me deploy
    ],
)
async def test_db_identity_comes_from_the_task(monkeypatch, client_id, run_kind, owner_kind, expected_user):
    calls = _fake_db_account(monkeypatch)
    t = _env_task(pipeline=_DB_PIPELINE)
    t.client_id, t._run_kind, t._owner_kind = client_id, run_kind, owner_kind
    await _build_env(t)

    identity, target = calls['authorize'][0]
    assert target == {'scope': 'org'}
    assert identity == {
        'org_id': 'org-1',
        'user_id': expected_user,
        'team_id': 'team-1',
        'run_kind': run_kind,
        'owner_kind': owner_kind,
        'public_endpoint': False,
        'path': 'pipeline',
        'task_id': 'task-test',
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('source', 'public'),
    [('chat', True), ('dropper', True), ('webhook', True), ('discord', True), ('telegram', True), ('tools', False)],
)
async def test_public_endpoint_comes_from_the_source_nodes(monkeypatch, source, public):
    """Every task is addressed the same way, so nothing on the task itself
    can decide this: the pipeline's source providers do (OQ 14).
    """
    calls = _fake_db_account(monkeypatch)
    pipeline = {'components': [{'id': 's', 'provider': source}, {'id': 'db', 'provider': 'rocketride_sql'}]}
    await _build_env(_env_task(pipeline=pipeline))
    assert calls['authorize'][0][0]['public_endpoint'] is public


@pytest.mark.asyncio
async def test_denial_fails_task_start_before_anything_is_provisioned(monkeypatch):
    calls = _fake_db_account(
        monkeypatch, deny=lambda target: 'public_endpoint_cannot_use_user_db' if target['scope'] == 'user' else None
    )
    with pytest.raises(PermissionError, match="user database 'user-2': public_endpoint_cannot_use_user_db"):
        await _build_env(_env_task(pipeline=_SCOPED_PIPELINE))
    assert calls['resolve'] == []


@pytest.mark.asyncio
async def test_team_deploy_asks_for_a_user_database_with_no_user(monkeypatch):
    """A team deploy has no user: the request carries user_id='' and the
    account layer refuses it (hard rule 1). Nothing is resolved.
    """
    calls = _fake_db_account(
        monkeypatch, deny=lambda target: 'team_deploy_has_no_user' if target['scope'] == 'user' else None
    )
    t = _env_task(pipeline={'components': [{'id': 'g', 'provider': 'rocketride_graph', 'config': {'scope': 'user'}}]})
    t.client_id, t._run_kind, t._owner_kind = '', 'deploy', 'team'
    with pytest.raises(PermissionError, match='team_deploy_has_no_user'):
        await _build_env(t)
    assert calls['authorize'][0][1] == {'scope': 'user', 'user_id': ''}
    assert calls['resolve'] == []


@pytest.mark.asyncio
async def test_own_team_named_twice_is_one_database(monkeypatch):
    """scope=team with no target and with the run's own team id are the same
    database: authorized and resolved once, delivered under both keys.
    """
    calls = _fake_db_account(monkeypatch)
    pipeline = {
        'components': [
            {'id': 'a', 'provider': 'rocketride_sql', 'config': {'scope': 'team'}},
            {'id': 'b', 'provider': 'rocketride_graph', 'config': {'scope': 'team', 'target': 'team-1'}},
        ]
    }
    env = await _build_env(_env_task(pipeline=pipeline))
    assert json.loads(env['ROCKETRIDE_DB_DSNS']) == {
        'team': 'postgresql://team-team-1@pooler/db',
        'team:team-1': 'postgresql://team-team-1@pooler/db',
    }
    assert len(calls['authorize']) == 1 and len(calls['resolve']) == 1


@pytest.mark.asyncio
async def test_the_engine_resolves_the_database_the_decision_named(monkeypatch):
    """rocketride-saas #833 review: the engine provisions decision.owner_id,
    the id that was checked, never its own re-derivation of the target.
    """
    calls = _fake_db_account(monkeypatch, owner=lambda target: 'team-checked' if target['scope'] == 'team' else '')
    pipeline = {'components': [{'id': 'a', 'provider': 'rocketride_sql', 'config': {'scope': 'team'}}]}
    env = await _build_env(_env_task(pipeline=pipeline))
    assert calls['authorize'][0][1] == {'scope': 'team', 'team_id': 'team-1'}
    assert calls['resolve'] == [('org-1', 'team', 'team-checked')]
    assert json.loads(env['ROCKETRIDE_DB_DSNS']) == {'team': 'postgresql://team-team-checked@pooler/db'}


@pytest.mark.asyncio
async def test_malformed_scope_fails_task_start(monkeypatch):
    """The resolver refuses the value against the schema's enum before the DB layer sees it."""
    calls = _fake_db_account(monkeypatch)
    pipeline = {'components': [{'id': 'sql_1', 'provider': 'rocketride_sql', 'config': {'scope': 'everyone'}}]}
    with pytest.raises(ValueError, match="sql_1: \"scope\" must be one of \\['org', 'team', 'user'\\], got 'everyone'"):
        await _build_env(_env_task(pipeline=pipeline))
    assert calls['authorize'] == []


@pytest.mark.asyncio
async def test_authorize_raising_fails_task_start_and_issues_no_dsn(monkeypatch):
    """An authorization check that errors (the account layer is down) fails
    closed: the start raises and nothing is provisioned.
    """
    import ai.account

    calls = _fake_db_account(monkeypatch)

    async def authorize(identity, target=None):
        raise RuntimeError('membership lookup failed')

    monkeypatch.setattr(ai.account.account, 'authorize_db_target', authorize)
    with pytest.raises(RuntimeError, match='membership lookup failed'):
        await _build_env(_env_task(pipeline=_SCOPED_PIPELINE))
    assert calls['resolve'] == []


@pytest.mark.asyncio
async def test_failed_resolve_names_the_database_that_failed(monkeypatch):
    """One failed resolve delivers no DSN at all (fail closed), and the
    reason every node reports names the database that failed, not the org
    database the first node asked for.
    """
    calls = _fake_db_account(monkeypatch)

    async def resolve(client_id, scope='org', owner_id=''):
        calls['resolve'].append((client_id, scope, owner_id))
        if scope == 'team':
            raise RuntimeError('DB broker rejected provision for this account (HTTP 403)')
        return f'postgresql://{scope}@pooler/db'

    import ai.account

    monkeypatch.setattr(ai.account.account, 'resolve_db_dsn', resolve)
    env = await _build_env(_env_task(pipeline=_SCOPED_PIPELINE))
    assert 'ROCKETRIDE_DB_DSNS' not in env and 'ROCKETRIDE_DB_DSN' not in env
    assert env['ROCKETRIDE_DB_RESOLVE_ERROR'] == (
        "the team database 'team-1' failed to resolve: DB broker rejected provision for this account (HTTP 403)"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('components', 'env', 'target', 'public'),
    [
        # A provider that only becomes a public source after expansion.
        (
            [{'id': 'src', 'provider': '${ROCKETRIDE_SOURCE}'}, {'id': 'db', 'provider': 'rocketride_sql'}],
            {'ROCKETRIDE_SOURCE': 'webhook'},
            {'scope': 'org'},
            True,
        ),
        # A DB node and its target that only appear after expansion.
        (
            [
                {'id': 'src', 'provider': 'tools'},
                {
                    'id': 'db',
                    'provider': '${ROCKETRIDE_DB_NODE}',
                    'config': {'scope': 'team', 'target': '${ROCKETRIDE_TEAM}'},
                },
            ],
            {'ROCKETRIDE_DB_NODE': 'rocketride_graph', 'ROCKETRIDE_TEAM': 'team-9'},
            {'scope': 'team', 'team_id': 'team-9'},
            False,
        ),
    ],
)
async def test_start_authorizes_the_resolved_pipeline(monkeypatch, components, env, target, public):
    """start_task authorizes the pipeline it runs, not the raw one: ${...}
    expansion can turn a provider into a public source or a DB node, and a
    target into an id (PR #2626 review).
    """
    import ai.modules.task.task_engine as engine

    calls = _fake_db_account(monkeypatch)
    t = _env_task(pipeline={'components': components})
    t.source = 'src'
    t._env_source = AsyncMock(return_value=env)
    t._restart_env = None
    t._status = SimpleNamespace(name='', state=engine.TASK_STATE.NONE.value, exitMessage='', completed=False)
    t._launch_args = {}
    t._server = MagicMock(_config={})
    t._is_debugging = lambda: False
    t._write_task_file = AsyncMock(return_value='/tmp/task.json')
    t._send_status_update = AsyncMock()
    t._terminated = AsyncMock()

    class Launched(Exception):
        pass

    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', AsyncMock(side_effect=Launched))
    with pytest.raises(Launched):
        await TaskEngine.start_task(t)

    assert [request for _, request in calls['authorize']] == [target]
    assert calls['authorize'][0][0]['public_endpoint'] is public
    # What RUNS keeps its placeholders (plan 6.2): the task file carries the
    # spec as written plus the engine's default env (the referenced values)
    written, default_env = t._write_task_file.call_args.args
    assert '${' in json.dumps(written['components'])
    assert default_env == env


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('saas', 'startup', 'user', 'passed'),
    [
        # The hosting flags come from the engine itself, not from its arguments
        (True, [], [], ['--hosted', '--shared-host']),
        (False, [], [], []),
        # Crash dumps follow the engine's own --dumps
        (False, ['--dumps'], [], ['--dumps']),
        # A pipeline's own is dropped, whatever spelling it used
        (False, [], ['--dumps'], []),
        (False, [], ['--DUMPS'], []),
        (False, [], ['--trace=debugOut --Dumps=yes'], ['--trace=debugOut']),
        (False, ['--dumps'], ['--dumps=false'], ['--dumps']),
        # The trace level is the caller's if it set one, the engine's otherwise
        (False, ['--trace=a'], [], ['--trace=a']),
        (False, ['--trace=a'], ['--trace=b'], ['--trace=b']),
    ],
)
async def test_start_passes_only_the_operators_options(monkeypatch, saas, startup, user, passed):
    """The task's command line carries what the operator chose: --hosted and
    --shared-host for a hosted engine, and --dumps as the engine itself was
    started. The engine reads the first --dumps, and the operator's is written
    before a pipeline's own arguments, so a pipeline cannot turn dumps on.
    """
    import ai.modules.task.task_engine as engine

    _fake_db_account(monkeypatch)
    monkeypatch.setattr(engine, '_is_saas_engine', lambda: saas)
    monkeypatch.setattr(engine, 'startup_args', lambda: startup)
    t = _env_task(pipeline={'components': [{'id': 'src', 'provider': 'tools'}]})
    t.source = 'src'
    t._env_source = AsyncMock(return_value={})
    t._restart_env = None
    t._status = SimpleNamespace(name='', state=engine.TASK_STATE.NONE.value, exitMessage='', completed=False)
    t._launch_args = {'args': user}
    t._server = MagicMock(_config={})
    t._is_debugging = lambda: False
    t._write_task_file = AsyncMock(return_value='/tmp/task.json')
    t._send_status_update = AsyncMock()
    t._terminated = AsyncMock()

    class Launched(Exception):
        pass

    spawn = AsyncMock(side_effect=Launched)
    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', spawn)
    with pytest.raises(Launched):
        await TaskEngine.start_task(t)

    # Lower-cased: the engine matches options without regard to case, so the test must too
    options = [
        a for a in spawn.call_args.args if a.lower().startswith(('--hosted', '--shared-host', '--dumps', '--trace='))
    ]
    assert options == passed


@pytest.mark.parametrize('saas', [True, False])
def test_hosted_refusal_asks_the_gate_for_the_shared_host_on_a_hosted_engine_only(monkeypatch, saas):
    """The server's per-control check: the gate is asked, told the task shares the host, on a hosted engine only."""
    import ai.modules.task.task_engine as engine

    monkeypatch.setattr(engine, '_is_saas_engine', lambda: saas)
    checked = []
    monkeypatch.setattr(engine, 'saas_pipeline_violation', lambda *a, **k: checked.append(k['shared_host']) or 'no')
    assert engine.hosted_refusal({'components': []}) == ('no' if saas else None)
    assert checked == ([True] if saas else [])


@pytest.mark.asyncio
@pytest.mark.parametrize('available', [True, False])
async def test_start_puts_the_pipelines_nodes_on_disk_before_the_spawn(monkeypatch, available):
    """The nodes a pipeline names that the server lacks are unpacked before the
    engine starts, so its start-up scan loads them; one that cannot be had
    refuses the launch and nothing is spawned.
    """
    import ai.modules.task.task_engine as engine

    monkeypatch.setattr(engine, '_is_saas_engine', lambda: False)
    order = []

    def place(pipeline):
        order.append(('place', [c['provider'] for c in pipeline['components']]))
        if not available:
            raise FileNotFoundError('llm_x.rrnode is not in releases server-v1')

    monkeypatch.setattr(engine.node_store, 'place', place)
    t = _task(source='src', pipeline={'components': [{'id': 'src', 'provider': 'llm_x'}]})
    t._status = SimpleNamespace(name='', state=engine.TASK_STATE.NONE.value, exitMessage='', completed=False)
    t._server = MagicMock(_config={})
    t._launch_args = {}
    t._default_env = AsyncMock(return_value={})
    t._is_debugging = lambda: False
    t._shares_host = lambda: False
    t._write_task_file = AsyncMock(return_value='/tmp/task.json')
    t._send_status_update = AsyncMock()
    t._build_subprocess_env = AsyncMock(return_value={})
    t._terminated = AsyncMock()

    class Launched(Exception):
        pass

    async def spawn(*args, **kwargs):
        order.append(('spawn',))
        raise Launched()

    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', spawn)
    with pytest.raises(Launched if available else RuntimeError, match=None if available else "pipeline's nodes"):
        await TaskEngine.start_task(t)

    assert order == ([('place', ['llm_x']), ('spawn',)] if available else [('place', ['llm_x'])])
    # A start that fails ends the run, whichever step refused it
    t._terminated.assert_awaited_once()


# ---------------------------------------------------------------------------
# filter_subprocess_env — the child inherits an allowlist, never the whole env
# ---------------------------------------------------------------------------


def test_filter_subprocess_env_is_an_allowlist():
    """Engine-tier configuration never reaches pipeline code: only the runtime
    baseline, the ROCKETRIDE_* namespace, the services the child reaches
    itself (the OAuth broker) and README-documented node fallbacks pass. The
    object store, its secret, the public address and the fetch-URL signing
    key stay with the server: a node's files and state go through it (plan
    5.7), and so does any shared state store.
    """
    env = filter_subprocess_env(
        {
            'PATH': '/usr/bin',
            'HOME': '/home/rocketride',
            'http_proxy': 'http://proxy:3128',
            'PYTHONPATH': '/opt/rocketride/ai',
            'HF_HOME': '/cache/hf',
            'ROCKETRIDE_OPENAI_KEY': 'sk-pipe',
            'RR_STORE_URL': 's3://bucket',
            'RR_STORE_SECRET_KEY': 'store',
            'RR_BASE_URL': 'https://engine.example',
            'RR_SIGNING_KEY': 'sign',
            'RR_OAUTH_BROKER_URL': 'https://broker.example',
            'RR_PROC_PRIVATE': '1',
            'AWS_ROLE_ARN': 'arn:aws:iam::1:role/engine',
            'MEDIA_TOOLKIT_FFMPEG': '/opt/ffmpeg',
            'NOTION_API_KEY': 'notion',
            # engine-only: deployment credentials and server-side settings
            'RR_DB_URL': 'postgresql://platform',
            'RR_MASTER_KEY': 'fernet',
            'RR_PARAM_TOKEN_SECRET': 'param-token-secret',
            'RR_IDP_SERVICE_TOKEN': 'jwt',
            'RR_APP_URL': 'https://app.example',
            'ENGINE_API_KEY': 'engine',
            'DATABASE_URL': 'postgresql://other',
            'SLACK_BOT_TOKEN': 'xoxb',
            'RR_REDIS_URL': 'redis://state',
        }
    )
    assert env == {
        'PATH': '/usr/bin',
        'HOME': '/home/rocketride',
        'http_proxy': 'http://proxy:3128',
        'PYTHONPATH': '/opt/rocketride/ai',
        'HF_HOME': '/cache/hf',
        'ROCKETRIDE_OPENAI_KEY': 'sk-pipe',
        'RR_OAUTH_BROKER_URL': 'https://broker.example',
        'RR_PROC_PRIVATE': '1',  # tasks must see the opt-in to act on it
        'AWS_ROLE_ARN': 'arn:aws:iam::1:role/engine',
        'MEDIA_TOOLKIT_FFMPEG': '/opt/ffmpeg',
        'NOTION_API_KEY': 'notion',
    }


def test_filter_subprocess_env_opt_in_names_and_prefixes():
    """RR_SUBPROCESS_ENV adds exact names and '*'-suffixed prefixes, separated
    by commas or spaces. The knob itself is operator-tier (RR_*) and is not
    handed to the child.
    """
    env = filter_subprocess_env(
        {
            'RR_SUBPROCESS_ENV': 'SLACK_BOT_TOKEN, gh_*',
            'SLACK_BOT_TOKEN': 'xoxb',
            'GH_TOKEN': 'ghp',
            'GH_HOST': 'github.example',
            'RR_MASTER_KEY': 'fernet',
        }
    )
    assert env == {
        'SLACK_BOT_TOKEN': 'xoxb',
        'GH_TOKEN': 'ghp',
        'GH_HOST': 'github.example',
    }


def test_filter_subprocess_env_ignores_caller_writable_opt_in():
    """ROCKETRIDE_* is writable by any authenticated client (account set_env),
    so an opt-in spelled there must have no effect.
    """
    env = filter_subprocess_env({'ROCKETRIDE_SUBPROCESS_ENV': '*', 'RR_MASTER_KEY': 'fernet', 'PATH': '/usr/bin'})
    assert env == {'ROCKETRIDE_SUBPROCESS_ENV': '*', 'PATH': '/usr/bin'}


def test_filter_subprocess_env_star_passes_everything():
    """A bare '*' is the explicit opt-out back to full inheritance."""
    src = {'RR_SUBPROCESS_ENV': '*', 'RR_MASTER_KEY': 'fernet', 'PATH': '/usr/bin'}
    assert filter_subprocess_env(src) == src


def test_filter_subprocess_env_passes_the_mocks_and_not_the_servers_own_keys():
    """RR_MOCK is handed to every engine by name; the server's API key and its
    MCP credential are RR_* names the allowlist never passes.
    """
    env = filter_subprocess_env(
        {
            'RR_MOCK': '/mocks',
            'RR_APIKEY': 'server-key',
            'RR_MCP_ENGINE_AUTH': 'mcp-key',
            'RR_MCP_ENGINE_URI': 'wss://engine',
        }
    )
    assert env == {'RR_MOCK': '/mocks'}


# ---------------------------------------------------------------------------
# resolve_parameter_tokens — the child gets values, not tokens it cannot read
# ---------------------------------------------------------------------------

_TOKEN_PIPELINE = {
    'source': 'source_1',
    'components': [
        {
            'id': 'source_1',
            'provider': 'filesys',
            'config': {'parameters': {'secureParameters': {'secure': ['password'], 'token': 'UlJQVAI='}}},
        }
    ],
}


@pytest.fixture
def engine_resolve(monkeypatch):
    """Record calls to rocketlib.resolveSecureParameters and return a decoded pipeline."""
    calls = []
    decoded = {'source': 'source_1', 'components': [{'id': 'source_1', 'config': {'parameters': {'password': 'pw'}}}]}

    def resolve(pipeline):
        calls.append(pipeline)
        return decoded

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', resolve, raising=False)
    return SimpleNamespace(calls=calls, decoded=decoded)


def test_resolve_parameter_tokens_without_secret_passes_through(engine_resolve):
    """Without the deployment secret the child decodes its own tokens, as before."""
    assert resolve_parameter_tokens(_TOKEN_PIPELINE, environ={}) is _TOKEN_PIPELINE
    assert resolve_parameter_tokens(_TOKEN_PIPELINE, environ={CONST_PARAM_TOKEN_SECRET_ENV: ''}) is _TOKEN_PIPELINE
    assert engine_resolve.calls == []


def test_resolve_parameter_tokens_with_secret_decodes_in_engine(engine_resolve):
    """With the deployment secret set, the engine decodes the tokens before the task file is written."""
    result = resolve_parameter_tokens(_TOKEN_PIPELINE, environ={CONST_PARAM_TOKEN_SECRET_ENV: 'param-token-secret'})
    assert result is engine_resolve.decoded
    assert engine_resolve.calls == [_TOKEN_PIPELINE]


def test_resolve_parameter_tokens_reads_process_environment(engine_resolve, monkeypatch):
    """The default environment is the engine process's own."""
    monkeypatch.delenv(CONST_PARAM_TOKEN_SECRET_ENV, raising=False)
    assert resolve_parameter_tokens(_TOKEN_PIPELINE) is _TOKEN_PIPELINE

    monkeypatch.setenv(CONST_PARAM_TOKEN_SECRET_ENV, 'param-token-secret')
    assert resolve_parameter_tokens(_TOKEN_PIPELINE) is engine_resolve.decoded


def test_param_token_secret_stays_out_of_subprocess():
    """The child never gets the secret, which is why the engine decodes for it."""
    env = filter_subprocess_env({'PATH': '/usr/bin', CONST_PARAM_TOKEN_SECRET_ENV: 'param-token-secret'})
    assert env == {'PATH': '/usr/bin'}


def test_filter_subprocess_env_matches_names_case_insensitively():
    """Windows env names are case-insensitive; the child sees the original spelling."""
    env = filter_subprocess_env({'Path': 'C:\\Windows', 'SystemRoot': 'C:\\Windows', 'Rr_Master_Key': 'fernet'})
    assert env == {'Path': 'C:\\Windows', 'SystemRoot': 'C:\\Windows'}


@pytest.mark.asyncio
async def test_subprocess_env_drops_engine_credentials(monkeypatch):
    """The built env is the allowlisted view of os.environ: deployment
    credentials stay in the engine, the pipeline namespace comes through.
    """
    monkeypatch.setenv('RR_MASTER_KEY', 'fernet')
    monkeypatch.setenv('RR_DB_URL', 'postgresql://platform')
    monkeypatch.setenv('ROCKETRIDE_OPENAI_KEY', 'sk-pipe')
    monkeypatch.setenv('PATH', '/usr/bin')
    monkeypatch.delenv('RR_SUBPROCESS_ENV', raising=False)

    env = await _build_env(_env_task())  # no DB nodes

    assert 'RR_MASTER_KEY' not in env
    assert 'RR_DB_URL' not in env
    assert env['ROCKETRIDE_OPENAI_KEY'] == 'sk-pipe'
    assert env['PATH'] == '/usr/bin'


# ---------------------------------------------------------------------------
# _accumulate_analytics — run analytics in the status body
# ---------------------------------------------------------------------------


def _analytics_task():
    """A task with a REAL status model and fresh analytics state."""
    from rocketride import TASK_STATUS

    t = _task(status=TASK_STATUS())
    t._an_open_by_pipe = {}
    t._an_component_open = {}
    t._an_idle_total = 0.0
    t._an_idle_longest = 0.0
    t._an_idle_longest_at = 0.0
    t._an_idle_since = 0.0
    return t


def test_analytics_interleaved_pipes_correlate_by_pipe():
    """
    The pipe id is the correlation key: BEGIN[parse]:0, BEGIN[parse]:32,
    END[parse]:0, END[parse]:32 must yield two DISTINCT durations — a
    component-keyed accumulator would clobber pipe 0's begin with pipe 32's.
    """
    t = _analytics_task()
    t0 = 1_000.0

    TaskEngine._accumulate_analytics(t, 'begin', 0, 'parse', ['a.txt'], {'eventTime': t0, 'logSeq': 100})
    TaskEngine._accumulate_analytics(t, 'begin', 32, 'parse', ['b.txt'], {'eventTime': t0 + 0.5, 'logSeq': 101})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'parse', ['a.txt'], {'eventTime': t0 + 1.0})
    TaskEngine._accumulate_analytics(t, 'end', 32, 'parse', ['b.txt'], {'eventTime': t0 + 3.0})

    docs = t._status.slowestDocs
    assert [(d.name, d.elapsed, d.beginSeq) for d in docs] == [('b.txt', 2.5, 101), ('a.txt', 1.0, 100)]
    assert t._status.completionSeconds == 3.5
    # Correlation state fully consumed.
    assert t._an_open_by_pipe == {}


def test_analytics_component_stats_key_by_pipe_and_reenter():
    """Enter/leave pairs interleave across pipes and reenter within one."""
    t = _analytics_task()
    t0 = 2_000.0

    # Interleaved across pipes: each leave must pair with ITS pipe's enter.
    TaskEngine._accumulate_analytics(t, 'enter', 0, 'parse', [], {'eventTime': t0})
    TaskEngine._accumulate_analytics(t, 'enter', 32, 'parse', [], {'eventTime': t0 + 1.0})
    TaskEngine._accumulate_analytics(t, 'leave', 0, 'parse', [], {'eventTime': t0 + 2.0})
    TaskEngine._accumulate_analytics(t, 'leave', 32, 'parse', [], {'eventTime': t0 + 2.5})

    stat = t._status.componentStats['parse']
    assert stat.calls == 2
    assert stat.totalSeconds == 3.5  # 2.0 + 1.5
    assert stat.maxSeconds == 2.0

    # Reentrancy within ONE pipe: LIFO within the (pipe, component) stack.
    TaskEngine._accumulate_analytics(t, 'enter', 0, 'llm', [], {'eventTime': t0})
    TaskEngine._accumulate_analytics(t, 'enter', 0, 'llm', [], {'eventTime': t0 + 1.0})
    TaskEngine._accumulate_analytics(t, 'leave', 0, 'llm', [], {'eventTime': t0 + 1.5})
    TaskEngine._accumulate_analytics(t, 'leave', 0, 'llm', [], {'eventTime': t0 + 4.0})
    llm = t._status.componentStats['llm']
    assert llm.calls == 2
    assert llm.totalSeconds == 4.5  # inner 0.5 + outer 4.0
    assert llm.maxSeconds == 4.0


def test_analytics_slowest_list_bounded_and_sorted():
    """The slowest list keeps the configured cap, slowest first."""
    from ai.constants import CONST_ANALYTICS_SLOWEST_DOCS

    t = _analytics_task()
    for i in range(CONST_ANALYTICS_SLOWEST_DOCS + 5):
        TaskEngine._accumulate_analytics(t, 'begin', i, 'p', [f'doc-{i}'], {'eventTime': 100.0, 'logSeq': i})
        TaskEngine._accumulate_analytics(t, 'end', i, 'p', [], {'eventTime': 100.0 + float(i + 1)})

    docs = t._status.slowestDocs
    assert len(docs) == CONST_ANALYTICS_SLOWEST_DOCS
    elapsed = [d.elapsed for d in docs]
    assert elapsed == sorted(elapsed, reverse=True)
    # The fastest completions fell off the bounded list.
    assert min(elapsed) > 1.0


def test_analytics_reset_clears_state():
    """_reset_status clears analytics fields AND correlation state."""
    t = _analytics_task()
    t._status_trace = []
    t.info = {}
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['x'], {'eventTime': 1.0, 'logSeq': 1})
    TaskEngine._accumulate_analytics(t, 'enter', 0, 'p', [], {'eventTime': 1.0})
    TaskEngine._accumulate_analytics(t, 'leave', 0, 'p', [], {'eventTime': 2.0})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': 3.0})
    assert t._status.componentStats and t._status.slowestDocs

    TaskEngine._reset_status(t)
    assert t._status.componentStats == {}
    assert t._status.slowestDocs == []
    assert t._status.completionSeconds == 0.0
    assert t._an_open_by_pipe == {} and t._an_component_open == {}


def test_analytics_idle_between_completions():
    """
    Pipe-unused time: quiet stretches BETWEEN completions accumulate (total
    + longest + when the longest began); overlapping completions never
    count as quiet. All published numbers are server-computed.
    """
    t = _analytics_task()
    t0 = 3_000.0

    # First completion — nothing before it counts (never went quiet).
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['a'], {'eventTime': t0, 'logSeq': 1})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': t0 + 1.0})
    assert t._an_idle_since == t0 + 1.0
    assert t._status.idleSeconds == 0.0

    # 4s quiet closes at the next begin; the marker clears while busy. The
    # longest stretch remembers WHEN it began.
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['b'], {'eventTime': t0 + 5.0, 'logSeq': 2})
    assert t._status.idleSeconds == 4.0
    assert t._status.idleLongestSeconds == 4.0
    assert t._status.idleLongestAt == t0 + 1.0
    assert t._an_idle_since == 0.0

    # Overlap: pipe 1 begins before pipe 0 ends — no quiet in between.
    TaskEngine._accumulate_analytics(t, 'begin', 1, 'p', ['c'], {'eventTime': t0 + 6.0, 'logSeq': 3})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': t0 + 7.0})
    assert t._an_idle_since == 0.0  # pipe 1 still busy
    TaskEngine._accumulate_analytics(t, 'end', 1, 'p', [], {'eventTime': t0 + 8.0})
    assert t._an_idle_since == t0 + 8.0

    # A shorter 1s gap grows the total but not the longest (or its stamp).
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['d'], {'eventTime': t0 + 9.0, 'logSeq': 4})
    assert t._status.idleSeconds == 5.0
    assert t._status.idleLongestSeconds == 4.0
    assert t._status.idleLongestAt == t0 + 1.0


def test_analytics_idle_refresh_extends_open_stretch():
    """
    The periodic publish path folds the STILL-OPEN quiet stretch into the
    status: total grows, and once the open stretch beats the recorded
    longest it becomes the longest — with ITS start as the stamp. Trace
    events never arrive during silence, so this is what keeps a quiet
    pipe's numbers current.
    """
    t = _analytics_task()
    t0 = 4_000.0

    # One closed 2s gap, then quiet from t0+5.
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['a'], {'eventTime': t0, 'logSeq': 1})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': t0 + 1.0})
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['b'], {'eventTime': t0 + 3.0, 'logSeq': 2})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': t0 + 5.0})

    # 1s into the silence: total extends, closed 2s gap is still longest.
    TaskEngine._refresh_idle_status(t, t0 + 6.0)
    assert t._status.idleSeconds == 3.0
    assert t._status.idleLongestSeconds == 2.0
    assert t._status.idleLongestAt == t0 + 1.0

    # 10s in: the open stretch is now the longest, stamped at ITS start.
    TaskEngine._refresh_idle_status(t, t0 + 15.0)
    assert t._status.idleSeconds == 12.0
    assert t._status.idleLongestSeconds == 10.0
    assert t._status.idleLongestAt == t0 + 5.0

    # The provisional publishes never double-count: closing the gap at the
    # next begin lands on the same numbers a fresh reader would compute.
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['c'], {'eventTime': t0 + 20.0, 'logSeq': 3})
    assert t._status.idleSeconds == 17.0
    assert t._status.idleLongestSeconds == 15.0
    assert t._status.idleLongestAt == t0 + 5.0

    # While busy, refresh republishes the closed totals unchanged.
    TaskEngine._refresh_idle_status(t, t0 + 60.0)
    assert t._status.idleSeconds == 17.0


def test_analytics_idle_reset():
    """_reset_status clears the pipe-unused counters with the rest."""
    t = _analytics_task()
    t._status_trace = []
    t.info = {}
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['a'], {'eventTime': 1.0, 'logSeq': 1})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': 2.0})
    TaskEngine._accumulate_analytics(t, 'begin', 0, 'p', ['b'], {'eventTime': 5.0, 'logSeq': 2})
    TaskEngine._accumulate_analytics(t, 'end', 0, 'p', [], {'eventTime': 6.0})
    assert t._status.idleSeconds == 3.0 and t._an_idle_since == 6.0

    TaskEngine._reset_status(t)
    assert t._status.idleSeconds == 0.0
    assert t._status.idleLongestSeconds == 0.0
    assert t._status.idleLongestAt == 0.0
    assert t._an_idle_total == 0.0 and t._an_idle_since == 0.0


# ---------------------------------------------------------------------------
# cap_trace_payload — the 1MB trace/flow payload clamp
# ---------------------------------------------------------------------------


def test_task_rejects_unknown_run_classifications():
    """run_kind/trigger are a CLOSED vocabulary, validated at construction.

    Both gate storage anchors, run-log scoping, and run ownership — a
    value outside the vocabulary must fail before it can pick a scope.
    ('' trigger is the interactive-dev spelling and stays valid.)
    """
    from unittest.mock import MagicMock

    common = dict(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        engine_key='enginehash:u-1',
        address='acme.p-1.s-1',
        pipeline={},
    )
    with pytest.raises(ValueError, match='run_kind'):
        TaskEngine(**common, run_kind='prod')
    with pytest.raises(ValueError, match='trigger'):
        TaskEngine(**common, trigger='cron')


@pytest.mark.asyncio
async def test_task_loads_nothing_for_a_pipeline_without_placeholders():
    """No ROCKETRIDE_* placeholder, no load: other ${...} are redacted anyway."""
    from unittest.mock import MagicMock

    source = AsyncMock(return_value={'ROCKETRIDE_KEY': 'v'})
    task = TaskEngine(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        engine_key='enginehash:u-1',
        address='acme.p-1.s-1',
        pipeline={},
        env_source=source,
    )

    assert (await task._resolve_pipeline({'config': 'plain', 'other': '${HOME}'})) == {
        'config': 'plain',
        'other': '<REDACTED>',
    }
    source.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_stop_during_the_first_start_load_ends_the_start(monkeypatch):
    """A stop that lands while start_task loads the placeholder values finds no
    process yet; the start then ends through _terminated() instead of
    launching the engine.
    """
    import ai.modules.task.task_engine as engine

    _fake_db_account(monkeypatch)
    t = _env_task(pipeline={'components': [{'id': 'src', 'provider': 'tools', 'config': {'k': '${ROCKETRIDE_KEY}'}}]})
    t.source = 'src'

    async def load_while_stopping():
        t._stop_reason = 'user'  # what stop_task records when it arrives now
        return {'ROCKETRIDE_KEY': 'v'}

    t._env_source = load_while_stopping
    t._status = SimpleNamespace(name='', state=engine.TASK_STATE.NONE.value, exitMessage='', completed=False)
    t._launch_args = {}
    t._server = MagicMock(_config={})
    t._is_debugging = lambda: False
    t._write_task_file = AsyncMock(return_value='/tmp/task.json')
    t._send_status_update = AsyncMock()
    t._terminated = AsyncMock()
    spawn = AsyncMock()
    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', spawn)

    with pytest.raises(RuntimeError, match='stopped before it started'):
        await TaskEngine.start_task(t)
    spawn.assert_not_awaited()
    t._terminated.assert_awaited()


@pytest.mark.asyncio
async def test_task_loads_placeholder_values_at_each_resolve():
    """A Task given an env_source calls it every time it resolves the pipeline
    and keeps no copy of the values; a plain env dict still works.
    """
    from unittest.mock import MagicMock

    common = dict(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        engine_key='enginehash:u-1',
        address='acme.p-1.s-1',
        pipeline={},
    )
    source = AsyncMock(side_effect=[{'ROCKETRIDE_KEY': 'v1'}, {'ROCKETRIDE_KEY': 'v2'}])
    task = TaskEngine(**common, env_source=source)
    pipeline = {'config': '${ROCKETRIDE_KEY}'}

    assert (await task._resolve_pipeline(pipeline))['config'] == 'v1'
    assert (await task._resolve_pipeline(pipeline))['config'] == 'v2'
    assert source.await_count == 2
    assert not hasattr(task, '_env')

    fixed = TaskEngine(**common, env={'ROCKETRIDE_KEY': 'fixed'})
    assert (await fixed._resolve_pipeline(pipeline))['config'] == 'fixed'


def test_cap_trace_payload_passes_small_payloads_through():
    """Payloads under the cap pass through IDENTICALLY (same object)."""
    payload = {'op': 'x', 'data': 'y' * 1000}
    assert cap_trace_payload(payload) is payload
    # Falsy payloads are untouched too (no marker for nothing).
    assert cap_trace_payload({}) == {}
    assert cap_trace_payload(None) is None


def test_cap_trace_payload_truncates_oversized_payloads():
    """An over-cap payload becomes the honest marker with a bounded preview."""
    blob = {'data': 'z' * (CONST_TRACE_PAYLOAD_CAP + 100)}
    capped = cap_trace_payload(blob)
    assert capped['truncated'] is True
    assert capped['originalBytes'] > CONST_TRACE_PAYLOAD_CAP
    assert len(capped['preview']) == CONST_TRACE_PREVIEW_BYTES
    # The marker CLIPS to the cap — consumers still get (just under) the
    # full megabyte, and the marker never exceeds the cap itself.
    import json as _json

    assert len(_json.dumps(capped)) <= CONST_TRACE_PAYLOAD_CAP


def test_cap_trace_payload_bound_holds_for_escape_heavy_payloads():
    """The cap must hold for the marker AS SERIALIZED, not the raw slice.

    `preview` holds already-serialized JSON text; re-serializing escapes
    every quote and backslash in it, so an object-heavy payload (unlike the
    plain-'z' fixture above, which needs no escaping) inflates the marker.
    The clamp must size the SERIALIZED marker under the cap.
    """
    import json as _json

    # Thousands of tiny dicts full of quotes and backslashes — every one
    # of the preview's structural characters re-escapes on serialization.
    blob = {'data': [{'k': 'v"\\'}] * (CONST_TRACE_PAYLOAD_CAP // 12)}
    assert len(_json.dumps(blob)) > CONST_TRACE_PAYLOAD_CAP
    capped = cap_trace_payload(blob)
    assert capped['truncated'] is True
    assert len(_json.dumps(capped)) <= CONST_TRACE_PAYLOAD_CAP
    # The trimmed preview still carries real content, not an empty husk.
    assert len(capped['preview']) > CONST_TRACE_PAYLOAD_CAP // 4


def test_cap_trace_payload_leaves_unserializable_payloads_alone():
    """Unserializable payloads pass through — the transport owns that error."""
    payload = {'bad': object()}
    assert cap_trace_payload(payload) is payload


# ---------------------------------------------------------------------------
# on_event: pipeline activity
# ---------------------------------------------------------------------------


def _event_task(run_kind='dev'):
    """A Task wired far enough to run on_event, with the handlers stubbed."""
    from unittest.mock import AsyncMock

    t = _task()
    t._run_kind = run_kind
    t._last_pipeline_event = 0.0
    t._status_trace = []
    # The trace branch walks the per-pipe execution stack before anything else.
    t._status.pipeflow = SimpleNamespace(byPipe={})
    t._update_status = MagicMock()
    t._forward_task_event = AsyncMock()
    t._send_status_update = AsyncMock()
    # No stop was requested: an exit the engine reports is the run's own
    t._stop_reason = None
    return t


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'event_type',
    [
        'apaevt_status_counts',
        'apaevt_status_object',
        'apaevt_status_message',
        'apaevt_status_metrics',
        'apaevt_sse',
        'apaevt_trace',
    ],
)
async def test_on_event_engine_event_records_pipeline_activity_for_a_dev_task(event_type):
    """Pipeline work is activity: a dev task mid-turn is not idle (its controls read the stamp)."""
    t = _event_task()

    await TaskEngine.on_event(t, {'event': event_type, 'body': {}})

    assert t._last_pipeline_event > 0.0


@pytest.mark.asyncio
async def test_readiness_keeps_the_notes_the_nodes_published():
    """Readiness never touches the notes slot. A database node announces its
    Explore button once, possibly before the source reports ready (plan 3.6),
    so the keyed note merged before `service=True` must survive it; the
    source's unkeyed door follows the same rule (readiness is not a writer of
    notes at all). Only a run reset and a source's empty usr message clear.
    """
    t = _event_task()
    t._task_metrics = None
    t._channel_startup_open = True
    t._confirm_running = MagicMock()
    door = {'url-link': '{host}/webhook/{address}', 'address': '{address}'}
    explore = {'open-tool': 'rocketride.sql', 'nodeId': 'postgres_1', 'address': '{address}'}
    t._status.notes = [door, explore]

    await TaskEngine.on_event(t, {'event': 'apaevt_status_state', 'body': {'service': True}})
    assert t._status.notes == [door, explore]
    assert t._status.serviceUp is True and t._confirm_running.called
    await TaskEngine.on_event(t, {'event': 'apaevt_status_state', 'body': {'service': False}})
    assert t._status.notes == [door, explore]
    # The two clearing paths
    assert merge_status_notes([door, explore], []) == []
    TaskEngine._reset_status(t)
    assert t._status.notes == []


@pytest.mark.asyncio
async def test_on_event_stdout_does_not_count_as_activity():
    """Raw node output must not count as idle-timer activity."""
    t = _event_task()

    await TaskEngine.on_event(t, {'event': 'output', 'body': {'output': 'still here'}})

    assert t._last_pipeline_event == 0.0


@pytest.mark.asyncio
async def test_on_event_debugger_passthrough_does_not_count_as_activity():
    """Debugger traffic is not pipeline work and its cadence is not ours to reason about."""
    t = _event_task()

    await TaskEngine.on_event(t, {'event': 'stopped', 'body': {}})

    assert t._last_pipeline_event == 0.0


@pytest.mark.asyncio
@pytest.mark.parametrize('event_type', ['apaevt_status_counts', 'apaevt_sse', 'apaevt_trace'])
async def test_on_event_never_counts_as_activity_for_a_deploy_run(event_type):
    """A deploy run's ttl is a wall-clock window, not an idle timeout."""
    t = _event_task(run_kind='deploy')

    await TaskEngine.on_event(t, {'event': event_type, 'body': {}})

    assert t._last_pipeline_event == 0.0


@pytest.mark.asyncio
async def test_on_event_exit_reads_the_key_the_emitters_write():
    """A clean exit must record code 0, not the fallback."""
    t = _event_task()
    t._status.exitCode = None
    t._status.exitMessage = ''
    t._status.state = 0
    t._update_completion_status = MagicMock()
    t._close_run_log = MagicMock()

    await TaskEngine.on_event(t, {'event': 'apaevt_exit', 'body': {'exitCode': 0, 'message': 'COMPLETED'}})

    assert t._status.exitCode == 0
    assert t._status.exitMessage == 'COMPLETED'


@pytest.mark.asyncio
async def test_on_event_exit_still_defaults_when_no_code_is_sent():
    """A malformed exit with no code keeps the pessimistic default."""
    t = _event_task()
    t._status.exitCode = None
    t._status.exitMessage = ''
    t._status.state = 0
    t._update_completion_status = MagicMock()
    t._close_run_log = MagicMock()

    await TaskEngine.on_event(t, {'event': 'apaevt_exit', 'body': {'message': 'Malformed exit message'}})

    assert t._status.exitCode == 1


# ---------------------------------------------------------------------------
# on_event / apaevt_trace — the trace level that means "no traces"
# ---------------------------------------------------------------------------


def _trace_task(level):
    """A task ready to take one apaevt_trace, with the fan-out captured."""
    from unittest.mock import AsyncMock

    from rocketride import TASK_STATUS

    t = _task(status=TASK_STATUS())
    t._last_event_time = 0.0
    t._status_updated = False
    t._pipelineTraceLevel = level
    t.build_event = MagicMock(
        side_effect=lambda name, body=None, event_time=None: {
            'event': name,
            'body': dict(body or {}, eventTime=event_time),
        }
    )
    t._accumulate_analytics = MagicMock()
    t._forward_task_event = AsyncMock()
    return t


_TRACE_MESSAGE = {
    'event': 'apaevt_trace',
    'body': {
        'op': 'enter',
        'pipeId': 0,
        'componentId': 'parse',
        'traceId': 7,
        'trace': {'text': 'hello'},
        'eventTime': 1_000.0,
    },
}


@pytest.mark.asyncio
@pytest.mark.parametrize('level', ['metadata', 'summary', 'full'])
async def test_a_real_trace_level_still_derives_a_flow_event(level):
    """The levels that ask for tracing keep every part of the fan-out."""
    t = _trace_task(level)

    await TaskEngine.on_event(t, dict(_TRACE_MESSAGE))

    t._forward_task_event.assert_awaited_once()
    t._accumulate_analytics.assert_called_once()
    assert t.build_event.call_args.kwargs['body']['trace'] == {'text': 'hello'}


@pytest.mark.asyncio
async def test_an_sse_event_leaves_with_the_wire_trace_id():
    """The engine's bare counter becomes `{nodeId}.{engineId}.{traceId}` where the event leaves the task process (plan 7.4)."""
    t = _trace_task('full')
    t.engine_id = 4
    t._forward_task_event = TaskEngine._forward_task_event.__get__(t)  # the real forwarder stamps the body
    t._server.broadcast_task_event = AsyncMock()
    t._holds = {'dev.user-1.acme.proj-test.src-id': 900}
    t._run_logs = {}
    t._run_log_open_lock = asyncio.Lock()
    t._run_log_failed = set()
    message = {'event': 'apaevt_sse', 'body': {'pipeId': 0, 'traceId': 7, 'type': 'thinking', 'data': {}}}

    await TaskEngine.on_event(t, message)

    sent = t._server.broadcast_task_event.await_args.kwargs['event']
    assert sent['body']['traceId'] == '1.4.7'
    assert sent['body']['engineKey'] == 'enginehash:user-1'


@pytest.mark.asyncio
@pytest.mark.parametrize('level', ['none', '', None])
async def test_a_trace_derives_a_flow_whatever_the_engine_default_level(level):
    """
    The engine emits >DBG per BINDING at the binding's own trace level (plan
    7.4): a trace that arrives here was asked for by its binding, so the
    engine's default level (`none` for a shared engine, absent on an old task
    file) no longer gates the flow derivation. A holder tracing FULL on an
    engine whose default is `none` sees its flow.
    """
    t = _trace_task(level)
    await TaskEngine.on_event(t, dict(_TRACE_MESSAGE))
    t._forward_task_event.assert_awaited_once()
    t._accumulate_analytics.assert_called_once()
    assert t.build_event.call_args.kwargs['body']['trace'] == {'text': 'hello'}
    assert t._status_updated is True
    assert t._status.pipeflow.byPipe == {0: ['parse']}


@pytest.mark.asyncio
async def test_a_trace_never_sets_the_engine_wide_pipe_count():
    """
    The engine does not report its pipe count: a holder of a shared engine
    must not learn it (a holder count in disguise). pipeflow.totalPipes stays
    on the contract at its default 0, even if a body still carried the field.
    """
    t = _trace_task('full')

    await TaskEngine.on_event(t, {**_TRACE_MESSAGE, 'body': {**_TRACE_MESSAGE['body'], 'totalPipes': 5}})

    assert t._status.pipeflow.totalPipes == 0


# ---------------------------------------------------------------------------
# saas_pipeline_violation — what a hosted engine refuses to launch
# ---------------------------------------------------------------------------

_SERVICES = {
    'mcp_client': {'capabilities': ['invoke'], 'path': 'nodes.tool_mcp_client'},
    'tool_butterbase': {'capabilities': ['invoke'], 'path': 'nodes.tool_mcp_client'},
    'filesys': {'capabilities': ['filesystem', 'noremote', 'security', 'nosaas'], 'path': 'nodes.filesys'},
    'llm_openai': {'capabilities': ['invoke'], 'path': 'nodes.llm_openai'},
}
_DEFAULT_TRANSPORT = {'mcp_client': 'stdio', 'tool_butterbase': 'streamable-http'}


def _get_service(provider):
    """Stand-in for rocketlib.getServiceDefinition, which is case-insensitive."""
    return _SERVICES.get(provider.lower())


def _mcp_node_config(provider, config):
    """Stand-in for resolve_node_config: schema defaults under the component config.

    Like the resolver, a key the schema does not declare is a ConfigError.
    """
    from rocketlib import ConfigError

    defaults = {'transport': _DEFAULT_TRANSPORT[provider.lower()], 'commandLine': ''}
    unknown = sorted(set(config) - set(defaults))
    if unknown:
        raise ConfigError(f'unknown config key "{unknown[0]}"')
    return {**defaults, **{k: v for k, v in config.items() if v is not None}}


def _violation(*components):
    return saas_pipeline_violation({'components': list(components)}, _get_service, _mcp_node_config)


def test_saas_gate_allows_ordinary_nodes_and_http_mcp():
    assert _violation({'id': 'a', 'provider': 'llm_openai'}) is None
    assert _violation({'id': 'm', 'provider': 'mcp_client', 'config': {'transport': 'streamable-http'}}) is None
    assert _violation({'id': 'm', 'provider': 'mcp_client', 'config': {'transport': 'sse'}}) is None
    assert _violation({'id': 'b', 'provider': 'tool_butterbase', 'config': {}}) is None  # HTTP by default


def test_saas_gate_refuses_nosaas_nodes():
    assert 'not available on RocketRide Cloud' in _violation({'id': 'f', 'provider': 'filesys'})


@pytest.mark.parametrize(
    'config',
    [
        {},  # the schema default is stdio
        {'transport': 'stdio'},
        {'transport': 'STDIO '},
        {'transport': None},  # unset means the default, which is stdio
        {'profile': 'sse'},  # the old profile shape is an unknown key: unresolvable -> refused
    ],
)
def test_saas_gate_refuses_stdio_mcp(config):
    problem = _violation(
        {'id': 'm', 'provider': 'llm_openai'}, {'id': 'm2', 'provider': 'mcp_client', 'config': config}
    )
    assert problem and 'stdio MCP transport' in problem


@pytest.mark.parametrize(
    'component',
    [
        # another service built on the MCP client node, switched to stdio
        {'id': 'b', 'provider': 'tool_butterbase', 'config': {'transport': 'stdio', 'commandLine': 'x'}},
        # provider lookup is case-insensitive, so this is the MCP client with its stdio default
        {'id': 'c', 'provider': 'MCP_Client', 'config': {}},
    ],
)
def test_saas_gate_matches_the_node_not_the_provider_name(component):
    problem = _violation(component)
    assert problem and 'stdio MCP transport' in problem


def test_saas_gate_sees_a_nosaas_node_that_only_eaas_serves(monkeypatch):
    """A node EaaS serves is not in the engine's registry; the hosted gate
    still reads its capabilities and refuses it.
    """
    import rocketlib

    import ai.modules.task.task_engine as engine

    monkeypatch.setattr(engine, '_is_saas_engine', lambda: True)
    monkeypatch.setattr(rocketlib, 'getServiceDefinition', lambda provider: None)
    pipeline = {'components': [{'id': 'src', 'provider': 'text_output'}]}

    # Unknown to both: nothing to refuse on (the engine's own validation names an unknown provider)
    monkeypatch.setattr(engine.node_store, '_definitions', {})
    assert engine.hosted_refusal(pipeline) is None

    monkeypatch.setattr(engine.node_store, '_definitions', {'text_output': {'capabilities': ['nosaas']}})
    refusal = engine.hosted_refusal(pipeline)
    assert refusal and 'not available on RocketRide Cloud' in refusal


def test_saas_gate_off_the_engine_host_allows_stdio_mcp_but_not_nosaas():
    def violation(component):
        return saas_pipeline_violation({'components': [component]}, _get_service, _mcp_node_config, shared_host=False)

    assert violation({'id': 'm', 'provider': 'mcp_client', 'config': {'transport': 'stdio'}}) is None
    assert 'not available on RocketRide Cloud' in violation({'id': 'f', 'provider': 'filesys'})


# ---------------------------------------------------------------------------
# Exit code when the task sends no >EXIT event
# ---------------------------------------------------------------------------


def _exit_task(exit_event_seen=False):
    from rocketride import TASK_STATUS

    t = _task(status=TASK_STATUS())  # a first run: exitCode starts at 0
    t._exit_event_seen = exit_event_seen
    t._stop_reason = None
    t._crash = None
    t._process_killed = False
    return t


def test_process_exit_code_used_when_no_exit_event():
    """A task that exits before it can report (a refusal) is not recorded as exit 0."""
    t = _exit_task()
    TaskEngine._apply_process_exit_code(t, 1)
    assert t._status.exitCode == 1
    assert t._status.exitMessage == 'Stopped'


def test_exit_event_wins_over_process_exit_code():
    t = _exit_task(exit_event_seen=True)
    t._status.exitMessage = 'Completed'
    TaskEngine._apply_process_exit_code(t, 1)
    assert (t._status.exitCode, t._status.exitMessage) == (0, 'Completed')


def test_requested_stop_keeps_its_exit_code():
    """The kill signal of a user stop is not a task failure (no dashboard task_error)."""
    t = _exit_task()
    t._stop_reason = 'user'
    TaskEngine._apply_process_exit_code(t, -9)
    assert t._status.exitCode == 0


def test_unknown_process_exit_code_is_not_success():
    """The process did not exit in time: that is not a completed task."""
    t = _exit_task()
    TaskEngine._apply_process_exit_code(t, None)
    assert t._status.exitCode == 1


@pytest.mark.asyncio
async def test_exit_event_marks_the_run_as_reported():
    t = _exit_task()
    await TaskEngine.on_event(t, {'type': 'event', 'event': 'apaevt_exit', 'body': {'exitCode': 3, 'message': 'boom'}})
    assert t._exit_event_seen is True
    assert (t._status.exitCode, t._status.exitMessage) == (3, 'boom')


def test_a_new_run_starts_from_exit_code_zero():
    """A run started again after an error: a stop by the server, which keeps the code, must not read the old one."""
    t = _analytics_task()
    t._status_trace = []
    t.info = {}
    t._status.exitCode = 3
    t._status.exitMessage = 'boom'
    TaskEngine._reset_status(t)
    assert (t._status.exitCode, t._status.exitMessage) == (0, '')


class _ExitingProcess:
    """A subprocess whose output has closed but which is not reaped until wait()."""

    def __init__(self, code):
        self.returncode = None
        self._code = code

    async def wait(self):
        self.returncode = self._code
        return self._code


@pytest.mark.asyncio
async def test_exit_code_is_read_after_the_process_is_reaped():
    t = _exit_task()
    t._engine_process = _ExitingProcess(1)
    assert await TaskEngine._process_exit_code(t) == 1


@pytest.mark.asyncio
async def test_no_process_counts_as_failed():
    t = _exit_task()
    t._engine_process = None
    assert await TaskEngine._process_exit_code(t) == 1


class _LingeringProcess:
    """Output closed, but the process only exits once it is killed."""

    def __init__(self):
        self.returncode = None
        self.killed = False

    async def wait(self):
        if not self.killed:
            await asyncio.sleep(3600)
        self.returncode = -9
        return -9

    def kill(self):
        self.killed = True


@pytest.mark.asyncio
async def test_a_process_that_does_not_exit_is_killed_and_reaped(monkeypatch):
    import ai.modules.task.task_engine as te

    monkeypatch.setattr(te, 'CONST_CANCEL_WAIT_TIMEOUT_SECONDS', 0.05)
    t = _exit_task()
    t._engine_process = _LingeringProcess()
    assert await TaskEngine._process_exit_code(t) == -9
    assert t._engine_process.killed

    # The server's own kill is not a crash
    TaskEngine._apply_process_exit_code(t, -9)
    assert t._crash is None


# ---------------------------------------------------------------------------
# A crash the engine reported with >EXIT*Crash
# ---------------------------------------------------------------------------

_SEGV = {'exitCode': 1, 'message': 'Application received system signal: SIGSEGV', 'crash': True}


def _ending_task(process_exit_code, *, was_running=True):
    """An engine whose output has closed, for running the real _terminated()."""
    t = _exit_task()
    t._terminated_called = False
    t._teardown_done = asyncio.Event()
    t._is_terminating = False
    t.state = EngineState.RUNNING if was_running else EngineState.STARTING
    t._debug_stdio = t._data_client = t._task_metrics = t._tmpfile = t._data_port = None
    t._status_update_task = None
    t._final_events_sent = True
    t._stop_reason = None
    t._run_trigger = None
    t._bindings = {}
    t.files = None
    t._server.engine_crashed = MagicMock()
    t._send_status_update = AsyncMock()
    t._forward_task_event = AsyncMock()
    t._process_exit_code = AsyncMock(return_value=process_exit_code)
    return t


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'stop_reason, status, exit_code, exit_message, outcome',
    [
        (None, 'Stopped unexpectedly', 1, 'Stopped unexpectedly', 'error'),
        # A crash during a requested stop is part of the stop
        ('user', 'Stopped', 0, '', 'cancelled'),
    ],
)
async def test_a_reported_crash_ends_the_task(stop_reason, status, exit_code, exit_message, outcome):
    t = _ending_task(-6)
    t._stop_reason = stop_reason
    run_log = AsyncMock()
    # Two holding controls on one continuum: it completes once
    t._run_logs = {'dev.user-1.acme.proj-test.src-id': run_log, 'dev.user-2.acme.proj-test.src-id': run_log}
    await TaskEngine.on_event(t, {'type': 'event', 'event': 'apaevt_exit', 'body': dict(_SEGV)})
    await TaskEngine._terminated(t)
    assert (t._status.status, t._status.exitCode, t._status.exitMessage) == (status, exit_code, exit_message)
    run_log.end_run.assert_awaited_once()
    assert run_log.end_run.await_args.args[0] == outcome


@pytest.mark.asyncio
async def test_a_crash_after_running_leaves_the_holders_dormant():
    """A reported crash takes the same path as any abnormal exit: the engine is dormant and its holders restart it (plan 7.2)."""
    t = _ending_task(-6)
    await TaskEngine.on_event(t, {'type': 'event', 'event': 'apaevt_exit', 'body': dict(_SEGV)})
    await TaskEngine._terminated(t)
    assert t._status.status == 'Stopped unexpectedly'
    assert t._status.state == TASK_STATE.CANCELLED.value
    assert t.state is EngineState.STOPPED
    assert t.dormant_reason == 'crash'
    t._server.engine_crashed.assert_called_once_with(t)


@pytest.mark.asyncio
async def test_a_crash_before_running_is_a_failed_start():
    """An engine that crashed before it confirmed running failed its start and is not retried."""
    t = _ending_task(-6, was_running=False)
    await TaskEngine.on_event(t, {'type': 'event', 'event': 'apaevt_exit', 'body': dict(_SEGV)})
    await TaskEngine._terminated(t)
    assert t._status.status == 'Stopped unexpectedly'
    assert t.state is EngineState.FAILED
    assert t.dormant_reason is None
    t._server.engine_crashed.assert_not_called()


@pytest.mark.asyncio
async def test_a_crash_the_engine_did_not_report_reaches_the_console():
    """A process ended by a crash signal with no >EXIT gets its console line from the server, through the engine-level route."""
    import signal as signal_module

    t = _ending_task(-int(signal_module.SIGSEGV))
    await TaskEngine._terminated(t)
    assert t._status.status == 'Stopped unexpectedly'
    outputs = [
        call.args[1]['body']['output']
        for call in t._forward_task_event.await_args_list
        if call.args[1].get('event') == 'output'
    ]
    assert outputs == [f'Unexpected termination: SIGSEGV (code {int(signal_module.SIGSEGV)})\n']


# ---------------------------------------------------------------------------
# TaskData — the engine's data channel to the task
# ---------------------------------------------------------------------------


class _SilentTransport:
    """A connected transport that accepts every message and never answers."""

    def bind(self, **callbacks):
        """Accept the client's callbacks; the test drives them directly.

        Args:
            **callbacks: Handlers a real transport would call.
        """

    def is_connected(self):
        """Report the transport as open so requests are sent.

        Returns:
            bool: Always True.
        """
        return True

    async def send(self, message):
        """Swallow the message.

        Args:
            message: The DAP message that will never be answered.
        """

    def disconnect(self):
        """Nothing to close."""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'reason, expected',
    [
        ('task exited', 'task exited'),
        (None, 'Task data connection closed'),
    ],
)
async def test_data_channel_disconnect_fails_pending_requests(reason, expected):
    """A request waiting on the data channel fails when the channel closes, instead of waiting forever."""
    parent = _task()
    client = TaskEngine.TaskData(parent_task=parent, channel_id='c1', module='DATA-test', transport=_SilentTransport())
    parent._data_client = client

    pending = asyncio.ensure_future(client.dap_request(command='rrext_process', arguments={'subcommand': 'open'}))
    await asyncio.sleep(0)
    assert client._pending_requests

    await client.on_disconnected(reason, has_error=True)

    with pytest.raises(ConnectionError, match=expected):
        await asyncio.wait_for(pending, timeout=1)
    assert parent._data_client is None


# ---------------------------------------------------------------------------
# The data-channel token
# ---------------------------------------------------------------------------


class _LaunchStop(Exception):
    """Raised by a stubbed launch step to end start_task early."""


def _startable_task(monkeypatch):
    """Build a Task that start_task can drive up to the subprocess launch.

    The launch itself is stubbed: ``create_subprocess_exec`` records its
    arguments and raises ``_LaunchStop``, so no process starts.

    Args:
        monkeypatch: pytest fixture.

    Returns:
        tuple: ``(task, launches)`` — ``launches`` collects ``(argv, env)``.
    """
    from ai.modules.task import task_engine

    t = _task()
    t._status = SimpleNamespace(state=TASK_STATE.NONE.value, completed=False, startTime=None)
    t._launch_args = {}
    t._resolve_pipeline = AsyncMock(return_value={'components': []})
    t._check_pipeline = MagicMock()
    t._write_task_file = AsyncMock(return_value='/tmp/task-1.json')
    t._is_debugging = MagicMock(return_value=False)
    t._send_status_update = AsyncMock()
    t._build_subprocess_env = AsyncMock(return_value={'PATH': '/usr/bin'})
    t._terminated = AsyncMock()
    t._server = SimpleNamespace(
        assign_port=MagicMock(return_value=20001), _config={}, next_engine_id=lambda: 1, node_id=1
    )

    launches = []

    async def fake_exec(*argv, env=None, **kwargs):
        """Record the launch and stop it before any process starts."""
        launches.append((argv, env))
        raise _LaunchStop()

    monkeypatch.setattr(task_engine.asyncio, 'create_subprocess_exec', fake_exec)
    return t, launches


async def test_start_task_mints_a_fresh_token_for_every_start(monkeypatch):
    """Every start gets its own token, separate from the engine key."""
    t, _ = _startable_task(monkeypatch)
    tokens = []

    for _ in range(2):
        t._status.state = TASK_STATE.NONE.value
        with pytest.raises(_LaunchStop):
            await TaskEngine.start_task(t)
        tokens.append(t._data_token)

    assert all(len(token) >= 32 for token in tokens)
    assert tokens[0] != tokens[1]
    assert t.engine_key not in tokens


async def test_start_task_passes_only_the_token_hash_ahead_of_pipeline_args(monkeypatch):
    """The token's SHA-256 goes on argv before any pipeline arg; the token is in neither argv nor env."""
    t, launches = _startable_task(monkeypatch)
    t._launch_args = {'args': [f'--data_token_sha256={"b" * 64}']}

    with pytest.raises(_LaunchStop):
        await TaskEngine.start_task(t)

    ((argv, env),) = launches
    expected = f'--data_token_sha256={hashlib.sha256(t._data_token.encode("utf-8")).hexdigest()}'
    assert [arg for arg in argv if arg.startswith('--data_token_sha256')][0] == expected
    assert not any(t._data_token in arg for arg in argv)
    assert not any(t._data_token in value for value in env.values())


async def test_data_connection_presents_the_token(monkeypatch):
    """The parent dials /task/data with its run's token on the handshake."""
    from ai.modules.task import task_engine

    transports = []

    def fake_transport(uri, **kwargs):
        """Record the URI and the handshake options; hand back a stand-in transport."""
        transports.append((uri, kwargs))
        return MagicMock(name='transport')

    client = MagicMock(name='data-client')
    client.connect = AsyncMock()
    client.dap_request = AsyncMock(return_value={'success': True})
    client.did_fail = MagicMock(return_value=False)

    monkeypatch.setattr(task_engine, 'TransportWebSocket', fake_transport)
    monkeypatch.setattr(TaskEngine, 'TaskData', MagicMock(return_value=client))

    t = _task()
    t._is_terminating = False
    t._data_lock = asyncio.Lock()
    t._data_client = None
    t._data_port = 20001
    t._data_token = 'run-token'
    t._engine_process = None
    t._provider = None

    await TaskEngine._send_data(t, {'command': 'apaext_process', 'arguments': {}})

    ((uri, kwargs),) = transports
    assert uri == 'ws://127.0.0.1:20001/task/data'
    assert kwargs['headers']['Authorization'] == 'Bearer run-token'
    assert kwargs['headers']['X-Channel-Id']


async def test_data_request_without_a_token_fails_at_once(monkeypatch):
    """A request that outlived the run fails clearly, with no retries and no ``Bearer None``."""
    from ai.modules.task import task_engine

    transport = MagicMock(name='TransportWebSocket')
    monkeypatch.setattr(task_engine, 'TransportWebSocket', transport)

    t = _task()
    t._is_terminating = False
    t._data_lock = asyncio.Lock()
    t._data_client = None
    t._data_port = None
    t._data_token = None
    t._engine_process = None

    with pytest.raises(RuntimeError, match='not running'):
        await TaskEngine._send_data(t, {'command': 'apaext_process', 'arguments': {}})

    transport.assert_not_called()


# ---------------------------------------------------------------------------
# _terminated / wait_terminated
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wait_terminated_returns_once_teardown_finishes():
    """wait_terminated() releases after the teardown, and only once it ran."""
    t = _task()
    t._terminated_called = False
    t._teardown_done = asyncio.Event()
    t._teardown = AsyncMock()

    waiter = asyncio.ensure_future(t.wait_terminated())
    await asyncio.sleep(0)
    assert not waiter.done()

    await t._terminated()
    await asyncio.wait_for(waiter, timeout=1)
    t._teardown.assert_awaited_once()


@pytest.mark.asyncio
async def test_wait_terminated_releases_when_teardown_raises():
    """A failing teardown step still releases the waiters."""
    t = _task()
    t._terminated_called = False
    t._teardown_done = asyncio.Event()
    t._teardown = AsyncMock(side_effect=RuntimeError('teardown failed'))

    with pytest.raises(RuntimeError):
        await t._terminated()
    await asyncio.wait_for(t.wait_terminated(), timeout=1)


async def test_start_task_retries_a_run_log_open_that_failed_in_the_previous_run(monkeypatch):
    """A failed writer open is suppressed for ITS run only: the next launch of the engine tries again."""
    t, _ = _startable_task(monkeypatch)
    t._run_log_failed = {'dev.user-1.acme.docBrain.webhook_1'}

    with pytest.raises(_LaunchStop):
        await TaskEngine.start_task(t)

    assert t._run_log_failed == set()


async def test_start_task_clears_the_previous_runs_crash_state(monkeypatch):
    """A crash and a kill by the server belong to the run they happened in: the next launch starts without them.

    A relaunch reuses the engine object. A crash left on it would refuse the next run its `Completed`
    and record `error`; a kill flag left on it would hide the next run's own crash.
    """
    t, _ = _startable_task(monkeypatch)
    t._crash = 'SIGSEGV (code 11)'
    t._process_killed = True

    with pytest.raises(_LaunchStop):
        await TaskEngine.start_task(t)

    assert t._crash is None
    assert t._process_killed is False
