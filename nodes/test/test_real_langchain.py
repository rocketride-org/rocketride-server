# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""``real_langchain_or_skip()`` leaves ``sys.modules`` as it found a stubbed package."""

from __future__ import annotations

import sys
import types

from ._real_langchain import real_langchain_or_skip


def _langchain_core_modules():
    return {name: module for name, module in sys.modules.items() if name.partition('.')[0] == 'langchain_core'}


def test_restore_drops_the_real_modules_and_puts_the_stubs_back(monkeypatch):
    # The stub tree test_agent_langchain_parser.py builds when the real package is not loaded yet.
    for name in _langchain_core_modules():
        monkeypatch.delitem(sys.modules, name)
    stub = types.ModuleType('langchain_core')
    stub_messages = types.ModuleType('langchain_core.messages')
    stub.messages = stub_messages
    monkeypatch.setitem(sys.modules, 'langchain_core', stub)
    monkeypatch.setitem(sys.modules, 'langchain_core.messages', stub_messages)

    restore = real_langchain_or_skip()
    assert sys.modules['langchain_core'] is not stub
    assert 'langchain_core.tools' in sys.modules
    restore()

    assert _langchain_core_modules() == {'langchain_core': stub, 'langchain_core.messages': stub_messages}
    assert stub.messages is stub_messages
