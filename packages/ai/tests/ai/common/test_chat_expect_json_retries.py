# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""What ``ChatBase.chat``'s ``expectJson`` loop does with each kind of parse failure.

This is the only production path through ``parseJson``, so it decides whether a
diagnosis made there reaches anyone. Two failures arrive at the same ``except`` and
must not be treated alike:

- **Bad JSON** — the model can plausibly do better on a resample, so re-prompt it.
- **A truncated ``<think>`` block** — the model never reached the JSON because it ran
  out of output budget. The repair prompt ("examine your JSON and ensure it is
  complete") describes a problem that does not exist, a resample rarely fits a budget
  that already overflowed, and each attempt is a paid model call. Worse, the generic
  message raised after the loop replaces the one that named ``modelOutputTokens``.

``chat`` reads no instance state beyond ``self.chat_string``, so it is exercised over a
bare ``__new__`` instance with that one method stubbed — the pattern established in
``test_chat_return_contract.py``.

Run with::

    pytest packages/ai/tests/ai/common/test_chat_expect_json_retries.py -v
"""

from __future__ import annotations

import json

import pytest

from ai.common.chat import ChatBase
from ai.common.schema import Question
from ai.common.util import EmptyResponseError, ThinkTruncatedError

# A reasoning model that hit its output budget before emitting any JSON.
TRUNCATED = '<think>The user wants a JSON summary. Let me work through the fields one at a'

# The CRITICAL instruction question.py appends once a parse has already failed.
REPAIR_MARKER = 'previous response returned invalid JSON'


def _question() -> Question:
    """A minimal JSON-expecting question."""
    q = Question(expectJson=True)
    q.addQuestion('summarize this')
    return q


def _chat_returning(*responses: str) -> tuple[ChatBase, list[str]]:
    """A ChatBase whose ``chat_string`` yields ``responses`` in order, recording prompts.

    The last response repeats if the loop asks for more than were supplied, so a test
    that expects a single call does not accidentally pass on an IndexError.
    """
    prompts: list[str] = []
    chat = ChatBase.__new__(ChatBase)

    def _chat_string(prompt: str, **_kwargs) -> str:
        prompts.append(prompt)
        return responses[min(len(prompts) - 1, len(responses) - 1)]

    chat.chat_string = _chat_string
    return chat, prompts


class TestTruncatedThinkBlock:
    def test_fails_fast_without_spending_a_retry(self):
        """One model call, then the error — not three."""
        chat, prompts = _chat_returning(TRUNCATED)

        with pytest.raises(ThinkTruncatedError):
            chat.chat(_question())

        assert len(prompts) == 1

    def test_the_cause_survives_to_the_caller(self):
        """The whole point of the diagnosis: it is still readable at the top.

        Swallowed into the retry loop, it became ``Failed to get valid JSON response
        after N attempts``, which names nothing. ``LLMBase.writeQuestions`` renders
        whatever escapes here as ``**LLM error** — {type}: {message}``, so this is the
        text a user ends up seeing.
        """
        chat, _ = _chat_returning(TRUNCATED)

        with pytest.raises(ThinkTruncatedError, match='modelOutputTokens'):
            chat.chat(_question())

    def test_the_repair_prompt_is_never_sent(self):
        """The repair instruction misdescribes a budget overflow, so it must not be asked."""
        chat, prompts = _chat_returning(TRUNCATED)

        with pytest.raises(ThinkTruncatedError):
            chat.chat(_question())

        assert not any(REPAIR_MARKER in p for p in prompts)

    def test_a_truncation_discovered_on_a_retry_also_fails_fast(self):
        """The guard is inside the loop, so it holds on attempt 2 as well as attempt 1.

        This is the likelier production shape: the first answer is merely malformed, the
        repair prompt makes the model reason *harder* about getting the JSON right, and
        that is what pushes it over the output budget. Stopping here costs two calls
        rather than three, and still names the budget.
        """
        chat, prompts = _chat_returning('not json at all', TRUNCATED)

        with pytest.raises(ThinkTruncatedError, match='modelOutputTokens'):
            chat.chat(_question())

        assert len(prompts) == 2
        assert REPAIR_MARKER in prompts[1]

    def test_is_not_reported_as_exhausted_retries(self):
        """The dedicated arm has to come first — the subclass IS a ValueError."""
        chat, _ = _chat_returning(TRUNCATED)

        with pytest.raises(ValueError) as excinfo:
            chat.chat(_question())

        assert 'Failed to get valid JSON response' not in str(excinfo.value)


class TestOrdinaryBadJson:
    def test_still_retries_the_full_budget(self):
        """Unchanged behaviour for the failure a resample can actually fix."""
        chat, prompts = _chat_returning('not json at all')

        with pytest.raises(ValueError):
            chat.chat(_question())

        assert len(prompts) == 3
        assert REPAIR_MARKER in prompts[1]

    def test_the_final_error_counts_the_calls_it_made(self):
        """Three calls (the first and two repairs); the message used to say four."""
        chat, prompts = _chat_returning('not json at all')

        with pytest.raises(ValueError) as excinfo:
            chat.chat(_question())

        assert f'after {len(prompts)} attempts' in str(excinfo.value)

    def test_the_final_error_carries_the_parse_failure(self):
        """The exhausted-retries message used to drop what was wrong with the response."""
        chat, _ = _chat_returning('not json at all')

        with pytest.raises(ValueError, match='Cause:') as excinfo:
            chat.chat(_question())

        assert 'Expecting value' in str(excinfo.value)
        assert isinstance(excinfo.value.__cause__, json.JSONDecodeError)


class TestValidJson:
    def test_returns_on_the_first_attempt(self):
        chat, prompts = _chat_returning('{"answer": 42}')

        answer = chat.chat(_question())

        assert answer.getJson() == {'answer': 42}
        assert len(prompts) == 1

    def test_a_fenced_response_after_a_complete_think_block_parses(self):
        """The closed-block path must keep working; only the unterminated one is fatal."""
        chat, _ = _chat_returning('<think>reasoning</think>\n```json\n{"x": "y"}\n```')

        assert chat.chat(_question()).getJson() == {'x': 'y'}


class TestEmptyReply:
    """No text at all is not a formatting mistake either.

    A reasoning model that spends its whole output budget before writing returns
    nothing. The repair loop resent the same prompt with the same budget twice more
    (three calls in all); one live run paid 30 to 45 seconds per call for three empty
    replies, each cut off at the output limit.
    """

    def _chat(self, *responses):
        chat, prompts = _chat_returning(*responses)
        chat._modelOutputTokens = 4096
        return chat, prompts

    @pytest.mark.parametrize('empty', ['', '   \n  '], ids=['empty', 'whitespace'])
    def test_fails_fast_without_spending_a_retry(self, empty):
        chat, prompts = self._chat(empty)

        with pytest.raises(EmptyResponseError):
            chat.chat(_question())

        assert len(prompts) == 1

    def test_the_cause_names_the_setting_to_change(self):
        chat, _ = self._chat('')

        with pytest.raises(EmptyResponseError, match=r'modelOutputTokens \(now 4096\)'):
            chat.chat(_question())

    def test_an_empty_repair_reply_stops_the_retries(self):
        """Bad JSON earns a repair round; an empty answer to the repair ends it."""
        chat, prompts = self._chat('{"a": ', '')

        with pytest.raises(EmptyResponseError):
            chat.chat(_question())

        assert len(prompts) == 2
        assert REPAIR_MARKER in prompts[1]

    def test_is_still_a_value_error(self):
        assert issubclass(EmptyResponseError, ValueError)
