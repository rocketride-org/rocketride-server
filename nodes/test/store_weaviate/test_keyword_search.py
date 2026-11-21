# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression test: Weaviate keyword search matches the question text."""

from __future__ import annotations

from ai.common.schema import DocFilter, QuestionText

from .test_record_updates import _make_obj_records, _make_store


def test_keyword_search_matches_the_question_text() -> None:
    """The store builds the LIKE pattern from ``query.text``, not from the model repr."""
    records = _make_obj_records('obj-1', 2, is_deleted=False)
    records['obj-1-0']['properties']['content'] = 'the quick brown fox'
    records['obj-1-1']['properties']['content'] = 'a lazy dog'
    store, _ = _make_store(records)

    docs = store.searchKeyword(QuestionText(text='brown'), DocFilter(limit=10))

    assert [doc.page_content for doc in docs] == ['the quick brown fox']
