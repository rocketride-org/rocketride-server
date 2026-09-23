# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ChatBase._chat``'s return contract.

``flatten_content_blocks`` is covered directly in
``tests/ai/common/utils/test_content_blocks.py``. What these pin is the wiring:
that ``_chat`` — the method every non-streaming chat caller reaches — routes the
provider's ``content`` through it and hands back a ``str``.

That contract used to be ``return results.content``, which is a plain string on
OpenAI-style backends but a list of typed blocks on Anthropic with extended
thinking. Callers stringified whatever arrived, so the answer came back as the
blocks' repr with the raw reasoning and its base64 signatures inside it.

``_chat`` is exercised unbound against a stub ``_llm`` — constructing a real
ChatBase needs a provider config and a live model, and neither is relevant to
the shape of what comes back.

Run with::

    pytest packages/ai/tests/ai/common/test_chat_return_contract.py -v
"""

from __future__ import annotations

from typing import Any

from ai.common.chat import ChatBase


class _StubLLM:
    """Stands in for the LangChain model: records the prompt, returns fixed content."""

    def __init__(self, content: Any):
        self._content = content
        self.prompts: list[str] = []

    def invoke(self, prompt: str, **_kwargs: Any) -> Any:
        self.prompts.append(prompt)
        return type('Result', (), {'content': self._content})()


def _chat_with(content: Any) -> tuple[str, _StubLLM]:
    """Drive ChatBase._chat over a stub returning ``content``."""
    chat = ChatBase.__new__(ChatBase)
    llm = _StubLLM(content)
    chat._llm = llm
    return ChatBase._chat(chat, 'what is 2+2?'), llm


class TestStringContent:
    def test_plain_string_passes_through(self):
        answer, llm = _chat_with('4')
        assert answer == '4'
        assert llm.prompts == ['what is 2+2?']

    def test_return_is_always_a_string(self):
        for content in ('4', [], None, [{'type': 'text', 'text': '4'}]):
            assert isinstance(_chat_with(content)[0], str)


class TestTypedBlockContent:
    """The Anthropic extended-thinking shape."""

    def test_text_blocks_are_flattened_to_the_answer(self):
        blocks = [
            {'type': 'thinking', 'thinking': 'Let me work through this.', 'signature': 'ErUBCkYIBR=='},
            {'type': 'text', 'text': '4'},
        ]
        assert _chat_with(blocks)[0] == '4'

    def test_reasoning_never_reaches_the_caller(self):
        blocks = [
            {'type': 'thinking', 'thinking': 'SECRET-CHAIN-OF-THOUGHT'},
            {'type': 'text', 'text': 'the answer'},
        ]
        answer = _chat_with(blocks)[0]
        assert 'SECRET-CHAIN-OF-THOUGHT' not in answer
        assert answer == 'the answer'

    def test_block_repr_never_reaches_the_caller(self):
        """The regression: the list arriving verbatim, stringified downstream."""
        answer = _chat_with([{'type': 'text', 'text': 'hello'}])[0]
        assert answer == 'hello'
        for artefact in ("'type'", "'text'", '[{', '}]'):
            assert artefact not in answer

    def test_multiple_text_blocks_concatenate_in_order(self):
        blocks = [{'type': 'text', 'text': 'one '}, {'type': 'text', 'text': 'two'}]
        assert _chat_with(blocks)[0] == 'one two'
