# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.agent._internal.utils.extract_text``.

This is the seam every agent driver reads the host LLM through
(``AgentBase.call_llm`` -> ``extract_text``). It used to stringify whatever it
was handed, so an Anthropic-style typed-block list arrived at CrewAI's ReAct
parser as the blocks' repr and every tool call lost its arguments. The tests
below pin the flattening at each of the shapes ``extract_text`` accepts.

Run with::

    pytest packages/ai/tests/ai/common/agent/test_extract_text.py -v
"""

from __future__ import annotations

from typing import Any

from ai.common.agent._internal.utils import extract_text, truncate_at_stop_words

BLOCKS = [
    {'type': 'thinking', 'thinking': 'internal reasoning', 'signature': 'BASE64=='},
    {'type': 'text', 'text': 'Action Input: {"task": "go"}'},
]


class _WithText:
    """Engine result exposing ``getText()``."""

    def __init__(self, value: Any):
        self._value = value

    def getText(self):
        return self._value


class _WithJson:
    """Engine result exposing ``getJson()``."""

    def __init__(self, value: Any):
        self._value = value

    def getJson(self):
        return self._value


class TestPlainShapes:
    def test_get_text_string(self):
        assert extract_text(_WithText('  hello  ')) == 'hello'

    def test_get_json_dict_prefers_answer(self):
        assert extract_text(_WithJson({'answer': 'a', 'content': 'b'})) == 'a'

    def test_get_json_dict_falls_through_to_text(self):
        assert extract_text(_WithJson({'text': 'c'})) == 'c'

    def test_bare_value(self):
        assert extract_text('plain') == 'plain'


class TestContentBlocks:
    """The regression: a list is blocks, not text."""

    def test_blocks_from_get_text(self):
        assert extract_text(_WithText(BLOCKS)) == 'Action Input: {"task": "go"}'

    def test_blocks_from_get_json_top_level(self):
        assert extract_text(_WithJson(BLOCKS)) == 'Action Input: {"task": "go"}'

    def test_blocks_nested_under_a_dict_key(self):
        assert extract_text(_WithJson({'content': BLOCKS})) == 'Action Input: {"task": "go"}'

    def test_reasoning_is_dropped(self):
        out = extract_text(_WithText(BLOCKS))
        assert 'internal reasoning' not in out
        assert 'BASE64' not in out

    def test_no_block_wrapper_survives(self):
        """`"type": "text"` in the output is what corrupted the ReAct argument capture."""
        out = extract_text(_WithText(BLOCKS))
        assert '"type"' not in out
        assert not out.startswith('['), 'a list repr means the blocks were stringified'


class TestStopWordsAfterFlattening:
    def test_truncation_matches_once_the_newline_is_real(self):
        """A serialized block list escapes newlines, so the marker never matched."""
        blocks = [{'type': 'text', 'text': 'Thought: go\nObservation: fabricated'}]
        text = extract_text(_WithText(blocks))
        assert truncate_at_stop_words(text, ['\nObservation:']) == 'Thought: go'
