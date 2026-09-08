# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the CrewAI LLM adapter contract.

Bug: hierarchical crews failed with

    Failed to convert text into a Pydantic model due to error:
    'HostInvokeLLM' object has no attribute 'supports_function_calling'

Root cause: CrewAI defines ``supports_function_calling()`` on ``crewai.llm.LLM``
and on each provider completion class, but **not** on ``BaseLLM``. Most callers
probe it with ``hasattr`` first; several do not — ``crewai/utilities/converter.py``
(``to_pydantic`` / ``ato_pydantic`` / ``to_json``) and ``crewai/tools/tool_usage.py``
(``_function_calling``) call it straight. Our ``HostInvokeLLM`` subclasses
``BaseLLM`` and implemented only ``call`` and ``acall``, so those paths raised
``AttributeError``, which ``converter.py`` swallows in a broad ``except Exception``
and re-reports as the misleading message above.

``Crew(planning=True)`` — hardcoded by the hierarchical manager — runs a planner
task with ``output_pydantic`` set, so the manager reached that path on every
kickoff whose plan text was not already clean JSON.

``crewai_base`` cannot be imported in a plain interpreter (it pulls ``rocketlib``,
``ai.common`` and ``crewai``, the last needing pywin32), so these tests stub those
three seams and exercise the REAL ``CrewBase._build_crew_llm``. The stubs are
installed and torn down around the import so a full ``builder nodes:test`` run,
where the real modules are present and session-shared, is unaffected.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

# Point at nodes/src/nodes, not nodes/src: importing through the `nodes` package
# would execute nodes/src/nodes/__init__.py, which pulls the engine-only `depends`.
_NODES_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
if str(_NODES_DIR) not in sys.path:
    sys.path.insert(0, str(_NODES_DIR))

_STUB_MODULE_NAMES = (
    'rocketlib',
    'crewai',
    'ai',
    'ai.common',
    'ai.common.agent',
    'ai.common.utils',
)


class _StubBaseLLM:
    """Stand-in for ``crewai.BaseLLM``.

    Mirrors the two things ``HostInvokeLLM`` relies on: an ``__init__`` taking
    ``model``/``temperature``, and a ``stop_sequences`` property. It deliberately
    does NOT define ``supports_function_calling`` — that absence is the bug under
    test, and defining it here would make these tests pass vacuously.
    """

    def __init__(self, model: str = '', temperature=None, **kwargs):
        self.model = model
        self.temperature = temperature
        self.stop = []

    @property
    def stop_sequences(self):
        return self.stop


def _build_stubs() -> dict:
    mod_rocketlib = types.ModuleType('rocketlib')
    mod_rocketlib.ToolDescriptor = dict

    # No `crewai.crew` / `crewai.tools` submodules: the import-time compatibility
    # patches in crewai_base wrap their imports in try/except and no-op without them.
    mod_crewai = types.ModuleType('crewai')
    mod_crewai.BaseLLM = _StubBaseLLM

    mod_ai = types.ModuleType('ai')
    mod_ai_common = types.ModuleType('ai.common')

    mod_agent = types.ModuleType('ai.common.agent')

    class AgentBase:
        pass

    class AgentContext:
        pass

    mod_agent.AgentBase = AgentBase
    mod_agent.AgentContext = AgentContext

    mod_utils = types.ModuleType('ai.common.utils')
    mod_utils.safe_str = str

    return {
        'rocketlib': mod_rocketlib,
        'crewai': mod_crewai,
        'ai': mod_ai,
        'ai.common': mod_ai_common,
        'ai.common.agent': mod_agent,
        'ai.common.utils': mod_utils,
    }


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    sys.modules.update(_build_stubs())
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


with _scoped_stubs():
    crewai_base = importlib.import_module('agent_crewai.crewai_base')


@pytest.fixture(autouse=True)
def _stubbed_crewai():
    """Keep the stubs live during the tests too.

    ``_build_crew_llm`` does ``from crewai import BaseLLM`` at call time, not at
    import time, so the stub has to be installed while each test runs. Scoping it
    per test restores the real modules afterwards, which matters under a full
    ``builder nodes:test`` run where they are present and session-shared.
    """
    with _scoped_stubs():
        yield


class _Recorder(crewai_base.CrewBase):
    """Minimal CrewBase whose call_llm records what the adapter forwarded."""

    def __init__(self):
        self.calls = []

    def call_llm(self, context, messages, role=None, stop_words=None):
        self.calls.append({'context': context, 'messages': messages, 'role': role, 'stop_words': stop_words})
        return 'host reply'


def _llm():
    return _Recorder()._build_crew_llm(context=object(), role='Rocket Ralph')


class TestFunctionCallingSupport:
    def test_method_exists_and_is_callable(self):
        llm = _llm()
        assert callable(getattr(llm, 'supports_function_calling', None))

    def test_reports_no_native_function_calling(self):
        """`call` ignores tools/response_model and returns a string, so False is the truth."""
        assert _llm().supports_function_calling() is False

    def test_base_class_does_not_provide_it(self):
        """Guards against 'BaseLLM covers this now' — the override must stay explicit."""
        assert not hasattr(_StubBaseLLM, 'supports_function_calling')

    def test_converter_probe_does_not_raise(self):
        """Reproduces crewai/utilities/converter.py:97, which calls this unguarded."""
        llm = _llm()
        if llm.supports_function_calling():
            response = llm.call(messages=[{'role': 'user', 'content': 'hi'}], response_model=object)
        else:
            response = llm.call([{'role': 'user', 'content': 'hi'}])
        assert response == 'host reply'

    def test_tool_usage_probe_does_not_raise(self):
        """Reproduces crewai/tools/tool_usage.py:814, the tool-call repair path."""
        llm = _llm()
        assert llm.supports_function_calling() in (True, False)


class TestUnguardedInterface:
    """CrewAI calls these on the agent's LLM without a hasattr guard."""

    @pytest.mark.parametrize('name', ['call', 'acall', 'supports_function_calling'])
    def test_method_is_present(self, name):
        assert callable(getattr(_llm(), name, None))

    def test_inherited_capability_methods_are_reachable(self):
        """These come from BaseLLM; assert we did not shadow them into nothing."""
        llm = _llm()
        for name in ('stop_sequences',):
            assert hasattr(llm, name)


class TestCallForwarding:
    def test_call_forwards_role_and_stop_sequences(self):
        recorder = _Recorder()
        llm = recorder._build_crew_llm(context='ctx', role='Rocket Ralph')
        llm.stop = ['\nObservation:']

        assert llm.call('question') == 'host reply'
        assert recorder.calls == [
            {'context': 'ctx', 'messages': 'question', 'role': 'Rocket Ralph', 'stop_words': ['\nObservation:']}
        ]

    def test_acall_bridges_to_the_sync_channel(self):
        recorder = _Recorder()
        llm = recorder._build_crew_llm(context='ctx', role='Rocket Ralph')

        assert asyncio.run(llm.acall('question')) == 'host reply'
        assert recorder.calls[0]['messages'] == 'question'
