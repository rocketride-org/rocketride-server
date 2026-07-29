# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Confluence source node's engine glue (no network).

Stubs only the engine-only modules (rocketlib, depends) that IEndpoint.py
imports through the nodes.confluence package __init__. The REST/pagination
logic itself lives in confluence_client.py and is covered separately in
test_client.py (no engine, no stubbing needed there).
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# _emit_page calls the real convert_storage_html (which needs bs4) on real
# HTML in several tests below — skip cleanly rather than failing with a
# confusing assertion error if bs4 truly isn't installed.
pytest.importorskip('bs4')

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


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

    return {'rocketlib': rocketlib, 'depends': depends}


_stubs = _build_import_stubs()
_added_stubs = []
for _name, _stub in _stubs.items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

try:
    endpoint_mod = importlib.import_module('nodes.confluence.IEndpoint')
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


# ---------------------------------------------------------------------------
# _run: config validation guard + pagination-error containment
# ---------------------------------------------------------------------------


def test_run_bails_out_when_config_incomplete(monkeypatch):
    ep = _make_endpoint({'baseUrl': '', 'email': 'a@b.com', 'apiToken': 'tok', 'spaceKey': 'ENG'})

    build_session = MagicMock()
    monkeypatch.setattr(endpoint_mod.confluence_client, 'build_session', build_session)

    ep._run()

    build_session.assert_not_called()


def test_run_reports_pages_pulled_before_a_pagination_error(monkeypatch):
    ep = _make_endpoint(
        {'baseUrl': 'https://x.atlassian.net/wiki', 'email': 'a@b.com', 'apiToken': 'tok', 'spaceKey': 'ENG'}
    )
    ep.target.getPipe.return_value = MagicMock()

    def _flaky_pages(*_a, **_kw):
        yield {'id': '1', 'title': 'One', 'body': {'storage': {'value': '<p>ok</p>'}}}
        raise RuntimeError('confluence 500')

    monkeypatch.setattr(endpoint_mod.confluence_client, 'build_session', lambda *a, **kw: MagicMock())
    monkeypatch.setattr(endpoint_mod.confluence_client, 'iter_space_pages', lambda *a, **kw: _flaky_pages())

    # Should not raise — the failure is caught and reported, not propagated.
    ep._run()

    final_call = endpoint_mod.monitorStatus.call_args_list[-1][0][0]
    assert 'pulled 1 page' in final_call


# ---------------------------------------------------------------------------
# _emit_page: pipe wiring + per-page failure isolation
# ---------------------------------------------------------------------------


def test_emit_page_writes_text_and_tables():
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    page = {
        'id': '42',
        'title': 'Runbook',
        'body': {'storage': {'value': '<p>Steps</p><table><tr><th>A</th></tr><tr><td>1</td></tr></table>'}},
    }

    ep._emit_page(page, 'ENG')

    pipe.open.assert_called_once()
    pipe.writeText.assert_called_once()
    assert 'Steps' in pipe.writeText.call_args[0][0]
    pipe.writeTable.assert_called_once()
    pipe.close.assert_called_once()
    ep.target.putPipe.assert_called_once_with(pipe)


def test_emit_page_skips_on_conversion_error(monkeypatch):
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    def _boom(_html):
        raise ValueError('bad markup')

    monkeypatch.setattr(endpoint_mod, 'convert_storage_html', _boom)

    page = {'id': '7', 'title': 'Broken', 'body': {'storage': {'value': '<p>x</p>'}}}
    ep._emit_page(page, 'ENG')

    # Conversion failed before any pipe was opened, so nothing should be touched
    pipe.open.assert_not_called()
    ep.target.getPipe.assert_not_called()


def test_emit_page_puts_pipe_back_even_on_write_failure():
    ep = _make_endpoint({})
    pipe = MagicMock()
    pipe.writeText.side_effect = RuntimeError('engine write failed')
    ep.target.getPipe.return_value = pipe

    page = {'id': '9', 'title': 'Flaky', 'body': {'storage': {'value': '<p>content</p>'}}}
    ep._emit_page(page, 'ENG')

    # A failed write must not leave the pipe open — close() is called in the
    # cleanup path even though the happy-path pipe.close() was never reached.
    pipe.close.assert_called_once()
    ep.target.putPipe.assert_called_once_with(pipe)


def test_emit_page_does_not_double_close_on_success():
    ep = _make_endpoint({})
    pipe = MagicMock()
    ep.target.getPipe.return_value = pipe

    page = {'id': '10', 'title': 'Fine', 'body': {'storage': {'value': '<p>content</p>'}}}
    ep._emit_page(page, 'ENG')

    pipe.close.assert_called_once()


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
