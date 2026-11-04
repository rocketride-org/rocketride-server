# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Prompt and guardrails judged together, the way a RAG turn meets them.

Each node was tested on its own and each looked right, while the pair still got
ordinary turns wrong: the prompt node told the model to refuse, or guardrails
dropped what the model produced. These run a turn through the real prompt node,
stand a model answer in its place, and put that answer through the real guardrails
node, asserting on what the user is actually delivered.

Loaded with the engine dependencies stubbed, so no server, model or key is needed.
"""

import importlib.util
import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), 'prompt'))
from test_grounding_instruction import _load_iinstance  # noqa: E402

# Loaded by path: several nodes have a test_all.py, so the bare name is ambiguous.
_spec = importlib.util.spec_from_file_location('guardrails_test_all', os.path.join(_HERE, 'test_all.py'))
_guardrails_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guardrails_tests)

# A miss under Strict must never deliver one of these, and must always deliver something.
QUESTION = 'Was Apple net income $94.7B in FY2024?'

AFFIRMATIONS = (
    'Yes. Apple net income was $94.7B.',
    'Correct, it was $94.7B.',
    'Yes, it was $94.7B. There is no doubt.',
    'Nothing else to add, it was $94.7B.',
    'Apple net income was $94.7B. Further detail is not available.',
    'The $94.7B you mentioned is correct, no doubt about it.',
    "Apple's net income was about ninety-four billion dollars.",
)

REFUSALS_QUOTING_THE_FIGURE = (
    'I cannot confirm whether it was $94.7B.',
    'The figure of $94.7 billion is not in the documents.',
    "I didn't find the $94.7B figure in the documents.",
    'I do not have the figure. You asked about $94.7B, but no document covers it.',
    'Regarding $94.7B, I could not find it in the documents.',
)

REPLIES_WITHOUT_A_FIGURE = (
    'Hello! Happy to help. What would you like to look at?',
    'I do not have the information to answer that.',
    "I'm sorry, I couldn't find that in the knowledge base.",
    'Could you clarify which fiscal year you mean?',
)


@pytest.fixture
def prompt_node():
    module = _load_iinstance()
    inst = module.IInstance()
    inst.IGlobal = types.SimpleNamespace(config={})
    inst.emitted = []
    inst.instance = types.SimpleNamespace(writeQuestions=inst.emitted.append)
    inst.open(None)
    return inst


@pytest.fixture(scope='module')
def guardrails():
    IInstance, EngineClass, FakeQuestion, FakeQuestionText, FakeAnswer = (
        _guardrails_tests.TestIInstanceLifecycle._load_iinstance_class()
    )
    return types.SimpleNamespace(
        IInstance=IInstance,
        Engine=EngineClass,
        Question=FakeQuestion,
        QuestionText=FakeQuestionText,
        Answer=FakeAnswer,
    )


def _turn(node, question, documents):
    """One retrieval turn, returning the instruction the model would be given."""
    node.writeQuestions(types.SimpleNamespace(questions=[types.SimpleNamespace(text=question)]))
    node.writeDocuments(documents)
    node.closing()
    emitted = node.emitted[-1]
    return next((i.instructions for i in emitted.instructions if i.subtitle == 'Grounding'), None)


def _delivered(g, answer, question=QUESTION, retrieved=True, **overrides):
    """What the user receives when *answer* passes a Strict guardrails node."""
    inst = g.IInstance()
    settings = {'policy_mode': 'block', 'require_grounding': True}
    settings.update(overrides)
    inst.IGlobal = types.SimpleNamespace(engine=g.Engine(settings), config={})
    delivered = []
    inst.instance = types.SimpleNamespace(
        writeAnswers=delivered.append,
        writeQuestions=lambda q: None,
        writeDocuments=lambda d: None,
    )
    inst.preventDefault = lambda: None
    inst.open(None)
    inst.writeQuestions(g.Question(questions=[g.QuestionText(question)]))
    if retrieved:
        inst.writeDocuments([])
    inst.writeAnswers(g.Answer(answer))
    return [a.getText() for a in delivered]


def test_a_greeting_survives_a_retrieval_miss(prompt_node, guardrails):
    """A store matches nothing on plenty of turns, and the turn is still answerable.

    The instruction must not order a refusal outright, and the answer the model
    gives must reach the user unchanged.
    """
    question = 'Hello, thanks for your help'
    instruction = _turn(prompt_node, question, [])
    reply = 'Hello! Happy to help. What would you like to look at?'

    assert 'needs that material' in instruction, 'the refusal has to be conditional on the question'
    assert _delivered(guardrails, reply, question) == [reply]


def test_a_miss_never_delivers_an_ungrounded_figure_and_never_silence(prompt_node, guardrails):
    """The property both halves exist for, held across every shape of answer.

    Whether the model affirms the question's figure, invents one, or declines while
    quoting it, the user gets exactly one reply and that reply states no figure.
    """
    _turn(prompt_node, QUESTION, [])

    for answer in AFFIRMATIONS + REFUSALS_QUOTING_THE_FIGURE + REPLIES_WITHOUT_A_FIGURE:
        delivered = _delivered(guardrails, answer)
        assert len(delivered) == 1, answer
        assert not guardrails.Engine.FIGURE_PATTERN.search(delivered[0]), answer


def test_an_affirmed_figure_reaches_the_user_as_a_refusal(prompt_node, guardrails):
    """Repeating a figure as fact asserts it as much as inventing one."""
    _turn(prompt_node, QUESTION, [])

    for answer in AFFIRMATIONS:
        assert _delivered(guardrails, answer) == [guardrails.Engine.UNGROUNDED_REPLY], answer


def test_a_refusal_quoting_the_figure_still_reaches_the_user_as_a_refusal(guardrails):
    """The case every phrase rule kept dropping: the user is told no, not nothing."""
    for answer in REFUSALS_QUOTING_THE_FIGURE:
        assert _delivered(guardrails, answer) == [guardrails.Engine.UNGROUNDED_REPLY], answer


def test_a_reply_without_a_figure_is_delivered_as_written(guardrails):
    """Nothing to ground, so the model's own wording reaches the user."""
    for answer in REPLIES_WITHOUT_A_FIGURE:
        assert _delivered(guardrails, answer) == [answer], answer


def test_an_invented_figure_after_a_miss_is_replaced(prompt_node, guardrails):
    """The case the feature exists for: the reported finance chatbot."""
    question = 'What is the refund policy?'
    _turn(prompt_node, question, [])

    delivered = _delivered(guardrails, 'Refunds are processed within $250 of the original charge.', question)

    assert delivered == [guardrails.Engine.UNGROUNDED_REPLY]


def test_a_pipeline_that_never_retrieves_is_untouched(prompt_node, guardrails):
    """No documents lane means no grounding rule and no grounding verdict."""
    prompt_node.writeText('branch a output')
    prompt_node.closing()
    emitted = prompt_node.emitted[-1]

    assert [i.subtitle for i in emitted.instructions] == ['User Instruction']
    assert _delivered(guardrails, 'Revenue was $94.7B.', retrieved=False) == ['Revenue was $94.7B.']
