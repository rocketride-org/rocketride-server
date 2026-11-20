# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The readiness notes a source publishes: the node's button is an `open-tool` note.

Pins plan 3.6 / B2: the chat and dropper sources name the front end that
talks to them (`open-tool` = the app id) with their own node id beside it,
so the host opens that app's document bound to the running control; no
page URL is composed any more (the button's link and the page servers are
gone). The webhook keeps its data door only.
"""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def source_module(monkeypatch):
    """Load the real source with only its native and server boundaries stubbed."""
    rocketlib = ModuleType('rocketlib')
    rocketlib.IEndpointBase = object
    rocketlib.monitorOther = Mock()
    rocketlib.monitorStatus = Mock()
    rocketlib.debug = Mock()
    rocketlib.isCancelled = Mock(return_value=False)
    depends = ModuleType('depends')
    depends.depends = Mock()
    ai = ModuleType('ai')
    ai.node = SimpleNamespace(require_shared_web_server=Mock())
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'depends', depends)
    monkeypatch.setitem(sys.modules, 'ai', ai)
    path = Path(__file__).resolve().parents[2] / 'src/nodes/webhook/IEndpoint.py'
    spec = importlib.util.spec_from_file_location('_webhook_notes_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _notes_of(source_module, logical_type):
    """Run `_startup` for one logical type and return the notes it published."""
    endpoint = source_module.IEndpoint()
    endpoint.endpoint = SimpleNamespace(logicalType=logical_type)
    endpoint.target = None
    source_module.monitorOther.reset_mock()
    endpoint._startup()
    calls = [c for c in source_module.monitorOther.call_args_list if c.args[0] == 'usr']
    assert len(calls) == 1, 'one usr note per startup'
    return json.loads(calls[0].args[1])


@pytest.mark.parametrize(
    ('logical_type', 'app_id', 'label'),
    [('chat', 'rocketride.chat', 'Open Chat'), ('dropper', 'rocketride.dropper', 'Open Dropper')],
)
def test_front_end_sources_publish_the_open_tool_note(source_module, logical_type, app_id, label):
    """The note names the app and the node; the node id is the control's source placeholder."""
    notes = _notes_of(source_module, logical_type)
    assert len(notes) == 1
    info = notes[0]
    assert info['open-tool'] == app_id
    assert info['button-text'] == label
    # {source} is filled per control by the server (expand_note): the last
    # segment of the control's address is this source's component id.
    assert info['nodeId'] == '{source}'
    assert info['address'] == '{address}'
    # No page URL is composed at all (B2; the page servers are gone with
    # C.16a): the host opens the app's document from the note, never from a
    # link, and the SDK talks to the source by address.
    assert set(info) == {'button-text', 'open-tool', 'nodeId', 'address'}


def test_the_webhook_keeps_its_data_door_without_a_button(source_module):
    """A webhook has no front end: the data door and the lanes, no open-tool."""
    notes = _notes_of(source_module, 'webhook')
    info = notes[0]
    assert 'open-tool' not in info
    assert 'button-link' not in info
    assert 'button-text' not in info
    assert info['url-link'] == '{host}/webhook/{address}'
    assert info['lanes'] == []
