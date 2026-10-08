# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""``{{memory.ref:key}}`` as a whole tool argument.

The executor substitutes the stored value before the tool runs, so large data goes
from one tool to the next without passing through the prompt. A tag for a key that
is not stored used to become None, and the tool ran with it: a write created an
empty file and the model saw a normal result.
"""

from __future__ import annotations

from types import SimpleNamespace


class Memory:
    """The memory channel's read and write over a dict."""

    def __init__(self, data=None):
        self.data = dict(data or {})

    def put(self, key, value):
        self.data[key] = value
        return {'ok': True}

    def get(self, key):
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}


def run_wave(wave, args, memory):
    """Run one wave of a single workspace.write call; return its result and what the tool received."""
    received = []

    def call_tool(context, tool, args):
        received.append(args)
        return {'ok': True}

    results = wave.executor.execute_wave(
        [{'tool': 'workspace.write', 'args': args}],
        agent_base=SimpleNamespace(call_tool=call_tool),
        context=SimpleNamespace(memory=memory),
        wave_name='wave-1',
    )
    return results[0], received


def test_a_whole_argument_tag_hands_the_stored_value_to_the_tool(wave):
    stored = {'content': 'body { color: red; }'}
    memory = Memory({'wave-0.r0': stored})

    result, received = run_wave(wave, {'path': 'a.css', 'content': '{{memory.ref:wave-0.r0:text:content}}'}, memory)

    assert 'error' not in result
    assert received == [{'path': 'a.css', 'content': 'body { color: red; }'}]


def test_a_whole_argument_tag_for_a_missing_key_fails_before_the_tool_runs(wave):
    """The key was never stored, was removed, or was held back from a call that timed out."""
    result, received = run_wave(wave, {'path': 'a.css', 'content': '{{memory.ref:wave-9.r0}}'}, Memory())

    assert received == [], 'the tool ran on data that is not there'
    assert result['error'] == '{{memory.ref:wave-9.r0}} names no stored key, so the call did not run'
    assert result['args'], 'the model is shown the call as it wrote it'


def test_the_prompt_documents_the_tag_as_a_tool_argument(wave):
    question = wave.planner._build_wave_question(
        context=SimpleNamespace(tools=SimpleNamespace(list=[])),
        question=wave.planner.Question(),
        waves=[],
    )
    memory_block = next(i.instructions for i in question.instructions if i.subtitle == 'Memory')

    assert '{{memory.ref:key}} (tool argument)' in memory_block
    assert '"args": {"data": "{{memory.ref:wave-1.r0}}"}' in memory_block
    assert 'If the key is not stored, the call fails without' in memory_block
