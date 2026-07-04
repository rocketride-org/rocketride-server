"""Unit tests for ai.modules.task.pipeflow.apply_pipeflow_event.

These pin the two fixes for the agent-trace "missing leave event" / duplicate-span
bug (reentrant agent sub-invocations share one pipe_index and interleave):

1. Each emitted `pipes` chain is an independent snapshot — mutating the stack via
   later events must NOT change an already-captured chain (the aliasing bug where
   the live list was emitted by reference).
2. `leave` pops by identity (the leaving component), not by position, so an
   out-of-order leave removes the correct frame rather than the current top.

Loaded by file path (pipeflow.py has no heavy imports) so the test needs no engine
runtime — run with `pytest --noconftest`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PIPEFLOW_PATH = Path(__file__).resolve().parents[4] / 'src' / 'ai' / 'modules' / 'task' / 'pipeflow.py'


def _load():
    spec = importlib.util.spec_from_file_location('rr_real_pipeflow', _PIPEFLOW_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.apply_pipeflow_event


apply_pipeflow_event = _load()


class TestStackUpdates:
    def test_begin_resets_stack(self):
        by_pipe = {0: ['stale', 'frames']}
        pipes = apply_pipeflow_event(by_pipe, 0, 'begin', 'ralph')
        assert pipes == ['ralph']
        assert by_pipe[0] == ['ralph']

    def test_enter_appends_and_snapshots_self(self):
        by_pipe = {}
        apply_pipeflow_event(by_pipe, 0, 'begin', 'ralph')
        pipes = apply_pipeflow_event(by_pipe, 0, 'enter', 'qdrant')
        assert pipes == ['ralph', 'qdrant']

    def test_end_clears_stack(self):
        by_pipe = {0: ['ralph', 'qdrant']}
        pipes = apply_pipeflow_event(by_pipe, 0, 'end', 'ralph')
        assert pipes == []
        assert by_pipe[0] == []


class TestSnapshotIndependence:
    def test_returned_pipes_is_not_the_live_stack(self):
        by_pipe = {}
        apply_pipeflow_event(by_pipe, 0, 'begin', 'ralph')
        captured = apply_pipeflow_event(by_pipe, 0, 'enter', 'qdrant')
        assert captured == ['ralph', 'qdrant']
        # Mutating the stack via subsequent events must not alter the captured chain.
        apply_pipeflow_event(by_pipe, 0, 'enter', 'transformer')
        apply_pipeflow_event(by_pipe, 0, 'leave', 'transformer')
        assert captured == ['ralph', 'qdrant']  # would be corrupted if emitted by reference


class TestIdentityLeavePop:
    def test_out_of_order_leave_pops_correct_component(self):
        by_pipe = {}
        apply_pipeflow_event(by_pipe, 0, 'begin', 'ralph')
        apply_pipeflow_event(by_pipe, 0, 'enter', 'qdrant')
        apply_pipeflow_event(by_pipe, 0, 'enter', 'transformer')
        # qdrant leaves BEFORE transformer (interleaved). A blind top-pop would drop
        # transformer; identity-pop must drop qdrant.
        pipes = apply_pipeflow_event(by_pipe, 0, 'leave', 'qdrant')
        assert pipes == ['ralph', 'transformer']
        assert by_pipe[0] == ['ralph', 'transformer']

    def test_leave_removes_last_occurrence(self):
        by_pipe = {0: ['ralph', 'tool', 'ralph']}
        pipes = apply_pipeflow_event(by_pipe, 0, 'leave', 'ralph')
        assert pipes == ['ralph', 'tool']

    def test_leave_of_absent_component_falls_back_to_top_pop(self):
        by_pipe = {0: ['ralph', 'qdrant']}
        pipes = apply_pipeflow_event(by_pipe, 0, 'leave', 'ghost')
        assert pipes == ['ralph']

    def test_leave_on_empty_stack_is_safe(self):
        by_pipe = {0: []}
        pipes = apply_pipeflow_event(by_pipe, 0, 'leave', 'ralph')
        assert pipes == []


class TestReentrantSequence:
    def test_nested_agent_memory_lookup_unwinds_cleanly(self):
        by_pipe = {}
        seq = [
            ('begin', 'ralph'),
            ('enter', 'qdrant'),
            ('enter', 'transformer'),
            ('leave', 'transformer'),
            ('leave', 'qdrant'),
            ('end', 'ralph'),
        ]
        snapshots = [apply_pipeflow_event(by_pipe, 0, op, name) for op, name in seq]
        assert snapshots[0] == ['ralph']
        assert snapshots[1] == ['ralph', 'qdrant']
        assert snapshots[2] == ['ralph', 'qdrant', 'transformer']
        assert snapshots[3] == ['ralph', 'qdrant']
        assert snapshots[4] == ['ralph']
        assert snapshots[5] == []
