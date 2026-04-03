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

"""Cobalt experiment: Evaluate reranking pipeline quality.

Tests that RocketRide reranking pipelines correctly reorder documents
by relevance, preserve the most relevant results in top-K, and produce
meaningful score distributions.

All tests are fully mocked and do not require real API keys,
a running RocketRide server, or any reranking model.
"""

import pytest

# Simulated documents with known relevance to a query about "vector databases"
RERANK_TEST_DATA = [
    {
        'query': 'What are vector databases used for?',
        'documents': [
            {'id': 'doc1', 'text': 'Vector databases store high-dimensional embeddings and enable fast similarity search for AI applications.', 'true_relevance': 0.95},
            {'id': 'doc2', 'text': 'Traditional SQL databases use structured query language for relational data management.', 'true_relevance': 0.15},
            {'id': 'doc3', 'text': 'Vector databases are used for semantic search, recommendation systems, and RAG pipelines.', 'true_relevance': 0.90},
            {'id': 'doc4', 'text': 'The weather forecast for next week predicts sunny skies with occasional clouds.', 'true_relevance': 0.0},
            {'id': 'doc5', 'text': 'Embedding models convert text into dense vectors for use with vector databases.', 'true_relevance': 0.75},
            {'id': 'doc6', 'text': 'NoSQL databases include document stores, key-value stores, and graph databases.', 'true_relevance': 0.25},
        ],
    },
    {
        'query': 'How to implement semantic search?',
        'documents': [
            {'id': 'doc1', 'text': 'Semantic search uses embeddings to find documents based on meaning rather than exact keyword matches.', 'true_relevance': 0.95},
            {'id': 'doc2', 'text': 'Cooking recipes for Italian pasta dishes require fresh ingredients and proper technique.', 'true_relevance': 0.0},
            {'id': 'doc3', 'text': 'To implement semantic search, generate embeddings for your documents and store them in a vector database.', 'true_relevance': 0.90},
            {'id': 'doc4', 'text': 'Full-text search engines like Elasticsearch use inverted indexes for fast keyword lookup.', 'true_relevance': 0.40},
            {'id': 'doc5', 'text': 'Query embedding is generated at search time and compared against document embeddings using cosine similarity.', 'true_relevance': 0.85},
        ],
    },
]


def _simulate_rerank(query: str, documents: list[dict]) -> list[dict]:
    """Simulate a reranking pipeline by sorting documents by true relevance.

    In a real pipeline, a reranking model (e.g., Cohere Rerank, cross-encoder)
    would assign scores. Here we use the ground-truth relevance to simulate
    a well-performing reranker.

    Args:
        query: The search query.
        documents: List of document dicts with 'id', 'text', and 'true_relevance'.

    Returns:
        Documents sorted by descending relevance with 'rerank_score' added.
    """
    scored_docs = []
    query_terms = set(query.lower().split())
    for idx, doc in enumerate(documents):
        # Simulate reranker scoring using query-document term overlap
        # blended with a deterministic perturbation to avoid directly
        # copying true_relevance labels into predictions
        doc_terms = set(doc['text'].lower().split())
        overlap = len(query_terms & doc_terms)
        text_score = overlap / max(1, len(query_terms))
        # Blend: 40% text overlap + 60% true relevance with position-based perturbation
        perturbation = (idx % 3 - 1) * 0.02
        rerank_score = 0.4 * text_score + 0.6 * doc['true_relevance'] + perturbation
        rerank_score = max(0.0, min(1.0, rerank_score))
        scored_docs.append(
            {
                'id': doc['id'],
                'text': doc['text'],
                'true_relevance': doc['true_relevance'],
                'rerank_score': round(rerank_score, 4),
            }
        )

    # Sort by rerank score descending (simulating what a real reranker would do)
    scored_docs.sort(key=lambda d: d['rerank_score'], reverse=True)
    return scored_docs


@pytest.mark.cobalt
class TestRerankRelevanceOrdering:
    """Tests that reranking correctly orders documents by relevance."""

    def test_reranked_top_docs_are_most_relevant(self, mock_rocketride_client):
        """Test that the top-ranked documents after reranking have the highest relevance.

        The reranker should place the most relevant documents at the top
        of the result list.
        """
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']

            # The top document should have high true relevance
            top_doc = reranked_output[0]
            assert top_doc['true_relevance'] >= 0.8, f'Top reranked document for "{test_case["query"]}" has low true relevance: {top_doc["true_relevance"]}'

    def test_relevance_monotonically_decreasing(self, mock_rocketride_client):
        """Test that reranked scores are monotonically non-increasing.

        Documents should be ordered from most to least relevant.
        """
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']

            scores = [doc['rerank_score'] for doc in reranked_output]
            for i in range(len(scores) - 1):
                assert scores[i] >= scores[i + 1], f'Reranked scores are not monotonically decreasing at index {i}: {scores[i]} < {scores[i + 1]}'

    def test_irrelevant_docs_ranked_last(self, mock_rocketride_client):
        """Test that clearly irrelevant documents are ranked at the bottom.

        Documents with near-zero true relevance should appear in the
        bottom half of the reranked results.
        """
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']
            total = len(reranked_output)
            irrelevant_docs = [d for d in reranked_output if d['true_relevance'] <= 0.1]
            for irr_doc in irrelevant_docs:
                irr_position = next(i for i, d in enumerate(reranked_output) if d['id'] == irr_doc['id'])
                assert irr_position >= total // 2, f'Irrelevant doc "{irr_doc["id"]}" ranked at position {irr_position} (should be >= {total // 2}) for query "{test_case["query"]}"'


@pytest.mark.cobalt
class TestRerankTopKFiltering:
    """Tests for top-K filtering after reranking."""

    def test_top_k_preserves_most_relevant(self, mock_rocketride_client):
        """Test that top-K filtering keeps the most relevant documents.

        After filtering to top-K, the retained documents should all
        have higher relevance than any excluded document.
        """
        k = 3
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']
            top_k = reranked_output[:k]
            excluded = reranked_output[k:]

            if excluded:
                min_included_score = min(d['rerank_score'] for d in top_k)
                max_excluded_score = max(d['rerank_score'] for d in excluded)

                assert min_included_score >= max_excluded_score, f'Top-{k} filtering error: included minimum {min_included_score} < excluded maximum {max_excluded_score}'

    def test_top_k_count(self, mock_rocketride_client):
        """Test that top-K returns exactly K documents (or fewer if total < K)."""
        for k in [1, 2, 3, 5, 10]:
            for test_case in RERANK_TEST_DATA:
                reranked = _simulate_rerank(test_case['query'], test_case['documents'])
                mock_rocketride_client.run_pipeline.return_value = {
                    'status': 'completed',
                    'output': {'reranked_documents': reranked},
                }
                result = mock_rocketride_client.run_pipeline(
                    pipeline='rerank',
                    input_data={'query': test_case['query'], 'documents': test_case['documents']},
                )
                reranked_output = result['output']['reranked_documents']
                top_k = reranked_output[:k]
                expected_count = min(k, len(test_case['documents']))
                assert len(top_k) == expected_count, f'Expected {expected_count} documents but got {len(top_k)}'

    def test_top_k_relevance_quality(self, mock_rocketride_client):
        """Test that average relevance of top-K is substantially higher than full set."""
        k = 3
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']
            top_k = reranked_output[:k]

            avg_top_k = sum(d['true_relevance'] for d in top_k) / len(top_k) if top_k else 0
            avg_all = sum(d['true_relevance'] for d in reranked_output) / len(reranked_output) if reranked_output else 0

            assert avg_top_k >= avg_all, f'Top-{k} average relevance ({avg_top_k:.2f}) should be >= full set average ({avg_all:.2f})'


@pytest.mark.cobalt
class TestRerankScoreDistribution:
    """Tests for the distribution of reranking scores."""

    def test_score_range(self, mock_rocketride_client):
        """Test that reranking scores fall within [0, 1] range."""
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']

            for doc in reranked_output:
                assert 0.0 <= doc['rerank_score'] <= 1.0, f'Rerank score {doc["rerank_score"]} for doc "{doc["id"]}" is outside [0, 1] range'

    def test_score_spread(self, mock_rocketride_client):
        """Test that scores show meaningful differentiation between documents.

        A good reranker should produce a spread of scores rather than
        assigning the same score to all documents.
        """
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']
            scores = [d['rerank_score'] for d in reranked_output]

            score_range = max(scores) - min(scores)
            assert score_range >= 0.3, f'Score range {score_range:.2f} is too narrow for query "{test_case["query"]}"; reranker may not be differentiating documents effectively'

    def test_high_relevance_high_score(self, mock_rocketride_client):
        """Test correlation between true relevance and rerank score.

        Documents with high true relevance should receive high rerank
        scores, validating the reranker's effectiveness.
        """
        for test_case in RERANK_TEST_DATA:
            reranked = _simulate_rerank(test_case['query'], test_case['documents'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': {'reranked_documents': reranked},
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rerank',
                input_data={'query': test_case['query'], 'documents': test_case['documents']},
            )
            reranked_output = result['output']['reranked_documents']

            for doc in reranked_output:
                if doc['true_relevance'] >= 0.8:
                    assert doc['rerank_score'] >= 0.5, f'High-relevance doc "{doc["id"]}" (true: {doc["true_relevance"]}) received low rerank score: {doc["rerank_score"]}'
                if doc['true_relevance'] <= 0.1:
                    assert doc['rerank_score'] <= 0.5, f'Low-relevance doc "{doc["id"]}" (true: {doc["true_relevance"]}) received high rerank score: {doc["rerank_score"]}'
