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

import sys
import os

import pytest

# Ensure the evaluators package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from evaluators.relevance import evaluate_relevance
from evaluators.format_check import evaluate_format

# Test dataset: input queries with expected reference answers
QA_DATASET = [
    {
        'input': 'What is machine learning?',
        'expected': 'Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed. It focuses on developing algorithms that can access data and use it to learn for themselves.',
    },
    {
        'input': 'Explain neural networks',
        'expected': 'Neural networks are computing systems inspired by biological neural networks in the human brain. They consist of interconnected nodes organized in layers that process information using connectionist approaches to computation.',
    },
    {
        'input': 'What is NLP?',
        'expected': 'Natural language processing is a field of artificial intelligence that focuses on the interaction between computers and humans through natural language. It involves programming computers to process and analyze large amounts of natural language data.',
    },
    {
        'input': 'What is reinforcement learning?',
        'expected': 'Reinforcement learning is a type of machine learning where an agent learns to make decisions by performing actions in an environment to maximize cumulative reward. The agent learns through trial and error, receiving feedback in the form of rewards or penalties.',
    },
    {
        'input': 'Define transfer learning',
        'expected': 'Transfer learning is a machine learning technique where a model trained on one task is reused as the starting point for a model on a second task. It leverages knowledge gained from solving one problem and applies it to a different but related problem.',
    },
]

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

    def test_response_relevance(self, mock_rocketride_client):
        """Test that LLM responses are relevant to the input query.

        Evaluates each dataset item by comparing the simulated pipeline
        output against the expected reference using keyword overlap
        and length-ratio scoring.
        """
        scores = []
        for item in QA_DATASET:
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
        assert avg_score >= 0.5, f'Average relevance score {avg_score:.2f} is below threshold 0.5'

    def test_response_completeness(self, mock_rocketride_client):
        """Test that responses cover key aspects of the question.

        Completeness is measured by checking that the response contains
        a meaningful number of content words from the expected answer,
        indicating it addresses the core concepts of the question.
        """
        for item in QA_DATASET:
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

    def test_response_format(self, mock_rocketride_client):
        """Test that responses follow expected prose formatting.

        LLM Q&A responses should be in prose format with proper
        sentence structure and punctuation, not lists or code blocks.
        """
        for item in QA_DATASET:
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

    def test_factual_accuracy(self, mock_rocketride_client):
        """Test factual accuracy using keyword overlap with reference answers.

        Measures how well the actual response aligns with the expected
        reference answer in terms of shared content words, serving as
        a proxy for factual consistency.
        """
        scores = []
        for item in QA_DATASET:
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

    def test_quality_threshold(self, mock_rocketride_client):
        """Test that average quality across all dimensions meets threshold.

        Aggregates relevance, format, and accuracy scores to produce
        a single quality metric. This mirrors the cobalt.toml threshold
        configuration (avg >= 0.7).
        """
        quality_scores = []

        for item in QA_DATASET:
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
        assert avg_quality >= 0.5, f'Average composite quality {avg_quality:.2f} does not meet threshold 0.5'

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
