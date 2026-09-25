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

"""Integration tests for the Cobalt Evaluator node that exercise the real
`cobalt` library (from the basalt-ai-cobalt PyPI package).

These tests are distinct from `test_eval_cobalt.py` which mocks `cobalt`
entirely to validate the fallback/dispatch logic. Here we import the real
library (skipping the whole module when it is unavailable) and drive each
evaluation mode end-to-end to catch regressions in how `CobaltEvaluator`
integrates with the upstream API.

Run with:

    pytest -m integration nodes/test/cobalt/test_eval_cobalt_integration.py
"""

import importlib.util
import os
import pathlib
import sys
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

# The basalt-ai-cobalt package exposes its API under the `cobalt` module name.
# Tests that require the real library are guarded individually so that
# `--collect-only` still reports the full set of tests even when the library
# is not installed in the current environment.
_cobalt_installed = importlib.util.find_spec('cobalt') is not None
_requires_cobalt = pytest.mark.skipif(
    not _cobalt_installed,
    reason='requires basalt-ai-cobalt to be installed',
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Minimal rocketlib / ai.common stubs so CobaltEvaluator can be imported
# outside the RocketRide engine runtime. We deliberately do NOT mock `cobalt`
# here — the point of these tests is to exercise the real library path.
# ---------------------------------------------------------------------------

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_NODES_DIR = str(_REPO_ROOT / 'nodes' / 'src' / 'nodes')

_rocketlib = ModuleType('rocketlib')
_rocketlib.IGlobalBase = type('IGlobalBase', (), {})
_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
_rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()
_rocketlib.warning = MagicMock()
_rocketlib.debug = MagicMock()

_ai_mod = ModuleType('ai')
_ai_common = ModuleType('ai.common')
_ai_common_config = ModuleType('ai.common.config')
_ai_common_schema = ModuleType('ai.common.schema')
_ai_mod.__path__ = [str(_REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai')]
_ai_common.__path__ = [str(_REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common')]


class _StubConfig:
    @staticmethod
    def getNodeConfig(logical_type, conn_config):
        return conn_config


_ai_common_config.Config = _StubConfig
_ai_common.config = _ai_common_config


class _StubAnswer:
    def __init__(self, expectJson=False):  # noqa: D107
        self.expectJson = expectJson
        self._answer = None

    def setAnswer(self, value):
        self._answer = value

    def getJson(self):
        return self._answer

    def getText(self):
        return str(self._answer) if self._answer is not None else ''

    def isJson(self):
        return self.expectJson


class _StubQuestion:
    def __init__(self, **kwargs):  # noqa: D107
        self.questions = []
        self.context = []
        self.instructions = []
        self.history = []
        self.examples = []
        self.documents = []
        self.goals = []
        self.metadata = {}

    def addQuestion(self, text):
        self.questions.append(text)

    def addContext(self, ctx):
        self.context.append(ctx)


class _StubQuestionText:
    def __init__(self, text=''):  # noqa: D107
        self.text = text


_ai_common_schema.Answer = _StubAnswer
_ai_common_schema.Question = _StubQuestion
_ai_common_schema.QuestionText = _StubQuestionText
_ai_common_schema.QuestionType = type('QuestionType', (), {'QUESTION': 'question'})()
_ai_common_schema.Doc = MagicMock
_ai_common_schema.DocFilter = MagicMock
_ai_common_schema.DocMetadata = MagicMock
_ai_common_schema.DocGroup = MagicMock
_ai_common.schema = _ai_common_schema

_STUB_MODULES = {
    'rocketlib': _rocketlib,
    'ai': _ai_mod,
    'ai.common': _ai_common,
    'ai.common.config': _ai_common_config,
    'ai.common.schema': _ai_common_schema,
}

_modules_patch = patch.dict(sys.modules, _STUB_MODULES)
_modules_patch.start()
if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)

from eval_cobalt.cobalt_evaluator import CobaltEvaluator  # noqa: E402

_modules_patch.stop()
if _NODES_DIR in sys.path:
    sys.path.remove(_NODES_DIR)


# ---------------------------------------------------------------------------
# Integration tests — one per evaluation mode
# ---------------------------------------------------------------------------


@_requires_cobalt
def test_similarity_real_library_path():
    """Drive similarity evaluation through the real `cobalt.Evaluator`.

    The score itself is only asserted to be a valid probability, since the
    value depends on the installed library version — but the reasoning is
    asserted exactly, because that is the only thing that distinguishes the
    real path from the fallback. Without it this test passed for months while
    every evaluation actually fell back to Jaccard: cobalt's `evaluate` is a
    coroutine taking an `EvalContext`, the node called it with `output=` /
    `expected=` keywords, and the resulting TypeError was swallowed.
    """
    evaluator = CobaltEvaluator({'eval_type': 'similarity', 'threshold': 0.5}, {})
    result = evaluator.evaluate_semantic(
        'The capital of France is Paris',
        'Paris is the capital of France',
    )

    assert isinstance(result, dict)
    assert result['evaluator'] == 'semantic'
    assert 0.0 <= result['score'] <= 1.0
    assert isinstance(result['passed'], bool)
    # cobalt's similarity handler returns 'Similarity: <cosine> (threshold: <t>)'
    # (cobalt/evaluators/similarity.py:54-57); every fallback reason starts with
    # 'Fallback'.
    assert 'Fallback' not in result['reasoning']
    assert result['reasoning'].startswith('Similarity:')


@_requires_cobalt
def test_similarity_real_library_disagrees_with_the_fallback():
    """The cobalt lane must not silently reproduce the Jaccard fallback.

    TF-IDF cosine weights terms; Jaccard counts set overlap. On a partially
    overlapping pair the two disagree, so an equal score here means the real
    evaluator never ran. (A reordered sentence is no good as a probe: both
    metrics score it 1.0, which is why the reasoning assertion above carries
    the identical-wording case.)
    """
    evaluator = CobaltEvaluator({'eval_type': 'similarity', 'threshold': 0.5}, {})
    output, expected = 'the quick brown fox', 'a fast brown fox jumps over it'

    live = evaluator.evaluate_semantic(output, expected)
    fallback = CobaltEvaluator._fallback_semantic(output, expected, 0.5)

    assert live['reasoning'].startswith('Similarity:')
    assert fallback['reasoning'].startswith('Fallback')
    assert live['score'] != fallback['score']


@_requires_cobalt
def test_similarity_below_the_threshold_fails_on_the_raw_cosine():
    """A cosine under the threshold must fail, and the score must be that cosine.

    cobalt's similarity handler returns ``1.0 if sim >= t else sim / t``
    (cobalt/evaluators/similarity.py:53) — a threshold-normalised value, not the
    cosine. Handing it this node's threshold and then comparing what came back
    with the same threshold again applied it twice, so every cosine in
    ``[t**2, t)`` was reported as a pass: this pair's cosine is 0.2606 and it
    passed at a threshold of 0.5 with a score of 0.5211. The node now asks cobalt
    for the raw cosine (threshold 1.0) and applies its own threshold once.
    """
    evaluator = CobaltEvaluator({'eval_type': 'similarity', 'threshold': 0.5}, {})
    result = evaluator.evaluate_semantic('the quick brown fox', 'a fast brown fox jumps over it')

    # The cosine is in cobalt's own reason either way; the score is what moved.
    assert result['reasoning'].startswith('Similarity: 0.2606')
    assert abs(result['score'] - 0.2606) < 1e-4
    assert result['passed'] is False


@_requires_cobalt
@pytest.mark.skipif(not os.getenv('OPENAI_API_KEY'), reason='requires OPENAI_API_KEY for llm_judge integration')
def test_llm_judge_real_library_path():
    """Drive llm_judge evaluation through the real library + real API.

    This test only runs when OPENAI_API_KEY is set in the environment,
    since the evaluator will make a live API call. It asserts the result
    is well-formed and the score is a valid probability.
    """
    evaluator = CobaltEvaluator(
        {
            'eval_type': 'llm_judge',
            'threshold': 0.5,
            'model': 'gpt-4',
            'criteria': 'Is the output a correct and concise answer to the question?',
            'apikey': os.environ['OPENAI_API_KEY'],
        },
        {},
    )
    result = evaluator.evaluate_llm_judge(
        output='The capital of France is Paris.',
        expected='Paris is the capital of France.',
    )

    assert isinstance(result, dict)
    assert result['evaluator'] == 'llm_judge'
    assert 0.0 <= result['score'] <= 1.0
    assert isinstance(result['passed'], bool)
    # A ValueError from the registry or a TypeError from the call shape would
    # otherwise read as a pass.
    assert not result['reasoning'].startswith('Evaluation failed:')


def test_custom_real_library_path():
    """Exercise the custom-function dispatch end-to-end.

    Custom mode never touches the `cobalt` library: user code provides the
    scoring callable. We still keep this test under the `integration` marker
    so the three evaluator modes are always covered together.
    """
    observed_calls = []

    def custom_scorer(output, expected):
        observed_calls.append((output, expected))
        return {'score': 0.87, 'reasoning': 'deterministic custom scorer'}

    evaluator = CobaltEvaluator(
        {'eval_type': 'custom', 'threshold': 0.5, 'custom_fn': custom_scorer},
        {},
    )
    result = evaluator.evaluate_custom('the quick brown fox', 'the quick brown fox')

    assert len(observed_calls) == 1
    assert observed_calls[0] == ('the quick brown fox', 'the quick brown fox')
    assert result['score'] == 0.87
    assert result['passed'] is True
    assert result['evaluator'] == 'custom'
