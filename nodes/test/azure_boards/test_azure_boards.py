# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Azure Boards source node's engine glue (no network).

Stubs the engine-only modules (rocketlib, depends, ai.common.schema) that
IEndpoint.py imports through the nodes.azure_boards package __init__. The
REST/pagination logic lives in azure_boards_client.py and is covered
separately in test_client.py (no engine, no stubbing needed there).
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

try:
    import bs4  # noqa: F401

    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

# _emit_work_item calls the real build_doc_fields (which needs bs4 only when
# a description is present) on real work items in several tests below — skip
# only the ones that actually exercise HTML stripping.
requires_bs4 = pytest.mark.skipif(not _HAS_BS4, reason='bs4 not installed')

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


class _FakeDocMetadata:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _FakeDoc:
    def __init__(self, page_content=None, metadata=None):
        self.page_content = page_content
        self.metadata = metadata


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IEndpointBase = object
    rocketlib.IGlobalBase = object
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.getObject = MagicMock(side_effect=lambda obj: MagicMock(**obj))
    rocketlib.monitorStatus = MagicMock()
    rocketlib.monitorCompleted = MagicMock()
    rocketlib.monitorFailed = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_schema = MagicMock()
    ai_common_schema.Doc = _FakeDoc
    ai_common_schema.DocMetadata = _FakeDocMetadata

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.schema': ai_common_schema,
    }


_stubs = _build_import_stubs()
_added_stubs = []
for _name, _stub in _stubs.items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

try:
    endpoint_mod = importlib.import_module('nodes.azure_boards.IEndpoint')
finally:
    for _name in _added_stubs:
        sys.modules.pop(_name, None)

IEndpoint = endpoint_mod.IEndpoint


def _make_endpoint(config: dict) -> IEndpoint:
    """Build an IEndpoint without running __init__ (which needs a real engine)."""
    ep = IEndpoint.__new__(IEndpoint)
    ep.endpoint = MagicMock()
    ep.endpoint.serviceConfig = {'parameters': config}
    ep.target = MagicMock()
    return ep


_BASE_CONFIG = {
    'organization': 'myorg',
    'project': 'myproj',
    'personalAccessToken': 'tok',
    'wiql': 'SELECT [System.Id] FROM WorkItems',
}


# ---------------------------------------------------------------------------
# _run: config validation guard + pagination-error containment
# ---------------------------------------------------------------------------


def test_run_bails_out_when_config_incomplete(monkeypatch):
    ep = _make_endpoint({**_BASE_CONFIG, 'organization': ''})

    build_session = MagicMock()
    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'build_session', build_session)

    ep._run()

    build_session.assert_not_called()


def test_run_surfaces_pull_error_as_a_failure(monkeypatch):
    ep = _make_endpoint(_BASE_CONFIG)
    ep.target.getPipe.return_value = MagicMock()

    def _flaky_items(*_a, **_kw):
        yield {'id': 1, 'fields': {'System.Title': 'One'}}
        raise RuntimeError('azure devops 500')

    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'build_session', lambda *a, **kw: MagicMock())
    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'iter_work_items', lambda *a, **kw: _flaky_items())
    endpoint_mod.monitorFailed.reset_mock()

    with pytest.raises(RuntimeError, match='azure devops 500'):
        ep._run()

    endpoint_mod.monitorFailed.assert_called_once_with(0)
    final_call = endpoint_mod.monitorStatus.call_args_list[-1][0][0]
    assert 'INCOMPLETE' in final_call
    assert 'pulled 1 record' in final_call


def test_run_passes_max_records_from_config(monkeypatch):
    ep = _make_endpoint({**_BASE_CONFIG, 'maxRecords': 5})

    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'build_session', lambda *a, **kw: MagicMock())
    iter_items = MagicMock(return_value=iter([]))
    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'iter_work_items', iter_items)

    ep._run()

    args, _ = iter_items.call_args
    assert args[-1] == 5


def test_run_defaults_max_records_when_unset(monkeypatch):
    ep = _make_endpoint(_BASE_CONFIG)

    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'build_session', lambda *a, **kw: MagicMock())
    iter_items = MagicMock(return_value=iter([]))
    monkeypatch.setattr(endpoint_mod.azure_boards_client, 'iter_work_items', iter_items)

    ep._run()

    args, _ = iter_items.call_args
    assert args[-1] == endpoint_mod._DEFAULT_MAX_RECORDS


# ---------------------------------------------------------------------------
# _emit_work_item: pipe wiring + per-item failure isolation
# ---------------------------------------------------------------------------


def test_emit_work_item_writes_a_document():
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    work_item = {'id': 42, 'fields': {'System.Title': 'Fix login bug', 'System.State': 'Active'}}
    ep._emit_work_item(work_item, 'myorg', 'myproj')

    pipe.open.assert_called_once()
    pipe.writeDocuments.assert_called_once()
    docs = pipe.writeDocuments.call_args[0][0]
    assert len(docs) == 1
    assert 'Fix login bug' in docs[0].page_content
    assert docs[0].metadata.state == 'Active'
    assert docs[0].metadata.objectId == '42'
    pipe.close.assert_called_once()
    ep.target.putPipe.assert_called_once_with(pipe)


def test_emit_work_item_skips_on_conversion_error(monkeypatch):
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    def _boom(_work_item):
        raise ValueError('bad fields')

    monkeypatch.setattr(endpoint_mod, 'build_doc_fields', _boom)

    work_item = {'id': 7, 'fields': {'System.Title': 'Broken'}}
    ep._emit_work_item(work_item, 'myorg', 'myproj')

    pipe.open.assert_not_called()
    ep.target.getPipe.assert_not_called()


def test_emit_work_item_puts_pipe_back_even_on_write_failure():
    ep = _make_endpoint({})
    pipe = MagicMock()
    pipe.writeDocuments.side_effect = RuntimeError('engine write failed')
    ep.target.getPipe.return_value = pipe

    work_item = {'id': 9, 'fields': {'System.Title': 'Flaky'}}
    ep._emit_work_item(work_item, 'myorg', 'myproj')

    pipe.close.assert_called_once()
    ep.target.putPipe.assert_called_once_with(pipe)


def test_emit_work_item_does_not_double_close_on_success():
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    work_item = {'id': 10, 'fields': {'System.Title': 'Fine'}}
    ep._emit_work_item(work_item, 'myorg', 'myproj')

    pipe.close.assert_called_once()


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
