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

"""Hybrid search engine combining vector similarity and BM25 keyword search."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


class HybridSearchEngine:
    """Combines vector similarity search with BM25 keyword search using Reciprocal Rank Fusion."""

    def __init__(self, alpha: float = 0.5):
        """
        Initialize the hybrid search engine.

        Args:
            alpha: Weight for vector scores (0.0 to 1.0). BM25 weight is (1 - alpha).
                   alpha=1.0 means vector-only, alpha=0.0 means BM25-only.
        """
        if not 0.0 <= alpha <= 1.0:
            raise ValueError('alpha must be between 0.0 and 1.0')
        self.alpha = alpha

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        """Tokenize text by lowercasing and splitting on non-alphanumeric characters."""
        if not text:
            return []
        # Lowercase, then split on non-word characters
        return [token for token in re.split(r'\W+', text.lower()) if token]

    def bm25_search(self, query: str, documents: List[Dict[str, Any]], top_k: int = 10) -> List[Dict[str, Any]]:
        """
        BM25 keyword search over document texts.

        Args:
            query: The search query string.
            documents: List of dicts, each must have a 'text' key with the document content.
                       May also have an 'id' key for identification.
            top_k: Maximum number of results to return.

        Returns:
            List of documents with 'bm25_score' added, sorted by score descending.
        """
        if not query or not documents:
            return []

        # Extract texts and tokenize
        doc_texts = [doc.get('text', '') or '' for doc in documents]
        tokenized_docs = [self._tokenize(text) for text in doc_texts]

        # Filter out empty tokenized docs for BM25, but keep track of indices
        non_empty_indices = [i for i, tokens in enumerate(tokenized_docs) if tokens]
        if not non_empty_indices:
            return []

        non_empty_tokenized = [tokenized_docs[i] for i in non_empty_indices]

        from rank_bm25 import BM25Okapi

        bm25 = BM25Okapi(non_empty_tokenized)
        query_tokens = self._tokenize(query)

        if not query_tokens:
            return []

        scores = bm25.get_scores(query_tokens)

        # Map scores back to original document indices
        scored_docs = []
        for rank_idx, orig_idx in enumerate(non_empty_indices):
            doc_copy = dict(documents[orig_idx])
            doc_copy['bm25_score'] = float(scores[rank_idx])
            scored_docs.append(doc_copy)

        # Sort by score descending
        scored_docs.sort(key=lambda d: d['bm25_score'], reverse=True)

        return scored_docs[:top_k]

    @staticmethod
    def reciprocal_rank_fusion(
        *result_lists: List[Dict[str, Any]],
        k: int = 60,
        id_key: str = 'id',
        weights: Optional[List[float]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Merge multiple ranked result lists using Reciprocal Rank Fusion (RRF).

        RRF score = sum(weight_i / (k + rank_i)) across all result lists.
        This method is rank-based and does not depend on score magnitudes.

        Args:
            *result_lists: Variable number of ranked result lists.
            k: RRF constant (default 60). Higher values reduce the impact of high rankings.
            id_key: Key used to identify and deduplicate documents across lists.
            weights: Optional list of weights for each result list. If None, all lists
                     are weighted equally (weight=1.0). Length must match result_lists.

        Returns:
            Merged, deduplicated list sorted by RRF score descending.
        """
        if weights is not None and len(weights) != len(result_lists):
            raise ValueError('weights length must match the number of result lists')

        rrf_scores: Dict[str, float] = {}
        doc_map: Dict[str, Dict[str, Any]] = {}

        for list_idx, result_list in enumerate(result_lists):
            weight = weights[list_idx] if weights is not None else 1.0
            for rank, doc in enumerate(result_list):
                doc_id = str(doc.get(id_key, ''))
                if not doc_id:
                    # Use text content as fallback identifier
                    doc_id = str(doc.get('text', f'__unnamed_{rank}'))

                rrf_score = weight * (1.0 / (k + rank + 1))  # rank is 0-indexed, RRF uses 1-indexed
                rrf_scores[doc_id] = rrf_scores.get(doc_id, 0.0) + rrf_score

                # Keep the first occurrence of each document
                if doc_id not in doc_map:
                    doc_map[doc_id] = dict(doc)

        # Attach RRF scores and sort
        results = []
        for doc_id, rrf_score in rrf_scores.items():
            doc = dict(doc_map[doc_id])
            doc['rrf_score'] = rrf_score
            results.append(doc)

        # Sort by RRF score descending; ties broken by existing order (stable sort)
        results.sort(key=lambda d: d['rrf_score'], reverse=True)

        return results

    def search(
        self,
        query: str,
        documents: List[Dict[str, Any]],
        vector_scores: Optional[List[float]] = None,
        top_k: int = 10,
        rrf_k: int = 60,
    ) -> List[Dict[str, Any]]:
        """
        Full hybrid search: vector + BM25 merged via Reciprocal Rank Fusion.

        Args:
            query: The search query string.
            documents: List of dicts with 'text' (and optionally 'id') keys.
            vector_scores: Pre-computed vector similarity scores aligned with documents.
                          If None, only BM25 is used.
            top_k: Maximum number of results to return.
            rrf_k: RRF constant for fusion.

        Returns:
            List of documents ranked by hybrid RRF score.
        """
        if not documents:
            return []

        # Build vector-ranked list if scores are provided
        vector_results: List[Dict[str, Any]] = []
        if vector_scores is not None and len(vector_scores) == len(documents):
            scored = []
            for i, doc in enumerate(documents):
                doc_copy = dict(doc)
                doc_copy['vector_score'] = float(vector_scores[i])
                scored.append(doc_copy)
            scored.sort(key=lambda d: d['vector_score'], reverse=True)
            vector_results = scored

        # Run BM25 search
        bm25_results = self.bm25_search(query, documents, top_k=len(documents))

        # If alpha is 0 (BM25-only), skip vector results
        if self.alpha == 0.0 or not vector_results:
            return bm25_results[:top_k]

        # If alpha is 1 (vector-only), skip BM25 results
        if self.alpha == 1.0 or not bm25_results:
            return vector_results[:top_k]

        # Merge using RRF, weighting vector by alpha and BM25 by (1 - alpha)
        merged = self.reciprocal_rank_fusion(
            vector_results,
            bm25_results,
            k=rrf_k,
            weights=[self.alpha, 1.0 - self.alpha],
        )

        return merged[:top_k]
