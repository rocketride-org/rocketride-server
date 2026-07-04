# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for _parse_tool_call_envelope in agent_langchain/langchain.py.

Stubs are installed non-destructively (never overwriting real modules already in
sys.modules), and engine stubs are cleaned up after langchain.py is loaded so
they don't leak into other test modules sharing the same session.
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


class _FakeAIMessage:
    def __init__(self, content='', tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.additional_kwargs = additional_kwargs or {}


# Snapshot sys.modules BEFORE any stubs so we know exactly what we add.
_PRE_STUB = frozenset(sys.modules)


def _mod_if_absent(name):
    """Register a stub module only if name is not already in sys.modules."""
    if name not in sys.modules:
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m
    return sys.modules[name]


def _install_stubs():
    # Engine runtime stubs — only needed while exec'ing langchain.py's top-level
    # imports. Removed after loading (see cleanup block below).
    depends_mod = _mod_if_absent('depends')
    if not hasattr(depends_mod, 'depends'):
        depends_mod.depends = lambda *a, **kw: None

    rocketlib = _mod_if_absent('rocketlib')
    if not hasattr(rocketlib, 'ToolDescriptor'):
        rocketlib.ToolDescriptor = object

    ai = _mod_if_absent('ai')
    ai_common = _mod_if_absent('ai.common')
    if not hasattr(ai, 'common'):
        ai.common = ai_common

    ai_agent = _mod_if_absent('ai.common.agent')
    if not hasattr(ai_common, 'agent'):
        ai_common.agent = ai_agent
    if not hasattr(ai_agent, 'AgentBase'):
        ai_agent.AgentBase = object
    if not hasattr(ai_agent, 'AgentContext'):
        ai_agent.AgentContext = object

    ai_agent_types = _mod_if_absent('ai.common.agent.types')
    if not hasattr(ai_agent, 'types'):
        ai_agent.types = ai_agent_types
    if not hasattr(ai_agent_types, 'AgentRunResult'):
        ai_agent_types.AgentRunResult = object

    ai_schema = _mod_if_absent('ai.common.schema')
    if not hasattr(ai_common, 'schema'):
        ai_common.schema = ai_schema
    if not hasattr(ai_schema, 'Question'):
        ai_schema.Question = object

    ai_utils = _mod_if_absent('ai.common.utils')
    if not hasattr(ai_common, 'utils'):
        ai_common.utils = ai_utils
    if not hasattr(ai_utils, 'langchain_messages_to_transcript'):
        ai_utils.langchain_messages_to_transcript = lambda *a, **kw: ''
    if not hasattr(ai_utils, 'normalize_bound_tools'):
        ai_utils.normalize_bound_tools = lambda *a, **kw: []
    if not hasattr(ai_utils, 'safe_str'):
        ai_utils.safe_str = str

    # langchain_core stubs — kept in sys.modules at call time because
    # _parse_tool_call_envelope imports AIMessage inside the function body.
    # In CI, langchain-core is installed (agent_langchain/requirements.txt),
    # so _mod_if_absent won't install stubs there and there's nothing to clean.
    lc = _mod_if_absent('langchain_core')
    lc_msgs = _mod_if_absent('langchain_core.messages')
    if not hasattr(lc, 'messages'):
        lc.messages = lc_msgs
    if not hasattr(lc_msgs, 'AIMessage'):
        lc_msgs.AIMessage = _FakeAIMessage

    lc_lm = _mod_if_absent('langchain_core.language_models')
    if not hasattr(lc, 'language_models'):
        lc.language_models = lc_lm
    if not hasattr(lc_lm, 'BaseChatModel'):
        lc_lm.BaseChatModel = object

    lc_out = _mod_if_absent('langchain_core.outputs')
    if not hasattr(lc, 'outputs'):
        lc.outputs = lc_out
    if not hasattr(lc_out, 'ChatGeneration'):
        lc_out.ChatGeneration = object
    if not hasattr(lc_out, 'ChatResult'):
        lc_out.ChatResult = object

    lc_tools = _mod_if_absent('langchain_core.tools')
    if not hasattr(lc, 'tools'):
        lc.tools = lc_tools
    if not hasattr(lc_tools, 'BaseTool'):
        lc_tools.BaseTool = object

    lc_agents = _mod_if_absent('langchain.agents')
    _mod_if_absent('langchain')
    if not hasattr(lc_agents, 'AgentExecutor'):
        lc_agents.AgentExecutor = object


_install_stubs()

# Load langchain.py directly by file path to bypass the package __init__.py
# chain, which pulls in the full engine runtime (rocketlib, IGlobal, etc.).
_LANGCHAIN_FILE = _NODES_SRC / 'nodes' / 'agent_langchain' / 'langchain.py'
_spec = importlib.util.spec_from_file_location('_agent_langchain_langchain', _LANGCHAIN_FILE)
_langchain_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_langchain_mod)
_parse = _langchain_mod._parse_tool_call_envelope

# Remove engine stubs we installed — they're not needed at call time and must
# not shadow the real rocketlib/ai modules for other tests in the same session.
_ENGINE_PREFIXES = ('rocketlib', 'ai', 'depends')
for _name in list(sys.modules):
    if _name not in _PRE_STUB and any(_name == p or _name.startswith(p + '.') for p in _ENGINE_PREFIXES):
        sys.modules.pop(_name, None)


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


def test_tool_call_non_dict_args_wrapped_in_input():
    # Scalar / list args are wrapped as {'input': value} rather than dropped.
    raw = '{"type":"tool_call","name":"srv.echo","args":"hello"}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {'input': 'hello'}

    raw = '{"type":"tool_call","name":"srv.echo","args":[1, 2]}'
    msg = _parse(raw)
    assert msg is not None
    assert msg.tool_calls[0]['args'] == {'input': [1, 2]}
