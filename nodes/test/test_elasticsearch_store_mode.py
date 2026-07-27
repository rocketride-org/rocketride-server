"""Tests for Elasticsearch store_mode / mode config key selection.

Covers:
- Unit tests for _parse_mode_elasticsearch helper
- Integration tests for IGlobal._begin_elasticsearch key-selection and fallback logic
"""

import pytest
from unittest.mock import MagicMock, patch

from nodes.index_search.IGlobal import _parse_mode_elasticsearch
from nodes.index_search.constants import MODE_INDEX, MODE_VSTORE


# ---------------------------------------------------------------------------
# Unit tests — _parse_mode_elasticsearch helper
# ---------------------------------------------------------------------------


def test_parse_mode_elasticsearch():
    """Verify _parse_mode_elasticsearch maps all documented input variants correctly.

    Covers boolean True/False, string aliases ('self-managed', 'index',
    'vstore', 'vector_database', 'false', 'true', ''), and unknown strings
    that should default to MODE_VSTORE.
    """
    # Boolean inputs
    assert _parse_mode_elasticsearch(True) == MODE_VSTORE
    assert _parse_mode_elasticsearch(False) == MODE_INDEX

    # String inputs that map to MODE_INDEX
    assert _parse_mode_elasticsearch('false') == MODE_INDEX
    assert _parse_mode_elasticsearch('index') == MODE_INDEX
    assert _parse_mode_elasticsearch('') == MODE_INDEX

    # String inputs that map to MODE_VSTORE
    assert _parse_mode_elasticsearch('self-managed') == MODE_VSTORE
    assert _parse_mode_elasticsearch('true') == MODE_VSTORE
    assert _parse_mode_elasticsearch('vstore') == MODE_VSTORE
    assert _parse_mode_elasticsearch('vector_database') == MODE_VSTORE

    # Unknown strings default to MODE_VSTORE
    assert _parse_mode_elasticsearch('unknown-value') == MODE_VSTORE


# ---------------------------------------------------------------------------
# Integration tests — IGlobal._begin_elasticsearch key-selection logic
#
# We patch out the heavy I/O (Store constructor, super().beginGlobal) and test
# only the config-reading / mode-assignment logic inside _begin_elasticsearch.
# ---------------------------------------------------------------------------


def _make_iglobal():
    """Return a minimally configured IGlobal instance with I/O dependencies mocked."""
    from nodes.index_search.IGlobal import IGlobal

    glb = IGlobal.__new__(IGlobal)
    glb.glb = MagicMock()
    glb.IEndpoint = MagicMock()
    glb.search_enabled = False
    glb.search_match_operator = 'or'
    glb.search_exact_slop = 0
    glb.search_highlight_enabled = False
    glb.search_highlight_fragment_size = 200
    glb.mode = MODE_VSTORE
    glb.store = None
    return glb


def _run_begin_elasticsearch(connConfig):
    """Helper: create an IGlobal and call _begin_elasticsearch with patched I/O."""
    glb = _make_iglobal()
    mock_store = MagicMock()
    mock_store.host = 'localhost'
    mock_store.port = 9200
    mock_store.index = 'test-index'

    with patch('nodes.index_search.IGlobal.IGlobalTransform.beginGlobal', return_value=None), \
         patch('nodes.index_search.elasticsearch_store.Store', return_value=mock_store):
        glb._begin_elasticsearch(connConfig, {})

    return glb


# -- Scenario 1: store_mode present → store_mode is used, legacy mode is ignored --


def test_begin_elasticsearch_store_mode_false_wins_over_legacy_self_managed():
    """Verify store_mode=False → MODE_INDEX even when legacy mode='self-managed'.

    When both 'store_mode' and 'mode' exist in connConfig, store_mode must
    take precedence.
    """
    glb = _run_begin_elasticsearch({'store_mode': False, 'mode': 'self-managed'})
    assert glb.mode == MODE_INDEX, (
        "store_mode=False must resolve to MODE_INDEX even when legacy mode='self-managed'"
    )


def test_begin_elasticsearch_store_mode_true_gives_vstore():
    """Verify store_mode=True → MODE_VSTORE regardless of legacy mode value."""
    glb = _run_begin_elasticsearch({'store_mode': True, 'mode': 'index'})
    assert glb.mode == MODE_VSTORE


# -- Scenario 2: no store_mode key, only legacy boolean mode → fallback to mode --


def test_begin_elasticsearch_fallback_legacy_bool_false():
    """Verify _begin_elasticsearch falls back to legacy boolean mode=False → MODE_INDEX.

    When 'store_mode' is absent, the legacy 'mode' key must be used.
    """
    glb = _run_begin_elasticsearch({'mode': False})
    assert glb.mode == MODE_INDEX


def test_begin_elasticsearch_fallback_legacy_bool_true():
    """Verify legacy boolean mode=True falls back to MODE_VSTORE."""
    glb = _run_begin_elasticsearch({'mode': True})
    assert glb.mode == MODE_VSTORE


# -- Scenario 3: only legacy deployment-profile string → fallback and map correctly --


def test_begin_elasticsearch_fallback_legacy_string_self_managed():
    """Verify legacy deployment-profile string mode='self-managed' falls back to MODE_VSTORE.

    'self-managed' is a deployment profile value (not a boolean) that must
    map to MODE_VSTORE through the _parse_mode_elasticsearch fallback.
    """
    glb = _run_begin_elasticsearch({'mode': 'self-managed'})
    assert glb.mode == MODE_VSTORE, (
        "Legacy deployment-profile 'self-managed' should map to MODE_VSTORE"
    )


def test_begin_elasticsearch_fallback_legacy_string_index():
    """Verify legacy deployment-profile string mode='index' falls back to MODE_INDEX."""
    glb = _run_begin_elasticsearch({'mode': 'index'})
    assert glb.mode == MODE_INDEX


# -- Scenario 4: both keys present → store_mode always wins --


def test_begin_elasticsearch_store_mode_wins_over_all_legacy_variants():
    """Verify store_mode takes precedence over every possible legacy mode value.

    Tests three sub-cases: legacy mode as True, 'self-managed', and False.
    In all cases store_mode=False must produce MODE_INDEX.
    """
    for legacy_mode in [True, 'self-managed', False]:
        glb = _run_begin_elasticsearch({'store_mode': False, 'mode': legacy_mode})
        assert glb.mode == MODE_INDEX, (
            f"store_mode=False must win over legacy mode={legacy_mode!r}; got {glb.mode}"
        )


# -- Edge case: neither key present → default to MODE_VSTORE --


def test_begin_elasticsearch_defaults_to_vstore_when_no_mode_key():
    """Verify _begin_elasticsearch defaults to MODE_VSTORE when connConfig has no mode keys."""
    glb = _run_begin_elasticsearch({})
    assert glb.mode == MODE_VSTORE
