# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the agent_crewai ReAct stop-sequence fix (#1363, Part B).

Bug: the CrewAI ReAct agent (Rocket Ralph) emitted the whole Thought/Action/
Observation/.../Final Answer transcript in ONE completion, fabricating the
Observation lines, so the real GitHub tool was never invoked and the agent
answered from an invented issue.

Root cause: `nodes/src/nodes/agent_crewai/crewai_base.py` `HostInvokeLLM.call`
read the raw `self.stop` field instead of CrewAI's `self.stop_sequences` property.
CrewAI injects the ReAct stop list (``"\nObservation:"``) per-call via a contextvar
override that is ONLY visible through `stop_sequences` (crewai/llms/base_llm.py:99,201).
Reading `self.stop` returned an empty list, so `AgentBase.call_llm`'s post-hoc
`truncate_at_stop_words` no-oped and the fabricated tail survived.

The wrapper itself (`crewai_base.HostInvokeLLM`) cannot be imported in a plain
interpreter — it pulls `rocketlib` (engine-only) and `crewai` (needs pywin32). So
these tests pin the fix at the two seams that ARE importable here:

1. The REAL `truncate_at_stop_words` (the function the fix feeds) — proving that with
   the correct stop list the fabricated transcript is trimmed back to a clean Action,
   and with ``None`` (the old behaviour) it is not.
2. A faithful mirror of CrewAI's `BaseLLM.stop`/`stop_sequences`/`call_stop_override`
   contract (semantics copied from crewai/llms/base_llm.py:165-214) — proving exactly
   why the wrapper must read `stop_sequences`, not `stop`: only the property reflects
   the per-call override.

End-to-end verification (real wrapper) requires the engine runtime — re-run the
Rocket Ralph pipeline and confirm the agent invokes search_issues and cites a real
issue rather than a fabricated one.
"""

from __future__ import annotations

import contextlib
import contextvars
import importlib.util
import sys
import types
from pathlib import Path

# ---------------------------------------------------------------------------
# Load the REAL truncate_at_stop_words from packages/ai, stubbing only its one
# dependency (ai.common.utils.safe_str) so no engine modules are required.
# ---------------------------------------------------------------------------
_UTILS_PATH = (
    Path(__file__).resolve().parents[3]
    / 'packages'
    / 'ai'
    / 'src'
    / 'ai'
    / 'common'
    / 'agent'
    / '_internal'
    / 'utils.py'
)


def _load_real_truncate():
    saved = {k: sys.modules.get(k) for k in ('ai', 'ai.common', 'ai.common.utils')}
    acu = types.ModuleType('ai.common.utils')
    acu.safe_str = lambda x: '' if x is None else str(x)
    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    sys.modules['ai.common.utils'] = acu
    try:
        spec = importlib.util.spec_from_file_location('rr_real_agent_utils', _UTILS_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.truncate_at_stop_words
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


truncate_at_stop_words = _load_real_truncate()

# The exact failure shape from the pasted repro: a full ReAct transcript with a
# fabricated Observation and a fabricated Final Answer, emitted in one completion.
FABRICATED = (
    'Thought: The user reported a bug, I should search existing issues.\n'
    'Action: tool_github_1_search_issues\n'
    'Action Input: {"query": "dropper browse button", "state": "open"}\n'
    'Observation: [{"number": 42, "title": "Dropper node: Browse button..."}]\n'
    'Thought: I now know the final answer\n'
    'Final Answer: There is already an open issue #42 that matches.'
)

# CrewAI's ReAct stop list (crewai/agent/core.py:1062 -> i18n "observation" slice).
REACT_STOP = ['\nObservation:']


# ---------------------------------------------------------------------------
# Seam 1 — the real truncation the fix feeds
# ---------------------------------------------------------------------------


class TestTruncationOutcome:
    def test_correct_stop_list_trims_to_clean_action(self):
        out = truncate_at_stop_words(FABRICATED, REACT_STOP)
        # Only Thought/Action/Action Input survive — a clean Action for CrewAI to execute.
        assert out.strip().endswith('}')
        assert 'Observation:' not in out
        assert 'Final Answer' not in out
        assert 'Action: tool_github_1_search_issues' in out

    def test_none_stop_list_is_the_bug(self):
        # Old behaviour: self.stop -> empty -> None reaches truncate -> no-op -> the
        # fabricated Observation + Final Answer survive (tool never runs).
        assert truncate_at_stop_words(FABRICATED, None) == FABRICATED

    def test_empty_stop_list_also_no_ops(self):
        assert truncate_at_stop_words(FABRICATED, []) == FABRICATED


# ---------------------------------------------------------------------------
# Seam 2 — why the wrapper must read `stop_sequences`, not `stop`
# Faithful mirror of crewai/llms/base_llm.py:165-214 (stop field + stop_sequences
# property + call_stop_override contextvar). If CrewAI changes this contract, the
# real engine-gated e2e is the backstop.
# ---------------------------------------------------------------------------

_override_var: contextvars.ContextVar = contextvars.ContextVar('_override_var', default=None)


@contextlib.contextmanager
def call_stop_override(llm, stop):
    current = _override_var.get() or {}
    new = dict(current)
    new[id(llm)] = stop
    token = _override_var.set(new)
    try:
        yield
    finally:
        _override_var.reset(token)


class _MirrorBaseLLM:
    """Mirrors CrewAI BaseLLM's stop/stop_sequences semantics."""

    def __init__(self):
        self.stop: list[str] = []  # raw field — default empty

    @property
    def stop_sequences(self) -> list[str]:
        overrides = _override_var.get()
        if overrides is not None:
            ov = overrides.get(id(self))
            if ov is not None:
                return ov
        return self.stop


class TestStopSequencesContract:
    def test_raw_stop_misses_override(self):
        llm = _MirrorBaseLLM()
        with call_stop_override(llm, REACT_STOP):
            # The OLD wrapper read this -> empty -> bug.
            assert getattr(llm, 'stop', None) == []

    def test_stop_sequences_reflects_override(self):
        llm = _MirrorBaseLLM()
        with call_stop_override(llm, REACT_STOP):
            # The FIXED wrapper reads this -> the active ReAct stop list.
            assert llm.stop_sequences == REACT_STOP

    def test_stop_sequences_falls_back_outside_override(self):
        llm = _MirrorBaseLLM()
        assert llm.stop_sequences == []  # no override active -> raw field

    def test_property_feeds_truncation_end_to_end(self):
        # The composed fix: read stop_sequences under the override, feed truncate.
        llm = _MirrorBaseLLM()
        with call_stop_override(llm, REACT_STOP):
            out = truncate_at_stop_words(FABRICATED, llm.stop_sequences)
        assert 'Observation:' not in out and 'Final Answer' not in out
