# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for Astra DB Store._convertFilter soft-delete semantics.

Ensures default DocFilter behavior matches other vector stores: soft-deleted
documents are excluded unless the caller explicitly sets isDeleted=True.
"""

from ai.common.schema import DocFilter

from nodes.astra_db.astra_db import Store


def _store():
    """Bare Store instance; _convertFilter does not use initialized fields."""
    return Store.__new__(Store)


def test_convert_filter_default_excludes_deleted():
    """Empty DocFilter should add meta.isDeleted == False."""
    store = _store()
    f = DocFilter()
    result = store._convertFilter(f)
    assert result.get('meta.isDeleted') is False


def test_convert_filter_isdeleted_false_excludes_deleted():
    """Explicit isDeleted=False should add meta.isDeleted == False."""
    store = _store()
    f = DocFilter(isDeleted=False)
    result = store._convertFilter(f)
    assert result.get('meta.isDeleted') is False


def test_convert_filter_isdeleted_true_omits_deleted_clause():
    """isDeleted=True should not constrain meta.isDeleted (include deleted docs)."""
    store = _store()
    f = DocFilter(isDeleted=True)
    result = store._convertFilter(f)
    assert 'meta.isDeleted' not in result


def test_convert_filter_isdeleted_none_with_nodeid_still_excludes_deleted():
    """isDeleted=None should still default to excluding soft-deleted rows."""
    store = _store()
    f = DocFilter(nodeId='n1', isDeleted=None)
    result = store._convertFilter(f)
    assert result['meta.nodeId'] == 'n1'
    assert result.get('meta.isDeleted') is False
