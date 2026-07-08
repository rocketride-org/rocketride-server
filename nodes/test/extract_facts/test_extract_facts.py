# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Standalone unit tests for the Extract Facts node.

Mirrors the direct-IInstance harness used by guardrails/test_all.py: rocketlib
and ai.common.* are stubbed, IInstance.py is loaded from source via
spec_from_file_location, and the engine collaborator (self.instance) is a
SimpleNamespace that captures writeAnswers/writeDocuments and returns a fake
Answer from invoke(). No running server is required.

Asserts:
  (a) configured target fields drive the extraction prompt,
  (b) provenance is attached to every emitted fact,
  (c) the validator pass runs and reconciles a disagreement,
  (d) both the answers and documents lanes emit,
  (e) the documents lane is skipped when no downstream listens.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types


_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'extract_facts')


# ---------------------------------------------------------------------------
# Fake schema/rocketlib collaborators (shape matches ai.common.schema usage in
# extract_data/IInstance.py: Question(addInstruction/addContext/addDocuments/
# addExample), Answer(getJson/setAnswer), Doc/DocMetadata, IInvokeLLM.Ask).
# ---------------------------------------------------------------------------


class FakeQuestion:
    def __init__(self, **kwargs):
        self.role = kwargs.get('role', '')
        self.expectJson = kwargs.get('expectJson', False)
        self.instructions = []  # list[(title, body)]
        self.context = []
        self.documents = []
        self.examples = []

    def addInstruction(self, title, body):
        self.instructions.append((title, body))

    def addContext(self, ctx):
        self.context.append(ctx)

    def addDocuments(self, text):
        self.documents.append(text)

    def addExample(self, userText, jsonAnswer):
        self.examples.append((userText, jsonAnswer))

    def instruction_text(self):
        return '\n'.join(f'{t}\n{b}' for t, b in self.instructions)


class FakeQuestionType:
    QUESTION = 'question'


class FakeAnswer:
    """Fake Answer. getJson() returns the payload the node stored/received."""

    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self._json = None

    def setAnswer(self, value):
        self._json = value

    def getJson(self):
        return self._json


def _make_answer(payload):
    a = FakeAnswer(expectJson=True)
    a.setAnswer(payload)
    return a


class FakeAsk:
    def __init__(self, question=None):
        self.question = question


class FakeIInvokeLLM:
    Ask = FakeAsk


class FakeDocMetadata:
    def __init__(self, owner, **kwargs):
        self.owner = owner
        self.__dict__.update(kwargs)


class FakeDoc:
    def __init__(self, page_content='', type='Document', metadata=None):
        self.page_content = page_content
        self.type = type
        self.metadata = metadata


# ---------------------------------------------------------------------------
# Loader — stub modules, then load IInstance.py from source.
# (Pattern: guardrails/test_all.py:549-680.)
# ---------------------------------------------------------------------------


def _load_iinstance_class(node_config):
    saved = {}
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'rocketlib.types': types.ModuleType('rocketlib.types'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.config': types.ModuleType('ai.common.config'),
        'ai.common.util': types.ModuleType('ai.common.util'),
    }

    class FakeIInstanceBase:
        IGlobal = None
        instance = None

        def __init__(self):
            pass

        def preventDefault(self):
            pass

    class FakeIGlobalBase:
        glb = None

    class FakeEntry:
        pass

    class FakeConfig:
        @staticmethod
        def getNodeConfig(logicalType, connConfig):
            return node_config

    stubs['rocketlib'].IInstanceBase = FakeIInstanceBase
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].Entry = FakeEntry
    stubs['rocketlib'].warning = lambda *a, **kw: None
    stubs['rocketlib.types'].IInvokeLLM = FakeIInvokeLLM
    stubs['ai.common.schema'].Question = FakeQuestion
    stubs['ai.common.schema'].QuestionType = FakeQuestionType
    stubs['ai.common.schema'].Answer = FakeAnswer
    stubs['ai.common.schema'].Doc = FakeDoc
    stubs['ai.common.schema'].DocMetadata = FakeDocMetadata
    stubs['ai.common.config'].Config = FakeConfig
    stubs['ai.common.util'].normalize = lambda s: ' '.join(str(s).split())

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            'extract_facts',
            os.path.join(_NODE_DIR, '__init__.py'),
            submodule_search_locations=[_NODE_DIR],
        )
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules['extract_facts'] = pkg_mod

        iglobal_spec = importlib.util.spec_from_file_location(
            'extract_facts.IGlobal', os.path.join(_NODE_DIR, 'IGlobal.py')
        )
        iglobal_mod = importlib.util.module_from_spec(iglobal_spec)
        sys.modules['extract_facts.IGlobal'] = iglobal_mod
        iglobal_spec.loader.exec_module(iglobal_mod)

        iinst_spec = importlib.util.spec_from_file_location(
            'extract_facts.IInstance', os.path.join(_NODE_DIR, 'IInstance.py')
        )
        iinst_mod = importlib.util.module_from_spec(iinst_spec)
        sys.modules['extract_facts.IInstance'] = iinst_mod
        iinst_spec.loader.exec_module(iinst_mod)

        return iinst_mod.IInstance, iglobal_mod.IGlobal
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        for mod_name in list(sys.modules.keys()):
            if mod_name == 'extract_facts' or mod_name.startswith('extract_facts.'):
                sys.modules.pop(mod_name, None)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

_FIELDS = [
    {'column': 'invoice_total', 'type': 'decimal', 'defval': ''},
    {'column': 'currency', 'type': 'text', 'defval': 'USD'},
]

_TABLE = '| item | amount |\n| ---- | ------ |\n| Widget | 100.00 |'


def _build_instance(invoke_side_effect, listens=('answers', 'documents')):
    """Construct an IInstance wired to a fake IGlobal + captured engine.

    invoke_side_effect(call_index, ask) -> FakeAnswer  models the two prompt
    passes against the single LLM invoke lane.
    Returns (inst, captured) where captured has .answers, .documents, .asks.
    """
    IInstance, IGlobal = _load_iinstance_class({'fields': _FIELDS, 'validate': True, 'include_provenance': True})

    glob = IGlobal.__new__(IGlobal)
    glob.glb = types.SimpleNamespace(logicalType='extract_facts', connConfig={})
    glob.beginGlobal()  # populates glob.fields/validate/include_provenance

    inst = IInstance.__new__(IInstance)
    inst.IGlobal = glob

    captured = types.SimpleNamespace(answers=[], documents=[], asks=[])
    call_index = {'n': 0}

    def _invoke(ask):
        captured.asks.append(ask)
        i = call_index['n']
        call_index['n'] += 1
        return invoke_side_effect(i, ask)

    inst.instance = types.SimpleNamespace(
        invoke=_invoke,
        writeAnswers=lambda a: captured.answers.append(a),
        writeDocuments=lambda d: captured.documents.append(d),
        hasListener=lambda lane: lane in listens,
    )
    inst.preventDefault = lambda: None
    return inst, captured


# ---------------------------------------------------------------------------
# (a) configured target fields drive extraction
# ---------------------------------------------------------------------------


def test_configured_fields_drive_extraction_prompt():
    def side_effect(i, ask):
        return _make_answer([])

    inst, captured = _build_instance(side_effect)
    inst.open(types.SimpleNamespace())
    inst.writeTable(_TABLE)
    inst.closing()

    # The first invoke is the extraction pass; its prompt must name each field.
    assert captured.asks, 'extraction pass must call instance.invoke'
    prompt = captured.asks[0].question.instruction_text()
    assert 'invoice_total' in prompt
    assert 'currency' in prompt


# ---------------------------------------------------------------------------
# (b) provenance is attached to every emitted fact
# ---------------------------------------------------------------------------

_PROVENANCE_KEYS = {'page', 'table_id', 'row', 'col', 'source_text', 'confidence'}


def test_provenance_attached_to_each_fact():
    fact = {
        'invoice_total': 100.0,
        'currency': 'USD',
        '_provenance': {
            'page': 1,
            'table_id': 0,
            'row': 1,
            'col': 1,
            'source_text': 'Widget 100.00',
            'confidence': 0.97,
        },
    }

    def side_effect(i, ask):
        # pass 0 = extraction, pass 1 = validator (returns same, no disagreement)
        return _make_answer([fact])

    inst, captured = _build_instance(side_effect)
    inst.open(types.SimpleNamespace())
    inst.writeTable(_TABLE)
    inst.closing()

    assert captured.answers, 'answers lane must emit'
    emitted = captured.answers[0].getJson()
    assert len(emitted) == 1
    assert _PROVENANCE_KEYS.issubset(emitted[0]['_provenance'].keys())
    # configured target fields still present alongside provenance
    assert emitted[0]['invoice_total'] == 100.0
    assert emitted[0]['currency'] == 'USD'


# ---------------------------------------------------------------------------
# (c) validator pass runs and reconciles a disagreement
# ---------------------------------------------------------------------------


def test_validator_pass_reconciles_disagreement():
    prov = {'page': 1, 'table_id': 0, 'row': 1, 'col': 1, 'source_text': 'Widget 100.00'}
    extraction = [{'currency': 'USD', 'invoice_total': 10.0, '_provenance': {**prov, 'confidence': 0.55}}]  # wrong read
    reconciled = [
        {'currency': 'USD', 'invoice_total': 100.0, '_provenance': {**prov, 'confidence': 0.98}}
    ]  # validator fix

    def side_effect(i, ask):
        return _make_answer(extraction if i == 0 else reconciled)

    inst, captured = _build_instance(side_effect)
    inst.open(types.SimpleNamespace())
    inst.writeTable(_TABLE)
    inst.closing()

    # Two prompt passes against the single invoke lane (extraction + validator).
    assert len(captured.asks) >= 2, 'validator pass must issue a second invoke'
    validator_prompt = captured.asks[1].question.instruction_text().lower()
    assert 'verif' in validator_prompt or 'disagree' in validator_prompt or 'reconcil' in validator_prompt

    emitted = captured.answers[0].getJson()
    assert emitted[0]['invoice_total'] == 100.0, 'validator value should win the tie-break'
    assert emitted[0]['_provenance']['confidence'] == 0.98


# ---------------------------------------------------------------------------
# (d) both answers and documents lanes emit
# ---------------------------------------------------------------------------


def test_both_lanes_emit_on_closing():
    fact = {
        'invoice_total': 100.0,
        'currency': 'USD',
        '_provenance': {
            'page': 1,
            'table_id': 0,
            'row': 1,
            'col': 1,
            'source_text': 'Widget 100.00',
            'confidence': 0.97,
        },
    }

    def side_effect(i, ask):
        return _make_answer([fact])

    inst, captured = _build_instance(side_effect)
    inst.open(types.SimpleNamespace())
    inst.writeTable(_TABLE)
    inst.closing()

    assert len(captured.answers) == 1, 'answers lane must emit exactly once'
    assert captured.documents, 'documents lane must emit'
    docs = captured.documents[0]
    assert len(docs) == 1
    payload = json.loads(docs[0].page_content)
    assert _PROVENANCE_KEYS.issubset(payload['_provenance'].keys())


# ---------------------------------------------------------------------------
# (e) documents lane skipped when no listener
# ---------------------------------------------------------------------------


def test_documents_lane_skipped_when_no_listener():
    """When no downstream listens on 'documents', that lane must not emit."""

    def side_effect(i, ask):
        return _make_answer([])

    inst, captured = _build_instance(side_effect, listens=('answers',))
    inst.open(types.SimpleNamespace())
    inst.writeTable(_TABLE)
    inst.closing()

    assert captured.answers, 'answers lane should still emit'
    assert not captured.documents, 'documents lane must be skipped without a listener'
