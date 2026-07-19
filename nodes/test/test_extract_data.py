"""Regression tests for the extract_data node (IInstance.py).

Covers the `documents` input lane added for issue #1408:
  - writeDocuments forwards the received documents to _extractData unchanged
  - _extractData feeds those documents into the LLM question via addDocuments

Server-free: the engine/AI modules the node imports are stubbed (only for the
attributes it needs, and only when missing) so the node's Python can be imported
and driven with plain pytest, no running server. When the real modules are
present (CI) they are left untouched and this becomes a light integration test.
"""

import importlib
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock


_TEST_ROOT = Path(__file__).resolve().parent
if str(_TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(_TEST_ROOT))

from framework.discovery import _parse_service_json


_SERVICES_PATH = _TEST_ROOT.parent / 'src' / 'nodes' / 'extract_data' / 'services.json'


def test_services_documents_lane_maps_to_answers_and_documents():
    """The services contract exposes the documents input lane."""
    services = _parse_service_json(str(_SERVICES_PATH))

    assert services is not None
    assert services['lanes']['documents'] == ['answers', 'documents']


class _StubBase:
    """Stand-in for rocketlib IInstanceBase / IGlobalBase."""

    def preventDefault(self) -> None:
        pass


class _StubDoc:
    """Minimal stand-in for ai.common.schema.Doc (real Doc has page_content)."""

    def __init__(self, page_content=None, **kwargs):
        self.page_content = page_content
        for key, value in kwargs.items():
            setattr(self, key, value)


def _module(name):
    """Return sys.modules[name], creating an empty module if absent."""
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    return mod


def _ensure_attrs(mod, **attrs):
    """Add attributes only when the module doesn't already define them."""
    for name, value in attrs.items():
        if not hasattr(mod, name):
            setattr(mod, name, value)


# Augment (never replace) the modules the node imports, so this coexists with
# both the real packages and the partial stubs other node tests install.
_ensure_attrs(
    _module('rocketlib'),
    IInstanceBase=_StubBase,
    IGlobalBase=_StubBase,
    Entry=object,
    warning=lambda *a, **kw: None,
    debug=lambda *a, **kw: None,
)
_ensure_attrs(_module('rocketlib.types'), IInvokeLLM=MagicMock())
_module('ai')
_module('ai.common')
_ensure_attrs(
    _module('ai.common.schema'),
    Doc=_StubDoc,
    DocMetadata=MagicMock(),
    Question=MagicMock(),
    QuestionType=types.SimpleNamespace(QUESTION='question'),
    Answer=MagicMock(),
)
_ensure_attrs(_module('ai.common.util'), normalize=lambda text: text)
_ensure_attrs(_module('ai.common.config'), Config=MagicMock())

# Import the node package (its parent dir goes on the path, like test_contracts).
# importlib is used so we get the *module* (the package __init__ rebinds the name
# `IInstance` to the class, which shadows the submodule for `import ... as`).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes'))
node_module = importlib.import_module('extract_data.IInstance')

IInstance = node_module.IInstance
Doc = node_module.Doc  # exactly the Doc the node imported (stub or real)


def _make_instance():
    """Build an IInstance with the framework-provided attrs faked out.

    Uses __new__ to skip the base __init__ (whose signature differs between the
    real engine base and the stub); the handlers only touch the attrs set here.
    """
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = types.SimpleNamespace(fields=[])
    inst.instance = MagicMock()
    inst.table = []
    inst.chunkId = 0
    return inst


class TestWriteDocumentsRouting:
    """writeDocuments must hand the documents straight to _extractData."""

    def test_forwards_documents_to_extract(self):
        inst = _make_instance()
        received = []
        inst._extractData = lambda arg: received.append(arg)

        docs = [Doc(page_content='Alice, 30'), Doc(page_content='Bob, 40')]
        inst.writeDocuments(docs)

        assert received == [docs], f'writeDocuments should forward the doc list unchanged, got {received}'

    def test_empty_document_list_still_extracts(self):
        inst = _make_instance()
        received = []
        inst._extractData = lambda arg: received.append(arg)

        inst.writeDocuments([])

        assert received == [[]], 'writeDocuments([]) should still invoke extraction with an empty list'


class TestDocumentsReachQuestion:
    """_extractData must feed the documents into the LLM question."""

    def test_page_content_reaches_question(self, monkeypatch):
        # Record the question the node builds, and neutralise the LLM round-trip.
        class RecordingQuestion:
            last = None

            def __init__(self, *a, **kw):
                self.documents = []
                RecordingQuestion.last = self

            def addInstruction(self, *a, **kw):
                pass

            def addContext(self, *a, **kw):
                pass

            def addDocuments(self, documents):
                self.documents.append(documents)

        monkeypatch.setattr(node_module, 'Question', RecordingQuestion)
        monkeypatch.setattr(node_module, 'IInvokeLLM', types.SimpleNamespace(Ask=lambda **kw: kw))

        inst = _make_instance()
        inst.writeAnswers = lambda result: None  # skip answer handling for this test

        docs = [Doc(page_content='Alice, 30'), Doc(page_content='Bob, 40')]
        inst.writeDocuments(docs)

        question = RecordingQuestion.last
        assert question is not None, '_extractData should have built a Question'
        assert question.documents == [docs], f'documents should be passed to addDocuments, got {question.documents}'
        assert inst.instance.invoke.called, 'the LLM should be invoked with the built question'
