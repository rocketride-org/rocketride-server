# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Load ``store_qdrant/qdrant.py`` bound to the repository's mock ``qdrant_client``.

The driver runs against the real ``ai.common.store`` base class and the real
schema, but its ``qdrant_client`` names resolve to ``nodes/test/mocks/qdrant_client``
(an in-memory server that mirrors the real one's paging, filter and payload
semantics). ``sys.modules`` is restored afterwards, so the real client stays
importable for the live suites.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

_NODES = Path(__file__).resolve().parents[2]
_MOCKS = _NODES / 'test' / 'mocks'
_DRIVER = _NODES / 'src' / 'nodes' / 'store_qdrant' / 'qdrant.py'


def _is_client_module(name: str) -> bool:
    return name == 'qdrant_client' or name.startswith('qdrant_client.')


def load_driver(module_name: str = '_vx_qdrant_driver_mock') -> types.ModuleType:
    """Execute qdrant.py with the mock client; return the module (``.Store``, ``.QdrantClient``)."""
    # Import the real dependencies first, so nothing else resolves from the mocks directory.
    # A stub numpy left behind by an older test module would break the driver's maths.
    if 'numpy' in sys.modules and not getattr(sys.modules['numpy'], '__file__', None):
        del sys.modules['numpy']
    import numpy  # noqa: F401
    import ai.common.config  # noqa: F401
    import ai.common.schema  # noqa: F401
    import ai.common.store  # noqa: F401

    saved_clients = {n: m for n, m in sys.modules.items() if _is_client_module(n)}
    saved_depends = sys.modules.get('depends')
    for name in saved_clients:
        del sys.modules[name]
    depends = types.ModuleType('depends')
    depends.depends = lambda *_a, **_k: None
    sys.modules['depends'] = depends
    sys.path.insert(0, str(_MOCKS))
    try:
        importlib.import_module('qdrant_client')
        spec = importlib.util.spec_from_file_location(module_name, _DRIVER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(_MOCKS))
        for name in [n for n in sys.modules if _is_client_module(n)]:
            del sys.modules[name]
        sys.modules.update(saved_clients)
        if saved_depends is None:
            sys.modules.pop('depends', None)
        else:
            sys.modules['depends'] = saved_depends


def make_store(
    module: types.ModuleType, *, collection: str = 'vx_unit', similarity: str = 'Cosine', score: float = 0.3
):
    """Build a Store through its real constructor (node config resolved by a stub)."""
    module.Config = types.SimpleNamespace(getNodeConfig=lambda _provider, conn: dict(conn))
    conn = {
        'collection': collection,
        'host': '127.0.0.1',
        'port': 6333,
        'similarity': similarity,
        'score': score,
        'profile': 'local',
    }
    return module.Store('qdrant', conn, {})


def make_doc(
    object_id: str,
    chunk_id: int,
    vector: Sequence[float],
    *,
    text: Optional[str] = None,
    parent: Optional[str] = None,
    deleted: bool = False,
    is_table: bool = False,
    model: str = 'unit-model',
    **extras: Any,
):
    """A chunk as the embedding node hands it to the store."""
    from ai.common.schema import Doc, DocMetadata

    metadata = DocMetadata(
        objectId=object_id,
        chunkId=chunk_id,
        nodeId='chunk_1',
        parent=parent or f'C:/docs/{object_id}.md',
        permissionId=0,
        isDeleted=deleted,
        isTable=is_table,
        tableId=0,
        **extras,
    )
    doc = Doc(page_content=text if text is not None else f'{object_id} chunk {chunk_id}', metadata=metadata)
    doc.embedding = [float(v) for v in vector]
    doc.embedding_model = model
    return doc


def vx_filter(**kwargs: Any):
    """A DocFilter that also carries the explorer fields (``deleted``, ``minScore``)."""
    from ai.common.schema import DocFilter

    fields: Dict[str, Any] = getattr(DocFilter, 'model_fields', {})
    if 'deleted' in fields and 'minScore' in fields:
        return DocFilter(**kwargs)

    class _VxDocFilter(DocFilter):
        deleted: Optional[str] = None
        minScore: Optional[float] = None

    return _VxDocFilter(**kwargs)


def keys_of(docs: Iterable[Any]) -> List[tuple]:
    """(objectId, chunkId) of each doc, in order."""
    return [(d.metadata.objectId, d.metadata.chunkId) for d in docs]
