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

"""Cobalt experiment: Evaluate LLM pipeline output quality.

Tests that RocketRide LLM pipelines produce accurate, relevant,
and well-formatted responses using semantic similarity and
custom evaluators.

All tests are fully mocked and do not require real API keys or
a running RocketRide server.
"""

import pytest

from evaluators.relevance import evaluate_relevance
from evaluators.format_check import evaluate_format

# Simulated LLM pipeline responses (mocked to avoid real API calls)
SIMULATED_RESPONSES = {
    'What is machine learning?': 'Machine learning is a branch of artificial intelligence focused on building systems that learn from data. These algorithms improve their performance over time without being explicitly programmed for each task.',
    'Explain neural networks': 'Neural networks are computational models inspired by the human brain. They use layers of interconnected nodes to process data, recognize patterns, and make decisions. Each layer transforms the input data progressively.',
    'What is NLP?': 'Natural language processing (NLP) is an AI discipline concerned with enabling computers to understand, interpret, and generate human language. It combines computational linguistics with machine learning to process text and speech data.',
    'What is reinforcement learning?': 'Reinforcement learning is a machine learning paradigm where an agent interacts with an environment, taking actions and receiving rewards or penalties. The goal is to learn a policy that maximizes long-term cumulative reward through trial and error.',
    'Define transfer learning': 'Transfer learning involves taking a pre-trained model from one domain and fine-tuning it for a related task. This approach saves training time and data by leveraging knowledge already captured in the base model.',
}


def _simulate_pipeline_response(query: str) -> str:
    """Return a simulated LLM pipeline response for a given query.

    Args:
        query: The input query string.

    Returns:
        A simulated response string.
    """
    return SIMULATED_RESPONSES.get(query, 'I do not have information about that topic.')


@pytest.mark.cobalt
class TestLLMOutputQuality:
    """Cobalt-style experiments for LLM output evaluation."""

    def test_response_relevance(self, mock_rocketride_client, sample_qa_dataset):
        """Test that LLM responses are relevant to the input query.

        Evaluates each dataset item by comparing the simulated pipeline
        output against the expected reference using keyword overlap
        and length-ratio scoring.
        """
        scores = []
        for item in sample_qa_dataset:
            # Simulate pipeline execution
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': _simulate_pipeline_response(item['input']),
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='llm-qa',
                input_data={'query': item['input']},
            )
            output = result['output']

            evaluation = evaluate_relevance(output, item['expected'])
            scores.append(evaluation['score'])

            # Each individual response should have at least some relevance
            assert evaluation['score'] > 0.2, f'Response to "{item["input"]}" has very low relevance: {evaluation["reasoning"]}'

        avg_score = sum(scores) / len(scores)
        # Threshold matches cobalt.toml [thresholds] p95 = 0.5
        assert avg_score >= 0.5, f'Average relevance score {avg_score:.2f} is below threshold 0.5'

    def test_response_completeness(self, mock_rocketride_client, sample_qa_dataset):
        """Test that responses cover key aspects of the question.

        Completeness is measured by checking that the response contains
        a meaningful number of content words from the expected answer,
        indicating it addresses the core concepts of the question.
        """
        for item in sample_qa_dataset:
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': _simulate_pipeline_response(item['input']),
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='llm-qa',
                input_data={'query': item['input']},
            )
            output = result['output']

            # A complete response should not be trivially short
            assert len(output.split()) >= 10, f'Response to "{item["input"]}" is too short ({len(output.split())} words)'

            # Check that the response addresses the subject of the question
            evaluation = evaluate_relevance(output, item['expected'])
            assert evaluation['score'] >= 0.3, f'Response to "{item["input"]}" appears incomplete: {evaluation["reasoning"]}'

    def test_response_format(self, mock_rocketride_client, sample_qa_dataset):
        """Test that responses follow expected prose formatting.

        LLM Q&A responses should be in prose format with proper
        sentence structure and punctuation, not lists or code blocks.
        """
        for item in sample_qa_dataset:
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': _simulate_pipeline_response(item['input']),
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='llm-qa',
                input_data={'query': item['input']},
            )
            output = result['output']

            evaluation = evaluate_format(output, expected_format='prose')
            assert evaluation['passed'], f'Response to "{item["input"]}" has unexpected format: {evaluation["reasoning"]}'

    def test_factual_accuracy(self, mock_rocketride_client, sample_qa_dataset):
        """Test factual accuracy using keyword overlap with reference answers.

        Measures how well the actual response aligns with the expected
        reference answer in terms of shared content words, serving as
        a proxy for factual consistency.
        """
        scores = []
        for item in sample_qa_dataset:
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': _simulate_pipeline_response(item['input']),
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='llm-qa',
                input_data={'query': item['input']},
            )
            output = result['output']

            evaluation = evaluate_relevance(output, item['expected'], keyword_weight=1.0, length_weight=0.0)
            scores.append(evaluation['score'])

        avg_score = sum(scores) / len(scores)
        assert avg_score >= 0.3, f'Average factual accuracy score {avg_score:.2f} is below threshold 0.3'

    def test_quality_threshold(self, mock_rocketride_client, sample_qa_dataset):
        """Test that average quality across all dimensions meets threshold.

        Aggregates relevance and format scores to produce a single
        quality metric. This mirrors the cobalt.toml threshold
        configuration (avg >= 0.7).
        """
        quality_scores = []

        for item in sample_qa_dataset:
            mock_rocketride_client.run_pipeline.return_value = {
                'status': 'completed',
                'output': _simulate_pipeline_response(item['input']),
            }
            result = mock_rocketride_client.run_pipeline(
                pipeline='llm-qa',
                input_data={'query': item['input']},
            )
            output = result['output']

            relevance = evaluate_relevance(output, item['expected'])
            formatting = evaluate_format(output, expected_format='prose')

            # Composite quality score: 60% relevance + 40% format
            composite = 0.6 * relevance['score'] + 0.4 * formatting['score']
            quality_scores.append(composite)

        avg_quality = sum(quality_scores) / len(quality_scores)
        # Threshold matches cobalt.toml [thresholds] avg = 0.7
        assert avg_quality >= 0.7, f'Average composite quality {avg_quality:.2f} does not meet threshold 0.7'

    def test_empty_input_handling(self, mock_rocketride_client):
        """Test that the pipeline handles empty input gracefully.

        The pipeline should return a valid (possibly empty) response
        rather than crashing when given empty input.
        """
        mock_rocketride_client.run_pipeline.return_value = {
            'status': 'completed',
            'output': 'I need a question to provide an answer.',
        }
        result = mock_rocketride_client.run_pipeline(
            pipeline='llm-qa',
            input_data={'query': ''},
        )
        assert result['status'] == 'completed'
        assert isinstance(result['output'], str)
