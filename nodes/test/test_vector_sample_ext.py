# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How the ``sample`` tool says where its points came from (contract section 4.4-B).

Without a native sampler, ``sample`` builds its key space from the document
listing. Every answer now carries ``listing``: how many documents the sampler
listed, whether the listing still had pages left when it stopped
(``truncated``) and why it stopped (``reason``):

* ``'complete'``: the store handed out no further cursor;
* ``'cap'``: the row cap was reached with documents left (500 documents, or the
  whole scope when ``filter.object_ids`` names more, up to ``scope_keys_max``);
* ``'stale'``: pages in a row without a new document, or a store that says it
  cannot page;
* ``'pages'``: the pages the row budget needs plus the slack pages;
* ``'budget'``: the listing's share of the sample's time budget.

A truncated listing adds the caveat ``listing_truncated``. A native sampler lists
nothing; its key space is the whole scope, so its listing is complete. ``of`` is
unchanged and is never a scope count.
"""

from __future__ import annotations

from typing import List

import pytest

from ai.common.store import document_store as _store_module
from ai.common.store import vx_tools
from ai.common.store.vx_types import LISTING_REASONS, DocPage

from .test_vector_hooks import ExactListingStore, NativeStratifiedStore, VectorMemoryStore, corpus, make_doc
from .test_vectordb_tool_mixin import _EmptyPageListing, _RepeatingListing, _backend_calls, node


def _single_chunk_docs(count: int, *, dim: int = 4, prefix: str = 'd') -> list:
    return [make_doc(f'{prefix}{i:04d}', 0, dim=dim) for i in range(count)]


def _listing(answer) -> dict:
    assert answer['success'] is True, answer
    listing = answer['listing']
    assert set(listing) == {'documents', 'truncated', 'reason'}
    assert listing['reason'] in LISTING_REASONS
    assert listing['truncated'] is (listing['reason'] != 'complete')
    assert ('listing_truncated' in answer.get('caveats', [])) is listing['truncated']
    return listing


class _PagedListing(ExactListingStore):
    """A sorted, distinct listing whose store hands out at most ``page_rows`` documents per page."""

    page_rows = 300

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort) -> DocPage:
        return super().listDocumentPage(
            cursor=cursor, limit=min(limit, self.page_rows), object_ids=object_ids, deleted=deleted, sort=sort
        )


class _EndlessListing(VectorMemoryStore):
    """Every page brings one new document (never stored) and a cursor: only the page budget ends it."""

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort):
        self.calls.append(('listDocumentPage', cursor, limit))
        page = len(_backend_calls(self, 'listDocumentPage'))
        if page > 200:
            raise RuntimeError(f'asked for {page} pages: the listing loop does not end')
        row = _store_module.documentRow(make_doc(f'ghost{page:03d}', 0))
        return DocPage([row], f'c{page}', None, False, True, True, [])


class _UnpageableListing(VectorMemoryStore):
    """A store that lists one page and says it cannot page further (as the base listing does on a repeat)."""

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort):
        self.calls.append(('listDocumentPage', cursor, limit))
        firsts = [doc for key, doc in self.rows.items() if key[1] == 0 and key[0] != 'schema'][:2]
        rows = [_store_module.documentRow(doc) for doc in firsts]
        return DocPage(rows, None, None, False, True, True, ['documents_paging_unsupported'])


# ---------------------------------------------------------------------------
# One case per reason
# ---------------------------------------------------------------------------


def test_a_listing_that_ends_by_itself_is_complete():
    store = ExactListingStore().seed(_single_chunk_docs(12))
    answer = node(store).sample({'n': 5, 'seed': 3})
    assert _listing(answer) == {'documents': 12, 'truncated': False, 'reason': 'complete'}
    assert 'caveats' not in answer


def test_six_hundred_documents_without_a_scope_stop_at_the_cap():
    store = ExactListingStore().seed(_single_chunk_docs(600))
    answer = node(store).sample({'n': 20, 'seed': 1})
    assert _listing(answer) == {'documents': 500, 'truncated': True, 'reason': 'cap'}
    assert answer['caveats'] == ['listing_truncated']
    # of is the store's own count, never the sampler's listing.
    assert answer['of'] == {'chunks': 600, 'documents': 600}


def test_exactly_the_cap_with_no_page_left_is_complete():
    store = ExactListingStore().seed(_single_chunk_docs(500))
    assert _listing(node(store).sample({'n': 5})) == {'documents': 500, 'truncated': False, 'reason': 'complete'}


@pytest.mark.parametrize('store_cls', [_EmptyPageListing, _RepeatingListing])
def test_pages_without_a_new_document_are_stale(store_cls):
    store = store_cls().seed(corpus({'a': [0, 1], 'b': [0, 1]}, dim=8))
    answer = node(store).sample({'n': 10})
    listing = _listing(answer)
    assert listing['reason'] == 'stale' and listing['truncated'] is True
    assert listing['documents'] == (0 if store_cls is _EmptyPageListing else 2)
    assert 'listing_truncated' in answer['caveats']
    assert len(_backend_calls(store, 'listDocumentPage')) <= 3


def test_a_store_that_cannot_page_is_a_stale_listing():
    store = _UnpageableListing().seed(corpus({'a': [0], 'b': [0], 'c': [0]}, dim=8))
    listing = _listing(node(store).sample({'n': 10}))
    assert listing == {'documents': 2, 'truncated': True, 'reason': 'stale'}


def test_a_listing_that_never_ends_stops_at_its_page_budget():
    store = _EndlessListing().seed(corpus({'a': [0, 1], 'b': [0]}, dim=8))
    answer = node(store).sample({'n': 10})
    pages = 1 + vx_tools.LISTING_SLACK_PAGES
    assert _listing(answer) == {'documents': pages, 'truncated': True, 'reason': 'pages'}
    # The listing's pages, plus the one page that looks up the paths of documents it never listed.
    assert len(_backend_calls(store, 'listDocumentPage')) == pages + 1
    assert answer['n'] == 3, 'the refill still draws what the store holds'


def test_a_slow_listing_stops_at_its_share_of_the_time_budget(monkeypatch):
    clock = [1000.0]
    budget_s = vx_tools.LIMITS['sample_budget_ms'] / 1000.0
    page_s = budget_s * vx_tools.SAMPLE_LISTING_BUDGET_SHARE * 0.6

    class Slow(_PagedListing):
        page_rows = 2

        def listDocumentPage(self, **kw):
            clock[0] += page_s
            return super().listDocumentPage(**kw)

    monkeypatch.setattr(vx_tools, '_monotonic', lambda: clock[0])
    store = Slow().seed(_single_chunk_docs(7))
    answer = node(store).sample({'n': 4})
    assert _listing(answer) == {'documents': 4, 'truncated': True, 'reason': 'budget'}
    assert answer['n'] == 4


def test_the_listing_object_is_the_same_on_a_light_sample():
    store = ExactListingStore().seed(_single_chunk_docs(600))
    answer = node(store).sample({'n': 50, 'mode': 'light'})
    assert _listing(answer) == {'documents': 500, 'truncated': True, 'reason': 'cap'}


# ---------------------------------------------------------------------------
# A scope is listed whole
# ---------------------------------------------------------------------------


def test_a_scope_of_twelve_hundred_documents_is_listed_whole_over_four_pages():
    store = _PagedListing().seed(_single_chunk_docs(1300))
    scope: List[str] = [f'd{i:04d}' for i in range(1200)]
    answer = node(store).sample({'n': 2000, 'seed': 5, 'filter': {'object_ids': scope}})
    assert _listing(answer) == {'documents': 1200, 'truncated': False, 'reason': 'complete'}
    assert len(_backend_calls(store, 'listDocumentPage')) == 4
    # Every scoped document has its chunk 0 in the stratified pick: no refill, no bias.
    assert {doc['objectId'] for doc in answer['docs']} == set(scope)
    assert (answer['n'], answer['biased'], answer['strategy_used']) == (1200, False, 'stratified')


def test_a_scope_smaller_than_the_default_still_lists_up_to_the_default():
    store = _PagedListing().seed(_single_chunk_docs(40))
    scope = [f'd{i:04d}' for i in range(0, 40, 2)]
    answer = node(store).sample({'n': 100, 'filter': {'object_ids': scope}})
    assert _listing(answer) == {'documents': 20, 'truncated': False, 'reason': 'complete'}
    assert {doc['objectId'] for doc in answer['docs']} == set(scope)


def test_the_scope_never_widens_the_listing_beyond_the_scope_limit():
    scope_max = vx_tools.LIMITS['scope_keys_max']
    answer = node(ExactListingStore().seed(_single_chunk_docs(3))).sample(
        {'n': 5, 'filter': {'object_ids': [f'x{i}' for i in range(scope_max + 1)]}}
    )
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')


def test_a_scoped_sample_without_scoped_documents_lists_none():
    store = ExactListingStore().seed(_single_chunk_docs(5))
    answer = node(store).sample({'n': 5, 'filter': {'object_ids': ['nowhere']}})
    assert _listing(answer) == {'documents': 0, 'truncated': False, 'reason': 'complete'}
    assert answer['n'] == 0


# ---------------------------------------------------------------------------
# A native sampler lists nothing: its key space is the whole scope
# ---------------------------------------------------------------------------


def test_a_native_sampler_reports_a_complete_listing_of_the_counted_documents():
    store = NativeStratifiedStore().seed(corpus({'a': [0, 1], 'b': [0], 'c': [0, 1, 2]}, dim=8))
    answer = node(store).sample({'n': 4})
    assert answer['strategy_used'] == 'stratified'
    assert _listing(answer) == {'documents': 3, 'truncated': False, 'reason': 'complete'}


def test_a_scoped_native_sample_counts_the_scope():
    store = NativeStratifiedStore().seed(corpus({'a': [0, 1], 'b': [0], 'c': [0, 1, 2]}, dim=8))
    answer = node(store).sample({'n': 10, 'filter': {'object_ids': ['a', 'c']}})
    assert _listing(answer) == {'documents': 2, 'truncated': False, 'reason': 'complete'}


def test_a_native_sampler_that_cannot_count_reports_the_documents_it_drew():
    class Uncounted(NativeStratifiedStore):
        def countDocumentsWhere(self, docFilter):
            return None

    store = Uncounted().seed(corpus({'a': [0, 1], 'b': [0], 'c': [0, 1, 2]}, dim=8))
    answer = node(store).sample({'n': 2})
    listing = _listing(answer)
    assert listing['reason'] == 'complete' and listing['documents'] == len(answer['docs'])
