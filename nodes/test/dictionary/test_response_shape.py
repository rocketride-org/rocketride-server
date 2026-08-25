# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Deterministic response-shape tests for the dictionary node."""

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest


_NODE_ROOT = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
_STUB_MODULES = ('rocketlib', 'rocketlib.types', 'ai', 'ai.common', 'ai.common.schema')
_MISSING = object()


class _StubDoc:
    def __init__(self, page_content, metadata):
        self.page_content = page_content
        self.metadata = metadata


class _StubDocMetadata:
    def __init__(self, owner, **values):
        self.owner = owner
        self.values = values


class _Answer:
    def __init__(self, value):
        self.value = value

    def getJson(self):
        return self.value


class _InvalidJsonAnswer:
    def getJson(self):
        raise ValueError('Answer is not in JSON format.')


def _install_stubs(monkeypatch):
    """Force deterministic stubs, regardless of modules left by earlier tests."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.__path__ = []
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.Entry = object
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')

    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = MagicMock()
    rocketlib.types = rocketlib_types

    ai = types.ModuleType('ai')
    ai.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    ai_schema = types.ModuleType('ai.common.schema')
    ai_schema.Answer = object
    ai_schema.Doc = _StubDoc
    ai_schema.DocMetadata = _StubDocMetadata
    ai_schema.Question = MagicMock()
    ai_schema.QuestionType = types.SimpleNamespace(QUESTION='question')
    ai.common = ai_common
    ai_common.schema = ai_schema

    for name, module in {
        'rocketlib': rocketlib,
        'rocketlib.types': rocketlib_types,
        'ai': ai,
        'ai.common': ai_common,
        'ai.common.schema': ai_schema,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)


@pytest.fixture
def dictionary_module(monkeypatch, request):
    """Import the node with local engine/schema stubs and restore module state."""
    original_path = list(sys.path)
    original_stubs = {name: sys.modules.get(name, _MISSING) for name in _STUB_MODULES}
    original_node_modules = {
        name: module for name, module in sys.modules.items() if name == 'dictionary' or name.startswith('dictionary.')
    }

    def restore_import_state():
        for name in tuple(sys.modules):
            if (name == 'dictionary' or name.startswith('dictionary.')) and name not in original_node_modules:
                del sys.modules[name]
        sys.modules.update(original_node_modules)

        assert sys.path == original_path
        for name, original_module in original_stubs.items():
            if original_module is _MISSING:
                assert name not in sys.modules
            else:
                assert sys.modules[name] is original_module

    request.addfinalizer(restore_import_state)

    with monkeypatch.context() as patch:
        _install_stubs(patch)
        for name in original_node_modules:
            patch.delitem(sys.modules, name)

        patch.syspath_prepend(str(_NODE_ROOT))
        yield importlib.import_module('dictionary.IInstance')


def _make_instance(dictionary_module):
    instance_type = dictionary_module.IInstance
    instance = instance_type.__new__(instance_type)
    instance.instance = MagicMock()
    instance.chunkId = 0
    return instance


def test_array_emits_one_document_per_definition_with_incrementing_metadata(dictionary_module):
    instance = _make_instance(dictionary_module)
    definitions = [
        {'term': 'Red loan', 'description': 'A delinquent loan below the credit-score threshold.'},
        {'term': 'CPMD', 'description': 'Credit Portfolio Marketing Division.'},
    ]

    instance.writeAnswers(_Answer(definitions))

    instance.instance.writeDocuments.assert_called_once()
    documents = instance.instance.writeDocuments.call_args.args[0]
    assert [json.loads(document.page_content) for document in documents] == definitions
    assert [document.metadata.values['chunkId'] for document in documents] == [0, 1]
    assert all(document.metadata.values['isTable'] is False for document in documents)
    assert all(document.metadata.values['tableId'] == 0 for document in documents)
    assert instance.chunkId == 2


def test_empty_array_is_valid_and_emits_an_empty_document_batch(dictionary_module):
    instance = _make_instance(dictionary_module)

    instance.writeAnswers(_Answer([]))

    instance.instance.writeDocuments.assert_called_once_with([])
    assert instance.chunkId == 0


@pytest.mark.parametrize('value', [{'term': 'CPMD'}, 'definition', 42, None])
def test_non_array_json_is_rejected_before_any_documents_are_emitted(dictionary_module, value):
    instance = _make_instance(dictionary_module)

    with pytest.raises(ValueError, match='expected the LLM response to be a JSON array of definitions'):
        instance.writeAnswers(_Answer(value))

    instance.instance.writeDocuments.assert_not_called()
    assert instance.chunkId == 0


def test_invalid_json_error_propagates_without_emitting_documents(dictionary_module):
    instance = _make_instance(dictionary_module)

    with pytest.raises(ValueError, match='Answer is not in JSON format'):
        instance.writeAnswers(_InvalidJsonAnswer())

    instance.instance.writeDocuments.assert_not_called()
    assert instance.chunkId == 0
