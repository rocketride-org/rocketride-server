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


# Matching is exact (case-sensitive) on purpose: API-level stop is now primary, so the
# truncation net stays narrow to avoid cutting legitimate answers that merely contain the
# marker text. Drifted markers are left alone rather than risk an over-match.
DRIFT_SPACED = FABRICATED.replace('\nObservation:', '\nObservation :')  # spaced colon
DRIFT_CASE = FABRICATED.replace('\nObservation:', '\nobservation:')  # lowercased


class TestTruncationIsExactOnly:
    def test_drifted_marker_is_not_truncated(self):
        # "\nObservation :" / "\nobservation:" are not the exact stop word, so the net
        # leaves them intact (the provider's API stop handles the real case).
        assert truncate_at_stop_words(DRIFT_SPACED, REACT_STOP) == DRIFT_SPACED
        assert truncate_at_stop_words(DRIFT_CASE, REACT_STOP) == DRIFT_CASE

    def test_prose_containing_marker_text_is_preserved(self):
        # A legitimate answer mentioning the marker text must not be cut.
        prose = 'My key observation: the pipeline is healthy.'
        assert truncate_at_stop_words(prose, REACT_STOP) == prose

    def test_clean_text_without_marker_is_untouched(self):
        clean = 'Thought: all done\nFinal Answer: 42 is the answer.'
        assert truncate_at_stop_words(clean, REACT_STOP) == clean


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


# ---------------------------------------------------------------------------
# Seam 3 — API-level stop: the native Anthropic payload must carry the stop
# sequences published on STOP_SEQUENCES_VAR, so the provider stops generating
# (not just post-hoc truncation). Loads the REAL llm_native_stream with rocketlib
# stubbed, and fakes the LangChain payload builder + raw stream.
# ---------------------------------------------------------------------------
_NATIVE_PATH = (
    Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'llm_native_stream.py'
)


def _load_native_stream():
    saved_rl = sys.modules.get('rocketlib')
    rl = types.ModuleType('rocketlib')
    rl.debug = lambda *a, **k: None
    rl.warning = lambda *a, **k: None
    sys.modules['rocketlib'] = rl
    try:
        spec = importlib.util.spec_from_file_location('rr_real_native_stream', _NATIVE_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if saved_rl is None:
            sys.modules.pop('rocketlib', None)
        else:
            sys.modules['rocketlib'] = saved_rl


def _run_native_capture(ns, stop_value):
    """Drive _stream_anthropic_messages_api with fakes; return the stop the payload got."""
    captured: dict = {}

    class _FakeLLM:
        _client = object()  # non-None so the client guard passes

        def _get_request_payload(self, prompt, stop=None, stream=None):
            captured['stop'] = stop
            return {}

    class _FakeChat:
        _llm = _FakeLLM()

    ns._open_raw_message_stream = lambda client, payload: iter(())  # no events -> no text
    token = ns.STOP_SEQUENCES_VAR.set(stop_value)
    try:
        # Produces no text, so the function raises after building the payload — we only
        # assert the payload wiring, which happens before any streaming.
        ns._stream_anthropic_messages_api(_FakeChat(), 'prompt', lambda t: None, None, None)
    except RuntimeError:
        pass
    finally:
        ns.STOP_SEQUENCES_VAR.reset(token)
    return captured.get('stop', 'UNSET')


class TestNativeStopThreading:
    def test_payload_carries_contextvar_stop(self):
        ns = _load_native_stream()
        assert _run_native_capture(ns, REACT_STOP) == REACT_STOP

    def test_payload_stop_defaults_none(self):
        ns = _load_native_stream()
        assert _run_native_capture(ns, None) is None


# ---------------------------------------------------------------------------
# Seam 4 — LLMBase._question must publish the stop list on STOP_SEQUENCES_VAR
# around chat.chat(...) and ALWAYS reset it afterward, so a stop from one request
# cannot leak onto the next on a reused chat instance. Loads the REAL llm_base
# with its deps stubbed, sharing the real STOP_SEQUENCES_VAR object.
# ---------------------------------------------------------------------------
_LLM_BASE_PATH = Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'llm_base.py'


def _load_llm_base(stop_var):
    saved = {
        k: sys.modules.get(k)
        for k in ('rocketlib', 'ai', 'ai.common', 'ai.common.schema', 'ai.common.llm_native_stream')
    }
    rl = types.ModuleType('rocketlib')
    rl.IInstanceBase = object
    rl.invoke_function = lambda f: f
    rl.warning = lambda *a, **k: None
    sys.modules['rocketlib'] = rl
    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    schema = types.ModuleType('ai.common.schema')
    schema.Question = object
    schema.Answer = object
    sys.modules['ai.common.schema'] = schema
    nsmod = types.ModuleType('ai.common.llm_native_stream')
    nsmod.STOP_SEQUENCES_VAR = stop_var  # share the SAME contextvar the test asserts on
    sys.modules['ai.common.llm_native_stream'] = nsmod
    try:
        spec = importlib.util.spec_from_file_location('rr_real_llm_base', _LLM_BASE_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.LLMBase
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


class TestQuestionContextvar:
    def _make_self(self, chat):
        ig = type('IGlobal', (), {'_chat': chat})()
        return type('Node', (), {'IGlobal': ig})()

    def test_question_sets_stop_during_and_resets_after(self):
        var = _load_native_stream().STOP_SEQUENCES_VAR
        LLMBase = _load_llm_base(var)
        seen = {}

        class _Chat:
            def chat(self, question, on_chunk=None, on_finish=None, on_reasoning_chunk=None):
                seen['during'] = var.get()
                return 'answer'

        assert var.get() is None
        LLMBase._question(self._make_self(_Chat()), 'q', stop=REACT_STOP)
        assert seen['during'] == REACT_STOP  # published during the call
        assert var.get() is None  # reset afterward

    def test_question_resets_stop_even_when_chat_raises(self):
        var = _load_native_stream().STOP_SEQUENCES_VAR
        LLMBase = _load_llm_base(var)

        class _Chat:
            def chat(self, question, on_chunk=None, on_finish=None, on_reasoning_chunk=None):
                raise RuntimeError('boom')

        try:
            LLMBase._question(self._make_self(_Chat()), 'q', stop=REACT_STOP)
        except RuntimeError:
            pass
        assert var.get() is None  # reset in finally, no leak onto the next request
