# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The explorer's document hooks keep names of their own: ``listDocumentPage`` and ``countDocumentsWhere``.

``listDocuments`` and ``countDocuments`` belong to the simple document listing of
the agent tools (PR #2704: ``listDocuments(parent, offset, limit, deleted)``
returning a list, ``countDocuments(parent, deleted)`` returning an int). Had the
explorer kept those names for its cursor-paged hooks, a textual merge would keep
both definitions in ``DocumentStoreBase`` and the later one would silently win:
the ``documents`` tool would then fail with a TypeError (reported as
``STORE_ERROR``), and ``stats`` would read ``docFilter`` as a ``parent`` and
count nothing.

So no class in the store package or in a vector store node defines either name
with the explorer's arguments (the #2704 shape stays allowed, so the guard holds
once #2704 lands), the explorer modules never name them, and the read tools,
run on a driver that has both pairs, call the explorer's hooks only.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from ai.common.schema import DocFilter
from ai.common.store import DocumentStoreBase
from ai.common.store.vx_types import DocPage

from .test_vector_hooks import ExactListingStore
from .test_vectordb_tool_mixin import clustered, node

_ROOT = Path(__file__).resolve().parents[2]
_STORE_PACKAGE = _ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'store'
_NODES_DIR = _ROOT / 'nodes' / 'src' / 'nodes'

#: The names #2704 owns, with the only parameters its definitions take.
_OWNED_BY_2704: Dict[str, frozenset] = {
    'listDocuments': frozenset({'parent', 'offset', 'limit', 'deleted'}),
    'countDocuments': frozenset({'parent', 'deleted'}),
}

#: The explorer's own hooks.
_EXPLORER_HOOKS = ('listDocumentPage', 'countDocumentsWhere')


def _driver_sources() -> List[Path]:
    """Every Python file of the store package and of the vector store nodes."""
    files = sorted(_STORE_PACKAGE.rglob('*.py'))
    for node_dir in sorted(_NODES_DIR.iterdir()):
        if node_dir.is_dir() and (node_dir.name.startswith('store_') or node_dir.name == 'rocketride_vector'):
            files += sorted(node_dir.rglob('*.py'))
    return files


def _method_params(fn: ast.FunctionDef) -> List[str]:
    args = fn.args
    names = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
    return [name for name in names if name not in ('self', 'cls')]


def _definitions(name: str) -> List[Tuple[str, str, List[str]]]:
    """``(file, class, params)`` of every method called ``name`` in the driver sources."""
    found = []
    for path in _driver_sources():
        tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            for fn in cls.body:
                if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name == name:
                    found.append((str(path.relative_to(_ROOT)), cls.name, _method_params(fn)))
    return found


def test_the_sources_are_scanned():
    sources = {path.relative_to(_ROOT).as_posix() for path in _driver_sources()}
    assert 'packages/ai/src/ai/common/store/document_store.py' in sources
    assert 'packages/ai/src/ai/common/store/pgvector/driver.py' in sources
    assert 'nodes/src/nodes/store_qdrant/qdrant.py' in sources
    assert any(path.startswith('nodes/src/nodes/rocketride_vector/') for path in sources)


def test_no_class_defines_the_names_2704_owns_with_the_explorer_s_arguments():
    clashes = [
        (path, cls, name, params)
        for name, allowed in _OWNED_BY_2704.items()
        for path, cls, params in _definitions(name)
        if not set(params) <= allowed
    ]
    assert clashes == [], f'rename these to {_EXPLORER_HOOKS}: {clashes}'


def test_the_base_declares_the_explorer_hooks_under_their_own_names():
    for name in _EXPLORER_HOOKS:
        assert callable(getattr(DocumentStoreBase, name, None)), name
        assert name in DocumentStoreBase.VX_HOOKS
    assert not set(_OWNED_BY_2704) & set(DocumentStoreBase.VX_HOOKS)


def test_the_explorer_modules_never_name_the_hooks_2704_owns():
    named = []
    for path in sorted(_STORE_PACKAGE.glob('vx_*.py')):
        tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        named += [
            (path.name, n.lineno, n.attr)
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and n.attr in _OWNED_BY_2704
        ]
        named += [
            (path.name, n.lineno, n.value)
            for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and n.value in _OWNED_BY_2704
        ]
    assert named == []


class BothPairsStore(ExactListingStore):
    """A driver with the explorer's hooks and #2704's simple pair, as a merge of both would have."""

    def listDocumentPage(self, *, cursor, limit, object_ids, deleted, sort, filter=None) -> DocPage:
        self.calls.append(('listDocumentPage', cursor, limit))
        return super().listDocumentPage(cursor=cursor, limit=limit, object_ids=object_ids, deleted=deleted, sort=sort)

    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        self.calls.append(('countDocumentsWhere', docFilter))
        return super().countDocumentsWhere(docFilter)

    def listDocuments(self, parent=None, offset=0, limit=100, deleted=False) -> List[dict]:
        self.calls.append(('2704.listDocuments', parent, offset, limit, deleted))
        return []

    def countDocuments(self, parent=None, deleted=False) -> int:
        self.calls.append(('2704.countDocuments', parent, deleted))
        return 0


def _called(store: BothPairsStore) -> Sequence[str]:
    return [call[0] for call in store.calls]


def test_list_documents_reads_through_the_explorer_s_listing_only():
    store = clustered(BothPairsStore, docs=3, chunks=2)
    answer = node(store).list_documents({})
    assert answer['success'] is True, answer
    assert [item['objectId'] for item in answer['items']] == ['doc00', 'doc01', 'doc02']
    assert 'listDocumentPage' in _called(store)
    assert not [name for name in _called(store) if name.startswith('2704.')]


def test_stats_counts_documents_through_the_explorer_s_count_only():
    store = clustered(BothPairsStore, docs=3, chunks=2)
    answer = node(store).stats({'mode': 'full'})
    assert answer['success'] is True, answer
    assert answer['documents'] == 3
    assert 'countDocumentsWhere' in _called(store)
    assert not [name for name in _called(store) if name.startswith('2704.')]


def test_sample_and_objdir_list_through_the_explorer_s_listing_only():
    store = clustered(BothPairsStore, docs=3, chunks=2)
    inst = node(store)
    assert inst.sample({'n': 4, 'seed': 1})['success'] is True
    objdir = inst.objdir({})
    assert objdir['success'] is True and len(objdir['entries']) == 3
    assert 'listDocumentPage' in _called(store)
    assert not [name for name in _called(store) if name.startswith('2704.')]


def test_dialect_reports_the_explorer_count_from_the_renamed_hook():
    store = clustered(BothPairsStore, docs=2, chunks=1)
    capabilities = node(store).dialect({})['capabilities']
    assert capabilities['count_documents'] is True
    assert capabilities['documents_distinct'] is True
