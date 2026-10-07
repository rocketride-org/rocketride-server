# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The pieces behind prompt caching: the prefix, the split, and who sets it when.

``ChatBase.chat`` works out the start of the prompt that stays the same between
calls and publishes it on ``PROMPT_CACHE_PREFIX_VAR`` for its first model call only.
A driver that supports caching (Anthropic) splits its request there. Everything else
sends the same string as before.
"""

from __future__ import annotations

import pytest

from ai.common.chat import ChatBase
from ai.common.llm_adapter import _split_input_cache
from ai.common.llm_native_stream import PROMPT_CACHE_PREFIX_VAR, apply_prompt_cache_breakpoint
from ai.common.schema import Question

# ---------------------------------------------------------------------------
# apply_prompt_cache_breakpoint
# ---------------------------------------------------------------------------


def _payload(content):
    return {'model': 'm', 'messages': [{'role': 'user', 'content': content}]}


def test_split_marks_the_prefix_and_keeps_the_text():
    payload = apply_prompt_cache_breakpoint(_payload('STABLE part. changing part'), 'STABLE part. ')

    blocks = payload['messages'][0]['content']
    assert blocks == [
        {'type': 'text', 'text': 'STABLE part. ', 'cache_control': {'type': 'ephemeral'}},
        {'type': 'text', 'text': 'changing part'},
    ]


@pytest.mark.parametrize(
    ('content', 'prefix'),
    [
        ('abc def', None),
        ('abc def', ''),
        ('abc def', '   '),
        ('abc def', 'xyz'),
        ('abc ', 'abc '),
        ('abc  \n ', 'abc'),
        ([{'type': 'text', 'text': 'abc def'}], 'abc'),
    ],
    ids=['no-prefix', 'empty', 'blank', 'not-a-prefix', 'nothing-after', 'only-blank-after', 'already-blocks'],
)
def test_split_leaves_the_payload_alone_when_it_cannot_apply(content, prefix):
    payload = _payload(content)

    assert apply_prompt_cache_breakpoint(payload, prefix)['messages'][0]['content'] == content


def test_split_only_touches_a_final_user_turn():
    payload = {'messages': [{'role': 'user', 'content': 'abc def'}, {'role': 'assistant', 'content': 'abc def'}]}

    assert apply_prompt_cache_breakpoint(payload, 'abc ')['messages'][1]['content'] == 'abc def'


# ---------------------------------------------------------------------------
# The prefix ChatBase computes
# ---------------------------------------------------------------------------


class _CachingChat(ChatBase):
    SUPPORTS_PROMPT_CACHE_PREFIX = True

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []
        self._modelOutputTokens = 4096

    def chat_string(self, prompt, **_kwargs):
        self.seen.append((prompt, PROMPT_CACHE_PREFIX_VAR.get()))
        return self.replies[min(len(self.seen) - 1, len(self.replies) - 1)]


def _question(scratch: str, *, cache: bool = True) -> Question:
    q = Question(role='You are a planning agent.', expectJson=True)
    q.cachePrefix = cache
    q.addInstruction('Rules', '- Plan carefully.')
    q.addContext(f'Scratch: {scratch}')
    q.addGoal('Make the header blue.')
    q.addQuestion('Plan the next step.')
    return q


def test_prefix_is_the_start_of_the_prompt_and_stops_before_the_context():
    chat = _CachingChat(['{"a": 1}'])

    chat.chat(_question('round 1'))

    prompt, prefix = chat.seen[0]
    assert prompt.startswith(prefix)
    assert 'Scratch' not in prefix
    assert '**Rules**' in prefix


def test_prefix_is_the_same_in_every_round():
    chat = _CachingChat(['{"a": 1}'])

    chat.chat(_question('round 1'))
    chat.chat(_question('round 2, with more notes'))

    assert chat.seen[0][1] == chat.seen[1][1]


def test_only_the_first_call_carries_the_prefix():
    """A JSON repair prompt inserts an instruction near the top, so its start differs."""
    chat = _CachingChat(['not json', '{"a": 1}'])

    chat.chat(_question('round 1'))

    assert chat.seen[0][1] is not None
    assert chat.seen[1][1] is None
    assert PROMPT_CACHE_PREFIX_VAR.get() is None


def test_no_prefix_without_the_flag_or_without_driver_support():
    flagless = _CachingChat(['{"a": 1}'])
    flagless.chat(_question('r', cache=False))

    unsupported = _CachingChat(['{"a": 1}'])
    unsupported.SUPPORTS_PROMPT_CACHE_PREFIX = False
    unsupported.chat(_question('r'))

    assert flagless.seen[0][1] is None
    assert unsupported.seen[0][1] is None


def test_the_prompt_string_itself_does_not_change():
    """Every provider still receives exactly getPrompt(): the split happens only in the Anthropic driver."""
    chat = _CachingChat(['{"a": 1}'])
    question = _question('round 1')

    chat.chat(question)

    assert chat.seen[0][0] == question.getPrompt()


# ---------------------------------------------------------------------------
# Metering cache writes
# ---------------------------------------------------------------------------


def test_cache_writes_reported_per_lifetime_are_counted():
    """langchain-anthropic zeroes cache_creation and reports the writes by lifetime instead."""
    usage = {
        'input_tokens': 2100,
        'output_tokens': 20,
        'input_token_details': {'cache_read': 0, 'cache_creation': 0, 'ephemeral_5m_input_tokens': 2000},
    }

    fresh, out, read, written = _split_input_cache(usage)

    assert (fresh, out, read, written) == (100, 20, 0, 2000)


def test_cache_writes_reported_as_one_total_are_counted():
    usage = {'input_tokens': 2100, 'output_tokens': 20, 'input_token_details': {'cache_creation': 2000}}

    assert _split_input_cache(usage) == (100, 20, 0, 2000)
