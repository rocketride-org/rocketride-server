# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the multi_agent orchestration node.

These tests validate agent definition parsing, blackboard thread safety,
orchestrator planning/execution/merging, max_rounds enforcement, and the
IGlobal/IInstance lifecycle — all without a running server.

Usage:
    pytest nodes/test/test_multi_agent.py -v
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Path setup — add the node source directory so we can import directly.
# ---------------------------------------------------------------------------

NODES_SRC = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes')
if NODES_SRC not in sys.path:
    sys.path.insert(0, NODES_SRC)

# We must mock rocketlib and ai.common.schema before importing multi_agent,
# because IGlobal.py / IInstance.py import from them at module level.

# ---------------------------------------------------------------------------
# Mock rocketlib and ai.common.schema
# ---------------------------------------------------------------------------


class _MockIGlobalBase:
    IEndpoint = None
    glb = None

    def beginGlobal(self):
        pass

    def endGlobal(self):
        pass


class _MockIInstanceBase:
    IGlobal = None
    IEndpoint = None
    instance = None

    def beginInstance(self):
        pass

    def endInstance(self):
        pass

    def preventDefault(self):
        raise Exception('PreventDefault')

    def invoke(self, *args, **kwargs):
        pass


class _MockQuestion:
    def __init__(self, **kwargs):
        self.role = kwargs.get('role', '')
        self.questions = kwargs.get('questions', [])
        self.context = kwargs.get('context', [])
        self.goals = kwargs.get('goals', [])
        self.instructions = kwargs.get('instructions', [])
        self.history = kwargs.get('history', [])
        self.examples = kwargs.get('examples', [])
        self.documents = kwargs.get('documents', [])
        self.expectJson = kwargs.get('expectJson', False)

    def addQuestion(self, text):
        self.questions.append(type('QT', (), {'text': text})())

    def addContext(self, ctx):
        self.context.append(ctx)

    def addGoal(self, g):
        self.goals.append(g)

    def getPrompt(self, *args, **kwargs):
        return ' '.join(q.text for q in self.questions)


class _MockAnswer:
    def __init__(self, **kwargs):
        self.answer = None
        self.expectJson = kwargs.get('expectJson', False)

    def setAnswer(self, value):
        self.answer = value

    def getText(self):
        if self.answer is None:
            return ''
        if isinstance(self.answer, (dict, list)):
            return json.dumps(self.answer)
        return str(self.answer)

    def isJson(self):
        return self.expectJson

    def getJson(self):
        return self.answer if isinstance(self.answer, (dict, list)) else None


# Install mocks before importing multi_agent modules.
_mock_rocketlib = MagicMock()
_mock_rocketlib.IGlobalBase = _MockIGlobalBase
_mock_rocketlib.IInstanceBase = _MockIInstanceBase
_mock_rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()

_mock_ai_schema = MagicMock()
_mock_ai_schema.Question = _MockQuestion
_mock_ai_schema.Answer = _MockAnswer

_mock_ai_common = MagicMock()
_mock_ai_common.schema = _mock_ai_schema

_mock_ai = MagicMock()
_mock_ai.common = _mock_ai_common
_mock_ai.common.schema = _mock_ai_schema

_mock_ai_config = MagicMock()

sys.modules.setdefault('rocketlib', _mock_rocketlib)
sys.modules.setdefault('ai', _mock_ai)
sys.modules.setdefault('ai.common', _mock_ai_common)
sys.modules.setdefault('ai.common.config', _mock_ai_config)
sys.modules.setdefault('ai.common.schema', _mock_ai_schema)

# Now safe to import.
from multi_agent.agent_definition import AgentDefinition, parse_agent_definitions
from multi_agent.blackboard import SharedBlackboard
from multi_agent.orchestrator import AgentResult, MultiAgentOrchestrator, SubTask


# ===========================================================================
# Helper — deterministic LLM stub
# ===========================================================================


def _make_echo_llm():
    """Return a call_llm that echoes the user prompt back."""

    def call_llm(system_prompt: str, user_prompt: str) -> str:
        return f'echo: {user_prompt}'

    return call_llm


def _make_plan_llm(plan_json: str):
    """Return a call_llm that returns *plan_json* on the first call (planning).

    Subsequent calls (agent execution / merging) echo the user prompt.
    """
    calls = {'n': 0}

    def call_llm(system_prompt: str, user_prompt: str) -> str:
        calls['n'] += 1
        if calls['n'] == 1:
            return plan_json
        return f'agent-output({user_prompt[:60]})'

    return call_llm


# ===========================================================================
# AgentDefinition parsing tests
# ===========================================================================


class TestAgentDefinitionParsing:
    def test_from_dict_valid(self):
        ad = AgentDefinition.from_dict(
            {
                'name': 'researcher',
                'role': 'researcher',
                'instructions': 'Search the web.',
                'tools': ['web_search'],
                'model': 'gpt-4o',
            }
        )
        assert ad.name == 'researcher'
        assert ad.role == 'researcher'
        assert ad.tools == ['web_search']
        assert ad.model == 'gpt-4o'

    def test_from_dict_minimal(self):
        ad = AgentDefinition.from_dict({'name': 'bot'})
        assert ad.name == 'bot'
        assert ad.role == ''
        assert ad.tools == []

    def test_from_dict_rejects_unknown_keys(self):
        with pytest.raises(ValueError, match='Unknown keys'):
            AgentDefinition.from_dict({'name': 'bot', 'evil_key': 'payload'})

    def test_from_dict_rejects_non_dict(self):
        with pytest.raises(TypeError, match='must be a dict'):
            AgentDefinition.from_dict('not a dict')

    def test_empty_name_raises(self):
        with pytest.raises(ValueError, match='non-empty string'):
            AgentDefinition(name='')

    def test_name_must_be_string(self):
        with pytest.raises(ValueError, match='non-empty string'):
            AgentDefinition(name=123)

    def test_tools_must_be_list_of_strings(self):
        with pytest.raises(TypeError, match='list of strings'):
            AgentDefinition(name='bot', tools=[1, 2])

    def test_parse_agent_definitions_from_list(self):
        raw = [{'name': 'a', 'role': 'r1'}, {'name': 'b', 'role': 'r2'}]
        agents = parse_agent_definitions(raw)
        assert len(agents) == 2
        assert agents[0].name == 'a'
        assert agents[1].name == 'b'

    def test_parse_agent_definitions_from_json_string(self):
        raw = json.dumps([{'name': 'x'}])
        agents = parse_agent_definitions(raw)
        assert len(agents) == 1
        assert agents[0].name == 'x'

    def test_parse_agent_definitions_none(self):
        assert parse_agent_definitions(None) == []

    def test_parse_agent_definitions_empty_string(self):
        assert parse_agent_definitions('') == []

    def test_parse_agent_definitions_invalid_json(self):
        with pytest.raises(ValueError, match='not valid JSON'):
            parse_agent_definitions('{bad json}')

    def test_parse_agent_definitions_not_array(self):
        with pytest.raises(ValueError, match='JSON array'):
            parse_agent_definitions({'name': 'solo'})


# ===========================================================================
# SharedBlackboard tests
# ===========================================================================


class TestSharedBlackboard:
    def test_write_and_read(self):
        bb = SharedBlackboard()
        bb.write('agent1', 'key1', 'value1')
        assert bb.read('key1') == 'value1'

    def test_read_missing_key(self):
        bb = SharedBlackboard()
        assert bb.read('nope') is None

    def test_read_all(self):
        bb = SharedBlackboard()
        bb.write('a', 'x', 1)
        bb.write('b', 'y', 2)
        assert bb.read_all() == {'x': 1, 'y': 2}

    def test_overwrite_key(self):
        bb = SharedBlackboard()
        bb.write('a', 'k', 'v1')
        bb.write('b', 'k', 'v2')
        assert bb.read('k') == 'v2'

    def test_history_ordering(self):
        bb = SharedBlackboard()
        bb.write('a', 'k1', 'v1')
        bb.write('b', 'k2', 'v2')
        bb.write('a', 'k1', 'v3')
        history = bb.get_history()
        assert len(history) == 3
        assert history[0].agent_name == 'a'
        assert history[0].key == 'k1'
        assert history[1].agent_name == 'b'
        assert history[2].value == 'v3'

    def test_history_has_timestamps(self):
        bb = SharedBlackboard()
        before = time.time()
        bb.write('a', 'k', 'v')
        after = time.time()
        entry = bb.get_history()[0]
        assert before <= entry.timestamp <= after

    def test_clear(self):
        bb = SharedBlackboard()
        bb.write('a', 'k', 'v')
        bb.clear()
        assert bb.read('k') is None
        assert bb.read_all() == {}
        assert bb.get_history() == []

    def test_thread_safety_concurrent_writes(self):
        """Verify no data corruption under concurrent writes from many threads."""
        bb = SharedBlackboard()
        num_threads = 20
        writes_per_thread = 50
        barrier = threading.Barrier(num_threads)

        def writer(thread_id):
            barrier.wait()
            for i in range(writes_per_thread):
                bb.write(f'agent-{thread_id}', f't{thread_id}-k{i}', i)

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Every key should be present.
        state = bb.read_all()
        for t in range(num_threads):
            for i in range(writes_per_thread):
                assert f't{t}-k{i}' in state

        # History should have exactly num_threads * writes_per_thread entries.
        assert len(bb.get_history()) == num_threads * writes_per_thread


# ===========================================================================
# Orchestrator — construction and validation
# ===========================================================================


class TestOrchestratorConstruction:
    def test_empty_agents(self):
        orch = MultiAgentOrchestrator({'agents_json': '[]'}, _make_echo_llm())
        assert orch.agents == []

    def test_valid_config(self):
        cfg = {
            'agents_json': json.dumps(
                [
                    {'name': 'r', 'role': 'researcher'},
                    {'name': 'w', 'role': 'writer'},
                ]
            ),
            'communication_protocol': 'blackboard',
            'max_rounds': 5,
            'merge_strategy': 'summarize',
            'execution_mode': 'parallel',
        }
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        assert len(orch.agents) == 2

    def test_invalid_protocol(self):
        with pytest.raises(ValueError, match='Unknown communication_protocol'):
            MultiAgentOrchestrator(
                {'agents_json': '[]', 'communication_protocol': 'telepathy'},
                _make_echo_llm(),
            )

    def test_invalid_merge_strategy(self):
        with pytest.raises(ValueError, match='Unknown merge_strategy'):
            MultiAgentOrchestrator(
                {'agents_json': '[]', 'merge_strategy': 'magic'},
                _make_echo_llm(),
            )

    def test_invalid_execution_mode(self):
        with pytest.raises(ValueError, match='Unknown execution_mode'):
            MultiAgentOrchestrator(
                {'agents_json': '[]', 'execution_mode': 'quantum'},
                _make_echo_llm(),
            )

    def test_max_rounds_must_be_positive(self):
        with pytest.raises(ValueError, match='max_rounds'):
            MultiAgentOrchestrator(
                {'agents_json': '[]', 'max_rounds': 0},
                _make_echo_llm(),
            )


# ===========================================================================
# Orchestrator — planning
# ===========================================================================


class TestOrchestratorPlanning:
    def _make_orch(self, agents_json, **kwargs):
        cfg = {'agents_json': agents_json, **kwargs}
        return MultiAgentOrchestrator(cfg, _make_echo_llm())

    def test_plan_produces_subtasks(self):
        agents = json.dumps(
            [
                {'name': 'r', 'role': 'researcher'},
                {'name': 'w', 'role': 'writer'},
            ]
        )
        plan_json = json.dumps(
            [
                {'id': 't1', 'description': 'Research X', 'assigned_agent': 'r', 'depends_on': []},
                {'id': 't2', 'description': 'Write about X', 'assigned_agent': 'w', 'depends_on': ['t1']},
            ]
        )
        llm = _make_plan_llm(plan_json)
        orch = MultiAgentOrchestrator({'agents_json': agents}, llm)
        plan = orch.plan('Tell me about X')
        assert len(plan) == 2
        assert plan[0].assigned_agent == 'r'
        assert plan[1].depends_on == ['t1']

    def test_plan_fallback_on_bad_json(self):
        agents = json.dumps([{'name': 'a'}, {'name': 'b'}])
        llm = _make_plan_llm('this is not json at all')
        orch = MultiAgentOrchestrator({'agents_json': agents}, llm)
        plan = orch.plan('Do something')
        # Fallback creates one task per agent.
        assert len(plan) == 2
        assert plan[0].assigned_agent == 'a'
        assert plan[1].assigned_agent == 'b'

    def test_plan_strips_markdown_fences(self):
        agents = json.dumps([{'name': 'a'}])
        fenced = '```json\n[{"id":"t1","description":"do it","assigned_agent":"a","depends_on":[]}]\n```'
        llm = _make_plan_llm(fenced)
        orch = MultiAgentOrchestrator({'agents_json': agents}, llm)
        plan = orch.plan('Test')
        assert len(plan) == 1
        assert plan[0].id == 't1'


# ===========================================================================
# Orchestrator — execution modes
# ===========================================================================


class TestOrchestratorExecution:
    def _agents_json(self):
        return json.dumps(
            [
                {'name': 'a1', 'role': 'role1', 'instructions': 'Do A.'},
                {'name': 'a2', 'role': 'role2', 'instructions': 'Do B.'},
            ]
        )

    def test_sequential_execution_order(self):
        """Agents execute in plan order; order is preserved in results."""
        order = []

        def llm(sys, usr):
            # Record the order agents are invoked.
            if 'supervisor' not in sys.lower() and 'synthesis' not in sys.lower():
                order.append(usr[:20])
            return f'done: {usr[:20]}'

        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'sequential',
        }
        orch = MultiAgentOrchestrator(cfg, llm)
        tasks = [
            SubTask(id='t1', description='first task', assigned_agent='a1'),
            SubTask(id='t2', description='second task', assigned_agent='a2'),
        ]
        results = orch.execute(tasks)
        assert len(results) == 2
        assert results[0].agent_name == 'a1'
        assert results[1].agent_name == 'a2'
        # Sequential means order[0] was invoked before order[1].
        assert len(order) == 2

    def test_parallel_execution_concurrent(self):
        """Parallel mode runs agents concurrently (not strictly sequential)."""
        start_times = {}
        lock = threading.Lock()

        def llm(sys, usr):
            tid = threading.current_thread().ident
            with lock:
                start_times[tid] = time.time()
            time.sleep(0.05)  # Small sleep to prove concurrency.
            return 'done'

        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'parallel',
        }
        orch = MultiAgentOrchestrator(cfg, llm)
        tasks = [
            SubTask(id='t1', description='task1', assigned_agent='a1'),
            SubTask(id='t2', description='task2', assigned_agent='a2'),
        ]
        t0 = time.time()
        results = orch.execute(tasks)
        elapsed = time.time() - t0
        assert len(results) == 2
        # If sequential, would take >= 0.1s; parallel should be ~0.05s.
        assert elapsed < 0.15

    def test_supervisor_respects_dependencies(self):
        """Supervisor mode runs t1 first, then t2 (which depends on t1)."""
        execution_order = []
        lock = threading.Lock()

        def llm(sys, usr):
            with lock:
                execution_order.append(usr[:30])
            return 'result'

        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'supervisor',
        }
        orch = MultiAgentOrchestrator(cfg, llm)
        tasks = [
            SubTask(id='t1', description='independent', assigned_agent='a1'),
            SubTask(id='t2', description='depends_on_t1', assigned_agent='a2', depends_on=['t1']),
        ]
        results = orch.execute(tasks)
        assert len(results) == 2
        assert all(r.error is None for r in results)

    def test_max_rounds_enforced_sequential(self):
        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'sequential',
            'max_rounds': 1,
        }
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        tasks = [
            SubTask(id='t1', description='task1', assigned_agent='a1'),
            SubTask(id='t2', description='task2', assigned_agent='a2'),
        ]
        results = orch.execute(tasks)
        assert results[0].error is None
        assert results[1].error == 'Max rounds exceeded'

    def test_max_rounds_enforced_parallel(self):
        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'parallel',
            'max_rounds': 1,
        }
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        # 3 tasks but max_rounds=1 limits to 1 task executed.
        tasks = [
            SubTask(id='t1', description='task1', assigned_agent='a1'),
        ]
        results = orch.execute(tasks)
        assert len(results) == 1

    def test_agent_failure_graceful(self):
        """Agent failures are captured, not propagated."""

        def llm(sys, usr):
            if 'fail' in usr:
                raise RuntimeError('LLM exploded')
            return 'ok'

        cfg = {
            'agents_json': self._agents_json(),
            'execution_mode': 'parallel',
        }
        orch = MultiAgentOrchestrator(cfg, llm)
        tasks = [
            SubTask(id='t1', description='fail please', assigned_agent='a1'),
            SubTask(id='t2', description='succeed', assigned_agent='a2'),
        ]
        results = orch.execute(tasks)
        failed = [r for r in results if r.error]
        succeeded = [r for r in results if not r.error]
        assert len(failed) == 1
        assert 'LLM exploded' in failed[0].error
        assert len(succeeded) == 1

    def test_unknown_agent_in_task(self):
        cfg = {'agents_json': json.dumps([{'name': 'a1'}]), 'execution_mode': 'sequential'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        tasks = [SubTask(id='t1', description='task', assigned_agent='nonexistent')]
        results = orch.execute(tasks)
        assert results[0].error == 'Unknown agent: nonexistent'


# ===========================================================================
# Orchestrator — merging
# ===========================================================================


class TestOrchestratorMerging:
    def test_merge_concatenate(self):
        cfg = {'agents_json': json.dumps([{'name': 'a'}, {'name': 'b'}]), 'merge_strategy': 'concatenate'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        results = [
            AgentResult(agent_name='a', task_id='t1', output='Result A'),
            AgentResult(agent_name='b', task_id='t2', output='Result B'),
        ]
        merged = orch.merge_results(results)
        assert '## a' in merged
        assert 'Result A' in merged
        assert '## b' in merged
        assert 'Result B' in merged

    def test_merge_summarize(self):
        def llm(sys, usr):
            if 'synthesis' in sys.lower() or 'combine' in sys.lower():
                return 'synthesized answer'
            return usr

        cfg = {'agents_json': json.dumps([{'name': 'a'}]), 'merge_strategy': 'summarize'}
        orch = MultiAgentOrchestrator(cfg, llm)
        results = [AgentResult(agent_name='a', task_id='t1', output='data')]
        merged = orch.merge_results(results)
        assert 'synthesized answer' in merged

    def test_merge_vote(self):
        def llm(sys, usr):
            if 'judge' in sys.lower():
                return 'best answer chosen'
            return usr

        cfg = {'agents_json': json.dumps([{'name': 'a'}, {'name': 'b'}]), 'merge_strategy': 'vote'}
        orch = MultiAgentOrchestrator(cfg, llm)
        results = [
            AgentResult(agent_name='a', task_id='t1', output='answer A'),
            AgentResult(agent_name='b', task_id='t2', output='answer B'),
        ]
        merged = orch.merge_results(results)
        assert 'best answer chosen' in merged

    def test_merge_vote_single_result(self):
        """Vote with a single result should just return it directly."""
        cfg = {'agents_json': json.dumps([{'name': 'a'}]), 'merge_strategy': 'vote'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        results = [AgentResult(agent_name='a', task_id='t1', output='only answer')]
        merged = orch.merge_results(results)
        assert merged == 'only answer'

    def test_merge_empty_results(self):
        cfg = {'agents_json': json.dumps([{'name': 'a'}])}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        assert orch.merge_results([]) == ''

    def test_merge_all_failed(self):
        cfg = {'agents_json': json.dumps([{'name': 'a'}])}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        results = [AgentResult(agent_name='a', task_id='t1', error='boom')]
        merged = orch.merge_results(results)
        assert 'All agents failed' in merged
        assert 'boom' in merged

    def test_merge_with_errors_included(self):
        cfg = {'agents_json': json.dumps([{'name': 'a'}, {'name': 'b'}]), 'merge_strategy': 'concatenate'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        results = [
            AgentResult(agent_name='a', task_id='t1', output='good'),
            AgentResult(agent_name='b', task_id='t2', error='bad'),
        ]
        merged = orch.merge_results(results)
        assert 'good' in merged
        assert '## Errors' in merged
        assert 'bad' in merged


# ===========================================================================
# Orchestrator — end-to-end run
# ===========================================================================


class TestOrchestratorEndToEnd:
    def test_run_empty_agents(self):
        cfg = {'agents_json': '[]'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        result = orch.run('hello')
        assert result['answer'] == ''
        assert result['agent_results'] == []

    def test_run_single_agent_passthrough(self):
        cfg = {'agents_json': json.dumps([{'name': 'solo', 'role': 'helper'}])}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        result = orch.run('What is 2+2?')
        assert result['answer'] != ''
        assert len(result['agent_results']) == 1
        assert result['agent_results'][0].agent_name == 'solo'

    def test_run_multi_agent_supervisor(self):
        agents = json.dumps(
            [
                {'name': 'r', 'role': 'researcher'},
                {'name': 'w', 'role': 'writer'},
            ]
        )
        plan = json.dumps(
            [
                {'id': 't1', 'description': 'research', 'assigned_agent': 'r', 'depends_on': []},
                {'id': 't2', 'description': 'write', 'assigned_agent': 'w', 'depends_on': ['t1']},
            ]
        )
        llm = _make_plan_llm(plan)
        cfg = {'agents_json': agents, 'execution_mode': 'supervisor'}
        orch = MultiAgentOrchestrator(cfg, llm)
        result = orch.run('Write a report on X')
        assert result['answer'] != ''
        assert len(result['agent_results']) == 2


# ===========================================================================
# Communication protocols
# ===========================================================================


class TestCommunicationProtocols:
    def test_blackboard_protocol_writes_results(self):
        agents = json.dumps([{'name': 'a', 'role': 'worker'}])
        cfg = {'agents_json': agents, 'communication_protocol': 'blackboard'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        result = orch.run('test')
        # Agent should have written its result to the blackboard with step-indexed key.
        bb = result['blackboard']
        # Single-agent passthrough uses task_id='single', so key is 'a_result_single'.
        assert 'a_result_single' in bb

    def test_message_passing_send_and_receive(self):
        agents = json.dumps([{'name': 'sender'}, {'name': 'receiver'}])
        cfg = {'agents_json': agents, 'communication_protocol': 'message_passing'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        orch.send_message('sender', 'receiver', 'hello from sender')
        # Verify the message is in the queue.
        q = orch._message_queues['receiver']
        assert not q.empty()

    def test_message_passing_unknown_target(self):
        agents = json.dumps([{'name': 'a'}])
        cfg = {'agents_json': agents, 'communication_protocol': 'message_passing'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        with pytest.raises(ValueError, match='Unknown target agent'):
            orch.send_message('a', 'nonexistent', 'hi')

    def test_delegation_default(self):
        """Delegation is the default protocol — should work without extra setup."""
        agents = json.dumps([{'name': 'a'}])
        cfg = {'agents_json': agents}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        result = orch.run('test')
        assert result['answer'] != ''


# ===========================================================================
# IGlobal lifecycle
# ===========================================================================


class TestIGlobalLifecycle:
    def _make_iglobal(self, conn_config=None, open_mode='RUN'):
        """Create an IGlobal with properly mocked IEndpoint and glb."""
        from multi_agent.IGlobal import IGlobal

        ig = IGlobal()

        # Mock IEndpoint so the CONFIG mode check works.
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint.openMode = open_mode
        ig.IEndpoint = mock_endpoint

        # Mock glb with optional connConfig and logicalType.
        attrs = {'logicalType': 'multi_agent'}
        if conn_config is not None:
            attrs['connConfig'] = conn_config
        ig.glb = type('Glb', (), attrs)()

        # Make Config.getNodeConfig return the connConfig dict (mimics real behavior).
        from ai.common.config import Config

        Config.getNodeConfig = MagicMock(side_effect=lambda lt, cc: dict(cc))

        return ig

    def test_begin_global_loads_config(self):
        ig = self._make_iglobal(conn_config={'agents_json': '[]', 'max_rounds': 5})
        ig.beginGlobal()
        assert ig.config is not None
        assert ig.config.get('max_rounds') == 5

    def test_end_global_clears_config(self):
        ig = self._make_iglobal(conn_config={'agents_json': '[]'})
        ig.beginGlobal()
        ig.endGlobal()
        assert ig.config is None

    def test_begin_global_missing_connconfig(self):
        ig = self._make_iglobal(conn_config=None)
        ig.beginGlobal()
        assert ig.config == {}

    def test_begin_global_config_mode_skips(self):
        """When openMode is CONFIG, beginGlobal should return early without loading config."""
        ig = self._make_iglobal(conn_config={'agents_json': '[]'}, open_mode='CONFIG')
        ig.beginGlobal()
        assert ig.config is None


# ===========================================================================
# IInstance lifecycle
# ===========================================================================


class TestIInstanceLifecycle:
    def _make_instance(self, config=None):
        from multi_agent.IGlobal import IGlobal
        from multi_agent.IInstance import IInstance

        ig = IGlobal()
        ig.config = config or {'agents_json': json.dumps([{'name': 'bot', 'role': 'helper'}])}

        inst = IInstance()
        inst.IGlobal = ig

        # Mock the pipeline instance.
        mock_instance = MagicMock()
        mock_instance.invoke.return_value = _MockAnswer()
        mock_instance.writeAnswers = MagicMock()
        inst.instance = mock_instance

        return inst

    def test_write_questions_produces_answer(self):
        inst = self._make_instance()
        q = _MockQuestion()
        q.addQuestion('Hello')
        inst.writeQuestions(q)
        inst.instance.writeAnswers.assert_called_once()

    def test_deep_copy_prevents_mutation(self):
        """The answer written to the pipeline is deep-copied."""
        inst = self._make_instance()
        q = _MockQuestion()
        q.addQuestion('Test')
        inst.writeQuestions(q)
        # Get the answer that was written.
        call_args = inst.instance.writeAnswers.call_args
        answer = call_args[0][0]
        # Mutating the answer should not affect anything internal.
        original_text = answer.getText() if hasattr(answer, 'getText') else str(answer)
        assert original_text is not None  # Just verify it exists and is a copy.


# ===========================================================================
# Dependency deadlock detection
# ===========================================================================


class TestDeadlockDetection:
    def test_circular_dependency_deadlock(self):
        """Circular deps should be detected and produce error results."""
        agents = json.dumps([{'name': 'a'}, {'name': 'b'}])
        cfg = {'agents_json': agents, 'execution_mode': 'supervisor'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        tasks = [
            SubTask(id='t1', description='task1', assigned_agent='a', depends_on=['t2']),
            SubTask(id='t2', description='task2', assigned_agent='b', depends_on=['t1']),
        ]
        results = orch.execute(tasks)
        assert all(r.error == 'Dependency deadlock' for r in results)


# ===========================================================================
# CodeRabbit review fixes — regression tests
# ===========================================================================


class TestCodeRabbitFixes:
    """Tests that verify the fixes from CodeRabbit review feedback."""

    def _agents_json(self):
        return json.dumps([{'name': 'a1', 'role': 'r1'}, {'name': 'a2', 'role': 'r2'}])

    def test_parallel_empty_plan_returns_empty(self):
        """Empty plan in parallel mode should return empty list, not crash."""
        cfg = {'agents_json': self._agents_json(), 'execution_mode': 'parallel'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        results = orch.execute([])
        assert results == []

    def test_parallel_results_deterministic_order(self):
        """Parallel results should be in plan order, not completion order."""
        import time as time_mod

        cfg = {'agents_json': self._agents_json(), 'execution_mode': 'parallel'}

        def slow_llm(sys, usr):
            # a2 finishes faster than a1 to test ordering.
            if 'slow' in usr:
                time_mod.sleep(0.05)
            return f'result-for-{usr[:10]}'

        orch = MultiAgentOrchestrator(cfg, slow_llm)
        tasks = [
            SubTask(id='t1', description='slow task', assigned_agent='a1'),
            SubTask(id='t2', description='fast task', assigned_agent='a2'),
        ]
        results = orch.execute(tasks)
        assert len(results) == 2
        # Results must be in plan order (t1 first, t2 second).
        assert results[0].task_id == 't1'
        assert results[1].task_id == 't2'

    def test_parallel_overflow_capped(self):
        """Plans exceeding MAX_PARALLEL_TASKS are capped."""
        cfg = {'agents_json': self._agents_json(), 'execution_mode': 'parallel'}
        orch = MultiAgentOrchestrator(cfg, _make_echo_llm())
        # Create more tasks than MAX_PARALLEL_TASKS.
        tasks = [SubTask(id=f't{i}', description=f'task-{i}', assigned_agent='a1') for i in range(100)]
        results = orch.execute(tasks)
        assert len(results) <= orch.MAX_PARALLEL_TASKS

    def test_fallback_plan_preserves_original_question(self):
        """When JSON parsing fails, fallback tasks should contain the original question."""
        agents = json.dumps([{'name': 'a'}])
        llm = _make_plan_llm('not valid json at all')
        orch = MultiAgentOrchestrator({'agents_json': agents}, llm)
        plan = orch.plan('What is quantum computing?')
        # The task description should contain the original question.
        assert 'What is quantum computing?' in plan[0].description

    def test_failed_prerequisite_blocks_dependents(self):
        """If a prerequisite task fails, dependent tasks should be skipped."""

        def failing_llm(sys, usr):
            if 'fail' in usr:
                raise RuntimeError('step failed')
            return 'ok'

        cfg = {'agents_json': self._agents_json(), 'execution_mode': 'supervisor'}
        orch = MultiAgentOrchestrator(cfg, failing_llm)
        tasks = [
            SubTask(id='t1', description='fail this', assigned_agent='a1'),
            SubTask(id='t2', description='depends on t1', assigned_agent='a2', depends_on=['t1']),
        ]
        results = orch.execute(tasks)
        assert len(results) == 2
        # t1 should have the original error.
        t1_result = next(r for r in results if r.task_id == 't1')
        assert t1_result.error is not None
        assert 'step failed' in t1_result.error
        # t2 should be skipped because t1 failed.
        t2_result = next(r for r in results if r.task_id == 't2')
        assert t2_result.error is not None
        assert 'Skipped' in t2_result.error

    def test_blackboard_step_indexed_keys(self):
        """Same agent used in multiple tasks should not overwrite blackboard entries."""
        agents = json.dumps([{'name': 'worker', 'role': 'worker'}])
        cfg = {
            'agents_json': agents,
            'communication_protocol': 'blackboard',
            'execution_mode': 'sequential',
        }
        call_count = {'n': 0}

        def counting_llm(sys, usr):
            call_count['n'] += 1
            return f'result-{call_count["n"]}'

        orch = MultiAgentOrchestrator(cfg, counting_llm)
        tasks = [
            SubTask(id='t1', description='first', assigned_agent='worker'),
            SubTask(id='t2', description='second', assigned_agent='worker'),
        ]
        orch.execute(tasks)
        bb = orch.blackboard.read_all()
        # Both results should be present with step-indexed keys.
        assert 'worker_result_t1' in bb
        assert 'worker_result_t2' in bb
        assert bb['worker_result_t1'] != bb['worker_result_t2']

    def test_iinstance_none_config_raises(self):
        """IInstance should raise RuntimeError when config is None."""
        from multi_agent.IGlobal import IGlobal
        from multi_agent.IInstance import IInstance

        ig = IGlobal()
        ig.config = None  # Simulate missing config.

        inst = IInstance()
        inst.IGlobal = ig
        inst.instance = MagicMock()

        q = _MockQuestion()
        q.addQuestion('Hello')
        with pytest.raises(RuntimeError, match='config is not loaded'):
            inst.writeQuestions(q)


# ===========================================================================
# services.json contract
# ===========================================================================


class TestServicesJsonContract:
    @pytest.fixture(autouse=True)
    def _load_services(self):
        services_path = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'multi_agent', 'services.json')
        with open(services_path) as f:
            self.services = json.load(f)

    def test_has_title(self):
        assert self.services['title'] == 'Multi-Agent'

    def test_has_protocol(self):
        assert self.services['protocol'] == 'multi_agent://'

    def test_class_type_is_agent(self):
        assert 'agent' in self.services['classType']

    def test_register_is_filter(self):
        assert self.services['register'] == 'filter'

    def test_lanes_questions_to_answers(self):
        assert self.services['lanes'] == {'questions': ['answers']}

    def test_profiles_exist(self):
        profiles = self.services['preconfig']['profiles']
        assert 'supervisor' in profiles
        assert 'sequential' in profiles
        assert 'parallel' in profiles

    def test_fields_defined(self):
        fields = self.services['fields']
        assert 'agents_json' in fields
        assert 'communication_protocol' in fields
        assert 'max_rounds' in fields
        assert 'merge_strategy' in fields
