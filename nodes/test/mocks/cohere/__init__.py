"""
Mock Cohere package for rerank node integration tests.

When ROCKETRIDE_MOCK is set, this replaces the real cohere SDK so dynamic
node tests do not call external APIs.
"""

from . import errors


class _MockRerankResult:
    def __init__(self, index, relevance_score):
        self.index = index
        self.relevance_score = relevance_score


class _MockRerankResponse:
    def __init__(self, results):
        self.results = results


class ClientV2:
    """Mock Cohere v2 client with deterministic rerank results."""

    def __init__(self, api_key=None, **kwargs):
        """Store the configured API key for parity with the real client."""
        self.api_key = api_key

    def rerank(self, model=None, query=None, documents=None, top_n=None, **kwargs):
        documents = documents or []
        query_terms = set((query or '').lower().split())

        scored = []
        for index, document in enumerate(documents):
            document_terms = set(str(document).lower().split())
            overlap = len(query_terms & document_terms)
            scored.append((index, 1.0 + overlap))

        scored.sort(key=lambda item: item[1], reverse=True)
        limit = top_n if isinstance(top_n, int) and top_n > 0 else len(scored)
        if scored:
            max_score = scored[0][1]
        else:
            max_score = 1.0

        results = [_MockRerankResult(index, score / max_score) for index, score in scored[:limit]]
        return _MockRerankResponse(results)


__all__ = ['ClientV2', 'errors']
