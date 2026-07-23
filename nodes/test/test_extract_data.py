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
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from test.framework.discovery import _parse_service_json


_TEST_ROOT = Path(__file__).resolve().parent
_SERVICES_PATH = _TEST_ROOT.parent / 'src' / 'nodes' / 'extract_data' / 'services.json'
_NODE_ROOT = _TEST_ROOT.parent / 'src' / 'nodes'
_STUB_MODULE_NAMES = (
    'rocketlib',
    'rocketlib.types',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.util',
    'ai.common.config',
)
_MISSING = object()


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


def _stub_module(monkeypatch, name):
    """Return a temporary module, creating it only for this test's import."""
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        monkeypatch.setitem(sys.modules, name, mod)

        parent_name, _, child_name = name.rpartition('.')
        if parent_name:
            parent = _stub_module(monkeypatch, parent_name)
            monkeypatch.setattr(parent, child_name, mod, raising=False)

    return mod


def _ensure_attrs(monkeypatch, mod, **attrs):
    """Temporarily add attributes only when the module lacks them."""
    for name, value in attrs.items():
        if not hasattr(mod, name):
            monkeypatch.setattr(mod, name, value, raising=False)


@pytest.fixture
def extract_data_module(monkeypatch, request):
    """Import the node with temporary dependencies and restore interpreter state."""
    original_path = list(sys.path)
    original_stubs = {name: sys.modules.get(name, _MISSING) for name in _STUB_MODULE_NAMES}
    original_node_modules = {
        name: module
        for name, module in sys.modules.items()
        if name == 'extract_data' or name.startswith('extract_data.')
    }

    def assert_import_state_restored():
        """Restore the node import and verify that temporary state did not leak."""
        for name in tuple(sys.modules):
            if (name == 'extract_data' or name.startswith('extract_data.')) and name not in original_node_modules:
                del sys.modules[name]
        sys.modules.update(original_node_modules)

        assert sys.path == original_path
        for name, original_module in original_stubs.items():
            if original_module is _MISSING:
                assert name not in sys.modules
            else:
                assert sys.modules[name] is original_module
        for name, original_module in original_node_modules.items():
            assert sys.modules[name] is original_module

    request.addfinalizer(assert_import_state_restored)

    with monkeypatch.context() as patch:
        # Augment (never replace) real modules, while keeping partial stubs local
        # to this fixture so they cannot affect other tests.
        _ensure_attrs(
            patch,
            _stub_module(patch, 'rocketlib'),
            IInstanceBase=_StubBase,
            IGlobalBase=_StubBase,
            Entry=object,
            warning=lambda *a, **kw: None,
            debug=lambda *a, **kw: None,
        )
        _ensure_attrs(patch, _stub_module(patch, 'rocketlib.types'), IInvokeLLM=MagicMock())
        _stub_module(patch, 'ai')
        _stub_module(patch, 'ai.common')
        _ensure_attrs(
            patch,
            _stub_module(patch, 'ai.common.schema'),
            Doc=_StubDoc,
            DocMetadata=MagicMock(),
            Question=MagicMock(),
            QuestionType=types.SimpleNamespace(QUESTION='question'),
            Answer=MagicMock(),
        )
        _ensure_attrs(patch, _stub_module(patch, 'ai.common.util'), normalize=lambda text: text)
        _ensure_attrs(patch, _stub_module(patch, 'ai.common.config'), Config=MagicMock())

        # Import the node package (its parent dir goes on the path, like test_contracts).
        # importlib is used so we get the *module* (the package __init__ rebinds
        # `IInstance` to the class, which shadows the submodule for `import ... as`).
        patch.syspath_prepend(str(_NODE_ROOT))
        yield importlib.import_module('extract_data.IInstance')


def _make_instance(node_module):
    """Build an IInstance with the framework-provided attrs faked out.

    Uses __new__ to skip the base __init__ (whose signature differs between the
    real engine base and the stub); the handlers only touch the attrs set here.
    """
    instance_class = node_module.IInstance
    inst = instance_class.__new__(instance_class)
    inst.IGlobal = types.SimpleNamespace(fields=[])
    inst.instance = MagicMock()
    inst.table = []
    inst.chunkId = 0
    return inst


class TestWriteDocumentsRouting:
    """writeDocuments must hand the documents straight to _extractData."""

    def test_forwards_documents_to_extract(self, extract_data_module):
        inst = _make_instance(extract_data_module)
        received = []
        inst._extractData = lambda arg: received.append(arg)

        Doc = extract_data_module.Doc
        docs = [Doc(page_content='Alice, 30'), Doc(page_content='Bob, 40')]
        inst.writeDocuments(docs)

        assert received == [docs], f'writeDocuments should forward the doc list unchanged, got {received}'

    def test_empty_document_list_still_extracts(self, extract_data_module):
        inst = _make_instance(extract_data_module)
        received = []
        inst._extractData = lambda arg: received.append(arg)

        inst.writeDocuments([])

        assert received == [[]], 'writeDocuments([]) should still invoke extraction with an empty list'


class TestDocumentsReachQuestion:
    """_extractData must feed the documents into the LLM question."""

    def test_page_content_reaches_question(self, monkeypatch, extract_data_module):
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

        monkeypatch.setattr(extract_data_module, 'Question', RecordingQuestion)
        monkeypatch.setattr(extract_data_module, 'IInvokeLLM', types.SimpleNamespace(Ask=lambda **kw: kw))

        inst = _make_instance(extract_data_module)
        inst.writeAnswers = lambda result: None  # skip answer handling for this test

        Doc = extract_data_module.Doc
        docs = [Doc(page_content='Alice, 30'), Doc(page_content='Bob, 40')]
        inst.writeDocuments(docs)

        question = RecordingQuestion.last
        assert question is not None, '_extractData should have built a Question'
        assert question.documents == [docs], f'documents should be passed to addDocuments, got {question.documents}'
        assert inst.instance.invoke.called, 'the LLM should be invoked with the built question'
