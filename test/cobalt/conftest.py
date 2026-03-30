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

"""Shared fixtures for Cobalt AI evaluation experiments."""

import pytest
from unittest.mock import AsyncMock, MagicMock


@pytest.fixture
def mock_rocketride_client():
    """Create a mock RocketRide client for testing pipelines.

    Returns a MagicMock that simulates the RocketRide client interface,
    including pipeline execution and result retrieval. All network calls
    are fully mocked so no real API keys or server connections are needed.
    """
    client = MagicMock()
    client.connect = MagicMock(return_value=True)
    client.disconnect = MagicMock(return_value=True)
    client.is_connected = MagicMock(return_value=True)

    # Mock pipeline execution
    client.run_pipeline = MagicMock(return_value={'status': 'completed', 'output': ''})
    client.run_pipeline_async = AsyncMock(return_value={'status': 'completed', 'output': ''})

    # Mock pipeline management
    client.list_pipelines = MagicMock(return_value=[])
    client.get_pipeline = MagicMock(return_value={'name': 'test-pipeline', 'nodes': []})

    return client


@pytest.fixture
def sample_qa_dataset():
    """Return a small Q&A test dataset for LLM quality evaluation.

    Each item contains an input query and an expected reference answer.
    These are used as ground truth for relevance and accuracy scoring.
    """
    return [
        {
            'input': 'What is machine learning?',
            'expected': 'Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed. It focuses on developing algorithms that can access data and use it to learn for themselves.',
        },
        {
            'input': 'Explain neural networks',
            'expected': 'Neural networks are computing systems inspired by biological neural networks in the human brain. They consist of interconnected nodes (neurons) organized in layers that process information using connectionist approaches to computation.',
        },
        {
            'input': 'What is NLP?',
            'expected': 'Natural language processing (NLP) is a field of artificial intelligence that focuses on the interaction between computers and humans through natural language. It involves programming computers to process and analyze large amounts of natural language data.',
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


@pytest.fixture
def sample_rag_dataset():
    """Return a RAG test dataset with documents and queries.

    Each item contains a query, a set of context documents, and an
    expected answer that should be derivable from those documents.
    """
    return [
        {
            'query': 'What are the benefits of vector databases?',
            'documents': [
                'Vector databases are optimized for storing and querying high-dimensional vectors. They enable fast similarity search across millions of embeddings.',
                'Traditional databases use exact match queries, while vector databases use approximate nearest neighbor algorithms for efficient retrieval.',
                'Key benefits include: sub-millisecond query times for similarity search, horizontal scalability, and native support for embedding storage.',
            ],
            'expected': 'Vector databases offer fast similarity search with sub-millisecond query times, horizontal scalability, and native embedding storage support.',
        },
        {
            'query': 'How does chunking affect RAG quality?',
            'documents': [
                'Document chunking breaks large texts into smaller segments for embedding. Chunk size directly impacts retrieval quality.',
                'Smaller chunks provide more precise retrieval but may lose context. Larger chunks preserve context but may include irrelevant information.',
                'Overlapping chunks can help maintain context across boundaries. A typical overlap is 10-20% of the chunk size.',
            ],
            'expected': 'Chunking impacts RAG quality by trading off precision versus context. Smaller chunks give precise retrieval but may lose context, while larger chunks preserve context but may include noise. Overlapping chunks help maintain context across boundaries.',
        },
        {
            'query': 'What is hybrid search?',
            'documents': [
                'Hybrid search combines dense vector search with sparse keyword search (like BM25) to improve retrieval quality.',
                'Dense retrieval excels at semantic understanding while sparse retrieval is better at exact term matching.',
                'By combining both approaches, hybrid search achieves better recall and precision than either method alone.',
            ],
            'expected': 'Hybrid search combines dense vector search (for semantic understanding) with sparse keyword search like BM25 (for exact term matching), achieving better recall and precision than either approach alone.',
        },
    ]
