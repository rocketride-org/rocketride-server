# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""tool_masky through the engine's real ToolsBase.handle_invoke.

The other test files stub ToolsBase as a plain class and call _tool_invoke
directly. These tests go through the real tool.query / tool.validate /
tool.invoke routing, so a switched-off tool is checked the way an agent
reaches it: hidden from the listing, and refused with the message the README
documents (not dropped as "not owned").
"""

from __future__ import annotations

import sys
import types

import pytest

pytestmark = pytest.mark.skipif(sys.version_info < (3, 10), reason='the engine ToolsBase uses match statements')

if sys.version_info >= (3, 10):
    from ._stubs import APERR, scoped_stubs

    with scoped_stubs(real_tools_base=True) as _env:
        from tool_masky import IInstance as IInstanceMod
        from tool_masky import masky_driver as driver_mod

        REAL_TOOLS_BASE = _env.tools_base

READ_ONLY_TEXT = 'This operation is not permitted: the node is configured in read-only mode'


class RecordingClient:
    """Records every call; any attribute is a method that returns an empty result."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self.calls.append(name)
            return [] if name == 'list_voices' else {}

        return method


def _driver(settings=None):
    client = RecordingClient()
    return driver_mod.MaskyDriver(server_name='masky', client=client, settings=settings or {}), client


def _invoke(target, tool_name, args=None, op='tool.invoke'):
    return target.handle_invoke({'op': op, 'tool_name': tool_name, 'input': args or {}})


def _listed(d):
    param = {'op': 'tool.query', 'tools': []}
    with pytest.raises(APERR):  # tool.query always continues the chain
        d.handle_invoke(param)
    return [t['name'] for t in param['tools']]


def test_driver_is_built_on_the_real_tools_base():
    assert issubclass(driver_mod.MaskyDriver, REAL_TOOLS_BASE)


def test_read_only_hides_speak_and_refuses_a_direct_invoke_with_the_readme_message():
    d, client = _driver({'read_only': True})
    assert 'masky.speak' not in _listed(d)
    with pytest.raises(ValueError, match=READ_ONLY_TEXT):
        _invoke(d, 'masky.speak', {'text': 'hi', 'avatar_id': 'A'})
    assert client.calls == []


def test_read_only_refusal_also_applies_to_tool_validate():
    d, client = _driver({'read_only': True})
    with pytest.raises(ValueError, match=READ_ONLY_TEXT):
        _invoke(d, 'masky.speak', {'text': 'hi', 'avatar_id': 'A'}, op='tool.validate')
    assert client.calls == []


def test_read_only_still_runs_a_read_tool_through_handle_invoke():
    d, client = _driver({'read_only': True})
    assert 'masky.list_voices' in _listed(d)
    out = _invoke(d, 'masky.list_voices')
    assert out['output'] == {'voices': [], 'count': 0} and client.calls == ['list_voices']


def test_delete_tool_is_hidden_and_refused_naming_allow_delete():
    d, client = _driver()
    assert 'masky.delete_turn' not in _listed(d)
    with pytest.raises(ValueError, match="'allowDelete'"):
        _invoke(d, 'masky.delete_turn', {'conversation_id': 'C1', 'turn_id': 'T1'})
    assert client.calls == []


def test_a_tool_from_another_namespace_is_not_owned():
    d, client = _driver({'read_only': True})
    with pytest.raises(APERR) as info:
        _invoke(d, 'other.speak', {'text': 'hi'})
    assert 'not owned' in str(info.value) and client.calls == []


def test_iinstance_invoke_goes_through_handle_invoke_and_refuses():
    d, client = _driver({'read_only': True})
    inst = IInstanceMod.IInstance()
    inst.IGlobal = types.SimpleNamespace(driver=d)
    with pytest.raises(ValueError, match=READ_ONLY_TEXT):
        inst.invoke({'op': 'tool.invoke', 'tool_name': 'masky.speak', 'input': {'text': 'hi', 'avatar_id': 'A'}})
    assert client.calls == []
