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
"""
Regression tests for the NER node's writeDocuments enrichment (issue #2064).

These exercise the real Doc and DocMetadata rather than stand-ins, because the bug
being guarded against is specific to DocMetadata being a pydantic model: subscript
assignment raises TypeError, so entity fields have to be written as attributes.
"""

import importlib.util
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# Derive paths relative to this file to avoid hardcoded paths
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(TEST_DIR))
SRC_PATH = os.path.join(REPO_ROOT, 'nodes', 'src')
AI_PATH = os.path.join(REPO_ROOT, 'packages', 'ai', 'src')
CLIENT_PATH = os.path.join(REPO_ROOT, 'packages', 'client-python', 'src')
ENGINE_PATH = os.path.join(REPO_ROOT, 'packages', 'server', 'engine-lib', 'rocketlib-python', 'lib')

for path in [SRC_PATH, AI_PATH, CLIENT_PATH, ENGINE_PATH]:
    if path not in sys.path:
        sys.path.insert(0, path)


class _PreventDefaultRaised(Exception):
    """Stand-in for the APERR(Ec.PreventDefault) that the real preventDefault() raises."""


class _FakeIInstanceBase:
    """
    Stand-in for rocketlib.IInstanceBase.

    Mirrors the two pieces of engine context DocMetadata(pInstance) reads —
    instance.currentObject and IEndpoint.endpoint.jobConfig — and raises from
    preventDefault() the way the real implementation does.
    """

    def __init__(self):
        self.instance = MagicMock()
        self.instance.currentObject = types.SimpleNamespace(
            objectId='obj-1', path='/src/doc.txt', permissionId=7, componentId='sig-1'
        )
        self.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(jobConfig={'nodeId': 'node-1'}))

    def preventDefault(self):
        """Raise, as the real implementation does."""
        raise _PreventDefaultRaised()


_CORE_STUBS = ('rocketlib', 'engLib', 'depends')
_NER_DIR = os.path.join(SRC_PATH, 'nodes', 'ner')


def _load_ner_iinstance():
    """
    Load the NER IInstance from source with the engine-side modules stubbed.

    Loading by file path rather than by package name keeps this independent of whether
    'nodes' resolves to nodes/ or nodes/src/nodes during a full-suite run. The node's own
    IGlobal is stubbed so no model or vendor SDK is imported, but ai.common.schema is left
    real: these tests assert against the actual Doc and DocMetadata.

    sys.modules is restored exactly, because _sys_modules_guard.py fails the whole session
    if a stub is left behind.
    """
    saved_core = {name: sys.modules.get(name) for name in _CORE_STUBS}
    saved_pkg = {k: v for k, v in sys.modules.items() if k == 'ner' or k.startswith('ner.')}
    for name in _CORE_STUBS:
        sys.modules[name] = MagicMock()
    sys.modules['rocketlib'].IInstanceBase = _FakeIInstanceBase
    try:
        pkg_spec = importlib.util.spec_from_file_location(
            'ner', os.path.join(_NER_DIR, '__init__.py'), submodule_search_locations=[_NER_DIR]
        )
        # Registered but not executed: the relative imports only need the package to exist.
        sys.modules['ner'] = importlib.util.module_from_spec(pkg_spec)

        iglobal_stub = types.ModuleType('ner.IGlobal')
        iglobal_stub.IGlobal = type('FakeIGlobal', (), {})
        sys.modules['ner.IGlobal'] = iglobal_stub

        spec = importlib.util.spec_from_file_location('ner.IInstance', os.path.join(_NER_DIR, 'IInstance.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules['ner.IInstance'] = mod
        spec.loader.exec_module(mod)
        return mod.IInstance
    finally:
        for mod_name in [k for k in sys.modules if k == 'ner' or k.startswith('ner.')]:
            sys.modules.pop(mod_name, None)
        sys.modules.update(saved_pkg)
        for name, mod in saved_core.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


IInstance = _load_ner_iinstance()

from ai.common.schema import Doc, DocMetadata  # noqa: E402


def _run_write_documents(instance, docs):
    """Invoke writeDocuments, absorbing the preventDefault() the node raises at the end."""
    with pytest.raises(_PreventDefaultRaised):
        instance.writeDocuments(docs)


class TestNerWriteDocuments:
    """Regression tests for the NER node's writeDocuments method."""

    @staticmethod
    def _instance(entities):
        """Build a node instance whose recognizer returns the given entities."""
        instance = IInstance()
        instance.IGlobal = MagicMock()
        instance.IGlobal.recognizer.store_in_metadata = True
        instance.IGlobal.recognizer.extract_entities.return_value = entities
        return instance

    @staticmethod
    def _enriched(instance):
        """Return the single document the node forwarded downstream."""
        enriched_docs = instance.instance.writeDocuments.call_args[0][0]
        assert len(enriched_docs) == 1
        return enriched_docs[0]

    def test_write_documents_enrichment(self):
        """Entities land on the copy's metadata as attributes, grouped and deduplicated."""
        instance = self._instance(
            [
                {'entity_group': 'PER', 'word': 'Alice'},
                {'entity_group': 'PER', 'word': 'Bob'},
                {'entity_group': 'ORG', 'word': 'OpenAI'},
            ]
        )
        doc = Doc(
            page_content='Alice and Bob work at OpenAI.',
            metadata=DocMetadata(objectId='test_obj', chunkId=1),
        )

        _run_write_documents(instance, [doc])

        enriched = self._enriched(instance)
        assert enriched.metadata.entities_per == ['Alice', 'Bob']
        assert enriched.metadata.entities_org == ['OpenAI']
        assert enriched.metadata.entities_count == 3
        # Metadata the document already carried is preserved, not replaced.
        assert enriched.metadata.objectId == 'test_obj'
        assert enriched.metadata.chunkId == 1

    def test_write_documents_does_not_mutate_the_original(self):
        """The deep copy leaves the caller's document and its metadata untouched."""
        instance = self._instance([{'entity_group': 'PER', 'word': 'Alice'}])
        doc = Doc(page_content='Alice.', metadata=DocMetadata(objectId='test_obj', chunkId=1))

        _run_write_documents(instance, [doc])

        enriched = self._enriched(instance)
        assert enriched is not doc
        assert enriched.metadata is not doc.metadata
        assert not hasattr(doc.metadata, 'entities_per')
        assert not hasattr(doc.metadata, 'entities_count')

    def test_write_documents_initializes_missing_metadata(self):
        """A document without metadata gets identity from the object being processed."""
        instance = self._instance([])
        doc = Doc(page_content='No entities here.', metadata=None)

        _run_write_documents(instance, [doc])

        enriched = self._enriched(instance)
        assert isinstance(enriched.metadata, DocMetadata)
        # Inherited from instance.currentObject rather than a hardcoded placeholder.
        assert enriched.metadata.objectId == 'obj-1'
        assert enriched.metadata.parent == '/src/doc.txt'
        assert enriched.metadata.permissionId == 7
        assert enriched.metadata.nodeId == 'node-1'
        assert enriched.metadata.chunkId == 0

    def test_entity_fields_survive_serialization(self):
        """Entity fields written via setattr still appear in the serialized metadata."""
        instance = self._instance([{'entity_group': 'PER', 'word': 'Alice'}])
        doc = Doc(page_content='Alice.', metadata=DocMetadata(objectId='test_obj', chunkId=1))

        _run_write_documents(instance, [doc])

        serialized = self._enriched(instance).metadata.toDict()
        assert serialized['entities_per'] == ['Alice']
        assert serialized['entities_count'] == 1
