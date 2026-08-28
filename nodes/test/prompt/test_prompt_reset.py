# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Standalone unit tests for the Prompt node's per-turn state.

Mirrors the direct-IInstance harness used by extract_facts/test_extract_facts.py
and guardrails/test_all.py: rocketlib and ai.common.* are stubbed, IInstance.py is
loaded from source via spec_from_file_location, and the engine collaborator
(self.instance) is a SimpleNamespace that captures writeQuestions. No running
server is required.

WHY THESE EXIST. The node merges everything written to it and emits on close, but
it did not start over afterwards, and the instance outlives the turn in a resident
task. Context and instructions therefore accumulated across every turn the task
ever served - and since a chat is no part of a task's identity, across separate
conversations too. A request answered turns ago was still present, still phrased as
an instruction, and got carried out again.

Asserts:
  (a) a second turn carries only its own context,
  (b) instructions do not multiply turn over turn,
  (c) `open` starts a turn clean even without a preceding close,
  (d) a turn that received nothing emits nothing,
  (e) a turn that raised does not leak its context into the next one.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'prompt')


# ---------------------------------------------------------------------------
# Fake schema collaborator. Shape matches ai.common.schema.Question as the node
# uses it: addQuestion/addContext/addDocuments/addInstruction/getPrompt, over the
# list fields the real model declares (question.py:306).
# ---------------------------------------------------------------------------


class FakeQuestion:
    def __init__(self, **kwargs):
        self.context = []
        self.questions = []
        self.documents = []
        self.instructions = []

    def addInstruction(self, title, instruction):
        self.instructions.append((title, instruction))

    def addContext(self, context):
        self.context.append(context)

    def addQuestion(self, question):
        self.questions.append(types.SimpleNamespace(text=question))

    def addDocuments(self, documents):
        self.documents.append(documents)

    def getPrompt(self, has_previous_json_failed=False):
        return ' '.join(self.context)


# ---------------------------------------------------------------------------
# Loader — stub modules, then load IInstance.py from source.
# (Pattern: extract_facts/test_extract_facts.py:119-201.)
# ---------------------------------------------------------------------------


def _load_iinstance_class():
    saved = {}
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.config': types.ModuleType('ai.common.config'),
    }

    class FakeIInstanceBase:
        IGlobal = None
        instance = None

        def __init__(self):
            pass

    class FakeIGlobalBase:
        glb = None

    class FakeEntry:
        pass

    stubs['rocketlib'].IInstanceBase = FakeIInstanceBase
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].Entry = FakeEntry
    stubs['rocketlib'].debug = lambda *a, **kw: None
    stubs['rocketlib'].OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    stubs['ai.common.schema'].Question = FakeQuestion
    stubs['ai.common.config'].Config = types.SimpleNamespace(getNodeConfig=lambda *a: {})

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            'prompt_node',
            os.path.join(_NODE_DIR, '__init__.py'),
            submodule_search_locations=[_NODE_DIR],
        )
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules['prompt_node'] = pkg_mod

        iglobal_spec = importlib.util.spec_from_file_location(
            'prompt_node.IGlobal', os.path.join(_NODE_DIR, 'IGlobal.py')
        )
        iglobal_mod = importlib.util.module_from_spec(iglobal_spec)
        sys.modules['prompt_node.IGlobal'] = iglobal_mod
        iglobal_spec.loader.exec_module(iglobal_mod)

        iinst_spec = importlib.util.spec_from_file_location(
            'prompt_node.IInstance', os.path.join(_NODE_DIR, 'IInstance.py')
        )
        iinst_mod = importlib.util.module_from_spec(iinst_spec)
        sys.modules['prompt_node.IInstance'] = iinst_mod
        iinst_spec.loader.exec_module(iinst_mod)

        return iinst_mod.IInstance
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        for mod_name in list(sys.modules.keys()):
            if mod_name == 'prompt_node' or mod_name.startswith('prompt_node.'):
                sys.modules.pop(mod_name, None)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

_INSTRUCTIONS = ['CHANNEL: LIVE CHAT.', 'Answer the person in front of you.']


@pytest.fixture
def build():
    """Returns a factory for one IInstance wired to a captured engine.

    The instance is deliberately reused across turns by the tests, because that
    is exactly what a resident task does to it.
    """

    def _build(instructions=None):
        IInstance = _load_iinstance_class()

        inst = IInstance()
        inst.IGlobal = types.SimpleNamespace(
            config={'instructions': _INSTRUCTIONS if instructions is None else instructions}
        )

        captured = types.SimpleNamespace(questions=[])
        inst.instance = types.SimpleNamespace(writeQuestions=captured.questions.append)
        return inst, captured

    return _build


def _turn(inst, *texts):
    """One turn: open, write each text on the text lane, close."""
    inst.open(None)
    for text in texts:
        inst.writeText(text)
    inst.closing()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_a_second_turn_carries_only_its_own_context(build):
    """
    THE BUG, IN ONE ASSERTION.

    Two turns on one instance. The second must not be able to see the first: the
    text of a business card read three turns ago is not part of what the person is
    asking now, and a spoken request that was already carried out must not be
    handed to the agent again as though it were still waiting.
    """
    inst, captured = build()

    _turn(inst, 'the first card')
    _turn(inst, 'the second card')

    assert len(captured.questions) == 2
    assert captured.questions[0].context == ['the first card']
    assert captured.questions[1].context == ['the second card'], (
        'the second turn inherited the first turn - context accumulates across turns'
    )


def test_instructions_do_not_multiply_turn_over_turn(build):
    """
    `closing` adds the configured instructions every time it runs. Against a
    question it never replaced, the system prompt was repeated once per turn - six
    copies by the fourth - crowding out the turn it was supposed to frame.
    """
    inst, captured = build()

    for n in range(4):
        _turn(inst, f'turn {n}')

    for n, question in enumerate(captured.questions):
        assert len(question.instructions) == len(_INSTRUCTIONS), (
            f'turn {n} carries {len(question.instructions)} instructions, expected {len(_INSTRUCTIONS)}'
        )


def test_open_starts_a_turn_clean(build):
    """
    `open` is the turn's beginning, so it resets even if the previous turn never
    reached `closing` - a turn that was abandoned must not donate its context to
    the next one.
    """
    inst, captured = build()

    inst.open(None)
    inst.writeText('abandoned mid-turn')
    # No closing() - the turn goes nowhere.

    _turn(inst, 'the real question')

    assert len(captured.questions) == 1
    assert captured.questions[0].context == ['the real question']


def test_a_turn_that_received_nothing_emits_nothing(build):
    """
    A pipe holds one prompt node per intake lane and a turn reaches one of them.
    The idle ones used to emit anyway - a question of pure instructions, which an
    agent downstream answers, so a single turn drew two answers and the empty
    lane's output was filed as what the person had asked.
    """
    inst, captured = build()

    inst.open(None)
    inst.closing()

    assert captured.questions == [], 'a node that heard nothing still asked a question'


def test_an_emitted_turn_is_still_recorded_as_output(build):
    """The has_output flag tracks a turn that really did emit."""
    inst, captured = build()

    inst.open(None)
    assert inst.has_output is False
    inst.writeText('something')
    inst.closing()

    assert len(captured.questions) == 1


def test_documents_and_questions_lanes_also_count_as_input(build):
    """
    Silence is about receiving nothing, not about receiving no *text*. A turn that
    arrived as a document or a question is a turn.
    """
    inst, captured = build()

    inst.open(None)
    inst.writeDocuments(['a document'])
    inst.closing()

    assert len(captured.questions) == 1
    assert captured.questions[0].documents == [['a document']]


def test_a_failed_turn_does_not_leak_into_the_next(build):
    """
    If `closing` raises on its way out, the turn's context must still be dropped.
    Otherwise one bad turn poisons every turn after it - the same accumulation,
    reached by the error path.
    """
    inst, captured = build()

    inst.IGlobal = types.SimpleNamespace(config=None)  # config.get(...) raises

    inst.open(None)
    inst.writeText('the turn that failed')
    inst.closing()

    assert captured.questions == []

    inst.IGlobal = types.SimpleNamespace(config={'instructions': _INSTRUCTIONS})
    _turn(inst, 'the turn after')

    assert len(captured.questions) == 1
    assert captured.questions[0].context == ['the turn after']
