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

    pytest -m integration test/nodes/test_eval_cobalt_integration.py
"""

import os
import pathlib
import sys
from types import ModuleType
from unittest.mock import MagicMock

import pytest

# Skip the whole module when the real cobalt library is not installed.
# The basalt-ai-cobalt package exposes its API under the `cobalt` module name.
cobalt = pytest.importorskip('cobalt', reason='requires basalt-ai-cobalt to be installed')

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Minimal rocketlib / ai.common stubs so CobaltEvaluator can be imported
# outside the RocketRide engine runtime. We deliberately do NOT mock `cobalt`
# here — the point of these tests is to exercise the real library path.
# ---------------------------------------------------------------------------

_NODES_DIR = str(pathlib.Path(__file__).resolve().parents[2] / 'nodes' / 'src' / 'nodes')

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


class _StubConfig:
    @staticmethod
    def getNodeConfig(logical_type, conn_config):
        return conn_config


_ai_common_config.Config = _StubConfig


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


_ai_common_schema.Answer = _StubAnswer

_STUB_MODULES = {
    'rocketlib': _rocketlib,
    'ai': _ai_mod,
    'ai.common': _ai_common,
    'ai.common.config': _ai_common_config,
    'ai.common.schema': _ai_common_schema,
}

for _name, _mod in _STUB_MODULES.items():
    sys.modules.setdefault(_name, _mod)

if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)

from eval_cobalt.cobalt_evaluator import CobaltEvaluator  # noqa: E402


# ---------------------------------------------------------------------------
# Integration tests — one per evaluation mode
# ---------------------------------------------------------------------------


def test_similarity_real_library_path():
    """Drive similarity evaluation through the real `cobalt.Evaluator`.

    Verifies the configured CobaltEvaluator can call into the live library
    and produces a well-formed result dict. The only assertion on the score
    itself is that it is a valid probability: the actual value depends on
    the installed library version.
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
    assert 'reasoning' in result


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
