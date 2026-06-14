# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Standalone unit tests for the Landing.ai Parse node.

Parse's input lane is binary (`tags`), which doesn't fit the declarative
services.json test framework — so we test it here by feeding bytes straight to
the Parser with the landingai_ade SDK shadowed by the project mock (the same
approach reducto/llamaparse would need). No server required.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

# Resolve repo locations from this file: nodes/test/landing_ai/parse/test_parse.py
_TEST_ROOT = Path(__file__).resolve().parents[2]  # nodes/test
# Import the node package as top-level `landing_ai` from source, so relative
# imports resolve within it and we test source rather than the built dist copy.
_PKG_ROOT = Path(__file__).resolve().parents[3] / 'src' / 'nodes'  # nodes/src/nodes
_MOCKS_DIR = _TEST_ROOT / 'mocks'


def _import_scoped():
    """Import the node + landingai_ade mock without leaking sys.path.

    nodes/src/nodes must be on sys.path only while importing — leaving it there
    would let a node dir whose name matches a real library (e.g. `weaviate`)
    shadow that library for sibling tests sharing this xdist worker. We restore
    sys.path afterward; the imported modules stay cached in sys.modules (so the
    node's lazy `import landingai_ade` still resolves to the mock).
    """
    saved = sys.path[:]
    sys.path.insert(0, str(_MOCKS_DIR))
    sys.path.insert(0, str(_PKG_ROOT))
    try:
        landingai_ade = importlib.import_module('landingai_ade')  # the mock
        parse_mod = importlib.import_module('landing_ai.parse.parse')
    finally:
        sys.path[:] = saved
    return parse_mod.Parser, landingai_ade.LandingAIADE


Parser, LandingAIADE = _import_scoped()
_parse_mod = importlib.import_module('landing_ai.parse.parse')


def _make_parser() -> Parser:
    """Build a Parser without running __init__ (which reads engine config)."""
    parser = Parser.__new__(Parser)
    parser._api_key = 'test-key'
    parser._model = 'dpt-2-latest'
    parser._region = 'production'
    return parser


def test_parse_returns_markdown_and_tables() -> None:
    """parse() should map the ADE response to (markdown, [table blocks])."""
    parser = _make_parser()

    text, tables = parser.parse(b'%PDF-1.4 mock bytes', 'invoice.pdf')

    assert 'Mock Document' in text
    assert len(tables) == 1
    assert '| a | b |' in tables[0]


def test_parse_passes_model_and_document_tuple_to_sdk() -> None:
    """parse() should hand the SDK a (filename, bytes) tuple and the configured model."""
    parser = _make_parser()

    parser.parse(b'mock bytes', 'invoice.pdf')

    kwargs = LandingAIADE.last_parse_kwargs
    assert kwargs['model'] == 'dpt-2-latest'
    # The SDK takes a (filename, bytes) tuple directly — no temp file.
    assert kwargs['document'] == ('invoice.pdf', b'mock bytes')


def test_parse_sniffs_filename_when_absent() -> None:
    """parse() should derive a typed filename when none is given."""
    parser = _make_parser()

    parser.parse(b'%PDF-1.4 mock bytes')  # no file_name

    name, data = LandingAIADE.last_parse_kwargs['document']
    # filetype detects the PDF (upload.pdf); falls back to a .pdf name otherwise.
    assert name.endswith('.pdf')
    assert data == b'%PDF-1.4 mock bytes'


def test_parse_without_api_key_returns_empty() -> None:
    """parse() should fail closed (empty result) when no API key is set."""
    parser = _make_parser()
    parser._api_key = None

    text, tables = parser.parse(b'mock bytes', 'invoice.pdf')

    assert text == ''
    assert tables == []


def test_parse_reraises_sdk_errors(monkeypatch) -> None:
    """parse() should log and propagate SDK failures, not return empty output."""
    parser = _make_parser()

    class _Boom:
        def parse(self, **kwargs):
            raise RuntimeError('sdk down')

    monkeypatch.setattr(_parse_mod, 'build_client', lambda *a, **k: _Boom())

    with pytest.raises(RuntimeError, match='sdk down'):
        parser.parse(b'mock bytes', 'invoice.pdf')


def test_map_response_filters_table_chunks() -> None:
    """_map_response should send only table-typed chunks to the table lane."""
    parser = _make_parser()

    class _Chunk:
        def __init__(self, type, markdown):
            self.type = type
            self.markdown = markdown

    class _Resp:
        markdown = 'full markdown'
        chunks = [_Chunk('text', 'para'), _Chunk('Table', '| x |'), _Chunk('table', '| y |')]
        metadata = None

    text, tables = parser._map_response(_Resp())

    assert text == 'full markdown'
    assert tables == ['| x |', '| y |']  # case-insensitive 'table' match
