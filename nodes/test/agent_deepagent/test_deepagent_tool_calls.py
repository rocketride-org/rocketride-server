# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for Deep Agent tool-call envelope parsing."""

from __future__ import annotations

import json
import time

import pytest

from nodes.agent_deepagent.deepagent import (
    _invoke_deepagent_with_parallel_tools,
    _parse_tool_call_envelope,
    _tool_call_protocol_prompt,
)
from nodes.test.mocks.agent_deepagent import FakeParallelDeepAgent


def test_parse_tool_calls_envelope_preserves_all_calls():
    """Parse multiple task calls while preserving order, falsy args, and IDs."""
    raw = json.dumps(
        {
            'type': 'tool_calls',
            'calls': [
                {'id': 'call_a', 'name': 'task', 'args': {'description': 'A', 'subagent_type': 'eng'}},
                {'name': 'task', 'args': 0},
                {'id': 'call_c', 'name': 'task', 'args': ''},
                {'id': 'call_d', 'name': 'task', 'args': None},
            ],
        }
    )

    msg = _parse_tool_call_envelope(raw)

    assert msg is not None
    assert msg.tool_calls[0]['id'] == 'call_a'
    assert msg.tool_calls[1]['id'].startswith('call_')
    assert msg.tool_calls[2]['id'] == 'call_c'
    assert msg.tool_calls[3]['id'] == 'call_d'
    assert [call['name'] for call in msg.tool_calls] == ['task', 'task', 'task', 'task']
    assert [call['args'] for call in msg.tool_calls] == [
        {'description': 'A', 'subagent_type': 'eng'},
        {'input': 0},
        {'input': ''},
        {},
    ]


def test_parse_tool_calls_envelope_rejects_malformed_batches():
    """Reject a whole multi-call batch if any entry is malformed."""
    raw = json.dumps(
        {
            'type': 'tool_calls',
            'calls': [
                {'id': 'call_a', 'name': 'task', 'args': {'description': 'A'}},
                {'id': 'call_b', 'args': {'description': 'B'}},
                {'id': 'call_c', 'name': 'task', 'args': {'description': 'C'}},
            ],
        }
    )

    assert _parse_tool_call_envelope(raw) is None
    assert _parse_tool_call_envelope(json.dumps({'type': 'tool_calls', 'calls': ['bad']})) is None


def test_tool_protocol_prompt_advertises_multi_call_envelope():
    """Advertise the multi-call envelope so the PM can request fan-out."""
    prompt = _tool_call_protocol_prompt([{'name': 'task', 'description': 'Run subagent'}])

    assert '"type":"tool_calls"' in prompt
    assert '"calls"' in prompt


def test_multi_task_tool_calls_execute_in_parallel():
    """Regression-test LangGraph tool fan-out wall time for multi-task turns."""
    graph_module = pytest.importorskip('langgraph.graph')
    prebuilt_module = pytest.importorskip('langgraph.prebuilt')
    tools_module = pytest.importorskip('langchain_core.tools')

    delay = 0.25

    @tools_module.tool
    def task(description: str) -> str:
        """Run a subagent task."""
        time.sleep(delay)
        return description

    builder = graph_module.StateGraph(graph_module.MessagesState)
    builder.add_node('tools', prebuilt_module.ToolNode([task]))
    builder.add_edge(graph_module.START, 'tools')
    builder.add_edge('tools', graph_module.END)
    graph = builder.compile()

    raw = json.dumps(
        {
            'type': 'tool_calls',
            'calls': [
                {'id': 'call_a', 'name': 'task', 'args': {'description': 'A'}},
                {'id': 'call_b', 'name': 'task', 'args': {'description': 'B'}},
                {'id': 'call_c', 'name': 'task', 'args': {'description': 'C'}},
            ],
        }
    )
    msg = _parse_tool_call_envelope(raw)

    start = time.perf_counter()
    state = graph.invoke({'messages': [msg]})
    elapsed = time.perf_counter() - start

    tool_messages = state['messages'][1:]
    assert [message.content for message in tool_messages] == ['A', 'B', 'C']
    assert elapsed < delay * 2


def test_deepagent_invocation_uses_async_parallel_tool_path():
    """Ensure the driver invokes the async graph path for parallel tool calls."""
    delay = 0.25
    raw = json.dumps(
        {
            'type': 'tool_calls',
            'calls': [
                {'id': 'call_a', 'name': 'task', 'args': {'description': 'A'}},
                {'id': 'call_b', 'name': 'task', 'args': {'description': 'B'}},
                {'id': 'call_c', 'name': 'task', 'args': {'description': 'C'}},
            ],
        }
    )
    msg = _parse_tool_call_envelope(raw)

    start = time.perf_counter()
    state = _invoke_deepagent_with_parallel_tools(
        FakeParallelDeepAgent(delay), {'messages': [msg]}, config={'callbacks': []}
    )
    elapsed = time.perf_counter() - start

    assert state['messages'] == ['A', 'B', 'C']
    assert elapsed < delay * 2
