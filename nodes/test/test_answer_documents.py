# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the answer_documents node.

Verifies the pure answers -> document-content mapping and handler wiring without
the engine:
  - a JSON list yields one page_content per item (each fact indexed separately)
  - a JSON object yields a single page_content
  - a plain-text answer yields a single page_content
  - invalid JSON falls back to plain text
  - an empty / whitespace / null answer yields nothing
  - JSON list items that are already strings are used verbatim
  - the engine default forwards each original answer exactly once
"""

import importlib
import json
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'answer_documents'))
from adapt import answer_contents  # noqa: E402


class FakeAnswer:
    """Minimal stand-in for ai.common.schema.Answer (duck-typed)."""

    def __init__(self, value, is_json):
        self._value = value
        self._is_json = is_json

    def isJson(self):
        return self._is_json

    def getJson(self):
        return self._value

    def getText(self):
        if self._value is None:
            return ''
        if isinstance(self._value, (dict, list)):
            return json.dumps(self._value)
        return str(self._value)


class InvalidJsonAnswer(FakeAnswer):
    """Answer flagged as JSON whose payload cannot be decoded."""

    def getJson(self):
        raise ValueError('invalid JSON')


@pytest.fixture
def answer_documents_iinstance(monkeypatch):
    """Import IInstance with minimal engine/schema stubs."""
    node_root = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes')
    monkeypatch.syspath_prepend(node_root)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.Entry = object
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')

    ai = types.ModuleType('ai')
    common = types.ModuleType('ai.common')
    schema = types.ModuleType('ai.common.schema')

    class Doc:
        def __init__(self, page_content, metadata):
            self.page_content = page_content
            self.metadata = metadata

    class DocMetadata:
        def __init__(self, owner, **values):
            self.owner = owner
            self.values = values

    schema.Answer = object
    schema.Doc = Doc
    schema.DocMetadata = DocMetadata

    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'ai', ai)
    monkeypatch.setitem(sys.modules, 'ai.common', common)
    monkeypatch.setitem(sys.modules, 'ai.common.schema', schema)

    for module_name in ('answer_documents.IInstance', 'answer_documents.IGlobal', 'answer_documents'):
        sys.modules.pop(module_name, None)

    instance_type = importlib.import_module('answer_documents.IInstance').IInstance
    yield instance_type

    for module_name in ('answer_documents.IInstance', 'answer_documents.IGlobal', 'answer_documents'):
        sys.modules.pop(module_name, None)


def test_json_list_yields_one_document_per_fact():
    facts = [
        {'metric': 'revenue', 'period': 'FY2024', 'value': '5.2M'},
        {'metric': 'gross_margin', 'period': 'FY2024', 'value': '61%'},
    ]
    contents = answer_contents(FakeAnswer(facts, is_json=True))
    assert len(contents) == 2
    assert json.loads(contents[0])['metric'] == 'revenue'
    assert json.loads(contents[1])['value'] == '61%'


def test_json_object_yields_single_document():
    contents = answer_contents(FakeAnswer({'total': 5, 'currency': 'USD'}, is_json=True))
    assert contents == [json.dumps({'total': 5, 'currency': 'USD'}, ensure_ascii=False)]


def test_json_list_of_strings_uses_items_verbatim():
    contents = answer_contents(FakeAnswer(['fact one', 'fact two'], is_json=True))
    assert contents == ['fact one', 'fact two']


def test_plain_text_yields_single_document():
    contents = answer_contents(FakeAnswer('The 2024 audited revenue was $5.2M.', is_json=False))
    assert contents == ['The 2024 audited revenue was $5.2M.']


def test_invalid_json_falls_back_to_plain_text():
    contents = answer_contents(InvalidJsonAnswer('unstructured answer', is_json=True))
    assert contents == ['unstructured answer']


def test_invalid_json_with_empty_text_yields_nothing():
    assert answer_contents(InvalidJsonAnswer('   ', is_json=True)) == []


def test_empty_and_null_answers_yield_nothing():
    assert answer_contents(FakeAnswer('   ', is_json=False)) == []
    assert answer_contents(FakeAnswer('', is_json=False)) == []
    assert answer_contents(FakeAnswer(None, is_json=True)) == []


def test_json_empty_list_yields_nothing():
    assert answer_contents(FakeAnswer([], is_json=True)) == []


def test_write_answers_forwards_downstream_exactly_once_via_engine_default(answer_documents_iinstance):
    """The override emits documents but leaves answer forwarding to the engine."""
    node = answer_documents_iinstance.__new__(answer_documents_iinstance)
    node.instance = MagicMock()
    node.preventDefault = MagicMock()
    node.chunkId = 0
    node.instance.hasListener.return_value = True
    answer = FakeAnswer(['fact one', {'fact': 'two'}], is_json=True)

    node.writeAnswers(answer)

    node.instance.hasListener.assert_called_once_with('documents')
    node.instance.writeDocuments.assert_called_once()
    documents = node.instance.writeDocuments.call_args.args[0]
    assert [document.page_content for document in documents] == ['fact one', json.dumps({'fact': 'two'})]
    node.instance.writeAnswers.assert_not_called()
    node.preventDefault.assert_not_called()


def test_write_answers_skips_document_build_without_listener(answer_documents_iinstance):
    node = answer_documents_iinstance.__new__(answer_documents_iinstance)
    node.instance = MagicMock()
    node.preventDefault = MagicMock()
    node.chunkId = 0
    node.instance.hasListener.return_value = False
    answer = MagicMock()

    node.writeAnswers(answer)

    node.instance.hasListener.assert_called_once_with('documents')
    answer.isJson.assert_not_called()
    node.instance.writeDocuments.assert_not_called()
    node.instance.writeAnswers.assert_not_called()
    node.preventDefault.assert_not_called()
