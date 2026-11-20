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

"""The Vector Explorer's additive tools on every vector store node (contract section 4.4).

``VectorExplorerExtTools`` is mixed into ``VectorStoreToolMixin`` (``document_store``)
ahead of ``VectorExplorerTools``, so every store node that answers the explorer's
tools also answers the tools defined here. It holds the tools that came after the
first contract: ``recommend`` (similar chunks from positive and negative example
keys) and ``similarity_matrix`` (the pairwise similarities of up to
``matrix_keys_max`` keys). Neither accepts or returns a stored vector.

Every tool here is written as the tools in ``vx_tools`` are:

* ``@tool_function(..., audience=('dap',))`` over ``@vx_tools.vectordb_tool``, so
  it is listed for external (DAP) callers only and an agent's tool catalog does
  not change;
* ``vx_write_gate.check_read()`` first (a read refused on a public key answers
  ``READS_PUBLIC``);
* inputs read with the ``vx_tools`` argument helpers and the limits of
  ``vx_defaults.VECTOR_TOOL_LIMITS`` (reported in ``dialect.limits``);
* the store reached through ``self._vx_store()`` (``VectorExplorerTools``, next in
  the method resolution order of the node).

This module may import from ``vx_tools`` (the wrapper, the argument helpers, the
``_vx_*`` plumbing); ``vx_tools`` never imports from it, so there is no import
cycle.

See ``docs/development/nodes/vector-tool-contract.md`` section 4.4.
"""

import math
from typing import Any, Dict, List, Optional, Sequence

from rocketlib import tool_function

from ..schema import Doc, QuestionText
from . import vx_write_gate
from .errors import StoreUnsupported, ToolRefusal
from .vx_tools import (
    _ENVELOPE,
    _KEY_SCHEMA,
    DEFAULTS,
    LIMITS,
    Key,
    _bool_arg,
    _clamped,
    _filter_object_ids,
    _int_arg,
    _invalid,
    _keys_arg,
    _round,
    _vector_arg,
    _vx_state,
    deletedFilter,
    docKey,
    metadataValue,
    read_vectors,
    vectordb_tool,
)
from .vx_types import CONTROL_OBJECT_ID, MATRIX_SOURCES, RECOMMEND_STRATEGIES

#: The sentence of a ``best_score`` call to a store that cannot rank it (the app shows it as is).
BEST_SCORE_UNSUPPORTED = 'best_score is not supported by this store; use average_vector.'

#: The warning of a native recommendation asked to keep its examples: the store always leaves them out.
EXAMPLES_ALWAYS_EXCLUDED = 'examples_always_excluded'

#: Decimal places of every ``similarity_matrix`` value (reported as ``dp``).
MATRIX_DP = 2


def _examples_arg(args: Dict[str, Any], name: str) -> List[Key]:
    """One side of a recommendation's examples: 0 to ``recommend_examples_max`` distinct keys."""
    value = args.get(name)
    if value is None:
        return []
    return _keys_arg(value, name, LIMITS['recommend_examples_max'], min_n=0)


def _as_rows(vectors: Sequence[Any]) -> 'Any':
    import numpy as np

    return np.vstack([np.asarray(v, dtype=np.float64).reshape(1, -1) for v in vectors])


def _unit_rows(rows: 'Any') -> 'Any':
    import numpy as np

    norms = np.linalg.norm(rows, axis=1, keepdims=True)
    return rows / np.where(norms > 0, norms, 1.0)


def average_vector_query(metric: str, positives: Sequence[Any], negatives: Sequence[Any]) -> 'Any':
    """The search vector of an ``average_vector`` recommendation (contract section 4.4-D).

    ``avg_positive + avg_positive - avg_negative``, or ``avg_positive`` without negatives:
    the formula Qdrant documents for its own ``average_vector`` strategy. On a cosine store
    every example is taken at unit length first (Qdrant stores cosine vectors normalised,
    so a long vector does not outweigh a short one) and the result is unit length; on an
    ``ip`` or ``l2`` store the examples are averaged as stored.

    The query vector ``recommend`` adds as a positive is taken at unit length on a cosine
    store too, deliberately: a Qdrant server averages a raw vector as given, so a long one
    would outweigh the stored examples. The two rank alike whenever the vector is unit
    length, as the embedding models the templates use return it.

    :raises ToolRefusal: ``INVALID_INPUT`` when there is no positive vector, or when the
        examples cancel out on a cosine store (no direction is left to search).
    """
    import numpy as np

    if not positives:
        raise _invalid('Add at least one positive example.')
    cosine = metric == 'cosine'
    pos = _as_rows(positives)
    avg_positive = (_unit_rows(pos) if cosine else pos).mean(axis=0)
    query = avg_positive
    if negatives:
        neg = _as_rows(negatives)
        query = avg_positive + avg_positive - (_unit_rows(neg) if cosine else neg).mean(axis=0)
    if not np.all(np.isfinite(query)):
        raise _invalid('The examples do not give a vector to search with.')
    if cosine:
        norm = float(np.linalg.norm(query))
        if norm <= 1e-9:
            raise _invalid('The positive and negative examples cancel out; change the examples.')
        query = query / norm
    return query


def _matrix_value(value: float) -> Optional[float]:
    """One matrix cell: rounded to :data:`MATRIX_DP` places, never ``-0.0``, null when not finite."""
    number = float(value)
    if not math.isfinite(number):
        return None
    number = round(number, MATRIX_DP)
    return 0.0 if number == 0 else number


__all__ = [
    'BEST_SCORE_UNSUPPORTED',
    'EXAMPLES_ALWAYS_EXCLUDED',
    'MATRIX_DP',
    'VectorExplorerExtTools',
    'average_vector_query',
]


class VectorExplorerExtTools:
    """The Vector Explorer's additive tools; mixed into ``VectorStoreToolMixin`` before ``VectorExplorerTools``."""

    # ------------------------------------------------------------------
    # recommend
    # ------------------------------------------------------------------

    def _vx_neighbour_items(
        self, store: Any, metric: str, hits: Sequence[Doc], anchors: Any, *, native: bool
    ) -> List[Dict[str, Any]]:
        """Neighbour rows (as ``neighbors`` answers them) for ``hits``, best first.

        ``sim`` is the hit's similarity by the store's metric to the nearest row of
        ``anchors`` (the search vector of an average, the examples of a native ranking),
        read from the hit's own vector (the cached sample first, else ``getVectors``); the
        driver's score stands in when the vector cannot be read. A searched row is
        ``below_floor`` when its score is under the store's floor; a native ranking's
        score is not a search score, so it never is. Searched rows are ordered by
        ``sim``; a native ranking keeps the store's order.
        """
        import numpy as np

        from . import vx_math

        keyed = [(doc, docKey(doc)) for doc in hits]
        keyed = [(doc, key) for doc, key in keyed if key is not None and key[0] != CONTROL_OBJECT_ID]
        vectors = self._vx_vectors_for(store, [key for _doc, key in keyed]) if keyed else {}
        floor = float(self._vx_score(store)['floor'] or 0.0)
        rows: List[tuple] = []
        for doc, key in keyed:
            score = doc.score if isinstance(doc.score, (int, float)) else None
            sim: Optional[float]
            if key in vectors and len(vectors[key]) == anchors.shape[1]:
                sim = float(np.max(vx_math.similarity(metric, anchors, np.asarray(vectors[key]))))
            else:
                sim = float(score) if score is not None else None
            item = {
                'key': [key[0], key[1]],
                'sim': _round(sim, 4),
                'score': _round(score, 4),
                'below_floor': (not native) and score is not None and score < floor,
                'path': str(metadataValue(doc, 'parent') or ''),
                'chunkId': key[1],
                'preview': vx_math.snippet(doc.page_content, LIMITS['snippet_chars']),
            }
            rows.append((sim if sim is not None and math.isfinite(sim) else -math.inf, item))
        if not native:
            rows.sort(key=lambda row: -row[0])
        return [item for _sim, item in rows]

    def _vx_example_vectors(self, store: Any, keys: Sequence[Key]) -> Dict[Key, Any]:
        """The stored vectors of a recommendation's example ``keys``, read from the store now.

        The store, not the cached sample, says which examples are stored: a sample
        keeps the chunks of a document removed after it was drawn, and a store that
        ranks natively (``best_score``) looks its examples up in the collection, so
        ``examples_resolved`` and ``not_found`` must count what the store holds (at
        most ``recommend_examples_max`` keys a side, so the read is small). Only a
        store that cannot read vectors by key (``getVectors`` unsupported) is answered
        from the latest cached sample.
        """
        import numpy as np

        try:
            return {key: np.asarray(doc.embedding, dtype=np.float32) for key, doc in read_vectors(store, keys).items()}
        except StoreUnsupported:
            return self._vx_vectors_for(store, keys)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'positive': {
                    'type': 'array',
                    'items': _KEY_SCHEMA,
                    'maxItems': LIMITS['recommend_examples_max'],
                    'description': 'Chunks the results should be like.',
                },
                'negative': {
                    'type': 'array',
                    'items': _KEY_SCHEMA,
                    'maxItems': LIMITS['recommend_examples_max'],
                    'description': 'Chunks the results should be unlike.',
                },
                'vector': {
                    'type': ['array', 'null'],
                    'items': {'type': 'number'},
                    'description': 'The query vector the embed tool returned, counted as one more positive example.',
                },
                'k': {'type': 'integer', 'description': 'Results wanted (default 12, at most 50).'},
                'strategy': {
                    'type': 'string',
                    'enum': list(RECOMMEND_STRATEGIES),
                    'description': "'average_vector' (default, every store) or 'best_score' (stores that rank it natively).",
                },
                'filter': {'type': 'object', 'properties': {'object_ids': {'type': ['array', 'null']}}},
                'exclude_examples': {
                    'type': 'boolean',
                    'description': 'Leave the examples out of the results (default true).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                **_ENVELOPE,
                'items': {'type': 'array'},
                'strategy_used': {'type': 'string', 'enum': list(RECOMMEND_STRATEGIES)},
                'native': {'type': 'boolean'},
                'metric': {'type': 'string'},
                'k_requested': {'type': 'integer'},
                'examples_resolved': {'type': 'object'},
                'not_found': {'type': 'array', 'items': _KEY_SCHEMA},
            },
        },
        description=(
            'Find the stored chunks most like the positive example chunks and least like the negative ones, '
            'across the whole collection.'
        ),
        audience=('dap',),
    )
    @vectordb_tool
    def recommend(self, args):
        """Chunks like the positive examples and unlike the negative ones (contract section 4.4-D)."""
        vx_write_gate.check_read()
        import numpy as np

        store = self._vx_store()
        strategy = args.get('strategy')
        if strategy is None:
            strategy = 'average_vector'
        if strategy not in RECOMMEND_STRATEGIES:
            raise _invalid("strategy must be 'average_vector' or 'best_score'.")
        positive = _examples_arg(args, 'positive')
        negative = _examples_arg(args, 'negative')
        if set(positive) & set(negative):
            raise _invalid('A chunk cannot be both a positive and a negative example.')
        vector = _vector_arg(args['vector']) if args.get('vector') is not None else None
        if strategy == 'average_vector' and not positive and vector is None:
            raise _invalid('Add at least one positive example.')
        if not positive and not negative and vector is None:
            raise _invalid('Add at least one positive or negative example.')
        warnings: List[str] = []
        k = _clamped(_int_arg(args, 'k', DEFAULTS['neighbors_k']), 1, LIMITS['neighbors_k_max'], 'k', warnings)
        exclude = _bool_arg(args, 'exclude_examples', True)
        object_ids = _filter_object_ids(args)
        native = strategy == 'best_score'
        if native and not (
            self._vx_capabilities(store.capabilities())['recommend_best_score']
            and callable(getattr(store, 'recommendNative', None))
        ):
            raise ToolRefusal('UNSUPPORTED', BEST_SCORE_UNSUPPORTED)

        state = _vx_state(store)
        if not state.neighbors_busy.acquire(blocking=False):
            raise ToolRefusal(
                'BUSY', 'Another neighbour search or recommendation is running on this store; try again when it ends.'
            )
        try:
            if not store._doesCollectionExist():
                raise ToolRefusal('COLLECTION_MISSING', 'The collection does not exist yet; add a document first.')
            self._vx_load_control(store)
            metric = self._vx_metric(store) or 'cosine'

            wanted = [key for key in positive + negative if key[0] != CONTROL_OBJECT_ID]
            found = self._vx_example_vectors(store, wanted) if wanted else {}
            pos_found = [key for key in positive if key in found]
            neg_found = [key for key in negative if key in found]
            not_found = [[key[0], key[1]] for key in positive + negative if key not in found]
            if positive and not pos_found and vector is None:
                raise ToolRefusal(
                    'NOT_FOUND',
                    'None of the positive examples is stored in this collection.',
                    {'not_found': not_found},
                )
            if not positive and vector is None and not neg_found:
                raise ToolRefusal(
                    'NOT_FOUND',
                    'None of the negative examples is stored in this collection.',
                    {'not_found': not_found},
                )
            if vector is not None and store.vectorSize and len(vector) != int(store.vectorSize):
                raise ToolRefusal(
                    'DIMENSION_MISMATCH',
                    f'The vector has {len(vector)} values; this collection stores {int(store.vectorSize)}.',
                )
            examples_pos = [found[key] for key in pos_found] + ([vector] if vector is not None else [])
            examples_neg = [found[key] for key in neg_found]
            if len({len(v) for v in examples_pos + examples_neg}) > 1:
                raise ToolRefusal(
                    'DIMENSION_MISMATCH', 'The examples hold vectors of different lengths; they cannot be compared.'
                )

            if native:
                hits = [
                    doc
                    for doc in store.recommendNative(
                        positive=pos_found,
                        negative=neg_found,
                        strategy=strategy,
                        limit=k,
                        object_ids=object_ids,
                        vector=vector,
                    )
                    if (docKey(doc) or ('', 0))[0] != CONTROL_OBJECT_ID
                ]
                anchors = _as_rows(examples_pos or examples_neg)
                if not exclude:
                    warnings.append(EXAMPLES_ALWAYS_EXCLUDED)
            else:
                query = average_vector_query(metric, examples_pos, examples_neg)
                excluded = set(positive) | set(negative) if exclude else set()
                flt = deletedFilter('active', objectIds=object_ids, limit=k + len(excluded))
                flt.minScore = float('-inf')
                question = QuestionText(
                    text='', embedding=[float(v) for v in query], embedding_model=store.modelName or None
                )
                hits = [
                    doc
                    for doc in store.searchSemantic(question, flt)
                    if (docKey(doc) or ('', 0))[0] != CONTROL_OBJECT_ID and docKey(doc) not in excluded
                ]
                anchors = np.asarray(query, dtype=np.float64).reshape(1, -1)
            items = self._vx_neighbour_items(store, metric, hits, anchors, native=native)[:k]
            answer: Dict[str, Any] = {
                'success': True,
                'items': items,
                'strategy_used': strategy,
                'native': native,
                'metric': metric,
                'k_requested': k,
                'examples_resolved': {'positive': len(pos_found), 'negative': len(neg_found)},
                'not_found': not_found,
            }
            if warnings:
                answer['warnings'] = warnings
            return answer
        finally:
            state.neighbors_busy.release()

    # ------------------------------------------------------------------
    # similarity_matrix
    # ------------------------------------------------------------------

    def _vx_matrix_vectors(self, store: Any, keys: Sequence[Key]) -> 'tuple[Dict[Key, Any], set]':
        """Vectors for ``keys`` and the keys read from the cache.

        The latest cached sample first (by ``SampleEntry.index``), then ``getVectors`` for the
        rest; the control record is never read. A store that cannot read vectors leaves those
        keys out.
        """
        import numpy as np

        out: Dict[Key, Any] = {}
        cached: set = set()
        latest = _vx_state(store).samples().latest()
        if latest is not None:
            for key in keys:
                idx = latest.index.get(key)
                if idx is not None:
                    out[key] = latest.vectors[idx]
                    cached.add(key)
        missing = [key for key in keys if key not in out and key[0] != CONTROL_OBJECT_ID]
        if missing:
            try:
                for key, doc in read_vectors(store, missing).items():
                    out[key] = np.asarray(doc.embedding, dtype=np.float32)
            except StoreUnsupported:
                pass
        return out, cached

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['keys'],
            'properties': {
                'keys': {
                    'type': 'array',
                    'items': _KEY_SCHEMA,
                    'minItems': 2,
                    'maxItems': LIMITS['matrix_keys_max'],
                    'description': 'The chunks to compare, by [objectId, chunkId].',
                }
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                **_ENVELOPE,
                'n': {'type': 'integer'},
                'keys': {'type': 'array', 'items': _KEY_SCHEMA},
                'metric': {'type': 'string'},
                'dp': {'type': 'integer'},
                'matrix': {'type': 'array', 'items': {'type': 'array', 'items': {'type': ['number', 'null']}}},
                'source': {'type': 'string', 'enum': list(MATRIX_SOURCES)},
                'not_found': {'type': 'array', 'items': _KEY_SCHEMA},
            },
        },
        description='Return the pairwise similarities of up to 100 stored chunks, by [objectId, chunkId].',
        audience=('dap',),
    )
    @vectordb_tool
    def similarity_matrix(self, args):
        """The pairwise similarities of 2 to ``matrix_keys_max`` chunks, by key (contract section 4.4-E).

        Keys only: there is no sample id or index input, so the matrix does not depend on
        which sample the caller drew last. Each key's vector comes from the latest cached
        sample, else from the store (``source``); keys found in neither are listed in
        ``not_found`` and the matrix covers the others, in the order given, by the store's
        metric (``vx_math.similarity``), made exactly symmetric and rounded to ``dp`` places.
        Scalars only. Takes no lock: it reads the cache and the store as ``neighbors`` does
        and holds nothing another call waits for.
        """
        vx_write_gate.check_read()
        import numpy as np

        from . import vx_math

        store = self._vx_store()
        raw = args.get('keys')
        max_n = LIMITS['matrix_keys_max']
        if isinstance(raw, (list, tuple)) and len(raw) > max_n:
            raise ToolRefusal('LIMIT_EXCEEDED', f'A matrix compares at most {max_n} chunks; {len(raw)} were given.')
        keys = _keys_arg(raw, 'keys', max_n, min_n=2)
        if len(keys) < 2:
            raise _invalid('keys must name at least 2 different chunks.')
        if not store._doesCollectionExist():
            raise ToolRefusal('COLLECTION_MISSING', 'The collection does not exist yet; add a document first.')
        metric = self._vx_metric(store) or 'cosine'
        vectors, cached = self._vx_matrix_vectors(store, keys)
        resolved = [key for key in keys if key in vectors]
        not_found = [[key[0], key[1]] for key in keys if key not in vectors]
        if len(resolved) < 2:
            raise ToolRefusal(
                'NOT_FOUND', 'Fewer than 2 of those chunks are stored in this collection.', {'not_found': not_found}
            )
        if len({len(vectors[key]) for key in resolved}) > 1:
            raise ToolRefusal(
                'DIMENSION_MISMATCH', 'Those chunks hold vectors of different lengths; they cannot be compared.'
            )
        V = np.vstack([np.asarray(vectors[key], dtype=np.float32).reshape(1, -1) for key in resolved])
        S = vx_math.similarity(metric, V, V).astype(np.float64)
        S = (S + S.T) / 2.0
        from_cache = sum(1 for key in resolved if key in cached)
        source = 'cache' if from_cache == len(resolved) else ('store' if from_cache == 0 else 'mixed')
        return {
            'success': True,
            'n': len(resolved),
            'keys': [[key[0], key[1]] for key in resolved],
            'metric': metric,
            'dp': MATRIX_DP,
            'matrix': [[_matrix_value(value) for value in row] for row in S],
            'source': source,
            'not_found': not_found,
        }
