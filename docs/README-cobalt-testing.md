# Cobalt Pipeline Testing for RocketRide

## What is Cobalt?

[Cobalt](https://github.com/cobalt-ai/cobalt) (cobalt-ai) is a unit testing framework for AI agents and LLM-powered systems. It runs experiments by loading datasets, executing each item through your AI system, evaluating outputs against quality criteria, and reporting scores.

RocketRide uses Cobalt to validate the quality of its AI pipeline outputs -- LLM responses, RAG answers, and reranking results -- in an automated, reproducible way.

## Why RocketRide Uses Cobalt

RocketRide's pipeline nodes handle LLM calls, vector database queries, embedding generation, reranking, and more. Traditional unit tests verify that code runs without errors, but they cannot assess whether an LLM pipeline produces *good* outputs. Cobalt fills this gap by providing:

- **Quality scoring** -- Measure relevance, grounding, and formatting of pipeline outputs
- **Threshold enforcement** -- Fail CI if average quality drops below configured thresholds
- **Regression detection** -- Track quality over time to catch degradation early
- **Custom evaluators** -- Domain-specific scoring functions that are deterministic and offline

## Directory Structure

```
test/cobalt/
  cobalt.toml                     # Cobalt configuration (thresholds, concurrency)
  conftest.py                     # Shared pytest fixtures (mock client, datasets)
  requirements.txt                # Python dependencies for Cobalt tests
  evaluators/
    __init__.py
    relevance.py                  # Keyword overlap + length ratio evaluator
    grounding.py                  # Context grounding evaluator (hallucination detection)
    format_check.py               # Structural format evaluator (prose, list, code, json)
  experiments/
    __init__.py
    test_llm_quality.py           # LLM pipeline output quality experiments
    test_rag_quality.py           # RAG pipeline quality experiments
    test_rerank_quality.py        # Reranking pipeline quality experiments
```

## Running Cobalt Experiments Locally

### Prerequisites

```bash
# Install test dependencies
pip install -r test/cobalt/requirements.txt
pip install pytest
```

### Run All Cobalt Experiments

```bash
# Run only Cobalt-marked tests
pytest test/cobalt/ -m cobalt -v

# Run all Cobalt tests with detailed output
pytest test/cobalt/ -v --tb=long
```

### Run Specific Experiment Suites

```bash
# LLM quality experiments only
pytest test/cobalt/experiments/test_llm_quality.py -v

# RAG quality experiments only
pytest test/cobalt/experiments/test_rag_quality.py -v

# Reranking quality experiments only
pytest test/cobalt/experiments/test_rerank_quality.py -v
```

### Run a Single Test

```bash
pytest test/cobalt/experiments/test_llm_quality.py::TestLLMOutputQuality::test_response_relevance -v
```

### No API Keys Required

All experiments use mocked pipeline responses and deterministic evaluators. No real API keys, running servers, or external services are needed.

## How to Add New Experiments

### 1. Create a New Experiment File

Create a new file in `test/cobalt/experiments/` following the naming convention `test_<domain>_quality.py`:

```python
# test/cobalt/experiments/test_embedding_quality.py

import pytest
from evaluators.relevance import evaluate_relevance

DATASET = [
    {'input': '...', 'expected': '...'},
]

@pytest.mark.cobalt
class TestEmbeddingQuality:
    def test_embedding_similarity(self, mock_rocketride_client):
        """Test that similar inputs produce similar embeddings."""
        # Your test logic here
        pass
```

### 2. Use Existing Evaluators

Import evaluators from `test/cobalt/evaluators/`:

- `evaluate_relevance(output, expected)` -- keyword overlap + length ratio
- `evaluate_grounding(output, context)` -- sentence-level context grounding
- `evaluate_format(output, expected_format)` -- structural format checking

### 3. Create Custom Evaluators

Add new evaluators in `test/cobalt/evaluators/`. Every evaluator must:

- Be deterministic (no randomness)
- Work offline (no API calls)
- Return `{'score': float, 'passed': bool, 'reasoning': str}`

### 4. Use Fixtures

The `conftest.py` provides shared fixtures:

- `mock_rocketride_client` -- a fully mocked RocketRide client
- `sample_qa_dataset` -- Q&A test data
- `sample_rag_dataset` -- RAG test data with context documents

## CI Integration

### Add to CI Pipeline

Add a step to your CI workflow that runs Cobalt experiments:

```yaml
- name: Run Cobalt experiments
  run: |
    pip install -r test/cobalt/requirements.txt
    pytest test/cobalt/ -m cobalt -v --tb=short
```

### Quality Gates

The `cobalt.toml` configuration defines quality thresholds:

```toml
[thresholds]
avg = 0.7    # Average score across all experiments must be >= 0.7
p95 = 0.5    # 95th percentile worst-case must be >= 0.5
```

Tests that fall below these thresholds will fail, blocking the CI pipeline.

## Evaluator Reference

### relevance.evaluate_relevance(output, expected, ...)

Measures response relevance using two signals:
- **Keyword overlap** (default weight 0.7): Jaccard similarity of content words (stop words excluded)
- **Length ratio** (default weight 0.3): Penalizes responses that are much shorter or longer than expected

Parameters:
- `output` (str): The actual response
- `expected` (str): The reference answer
- `keyword_weight` (float): Weight for keyword overlap (default 0.7)
- `length_weight` (float): Weight for length ratio (default 0.3)
- `threshold` (float): Minimum score to pass (default 0.5)

### grounding.evaluate_grounding(output, context, ...)

Measures whether output claims are supported by the provided context:
- Splits output into sentences
- For each sentence, checks what fraction of content words appear in the context
- Returns average grounding score and per-sentence details

Parameters:
- `output` (str): The LLM-generated answer
- `context` (str): Source documents (concatenated)
- `threshold` (float): Minimum score to pass (default 0.5)

### format_check.evaluate_format(output, expected_format, ...)

Checks structural formatting of the output. Supported formats:
- **prose**: Continuous sentences with punctuation, not lists or code
- **list**: Bullet points or numbered items
- **code**: Code blocks or code-like syntax
- **json**: Valid JSON structure

Parameters:
- `output` (str): The text to check
- `expected_format` (str): One of 'prose', 'list', 'code', 'json'
- `threshold` (float): Minimum score to pass (default 0.5)
