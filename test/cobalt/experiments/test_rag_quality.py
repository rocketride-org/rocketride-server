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

"""Cobalt experiment: Evaluate RAG pipeline quality.

Tests that RocketRide RAG pipelines correctly retrieve relevant
documents, ground answers in context, and avoid hallucination.

All tests are fully mocked and do not require real API keys,
a running RocketRide server, or any vector database.
"""

import pytest

from evaluators.relevance import evaluate_relevance
from evaluators.grounding import evaluate_grounding

# Simulated RAG pipeline outputs (mocked to avoid real API calls)
SIMULATED_RAG_RESPONSES = {
    'What are the benefits of vector databases?': {
        'retrieved_docs': [
            'Vector databases are optimized for storing and querying high-dimensional vectors. They enable fast similarity search across millions of embeddings.',
            'Key benefits include: sub-millisecond query times for similarity search, horizontal scalability, and native support for embedding storage.',
        ],
        'answer': 'Vector databases provide fast similarity search with sub-millisecond query times, horizontal scalability for large datasets, and native support for storing and querying high-dimensional embeddings.',
    },
    'How does chunking affect RAG quality?': {
        'retrieved_docs': [
            'Document chunking breaks large texts into smaller segments for embedding. Chunk size directly impacts retrieval quality.',
            'Smaller chunks provide more precise retrieval but may lose context. Larger chunks preserve context but may include irrelevant information.',
            'Overlapping chunks can help maintain context across boundaries. A typical overlap is 10-20% of the chunk size.',
        ],
        'answer': 'Chunking directly impacts RAG quality by controlling the trade-off between precision and context. Smaller chunks enable more precise retrieval but risk losing context, while larger chunks preserve context but may include irrelevant information. Overlapping chunks with 10-20% overlap help maintain context across boundaries.',
    },
    'What is hybrid search?': {
        'retrieved_docs': [
            'Hybrid search combines dense vector search with sparse keyword search (like BM25) to improve retrieval quality.',
            'By combining both approaches, hybrid search achieves better recall and precision than either method alone.',
        ],
        'answer': 'Hybrid search is an approach that combines dense vector search for semantic understanding with sparse keyword search methods like BM25 for exact term matching. This combination achieves better recall and precision than either approach used in isolation.',
    },
}


def _simulate_rag_pipeline(query: str) -> dict:
    """Return a simulated RAG pipeline response.

    Args:
        query: The input query string.

    Returns:
        A dict with retrieved_docs and answer keys.
    """
    default_response = {
        'retrieved_docs': [],
        'answer': 'No relevant documents found for this query.',
    }
    return SIMULATED_RAG_RESPONSES.get(query, default_response)


@pytest.mark.cobalt
class TestRAGRetrievalQuality:
    """Tests for the retrieval stage of the RAG pipeline."""

    def test_retrieval_relevance(self, mock_rocketride_client, sample_rag_dataset):
        """Test that retrieved documents are relevant to the query.

        For each dataset item, checks that the retrieved documents
        share significant keyword overlap with the ground-truth
        context documents.
        """
        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }

            retrieved_text = ' '.join(rag_response['retrieved_docs'])
            expected_text = ' '.join(item['documents'])

            evaluation = evaluate_relevance(retrieved_text, expected_text)
            assert evaluation['score'] >= 0.4, f'Retrieval for "{item["query"]}" has low relevance: {evaluation["reasoning"]}'

    def test_retrieval_coverage(self, mock_rocketride_client, sample_rag_dataset):
        """Test that retrieval covers key information from the source documents.

        Checks that the retrieved document set collectively contains
        the essential information needed to answer the query.
        """
        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rag-qa',
                input_data={'query': item['query']},
            )
            output = result['output']

            # Verify we actually retrieved documents
            assert len(output['retrieved_docs']) > 0, f'No documents retrieved for "{item["query"]}"'

            # Check that retrieved docs cover the core content
            retrieved_text = ' '.join(output['retrieved_docs'])
            evaluation = evaluate_relevance(retrieved_text, item['expected'])
            assert evaluation['score'] >= 0.3, f'Retrieved docs for "{item["query"]}" miss key information: {evaluation["reasoning"]}'


@pytest.mark.cobalt
class TestRAGAnswerQuality:
    """Tests for the answer generation stage of the RAG pipeline."""

    def test_answer_grounding(self, mock_rocketride_client, sample_rag_dataset):
        """Test that generated answers are grounded in retrieved documents.

        The answer should be derived from the retrieved context rather
        than from the model's parametric knowledge. This tests the
        faithfulness of the generation step.
        """
        scores = []
        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rag-qa',
                input_data={'query': item['query']},
            )
            output = result['output']
            context = ' '.join(output['retrieved_docs'])
            answer = output['answer']

            evaluation = evaluate_grounding(answer, context)
            scores.append(evaluation['score'])

            assert evaluation['score'] >= 0.4, f'Answer for "{item["query"]}" is not well grounded: {evaluation["reasoning"]}'

        avg_score = sum(scores) / len(scores)
        assert avg_score >= 0.5, f'Average grounding score {avg_score:.2f} is below threshold 0.5'

    def test_hallucination_detection(self, mock_rocketride_client, sample_rag_dataset):
        """Test that answers do not contain claims unsupported by context.

        Hallucination is detected by checking if the answer's content
        words can be traced back to the retrieved documents. Sentences
        with low grounding scores indicate potential hallucination.
        """
        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rag-qa',
                input_data={'query': item['query']},
            )
            output = result['output']
            context = ' '.join(output['retrieved_docs'])
            answer = output['answer']

            evaluation = evaluate_grounding(answer, context)

            # Check per-sentence grounding to find hallucinated claims
            if evaluation.get('details'):
                low_grounding_sentences = [s for s in evaluation['details'] if s['score'] < 0.3]
                hallucination_ratio = len(low_grounding_sentences) / len(evaluation['details'])

                assert hallucination_ratio < 0.5, f'Answer for "{item["query"]}" has {len(low_grounding_sentences)}/{len(evaluation["details"])} potentially hallucinated sentences (ratio: {hallucination_ratio:.2f})'

    def test_answer_relevance_to_query(self, mock_rocketride_client, sample_rag_dataset):
        """Test that the answer is relevant to the original query.

        Even when grounded in context, the answer should directly
        address the user's question rather than tangential information
        from the retrieved documents.
        """
        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rag-qa',
                input_data={'query': item['query']},
            )
            output = result['output']
            answer = output['answer']

            evaluation = evaluate_relevance(answer, item['expected'])
            assert evaluation['score'] >= 0.4, f'Answer for "{item["query"]}" is not relevant to the query: {evaluation["reasoning"]}'


@pytest.mark.cobalt
class TestRAGEndToEnd:
    """End-to-end quality tests for the complete RAG pipeline."""

    def test_end_to_end_quality_threshold(self, mock_rocketride_client, sample_rag_dataset):
        """Test that overall RAG quality meets the configured threshold.

        Combines retrieval relevance, answer grounding, and answer
        relevance into a single composite metric.
        """
        composite_scores = []

        for item in sample_rag_dataset:
            rag_response = _simulate_rag_pipeline(item['query'])
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': rag_response,
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='rag-qa',
                input_data={'query': item['query']},
            )
            output = result['output']
            context = ' '.join(output['retrieved_docs'])
            answer = output['answer']
            expected_context = ' '.join(item['documents'])

            # Measure retrieval quality
            retrieval_eval = evaluate_relevance(' '.join(output['retrieved_docs']), expected_context)

            # Measure grounding quality
            grounding_eval = evaluate_grounding(answer, context)

            # Measure answer relevance
            answer_eval = evaluate_relevance(answer, item['expected'])

            # Composite: 30% retrieval + 40% grounding + 30% answer relevance
            composite = 0.3 * retrieval_eval['score'] + 0.4 * grounding_eval['score'] + 0.3 * answer_eval['score']
            composite_scores.append(composite)

        avg_quality = sum(composite_scores) / len(composite_scores)
        # Threshold matches cobalt.toml [thresholds] avg = 0.7
        assert avg_quality >= 0.7, f'Average end-to-end RAG quality {avg_quality:.2f} does not meet threshold 0.7'

    def test_no_documents_fallback(self, mock_rocketride_client):
        """Test graceful handling when no relevant documents are retrieved.

        The pipeline should produce a meaningful response (e.g., acknowledging
        the lack of information) rather than generating a hallucinated answer.
        """
        mock_rocketride_client.run_pipeline.return_value = {
            'status': 'completed',
            'output': {
                'retrieved_docs': [],
                'answer': 'No relevant documents found for this query.',
            },
        }
        result = mock_rocketride_client.run_pipeline(
            pipeline='rag-qa',
            input_data={'query': 'What is the airspeed velocity of an unladen swallow?'},
        )

        assert result['status'] == 'completed'
        output = result['output']
        assert len(output['retrieved_docs']) == 0
        assert isinstance(output['answer'], str)
        assert len(output['answer']) > 0
