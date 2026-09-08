# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.content_blocks.flatten_content_blocks``.

These pin the bug where an Anthropic-style typed-block list reached the agent
layer as text. ``str()`` / ``safe_str()`` on that list yields the blocks' repr::

    [{'type': 'thinking', ...}, {'text': 'Thought: ...', 'type': 'text'}]

and CrewAI's ReAct parser reads the model's output back with a greedy
``Action Input: (.*)`` under DOTALL. The capture therefore ran past the JSON
arguments and swallowed the serialized wrapper's trailing ``", "type": "text"}]``,
which json-repair welded onto the first key. Every tool call arrived as a
single-key dict and every declared field reported ``Field required``.

The regression assertions are ``test_answer_survives_the_react_argument_regex``
and ``test_reasoning_never_leaks_into_text``.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_content_blocks.py -v
"""

from __future__ import annotations

import re

from ai.common.utils import flatten_content_blocks

# The regex CrewAI uses (crewai/agents/constants.py): greedy, DOTALL.
ACTION_INPUT_REGEX = re.compile(r'Action\s*\d*\s*:\s*(.*?)\s*Action\s*\d*\s*Input\s*\d*\s*:\s*(.*)', re.DOTALL)


class TestPlainStrings:
    def test_string_passes_through(self):
        assert flatten_content_blocks('hello') == ('hello', '', False)

    def test_none_is_empty(self):
        assert flatten_content_blocks(None) == ('', '', False)

    def test_unexpected_type_is_stringified_not_raised(self):
        text, reasoning, sig = flatten_content_blocks(42)
        assert (text, reasoning, sig) == ('42', '', False)


class TestBlockVocabulary:
    def test_text_blocks_concatenate_in_order(self):
        blocks = [{'type': 'text', 'text': 'one '}, {'type': 'text', 'text': 'two'}]
        assert flatten_content_blocks(blocks)[0] == 'one two'

    def test_thinking_goes_to_reasoning(self):
        blocks = [{'type': 'thinking', 'thinking': 'ponder'}, {'type': 'text', 'text': 'answer'}]
        text, reasoning, _ = flatten_content_blocks(blocks)
        assert text == 'answer'
        assert reasoning == 'ponder'

    def test_reasoning_block_is_the_langchain_v1_alias(self):
        blocks = [{'type': 'reasoning', 'reasoning': 'ponder'}, {'type': 'text', 'text': 'answer'}]
        text, reasoning, _ = flatten_content_blocks(blocks)
        assert (text, reasoning) == ('answer', 'ponder')

    def test_untyped_block_counts_as_text(self):
        assert flatten_content_blocks([{'text': 'bare'}])[0] == 'bare'

    def test_signature_only_thinking_is_reported_not_emitted(self):
        blocks = [{'type': 'thinking', 'signature': 'BASE64=='}, {'type': 'text', 'text': 'answer'}]
        text, reasoning, sig_only = flatten_content_blocks(blocks)
        assert (text, reasoning, sig_only) == ('answer', '', True)
        assert 'BASE64' not in text, 'a verification signature is not model output'

    def test_non_dict_entries_are_skipped(self):
        assert flatten_content_blocks(['junk', None, {'type': 'text', 'text': 'ok'}])[0] == 'ok'

    def test_empty_list_is_empty_text(self):
        assert flatten_content_blocks([]) == ('', '', False)


class TestReActRegression:
    """The exact failure that motivated this helper."""

    BLOCKS = [
        {'type': 'thinking', 'thinking': 'I should delegate this.', 'signature': 'BASE64=='},
        {
            'type': 'text',
            'text': (
                'Thought: resolve the participants first\n'
                'Action: delegate_work_to_coworker\n'
                'Action Input: {"task": "Search", "context": "call intake", "coworker": "Specialist"}'
            ),
        },
    ]

    def test_answer_survives_the_react_argument_regex(self):
        """Flattened, the greedy capture ends at the JSON's closing brace."""
        text, _reasoning, _sig = flatten_content_blocks(self.BLOCKS)

        match = ACTION_INPUT_REGEX.search(text)
        assert match is not None
        assert match.group(1) == 'delegate_work_to_coworker'

        import json

        args = json.loads(match.group(2).strip())
        assert set(args) == {'task', 'context', 'coworker'}, 'all three fields must parse'

    def test_the_unflattened_list_is_what_broke(self):
        """Guards the diagnosis: str() of the blocks corrupts the captured args."""
        match = ACTION_INPUT_REGEX.search(str(self.BLOCKS))
        assert match is not None

        import json

        try:
            json.loads(match.group(2).strip())
        except json.JSONDecodeError:
            pass  # expected: the capture ran past the JSON into the block wrapper
        else:
            raise AssertionError('stringified blocks should not yield parseable tool args')

    def test_reasoning_never_leaks_into_text(self):
        text, reasoning, _sig = flatten_content_blocks(self.BLOCKS)
        assert 'I should delegate this.' not in text
        assert reasoning == 'I should delegate this.'

    def test_stop_word_truncation_can_match_a_real_newline(self):
        """A serialized list escapes newlines, so "\\nObservation:" never matched."""
        blocks = [{'type': 'text', 'text': 'Thought: go\nObservation: fabricated'}]
        text, _reasoning, _sig = flatten_content_blocks(blocks)
        assert '\nObservation:' in text
        assert '\nObservation:' not in str(blocks), 'the serialized form escapes the newline'
