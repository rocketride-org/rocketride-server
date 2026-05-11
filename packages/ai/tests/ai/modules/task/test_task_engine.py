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

    t = _task(
        pipeline={
            'version': 2,
            'source': 'src',
            'project_id': 'proj-1',
            'name': 'my-pipeline',
            'description': 'desc',
            'components': [{'id': 'src'}],
        },
    )

    config = Task._build_task(t)

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

    t = _task(pipeline={'source': 'src', 'components': []})
    config = Task._build_task(t)
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
