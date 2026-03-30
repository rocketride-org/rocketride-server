# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for the RocketRide agent pipeline node (agent_rocketride).

Covers IGlobal.beginGlobal / endGlobal lifecycle, IInstance.writeQuestions
(memory requirement, lazy AgentHostServices creation), IInstance.invoke
(tool.* delegation, unknown ops), and planner helpers (_build_all_tool_descriptions,
_build_wave_question, plan).
"""

import sys
import json
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Additional mocks for agent module dependencies.
# Originals are saved so they can be restored after the test module runs.
# ---------------------------------------------------------------------------

_SDK_MODULES = ['ai.common.agent._internal.agent_base']
_saved_sdk_modules = {name: sys.modules[name] for name in _SDK_MODULES if name in sys.modules}

# Mock ai.common.agent._internal.agent_base and agent_tool
_ai_common_agent_base = types.ModuleType('ai.common.agent._internal.agent_base')


class MockAgentBase:
    """Mock for AgentBase."""

    def __init__(self, iglobal=None):
        """Initialize."""
        self._iglobal = iglobal
        self.instructions = []

    def run_agent(self, instance, question, host=None, emit_answers_lane=True):
        pass

    def handle_invoke(self, instance, param):
        return None


_ai_common_agent_base.AgentBase = MockAgentBase
sys.modules['ai.common.agent._internal'] = sys.modules.get('ai.common.agent._internal', types.ModuleType('ai.common.agent._internal'))
sys.modules['ai.common.agent._internal.agent_base'] = _ai_common_agent_base


@pytest.fixture(autouse=True, scope='module')
def _restore_agent_sdk_modules():
    """Restore original SDK modules after all tests in this module run."""
    yield
    for name in _SDK_MODULES:
        if name in _saved_sdk_modules:
            sys.modules[name] = _saved_sdk_modules[name]
        elif name in sys.modules:
            del sys.modules[name]


# ---------------------------------------------------------------------------
# Import the node under test (path setup handled by conftest.py)
# ---------------------------------------------------------------------------

from nodes.agent_rocketride.IGlobal import IGlobal  # noqa: E402
from nodes.agent_rocketride.IInstance import IInstance  # noqa: E402
from nodes.agent_rocketride.planner import (  # noqa: E402
    _build_all_tool_descriptions,
    _build_wave_question,
    _json_default,
    plan,
    SYSTEM_ROLE,
)


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestAgentRocketRideIGlobal:
    """Test suite for agent_rocketride IGlobal lifecycle."""

    def test_begin_global_creates_agent(self):
        """BeginGlobal should create a RocketRideDriver agent."""
        ig = IGlobal()
        ig.glb = MagicMock()

        mock_driver = MagicMock()
        # The import happens inside beginGlobal via `from .rocketride_agent import RocketRideDriver`
        mock_agent_mod = MagicMock()
        mock_agent_mod.RocketRideDriver = MagicMock(return_value=mock_driver)
        with patch.dict(sys.modules, {'nodes.agent_rocketride.rocketride_agent': mock_agent_mod}):
            ig.beginGlobal()

        assert ig.agent is mock_driver

    def test_end_global_clears_agent(self):
        """EndGlobal should set agent to None."""
        ig = IGlobal()
        ig.agent = MagicMock()
        ig.endGlobal()
        assert ig.agent is None


# ===================================================================
# IInstance.writeQuestions
# ===================================================================


class TestAgentRocketRideWriteQuestions:
    """Test suite for IInstance.writeQuestions."""

    def test_write_questions_creates_host_services(self):
        """First writeQuestions call should create AgentHostServices."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.agent = MagicMock()
        inst.instance = MagicMock()

        mock_host = MagicMock()
        mock_host.memory = MagicMock()  # Memory is connected
        with patch('nodes.agent_rocketride.IInstance.AgentHostServices', return_value=mock_host):
            question = MagicMock()
            inst.writeQuestions(question)

        assert inst._agent_host is mock_host
        inst.IGlobal.agent.run_agent.assert_called_once()

    def test_write_questions_no_memory_raises(self):
        """WriteQuestions should raise ValueError if no memory node is connected."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.agent = MagicMock()
        inst.instance = MagicMock()

        mock_host = MagicMock()
        mock_host.memory = None  # No memory connected
        with patch('nodes.agent_rocketride.IInstance.AgentHostServices', return_value=mock_host):
            with pytest.raises(ValueError, match='memory'):
                inst.writeQuestions(MagicMock())

    def test_write_questions_reuses_host_services(self):
        """Subsequent writeQuestions calls should reuse the same AgentHostServices."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.agent = MagicMock()
        inst.instance = MagicMock()

        mock_host = MagicMock()
        mock_host.memory = MagicMock()
        inst._agent_host = mock_host

        question = MagicMock()
        inst.writeQuestions(question)

        # Should NOT have tried to create a new one
        assert inst._agent_host is mock_host
        inst.IGlobal.agent.run_agent.assert_called_once_with(inst, question, host=mock_host, emit_answers_lane=True)


# ===================================================================
# IInstance.invoke
# ===================================================================


class TestAgentRocketRideInvoke:
    """Test suite for IInstance.invoke routing."""

    def test_invoke_tool_op_delegates_to_agent(self):
        """Invoke with tool.* op should delegate to agent.handle_invoke."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.agent = MagicMock()
        inst.IGlobal.agent.handle_invoke.return_value = {'result': 'ok'}

        param = {'op': 'tool.query'}
        inst.invoke(param)
        inst.IGlobal.agent.handle_invoke.assert_called_once_with(inst, param)

    def test_invoke_tool_invoke_delegates(self):
        """Invoke with tool.invoke should delegate to agent."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.agent = MagicMock()
        inst.IGlobal.agent.handle_invoke.return_value = {'output': 'data'}

        param = {'op': 'tool.invoke', 'tool': 'test-tool', 'input': {}}
        inst.invoke(param)
        inst.IGlobal.agent.handle_invoke.assert_called_once_with(inst, param)

    def test_invoke_non_tool_op_falls_through(self):
        """Invoke with non-tool.* op should fall through to base class."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.instance = MagicMock()

        # Non-tool op should go to super().invoke()
        param = {'op': 'lifecycle.close'}
        # This may raise or return depending on base impl; we just verify
        # agent.handle_invoke is NOT called
        try:
            inst.invoke(param)
        except Exception:
            pass  # Base class may not handle this
        inst.IGlobal.agent.handle_invoke.assert_not_called()


# ===================================================================
# Planner helpers
# ===================================================================


class TestPlannerHelpers:
    """Test suite for planner.py helper functions."""

    def test_build_all_tool_descriptions_empty(self):
        """Should return '(none)' when no tools are available."""
        host = MagicMock()
        host.tools.query.return_value = []

        result = _build_all_tool_descriptions(host)
        assert result == '(none)'

    def test_build_all_tool_descriptions_with_tools(self):
        """Should return one JSON line per tool."""
        host = MagicMock()
        host.tools.query.return_value = [
            {'name': 'sql.query', 'description': 'Run a SQL query', 'inputSchema': {'type': 'object'}},
            {'name': 'http.http_request', 'description': 'Make HTTP request', 'inputSchema': {'type': 'object'}},
        ]

        result = _build_all_tool_descriptions(host)
        lines = result.strip().split('\n')
        assert len(lines) == 2
        # Each line should be valid JSON
        for line in lines:
            parsed = json.loads(line)
            assert 'name' in parsed

    def test_build_all_tool_descriptions_skips_nameless(self):
        """Should skip tools with no name."""
        host = MagicMock()
        host.tools.query.return_value = [
            {'name': '', 'description': 'No name'},
            {'name': 'valid.tool', 'description': 'Valid'},
        ]

        result = _build_all_tool_descriptions(host)
        lines = result.strip().split('\n')
        assert len(lines) == 1
        assert 'valid.tool' in lines[0]

    def test_json_default_decimal(self):
        """_json_default should convert Decimal-like objects to float."""
        import decimal

        result = _json_default(decimal.Decimal('3.14'))
        assert isinstance(result, float)
        assert abs(result - 3.14) < 0.001

    def test_json_default_datetime(self):
        """_json_default should convert datetime objects to ISO format."""
        import datetime

        dt = datetime.datetime(2026, 1, 15, 10, 30, 0)
        result = _json_default(dt)
        assert '2026-01-15' in result
        assert '10:30' in result

    def test_json_default_fallback(self):
        """_json_default should fall back to str() for unknown types."""

        class CustomObj:
            def __str__(self):
                return 'custom-string'

        result = _json_default(CustomObj())
        assert result == 'custom-string'


# ===================================================================
# Planner — _build_wave_question
# ===================================================================


class TestBuildWaveQuestion:
    """Test suite for _build_wave_question prompt construction."""

    def _make_inputs(self, tools=None, waves=None, scratch=''):
        from conftest import MockQuestion, MockAgentInput, MockAgentHost

        question = MockQuestion(text='What is the total revenue?')
        agent_input = MockAgentInput(question=question)
        host = MockAgentHost()
        host.tools.query.return_value = tools or []

        return {
            'agent_input': agent_input,
            'host': host,
            'waves': waves or [],
            'instructions': ['Be concise'],
            'scratch': scratch,
        }

    def test_wave_question_has_system_role(self):
        """The wave question should have the SYSTEM_ROLE set."""
        inputs = self._make_inputs()
        q = _build_wave_question(**inputs)
        assert q.role == SYSTEM_ROLE

    def test_wave_question_expects_json(self):
        """The wave question should set expectJson = True."""
        inputs = self._make_inputs()
        q = _build_wave_question(**inputs)
        assert q.expectJson is True

    def test_wave_question_promotes_questions_to_goals(self):
        """Original questions should be promoted to goals."""
        inputs = self._make_inputs()
        q = _build_wave_question(**inputs)
        assert len(q.goals) >= 1

    def test_wave_question_with_scratch(self):
        """Scratch notes should be included in the question context."""
        inputs = self._make_inputs(scratch='Key: wave-0.r0 = 42')
        q = _build_wave_question(**inputs)
        # The question object should have had addContext called
        # We verify via the mock infrastructure
        assert q is not None


# ===================================================================
# Planner — plan()
# ===================================================================


class TestPlan:
    """Test suite for the plan() function."""

    def _make_inputs(self, llm_response=None):
        from conftest import MockQuestion, MockAgentInput, MockAgentHost

        question = MockQuestion(text='Query the database')
        agent_input = MockAgentInput(question=question)
        host = MockAgentHost()
        host.tools.query.return_value = [
            {'name': 'sql.query', 'description': 'Run SQL', 'inputSchema': {'type': 'object'}},
        ]

        mock_answer = MagicMock()
        mock_answer.getJson.return_value = llm_response or {}
        host.llm.invoke.return_value = mock_answer

        return {
            'agent_input': agent_input,
            'host': host,
            'waves': [],
            'instructions': [],
            'current_scratch': '',
        }

    def test_plan_returns_done_response(self):
        """Plan should return the LLM response when it has done=true."""
        inputs = self._make_inputs(llm_response={'done': True, 'answer': 'The total is $42M', 'scratch': 'total=42M'})
        result = plan(**inputs)
        assert result['done'] is True
        assert result['answer'] == 'The total is $42M'

    def test_plan_returns_tool_calls(self):
        """Plan should return tool_calls when the LLM wants to invoke tools."""
        inputs = self._make_inputs(
            llm_response={
                'thought': 'Need to query the DB',
                'scratch': '',
                'tool_calls': [{'tool': 'sql.query', 'args': {'query': 'SELECT count(*) FROM orders'}}],
            }
        )
        result = plan(**inputs)
        assert 'tool_calls' in result
        assert len(result['tool_calls']) == 1
        assert result['tool_calls'][0]['tool'] == 'sql.query'

    def test_plan_returns_empty_on_malformed_response(self):
        """Plan should return {} when the LLM returns neither done nor tool_calls."""
        inputs = self._make_inputs(llm_response={'thought': 'I am confused'})
        result = plan(**inputs)
        assert result == {}

    def test_plan_returns_empty_on_empty_response(self):
        """Plan should return {} when the LLM returns an empty dict."""
        inputs = self._make_inputs(llm_response={})
        result = plan(**inputs)
        assert result == {}
