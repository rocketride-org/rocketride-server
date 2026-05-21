# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock rank_bm25 package for search_hybrid node testing.

When ROCKETRIDE_MOCK is set (or this directory is on sys.path before the real
package), this shadows the PyPI ``rank_bm25`` dependency so the
``HybridSearchEngine`` can be exercised without installing it. ``BM25Okapi``
implements the minimal interface the engine uses (``__init__(corpus)`` and
``get_scores(query_tokens)``) with a TF-IDF-ish score order good enough for
ranking assertions.
"""

from typing import Dict, List


class BM25Okapi:
    """Minimal stand-in for ``rank_bm25.BM25Okapi`` used only in tests."""

    def __init__(self, corpus: List[List[str]]) -> None:
        self.corpus = corpus
        self.doc_count = len(corpus)
        self.doc_freqs: Dict[str, int] = {}
        for doc_tokens in corpus:
            for token in set(doc_tokens):
                self.doc_freqs[token] = self.doc_freqs.get(token, 0) + 1

    def get_scores(self, query_tokens: List[str]) -> List[float]:
        scores: List[float] = []
        for doc_tokens in self.corpus:
            token_counts: Dict[str, int] = {}
            for t in doc_tokens:
                token_counts[t] = token_counts.get(t, 0) + 1
            score = 0.0
            for qt in query_tokens:
                if qt in token_counts:
                    tf = token_counts[qt]
                    df = self.doc_freqs.get(qt, 1)
                    idf = max(0.1, (self.doc_count - df + 0.5) / (df + 0.5))
                    score += tf * idf
            scores.append(score)
        return scores
