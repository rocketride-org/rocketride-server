# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Prompt and guardrails judged together, the way a RAG turn meets them.

Each node was tested on its own and each looked right, while the pair still got
ordinary turns wrong: the prompt node told the model to refuse, or guardrails
dropped what the model produced. These run a turn through the real prompt node,
stand a model answer in its place, and put that answer through the real engine.

Loaded with the engine dependencies stubbed, so no server, model or key is needed.
"""

import importlib.util
import os
import sys
import types

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_ENGINE_PATH = os.path.join(_ROOT, 'src', 'nodes', 'guardrails', 'guardrails_engine.py')

sys.path.insert(0, os.path.join(_ROOT, 'test', 'prompt'))
from test_grounding_instruction import _load_iinstance  # noqa: E402


def _engine(**overrides):
    saved = sys.modules.get('rocketlib')
    stub = types.ModuleType('rocketlib')
    stub.warning = lambda *a, **kw: None
    sys.modules['rocketlib'] = stub
    spec = importlib.util.spec_from_file_location('guardrails_engine_e2e', _ENGINE_PATH)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop('rocketlib', None) if saved is None else sys.modules.__setitem__('rocketlib', saved)
    settings = {'policy_mode': 'block', 'require_grounding': True}
    settings.update(overrides)
    return mod.GuardrailsEngine(settings)


@pytest.fixture
def prompt_node():
    module = _load_iinstance()
    inst = module.IInstance()
    inst.IGlobal = types.SimpleNamespace(config={})
    inst.emitted = []
    inst.instance = types.SimpleNamespace(writeQuestions=inst.emitted.append)
    inst.open(None)
    return inst


def _turn(node, question, documents):
    """One retrieval turn, returning the instruction the model would be given."""
    node.writeQuestions(types.SimpleNamespace(questions=[types.SimpleNamespace(text=question)]))
    node.writeDocuments(documents)
    node.closing()
    emitted = node.emitted[-1]
    return next((i.instructions for i in emitted.instructions if i.subtitle == 'Grounding'), None)


def _verdict(answer, question, **overrides):
    return _engine(**overrides).evaluate(
        answer,
        mode='output',
        context={'source_documents': [], 'retrieval_ran': True, 'question_text': question},
    )['action']


def test_a_greeting_survives_a_retrieval_miss(prompt_node):
    """A store matches nothing on plenty of turns, and the turn is still answerable.

    The instruction must not order a refusal outright, and the answer the model
    gives must reach the user.
    """
    question = 'Hello, thanks for your help'
    instruction = _turn(prompt_node, question, [])

    assert 'needs that material' in instruction, 'the refusal has to be conditional on the question'
    assert _verdict('Hello! Happy to help. What would you like to look at?', question) != 'block'


def test_an_answer_that_hands_back_the_question_figure_is_still_blocked(prompt_node):
    """Repeating a figure as fact asserts it as much as inventing one.

    Nothing was retrieved, so there is no support for it either way.
    """
    question = 'Was Apple net income $94.7B?'
    _turn(prompt_node, question, [])

    for answer in ('Yes. Apple net income was $94.7B.', 'Correct, it was $94.7B.'):
        assert _verdict(answer, question) == 'block', answer


def test_a_refusal_naming_the_same_amount_another_way_is_kept(prompt_node):
    """$1,200 and $1200 are one amount, so quoting it back is not a new claim."""
    for answer, question in (
        ('I could not find the $1200 figure in the documents.', 'Was the fee $1,200?'),
        ('There is no mention of 12.0% in the sources.', 'Did revenue grow 12%?'),
    ):
        assert _verdict(answer, question) != 'block', answer


def test_an_invented_figure_after_a_miss_is_still_blocked(prompt_node):
    """The case the feature exists for, held in place while the others were loosened."""
    question = 'What is the refund policy?'
    _turn(prompt_node, question, [])

    assert _verdict('Refunds are processed within $250 of the original charge.', question) == 'block'


def test_a_pipeline_that_never_retrieves_is_untouched(prompt_node):
    """No documents lane means no grounding rule and no grounding verdict."""
    prompt_node.writeText('branch a output')
    prompt_node.closing()
    emitted = prompt_node.emitted[-1]

    assert [i.subtitle for i in emitted.instructions] == ['User Instruction']
    assert (
        _engine().evaluate(
            'Revenue was $94.7B.',
            mode='output',
            context={'source_documents': [], 'retrieval_ran': False, 'question_text': 'anything'},
        )['action']
        != 'block'
    )
