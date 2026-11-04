import functools
import importlib
import json
import threading
from abc import abstractmethod, ABC
from typing import TYPE_CHECKING, List, Callable, Dict, Any, FrozenSet, Optional, Sequence, Tuple
from rocketlib import IInstanceBase, tool_function, warning
from ..schema import Doc, DocFilter, DocMetadata, Question, QuestionText, QuestionType, Answer
from . import vx_write_gate
from .errors import StoreUnsupported, ToolRefusal
from .vx_defaults import AGENT_WRITE_IDS_MAX, VECTOR_TOOL_LIMITS
from .vx_tools import (  # noqa: F401 - re-exported for the drivers that override the hooks
    ListingGuard,
    VectorExplorerTools,
    decodeCursor,
    defaultCursorState,
    deletedFilter,
    docKey as _vxDocKey,
    documentRow,
    encodeCursor,
    hasVector,
    invalidCursor,
    matchesDeleted,
    metadataValue,
    normalize_tool_input,
    read_vectors,
    safe_error,
    vectordb_tool,
)
from .vx_tools import _strings_arg
from .vx_tools_ext import VectorExplorerExtTools
from .vx_types import CONTROL_OBJECT_ID, ChunkPage, DocListFilter, DocPage, KnnGraph, StoreInfo

if TYPE_CHECKING:  # annotations only: numpy is imported where a hook needs it
    import numpy as np

    from .vx_types import Deleted, Key


def _unsupported(hook: str) -> Exception:
    """Build the ``StoreUnsupported`` an optional hook raises when the driver does not implement it."""
    return StoreUnsupported(f'{hook} is not supported by this store')


#: ``dialect.backend`` for a provider (node logical type) whose driver does not set ``VX_BACKEND``.
_BACKEND_BY_PROVIDER: Dict[str, str] = {
    'postgres': 'pgvector',
    'rocketride_vector': 'pgvector',
    'qdrant': 'qdrant',
    'chroma': 'chroma',
    'milvus': 'milvus',
    'weaviate': 'weaviate',
    'pinecone': 'pinecone',
    'astra_db': 'astra',
    'astra': 'astra',
    'mongodb+srv': 'atlas',
    'atlas': 'atlas',
}

#: Metadata keys ``DocMetadata(pInstance)`` adds for the explorer (contract section 2.3). A driver
#: that cannot store them (:meth:`DocumentStoreBase.vxStoresExtras`) never sees them in ``addChunks``.
VX_METADATA_EXTRAS: Tuple[str, ...] = ('size', 'modifyTime', 'ingestedAt')

#: Driver modules that write one table column per metadata key (``model_dump().keys()`` as the
#: INSERT column list) and therefore fail on an unknown key until they keep extras elsewhere.
_COLUMN_PER_KEY_MODULES = frozenset({'store_postgres', 'rocketride_vector'})

#: Most times the default ``scrollChunks`` slides an empty window forward (each slide doubles it).
_SCROLL_SLIDES_MAX = 64

#: Driver methods that change stored rows; ``DocumentStoreBase.__init_subclass__`` guards them.
_VX_GUARDED_WRITES = ('addChunks', 'remove', 'removeCounted', 'markDeleted', 'markActive')


def _guarded_write(name: str, method: Callable) -> Callable:
    """Wrap a driver write method: extras trimmed for ``addChunks``, cached counts dropped afterwards.

    A removal or a trash write also drops the cached samples, so ``project``, ``neighbors``
    and ``similarity_matrix`` never serve a point that left the collection or went to the
    trash; an upload keeps them (the points they hold are still stored and live).
    """
    if name == 'addChunks':

        @functools.wraps(method)
        def guarded(self, chunks, *args, **kw):
            try:
                return method(self, self.vxWritableChunks(chunks), *args, **kw)
            finally:
                self.vxForgetCounts()

    else:

        @functools.wraps(method)
        def guarded(self, *args, **kw):
            try:
                return method(self, *args, **kw)
            finally:
                self.vxForgetCounts()
                self.vxForgetSamples()

    guarded.__vx_write_guard__ = True
    return guarded


def _without_extras(doc: Doc) -> Doc:
    """Return ``doc`` without :data:`VX_METADATA_EXTRAS` in its metadata (a copy; ``doc`` is not changed)."""
    metadata = getattr(doc, 'metadata', None)
    extra = getattr(metadata, 'model_extra', None)
    if not extra or not any(name in extra for name in VX_METADATA_EXTRAS):
        return doc
    trimmed = metadata.model_copy()
    object.__setattr__(
        trimmed,
        '__pydantic_extra__',
        {name: value for name, value in extra.items() if name not in VX_METADATA_EXTRAS},
    )
    copy = doc.model_copy()
    copy.metadata = trimmed
    return copy


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _docKey(doc: Doc) -> str:
    return f'{metadataValue(doc, "objectId")}#{metadataValue(doc, "chunkId")}'


class DocumentStoreBase(ABC):
    """
    Base class for all vector storage drivers.

    The DocumentStoreBase class is used to abstract the details of the DocumentStore
    so it can be dynamically changed to a different provider. Some methods are abstract
    which must be implemented in the actual providers, but some of the utility functions
    are implemented here but can be overridden
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Define the default constructor.
        """
        self.vectorSize: int = 0
        self.modelName: str = ''
        self.threshold_search = 0.5
        self.collectionLock = threading.Lock()

        # The node's logical type ('qdrant', 'postgres', ...); reported by the explorer tools.
        self.provider: str = provider

        # Whether the last query model compared against the control record differed
        # from it (None until a search names a model). A warning, never a refusal.
        self.modelMismatch: Optional[bool] = None

    @abstractmethod
    def _doesCollectionExist() -> bool:
        """
        Return True if the collection exists, False otherwise.

        This the abstract method that the driver must implement
        """

    @abstractmethod
    def _createCollection() -> bool | None:
        """
        Create the collection.

        This the abstract method that the driver must implement. Implementations
        must either raise on failure or explicitly return False; the caller
        (createCollection) treats a return value of exactly False as failure and
        aborts before indexing any documents.

        The return is annotated bool | None because None is a legitimate success
        value here: store_weaviate, store_postgres and rocketride_vector create
        the collection and return nothing. Only an explicit False means failure.
        """

    @abstractmethod
    def count_documents(self) -> int:
        """
        Return how many documents are present in the document store.
        """

    @abstractmethod
    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Return the documents that match the filters provided.
        """

    @abstractmethod
    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        """
        Return the documents that match the filters provided.
        """

    @abstractmethod
    def get(self, docFilter: DocFilter) -> List[Doc]:
        """
        Perform a database query to get objects.
        """

    @abstractmethod
    def getPaths(self, parent: str | None = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        """
        Query and return all the unique parent paths.
        """

    @abstractmethod
    def addChunks(self, chunks: List[Doc]) -> None:
        """
        Write (or overwrite) documents into the store.
        """

    @abstractmethod
    def remove(self, objectIds: List[str]) -> None:
        """
        Delete all documents with a matching objectIds from the document store.
        """

    @abstractmethod
    def markDeleted(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as deleted.

        They then will not be returned from the search without specifying deleted=True.
        Returns the number of chunks the call moved to the trash (0 for a document already
        there or not stored), or None when the backend cannot count; the ``soft_delete``
        tool answers it as ``matched_chunks``.
        """

    @abstractmethod
    def markActive(self, objectIds: List[str]) -> Optional[int]:
        """
        Mark the set of documents with the given objectId as active.

        This occurs if a document now "comes back" after begin deleted.
        Returns the number of chunks the call took out of the trash (0 for a document not
        in it), or None when the backend cannot count; ``restore`` answers it.
        """

    @abstractmethod
    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        """
        Given an object id, render the complete document.

        Rehydrates all the chunks into the proper order.
        """

    # ------------------------------------------------------------------
    # Optional explorer hooks (docs/development/nodes/vector-tool-contract.md, section 2)
    #
    # None of these is abstract: a driver overrides the ones its backend can
    # answer natively and inherits the rest. A hook that cannot be answered
    # raises ``StoreUnsupported`` (``ai.common.store.errors``), which the tool
    # wrapper reports as ``{success: false, code: 'UNSUPPORTED'}``. Every hook
    # excludes the control record (objectId ``'schema'``) from what it returns.
    #
    # The defaults below work on any driver through the abstract API (``get``,
    # ``remove``) and the count hooks; ``sampleChunks`` and ``getVectors`` have
    # no portable default because no driver returns embeddings from ``get``.
    # ------------------------------------------------------------------

    #: Capability names a driver declares in addition to the hooks it overrides, for example
    #: ``'sample_stratified_native'``, ``'knn_native'``, ``'documents_distinct'``,
    #: ``'documents_sorted'``, ``'search_keyword'`` (vocabulary: ``vx_types.CAPABILITY_KEYS``).
    VX_DRIVER_CAPABILITIES: FrozenSet[str] = frozenset()

    #: The optional hooks :meth:`capabilities` inspects.
    VX_HOOKS: Tuple[str, ...] = (
        'describe',
        'scoreInfo',
        'countChunks',
        'countDocumentsWhere',
        'listDocumentPage',
        'scrollChunks',
        'sampleChunks',
        'getVectors',
        'knnGraph',
        'removeCounted',
    )

    #: ``dialect.backend`` of the driver ('pgvector', 'qdrant', ...). None: derived from the provider.
    VX_BACKEND: Optional[str] = None

    #: ``dialect.keyword_match`` (contract section 4.4-G): how ``searchKeyword`` matches the question's
    #: text, from ``vx_types.KEYWORD_MATCHES``. ``'substring'``: a fragment anywhere in the chunk text
    #: (pgvector's ``ILIKE``, Chroma's ``$contains``); ``'token'``: whole words of a full-text index
    #: (Qdrant's ``MatchText``). None: the driver has no keyword search, or does not say.
    VX_KEYWORD_MATCH: Optional[str] = None

    #: ``dialect.support``: 'supported' once the driver's unmocked suites pass on a new and a legacy
    #: collection, else 'experimental'. A driver lane sets it; mocked evidence never does.
    VX_SUPPORT: str = 'experimental'

    #: Whether ``addChunks`` may receive the explorer's metadata extras (:data:`VX_METADATA_EXTRAS`).
    #: None: derived by :meth:`vxStoresExtras` (False for pgvector, True for payload stores). A driver
    #: that keeps extras (pgvector in its ``meta`` column) sets True; one that cannot sets False.
    VX_STORES_EXTRAS: Optional[bool] = None

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Route every driver's own write methods through the explorer's guards.

        ``addChunks`` goes through :meth:`vxWritableChunks`, so a driver that cannot store
        the explorer's metadata extras keeps ingesting exactly what it wrote before; it and
        ``remove``, ``removeCounted``, ``markDeleted`` and ``markActive`` then drop the cached
        ``stats`` figures (:meth:`vxForgetCounts`), whether they succeed or fail, and all but
        ``addChunks`` drop the cached samples too (:meth:`vxForgetSamples`). Covers every path
        to the driver: ``writeDocuments`` (the data lane), nodes that call the store directly,
        ``createCollection`` and the tools.
        """
        super().__init_subclass__(**kwargs)
        for name in _VX_GUARDED_WRITES:
            method = cls.__dict__.get(name)
            if method is None or getattr(method, '__isabstractmethod__', False):
                continue
            if getattr(method, '__vx_write_guard__', False):
                continue
            setattr(cls, name, _guarded_write(name, method))

    def vxForgetCounts(self) -> None:
        """Drop the ``stats`` figures cached for this store, so the next ``stats`` recounts."""
        state = self.__dict__.get('_vx_state')
        if state is not None:
            state.forget_counts()

    def vxForgetSamples(self) -> None:
        """Drop the samples cached for this store (after a removal or a trash write)."""
        state = self.__dict__.get('_vx_state')
        if state is not None:
            state.forget_samples()

    def vxChunksInState(self, objectIds: Sequence[str], deleted: bool) -> Optional[int]:
        """Count the chunks of ``objectIds`` in the trash (``deleted``) or out of it, through :meth:`countChunks`.

        A driver whose update does not report what it changed counts the chunks a
        ``markDeleted`` (``deleted=False``) or ``markActive`` (``deleted=True``) is about to
        move, so both return a count. None when the driver cannot count with a filter.
        """
        ids = [str(oid) for oid in objectIds or [] if str(oid) != CONTROL_OBJECT_ID]
        if not ids:
            return 0
        count = self.countChunks(deletedFilter('deleted' if deleted else 'active', objectIds=ids))
        return count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None

    def vxStoresExtras(self) -> bool:
        """Return whether this driver stores the explorer's metadata extras.

        :attr:`VX_STORES_EXTRAS` when the driver sets it; otherwise False for the pgvector
        backend and the drivers that write one column per metadata key, True for the rest
        (Qdrant, Chroma, Milvus, Weaviate and Pinecone keep them in the payload).
        """
        declared = type(self).VX_STORES_EXTRAS
        if isinstance(declared, bool):
            return declared
        if self.vxBackend() == 'pgvector':
            return False
        return not _COLUMN_PER_KEY_MODULES.intersection(type(self).__module__.split('.'))

    def vxWritableChunks(self, chunks: List[Doc]) -> List[Doc]:
        """Return ``chunks`` as this driver can store them: without the metadata extras when it cannot.

        The caller's documents are never changed; a trimmed document is a copy.
        """
        if not chunks or not isinstance(chunks, (list, tuple)) or self.vxStoresExtras():
            return chunks
        return [_without_extras(doc) for doc in chunks]

    def capabilities(self) -> FrozenSet[str]:
        """
        Return what this driver implements natively.

        The result is the names of the hooks in :attr:`VX_HOOKS` that the driver
        overrides (``type(self).hook is not DocumentStoreBase.hook``) plus the
        driver's :attr:`VX_DRIVER_CAPABILITIES`. The tools map this onto the
        ``dialect.capabilities`` keys.
        """
        cls = type(self)
        overridden = {
            name for name in DocumentStoreBase.VX_HOOKS if getattr(cls, name) is not getattr(DocumentStoreBase, name)
        }
        return frozenset(overridden) | frozenset(cls.VX_DRIVER_CAPABILITIES)

    def vxBackend(self) -> str:
        """Return the backend family reported as ``dialect.backend``."""
        if self.VX_BACKEND:
            return self.VX_BACKEND
        provider = str(getattr(self, 'provider', '') or '')
        return _BACKEND_BY_PROVIDER.get(provider, provider or 'unknown')

    def vxCollectionName(self) -> Optional[str]:
        """Return the collection (table, index) name, never a database or host name; None when unknown."""
        for attr in ('collection_name', 'collection', 'table', 'index_name', 'indexName'):
            value = getattr(self, attr, None)
            if isinstance(value, str) and value:
                return value
        return None

    def _readControlRecord(self) -> bool:
        """Read the control record; load ``vectorSize``/``modelName`` and return True when exactly one exists."""
        flt = DocFilter(objectIds=[CONTROL_OBJECT_ID], isDeleted=True)
        flt.deleted = 'all'
        docs = self.get(flt, checkCollection=False)
        controls = [d for d in docs if metadataValue(d, 'objectId') == CONTROL_OBJECT_ID]
        if len(controls) != 1:
            return False
        self.vectorSize = int(metadataValue(controls[0], 'vectorSize') or 0)
        self.modelName = str(metadataValue(controls[0], 'modelName') or '')
        return True

    def describe(self) -> StoreInfo:
        """
        Describe the store: backend, collection, metric, dimension, model, index, size, caveats.

        Never raises for a missing collection: it answers ``collection_exists=False``
        and ``control_record=None``. Never carries a host, port, DSN, credential or
        database name.

        Default: existence through ``_doesCollectionExist()``, model and dimension from
        the control record, the configured similarity as the metric;
        ``backend_version``, ``index``, ``size_bytes`` and ``meta_column`` None. The
        caveat ``model_mismatch`` is added when the last query model compared by
        :meth:`doesCollectionExist` differed from the stored one.
        """
        from .vx_math import normalize_metric

        exists = bool(self._doesCollectionExist())
        control: Optional[bool] = None
        if exists:
            with self.collectionLock:
                control = self._readControlRecord()
        caveats: List[str] = []
        if getattr(self, 'modelMismatch', None):
            caveats.append('model_mismatch')
        known = exists and bool(control)
        return StoreInfo(
            backend=self.vxBackend(),
            backend_version=None,
            collection=self.vxCollectionName(),
            collection_exists=exists,
            control_record=control,
            meta_column=None,
            metric=normalize_metric(getattr(self, 'similarity', None)) if exists else None,
            dimension=(self.vectorSize or None) if known else None,
            model=(self.modelName or None) if known else None,
            index=None,
            size_bytes=None,
            caveats=caveats,
        )

    def scoreInfo(self) -> Dict[str, Any]:
        """
        Describe how ``Doc.score`` is computed for this store.

        Keys: ``formula`` (text), ``higher_is_better`` (bool), ``floor`` (the driver's legacy
        floor below which search drops rows), ``threshold`` (the node's configured score
        threshold), and optionally ``range``.
        """
        return {'formula': 'unknown', 'higher_is_better': True, 'floor': 0.2, 'threshold': self.threshold_search}

    def effectiveFloor(self, docFilter: DocFilter) -> float:
        """
        Return the score floor a search with ``docFilter`` applies.

        ``docFilter.minScore`` when it is set (it may be ``-inf`` to keep every row),
        otherwise the driver's legacy floor (``scoreInfo()['floor']``). Agents never set
        ``minScore``, so their results are unchanged.
        """
        min_score = getattr(docFilter, 'minScore', None)
        if min_score is not None:
            return float(min_score)
        return float(self.scoreInfo()['floor'])

    def countChunks(self, docFilter: DocFilter) -> Optional[int]:
        """
        Count the chunk rows matching ``docFilter`` (control record excluded).

        A driver that counts selects rows by :meth:`resolveDeleted`, never by the
        legacy ``isDeleted`` flag alone: some backends read ``isDeleted=True`` as
        "deleted rows only", so ``deleted='all'`` would count no active row (and
        :meth:`removeCounted` would report a stored document as empty).

        Default: None (the backend cannot count with a filter).
        """
        return None

    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]:
        """
        Count the distinct objectIds matching ``docFilter`` (control record excluded).

        Rows are selected by :meth:`resolveDeleted`, as in :meth:`countChunks`.

        Default: None.
        """
        return None

    def listDocumentPage(
        self,
        *,
        cursor: Optional[str],
        limit: int,
        object_ids: Optional[Sequence[str]],
        deleted: 'Deleted',
        sort: str,
        filter: Optional[DocListFilter] = None,
    ) -> DocPage:
        """
        Return one page of documents (one row per objectId).

        ``cursor`` is the opaque ``next_cursor`` of the previous page (None for the first
        page); ``object_ids`` restricts the listing; ``sort`` is ``'path'``.

        ``filter`` (contract section 4.4-A) restricts the listing further. The ``documents``
        tool passes it only to a driver that declares ``documents_filter`` in
        :attr:`VX_DRIVER_CAPABILITIES`, so a driver whose override does not take it is never
        handed one. A driver applies the keys it can and names the others in
        ``DocPage.filter_ignored``; the tool answers ``filter_applied`` from that. This
        default applies none of them and names every given key.

        Default (``distinct=False``, ``sorted=False``):
        ``get(DocFilter(chunkIds=[0], deleted=deleted, limit=limit + 1, offset=cursor.offset))``,
        sorted by ``(parent, objectId)`` within the page; ``chunks=None``,
        ``counts_exact=False``, ``total=None``, caveat ``documents_by_first_chunk`` (a
        document is listed by its chunk 0; the ``list_documents`` tool reads the trash after
        the last page for the documents whose chunk 0 is there but which have a live chunk). The opaque cursor is
        ``{'o': offset, 'f': first key of the previous page}``; when a page's first key
        equals ``cursor['f']`` the backend ignored the offset, so the page ends with
        ``next_cursor=None`` and the caveat ``'documents_paging_unsupported'``.

        A cursor the hook did not issue raises :func:`invalidCursor` (``INVALID_INPUT``)
        before the backend is asked; a driver with its own cursor does the same.
        """
        offset, previous_first = defaultCursorState(cursor)
        limit = max(1, int(limit))
        flt = deletedFilter(
            deleted,
            chunkIds=[0],
            objectIds=list(object_ids) if object_ids else None,
            limit=limit + 1,
            offset=offset,
        )
        raw = self.get(flt)
        first_key = _docKey(raw[0]) if raw else None
        ignored = filter.given() if filter is not None else ()
        if previous_first is not None and first_key == previous_first:
            return DocPage(
                items=[],
                next_cursor=None,
                total=None,
                counts_exact=False,
                distinct=False,
                sorted=False,
                caveats=['documents_by_first_chunk', 'documents_paging_unsupported'],
                filter_ignored=ignored,
            )
        items = [
            documentRow(doc)
            for doc in raw[:limit]
            if metadataValue(doc, 'objectId') != CONTROL_OBJECT_ID
            and (not object_ids or metadataValue(doc, 'objectId') in object_ids)
            and matchesDeleted(doc, deleted)
        ]
        items.sort(key=lambda row: (row.path, row.objectId))
        next_cursor = encodeCursor({'o': offset + limit, 'f': first_key}) if len(raw) > limit else None
        return DocPage(
            items=items,
            next_cursor=next_cursor,
            total=None,
            counts_exact=False,
            distinct=False,
            sorted=False,
            caveats=['documents_by_first_chunk'],
            filter_ignored=ignored,
        )

    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: 'Deleted') -> ChunkPage:
        """
        Return the chunks of one document after ``after_chunk``, in chunk order, without embeddings.

        Default: ``get(DocFilter(objectIds=[objectId], minChunkId=after_chunk + 1,
        maxChunkId=after_chunk + limit, deleted=deleted))`` sorted by chunkId, plus a
        one-row probe past the window for ``has_more``. When the window is empty but the
        probe finds a later chunk, the window slides forward (doubling its width, never
        past the probed chunk's own window) until it holds a chunk, so a page is never
        empty while chunks follow: the first page of a document carries its first stored
        chunk however its ids are spaced (a document whose chunk 0 was removed answers
        its chunk 1). A page holds at most ``limit`` chunks; ``next_after`` is the end of
        the window read, or the last chunk returned when the window held more.
        """
        if objectId == CONTROL_OBJECT_ID:
            return ChunkPage(docs=[], has_more=False, next_after=int(after_chunk))
        limit = max(1, int(limit))
        low = int(after_chunk) + 1
        high = int(after_chunk) + limit
        rows = self._vxChunkWindow(objectId, low, high, deleted)
        following: Optional[int] = None
        probed = False
        if not rows:
            following, probed = self._vxChunkAfter(objectId, high, deleted), True
            width = limit
            for _ in range(_SCROLL_SLIDES_MAX):
                if following is None:
                    break
                low, width = high + 1, width * 2
                high = min(following + limit - 1, low + width - 1)
                rows = self._vxChunkWindow(objectId, low, high, deleted)
                if rows or high >= following:  # found, or the probed chunk went away meanwhile
                    probed = False
                    break
        if len(rows) > limit:
            rows = rows[:limit]
            return ChunkPage(docs=[doc for _, doc in rows], has_more=True, next_after=rows[-1][0])
        if not probed:
            following = self._vxChunkAfter(objectId, high, deleted)
        return ChunkPage(docs=[doc for _, doc in rows], has_more=following is not None, next_after=high)

    def _vxChunkWindow(self, objectId: str, low: int, high: int, deleted: 'Deleted') -> List[Tuple[int, Doc]]:
        """``(chunkId, doc)`` of the document's chunks in ``[low, high]``, sorted, without embeddings."""
        window = self.get(
            deletedFilter(
                deleted, objectIds=[objectId], minChunkId=low, maxChunkId=high, limit=high - low + 1, offset=0
            )
        )
        by_chunk: Dict[int, Doc] = {}
        for doc in window:
            chunk = _int_or_none(metadataValue(doc, 'chunkId'))
            if (
                metadataValue(doc, 'objectId') == objectId
                and chunk is not None
                and low <= chunk <= high
                and matchesDeleted(doc, deleted)
            ):
                doc.embedding = None
                by_chunk.setdefault(chunk, doc)
        return [(chunk, by_chunk[chunk]) for chunk in sorted(by_chunk)]

    def _vxChunkAfter(self, objectId: str, high: int, deleted: 'Deleted') -> Optional[int]:
        """The id of some chunk of the document above ``high`` (a one-row probe), or None."""
        beyond = self.get(deletedFilter(deleted, objectIds=[objectId], minChunkId=high + 1, limit=1, offset=0))
        for doc in beyond:
            chunk = _int_or_none(metadataValue(doc, 'chunkId'))
            if (
                metadataValue(doc, 'objectId') == objectId
                and chunk is not None
                and chunk > high
                and matchesDeleted(doc, deleted)
            ):
                return chunk
        return None

    def sampleChunks(
        self,
        *,
        n: int,
        seed: int,
        strategy: str,
        docFilter: DocFilter,
        include_keys: Sequence['Key'],
    ) -> Tuple[List[Doc], str]:
        """
        Draw up to ``n`` chunks WITH embeddings; return ``(docs, strategy_used)``.

        ``strategy`` is ``'random'``, ``'stratified'`` or ``'first'`` (``strategy_used`` is one
        of those). A driver implements ``'stratified'`` only where it is cheap and native
        (pgvector ``ROW_NUMBER() OVER (PARTITION BY objectid ORDER BY random())``, Atlas
        ``$sample`` per group) and raises ``StoreUnsupported`` otherwise, so the shared
        sampler falls back. ``include_keys`` are keys the caller already holds; a driver
        may skip them.

        Default: raise ``StoreUnsupported``.
        """
        raise _unsupported('sampleChunks')

    def getVectors(self, keys: Sequence['Key']) -> List[Doc]:
        """
        Return the chunks for ``keys`` WITH embeddings; each Doc carries ``metadata.pointId``.

        Reads by filter (``objectId IN ... AND chunkId IN ...``, paired client-side,
        deleted rows included). A driver with deterministic ids may first try
        ``uuid5(NAMESPACE_URL, f'{objectId}#{chunkId}')`` and MUST fall back to the
        filter for every miss (older rows have random ids). Missing keys are omitted.

        Default: raise ``StoreUnsupported``.
        """
        raise _unsupported('getVectors')

    def knnGraph(self, keys: Sequence['Key'], vectors: 'np.ndarray', metric: str, k: int) -> KnnGraph:
        """
        Return the k-nearest-neighbour graph over the sampled ``keys`` (rows of ``vectors``).

        Default: ``vx_math.knn(metric, vectors, k)``, ``source='node'``.
        Qdrant overrides it with ``search_matrix_offsets`` (``source='native'``).
        """
        from .vx_math import knn

        offsets, cols, sims = knn(metric, vectors, k)
        k_eff = max(0, min(int(k), len(keys) - 1))
        return KnnGraph(k=k_eff, offsets_row=offsets, cols=cols, sims=sims, source='node')

    def removeCounted(self, objectIds: List[str]) -> Optional[int]:
        """
        Remove every chunk of ``objectIds``; return the rows actually removed (None when unknown).

        Never removes the control record. Default:
        ``n = countChunks(DocFilter(objectIds=objectIds, deleted='all')); self.remove(objectIds); return n``.
        """
        ids = [oid for oid in objectIds if oid != CONTROL_OBJECT_ID]
        if not ids:
            return 0
        count = self.countChunks(deletedFilter('all', objectIds=list(ids)))
        self.remove(ids)
        return count

    @staticmethod
    def resolveDeleted(docFilter: DocFilter) -> 'Deleted':
        """
        Return which rows ``docFilter`` covers: ``'active'``, ``'deleted'`` or ``'all'``.

        ``docFilter.deleted`` when it is set; otherwise ``isDeleted`` None or False reads
        as ``'active'`` and True as ``'all'``.
        """
        deleted = getattr(docFilter, 'deleted', None)
        if deleted in ('active', 'deleted', 'all'):
            return deleted
        return 'all' if getattr(docFilter, 'isDeleted', None) is True else 'active'

    def _getDocKey(self, doc: Doc) -> Tuple[str, int]:
        return (doc.metadata.objectId, doc.metadata.chunkId)

    def _getTableKey(self, doc: Doc) -> Tuple[str, int]:
        return (doc.metadata.objectId, doc.metadata.tableId)

    def _processFullTables(self, documents: Dict[Tuple[str, int], Doc]) -> Dict[Tuple[str, int], Doc]:
        """
        Process tables.

        This is post processing after a search has
        completed which reads the entire table and concatenates
        the documents of the tables into the first entry for
        that table
        """
        # Find the tables we need to process
        tableIds: Dict[str, List[int]] = {}
        tableDocs: Dict[Tuple[str, int], Doc] = {}
        for docKey, doc in documents.items():
            # If this is not a table, skip it
            if not doc.metadata.isTable:
                continue

            # Get the objectId and the table id
            objectId = doc.metadata.objectId
            tableId = doc.metadata.tableId

            # Add this table to the group to find
            if objectId not in tableIds:
                tableIds[objectId] = []

            # Append this table id
            if tableId not in tableIds[objectId]:
                tableIds[objectId].append(tableId)

            # Add this table to the score group
            tableKey = self._getTableKey(doc)
            if tableKey not in tableDocs:
                # Reset the page content, we build it up
                # in the next phase
                doc.page_content = ''

                # Save it
                tableDocs[tableKey] = doc

            # Update the score if this one is higher
            if doc.score > tableDocs[tableKey].score:
                tableDocs[tableKey].score = doc.score

        # If there are no tables, done
        if not len(tableIds):
            return documents

        # Now, we can do our queries
        for objectId in tableIds.keys():
            # Build the filter
            tableFilter = DocFilter(isTable=True, objectIds=[objectId], tableIds=tableIds[objectId])

            # Get all the table chunks for these tables in
            # the document
            tableChunks = self.get(tableFilter)

            # Sort them by chunkId
            tableChunks.sort(key=lambda doc: doc.metadata.chunkId)

            # Gather up all the text of the table
            for chunk in tableChunks:
                # Get this chunks table key
                tableKey = self._getTableKey(chunk)

                # Get the object id
                objectId = chunk.metadata.objectId

                # If this is the first part of the table
                if tableKey not in tableDocs:
                    original_content = chunk.page_content
                    chunk.page_content = ''
                    tableDocs[tableKey] = chunk
                    tableDocs[tableKey].page_content += original_content
                    continue

                # Append the text
                tableDocs[tableKey].page_content += chunk.page_content

        # Now, we have the new documents built into tableDocs. The
        # key for this is (objectId/tableId). It has the highest score
        # returned in all of our chunks, and now has the page_content
        # containing the entire table. Rip through the original docs
        # and replace the table chunks with the new tableDocs
        newDocs: Dict[Tuple[str, int], Doc] = {}
        for docKey, doc in documents.items():
            # If this is not a table, we are not replacing it
            if not doc.metadata.isTable:
                newDocs[docKey] = doc
                continue

            # Get the table key of this document table
            tableKey = self._getTableKey(doc)

            # If this table is not there, it has already been replaced
            if tableKey not in tableDocs:
                continue

            # Get the new document key for this
            docKey = self._getDocKey(tableDocs[tableKey])

            # Add this to the new docs
            newDocs[docKey] = tableDocs[tableKey]

            # Remove it from the tableDocs
            del tableDocs[tableKey]

        # Return the new document list
        return newDocs

    def _processFullDocuments(self, documents: Dict[Tuple[str, int], Doc]) -> Dict[Tuple[str, int], Doc]:
        # Make sure we only read it once
        objectIds: Dict[str, Doc] = {}

        # Walk through all the source documents
        for docKey, doc in documents.items():
            # Get the object id
            objectId = doc.metadata.objectId

            # If we have already read this document, grab the highest score
            if objectId in objectIds:
                if doc.score > objectIds[objectId].score:
                    objectIds[objectId].score = doc.score
                    continue

            # We will be filling this all in
            doc.page_content = ''
            doc.metadata.chunkId = 0

            # Add it to the list
            objectIds[doc.metadata.objectId] = doc

        # Now, we have a collection of object ids we need to retrieve
        newDocs: Dict[Tuple[str, int], Doc] = {}
        for objectId in objectIds.keys():
            # Build the filter
            docFilter = DocFilter(objectIds=[objectId])

            # Get all the table chunks for these tables in
            # the document
            docChunks = self.get(docFilter)

            # Sort them by chunkId
            docChunks.sort(key=lambda doc: doc.metadata.chunkId)

            # Get the base document
            doc = objectIds[objectId]
            for docChunk in docChunks:
                doc.page_content += docChunk.page_content

            # Get the key and save it
            docKey = self._getDocKey(doc)
            newDocs[docKey] = doc

        # Return the update document list
        return newDocs

    def _queryDocuments(self, question: Question) -> Dict[Tuple[str, int], Doc]:
        # Get the type of question being asked
        type = question.type

        # Keep track of the documents by objectId/chunkId
        documents: Dict[Tuple[str, int], Doc] = {}

        # Add the pending documents to our list
        for doc in question.documents:
            # Add the doc to the list
            key = self._getDocKey(doc)
            documents[key] = doc

        def _addDoc(doc: Doc):
            # If it doesn't meet our score threshold, skip it
            if doc.score < self.threshold_search:
                return

            # Get the key for this document
            key = self._getDocKey(doc)

            # If this is already there, skip
            if key in documents:
                # Use the highest score
                if doc.score > documents[key].score:
                    documents[key].score = doc.score
                return

            # Add it
            documents[key] = doc

        def _addDocs(docs: List[Doc]):
            # For each document, add it
            for doc in docs:
                _addDoc(doc)

        # What type is this?
        if type == QuestionType.PROMPT or type == QuestionType.SEMANTIC or type == QuestionType.QUESTION:
            # For each question
            for query in question.questions:
                # Make sure we have the embeddings
                if not query.embedding_model:
                    raise Exception('You must run your question through an embedding filter')

                # Do a find operation
                docs = self.searchSemantic(query, question.filter)

                # Add the documents we got back
                _addDocs(docs)

        if type == QuestionType.KEYWORD:
            # For each question
            for query in question.questions:
                # Do a find operation
                docs = self.searchKeyword(query, question.filter)

                # Add the documents we got back
                _addDocs(docs)

        elif type == QuestionType.GET:
            # This is a get request
            docs = self.get(question.filter)

            # Add the documents we got back
            _addDocs(docs)

        else:
            # Nothing that we handle, pass it on
            pass

        # Return our 'raw' query documents
        return documents

    def dispatchSearch(self, pSelf: IInstanceBase, question: Question) -> List[Doc]:
        # Perform the raw query
        documents = self._queryDocuments(question)

        # Process full table request
        if question.filter.fullTables and not question.filter.fullDocuments:
            documents = self._processFullTables(documents)

        # Process full document request
        if question.filter.fullDocuments:
            documents = self._processFullDocuments(documents)

        # Get the resulting documents as a list
        documentList = list(documents.values())

        # Sort them by score
        documentList.sort(key=lambda doc: -doc.score)

        # Get the listeners to us
        listeners = pSelf.instance.getListeners()

        # If someone is listening on the documents lane, send it
        if 'documents' in listeners:
            pSelf.instance.writeDocuments(documentList)

        # If someone is listening on the answers lane, send it
        if 'answers' in listeners:
            answer = Answer()
            answer.setAnswer([document.toDict() for document in documentList])
            pSelf.instance.writeAnswers(answer)

        # If someone is listening on the questions lane, send it
        if 'questions' in listeners:
            # If we have a document list
            if documentList:
                # Replace the previous document list
                question.documents = documentList

                # If we don't have a filter list, create it
                if not question.filter.objectIds:
                    question.filter.objectIds = []

                # Add the objects ids to the filter list - this will limit the
                # next set of questions to these documents
                for doc in documentList:
                    # Get the object id
                    objectId = doc.metadata.objectId

                    # Filter to this object id
                    if objectId not in question.filter.objectIds:
                        question.filter.objectIds.append(doc.metadata.objectId)

            # Write the new question
            pSelf.instance.writeQuestions(question)

        # We handled all of our lane outputs
        return pSelf.preventDefault()

    def _checkCollectionExists(self) -> bool:
        """
        Check if collection exists without acquiring locks.

        This method performs the same logic as doesCollectionExist but without
        acquiring locks, allowing it to be called from within collectionLock.

        :return: True if the collection exists, False otherwise.
        """
        try:
            # Perform the actual existence check without locks
            exists = self._doesCollectionExist()

            # If the collection does not exist, return False
            if not exists:
                return False

            # Create a document filter to locate the control document
            filter = DocFilter()
            filter.objectIds = [CONTROL_OBJECT_ID]  # Looking for the reference schema document
            filter.isDeleted = True  # Ensure it's the correct metadata document

            # Fetch the document using the filter
            doc = self.get(filter, checkCollection=False)

            # The collection should contain exactly one control document, otherwise it's corrupted
            if len(doc) != 1:
                raise Exception(f'Collection does not have control document, found {len(doc)}')

            # Extract and store the vector size and model name from the control document
            self.vectorSize = doc[0].metadata.vectorSize
            self.modelName = doc[0].metadata.modelName

            return True

        except Exception as e:
            raise Exception(f'Error checking collection: {str(e)}')

    def doesCollectionExist(self, modelName: str = None) -> bool:
        """
        Check if the collection exists and verifies its integrity.

        If a `modelName` is provided it is compared with the collection's stored model
        and the outcome is recorded in ``self.modelMismatch`` (reported by ``describe()``
        and the explorer tools as ``model_mismatch``). A mismatch never makes this
        return False: reads keep working as they always have.

        :param modelName: Optional name of the embedding model the caller's vectors were made with.
        :return: True if the collection exists, otherwise False.
        """
        # Acquire the lock to ensure thread-safe checking
        with self.collectionLock:
            exists = self._checkCollectionExists()
        if exists and modelName and self.modelName:
            self.modelMismatch = modelName != self.modelName
        return exists

    def createCollection(self, documents: List[Doc]):
        """
        Create a new collection if it does not already exist.

        Ensures all documents have the same embedding model and vector size.
        Stores a "bogus" metadata document for validation.

        :param documents: List of document objects to be added to the collection.
        :return: True if the collection was created successfully.
        """
        # Acquire the lock to ensure thread-safe collection creation
        with self.collectionLock:
            # Check if another process/thread has already created the collection
            if self._checkCollectionExists():
                # Collection already exists, validate documents against existing collection
                for doc in documents:
                    if not doc.embedding_model:
                        raise Exception('You must run your documents through an embedding filter')
                    if doc.embedding_model != self.modelName:
                        raise Exception(
                            f'The collection uses {self.modelName} but the document was encoded with {doc.embedding_model}'
                        )
                    if len(doc.embedding) != self.vectorSize:
                        raise Exception(
                            f'The collection uses a vector size of {self.vectorSize} but the document has {len(doc.embedding)} vector size'
                        )
                return True

            # If no documents are provided, exit early
            if not len(documents):
                return True

            # Use the first document as a reference for embedding model and vector size
            modelName = documents[0].embedding_model
            vectorSize = len(documents[0].embedding)

            # Validate that all documents have the same embedding model and vector size
            for doc in documents:
                if doc.embedding_model != modelName:
                    raise Exception('All documents must have the same embedding model')
                if len(doc.embedding) != vectorSize:
                    raise Exception('All documents must have the same vector size')

            # Store a reference document (first document in the list)
            refdoc = documents[0]

            # Create metadata for the "bogus" document
            metadata = DocMetadata(
                objectId=CONTROL_OBJECT_ID,  # Unique identifier for schema validation
                chunkId=0,  # The chunk id
                vectorSize=vectorSize,  # Store vector size for future validation
                modelName=modelName,  # Store embedding model name
                isDeleted=True,  # Marked as deleted to avoid retrieval in normal searches
            )

            # Create the "bogus" document with empty content and metadata
            doc = Doc(page_content='', metadata=metadata)

            # Assign the same embedding model but use a zeroed-out vector
            doc.embedding_model = refdoc.embedding_model
            doc.embedding = [0] * vectorSize  # List of zeros for validation purposes

            # Create the actual collection with the specified vector size
            created = self._createCollection(vectorSize)

            # Some drivers signal failure by returning False instead of raising;
            # honor that instead of silently indexing into a collection that was
            # never created (do not treat None as failure - a few drivers return
            # nothing on success).
            if created is False:
                raise Exception(f'{type(self).__name__} failed to create the vector collection')

            # Add the "bogus" document to the collection
            self.addChunks([doc], checkCollection=False)

            # Store the expected model name and vector size for validation
            self.vectorSize = vectorSize
            self.modelName = modelName

            # Validate all provided documents against the newly created collection metadata
            for doc in documents:
                if not doc.embedding_model:
                    raise Exception('You must run your documents through an embedding filter')
                if doc.embedding_model != modelName:
                    raise Exception(
                        f'The collection uses {modelName} but the document was encoded with {doc.embedding_model}'
                    )
                if len(doc.embedding) != vectorSize:
                    raise Exception(
                        f'The collection uses a vector size of {vectorSize} but the document has {len(doc.embedding)} vector size'
                    )

        # Collection successfully created and validated
        return True


def getStore(provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> DocumentStoreBase:
    """
    Examine the configuration and returns and initializes a store.
    """
    # Build up the module name - it will be in the store dir
    name = 'connectors.' + provider

    # Get the module
    module = importlib.import_module(name)

    # See if this has the proper interface
    if not hasattr(module, 'getStore'):
        raise Exception(f'Module {provider} is not a store provider')

    # Get the class
    cls = getattr(module, 'getStore')()

    # Create an instance of the class
    return cls(provider, connConfig, bag)


# ---------------------------------------------------------------------------
# Vector DB tool mixin
# ---------------------------------------------------------------------------
#
# Rod's review feedback on PR #524 suggested co-locating the tool definitions
# with the underlying store so every vectordb node can "morph into a tool"
# without a separate generic wrapper node. Because the engine dispatches
# ``invoke`` against the node's ``IInstance`` (not the ``DocumentStoreBase``
# subclass, which is composed via ``self.IGlobal.store``), the tool methods
# must live on a class that the ``IInstance`` subclasses. This mixin is that
# class: it lives next to ``DocumentStoreBase`` so the store interface stays
# together in a single file, and it delegates every call to
# ``self.IGlobal.store`` (which is a ``DocumentStoreBase`` instance).
#
# Any vectordb ``IInstance`` that subclasses ``VectorStoreToolMixin`` picks up
# the ``search``, ``upsert`` and ``delete`` tools automatically via
# ``IInstanceBase._collect_tool_methods`` (which walks the full MRO).


_VECTORDB_TOOL_MAX_TOP_K = 100
_VECTORDB_TOOL_DEFAULT_TOP_K = 10
_VECTORDB_TOOL_MAX_OBJDIR_LIMIT = 1000
_VECTORDB_TOOL_MAX_GET_LIMIT = 100
# `get` pages a document itself: whether a driver's `get` honours `offset` varies
# (Astra, Weaviate and Pinecone ignore it), so the tool fetches the document's
# chunks once, orders them by chunkId here and slices. This is also the most
# chunks one document can have and still be fully readable through the tool.
_VECTORDB_TOOL_GET_FETCH_LIMIT = 10_000
_VECTORDB_DEFAULT_SERVER_NAME = 'vectordb'
_OBJDIR_MAX_LIMIT = 1000
_OBJDIR_SCAN_MAX = 10000

#: What ``objdir`` answers in ``warning`` when its listing stopped before the page was full.
_OBJDIR_STOPPED = {
    'cap': 'objdir read its limit of {rows} rows before the page was full: the list is incomplete.',
    'budget': 'objdir ran out of its time budget before the page was full: the list is incomplete.',
    'stale': 'The store stopped handing out new documents before the page was full: the list may be incomplete.',
}


#: The normaliser every store tool's input goes through (kept under its historical name).
_normalize_vectordb_tool_input = normalize_tool_input


class VectorStoreToolMixin(VectorExplorerExtTools, VectorExplorerTools):
    """
    Expose vector DB search/upsert/delete and the document listing as agent tools.

    Any vectordb ``IInstance`` that inherits from this mixin is automatically
    discoverable through the ``tool.*`` control-plane protocol. The mixin
    delegates all storage operations to ``self.IGlobal.store`` (a
    :class:`DocumentStoreBase` implementation) so backend-specific code stays
    in the backend driver.

    To enable tool discovery, the node's ``services.json`` must also include
    ``"tool"`` in its ``classType`` list and ``"invoke"`` in its
    ``capabilities`` list.

    An agent node in the same pipeline addresses the tools by the store
    node's pipeline id (``<node id>.search``, ``<node id>.upsert`` and so on;
    see ``ai.common.agent``), so two vectordb nodes in one pipeline never
    collide, and an app calls them by the bare function name and the node id.
    ``serverName`` (``self.IGlobal.serverName``, configurable in
    ``services.json``) only labels the tools' messages, such as a refused
    write naming ``<serverName>.delete``; changing it does not change the
    addresses.

    Two optional ``IGlobal`` switches gate the surface (``StoreGlobalBase``
    resolves both from the node config). ``expose_tools`` decides whether the
    node offers any tool at all: a node that does not define it exposes them,
    a node whose store is shared or managed (``rocketride_vector`` reads and
    writes the team's tenant database) defaults it to off, because ``objdir``
    and ``get`` together return the whole table to any caller of the
    pipeline's tool path. ``allow_write`` then decides whether the write tools
    (``upsert``, ``delete``, ``soft_delete`` and ``restore``) are among them. While a
    switch is off the affected tools are left out of ``_collect_tool_methods``,
    so the engine neither lists nor dispatches them (an invoke fails as a tool
    the node has no handler for); :meth:`_vectordb_surface_refusal`, which the
    shared tool envelope (``vectordb_tool``) runs before every tool, is a second
    line of defence for direct calls and returns ``{"success": false, "error":
    ...}``. The SQL nodes keep raw execution behind an ``allow_execute`` switch
    in the same spirit (there, ``execute`` raises).

    Those two switches are the outer gate: whether a tool exists for this node
    at all, and so ``allow_write`` alone decides whether an agent may write. A
    write tool that exists still runs ``vx_write_gate.check_write`` first, the
    inner gate: who is calling (an agent, or a DAP caller through a Tools source
    with an account or task key) and, for DAP calls, the node's ``allow_writes``.
    """

    # --- Configuration knobs (override via IGlobal) ------------------------

    def _vectordb_default_top_k(self) -> int:
        glb = getattr(self, 'IGlobal', None)
        value = getattr(glb, 'default_top_k', None)
        try:
            value = int(value) if value is not None else _VECTORDB_TOOL_DEFAULT_TOP_K
        except (TypeError, ValueError):
            value = _VECTORDB_TOOL_DEFAULT_TOP_K
        return max(1, min(value, _VECTORDB_TOOL_MAX_TOP_K))

    def _vectordb_score_threshold(self) -> float:
        glb = getattr(self, 'IGlobal', None)
        value = getattr(glb, 'score_threshold', None)
        try:
            value = float(value) if value is not None else 0.0
        except (TypeError, ValueError):
            value = 0.0
        return max(0.0, min(value, 1.0))

    def _vectordb_store(self) -> 'DocumentStoreBase':
        store = getattr(getattr(self, 'IGlobal', None), 'store', None)
        if store is None:
            raise RuntimeError('vectordb tool: store not initialized')
        return store

    def _vectordb_server_name(self) -> str:
        """Return the label this node's tool messages carry (not the tools' address).

        Reads ``self.IGlobal.serverName`` (set from the node config). Falls
        back to the provider name (``self.IGlobal.glb.logicalType``) and
        finally to ``'vectordb'`` if neither is available. The returned value
        is stripped of leading/trailing whitespace and ``'.'`` characters to
        guarantee a clean ``<server>.<tool>`` in those messages.
        """
        glb = getattr(self, 'IGlobal', None)
        name = getattr(glb, 'serverName', None)
        if not name:
            # Fall back to the node's logical type (e.g. 'pinecone').
            inner = getattr(glb, 'glb', None)
            name = getattr(inner, 'logicalType', None)
        if not isinstance(name, str):
            name = _VECTORDB_DEFAULT_SERVER_NAME
        name = name.strip().strip('.')
        return name or _VECTORDB_DEFAULT_SERVER_NAME

    def _vectordb_allow_write(self) -> bool:
        """Whether the write tools (``upsert``, ``delete``, ``soft_delete``, ``restore``) may change the store.

        Reads ``self.IGlobal.allow_write``. A node that does not define the
        attribute allows writes, which keeps every existing store node as it
        was; a node that sets it (from its configuration) decides per node.
        A string value is parsed like a config switch, so ``'false'`` and
        ``'0'`` are off rather than truthy.
        """
        from ai.common.utils import parse_bool

        glb = getattr(self, 'IGlobal', None)
        return parse_bool(getattr(glb, 'allow_write', True), default=True)

    def _vectordb_write_refused(self, tool: str) -> Dict[str, Any]:
        """The failure object a write tool returns when writes are off for this node."""
        return {
            'success': False,
            'error': (
                f'{self._vectordb_server_name()}.{tool} is disabled for this node: writes through tools are '
                'off (set allow_write=true in the node configuration to enable)'
            ),
        }

    def _vectordb_expose_tools(self) -> bool:
        """Whether this node offers its tool functions at all.

        Reads ``self.IGlobal.expose_tools``. A node that does not define the
        attribute exposes its tools, which keeps every existing store node as
        it was; a node that sets it (from its configuration) decides per node.
        Parsed like ``allow_write``, so ``'false'`` and ``'0'`` are off.
        """
        from ai.common.utils import parse_bool

        glb = getattr(self, 'IGlobal', None)
        return parse_bool(getattr(glb, 'expose_tools', True), default=True)

    def _vectordb_tools_refused(self, tool: str) -> Dict[str, Any]:
        """The failure object any tool returns when the node does not expose its tools."""
        return {
            'success': False,
            'error': (
                f'{self._vectordb_server_name()}.{tool} is disabled for this node: tools are off '
                '(set expose_tools=true in the node configuration to enable)'
            ),
        }

    _VECTORDB_WRITE_TOOLS = frozenset(vx_write_gate.WRITE_TOOLS)

    def _vectordb_surface_refusal(self, tool: str) -> Optional[Dict[str, Any]]:
        """The outer gate for one call: None when this node offers ``tool``, else the failure object.

        Run by the shared tool envelope (``vectordb_tool``) before the tool reads its
        input, for every store tool: the tools switch first, then, for a write tool,
        the write switch.
        """
        if not self._vectordb_expose_tools():
            return self._vectordb_tools_refused(tool)
        if tool in self._VECTORDB_WRITE_TOOLS and not self._vectordb_allow_write():
            return self._vectordb_write_refused(tool)
        return None

    def _collect_tool_methods(self):
        """List the tools this node advertises: none unless it exposes tools, and no write tool unless it allows writes.

        ``tool.query`` discovery reads this map, so a tool left out of it is
        one a caller never sees (``tool_filesystem`` hides its tools behind
        its allow flags the same way). Calling a hidden tool by name is still
        refused, by the envelope's outer gate.
        """
        if not self._vectordb_expose_tools():
            return {}
        advertised = dict(super()._collect_tool_methods())
        if not self._vectordb_allow_write():
            for write_tool in self._VECTORDB_WRITE_TOOLS:
                advertised.pop(write_tool, None)
        return advertised

    def _vectordb_compute_embedding(self, query_text: str) -> Optional[List[float]]:
        """Attempt to compute a query embedding for semantic search.

        Tool invocations run in the control-plane ``invoke()`` path and do
        not pass through the data-lane embedding filters that normally
        populate ``QuestionText.embedding``. This hook gives nodes a chance
        to compute an embedding for the tool path. Override in a subclass or
        provide an ``embed_query`` callable on ``self.IGlobal`` (signature:
        ``embed_query(text: str) -> list[float]``).

        Returns ``None`` if no embedding provider is available; the caller
        will fall back to keyword search.
        """
        glb = getattr(self, 'IGlobal', None)
        embed_fn = getattr(glb, 'embed_query', None)
        if embed_fn is None or not callable(embed_fn):
            return None
        try:
            embedding = embed_fn(query_text)
        except Exception as exc:
            warning(f'vectordb tool: embed_query raised {type(exc).__name__}: {exc}')
            return None
        if not embedding:
            return None
        if not isinstance(embedding, (list, tuple)):
            warning(f'vectordb tool: embed_query returned unexpected type {type(embedding).__name__}')
            return None
        return list(embedding)

    # --- Tool methods ------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'The search query text. Will be matched against stored documents using semantic similarity.',
                },
                'top_k': {
                    'type': 'integer',
                    'description': 'Maximum number of results to return (default: 10).',
                    'default': _VECTORDB_TOOL_DEFAULT_TOP_K,
                },
                'filter': {
                    'type': 'object',
                    'description': 'Optional metadata filter. Only objectId, nodeId and parent are supported; unrecognized keys are rejected. Example: {"nodeId": "my-node", "parent": "/docs"}',
                    'properties': {
                        'objectId': {
                            'description': 'Match documents with this object ID. A string or an array of strings.',
                            'anyOf': [
                                {'type': 'string'},
                                {'type': 'array', 'items': {'type': 'string'}},
                            ],
                        },
                        'nodeId': {
                            'type': 'string',
                            'description': 'Match documents written by this node ID.',
                        },
                        'parent': {
                            'type': 'string',
                            'description': 'Match documents under this parent path.',
                        },
                    },
                    'additionalProperties': False,
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'results': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'content': {'type': 'string'},
                            'score': {'type': 'number'},
                            'metadata': {'type': 'object'},
                        },
                    },
                },
                'total': {'type': 'integer'},
                'success': {'type': 'boolean'},
                'error': {'type': 'string'},
            },
        },
        description=(
            'Search for documents in the vector database. Requires an embedding provider bound to this '
            'node (via IGlobal.embed_query) for semantic similarity search. Returns matching documents '
            'with their content, metadata, and scores. Returns {"success": false, "error": "..."} on '
            'failure (missing embedder, empty query, store error).'
        ),
    )
    @vectordb_tool
    def search(self, args):
        """Search for documents in the vector database.

        Legacy input (``query``, ``top_k``, ``filter`` with objectId/nodeId/parent) behaves
        as before and the answer gains ``success``, ``rank``, ``warnings`` and
        ``mode_used``. External callers may also pass ``vector`` (with
        ``embedding_model``), ``mode`` ('auto'|'semantic'|'keyword'), the filter keys
        ``objectIds``/``isTable``/``minChunkId``/``maxChunkId``, ``deleted``,
        ``include_below_floor`` and ``include_below_threshold``; results of a vector
        search add ``raw_score``, ``sim``, ``below_threshold`` and ``below_floor`` and
        come sorted by score.
        """
        store = self._vectordb_store()

        mode = args.get('mode', 'auto') or 'auto'
        if mode not in ('auto', 'semantic', 'keyword'):
            raise ToolRefusal('INVALID_INPUT', "mode must be 'auto', 'semantic' or 'keyword'.")
        vector = args.get('vector')
        query_text = str(args.get('query', '') or '').strip()
        if vector is None and not query_text:
            raise ToolRefusal('INVALID_INPUT', 'search requires a non-empty "query" string')

        default_top_k = self._vectordb_default_top_k()
        try:
            top_k = int(args.get('top_k', default_top_k))
        except (TypeError, ValueError):
            top_k = default_top_k
        top_k = max(1, min(top_k, _VECTORDB_TOOL_MAX_TOP_K))

        doc_filter = self._vectordb_search_filter(args)
        doc_filter.limit = top_k
        if args.get('include_below_floor') is True:
            doc_filter.minScore = float('-inf')
        include_below_threshold = args.get('include_below_threshold') is True

        warnings: List[str] = []
        question = QuestionText(text=query_text)
        explicit_vector: Optional[List[float]] = None
        if vector is not None:
            explicit_vector = self._vectordb_vector(vector)
            if not store._doesCollectionExist():
                raise ToolRefusal('COLLECTION_MISSING', 'The collection does not exist yet; add a document first.')
            try:
                store.doesCollectionExist()
            except Exception:
                pass
            if store.vectorSize and len(explicit_vector) != int(store.vectorSize):
                raise ToolRefusal(
                    'DIMENSION_MISMATCH',
                    f'The vector has {len(explicit_vector)} values; this collection stores {int(store.vectorSize)}.',
                )
            supplied_model = args.get('embedding_model')
            if (
                isinstance(supplied_model, str)
                and supplied_model
                and store.modelName
                and supplied_model != store.modelName
            ):
                warnings.append('model_mismatch')
            question.embedding = explicit_vector
            question.embedding_model = (
                supplied_model if isinstance(supplied_model, str) and supplied_model else None
            ) or (store.modelName or None)
        elif mode != 'keyword':
            # Require an embedding provider for semantic search. The control-plane
            # invoke() path does not flow through the data-lane embedding filters,
            # so nodes must bind IGlobal.embed_query at startup.
            embedding = self._vectordb_compute_embedding(query_text)
            if embedding is None:
                raise ToolRefusal(
                    'NO_EMBEDDER',
                    f'no embedding provider bound to IGlobal.embed_query; configure an embedding sub-block for the {self._vectordb_server_name()} node to enable semantic search',
                )
            question.embedding = embedding
            embed_model = getattr(getattr(self, 'IGlobal', None), 'embed_model_name', None)
            if isinstance(embed_model, str) and embed_model:
                question.embedding_model = embed_model

        if mode == 'keyword':
            docs: List[Doc] = store.searchKeyword(question, doc_filter)
            mode_used = 'keyword'
        else:
            try:
                docs = store.searchSemantic(question, doc_filter)
                mode_used = 'semantic'
            except Exception as exc:
                if mode == 'semantic':
                    raise
                warning(
                    f'vectordb tool: semantic search failed ({safe_error(exc)}); falling back to keyword search. Check that the store is initialized and the embedding model matches the collection.'
                )
                warnings.extend(['keyword_fallback', f'semantic search failed: {safe_error(exc)}'])
                docs = store.searchKeyword(question, doc_filter)
                mode_used = 'keyword'

        docs = [doc for doc in docs if metadataValue(doc, 'objectId') != CONTROL_OBJECT_ID]
        if explicit_vector is not None:
            docs.sort(key=lambda doc: -(doc.score if isinstance(doc.score, (int, float)) else float('-inf')))

        sims: Dict[Any, float] = {}
        if explicit_vector is not None and docs:
            sims = self._vectordb_result_sims(store, explicit_vector, docs)
        score_threshold = self._vectordb_score_threshold()
        floor = store.effectiveFloor(DocFilter()) if explicit_vector is not None else None
        node_threshold = getattr(store, 'threshold_search', None)
        results: List[Dict[str, Any]] = []
        for doc in docs:
            score = getattr(doc, 'score', 0.0) or 0.0
            if not include_below_threshold and score_threshold > 0 and score < score_threshold:
                continue
            meta: Dict[str, Any] = {}
            if doc.metadata:
                meta = {
                    'objectId': doc.metadata.objectId,
                    'nodeId': doc.metadata.nodeId,
                    'parent': doc.metadata.parent,
                    'chunkId': doc.metadata.chunkId,
                }
            item: Dict[str, Any] = {'content': doc.page_content or '', 'score': score, 'metadata': meta}
            if explicit_vector is not None:
                item['raw_score'] = score
                item['sim'] = sims.get(_vxDocKey(doc), score)
                item['below_threshold'] = isinstance(node_threshold, (int, float)) and score < node_threshold
                item['below_floor'] = score < floor
            results.append(item)

        trimmed = results[:top_k]
        for rank, item in enumerate(trimmed, start=1):
            item['rank'] = rank
        return {
            'success': True,
            'results': trimmed,
            'total': len(trimmed),
            'warnings': warnings,
            'mode_used': mode_used,
        }

    def _vectordb_search_filter(self, args: Dict[str, Any]) -> DocFilter:
        """Build the search filter from the legacy keys plus the explorer's extensions."""
        raw_filter = args.get('filter') or {}
        if not isinstance(raw_filter, dict):
            raw_filter = {}
        # Without ``deleted`` the filter is the legacy one, so agents' results do not change.
        if args.get('deleted') is None:
            doc_filter = DocFilter()
        else:
            deleted = args['deleted']
            if deleted not in ('active', 'deleted', 'all'):
                raise ToolRefusal('INVALID_INPUT', "deleted must be 'active', 'deleted' or 'all'.")
            doc_filter = deletedFilter(deleted)
        object_ids: List[str] = []
        object_id = raw_filter.get('objectId')
        if object_id:
            object_ids.extend([object_id] if isinstance(object_id, str) else list(object_id))
        extra_ids = raw_filter.get('objectIds')
        if extra_ids is not None:
            # The explorer's scope (contract section 4.4-B), checked like filter.object_ids of sample
            # and neighbors: a list of 1 to scope_keys_max non-empty strings (one string is one id).
            # A list over the cap is refused by its length before its items are looked at. The
            # legacy objectId key is neither capped nor checked, so agents' calls do not change.
            cap = VECTOR_TOOL_LIMITS['scope_keys_max']
            if isinstance(extra_ids, (list, tuple)) and len(extra_ids) > cap:
                raise ToolRefusal(
                    'LIMIT_EXCEEDED',
                    f'filter.objectIds names {len(extra_ids):,} documents; a search takes at most {cap:,}. '
                    'Narrow the scope.',
                )
            if isinstance(extra_ids, str):
                extra_ids = [extra_ids]
            object_ids.extend(_strings_arg(extra_ids, 'filter.objectIds', cap))
        if object_ids:
            doc_filter.objectIds = list(dict.fromkeys(str(oid) for oid in object_ids))
        node_id = raw_filter.get('nodeId')
        if node_id:
            doc_filter.nodeId = node_id
        parent = raw_filter.get('parent')
        if parent:
            doc_filter.parent = parent
        if isinstance(raw_filter.get('isTable'), bool):
            doc_filter.isTable = raw_filter['isTable']
        for key in ('minChunkId', 'maxChunkId'):
            value = raw_filter.get(key)
            if value is not None:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise ToolRefusal('INVALID_INPUT', f'filter.{key} must be an integer.')
                setattr(doc_filter, key, value)
        return doc_filter

    @staticmethod
    def _vectordb_vector(value: Any) -> List[float]:
        """Validate a caller-supplied vector."""
        import math

        if not isinstance(value, (list, tuple)) or not value:
            raise ToolRefusal('INVALID_INPUT', 'vector must be a non-empty list of numbers.')
        out: List[float] = []
        for item in value:
            if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
                raise ToolRefusal('INVALID_INPUT', 'vector must be a non-empty list of finite numbers.')
            out.append(float(item))
        return out

    def _vectordb_result_sims(
        self, store: 'DocumentStoreBase', vector: List[float], docs: List[Doc]
    ) -> Dict[Any, float]:
        """Similarity of each result to ``vector``, recomputed from the stored vectors where the store returns them."""
        from .vx_math import normalize_metric, similarity

        keys = [key for key in (_vxDocKey(doc) for doc in docs) if key is not None]
        try:
            stored = {key: doc.embedding for key, doc in read_vectors(store, keys).items()}
        except Exception:
            return {}
        metric = normalize_metric(getattr(store, 'similarity', None)) or 'cosine'
        out: Dict[Any, float] = {}
        for key, embedding in stored.items():
            if key is not None and len(embedding) == len(vector):
                out[key] = round(float(similarity(metric, [vector], [embedding])[0, 0]), 5)
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documents'],
            'properties': {
                'documents': {
                    'type': 'array',
                    'description': 'Array of documents to upsert.',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'content': {
                                'type': 'string',
                                'description': 'The text content of the document.',
                            },
                            'object_id': {
                                'type': 'string',
                                'description': 'Unique identifier for the document. Used for deduplication.',
                            },
                            'metadata': {
                                'type': 'object',
                                'description': 'Optional metadata. Only nodeId, parent and chunkId are stored; unrecognized keys are rejected.',
                                'properties': {
                                    'nodeId': {
                                        'type': 'string',
                                        'description': 'Writing node ID recorded on the document (default: "vectordb_tool").',
                                    },
                                    'parent': {
                                        'type': 'string',
                                        'description': 'Parent path recorded on the document (default: "/").',
                                    },
                                    'chunkId': {
                                        'type': 'integer',
                                        'minimum': 0,
                                        'description': (
                                            'Chunk index recorded on the document. Without it, the chunks sent for one '
                                            'object ID are numbered 0, 1, 2 ... in the order given; an explicit index '
                                            'may not repeat within one call.'
                                        ),
                                    },
                                },
                                'additionalProperties': False,
                            },
                            'embedding': {
                                'type': 'array',
                                'items': {'type': 'number'},
                                'description': 'Pre-computed embedding vector. If provided together with embedding_model, skips automatic embedding computation.',
                            },
                            'embedding_model': {
                                'type': 'string',
                                'description': 'Name of the model used to compute the supplied embedding vector.',
                            },
                        },
                        'required': ['content', 'object_id'],
                    },
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'count': {'type': 'integer'},
                'skipped': {'type': 'integer'},
            },
        },
        description=(
            'Add or update documents in the vector database. Each document requires content text and an '
            'object ID for deduplication. Embeddings are computed automatically when an embedding provider '
            'is bound to this node (via IGlobal.embed_query). Alternatively, supply pre-computed '
            '"embedding" (float array) and "embedding_model" (string) per document to skip auto-computation. '
            "Several documents with one object ID are stored as that document's chunks. "
            'Returns {"success": false, "error": "..."} when embeddings cannot be obtained.'
        ),
    )
    @vectordb_tool
    def upsert(self, args):
        """Add or update documents in the vector database (gated; see ``vx_write_gate``)."""
        store = self._vectordb_store()

        # The gate runs first (on the documents as sent), then the input is checked.
        raw_docs = args.get('documents', [])
        candidates = [raw for raw in raw_docs if isinstance(raw, dict)] if isinstance(raw_docs, list) else []
        decision = vx_write_gate.check_write(
            'upsert',
            object_ids=[str(raw.get('object_id', '')).strip() for raw in candidates],
            allow_writes=self._vx_allow_writes(),
            supplies_embedding=any(
                raw.get('embedding') is not None or raw.get('embedding_model') for raw in candidates
            ),
        )
        if not isinstance(raw_docs, list) or not raw_docs:
            raise ToolRefusal('INVALID_INPUT', 'upsert requires a non-empty "documents" array')

        embed_model_name = getattr(getattr(self, 'IGlobal', None), 'embed_model_name', None)

        from ai.common.utils import optional_int

        # First pass: validate, and settle each document's chunk number. An
        # explicit chunkId is kept and may not repeat within the call for one
        # object ID; a document without one takes the lowest number that object
        # ID has not used, so several chunks sent for one object without numbers
        # are stored as chunks 0, 1, 2 ... in the order given, not all as chunk 0
        # (which the drivers accept and get then returns in no defined order).
        entries: List[Tuple[dict, str, str, dict, Optional[int]]] = []
        explicit: Dict[str, set] = {}
        skipped = 0
        for raw in raw_docs:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            content = str(raw.get('content', '')).strip()
            object_id = str(raw.get('object_id', '')).strip()
            if not content or not object_id:
                skipped += 1
                continue
            if object_id == CONTROL_OBJECT_ID:
                return {
                    'success': False,
                    'error': f"upsert: object_id '{object_id}' is reserved for the store's control row",
                }

            extra_meta = raw.get('metadata') or {}
            if not isinstance(extra_meta, dict):
                return {'success': False, 'error': f"upsert: metadata must be an object (document '{object_id}')"}
            try:
                chunk_id = optional_int(extra_meta, 'chunkId', default=None, lo=0, tool_name='upsert')
            except ValueError as exc:
                return {'success': False, 'error': f"{exc} (document '{object_id}')"}
            if chunk_id is not None:
                if chunk_id in explicit.setdefault(object_id, set()):
                    return {
                        'success': False,
                        'error': f"upsert: document '{object_id}' lists chunkId {chunk_id} more than once",
                    }
                explicit[object_id].add(chunk_id)
            entries.append((raw, content, object_id, extra_meta, chunk_id))

        next_free: Dict[str, int] = {}
        docs: List[Doc] = []
        for raw, content, object_id, extra_meta, chunk_id in entries:
            if chunk_id is None:
                chunk_id = next_free.get(object_id, 0)
                while chunk_id in explicit.get(object_id, ()):
                    chunk_id += 1
                next_free[object_id] = chunk_id + 1
            metadata = DocMetadata(
                objectId=object_id,
                nodeId=extra_meta.get('nodeId', 'vectordb_tool'),
                parent=extra_meta.get('parent', '/'),
                chunkId=chunk_id,
                isDeleted=False,
            )
            doc = Doc(
                page_content=content,
                metadata=metadata,
            )

            supplied_embedding = raw.get('embedding')
            supplied_model = raw.get('embedding_model')
            if supplied_embedding and supplied_model:
                doc.embedding = list(supplied_embedding)
                doc.embedding_model = str(supplied_model)
            else:
                computed = self._vectordb_compute_embedding(content)
                if computed is None:
                    raise ToolRefusal(
                        'NO_EMBEDDER',
                        f'no embedding provider bound to IGlobal.embed_query; configure an embedding sub-block for the {self._vectordb_server_name()} node or supply pre-computed "embedding" and "embedding_model" per document',
                    )
                doc.embedding = computed
                doc.embedding_model = embed_model_name or ''

            docs.append(doc)

        if not docs:
            raise ToolRefusal('INVALID_INPUT', 'upsert: no valid documents provided')

        self._vectordb_check_collection_fit(store, docs)
        store.addChunks(docs)
        object_ids = list(dict.fromkeys(doc.metadata.objectId for doc in docs))
        self._vx_forget_counts(store)
        self._vx_log_write('vector.upsert', object_ids, len(docs), decision.origin)
        return {
            'success': True,
            'count': len(docs),
            'skipped': skipped,
            'audit': self._vx_audit('vector.upsert', store, object_ids, len(docs), decision),
        }

    @staticmethod
    def _vectordb_check_collection_fit(store: 'DocumentStoreBase', docs: List[Doc]) -> None:
        """Refuse documents embedded with another model or dimension than an existing collection's.

        ``MODEL_MISMATCH`` / ``DIMENSION_MISMATCH`` before anything is written (the store's own
        check would raise a plain exception after the call reached it). A collection that does
        not exist yet, or whose control record cannot be read, is left to ``addChunks``.
        """
        try:
            exists = bool(store._doesCollectionExist()) and bool(store.doesCollectionExist())
        except Exception:  # the store decides in addChunks, as before
            return
        if not exists:
            return
        for doc in docs:
            model = doc.embedding_model
            if store.modelName and isinstance(model, str) and model and model != store.modelName:
                raise ToolRefusal(
                    'MODEL_MISMATCH',
                    f"This collection was embedded with '{store.modelName}' and these documents with "
                    f"'{model}'; documents embedded with different models cannot be stored together.",
                )
            if store.vectorSize and hasVector(doc) and len(doc.embedding) != int(store.vectorSize):
                raise ToolRefusal(
                    'DIMENSION_MISMATCH',
                    f'The vectors have {len(doc.embedding)} values; this collection stores {int(store.vectorSize)}.',
                )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_ids'],
            'properties': {
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'List of object IDs to delete.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'deleted_count': {
                    'type': 'integer',
                    'description': 'The distinct object IDs the request named, not the documents found.',
                },
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'The distinct object IDs the request named, in the order given.',
                },
            },
        },
        description='Delete documents from the vector database by their object IDs.',
    )
    @vectordb_tool
    def delete(self, args):
        """Delete documents from the vector database by object IDs (gated; see ``vx_write_gate``).

        The only permanent delete. With ``deleted_only`` (the Vector Explorer's "Empty
        trash") a document is removed only when every chunk of it is in the trash; one
        that still has a live chunk (a later ingest batch added it) is left whole and named
        in ``kept_live``.
        """
        store = self._vectordb_store()

        # The gate runs first (on the ids as sent), then the input is checked.
        object_ids = args.get('object_ids', [])
        clean_ids = [str(oid).strip() for oid in object_ids if str(oid).strip()] if isinstance(object_ids, list) else []
        decision = vx_write_gate.check_write(
            'delete',
            object_ids=clean_ids,
            allow_writes=self._vx_allow_writes(),
        )
        if not isinstance(object_ids, list) or not object_ids:
            raise ToolRefusal('INVALID_INPUT', 'delete requires a non-empty "object_ids" array')
        if not clean_ids:
            raise ToolRefusal('INVALID_INPUT', 'delete: no valid object IDs provided')
        if decision.origin != 'agent' and len(clean_ids) > VECTOR_TOOL_LIMITS['write_ids_max']:
            raise ToolRefusal(
                'INVALID_INPUT', f'object_ids must be a list of 1 to {VECTOR_TOOL_LIMITS["write_ids_max"]} strings.'
            )
        deleted_only = args.get('deleted_only', False)
        if deleted_only is None:
            deleted_only = False
        if not isinstance(deleted_only, bool):
            raise ToolRefusal('INVALID_INPUT', 'deleted_only must be true or false.')
        if deleted_only and decision.origin == 'agent' and len(clean_ids) > AGENT_WRITE_IDS_MAX:
            # Each id may cost a live check; an agent's plain delete keeps develop's open list.
            raise ToolRefusal('INVALID_INPUT', f'object_ids must be a list of 1 to {AGENT_WRITE_IDS_MAX} strings.')
        unique_ids = list(dict.fromkeys(clean_ids))
        kept_live = self._vx_with_live_chunk(store, unique_ids) if deleted_only else []
        targets = [oid for oid in unique_ids if oid not in kept_live]
        not_found: List[str] = []
        rows: Optional[int] = 0
        if targets:
            _removed, not_found, rows = self._vx_remove(store, targets)
        # The audit names every id the call named, as without deleted_only (kept_live and
        # not_found say which of them were left alone); rows is what went.
        self._vx_log_write('vector.delete', unique_ids, rows, decision.origin)
        return {
            'success': True,
            'deleted_count': len(unique_ids),
            'object_ids': unique_ids,
            'removed_chunks': rows,
            'not_found': not_found,
            'kept_live': kept_live,
            'audit': self._vx_audit('vector.delete', store, unique_ids, rows, decision),
        }

    # --- The trash and the document listing (#2704's names, the explorer's shapes) --------------
    #
    # Defined here, on the class #2704 edits, not on a mixin: a merge of #2704 then meets
    # them as a textual conflict or a duplicate method of this one class, never as a method
    # of another class in the MRO that this one would silently shadow
    # (nodes/test/test_vector_tool_set.py holds every tool to one owner).

    @tool_function(
        input_schema=VectorExplorerTools.LIST_DOCUMENTS_INPUT,
        output_schema=VectorExplorerTools.LIST_DOCUMENTS_OUTPUT,
        description=(
            'List the documents in this vector database one by one (equal paths are not collapsed), each with '
            'its path and chunk count, in pages ordered by path. Follow next_cursor for the next page. '
            "deleted='deleted' (or true) lists the trash; parent keeps one exact path."
        ),
    )
    @vectordb_tool
    def list_documents(self, args):
        """One page of the document directory (see ``VectorExplorerTools._vx_list_documents``)."""
        return self._vx_list_documents(args)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_ids'],
            'properties': {
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Object IDs of the documents to move to the trash.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'The distinct object IDs the request named, in the order given.',
                },
                'matched_chunks': {
                    'type': ['integer', 'null'],
                    'description': (
                        'Chunk rows the store holds for those IDs in either state (0 when none of them exists), '
                        'or null when the store does not report a count.'
                    ),
                },
                'moved_chunks': {
                    'type': ['integer', 'null'],
                    'description': (
                        'Chunks the call moved to the trash (0 for documents already there), or null when the '
                        'store does not count.'
                    ),
                },
                'not_found': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Object IDs with nothing stored.',
                },
                'audit': {'type': 'object'},
            },
        },
        description=(
            'Move documents to the trash by object ID: their chunks stay stored but leave search, objdir, get '
            'and the active listing until restore. delete removes them for good instead.'
        ),
    )
    @vectordb_tool
    def soft_delete(self, args):
        """Move documents to the trash (gated; see ``VectorExplorerTools._vx_trash_write``)."""
        return self._vx_trash_write('soft_delete', args, deleted=True)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_ids'],
            'properties': {
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Object IDs of the documents to take out of the trash.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'The distinct object IDs the request named, in the order given.',
                },
                'matched_chunks': {
                    'type': ['integer', 'null'],
                    'description': (
                        'Chunk rows the store holds for those IDs in either state (0 when none of them exists), '
                        'or null when the store does not report a count.'
                    ),
                },
                'moved_chunks': {
                    'type': ['integer', 'null'],
                    'description': (
                        'Chunks the call took out of the trash (0 for documents not in it), or null when the '
                        'store does not count.'
                    ),
                },
                'not_found': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Object IDs with nothing stored.',
                },
                'audit': {'type': 'object'},
            },
        },
        description=(
            'Take documents out of the trash by object ID, so their chunks are searchable and readable again. '
            'A document not in the trash is left as it is; one removed with delete cannot be restored.'
        ),
    )
    @vectordb_tool
    def restore(self, args):
        """Take documents out of the trash (gated; see ``VectorExplorerTools._vx_trash_write``)."""
        return self._vx_trash_write('restore', args, deleted=False)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'parent': {
                    'type': 'string',
                    'description': (
                        'Optional parent path; lists documents stored under exactly this parent '
                        '(Atlas matches it as a case-insensitive pattern, Qdrant as a text match).'
                    ),
                },
                'offset': {
                    'type': 'integer',
                    'minimum': 0,
                    'description': 'Number of results to skip (default 0).',
                },
                'limit': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': 'Maximum number of results to return (default and cap 1000).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'paths': {
                    'type': 'object',
                    'description': 'Map of unique parent paths to their object IDs.',
                },
                'success': {'type': 'boolean'},
            },
        },
        description='List unique document paths stored in this vector database.',
    )
    @vectordb_tool
    def objdir(self, args):
        """List unique document paths in this vector store.

        ``paths`` maps each path to an objectId as before; the control record is never
        listed. ``parent``, when given, is an exact path (as develop's drivers read it),
        never a prefix. ``offset`` must be 0 or more and ``limit`` 1 or more (at most
        1000 are returned). On a driver with a native document
        listing (``listDocumentPage``), ``entries`` lists every document (path and objectId,
        equal paths not collapsed) and deleted documents are left out. On any other
        driver the answer is the driver's own ``getPaths`` page, as before: the default
        listing pages by offset, which several backends ignore or read as a point id.

        ``truncated`` is True when the listing stopped before the page was full and before
        the store ran out of documents (the scan cap, the time budget, or a store that
        stopped paging); ``warning`` then says why, because the list is incomplete.
        """
        store = self._vectordb_store()

        parent = args.get('parent', None)
        if parent is not None and not isinstance(parent, str):
            raise ToolRefusal('INVALID_INPUT', 'objdir: parent must be a string')
        from ai.common.utils import optional_int

        try:
            offset = optional_int(args, 'offset', default=0, lo=0, tool_name='objdir')
            limit = optional_int(args, 'limit', default=_OBJDIR_MAX_LIMIT, lo=1, tool_name='objdir')
        except ValueError as exc:
            raise ToolRefusal('INVALID_INPUT', str(exc)) from None
        limit = min(limit, _OBJDIR_MAX_LIMIT)

        entries: Optional[List[Dict[str, str]]] = None
        stopped: Optional[str] = None
        if 'listDocumentPage' in store.capabilities():
            try:
                entries, stopped = self._vectordb_objdir_listing(store, parent, offset, limit)
            except StoreUnsupported:
                entries, stopped = None, None
        if entries is None:
            legacy = store.getPaths(parent=parent, offset=offset, limit=limit) or {}
            entries = [
                {'path': str(path), 'objectId': str(oid)}
                for path, oid in legacy.items()
                if oid != CONTROL_OBJECT_ID and path not in (None, 'None', 'null')
            ]

        paths: Dict[str, str] = {}
        for entry in entries:
            paths.setdefault(entry['path'], entry['objectId'])
        answer: Dict[str, Any] = {'success': True, 'paths': paths, 'entries': entries, 'truncated': stopped is not None}
        if stopped is not None:
            answer['warning'] = _OBJDIR_STOPPED[stopped].format(rows=_OBJDIR_SCAN_MAX)
            warning(f'vectordb tool: objdir on {self._vectordb_server_name()}: {answer["warning"]}')
        return answer

    @staticmethod
    def _vectordb_objdir_listing(
        store: 'DocumentStoreBase', parent: Optional[str], offset: int, limit: int
    ) -> Tuple[List[Dict[str, str]], Optional[str]]:
        """``objdir`` entries from a native ``listDocumentPage``: active documents at ``parent``, paged.

        Each document is listed once. Paging ends after ``_OBJDIR_SCAN_MAX`` rows or as
        :class:`ListingGuard` decides (empty or repeated pages, a listing that cannot
        page, the time budget), so a driver whose cursor never ends cannot hang the tool.

        Returns the entries and why the listing stopped short of a full page while the
        store may hold more (a key of ``_OBJDIR_STOPPED``), or None when the page is full
        or the listing ended.
        """
        entries: List[Dict[str, str]] = []
        seen: set = set()
        skipped = 0
        scanned = 0
        stopped: Optional[str] = None
        page_size = VECTOR_TOOL_LIMITS['documents_page']
        guard = ListingGuard(_OBJDIR_SCAN_MAX, page_size, VECTOR_TOOL_LIMITS['sample_budget_ms'] / 1000.0)
        cursor: Optional[str] = None
        while len(entries) < limit:
            page = store.listDocumentPage(
                cursor=cursor,
                limit=page_size,
                object_ids=None,
                deleted='active',
                sort='path',
            )
            new_documents = 0
            for row in page.items:
                if row.objectId == CONTROL_OBJECT_ID or row.objectId in seen:
                    continue
                seen.add(row.objectId)
                new_documents += 1
                if row.deleted:
                    continue
                if parent is not None and row.path != parent:
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                if len(entries) < limit:
                    entries.append({'path': row.path, 'objectId': row.objectId})
            scanned += len(page.items)
            if guard.stop(page, new_documents) or scanned >= _OBJDIR_SCAN_MAX:
                if guard.reason != 'complete' and len(entries) < limit:
                    stopped = guard.reason if guard.reason in ('budget', 'stale') else 'cap'
                break
            cursor = page.next_cursor
        return entries, stopped

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_id'],
            'properties': {
                'object_id': {
                    'type': 'string',
                    'description': 'The objectId of the document to retrieve.',
                },
                'offset': {
                    'type': 'integer',
                    'minimum': 0,
                    'description': 'Number of chunks to skip (default 0); pages are ordered by chunk ID on every store.',
                },
                'limit': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': 'Maximum number of chunks to return (default and cap 100).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'chunks': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'content': {'type': 'string'},
                            'chunkId': {'type': 'integer'},
                            'metadata': {'type': 'object'},
                        },
                    },
                },
                'total': {'type': 'integer', 'description': 'Chunks the document has (up to 10000).'},
                'offset': {'type': 'integer'},
                'has_more': {'type': 'boolean', 'description': 'Whether a page follows this one.'},
                'truncated': {
                    'type': 'boolean',
                    'description': 'True when the document hit the 10000-chunk read ceiling: total and the last page may be incomplete.',
                },
                'success': {'type': 'boolean'},
            },
        },
        description=(
            'Retrieve document chunks by objectId from the vector database, in pages of up to 100 '
            "ordered by chunk ID; `total` is the document's chunk count and `has_more` says whether "
            'another page follows. A document is read up to 10000 chunks; `truncated` is true when that '
            'ceiling was hit. An unknown object ID, or one in the trash, returns {"success": false, "error": "..."}.'
        ),
    )
    @vectordb_tool
    def get(self, args):
        """Retrieve document chunks by objectId, in pages ordered by chunk ID.

        offset counts chunks after that sort, total is the document's chunk count
        and has_more says whether another page follows. The driver is asked for the
        whole document (up to _VECTORDB_TOOL_GET_FETCH_LIMIT chunks; truncated says
        when that ceiling was hit) and the page is cut here, so offset means the same
        on every backend. The Vector Explorer pages a document by chunk id through the
        chunks tool instead.
        """
        store = self._vectordb_store()

        object_id = str(args.get('object_id') or '').strip()
        if not object_id:
            raise ToolRefusal('INVALID_INPUT', 'object_id is required')
        if object_id == CONTROL_OBJECT_ID:
            raise ToolRefusal(
                'RESERVED_ID',
                f"get: object_id '{object_id}' is reserved for the store's control row",
                {'object_id': object_id},
            )

        from ai.common.utils import optional_int

        try:
            offset = optional_int(args, 'offset', default=0, lo=0, tool_name='get')
            limit = optional_int(args, 'limit', default=_VECTORDB_TOOL_MAX_GET_LIMIT, lo=1, tool_name='get')
        except ValueError as exc:
            raise ToolRefusal('INVALID_INPUT', str(exc)) from None

        limit = min(limit, _VECTORDB_TOOL_MAX_GET_LIMIT)
        # The driver is asked for the whole document (see _VECTORDB_TOOL_GET_FETCH_LIMIT);
        # the page is cut here, so `offset` means the same on every backend.
        doc_filter = DocFilter(
            objectIds=[object_id],
            offset=0,
            limit=_VECTORDB_TOOL_GET_FETCH_LIMIT,
            isDeleted=False,
        )
        docs = store.get(doc_filter)
        if not docs:
            # Not a page past the end: nothing is readable under this id. A document in the trash
            # (no live chunk, so every chunk is there) is told apart from an unknown one, since
            # restore makes the first readable again.
            if self._vx_in_trash(store, object_id):
                if self._vectordb_allow_write():
                    message = f"get: document '{object_id}' is soft-deleted; restore it to read it"
                else:
                    # restore is a write tool: do not point to a tool this node does not offer.
                    message = (
                        f"get: document '{object_id}' is soft-deleted; this node does not offer restore "
                        'while writes through tools are off'
                    )
                raise ToolRefusal('IN_TRASH', message, {'object_id': object_id})
            raise ToolRefusal('NOT_FOUND', f"get: no document with object_id '{object_id}'", {'object_id': object_id})

        chunks = [
            {
                'content': doc.page_content,
                'chunkId': getattr(doc.metadata, 'chunkId', None)
                if hasattr(doc.metadata, 'chunkId')
                else doc.metadata.get('chunkId', 0)
                if isinstance(doc.metadata, dict)
                else 0,
                'metadata': doc.metadata
                if isinstance(doc.metadata, dict)
                else dict(vars(doc.metadata))
                if hasattr(doc.metadata, '__dict__')
                else {},
            }
            for doc in docs
        ]

        # Deterministic page order on every store: by chunkId, then by content and
        # metadata, so repeated chunk IDs returned in a different order on the next
        # call cannot shift a page boundary and drop or repeat a chunk.
        def _page_key(chunk):
            return (
                int(chunk.get('chunkId') or 0),
                str(chunk.get('content') or ''),
                json.dumps(chunk.get('metadata') or {}, sort_keys=True, default=str),
            )

        chunks.sort(key=_page_key)
        total = len(chunks)
        page = chunks[offset : offset + limit]

        return {
            'success': True,
            'chunks': page,
            'total': total,
            'offset': offset,
            'has_more': offset + limit < total,
            # The read ceiling was reached: the document may have more than `total` chunks.
            'truncated': len(docs) >= _VECTORDB_TOOL_GET_FETCH_LIMIT,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {},
        },
        output_schema={
            'type': 'object',
            'properties': {
                'count': {
                    'type': 'integer',
                    'description': 'Rows (chunks) in the collection, as the store counts them.',
                },
                'document_count': {
                    'type': ['integer', 'null'],
                    'description': 'Active documents, or null on a store that does not list documents.',
                },
                'model': {'type': 'string', 'description': 'Embedding model name.'},
                'vector_size': {'type': 'integer', 'description': 'Embedding vector dimension.'},
                'success': {'type': 'boolean'},
            },
        },
        description=(
            'Return statistics about this vector store collection: the row count, the number of active '
            'documents where the store can tell, the embedding model and the vector size.'
        ),
    )
    @vectordb_tool
    def stats(self, args):
        """Return collection statistics for this vector store.

        ``count``, ``model`` and ``vector_size`` keep their meaning (``count`` is every
        stored row, the control record included); ``model`` and ``vector_size`` come
        from the control record. The answer adds documents, chunks, deleted chunks,
        tables, documents without a first chunk and the average chunks per document
        (None where the store cannot count). ``{"mode": "quick"}`` returns the raw count
        with the cached figures (``counts_as_of``), recounting only when nothing is cached,
        the figures are older than ``counts_cached_s`` or the store was written since. A
        missing collection answers ``count: 0`` with ``collection_exists: false``.
        """
        store = self._vectordb_store()
        mode = args.get('mode', 'full') or 'full'
        if mode not in ('full', 'quick'):
            raise ToolRefusal('INVALID_INPUT', "mode must be 'full' or 'quick'.")
        answer = self._vx_stats(store, mode)
        # #2704's name for the active documents figure, kept so its callers read the same answer.
        answer['document_count'] = answer.get('documents')
        return answer
