# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Stubs for System One node tests: a fake engine around the real runner and a fake HTTP client.

The node folder is registered as the package ``decision_systemone_under_test`` without running its
``__init__`` (which calls ``depends()`` and imports the engine glue), so the tests here import the node's
modules from source as ``decision_systemone_under_test.<module>``.
"""

import importlib
import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
import rocketlib.decisions as real_decisions

NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'decision_systemone'
PKG = 'decision_systemone_under_test'

if PKG not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        PKG, NODE_DIR / '__init__.py', submodule_search_locations=[str(NODE_DIR)]
    )
    sys.modules[PKG] = importlib.util.module_from_spec(_spec)

from decision_systemone_under_test.limits import DecisionLimits  # noqa: E402
from decision_systemone_under_test.questions import YES_NO, QuestionSpec  # noqa: E402
from decision_systemone_under_test.runner import DecisionRunner  # noqa: E402

SPECS = [QuestionSpec('urgent', YES_NO, 'Is it urgent?')]
# 400 tokens at 4 chars/token: 'hello' fits, 'x' * 2000 does not.
LIMITS = DecisionLimits(max_options=26, max_levels=26, max_questions=64, max_state_tokens=400, chars_per_token=4.0)


class Prevented(Exception):
    """Raised by the stubbed preventDefault()."""


class Meta(SimpleNamespace):
    def __init__(self, pInstance=None, chunkId=0, **kw):
        super().__init__(chunkId=chunkId, **kw)

    def model_dump(self):
        return dict(vars(self))


class Doc(SimpleNamespace):
    def __init__(self, page_content, metadata=None, type='Document'):
        super().__init__(page_content=page_content, metadata=metadata, type=type)

    def model_copy(self, deep=False):
        meta = None
        if self.metadata is not None:
            fields = dict(vars(self.metadata))
            if 'decision_refs' in fields:
                fields['decision_refs'] = dict(fields['decision_refs'])
            meta = Meta(**fields)
        return Doc(self.page_content, meta, self.type)


class Answer:
    def __init__(self, answer=None, expectJson=False):
        self.answer, self.expectJson = answer, expectJson

    def getText(self):
        if self.answer is None:
            return ''
        return json.dumps(self.answer) if isinstance(self.answer, (dict, list)) else str(self.answer)

    def getJson(self):
        """Mirror the real Answer.getJson: parse strings, raise ValueError on non-JSON, TypeError on other types."""
        if self.answer is None:
            return None
        if isinstance(self.answer, (dict, list)):
            return self.answer
        try:
            return json.loads(self.answer)
        except json.JSONDecodeError:
            raise ValueError('Answer is not in JSON format.')

    def isJson(self):
        return self.expectJson


class FakeClient:
    """Answers 'urgent' with noul 0.9, or raises ``error``."""

    def __init__(self, error=None):
        self.states, self.error = [], error

    def decide(self, model, state, questions):
        self.states.append(state)
        if self.error is not None:
            raise self.error
        return {'model': model, 'answers': {'urgent': {'type': 'noul', 'noul': 0.9}}, 'usage': {'input_tokens': 7}}


class _InstanceBase:
    """Stands in for rocketlib.IInstanceBase: only the real recordDecision, nothing engine-bound."""

    def recordDecision(self, questions, answers=None, **kwargs):
        return real_decisions.record_decision(self, questions, answers, **kwargs)


@pytest.fixture
def systemone(monkeypatch):
    """Import the node's IGlobal and IInstance against stubbed rocketlib/schema/config; yield helpers."""
    warnings = []
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = _InstanceBase
    rocketlib.decisions = real_decisions
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')
    rocketlib.warning = lambda message, *_a, **_k: warnings.append(message)
    rocketlib.debug = lambda *_a, **_k: None
    schema = types.ModuleType('ai.common.schema')
    schema.Doc, schema.DocMetadata, schema.Answer, schema.Question = Doc, Meta, Answer, SimpleNamespace
    config = types.ModuleType('ai.common.config')
    config.Config = SimpleNamespace(getNodeConfig=lambda *_a, **_k: {})
    for name, module in {
        'rocketlib': rocketlib,
        'rocketlib.decisions': real_decisions,
        'ai.common.schema': schema,
        'ai.common.config': config,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    for name in ('IInstance', 'IGlobal'):
        monkeypatch.delitem(sys.modules, f'{PKG}.{name}', raising=False)
    helpers = SimpleNamespace(
        IInstance=importlib.import_module(f'{PKG}.IInstance'),
        IGlobal=importlib.import_module(f'{PKG}.IGlobal'),
        warnings=warnings,
        config=config,
    )
    yield helpers
    # The modules were imported against the stubs; don't let them outlive them on this worker.
    package = sys.modules.get(PKG)
    for name in ('IInstance', 'IGlobal'):
        sys.modules.pop(f'{PKG}.{name}', None)
        if package is not None and hasattr(package, name):
            delattr(package, name)


@pytest.fixture
def node(systemone):
    """A System One node instance on a fresh object, with the real runner over FakeClient."""
    client = FakeClient()

    class Node(systemone.IInstance.IInstance):
        pass

    inst = Node()
    written = {'text': [], 'documents': []}
    inst.instance = SimpleNamespace(
        currentObject=SimpleNamespace(response={}),
        writeText=written['text'].append,
        writeDocuments=written['documents'].append,
        pipeType={'id': 'decision_ollama_1'},
    )
    inst.IGlobal = SimpleNamespace(
        runner=DecisionRunner(client, 'nimble', SPECS, LIMITS), glb=SimpleNamespace(logicalType='decision_ollama')
    )

    def prevent():
        raise Prevented()

    inst.preventDefault = prevent
    inst.open(None)
    return SimpleNamespace(inst=inst, client=client, written=written, warnings=systemone.warnings)


def group(node):
    """Return this node's decisions group (plain dict response)."""
    return node.inst.instance.currentObject.response['decisions']['decision_ollama_1']
