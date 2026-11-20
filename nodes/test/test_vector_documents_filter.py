# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The ``documents`` filter, the per-document health fields and the search scope cap on the stores.

Contract section 4.4-A (the filter), 4.4-B (the cap on ``search``'s ``filter.objectIds``),
4.4-F (``max_chunk_id`` and ``deleted_chunks``) and 4.4-G (``keyword_match``):

* the shared pgvector driver applies every key of the filter inside the statement that
  pages the document keys, on the same per-document aggregates the listing reports (the
  path, the chunk count, the first chunk's ingest time, the chunk-0 and table flags), so
  the keyset cursor and the total it carries count only matching documents; on a table
  without the ``meta`` column the two ingest-time keys are left to the app and named in
  ``filter_ignored``. A cursor is bound to the filter it was issued for. Every value is
  a bound parameter, escaped for ``LIKE`` where it is a pattern.
* each listed document reports ``max_chunk_id`` under the listing's ``deleted`` mode and
  ``deleted_chunks``, its soft-deleted rows whatever the mode; which documents are listed
  does not change.
* ``search`` refuses more than ``limits.scope_keys_max`` ids in ``filter.objectIds`` with
  ``LIMIT_EXCEEDED`` and anything but 1 to that many non-empty strings with
  ``INVALID_INPUT``, as ``sample`` checks ``filter.object_ids``; the legacy ``objectId``
  key is unchanged.
* ``VX_KEYWORD_MATCH`` says how a driver's keyword search matches: ``'substring'`` for
  pgvector (``ILIKE``) and Chroma (``$contains``), unset (null) for a driver without
  keyword search.

The pgvector cases run the real driver over the psycopg2 test double
(``nodes/test/mocks/psycopg2``); the same behaviour is checked live in
``test_store_postgres_full.py``.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from ai.common.store import DocumentStoreBase
from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS
from ai.common.store.vx_types import KEYWORD_MATCHES, DocListFilter, parse_doc_list_filter

from .test_vectordb_tool_mixin import clustered, node

_REPO = Path(__file__).resolve().parents[2]
_MOCK_PSYCOPG2 = _REPO / 'nodes' / 'test' / 'mocks' / 'psycopg2'
_SWAPPED = (
    'psycopg2',
    'psycopg2.sql',
    'psycopg2.extensions',
    'ai.common.store.pgvector',
    'ai.common.store.pgvector.sql',
    'ai.common.store.pgvector.pool',
    'ai.common.store.pgvector.driver',
)
DIM = 4
MODEL = 'test-model'
SCOPE_MAX = VECTOR_TOOL_LIMITS['scope_keys_max']


# ---------------------------------------------------------------------------
# The pgvector driver over the psycopg2 test double
# ---------------------------------------------------------------------------


@pytest.fixture()
def pg():
    """``PgVectorStore`` with psycopg2 replaced by the test double; ``sys.modules`` restored afterwards."""
    saved = {name: sys.modules.get(name) for name in _SWAPPED}
    import ai.common.store as store_pkg

    saved_attr = store_pkg.__dict__.get('pgvector')
    for name in _SWAPPED:
        sys.modules.pop(name, None)
    opened: List[Any] = []
    try:
        spec = importlib.util.spec_from_file_location(
            'psycopg2', _MOCK_PSYCOPG2 / '__init__.py', submodule_search_locations=[str(_MOCK_PSYCOPG2)]
        )
        mock = importlib.util.module_from_spec(spec)
        sys.modules['psycopg2'] = mock
        spec.loader.exec_module(mock)
        mock.MockConnection.reset()
        driver = importlib.import_module('ai.common.store.pgvector.driver')
        sql = importlib.import_module('ai.common.store.pgvector.sql')

        def open_store(table: str = 'docs', **kw: Any):
            store = driver.PgVectorStore(
                'postgres', {}, {}, connect_args={'dsn': 'postgresql://mock/db'}, table=table, **kw
            )
            opened.append(store)
            return store

        yield types.SimpleNamespace(open=open_store, db=mock.MockConnection, mock=mock, driver=driver, sql=sql)
    finally:
        for store in opened:
            try:
                store.close()
            except Exception:
                pass
        for name in _SWAPPED:
            sys.modules.pop(name, None)
            if saved[name] is not None:
                sys.modules[name] = saved[name]
        if saved_attr is not None:
            store_pkg.pgvector = saved_attr
        else:
            store_pkg.__dict__.pop('pgvector', None)


def _doc(object_id: str, chunk_id: int, parent: str, *, table: bool = False, **extra: Any):
    from ai.common.schema import Doc, DocMetadata

    meta = DocMetadata(
        objectId=object_id,
        chunkId=chunk_id,
        nodeId='chunk_1',
        parent=parent,
        permissionId=0,
        isDeleted=False,
        isTable=table,
        tableId=0,
        signature='component-signature',
        **extra,
    )
    vec = [float((hash((object_id, chunk_id, i)) % 97) + 1) for i in range(DIM)]
    return Doc(page_content=f'{object_id} chunk {chunk_id}', metadata=meta, embedding=vec, embedding_model=MODEL)


#: objectId -> (path, chunk ids, ingestedAt or None, chunk ids that are tables)
LIBRARY: Dict[str, tuple] = {
    'falcon': ('C:/demo/handbooks/falcon_handbook.md', [0, 1, 2], '2026-10-01T09:00:00Z', []),
    'osprey': ('C:/demo/handbooks/osprey_station.PDF', [0, 1], '2026-10-02T00:00:00Z', []),
    'orphan': ('C:/demo/handbooks/orphan.md', [5, 6, 7], '2026-10-03T00:00:00Z', []),
    'notes': ('C:/demo/handbooks_old/notes.md', [0], '2026-09-30T23:59:59Z', []),
    'pct': ('C:/demo/100%_done/report.md', [0, 1], None, []),
    'under': ('C:/demo/a_b/table.html', [0, 1, 2, 3], '2026-10-05T12:00:00Z', [2]),
    'axb': ('C:/demo/axb/file.txt', [0], '2026-10-05T12:00:00Z', []),
    'win': ('C:\\demo\\win\\Readme.MD', [0, 1], '2026-10-04T00:00:00Z', []),
    'mdx': ('C:/demo/x/page.mdx', [0], '2026-10-04T00:00:00Z', []),
    'bak': ('C:/demo/x/file.md.bak', [0], '2026-10-04T00:00:00Z', []),
    'bare': ('README', [0, 1, 2, 3, 4], None, []),
}


def _seed(store, library: Dict[str, tuple] = LIBRARY) -> None:
    for oid, (path, chunk_ids, ingested, tables) in library.items():
        extra = {'ingestedAt': ingested} if ingested else {}
        store.addChunks([_doc(oid, c, path, table=c in tables, **extra) for c in chunk_ids])


def _expected(flt: DocListFilter, library: Dict[str, tuple] = LIBRARY, *, dates: bool = True) -> List[str]:
    """The objectIds a filter selects from ``library``, by the contract's words, in (path, objectId) order."""
    out = []
    for oid, (path, chunk_ids, ingested, tables) in library.items():
        if flt.path_prefix is not None and not path.startswith(flt.path_prefix):
            continue
        if flt.file_types and not any(path.lower().endswith('.' + t) for t in flt.file_types):
            continue
        if flt.path_contains is not None and flt.path_contains.lower() not in path.lower():
            continue
        if dates and flt.ingested_after is not None and (ingested is None or ingested < flt.ingested_after):
            continue
        if dates and flt.ingested_before is not None and (ingested is None or ingested >= flt.ingested_before):
            continue
        if flt.min_chunks is not None and len(chunk_ids) < flt.min_chunks:
            continue
        if flt.max_chunks is not None and len(chunk_ids) > flt.max_chunks:
            continue
        if flt.has_first_chunk is not None and (0 in chunk_ids) != flt.has_first_chunk:
            continue
        if flt.has_tables is not None and bool(tables) != flt.has_tables:
            continue
        out.append((path, oid))
    return [oid for _path, oid in sorted(out)]


def _list_all(store, flt: Optional[DocListFilter], *, limit: int = 3, deleted: str = 'active'):
    """Every page of a listing: (objectIds in order, the pages)."""
    pages, cursor = [], None
    while True:
        page = store.listDocumentPage(
            cursor=cursor, limit=limit, object_ids=None, deleted=deleted, sort='path', filter=flt
        )
        pages.append(page)
        cursor = page.next_cursor
        if cursor is None:
            return [row.objectId for p in pages for row in p.items], pages


def _f(**kw: Any) -> DocListFilter:
    flt = parse_doc_list_filter(kw)
    assert flt is not None
    return flt


def test_pgvector_declares_the_filter_and_takes_it_in_its_hook(pg):
    cls = pg.driver.PgVectorStore
    assert 'documents_filter' in cls.VX_DRIVER_CAPABILITIES
    params = inspect.signature(cls.listDocumentPage).parameters
    assert params['filter'].kind is inspect.Parameter.KEYWORD_ONLY and params['filter'].default is None
    assert 'documents_filter' in pg.open().capabilities()


# Hand-checked selections: they pin the reference (_expected) as much as the driver.
@pytest.mark.parametrize(
    'given, objects',
    [
        ({'path_prefix': 'C:/demo/handbooks/'}, ['falcon', 'orphan', 'osprey']),
        # A prefix is not a folder test by itself: without the slash the sibling folder matches too.
        ({'path_prefix': 'C:/demo/handbooks'}, ['falcon', 'orphan', 'osprey', 'notes']),
        # LIKE's wildcards in the prefix are literal: 'a_b' does not match 'axb', '100%' only itself.
        ({'path_prefix': 'C:/demo/a_b/'}, ['under']),
        ({'path_prefix': 'C:/demo/100%'}, ['pct']),
        ({'path_prefix': '%'}, []),
        ({'path_prefix': 'C:\\demo\\win\\'}, ['win']),
        # Extensions ignore case and must be the last one: .mdx and .md.bak are not md.
        ({'file_types': ['md']}, ['pct', 'falcon', 'orphan', 'notes', 'win']),
        ({'file_types': ['.PDF', 'html']}, ['under', 'osprey']),
        ({'path_contains': 'HANDBOOK'}, ['falcon', 'orphan', 'osprey', 'notes']),
        ({'path_contains': '%'}, ['pct']),
        ({'path_contains': '\\win\\'}, ['win']),
        # ingested_after is inclusive, ingested_before exclusive; no ingest time never matches a bound.
        (
            {'ingested_after': '2026-10-01T09:00:00Z'},
            ['falcon', 'orphan', 'osprey', 'under', 'axb', 'win', 'bak', 'mdx'],
        ),
        ({'ingested_before': '2026-10-02'}, ['falcon', 'notes']),
        (
            {'ingested_after': '2026-10-01T11:00:00+02:00', 'ingested_before': '2026-10-02T00:00:01Z'},
            ['falcon', 'osprey'],
        ),
        ({'min_chunks': 4}, ['under', 'bare']),
        ({'max_chunks': 1}, ['notes', 'axb', 'bak', 'mdx']),
        ({'min_chunks': 2, 'max_chunks': 2}, ['pct', 'osprey', 'win']),
        ({'has_first_chunk': False}, ['orphan']),
        ({'has_tables': True}, ['under']),
        (
            {'path_prefix': 'C:/demo/', 'file_types': ['md'], 'has_first_chunk': True, 'min_chunks': 2},
            ['pct', 'falcon'],
        ),
    ],
)
def test_pgvector_filter_selects_the_documents_the_contract_names(pg, given, objects):
    store = pg.open()
    _seed(store)
    flt = _f(**given)
    listed, pages = _list_all(store, flt, limit=50)
    by_path = {oid: LIBRARY[oid][0] for oid in objects}
    assert listed == sorted(objects, key=lambda oid: (by_path[oid], oid))
    assert listed == _expected(flt)
    assert pages[0].filter_ignored == ()
    assert pages[0].total == len(objects)


@pytest.mark.parametrize(
    'given',
    [
        {'has_first_chunk': True},
        {'has_tables': False},
        {'path_contains': '_'},
        {'file_types': ['md', 'txt'], 'max_chunks': 3},
        {'path_prefix': 'C:/demo/', 'ingested_before': '2026-10-04T00:00:00Z', 'has_tables': False},
    ],
)
def test_pgvector_filtered_pages_follow_one_another_and_carry_the_filtered_total(pg, given):
    store = pg.open()
    _seed(store)
    flt = _f(**given)
    expected = _expected(flt)
    listed, pages = _list_all(store, flt, limit=2)
    assert listed == expected
    assert len(pages) == max(1, -(-len(expected) // 2))
    assert all(page.total == len(expected) for page in pages)
    assert all((page.counts_exact, page.distinct, page.sorted) == (True, True, True) for page in pages)


def test_pgvector_rows_of_a_filtered_listing_keep_their_counts_and_metadata(pg):
    store = pg.open()
    _seed(store)
    page = store.listDocumentPage(
        cursor=None, limit=10, object_ids=None, deleted='active', sort='path', filter=_f(has_tables=True)
    )
    (row,) = page.items
    assert (row.objectId, row.path, row.chunks, row.tables, row.has_first_chunk) == (
        'under',
        'C:/demo/a_b/table.html',
        4,
        1,
        True,
    )
    assert row.ingestedAt == '2026-10-05T12:00:00Z' and row.nodeId == 'chunk_1' and row.pointId


def test_pgvector_filter_and_object_ids_and_deleted_mode_combine(pg):
    store = pg.open()
    _seed(store)
    store.markDeleted(['falcon'])
    flt = _f(path_prefix='C:/demo/handbooks/')
    assert _list_all(store, flt)[0] == ['orphan', 'osprey']
    assert _list_all(store, flt, deleted='deleted')[0] == ['falcon']
    assert _list_all(store, flt, deleted='all')[0] == ['falcon', 'orphan', 'osprey']
    page = store.listDocumentPage(
        cursor=None, limit=10, object_ids=['osprey', 'notes', 'schema'], deleted='active', sort='path', filter=flt
    )
    assert [r.objectId for r in page.items] == ['osprey'] and page.total == 1


def test_pgvector_flags_follow_the_listing_mode(pg):
    """Under 'active' a document whose chunk 0 is soft-deleted has no first chunk; under 'all' it has one."""
    store = pg.open()
    _seed(store)
    table = pg.db.table('docs')
    for row in table.rows.values():
        if row.get('objectid') == 'under' and row.get('chunkid') in (0, 2):
            row['isdeleted'] = True
    assert 'under' in _list_all(store, _f(has_first_chunk=False))[0]
    assert 'under' not in _list_all(store, _f(has_tables=True))[0]
    assert 'under' in _list_all(store, _f(has_first_chunk=True, has_tables=True), deleted='all')[0]
    assert _list_all(store, _f(min_chunks=2, max_chunks=2, path_prefix='C:/demo/a_b/'))[0] == ['under']


def test_pgvector_without_a_filter_lists_as_before(pg):
    store = pg.open()
    _seed(store)
    plain, pages = _list_all(store, None, limit=4)
    assert plain == [oid for _p, oid in sorted((v[0], k) for k, v in LIBRARY.items())]
    assert all(page.filter_ignored == () for page in pages)
    assert pages[0].total == len(LIBRARY)


def test_pgvector_filter_values_are_bound_parameters_never_statement_text(pg):
    store = pg.open()
    _seed(store)
    hostile = "x' OR '1'='1"
    flt = _f(path_prefix=hostile, path_contains=hostile, file_types=['md'])
    assert _list_all(store, flt)[0] == []
    executed = [(text, params or []) for conn in pg.db.opened for text, params in conn.executed]
    keys = [(text, params) for text, params in executed if 'rr-pgvector:list_document_keys' in text]
    assert keys and all(hostile not in text for text, _params in executed)
    assert all(' HAVING ' in text for text, _params in keys)
    bound = [value for _text, params in keys for value in params]
    assert "x' OR '1'='1%" in bound and "%x' OR '1'='1%" in bound and ['%.md'] in bound


def test_pgvector_cursor_is_bound_to_its_filter(pg):
    from ai.common.store.errors import ToolRefusal

    store = pg.open()
    _seed(store)
    plain = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    filtered = store.listDocumentPage(
        cursor=None, limit=2, object_ids=None, deleted='active', sort='path', filter=_f(file_types=['md'])
    )
    assert plain.next_cursor and filtered.next_cursor
    for cursor, flt in (
        (plain.next_cursor, _f(file_types=['md'])),
        (filtered.next_cursor, None),
        (filtered.next_cursor, _f(file_types=['pdf'])),
    ):
        with pytest.raises(ToolRefusal) as err:
            store.listDocumentPage(cursor=cursor, limit=2, object_ids=None, deleted='active', sort='path', filter=flt)
        assert err.value.code == 'INVALID_INPUT'
    # The cursor goes on with the same filter, normalised the same way.
    again = store.listDocumentPage(
        cursor=filtered.next_cursor,
        limit=2,
        object_ids=None,
        deleted='active',
        sort='path',
        filter=_f(file_types=['.MD']),
    )
    assert [r.objectId for r in again.items] == _expected(_f(file_types=['md']))[2:4]


def _legacy_table(pg, library: Dict[str, tuple]) -> None:
    """A table in the shape of the drivers this one replaced (no ``meta`` column), locked so it stays so."""
    columns = [
        ('id', 'bigserial'),
        ('content', 'text'),
        ('objectid', 'text'),
        ('nodeid', 'text'),
        ('parent', 'text'),
        ('permissionid', 'int'),
        ('isdeleted', 'boolean'),
        ('chunkid', 'int'),
        ('istable', 'boolean'),
        ('tableid', 'int'),
        ('vectorsize', 'int'),
        ('modelname', 'text'),
        ('embedding', f'vector({DIM})'),
        ('signature', 'text'),
    ]
    table = pg.mock.MockTable('legacy', columns)
    rows = [{'objectid': 'schema', 'chunkid': 0, 'isdeleted': True, 'vectorsize': DIM, 'modelname': MODEL}]
    for oid, (path, chunk_ids, _ingested, tables) in library.items():
        for cid in chunk_ids:
            rows.append(
                {
                    'content': f'{oid} chunk {cid}',
                    'objectid': oid,
                    'nodeid': 'chunk_1',
                    'parent': path,
                    'permissionid': 0,
                    'isdeleted': False,
                    'chunkid': cid,
                    'istable': cid in tables,
                    'tableid': 0,
                    'vectorsize': DIM,
                    'modelname': '',
                    'embedding': [1.0] * DIM,
                    'signature': 'sig',
                }
            )
    for row in rows:
        row['id'] = table.next_id
        table.rows[table.next_id] = row
        table.next_id += 1
    pg.db._tables['legacy'] = table
    pg.db.locked_tables.add('legacy')


def test_pgvector_without_the_meta_column_leaves_the_ingest_keys_to_the_app(pg):
    _legacy_table(pg, LIBRARY)
    store = pg.open('legacy')
    assert store.describe().meta_column is False
    flt = _f(ingested_after='2026-10-01', ingested_before='2026-10-03', path_prefix='C:/demo/handbooks/')
    listed, pages = _list_all(store, flt, limit=2)
    assert listed == _expected(flt, dates=False) == ['falcon', 'orphan', 'osprey']
    assert all(page.filter_ignored == ('ingested_after', 'ingested_before') for page in pages)
    only_dates = store.listDocumentPage(
        cursor=None, limit=50, object_ids=None, deleted='active', sort='path', filter=_f(ingested_after='2026-10-01')
    )
    assert only_dates.filter_ignored == ('ingested_after',) and only_dates.total == len(LIBRARY)


def test_documents_tool_answers_server_and_partial_from_the_pgvector_driver(pg):
    store = pg.open()
    _seed(store)
    answer = node(store).list_documents({'filter': {'path_prefix': 'C:/demo/handbooks/', 'file_types': ['md']}})
    assert answer['success'] is True
    assert [item['objectId'] for item in answer['items']] == ['falcon', 'orphan']
    assert (answer['filter_applied'], answer['filter_ignored'], answer['total']) == ('server', [], 2)
    assert 'documents_filter_partial' not in answer['caveats'] and 'documents_filter_client' not in answer['caveats']

    _legacy_table(pg, LIBRARY)
    legacy = pg.open('legacy')
    answer = node(legacy).list_documents({'filter': {'ingested_before': '2026-10-02', 'max_chunks': 1}})
    assert (answer['filter_applied'], answer['filter_ignored']) == ('partial', ['ingested_before'])
    assert 'documents_filter_partial' in answer['caveats']
    assert [item['objectId'] for item in answer['items']] == ['axb', 'notes', 'bak', 'mdx']
    answer = node(legacy).list_documents({'filter': {'ingested_before': '2026-10-02'}})
    assert (answer['filter_applied'], answer['filter_ignored']) == ('none', ['ingested_before'])
    assert 'documents_filter_client' in answer['caveats'] and answer['total'] == len(LIBRARY)


# ---------------------------------------------------------------------------
# Per-document health fields (contract section 4.4-F)
# ---------------------------------------------------------------------------

HEALTH: Dict[str, tuple] = {
    'whole': ('C:/h/whole.md', [0, 1, 2], None, []),
    'gappy': ('C:/h/gappy.md', [0, 1, 3, 4], None, []),
    'tail': ('C:/h/tail.md', [3, 4], None, []),
}


def _soft_delete(pg, table: str, *keys) -> None:
    rows = pg.db.table(table).rows.values()
    for row in rows:
        if (row.get('objectid'), row.get('chunkid')) in keys:
            row['isdeleted'] = True


def _health(store, deleted: str) -> Dict[str, tuple]:
    rows = _list_all(store, None, deleted=deleted)[1]
    return {
        r.objectId: (r.chunks, r.max_chunk_id, r.deleted_chunks, r.has_first_chunk, r.tables, r.deleted)
        for p in rows
        for r in p.items
    }


def test_pgvector_rows_report_the_last_chunk_and_the_soft_deleted_rows(pg):
    store = pg.open()
    _seed(store, HEALTH)
    _soft_delete(pg, 'docs', ('gappy', 4), ('tail', 3), ('tail', 4))
    # (chunks, max_chunk_id, deleted_chunks, has_first_chunk, tables, deleted)
    assert _health(store, 'active') == {
        'whole': (3, 2, 0, True, 0, False),
        'gappy': (3, 3, 1, True, 0, False),
    }
    assert _health(store, 'deleted') == {
        'gappy': (1, 4, 1, False, 0, True),
        'tail': (2, 4, 2, False, 0, True),
    }
    assert _health(store, 'all') == {
        'whole': (3, 2, 0, True, 0, False),
        'gappy': (4, 4, 1, True, 0, True),
        'tail': (2, 4, 2, False, 0, True),
    }


def test_pgvector_health_fields_on_a_legacy_table(pg):
    _legacy_table(pg, HEALTH)
    store = pg.open('legacy')
    _soft_delete(pg, 'legacy', ('whole', 1))
    rows = _health(store, 'active')
    assert rows['whole'] == (2, 2, 1, True, 0, False)
    assert rows['tail'] == (2, 4, 0, False, 0, False)
    assert 'schema' not in rows


def test_pgvector_a_document_whose_rows_left_the_mode_between_the_two_statements_is_not_listed(pg, monkeypatch):
    store = pg.open()
    _seed(store, HEALTH)
    list_documents = store._sql.list_documents

    def soft_delete_then_aggregate(columns, where):
        _soft_delete(pg, 'docs', ('tail', 3), ('tail', 4))
        return list_documents(columns, where)

    monkeypatch.setattr(store._sql, 'list_documents', soft_delete_then_aggregate)
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert [r.objectId for r in page.items] == ['gappy', 'whole']


def test_documents_tool_answers_the_health_fields(pg):
    store = pg.open()
    _seed(store, HEALTH)
    _soft_delete(pg, 'docs', ('gappy', 4))
    items = {item['objectId']: item for item in node(store).list_documents({})['items']}
    assert (items['gappy']['max_chunk_id'], items['gappy']['deleted_chunks']) == (3, 1)
    assert (items['whole']['max_chunk_id'], items['whole']['deleted_chunks']) == (2, 0)


# ---------------------------------------------------------------------------
# search: the cap on filter.objectIds (contract section 4.4-B)
# ---------------------------------------------------------------------------


def _ids(n: int) -> List[str]:
    return [f'doc{i:05d}' for i in range(n)]


def _semantic_filter(store):
    return [call for call in store.calls if call[0] == 'semantic'][-1][2]


def test_search_takes_object_ids_up_to_the_scope_limit():
    store = clustered()
    answer = node(store).search(
        {'vector': store.rows[('doc00', 0)].embedding, 'filter': {'objectIds': _ids(SCOPE_MAX)}}
    )
    assert answer['success'] is True
    assert len(_semantic_filter(store).objectIds) == SCOPE_MAX


@pytest.mark.parametrize('mode', ['semantic', 'keyword', 'auto'])
def test_search_refuses_more_object_ids_than_the_scope_limit_before_embedding(mode):
    store = clustered()
    embedded: List[str] = []
    inst = node(store, embed_query=lambda text: embedded.append(text) or [0.1] * 8, embed_model_name='m')
    answer = inst.search({'query': 'kestrel', 'mode': mode, 'filter': {'objectIds': _ids(SCOPE_MAX + 1)}})
    assert (answer['success'], answer['code']) == (False, 'LIMIT_EXCEEDED')
    assert f'{SCOPE_MAX:,}' in answer['error'] and f'{SCOPE_MAX + 1:,}' in answer['error']
    assert embedded == [] and not [call for call in store.calls if call[0] in ('semantic', 'keyword')]


def test_search_keeps_the_legacy_object_id_key_unchanged():
    store = clustered()
    inst = node(store, embed_query=lambda text: [0.1] * 8, embed_model_name='m')
    answer = inst.search({'query': 'kestrel', 'filter': {'objectId': _ids(SCOPE_MAX + 5)}})
    assert answer['success'] is True
    assert len(_semantic_filter(store).objectIds) == SCOPE_MAX + 5
    inst.search({'query': 'kestrel', 'filter': {'objectIds': 'doc00'}})
    assert _semantic_filter(store).objectIds == ['doc00']


def _search_calls(store) -> List[Any]:
    return [call for call in store.calls if call[0] in ('semantic', 'keyword')]


@pytest.mark.parametrize('mode', ['auto', 'keyword'])
@pytest.mark.parametrize(
    'object_ids',
    [
        pytest.param(5, id='int'),
        pytest.param({'a': 1, 'b': 2}, id='mapping'),
        pytest.param([''] * 3, id='empty-strings'),
        pytest.param(['   '], id='blank-string'),
        pytest.param([1, 2, 3], id='ints'),
        pytest.param(['doc00', None], id='none-item'),
        pytest.param([], id='empty-list'),
        pytest.param('', id='empty-string'),
        pytest.param(False, id='false'),
    ],
)
def test_search_checks_the_shape_of_object_ids_like_the_sample_scope(object_ids, mode):
    # The same check as filter.object_ids of sample and neighbors: a list of 1 to scope_keys_max
    # non-empty strings, refused before anything is embedded or searched.
    store = clustered()
    embedded: List[str] = []
    inst = node(store, embed_query=lambda text: embedded.append(text) or [0.1] * 8, embed_model_name='m')
    answer = inst.search({'query': 'kestrel', 'mode': mode, 'filter': {'objectIds': object_ids}})
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')
    assert answer['error'] == f'filter.objectIds must be a list of 1 to {SCOPE_MAX} strings.'
    assert embedded == [] and _search_calls(store) == []


def test_search_counts_object_ids_before_checking_their_shape():
    store = clustered()
    answer = node(store).search({'query': 'kestrel', 'filter': {'objectIds': [None] * (SCOPE_MAX + 1)}})
    assert (answer['success'], answer['code']) == (False, 'LIMIT_EXCEEDED')
    assert f'{SCOPE_MAX:,}' in answer['error'] and f'{SCOPE_MAX + 1:,}' in answer['error']
    assert _search_calls(store) == []


def test_search_object_ids_are_trimmed_and_named_once():
    store = clustered()
    inst = node(store, embed_query=lambda text: [0.1] * 8, embed_model_name='m')
    answer = inst.search({'query': 'kestrel', 'filter': {'objectIds': (' doc01 ', 'doc00', 'doc01')}})
    assert answer['success'] is True
    assert _semantic_filter(store).objectIds == ['doc01', 'doc00']


def test_search_without_object_ids_searches_the_whole_collection():
    store = clustered()
    inst = node(store, embed_query=lambda text: [0.1] * 8, embed_model_name='m')
    assert inst.search({'query': 'kestrel', 'filter': {'objectIds': None}})['success'] is True
    assert not _semantic_filter(store).objectIds


def test_search_joins_the_legacy_object_id_and_the_scope():
    store = clustered()
    inst = node(store, embed_query=lambda text: [0.1] * 8, embed_model_name='m')
    answer = inst.search({'query': 'kestrel', 'filter': {'objectId': 'doc02', 'objectIds': ['doc00', 'doc02']}})
    assert answer['success'] is True
    assert _semantic_filter(store).objectIds == ['doc02', 'doc00']


# ---------------------------------------------------------------------------
# keyword_match (contract section 4.4-G)
# ---------------------------------------------------------------------------


def test_the_base_store_does_not_say_how_keywords_match():
    assert DocumentStoreBase.VX_KEYWORD_MATCH is None


def test_pgvector_keyword_search_matches_text_fragments(pg):
    store = pg.open()
    assert type(store).VX_KEYWORD_MATCH == 'substring'
    _seed(store, {'station': ('C:/s/station.md', [0], None, [])})
    from ai.common.schema import DocFilter, QuestionText

    found = store.searchKeyword(QuestionText(text='TION CHU'), DocFilter(limit=5))
    assert [d.metadata.objectId for d in found] == ['station']


_NODES = _REPO / 'nodes' / 'src' / 'nodes'


def _class_constants(path: Path) -> Dict[str, Dict[str, Any]]:
    """``{class name: {constant: value}}`` of the literal class-level assignments in a driver module."""
    out: Dict[str, Dict[str, Any]] = {}
    for cls in [n for n in ast.parse(path.read_text(encoding='utf-8')).body if isinstance(n, ast.ClassDef)]:
        values: Dict[str, Any] = {}
        for stmt in cls.body:
            target, value = None, None
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                target, value = stmt.targets[0].id, stmt.value
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
                target, value = stmt.target.id, stmt.value
            if target in ('VX_KEYWORD_MATCH', 'VX_DRIVER_CAPABILITIES'):
                if isinstance(value, ast.Call) and value.args:  # frozenset({...})
                    value = value.args[0]
                elif isinstance(value, ast.Call):
                    value = ast.Set(elts=[])
                values[target] = ast.literal_eval(value) if not isinstance(value, ast.Set) or value.elts else set()
        if values:
            out[cls.name] = values
    return out


def test_chroma_says_its_keyword_search_matches_text_fragments():
    constants = _class_constants(_NODES / 'store_chroma' / 'chroma.py')['Store']
    assert constants['VX_KEYWORD_MATCH'] == 'substring'
    assert 'search_keyword' in constants['VX_DRIVER_CAPABILITIES']


def test_pinecone_has_no_keyword_search_and_says_nothing():
    constants = _class_constants(_NODES / 'store_pinecone' / 'pinecone.py')['Store']
    assert 'search_keyword' not in constants['VX_DRIVER_CAPABILITIES']
    assert constants.get('VX_KEYWORD_MATCH') is None


def test_every_driver_that_names_its_keyword_matching_has_keyword_search():
    named = []
    paths = sorted(_NODES.glob('store_*/*.py')) + [_REPO / 'packages/ai/src/ai/common/store/pgvector/driver.py']
    for path in paths:
        for cls, constants in _class_constants(path).items():
            if constants.get('VX_KEYWORD_MATCH') is None:
                continue
            named.append(cls)
            assert constants['VX_KEYWORD_MATCH'] in KEYWORD_MATCHES, f'{path.name}:{cls}'
            assert 'search_keyword' in constants.get('VX_DRIVER_CAPABILITIES', set()), f'{path.name}:{cls}'
    assert 'PgVectorStore' in named and 'Store' in named
