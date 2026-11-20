# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Value types of the vector store explorer hooks (frozen interface).

These are what the optional ``DocumentStoreBase`` hooks return (``describe``,
``listDocumentPage``, ``scrollChunks``, ``knnGraph``) and the string vocabularies the
tools answer with (codes, capabilities, caveats). The tools turn them into JSON;
nothing here is sent over the wire as-is.

This module imports nothing at run time beyond the standard library, so drivers
and tests can import it cheaply. ``Doc`` and ``numpy`` appear in annotations only.

See ``docs/development/nodes/vector-tool-contract.md`` sections 2 and 4 (the
additive extensions, such as :class:`DocListFilter`, in section 4.4).
"""

import re
from dataclasses import dataclass, fields
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Literal, Mapping, Optional, Tuple

if TYPE_CHECKING:  # annotations only; no run-time dependency on numpy or the schema package
    import numpy as np

    from ..schema import Doc

# -----------------------------------------------------------------------------
# Keys and filters
# -----------------------------------------------------------------------------

#: Which rows a listing or read covers. ``'active'`` excludes soft-deleted rows.
Deleted = Literal['active', 'deleted', 'all']

#: The values of :data:`Deleted`, in documentation order.
DELETED_VALUES: Tuple[str, ...] = ('active', 'deleted', 'all')

#: The logical key of a chunk: ``(objectId, chunkId)``.
Key = Tuple[str, int]

#: objectId of the collection's control record. Never listed; refused on every external write path.
CONTROL_OBJECT_ID = 'schema'

# -----------------------------------------------------------------------------
# Hook return types
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class StoreInfo:
    """What ``DocumentStoreBase.describe()`` reports about the store.

    Never carries a host, port, DSN, credential or database name.
    """

    #: 'pgvector' | 'qdrant' | 'chroma' | 'milvus' | 'weaviate' | 'pinecone' | 'astra' | 'atlas'
    backend: str
    backend_version: Optional[str]
    #: Collection or table name, never the database name; None when absent.
    collection: Optional[str]
    collection_exists: bool
    #: Whether the control record is present; None when the collection does not exist.
    control_record: Optional[bool]
    #: pgvector only: False while the ``meta`` column could not be added yet; None on other backends.
    meta_column: Optional[bool]
    #: 'cosine' | 'l2' | 'ip' | None
    metric: Optional[str]
    dimension: Optional[int]
    model: Optional[str]
    index: Optional[Dict[str, Any]]
    size_bytes: Optional[int]
    #: Entries from :data:`CAVEATS`.
    caveats: List[str]


@dataclass(frozen=True)
class DocumentRow:
    """One document (one objectId) in a ``listDocumentPage`` page."""

    objectId: str
    path: str
    #: Chunks stored for the document; None when the backend cannot count them cheaply.
    chunks: Optional[int]
    has_first_chunk: bool
    deleted: bool
    tables: Optional[int]
    nodeId: Optional[str]
    size: Optional[int]
    modifyTime: Optional[int]
    #: UTC ISO-8601 when stored.
    ingestedAt: Optional[str]
    #: Backend id of the display row (chunk 0 when present).
    pointId: Optional[str]


@dataclass(frozen=True)
class DocPage:
    """One page of ``listDocumentPage``."""

    items: List[DocumentRow]
    #: Opaque cursor for the next page; None when the listing ended.
    next_cursor: Optional[str]
    #: Total documents, when known.
    total: Optional[int]
    counts_exact: bool
    #: True when every objectId appears at most once across the whole listing.
    distinct: bool
    #: True when rows arrive ordered by (path, objectId); otherwise the client sorts what it loaded.
    sorted: bool
    #: Entries from :data:`CAVEATS`.
    caveats: List[str]
    #: The keys of the call's :class:`DocListFilter` the hook did not apply, in
    #: :data:`DOC_LIST_FILTER_KEYS` order (contract section 4.4-A). Empty when the
    #: call had no filter or the hook applied every key it was given.
    filter_ignored: Tuple[str, ...] = ()


@dataclass(frozen=True)
class ChunkPage:
    """One page of ``scrollChunks``, in chunk order. The docs never carry embeddings."""

    docs: List['Doc']
    has_more: bool
    #: The chunkId to pass as ``after_chunk`` for the next page.
    next_after: int


@dataclass(frozen=True)
class KnnGraph:
    """A k-nearest-neighbour graph over sampled keys, in Qdrant's offsets layout.

    Row ``i``'s neighbours are ``cols[offsets_row[i]:offsets_row[i + 1]]`` with
    similarities ``sims[...]`` (higher is closer).
    """

    k: int
    offsets_row: 'np.ndarray'
    cols: 'np.ndarray'
    sims: 'np.ndarray'
    #: 'native' (computed by the backend) | 'node' (computed by vx_math on the node)
    source: str


# -----------------------------------------------------------------------------
# The documents filter (contract section 4.4-A)
# -----------------------------------------------------------------------------

#: Keys of a ``documents`` call's ``filter``, in documentation order. Any other key is refused.
DOC_LIST_FILTER_KEYS: Tuple[str, ...] = (
    'path_prefix',
    'file_types',
    'ingested_after',
    'ingested_before',
    'min_chunks',
    'max_chunks',
    'has_first_chunk',
    'has_tables',
    'path_contains',
)

#: Longest ``path_prefix`` or ``path_contains``, in characters.
DOC_LIST_FILTER_TEXT_MAX = 1024

#: Most entries of ``file_types``.
DOC_LIST_FILTER_TYPES_MAX = 32

_FILE_TYPE = re.compile(r'[a-z0-9]{1,16}')

#: ISO-8601 extended form: a date, optionally a time (seconds and a fraction optional) and an offset.
_INSTANT = re.compile(
    r'(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})'
    r'(?:[Tt ](?P<h>\d{2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:\.\d{1,9})?)?'
    r'(?P<tz>[Zz]|[+-]\d{2}:\d{2})?)?'
)


@dataclass(frozen=True)
class DocListFilter:
    """The ``filter`` of a ``documents`` call, as :func:`parse_doc_list_filter` normalises it.

    Every field is optional; None means "not filtered by this". A driver that applies
    some fields and not others names the skipped ones in the answer's
    ``filter_ignored`` (``filter_applied: 'partial'``).
    """

    #: The document path starts with this text (compared exactly, case-sensitive).
    path_prefix: Optional[str] = None
    #: Lower-cased extensions without the dot, e.g. ``('md', 'pdf')``: the path ends with one of them.
    file_types: Optional[Tuple[str, ...]] = None
    #: UTC ``YYYY-MM-DDTHH:MM:SSZ``: ingested at or after this instant.
    ingested_after: Optional[str] = None
    #: UTC ``YYYY-MM-DDTHH:MM:SSZ``: ingested before this instant.
    ingested_before: Optional[str] = None
    #: At least this many chunks.
    min_chunks: Optional[int] = None
    #: At most this many chunks.
    max_chunks: Optional[int] = None
    #: True: the document has chunk 0; False: it has none (a partly removed or partly ingested document).
    has_first_chunk: Optional[bool] = None
    #: True: at least one table chunk; False: none.
    has_tables: Optional[bool] = None
    #: The document path contains this text, ignoring case.
    path_contains: Optional[str] = None

    def given(self) -> Tuple[str, ...]:
        """Return the keys this filter sets (not None), in :data:`DOC_LIST_FILTER_KEYS` order."""
        return tuple(f.name for f in fields(self) if getattr(self, f.name) is not None)


def _filter_text(value: Any, name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f'filter.{name} must be text.')
    if len(value) > DOC_LIST_FILTER_TEXT_MAX:
        raise ValueError(f'filter.{name} must be at most {DOC_LIST_FILTER_TEXT_MAX} characters.')
    return value if value != '' else None


def _filter_instant(value: Any, name: str) -> Optional[str]:
    if value is None:
        return None
    sentence = f'filter.{name} must be an ISO-8601 date or date and time, such as 2026-10-01 or 2026-10-01T00:00:00Z.'
    # Matched by pattern rather than datetime.fromisoformat, whose accepted forms differ between Python versions.
    match = _INSTANT.fullmatch(value.strip()) if isinstance(value, str) else None
    if match is None:
        raise ValueError(sentence)
    part = match.groupdict()
    offset = timezone.utc
    if part['tz'] and part['tz'] not in ('Z', 'z'):
        sign = 1 if part['tz'][0] == '+' else -1
        hours, minutes = int(part['tz'][1:3]), int(part['tz'][4:6])
        if hours > 23 or minutes > 59:
            raise ValueError(sentence)
        offset = timezone(sign * timedelta(hours=hours, minutes=minutes))
    try:
        moment = datetime(
            int(part['y']),
            int(part['mo']),
            int(part['d']),
            int(part['h'] or 0),
            int(part['mi'] or 0),
            int(part['s'] or 0),
            tzinfo=offset,
        )
    except ValueError:  # month 13, February 30, hour 24, ...
        raise ValueError(sentence) from None
    # The stored ingestedAt is UTC 'YYYY-MM-DDTHH:MM:SSZ', so a bound in the same form compares as text.
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _filter_count(value: Any, name: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'filter.{name} must be a whole number of chunks, 0 or more.')
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f'filter.{name} must be a whole number of chunks, 0 or more.')
    count = int(value)
    if count < 0:
        raise ValueError(f'filter.{name} must be a whole number of chunks, 0 or more.')
    return count


def _filter_flag(value: Any, name: str) -> Optional[bool]:
    if value is None or isinstance(value, bool):
        return value
    raise ValueError(f'filter.{name} must be true, false or null.')


def _filter_types(value: Any) -> Optional[Tuple[str, ...]]:
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) > DOC_LIST_FILTER_TYPES_MAX:
        raise ValueError(f'filter.file_types must be a list of at most {DOC_LIST_FILTER_TYPES_MAX} file extensions.')
    out: List[str] = []
    for item in value:
        ext = item.strip().lower().lstrip('.') if isinstance(item, str) else ''
        if not _FILE_TYPE.fullmatch(ext):
            raise ValueError('filter.file_types must name extensions such as "md" or "pdf".')
        if ext not in out:
            out.append(ext)
    return tuple(out) if out else None


def parse_doc_list_filter(value: Any) -> Optional[DocListFilter]:
    """Read a ``documents`` call's ``filter``; return None when it sets nothing.

    Raises ``ValueError`` with a sentence for the caller (the tool answers it as
    ``INVALID_INPUT``) for: a filter that is not an object, an unknown key, text that is
    not text or is longer than :data:`DOC_LIST_FILTER_TEXT_MAX`, a date that is not in
    ISO-8601's extended form (``2026-10-01`` or ``2026-10-01T00:00:00Z``), a chunk count that is not a whole number of 0 or more, ``min_chunks``
    greater than ``max_chunks``, a flag that is not a boolean, and a ``file_types``
    entry that is not an extension. Dates become UTC ``YYYY-MM-DDTHH:MM:SSZ`` (a date or
    time without an offset is read as UTC); extensions are lower-cased without the dot;
    an empty text or list is the same as leaving the key out.
    """
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError('filter must be an object.')
    unknown = sorted(str(key) for key in value if key not in DOC_LIST_FILTER_KEYS)
    if unknown:
        raise ValueError(f'filter has unknown keys: {", ".join(unknown)}. Known: {", ".join(DOC_LIST_FILTER_KEYS)}.')
    parsed = DocListFilter(
        path_prefix=_filter_text(value.get('path_prefix'), 'path_prefix'),
        file_types=_filter_types(value.get('file_types')),
        ingested_after=_filter_instant(value.get('ingested_after'), 'ingested_after'),
        ingested_before=_filter_instant(value.get('ingested_before'), 'ingested_before'),
        min_chunks=_filter_count(value.get('min_chunks'), 'min_chunks'),
        max_chunks=_filter_count(value.get('max_chunks'), 'max_chunks'),
        has_first_chunk=_filter_flag(value.get('has_first_chunk'), 'has_first_chunk'),
        has_tables=_filter_flag(value.get('has_tables'), 'has_tables'),
        path_contains=_filter_text(value.get('path_contains'), 'path_contains'),
    )
    if parsed.min_chunks is not None and parsed.max_chunks is not None and parsed.min_chunks > parsed.max_chunks:
        raise ValueError('filter.min_chunks must not be greater than filter.max_chunks.')
    return parsed if parsed.given() else None


# -----------------------------------------------------------------------------
# Vocabularies (contract section 4.1)
# -----------------------------------------------------------------------------

#: Every ``code`` a failure envelope may carry.
TOOL_CODES: Tuple[str, ...] = (
    'INVALID_INPUT',
    'UNSUPPORTED',
    'NOT_FOUND',
    'IN_TRASH',
    'RESERVED_ID',
    'COLLECTION_MISSING',
    'STORE_ERROR',
    'DIMENSION_MISMATCH',
    'MODEL_MISMATCH',
    'NO_EMBEDDER',
    'LIMIT_EXCEEDED',
    'SAMPLE_EXPIRED',
    'BUSY',
    'TIMEOUT',
    'RATE_LIMITED',
    'WRITES_DISABLED',
    'WRITES_SOURCE',
    'WRITES_PUBLIC',
    'WRITES_BROADCAST',
    'WRITES_UNKNOWN_CALLER',
    'READS_PUBLIC',
)

#: Boolean keys of ``dialect.capabilities`` (``projection`` is a list, reported beside them).
CAPABILITY_KEYS: Tuple[str, ...] = (
    'describe',
    'count',
    'count_documents',
    'documents',
    'documents_distinct',
    'documents_sorted',
    'chunks',
    'vectors',
    'sample',
    'sample_light',
    'sample_stratified_native',
    'knn_native',
    'project',
    'neighbors',
    'search_vector',
    'search_keyword',
    'remove',
    'remove_count',
    'soft_delete',
    'embed_node',
    # Additive extensions (contract section 4.4); false until the node or driver offers them.
    'clusters',
    'documents_filter',
    'recommend_best_score',
)

#: Projections the ``sample`` tool can compute on the node.
PROJECTIONS: Tuple[str, ...] = ('pca',)

#: Every caveat string a tool answer may carry.
CAVEATS: Tuple[str, ...] = (
    'brute_force_search',
    'no_filtered_count',
    'biased_sample',
    'score_scale_raw',
    'score_scale_inverted_fixed',
    'shared_org_table',
    'experimental',
    'cloud_only_unverified',
    'extras_not_stored',
    'documents_by_first_chunk',
    'document_count_capped',
    'documents_unsorted',
    'documents_paging_unsupported',
    'model_mismatch',
    'meta_column_pending',
    'filtered_search_may_underfill',
    # Additive extensions (contract section 4.4).
    'listing_truncated',
    'documents_filter_partial',
    'documents_filter_client',
    # The trash (contract section 4.5).
    'trash_scan_cut',
)

#: ``sampleChunks`` strategies and the ``strategy_used`` values of a ``sample`` answer.
SAMPLE_STRATEGIES: Tuple[str, ...] = ('random', 'stratified', 'first')

#: ``KnnGraph.source`` / ``sample.knn_source`` values.
KNN_SOURCES: Tuple[str, ...] = ('native', 'node')

#: ``dialect.support`` values.
SUPPORT_LEVELS: Tuple[str, ...] = ('supported', 'experimental')

#: ``documents.filter_applied`` values: every given key applied by the store, some, or none.
FILTER_APPLIED_VALUES: Tuple[str, ...] = ('server', 'partial', 'none')

#: ``sample.listing.reason`` values: why the sampler's document listing ended.
LISTING_REASONS: Tuple[str, ...] = ('complete', 'cap', 'stale', 'pages', 'budget')

#: ``sample.cluster.method`` values the node computes. ``'label-propagation'`` is reserved and refused.
CLUSTER_METHODS: Tuple[str, ...] = ('knn-components',)

#: ``sample.clusters.label_source`` values (null when the sample has neither text nor paths).
CLUSTER_LABEL_SOURCES: Tuple[str, ...] = ('text', 'paths')

#: ``recommend.strategy`` / ``strategy_used`` values.
RECOMMEND_STRATEGIES: Tuple[str, ...] = ('average_vector', 'best_score')

#: ``similarity_matrix.source`` values: where the vectors of the matrix came from.
MATRIX_SOURCES: Tuple[str, ...] = ('cache', 'store', 'mixed')

#: ``dialect.keyword_match`` values (null when the store does not say, or has no keyword search).
KEYWORD_MATCHES: Tuple[str, ...] = ('substring', 'token')

__all__ = [
    'CAPABILITY_KEYS',
    'CAVEATS',
    'CLUSTER_LABEL_SOURCES',
    'CLUSTER_METHODS',
    'CONTROL_OBJECT_ID',
    'ChunkPage',
    'DELETED_VALUES',
    'DOC_LIST_FILTER_KEYS',
    'DOC_LIST_FILTER_TEXT_MAX',
    'DOC_LIST_FILTER_TYPES_MAX',
    'Deleted',
    'DocListFilter',
    'DocPage',
    'DocumentRow',
    'FILTER_APPLIED_VALUES',
    'KEYWORD_MATCHES',
    'KNN_SOURCES',
    'Key',
    'KnnGraph',
    'LISTING_REASONS',
    'MATRIX_SOURCES',
    'PROJECTIONS',
    'RECOMMEND_STRATEGIES',
    'SAMPLE_STRATEGIES',
    'SUPPORT_LEVELS',
    'StoreInfo',
    'TOOL_CODES',
    'parse_doc_list_filter',
]
