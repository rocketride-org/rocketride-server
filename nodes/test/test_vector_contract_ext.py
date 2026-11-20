# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The frozen shapes of the vector store contract's additive extensions (section 4.4).

What every store node reports or accepts before any of the new tools or fields
is implemented, so the app and the drivers can build against it:

* the new vocabulary entries (capability keys, caveats, the value lists of the
  new answer fields) and the three new limits, reported in ``dialect.limits``;
* ``dialect.capabilities`` names every new key: ``clusters`` is false until the
  node computes clusters, ``documents_filter`` and ``recommend_best_score`` follow
  the driver's ``VX_DRIVER_CAPABILITIES``;
* ``parse_doc_list_filter``: the ``documents`` filter, normalised, and every input
  it refuses with a sentence;
* the ``documents`` tool reads that filter (a refused one is ``INVALID_INPUT`` and
  never reaches the store), hands it to ``listDocumentPage(..., filter=...)`` only when
  the driver declares ``documents_filter`` (so the first contract's closed hook
  signatures keep working), and answers ``filter_applied`` / ``filter_ignored``
  from the page's ``DocPage.filter_ignored``: ``'server'``, ``'partial'`` (caveat
  ``documents_filter_partial``) or ``'none'`` (caveat ``documents_filter_client``);
* ``VectorExplorerExtTools`` is mixed in ahead of ``VectorExplorerTools`` without
  an import cycle, and the agent catalog is unchanged (pinned by
  ``test_vector_tool_envelope``).
"""

from __future__ import annotations

import ast
import dataclasses
import inspect
from pathlib import Path
from typing import List, Optional

import pytest

from ai.common.store import DocumentStoreBase, VectorExplorerExtTools, VectorExplorerTools, VectorStoreToolMixin
from ai.common.store import vx_tools, vx_tools_ext, vx_types
from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS
from ai.common.store.vx_types import DocListFilter, DocPage, parse_doc_list_filter

from .test_vector_hooks import ExactListingStore, MemoryStore, corpus, make_doc
from .test_vectordb_tool_mixin import node

# ---------------------------------------------------------------------------
# Vocabularies and limits
# ---------------------------------------------------------------------------


def test_the_new_capability_keys_and_caveats_are_appended_to_the_vocabularies():
    assert vx_types.CAPABILITY_KEYS[-3:] == ('clusters', 'documents_filter', 'recommend_best_score')
    assert vx_types.CAVEATS[-4:-1] == ('listing_truncated', 'documents_filter_partial', 'documents_filter_client')
    assert vx_types.CAVEATS[-1] == 'trash_scan_cut', 'the trash addendum (section 4.5) comes last'
    for vocabulary in (vx_types.CAPABILITY_KEYS, vx_types.CAVEATS):
        assert len(set(vocabulary)) == len(vocabulary)


def test_the_value_lists_of_the_new_answer_fields():
    assert vx_types.FILTER_APPLIED_VALUES == ('server', 'partial', 'none')
    assert vx_types.LISTING_REASONS == ('complete', 'cap', 'stale', 'pages', 'budget')
    assert vx_types.CLUSTER_METHODS == ('knn-components',)
    assert vx_types.CLUSTER_LABEL_SOURCES == ('text', 'paths')
    assert vx_types.RECOMMEND_STRATEGIES == ('average_vector', 'best_score')
    assert vx_types.MATRIX_SOURCES == ('cache', 'store', 'mixed')
    assert vx_types.KEYWORD_MATCHES == ('substring', 'token')


def test_the_new_limits_and_their_values():
    assert VECTOR_TOOL_LIMITS['recommend_examples_max'] == 10
    assert VECTOR_TOOL_LIMITS['matrix_keys_max'] == 100
    assert VECTOR_TOOL_LIMITS['max_components'] == 200
    # The first contract's limits are unchanged, in their order, ahead of the new ones.
    assert list(VECTOR_TOOL_LIMITS)[-3:] == ['recommend_examples_max', 'matrix_keys_max', 'max_components']


def test_dialect_reports_the_new_limits():
    limits = node(MemoryStore().seed(corpus({'a': [0]}))).dialect({})['limits']
    assert limits['recommend_examples_max'] == 10 and limits['matrix_keys_max'] == 100
    assert limits['max_components'] == 200


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------


class _FilteringStore(MemoryStore):
    """A driver that says it filters listings and recommends natively."""

    VX_DRIVER_CAPABILITIES = frozenset({'documents_filter', 'recommend_best_score'})


def test_dialect_names_every_capability_key_and_the_new_ones_are_off_by_default():
    caps = node(MemoryStore().seed(corpus({'a': [0]}))).dialect({})['capabilities']
    assert set(vx_types.CAPABILITY_KEYS) - {'embed_node'} <= set(caps)
    assert caps['clusters'] is False
    assert caps['documents_filter'] is False
    assert caps['recommend_best_score'] is False


def test_the_driver_declares_documents_filter_and_recommend_best_score():
    caps = node(_FilteringStore().seed(corpus({'a': [0]}))).dialect({})['capabilities']
    assert caps['documents_filter'] is True and caps['recommend_best_score'] is True
    assert caps['clusters'] is False, 'clusters is the node, not the driver'


# ---------------------------------------------------------------------------
# The documents filter
# ---------------------------------------------------------------------------


def test_the_filter_of_the_contract_example_is_read_as_given():
    parsed = parse_doc_list_filter(
        {
            'path_prefix': 'C:/demo/handbooks/',
            'file_types': ['md', 'pdf'],
            'ingested_after': '2026-10-01T00:00:00Z',
            'ingested_before': None,
            'min_chunks': 1,
            'max_chunks': None,
            'has_first_chunk': True,
            'has_tables': None,
            'path_contains': None,
        }
    )
    assert parsed == DocListFilter(
        path_prefix='C:/demo/handbooks/',
        file_types=('md', 'pdf'),
        ingested_after='2026-10-01T00:00:00Z',
        min_chunks=1,
        has_first_chunk=True,
    )
    assert parsed.given() == ('path_prefix', 'file_types', 'ingested_after', 'min_chunks', 'has_first_chunk')


def test_the_filter_is_frozen_and_keyed_as_documented():
    assert tuple(f.name for f in dataclasses.fields(DocListFilter)) == vx_types.DOC_LIST_FILTER_KEYS
    with pytest.raises(dataclasses.FrozenInstanceError):
        DocListFilter().path_prefix = 'x'  # type: ignore[misc]


@pytest.mark.parametrize('value', [None, {}, {'path_prefix': None, 'file_types': []}, {'path_contains': ''}])
def test_a_filter_that_sets_nothing_is_none(value):
    assert parse_doc_list_filter(value) is None


@pytest.mark.parametrize(
    'given,expected',
    [
        ('2026-10-01', '2026-10-01T00:00:00Z'),
        ('2026-10-01T12:30:00', '2026-10-01T12:30:00Z'),
        ('2026-10-01T12:30:00z', '2026-10-01T12:30:00Z'),
        ('2026-10-01T14:30:00+02:00', '2026-10-01T12:30:00Z'),
        ('2026-10-01T12:30:00.750Z', '2026-10-01T12:30:00Z'),
        ('2026-10-01T12:30-05:30', '2026-10-01T18:00:00Z'),
        (' 2026-10-01 12:30:00Z ', '2026-10-01T12:30:00Z'),
    ],
)
def test_dates_become_utc_in_the_stored_form(given, expected):
    # The stored ingestedAt is UTC 'YYYY-MM-DDTHH:MM:SSZ', so the bounds compare with it as text.
    assert parse_doc_list_filter({'ingested_after': given}).ingested_after == expected
    assert parse_doc_list_filter({'ingested_before': given}).ingested_before == expected


def test_file_types_are_lower_cased_without_the_dot_and_without_repeats():
    assert parse_doc_list_filter({'file_types': ['.PDF', 'md', ' Md ', 'pdf']}).file_types == ('pdf', 'md')


def test_text_up_to_the_limit_is_kept_as_given():
    prefix = 'C:\\Users\\' + 'x' * (vx_types.DOC_LIST_FILTER_TEXT_MAX - 9)
    assert len(prefix) == vx_types.DOC_LIST_FILTER_TEXT_MAX
    assert parse_doc_list_filter({'path_prefix': prefix, 'path_contains': '%_'}) == DocListFilter(
        path_prefix=prefix, path_contains='%_'
    )


def test_min_chunks_may_equal_max_chunks():
    assert parse_doc_list_filter({'min_chunks': 3, 'max_chunks': 3.0}) == DocListFilter(min_chunks=3, max_chunks=3)


@pytest.mark.parametrize(
    'value,sentence',
    [
        ('C:/demo', 'filter must be an object'),
        (['path_prefix'], 'filter must be an object'),
        ({'folder': 'C:/demo', 'deleted': 'all'}, 'unknown keys: deleted, folder'),
        ({'path_prefix': 7}, 'filter.path_prefix must be text'),
        ({'path_contains': 'x' * 1025}, 'at most 1024 characters'),
        ({'path_prefix': 'x' * 1025}, 'at most 1024 characters'),
        ({'ingested_after': '1 October 2026'}, 'ISO-8601'),
        ({'ingested_before': '2026-13-01'}, 'ISO-8601'),
        ({'ingested_after': 20261001}, 'ISO-8601'),
        ({'ingested_after': '20261001'}, 'ISO-8601'),
        ({'ingested_after': '2026-02-30'}, 'ISO-8601'),
        ({'ingested_after': '2026-10-01T24:00:00Z'}, 'ISO-8601'),
        ({'ingested_after': '2026-10-01T00:00:00+25:00'}, 'ISO-8601'),
        ({'ingested_after': '2026-10-01T00:00:00 UTC'}, 'ISO-8601'),
        ({'ingested_after': '  '}, 'ISO-8601'),
        ({'min_chunks': -1}, 'whole number'),
        ({'max_chunks': 2.5}, 'whole number'),
        ({'min_chunks': True}, 'whole number'),
        ({'max_chunks': '3'}, 'whole number'),
        ({'min_chunks': 5, 'max_chunks': 2}, 'min_chunks must not be greater than'),
        ({'has_tables': 'yes'}, 'true, false or null'),
        ({'has_first_chunk': 0}, 'true, false or null'),
        ({'file_types': 'md'}, 'list of at most'),
        ({'file_types': ['md'] * 33}, 'list of at most 32'),
        ({'file_types': ['tar.gz']}, 'extensions such as'),
        ({'file_types': ['']}, 'extensions such as'),
        ({'file_types': [3]}, 'extensions such as'),
    ],
)
def test_every_refused_filter_says_why(value, sentence):
    with pytest.raises(ValueError, match=sentence.replace('(', r'\(').replace('.', r'\.')):
        parse_doc_list_filter(value)


# ---------------------------------------------------------------------------
# The documents filter through the hook and the tool
# ---------------------------------------------------------------------------

_PATHS = {'a': 'C:/demo/handbooks/a.md', 'b': 'C:/demo/handbooks/b.PDF', 'c': 'C:/other/c.md'}

_FILTER_CAVEATS = {'documents_filter_partial', 'documents_filter_client'}


def _library():
    return [make_doc(oid, chunk, path=path) for oid, path in _PATHS.items() for chunk in (0, 1)]


class _ListingFilterStore(ExactListingStore):
    """A driver that is handed the documents filter: it applies the path keys and skips the others.

    ``received`` records the ``filter`` of every ``listDocumentPage`` call (None when the tool
    left the keyword out); ``also_skipped`` names keys the driver reports though it was not given them.
    """

    VX_DRIVER_CAPABILITIES = ExactListingStore.VX_DRIVER_CAPABILITIES | {'documents_filter'}
    APPLIES = frozenset({'path_prefix', 'file_types', 'path_contains'})

    def __init__(self, also_skipped=(), **kw) -> None:
        super().__init__(**kw)
        self.received: List[Optional[DocListFilter]] = []
        self.also_skipped = tuple(also_skipped)

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort, filter=None) -> DocPage:
        self.received.append(filter)
        page = super().listDocumentPage(cursor=cursor, limit=limit, object_ids=object_ids, deleted=deleted, sort=sort)
        if filter is None:
            return page

        def keep(path: str) -> bool:
            return (
                (filter.path_prefix is None or path.startswith(filter.path_prefix))
                and (filter.file_types is None or path.rsplit('.', 1)[-1].lower() in filter.file_types)
                and (filter.path_contains is None or filter.path_contains.lower() in path.lower())
            )

        items = [row for row in page.items if keep(row.path)]
        skipped = tuple(key for key in filter.given() if key not in self.APPLIES) + self.also_skipped
        return dataclasses.replace(page, items=items, total=len(items), filter_ignored=skipped)


def _paths(answer) -> List[str]:
    return [item['path'] for item in answer['items']]


def test_list_documents_takes_the_filter_by_keyword_with_none_by_default():
    parameter = inspect.signature(DocumentStoreBase.listDocumentPage).parameters['filter']
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY and parameter.default is None


def test_a_page_names_no_ignored_filter_key_unless_its_hook_says_so():
    assert DocPage([], None, None, False, False, False, []).filter_ignored == ()


def test_the_base_hook_applies_no_filter_key_and_names_every_given_one():
    store = MemoryStore().seed(_library())
    plain = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    page = store.listDocumentPage(
        cursor=None,
        limit=10,
        object_ids=None,
        deleted='active',
        sort='path',
        filter=DocListFilter(path_prefix='C:/other/', has_tables=True),
    )
    assert page.filter_ignored == ('path_prefix', 'has_tables')
    assert [row.path for row in page.items] == [row.path for row in plain.items] and len(page.items) == 3
    assert plain.filter_ignored == ()


@pytest.mark.parametrize(
    'args', [{}, {'filter': None}, {'filter': {}}, {'filter': {'path_contains': '', 'file_types': []}}]
)
@pytest.mark.parametrize('store_cls', [MemoryStore, _ListingFilterStore])
def test_without_a_filter_the_answer_carries_neither_key_and_the_hook_is_handed_none(args, store_cls):
    store = store_cls().seed(_library())
    answer = node(store).list_documents(args)
    assert answer['success'] is True and len(answer['items']) == 3
    assert 'filter_applied' not in answer and 'filter_ignored' not in answer
    assert not _FILTER_CAVEATS & set(answer['caveats'])
    if store_cls is _ListingFilterStore:
        assert store.received == [None]


def test_a_store_that_cannot_filter_answers_none_and_leaves_every_key_to_the_app():
    store = MemoryStore().seed(_library())
    plain = node(store).list_documents({})
    answer = node(store).list_documents({'filter': {'file_types': ['.MD'], 'path_prefix': 'C:/demo/handbooks/'}})
    assert answer['success'] is True
    assert answer['filter_applied'] == 'none'
    assert answer['filter_ignored'] == ['path_prefix', 'file_types'], 'in DOC_LIST_FILTER_KEYS order'
    assert answer['caveats'] == ['documents_by_first_chunk', 'documents_unsorted', 'documents_filter_client']
    assert answer['items'] == plain['items'], 'the rows are the unfiltered ones; the app filters them'
    assert list(answer).index('filter_applied') < list(answer).index('caveats')


def test_a_driver_with_the_first_contracts_closed_hook_is_never_handed_the_filter():
    # ExactListingStore overrides listDocumentPage(*, cursor, limit, object_ids, deleted, sort) as every
    # driver did before section 4.4; handing it filter= would raise TypeError (a STORE_ERROR).
    store = ExactListingStore().seed(_library())
    answer = node(store).list_documents({'filter': {'path_prefix': 'C:/other/'}})
    assert answer['success'] is True, answer
    assert answer['filter_applied'] == 'none' and answer['filter_ignored'] == ['path_prefix']
    assert answer['caveats'] == ['documents_filter_client']
    assert _paths(answer) == sorted(_PATHS.values())


def test_a_driver_that_applies_every_given_key_answers_server():
    store = _ListingFilterStore().seed(_library())
    answer = node(store).list_documents({'filter': {'path_prefix': 'C:/demo/handbooks/', 'file_types': ['.MD']}})
    assert answer['filter_applied'] == 'server' and answer['filter_ignored'] == []
    assert answer['caveats'] == []
    assert _paths(answer) == ['C:/demo/handbooks/a.md']
    assert store.received == [DocListFilter(path_prefix='C:/demo/handbooks/', file_types=('md',))], 'normalised'


def test_a_driver_that_skips_some_given_keys_answers_partial_and_names_them():
    store = _ListingFilterStore().seed(_library())
    answer = node(store).list_documents(
        {'filter': {'has_tables': False, 'path_prefix': 'C:/demo/handbooks/', 'ingested_after': '2026-10-01'}}
    )
    assert answer['filter_applied'] == 'partial'
    assert answer['filter_ignored'] == ['ingested_after', 'has_tables']
    assert answer['caveats'] == ['documents_filter_partial']
    assert _paths(answer) == ['C:/demo/handbooks/a.md', 'C:/demo/handbooks/b.PDF']
    assert store.received[-1].ingested_after == '2026-10-01T00:00:00Z'


def test_a_driver_that_skips_every_given_key_answers_none():
    store = _ListingFilterStore().seed(_library())
    answer = node(store).list_documents({'filter': {'has_tables': True, 'min_chunks': 2}})
    assert answer['filter_applied'] == 'none' and answer['filter_ignored'] == ['min_chunks', 'has_tables']
    assert answer['caveats'] == ['documents_filter_client']


def test_a_key_the_call_did_not_give_is_never_reported_as_ignored():
    store = _ListingFilterStore(also_skipped=('max_chunks', 'not_a_key')).seed(_library())
    answer = node(store).list_documents({'filter': {'path_contains': 'OTHER'}})
    assert answer['filter_applied'] == 'server' and answer['filter_ignored'] == []
    assert _paths(answer) == ['C:/other/c.md']


def test_a_driver_that_declares_the_filter_but_keeps_the_base_hook_answers_none():
    store = _FilteringStore().seed(_library())
    answer = node(store).list_documents({'filter': {'path_prefix': 'C:/other/'}})
    assert answer['filter_applied'] == 'none' and answer['filter_ignored'] == ['path_prefix']
    assert 'documents_filter_client' in answer['caveats'] and len(answer['items']) == 3


@pytest.mark.parametrize(
    'value,sentence',
    [
        ('C:/demo', 'filter must be an object'),
        ({'folder': 'C:/demo'}, 'unknown keys: folder'),
        ({'min_chunks': 3, 'max_chunks': 1}, 'min_chunks must not be greater than'),
        ({'ingested_after': 'yesterday'}, 'ISO-8601'),
        ({'path_prefix': 'x' * 1025}, 'at most 1024 characters'),
    ],
)
def test_a_refused_filter_is_invalid_input_and_never_reaches_the_store(value, sentence):
    store = _ListingFilterStore().seed(_library())
    answer = node(store).list_documents({'filter': value})
    assert answer['success'] is False and answer['code'] == 'INVALID_INPUT'
    assert sentence in answer['error']
    assert store.received == [] and not [call for call in store.calls if call[0] == 'listDocumentPage']


_REPO = Path(__file__).resolve().parents[2]


def _declares_documents_filter(cls: ast.ClassDef) -> bool:
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign):
            targets = stmt.targets
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            targets = [stmt.target]
        else:
            continue
        if not any(isinstance(t, ast.Name) and t.id == 'VX_DRIVER_CAPABILITIES' for t in targets):
            continue
        if any(isinstance(n, ast.Constant) and n.value == 'documents_filter' for n in ast.walk(stmt.value)):
            return True
    return False


@pytest.mark.parametrize(
    'source,declared',
    [
        ("class D:\n    VX_DRIVER_CAPABILITIES: FrozenSet[str] = frozenset({'documents_filter', 'knn_native'})", True),
        ("class D:\n    VX_DRIVER_CAPABILITIES = Base.VX_DRIVER_CAPABILITIES | {'documents_filter'}", True),
        ("class D:\n    VX_DRIVER_CAPABILITIES = frozenset({'documents_sorted'})\n    x = 'documents_filter'", False),
        ('class D:\n    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort): ...', False),
    ],
)
def test_the_guard_below_reads_a_declaration_of_the_filter(source, declared):
    assert _declares_documents_filter(ast.parse(source).body[0]) is declared


def test_a_driver_that_declares_the_filter_takes_it_in_its_own_list_documents():
    # The tool hands filter= to every driver that declares documents_filter, so its hook must take it.
    sources = [
        *sorted((_REPO / 'packages/ai/src/ai/common/store').rglob('*.py')),
        *sorted((_REPO / 'nodes/src/nodes').glob('store_*/**/*.py')),
    ]
    hooks = {}
    for path in sources:
        for cls in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if not isinstance(cls, ast.ClassDef):
                continue
            hook = next((n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'listDocumentPage'), None)
            if hook is None:
                continue
            takes = 'filter' in {arg.arg for arg in hook.args.kwonlyargs}
            hooks[f'{path.name}:{cls.name}'] = takes
            assert takes or not _declares_documents_filter(cls), f'{path.name}:{cls.name} declares documents_filter'
    assert hooks.get('document_store.py:DocumentStoreBase') is True
    assert len(hooks) >= 9, sorted(hooks)  # the base, pgvector and the seven node drivers


def test_the_list_documents_descriptor_names_the_filter_and_its_answer_keys():
    meta = VectorStoreToolMixin.list_documents.__tool_meta__
    assert tuple(meta['input_schema']['properties']['filter']['properties']) == vx_types.DOC_LIST_FILTER_KEYS
    output = meta['output_schema']['properties']
    assert output['filter_applied']['enum'] == list(vx_types.FILTER_APPLIED_VALUES)
    assert output['filter_ignored'] == {'type': 'array', 'items': {'type': 'string'}}
    assert meta['audience'] == ('agent', 'dap'), 'list_documents is in the agent catalog (#2704)'


# ---------------------------------------------------------------------------
# The additive tools' class
# ---------------------------------------------------------------------------


def test_the_additive_tools_are_mixed_in_ahead_of_the_explorer_tools():
    mro = VectorStoreToolMixin.__mro__
    assert mro.index(VectorExplorerExtTools) < mro.index(VectorExplorerTools)
    assert vx_tools_ext.VectorExplorerExtTools is VectorExplorerExtTools


def test_vx_tools_never_imports_the_additive_module():
    source = Path(vx_tools.__file__).read_text(encoding='utf-8')
    imported = {node.module or '' for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ImportFrom)} | {
        alias.name for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Import) for alias in node.names
    }
    assert not [name for name in imported if name.endswith('vx_tools_ext')]


def test_every_tool_on_the_additive_class_is_external_only_and_wrapped():
    tools = {
        name: value
        for name, value in vars(VectorExplorerExtTools).items()
        if callable(value) and hasattr(value, '__tool_meta__')
    }
    for name, method in tools.items():
        assert method.__tool_meta__['audience'] == ('dap',), name
        assert getattr(method, '__vectordb_tool__', False) is True, name
