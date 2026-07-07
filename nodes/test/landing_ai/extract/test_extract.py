# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Standalone unit tests for the Landing.ai Extract node.

Covers the schema-upload decode path and the extractor's response mapping with
the landingai_ade SDK shadowed by the project mock. (Extract's end-to-end lane
behavior is additionally covered by the declarative "test" block in
services.extract.json.)
"""

from __future__ import annotations

import base64
import importlib
import sys
from pathlib import Path

_TEST_ROOT = Path(__file__).resolve().parents[2]  # nodes/test
# Import the node package as top-level `landing_ai` from source (see test_parse.py).
_PKG_ROOT = Path(__file__).resolve().parents[3] / 'src' / 'nodes'  # nodes/src/nodes
_MOCKS_DIR = _TEST_ROOT / 'mocks'


def _import_scoped():
    """Import the node + landingai_ade mock without leaking sys.path.

    Leaving nodes/src/nodes on sys.path would let a node dir whose name matches a
    real library (e.g. `weaviate`) shadow it for sibling tests on this xdist
    worker. We restore sys.path after importing; the modules stay in sys.modules.
    """
    saved = sys.path[:]
    sys.path.insert(0, str(_MOCKS_DIR))
    sys.path.insert(0, str(_PKG_ROOT))
    try:
        landingai_ade = importlib.import_module('landingai_ade')  # the mock
        extract_mod = importlib.import_module('landing_ai.extract.extract')
        base_mod = importlib.import_module('landing_ai.landing_ai_base')
    finally:
        sys.path[:] = saved
    return extract_mod, base_mod, landingai_ade.LandingAIADE


_extract_mod, _base_mod, LandingAIADE = _import_scoped()
Extractor = _extract_mod.Extractor
decode_data_url = _base_mod.decode_data_url
load_schema_from_data_url = _base_mod.load_schema_from_data_url
resolve_api_key = _base_mod.resolve_api_key


def _make_extractor(schema=None, strict=False) -> Extractor:
    """Build an Extractor without running __init__ (which reads engine config)."""
    extractor = Extractor.__new__(Extractor)
    extractor._api_key = 'test-key'
    extractor._region = 'production'
    extractor._strict = strict
    extractor._schema = schema or {'type': 'object', 'properties': {'summary': {'type': 'string'}}}
    extractor._schema_error = None
    return extractor


# --- schema upload decode -------------------------------------------------


def test_load_schema_from_base64_data_url() -> None:
    """A base64 data-url JSON Schema should decode and parse to a dict."""
    schema_json = '{"type":"object","properties":{"total":{"type":"number"}}}'
    b64 = base64.b64encode(schema_json.encode('utf-8')).decode('ascii')
    data_url = f'data:application/json;base64,{b64}'

    schema = load_schema_from_data_url(data_url)

    assert schema['type'] == 'object'
    assert schema['properties']['total']['type'] == 'number'


def test_decode_data_url_handles_bare_json() -> None:
    """A bare (non-data-url) JSON string should still decode to bytes."""
    raw, _mime = decode_data_url('{"a": 1}')
    assert raw == b'{"a": 1}'


def test_load_schema_rejects_invalid_json() -> None:
    """A non-JSON upload should raise a clear ValueError."""
    import pytest

    with pytest.raises(ValueError):
        load_schema_from_data_url('not json at all {{{')


def test_load_schema_rejects_non_object() -> None:
    """A valid-JSON-but-not-an-object upload should be rejected."""
    import pytest

    with pytest.raises(ValueError, match='must be a JSON object'):
        load_schema_from_data_url('[1, 2, 3]')


def test_load_schema_rejects_bad_base64() -> None:
    """An undecodable base64 data-url should become a clean ValueError, not binascii.Error."""
    import pytest

    with pytest.raises(ValueError):
        load_schema_from_data_url('data:application/json;base64,@@@not-base64@@@')


def test_load_schema_rejects_oversized() -> None:
    """A schema larger than the cap should be rejected before json parsing."""
    import pytest

    oversized = '{"x":"' + ('a' * (3 * 1024 * 1024)) + '"}'  # ~3 MB > 2 MB cap

    with pytest.raises(ValueError, match='too large'):
        load_schema_from_data_url(oversized)


def test_load_schema_rejects_deeply_nested() -> None:
    """Pathologically nested JSON (under the size cap) should not crash, just raise ValueError."""
    import pytest

    deep = '[' * 50000 + ']' * 50000  # ~100 KB, but blows the recursion limit when parsed

    with pytest.raises(ValueError):
        load_schema_from_data_url(deep)


# --- extraction mapping ---------------------------------------------------


def test_extract_returns_extraction_payload() -> None:
    """extract() should return the response.extraction data."""
    extractor = _make_extractor()

    result = extractor.extract('# Invoice\n\nTotal: $100')

    assert result == {'summary': 'mock-extraction'}


def test_extract_passes_markdown_string_and_schema() -> None:
    """extract() should hand the SDK the Markdown content directly and the schema/strict."""
    schema = {'type': 'object', 'properties': {'x': {'type': 'string'}}}
    extractor = _make_extractor(schema=schema, strict=True)

    extractor.extract('# md content')

    kwargs = LandingAIADE.last_extract_kwargs
    # ADE Extract takes the Markdown content directly — no temp file/Path.
    assert kwargs['markdown'] == '# md content'
    # schema is passed as a JSON string (a dict would be flattened to multipart keys -> 422).
    import json

    assert isinstance(kwargs['schema'], str)
    assert json.loads(kwargs['schema']) == schema
    assert kwargs['strict'] is True


def test_extract_empty_markdown_returns_empty() -> None:
    """extract() should short-circuit on empty markdown."""
    extractor = _make_extractor()
    assert extractor.extract('   ') == {}


def test_extract_reraises_sdk_errors(monkeypatch) -> None:
    """extract() should log and propagate SDK failures, not return empty output."""
    import pytest

    extractor = _make_extractor()

    class _Boom:
        def extract(self, **kwargs):
            raise RuntimeError('sdk down')

    monkeypatch.setattr(_extract_mod, 'build_client', lambda *a, **k: _Boom())

    with pytest.raises(RuntimeError, match='sdk down'):
        extractor.extract('# md content')


def test_extract_raises_on_deferred_schema_error() -> None:
    """A schema error captured at init should surface when extract() runs."""
    import pytest

    extractor = _make_extractor()
    extractor._schema_error = 'uploaded schema is not valid JSON'

    with pytest.raises(ValueError, match='not valid JSON'):
        extractor.extract('# md content')


# --- credential resolution ------------------------------------------------


def test_resolve_api_key_prefers_config_then_env(monkeypatch) -> None:
    """resolve_api_key should use the config key, else ROCKETRIDE_LANDING_AI_KEY."""
    monkeypatch.setenv('ROCKETRIDE_LANDING_AI_KEY', 'env-key')
    assert resolve_api_key({'api_key': 'cfg-key'}) == 'cfg-key'
    assert resolve_api_key({'api_key': '   '}) == 'env-key'
    assert resolve_api_key({}) == 'env-key'

    monkeypatch.delenv('ROCKETRIDE_LANDING_AI_KEY', raising=False)
    assert resolve_api_key({}) is None
