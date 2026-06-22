# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for _parse_tool_call_envelope in agent_langchain/langchain.py.

No langchain install or engine runtime required — module-level deps are stubbed
before import, and langchain_core.messages.AIMessage is replaced with a minimal
fake so the parser's internal import resolves without the real package.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: inject stubs before importing langchain.py
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_STUBS_INSTALLED = False


class _FakeAIMessage:
    def __init__(self, content='', tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.additional_kwargs = additional_kwargs or {}


def _install_stubs():
    global _STUBS_INSTALLED
    if _STUBS_INSTALLED:
        return

    def _mod(name):
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m

    depends_mod = _mod('depends')
    depends_mod.depends = lambda *a, **kw: None

    rocketlib = _mod('rocketlib')
    rocketlib.ToolDescriptor = object

    ai = _mod('ai')
    ai_common = _mod('ai.common')
    ai.common = ai_common

    ai_agent = _mod('ai.common.agent')
    ai_common.agent = ai_agent
    ai_agent.AgentBase = object
    ai_agent.AgentContext = object

    ai_agent_types = _mod('ai.common.agent.types')
    ai_agent.types = ai_agent_types
    ai_agent_types.AgentRunResult = object

    ai_schema = _mod('ai.common.schema')
    ai_common.schema = ai_schema
    ai_schema.Question = object

    ai_utils = _mod('ai.common.utils')
    ai_common.utils = ai_utils
    ai_utils.langchain_messages_to_transcript = lambda *a, **kw: ''
    ai_utils.normalize_bound_tools = lambda *a, **kw: []
    ai_utils.safe_str = str

    # langchain_core stubs — also used inside _parse_tool_call_envelope
    lc = _mod('langchain_core')
    lc_msgs = _mod('langchain_core.messages')
    lc.messages = lc_msgs
    lc_msgs.AIMessage = _FakeAIMessage

    lc_lm = _mod('langchain_core.language_models')
    lc.language_models = lc_lm
    lc_lm.BaseChatModel = object

    lc_out = _mod('langchain_core.outputs')
    lc.outputs = lc_out
    lc_out.ChatGeneration = object
    lc_out.ChatResult = object

    lc_tools = _mod('langchain_core.tools')
    lc.tools = lc_tools
    lc_tools.BaseTool = object

    lc_agents = _mod('langchain.agents')
    _mod('langchain')
    lc_agents.AgentExecutor = object

    _STUBS_INSTALLED = True


_install_stubs()

# Load langchain.py directly by file path to bypass the package __init__.py
# chain, which pulls in the full engine runtime (rocketlib, IGlobal, etc.).
_LANGCHAIN_FILE = _NODES_SRC / 'nodes' / 'agent_langchain' / 'langchain.py'
_spec = importlib.util.spec_from_file_location('_agent_langchain_langchain', _LANGCHAIN_FILE)
_langchain_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_langchain_mod)
_parse = _langchain_mod._parse_tool_call_envelope


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_clean_tool_call():
    raw = '{"type":"tool_call","name":"srv.do_thing","args":{"x":1}}'
    msg = _parse(raw)
    assert msg is not None
    assert isinstance(msg, _FakeAIMessage)
    assert len(msg.tool_calls) == 1
    tc = msg.tool_calls[0]
    assert tc['name'] == 'srv.do_thing'
    assert tc['args'] == {'x': 1}


def test_clean_final():
    raw = '{"type":"final","content":"All done."}'
    msg = _parse(raw)
    assert msg is not None
    assert isinstance(msg, _FakeAIMessage)
    assert msg.content == 'All done.'
    assert msg.tool_calls == []


def test_preamble_before_tool_call():
    raw = (
        'I\'d be happy to help! Let me list the labels first.\n{"type":"tool_call","name":"gmail.label_list","args":{}}'
    )
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['name'] == 'gmail.label_list'


def test_preamble_before_final():
    raw = 'Sure, here is the result:\n{"type":"final","content":"ok"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.content == 'ok'


def test_markdown_fence_tool_call():
    raw = '```json\n{"type":"tool_call","name":"t","args":{}}\n```'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['name'] == 't'


def test_trailing_text_ignored():
    raw = '{"type":"final","content":"done"} Here is my explanation.'
    msg = _parse(raw)
    assert msg is not None
    assert msg.content == 'done'


def test_no_json_returns_none():
    assert _parse('not json at all') is None


def test_empty_string_returns_none():
    assert _parse('') is None


def test_no_opening_brace_returns_none():
    assert _parse('["array", "not", "object"]') is None


def test_unknown_type_returns_none():
    raw = '{"type":"unknown","data":"x"}'
    assert _parse(raw) is None


def test_tool_call_missing_name_returns_none():
    raw = '{"type":"tool_call","name":"","args":{}}'
    assert _parse(raw) is None


def test_tool_call_args_defaults_to_empty_dict():
    raw = '{"type":"tool_call","name":"srv.ping"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {}
