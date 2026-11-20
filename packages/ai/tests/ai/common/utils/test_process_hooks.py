# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.process_hooks.register_debugger_thread``: once per
thread, for the life of that thread.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_process_hooks.py -v
"""

from __future__ import annotations

import sys
import threading
from unittest.mock import MagicMock

from ai.common.utils import process_hooks, register_debugger_thread


def test_each_thread_registers_once(monkeypatch):
    pydevd = MagicMock()
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setattr(process_hooks, '_DEBUGGER_REGISTERED', threading.local())

    register_debugger_thread()
    register_debugger_thread()
    assert pydevd.settrace.call_count == 1


def test_a_later_thread_registers_even_with_a_reused_ident(monkeypatch):
    # Sequential threads commonly reuse an exited thread's ident; each must still register.
    pydevd = MagicMock()
    monkeypatch.setitem(sys.modules, 'pydevd', pydevd)
    monkeypatch.setattr(process_hooks, '_DEBUGGER_REGISTERED', threading.local())

    idents = []

    def run():
        idents.append(threading.get_ident())
        register_debugger_thread()

    for _ in range(3):
        t = threading.Thread(target=run)
        t.start()
        t.join()
    assert pydevd.settrace.call_count == 3


def test_without_a_debugger_nothing_happens(monkeypatch):
    monkeypatch.delitem(sys.modules, 'pydevd', raising=False)
    monkeypatch.setattr(process_hooks, '_DEBUGGER_REGISTERED', threading.local())
    register_debugger_thread()
    assert not getattr(process_hooks._DEBUGGER_REGISTERED, 'done', False)
