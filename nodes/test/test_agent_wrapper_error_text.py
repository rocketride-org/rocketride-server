# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The LangChain and Deep Agent wrappers turn a failed model call into the answer text.

An engine error's str() ends in " at (<engine source path>:<line>)". The wrapper's
message becomes the answer a user reads, so it must not carry that path; the debug
log keeps the full text. The frameworks are stand-ins, so this runs without them.
"""

import importlib.util
import os
import sys
import types
from types import SimpleNamespace

import pytest

_NODES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'nodes')
LOCATION = '/opt/rocketride/ai/common/chat.py:412'


def _engine_error():
    """An exception shaped the way the engine's translator builds one."""
    exc = Exception(f'Exception: Invalid API key. at ({LOCATION})')
    setattr(exc, '__formatted', True)
    return exc


class _Message:
    def __init__(self, content='', **kwargs):
        self.content = content


class _Handler:
    def __init__(self, *args, **kwargs):
        pass


class _FailingAgent:
    """The framework agent: its model call fails inside the engine."""

    def invoke(self, *args, **kwargs):
        raise _engine_error()

    async def ainvoke(self, *args, **kwargs):
        raise _engine_error()


def _stub(monkeypatch, name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)


def _load(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_NODES, relative_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _context():
    return SimpleNamespace(invoker=None, tools=SimpleNamespace(list=[]))


def _question():
    return SimpleNamespace(getPrompt=lambda: 'q')


@pytest.fixture
def frameworks(monkeypatch):
    """Stand-ins for the framework modules both drivers import inside _run."""
    _stub(monkeypatch, 'langchain.agents', create_agent=lambda **kwargs: _FailingAgent())
    _stub(monkeypatch, 'deepagents', create_deep_agent=lambda **kwargs: _FailingAgent())
    _stub(monkeypatch, 'langchain_core.messages', AIMessage=_Message, HumanMessage=_Message, SystemMessage=_Message)
    _stub(monkeypatch, 'langchain_core.callbacks', BaseCallbackHandler=_Handler)


def test_the_langchain_answer_for_a_failed_model_call_has_no_engine_path(monkeypatch, frameworks):
    module = _load('_langchain_wrapper_error_text', 'agent_langchain/langchain.py')
    logged = []
    monkeypatch.setattr(module, 'debug', logged.append)
    monkeypatch.setattr(module, '_build_langchain_llm', lambda *args: object())
    monkeypatch.setattr(module, '_build_langchain_tools', lambda *args: [])
    driver = module.LangChainDriver.__new__(module.LangChainDriver)

    with pytest.raises(RuntimeError) as caught:
        driver._run(context=_context(), question=_question())

    assert str(caught.value) == 'LangChain agent invoke failed: Exception: Exception: Invalid API key.'
    assert any(LOCATION in line for line in logged), 'the log lost the engine location'


def test_the_deep_agent_answer_for_a_failed_model_call_has_no_engine_path(monkeypatch, frameworks):
    module = _load('_deepagent_wrapper_error_text', 'agent_deepagent/deepagent.py')
    logged = []
    monkeypatch.setattr(module, 'debug', logged.append)
    monkeypatch.setattr(module, '_build_deepagent_llm', lambda *args: object())
    monkeypatch.setattr(module, '_build_deepagent_tools', lambda *args: [])
    driver = module.DeepAgentDriver.__new__(module.DeepAgentDriver)
    driver._system_prompt = ''
    driver._instructions = []
    driver._collect_subagents = lambda context: []

    with pytest.raises(RuntimeError) as caught:
        driver._run(context=_context(), question=_question())

    assert str(caught.value) == 'Deep agent invoke failed: Exception: Exception: Invalid API key.'
    assert any(LOCATION in line for line in logged), 'the log lost the engine location'
