# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the grounding instruction the prompt node appends.

The node cannot tell "retrieval found nothing" from "this pipeline does not
retrieve" by looking at the documents it holds, since both leave the list empty.
It branches on whether the documents lane was dispatched at all, so these pin
that distinction: a branch-merge prompt must be left exactly as it was.

Loaded with the engine dependencies stubbed, so no server, model or key is needed.
"""

import importlib.util
import os
import sys
import types

import pytest

_PROMPT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'src',
    'nodes',
    'prompt',
)


class _FakeInstruction:
    """Mirrors QuestionInstruction, which the node identifies by subtitle."""

    def __init__(self, subtitle, instructions):
        self.subtitle = subtitle
        self.instructions = instructions


class _FakeQuestion:
    """Enough of Question for the node: instructions, documents and context."""

    def __init__(self):
        self.questions = []
        self.context = []
        self.documents = []
        self.instructions = []

    def addQuestion(self, text):
        self.questions.append(text)

    def addContext(self, ctx):
        self.context.append(ctx)

    def addDocuments(self, documents):
        self.documents.extend(documents or [])

    def addInstruction(self, title, instruction):
        self.instructions.append(_FakeInstruction(title, instruction))

    def getPrompt(self):
        return ''


def _load_iinstance():
    """Load the node's IInstance with its engine dependencies stubbed."""
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.config': types.ModuleType('ai.common.config'),
        'depends': types.ModuleType('depends'),
    }

    class FakeIInstanceBase:
        IGlobal = None
        instance = None

        def __init__(self):
            pass

        def preventDefault(self):
            pass

    class FakeIGlobalBase:
        IEndpoint = None
        glb = None

    stubs['rocketlib'].IInstanceBase = FakeIInstanceBase
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].Entry = type('Entry', (), {})
    stubs['rocketlib'].OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    stubs['rocketlib'].debug = lambda *a, **kw: None
    stubs['ai.common.schema'].Question = _FakeQuestion
    stubs['ai.common.config'].Config = type('Config', (), {'getNodeConfig': staticmethod(lambda lt, cc: {})})
    stubs['depends'].depends = lambda *a, **kw: None

    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        for mod in [m for m in sys.modules if m == 'prompt' or m.startswith('prompt.')]:
            del sys.modules[mod]

        pkg_spec = importlib.util.spec_from_file_location(
            'prompt', os.path.join(_PROMPT_DIR, '__init__.py'), submodule_search_locations=[_PROMPT_DIR]
        )
        sys.modules['prompt'] = importlib.util.module_from_spec(pkg_spec)

        for sub in ('IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'prompt.{sub}', os.path.join(_PROMPT_DIR, f'{sub}.py'))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'prompt.{sub}'] = mod
            spec.loader.exec_module(mod)

        return sys.modules['prompt.IInstance']
    finally:
        for name, prior in saved.items():
            sys.modules.pop(name, None) if prior is None else sys.modules.__setitem__(name, prior)


@pytest.fixture
def node():
    """A prompt IInstance wired to a recording writer, with default config."""
    module = _load_iinstance()
    inst = module.IInstance()
    inst.IGlobal = types.SimpleNamespace(config={})
    inst.emitted = []
    inst.instance = types.SimpleNamespace(writeQuestions=inst.emitted.append)
    return inst


def _titles(inst):
    return [i.subtitle for i in inst.question.instructions]


def _grounding_text(inst):
    return next((i.instructions for i in inst.question.instructions if i.subtitle == 'Grounding'), None)


def test_retrieved_documents_get_a_grounding_instruction(node):
    """Documents were retrieved, so the answer should come from them."""
    node.writeDocuments(['Apple reported a net loss of (9,958) for FY2024.'])
    node.closing()

    body = _grounding_text(node)
    assert body is not None
    assert 'Base your answer on the documents' in body


def test_empty_retrieval_gets_an_abstain_instruction(node):
    """The reported case: retrieval ran, found nothing, and the model invented figures."""
    node.writeDocuments([])
    node.closing()

    body = _grounding_text(node)
    assert body is not None
    assert 'do not have the information' in body
    assert 'Do not answer from memory' in body


def test_a_branch_merge_prompt_is_untouched(node):
    """Text arriving without a documents lane is fan-in, not retrieval.

    Conditioning on context rather than on the lane would have caught these and
    told a branch-merge prompt to answer only from its context.
    """
    node.writeText('branch a output')
    node.writeText('branch b output')
    node.closing()

    assert _titles(node) == ['User Instruction']


def test_a_prompt_with_no_input_at_all_is_untouched(node):
    node.closing()

    assert _titles(node) == ['User Instruction']


def test_operator_instructions_are_kept_and_come_first(node):
    """The grounding rule is appended, never a replacement for what the operator wrote."""
    node.IGlobal.config = {'instructions': ['Answer as a financial analyst.', 'Be concise.']}
    node.writeDocuments(['Some retrieved passage.'])
    node.closing()

    assert _titles(node) == ['User Instruction 1', 'User Instruction 2', 'Grounding']
    assert node.question.instructions[0].instructions == 'Answer as a financial analyst.'


def test_the_retrieval_flag_resets_between_objects(node):
    """open() is the only reset point; a stale flag would ground the next turn wrongly."""
    node.writeDocuments([])
    assert node.retrieval_ran is True

    node.open(None)

    assert node.retrieval_ran is False
    node.closing()
    assert _titles(node) == ['User Instruction']


def test_repeated_turns_keep_one_grounding_instruction(node):
    """open() starts a fresh question, so nothing carries over between objects."""
    for turn in range(3):
        node.open(None)
        node.writeDocuments([f'document for turn {turn}'])
        node.closing()

    assert _titles(node) == ['User Instruction', 'Grounding']
    assert 'Base your answer on the documents' in _grounding_text(node)
    assert node.question.documents == ['document for turn 2'], 'a turn must not inherit earlier documents'


def test_a_later_empty_turn_replaces_the_grounding_rule(node):
    """A turn that retrieves nothing must not inherit the previous turn's rule."""
    node.open(None)
    node.writeDocuments(['a retrieved passage'])
    node.closing()
    assert 'Base your answer on the documents' in _grounding_text(node)

    node.open(None)
    node.writeDocuments([])
    node.closing()

    assert _titles(node).count('Grounding') == 1
    assert 'do not have the information' in _grounding_text(node)
    assert node.question.documents == [], 'the abstain rule must not sit above stale documents'
