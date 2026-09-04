# Cobalt Pipeline Testing for RocketRide

## What is Cobalt?

[Cobalt](https://github.com/basalt-ai/cobalt-python) (basalt-ai-cobalt) is a unit testing framework for AI agents and LLM-powered systems. It runs experiments by loading datasets, executing each item through your AI system, evaluating outputs against quality criteria, and reporting scores.

This page covers the scoring code Cobalt contributes to RocketRide: the
`eval_cobalt` node's evaluators, and the offline pytest suites under
`nodes/test/cobalt/`.

**Scope, up front.** The suites in `nodes/test/cobalt/experiments/` score
**simulated** pipeline outputs -- the responses come from the
`mock_rocketride_client` fixture in `conftest.py`, not from a running server or
a live model. They pin the behaviour of the evaluators and of the thresholds
the evaluators are asserted against; they do **not** measure the quality of a
real pipeline run. Scoring real runs, and gating CI on the result, is what the
`rocketride eval` golden-dataset runner (PR #1581) is for; this PR is the
in-pipeline counterpart that scores answers as they flow through a live
pipeline via the `eval_cobalt` node.

## Why RocketRide Uses Cobalt

RocketRide's pipeline nodes handle LLM calls, vector database queries, embedding generation, reranking, and more. Traditional unit tests verify that code runs without errors, but they cannot assess whether an LLM pipeline produces _good_ outputs. Cobalt fills this gap by providing:

- **Quality scoring** -- Measure relevance, grounding, and formatting of pipeline outputs
- **Threshold assertions** -- Each offline suite asserts against a threshold it hard-codes, so a change that degrades an evaluator fails the suite
- **Regression detection** -- Pin evaluator behaviour so scoring changes surface as test failures
- **Custom evaluators** -- Domain-specific scoring functions that are deterministic and offline

## Directory Structure

```text
nodes/test/cobalt/
  cobalt.toml                     # Config for the external Cobalt runner (not read by pytest)
  conftest.py                     # Shared pytest fixtures (mock client, datasets)
  requirements.txt                # Python dependencies for Cobalt tests
  test_eval_cobalt.py             # eval_cobalt node unit tests (cobalt library mocked)
  test_eval_cobalt_integration.py # eval_cobalt tests against the real cobalt library
  evaluators/                     # Shims re-exporting nodes/src/nodes/eval_cobalt/evaluators/
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
pip install -r nodes/test/cobalt/requirements.txt
pip install pytest
```

### Run All Cobalt Experiments

```bash
# Run only Cobalt-marked tests
pytest nodes/test/cobalt/ -m cobalt -v

# Run all Cobalt tests with detailed output
pytest nodes/test/cobalt/ -v --tb=long
```

### Run Specific Experiment Suites

```bash
# LLM quality experiments only
pytest nodes/test/cobalt/experiments/test_llm_quality.py -v

# RAG quality experiments only
pytest nodes/test/cobalt/experiments/test_rag_quality.py -v

# Reranking quality experiments only
pytest nodes/test/cobalt/experiments/test_rerank_quality.py -v
```

### Run a Single Test

```bash
pytest nodes/test/cobalt/experiments/test_llm_quality.py::TestLLMOutputQuality::test_response_relevance -v
```

### No API Keys Required

All experiments use mocked pipeline responses and deterministic evaluators. No real API keys, running servers, or external services are needed.

## How to Add New Experiments

### 1. Create a New Experiment File

Create a new file in `nodes/test/cobalt/experiments/` following the naming convention `test_<domain>_quality.py`:

```python
# nodes/test/cobalt/experiments/test_embedding_quality.py

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

Import evaluators from `nodes/test/cobalt/evaluators/`:

- `evaluate_relevance(output, expected)` -- keyword overlap + length ratio
- `evaluate_grounding(output, context)` -- sentence-level context grounding
- `evaluate_format(output, expected_format)` -- structural format checking

### 3. Create Custom Evaluators

Add new evaluators in `nodes/src/nodes/eval_cobalt/evaluators/` (their canonical
home), then re-export each one from `nodes/test/cobalt/evaluators/` so experiment
files can keep importing it by short name. Every evaluator must:

- Be deterministic (no randomness)
- Work offline (no API calls)
- Return `{'score': float, 'passed': bool, 'reasoning': str}`

### 4. Use Fixtures

The `conftest.py` provides shared fixtures:

- `mock_rocketride_client` -- a fully mocked RocketRide client
- `sample_qa_dataset` -- Q&A test data
- `sample_rag_dataset` -- RAG test data with context documents

## CI Integration

No workflow in this repository runs these suites as a quality gate today, and
this PR does not add one: gating CI on the quality of a real pipeline run needs
a runner that executes the pipeline, which is PR #1581 (`rocketride eval`). The
suites here run as ordinary pytest tests alongside the rest of `nodes/test/`,
and fail like any other test when an evaluator regresses.

If you do want them as a separate step in your own workflow:

```yaml
- name: Run Cobalt experiments
  run: |
    pip install -r nodes/test/cobalt/requirements.txt
    pytest nodes/test/cobalt/ -m cobalt -v --tb=short
```

### Quality Gates

`nodes/test/cobalt/cobalt.toml` declares the thresholds used by the external
`basalt-ai-cobalt` experiment runner:

```toml
[thresholds]
avg = 0.7    # Average score across all test items must be >= 0.7
p95 = 0.5    # 95th-percentile (top-tail) score must be >= 0.5
```

Nothing in this repository reads that file. The offline pytest gates under
`nodes/test/cobalt/experiments/` hard-code the thresholds they assert on, so
editing `cobalt.toml` does not change what `pytest` enforces -- the two must be
kept in sync by hand. A pytest assertion that falls below its own threshold
fails that test -- against a simulated response, not a real pipeline run.

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
- `threshold` (float): Minimum score in `[0.0, 1.0]` to pass (default 0.5)

### grounding.evaluate_grounding(output, context, ...)

Measures whether output claims are supported by the provided context:

- Splits output into sentences
- For each sentence, checks what fraction of content words appear in the context
- Returns average grounding score and per-sentence details

Parameters:

- `output` (str): The LLM-generated answer
- `context` (str): The source documents as a single string -- callers join multiple documents themselves (e.g. `' '.join(retrieved_docs)`)
- `threshold` (float): Minimum score in `[0.0, 1.0]` to pass (default 0.5)

### format_check.evaluate_format(output, expected_format, ...)

Checks structural formatting of the output. Supported formats:

- **prose**: Continuous sentences with punctuation, not lists or code
- **list**: Bullet points or numbered items
- **code**: Code blocks or code-like syntax
- **json**: Valid JSON structure

Parameters:

- `output` (str): The text to check
- `expected_format` (str): One of 'prose', 'list', 'code', 'json' (default 'prose')
- `threshold` (float): Minimum score in `[0.0, 1.0]` to pass (default 0.5)

Raises `ValueError` if `expected_format` is not one of the four supported values.

## End-to-end pipeline example

A working example pipeline is provided in `examples/cobalt-evaluation.pipe`.
It wires the full evaluation flow:

```text
dataset_cobalt → prompt → llm_openai → eval_cobalt → response_answers
```

- **dataset_cobalt** loads a small inline Q&A dataset (3 items).
- **prompt** prepends an instruction to each question.
- **llm_openai** generates an answer for each question.
- **eval_cobalt** scores each answer against the expected output using
  semantic similarity (`threshold: 0.6`).
- **response_answers** returns the evaluated answers.

Swap the `eval_cobalt_1` profile to `relevance`, `grounding`, `format`,
`llm_judge`, or `custom` to try the other evaluators. The `relevance`,
`grounding`, and `format` profiles are fully deterministic and require
no external API keys, making them ideal for CI gating.

Run the pipeline via the standard RocketRide loader (set
`ROCKETRIDE_OPENAI_KEY` in your environment first).

## Running real-library integration tests

The fast unit tests in `nodes/test/cobalt/test_eval_cobalt.py` mock the `cobalt`
library to keep CI deterministic. A companion file exercises the real
basalt-ai-cobalt library for each of the three primary evaluation modes
(`similarity`, `llm_judge`, `custom`):

```bash
pytest -m integration nodes/test/cobalt/test_eval_cobalt_integration.py
```

The whole module is skipped cleanly when `basalt-ai-cobalt` is not
installed, and the `llm_judge` test additionally requires
`OPENAI_API_KEY` to be set.
