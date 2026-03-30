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

"""Tests for the Cobalt Evaluator node.

All tests use mocks — no real Cobalt AI or external API calls are made.
"""

import copy
import os
import pathlib
import sys
from types import ModuleType
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Mock infrastructure — rocketlib, ai.common, depends, cobalt
# ---------------------------------------------------------------------------


def _setup_mocks():
    """Set up the mock modules required to import the eval_cobalt node."""
    # rocketlib mocks
    rocketlib = ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()
    rocketlib.warning = MagicMock()
    rocketlib.debug = MagicMock()
    rocketlib.Entry = type('Entry', (), {})()
    sys.modules['rocketlib'] = rocketlib
    sys.modules['rocketlib.types'] = ModuleType('rocketlib.types')

    # ai.common mocks
    ai_mod = ModuleType('ai')
    ai_common = ModuleType('ai.common')
    ai_common_config = ModuleType('ai.common.config')
    ai_common_schema = ModuleType('ai.common.schema')

    class MockConfig:
        @staticmethod
        def getNodeConfig(logical_type, conn_config):
            return conn_config

    ai_common_config.Config = MockConfig

    class MockAnswer:
        def __init__(self, expectJson=False):
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

    ai_common_schema.Answer = MockAnswer

    sys.modules['ai'] = ai_mod
    sys.modules['ai.common'] = ai_common
    sys.modules['ai.common.config'] = ai_common_config
    sys.modules['ai.common.schema'] = ai_common_schema

    # depends mock
    depends_mod = ModuleType('depends')
    depends_mod.depends = MagicMock()
    sys.modules['depends'] = depends_mod

    # cobalt mock — we intentionally do NOT register it in sys.modules so that
    # the top-level `from cobalt import Evaluator` in cobalt_evaluator.py fails
    # and _cobalt_available stays False.  Individual tests that need cobalt
    # available patch _cobalt_available and Evaluator directly.

    # rocketride mock (Answer re-export path)
    rocketride_pkg = ModuleType('rocketride')
    rocketride_pkg.Answer = MockAnswer
    sys.modules['rocketride'] = rocketride_pkg

    return MockAnswer


MockAnswer = _setup_mocks()

# Now import the module under test
_NODES_DIR = str(pathlib.Path(__file__).resolve().parent.parent.parent / 'nodes' / 'src' / 'nodes')
sys.path.insert(0, _NODES_DIR)
from eval_cobalt.cobalt_evaluator import CobaltEvaluator


# ===========================================================================
# CobaltEvaluator unit tests
# ===========================================================================


class TestCobaltEvaluatorInit:
    """Test CobaltEvaluator initialization."""

    def test_default_config(self):
        config = {}
        bag = {}
        evaluator = CobaltEvaluator(config, bag)
        assert evaluator._eval_type == 'similarity'
        assert evaluator._threshold == 0.7
        assert evaluator._model == 'gpt-4'

    def test_custom_config(self):
        config = {
            'eval_type': 'llm_judge',
            'threshold': 0.9,
            'model': 'claude-3',
            'criteria': 'Is it accurate?',
            'apikey': 'test-key-123',
        }
        bag = {'pipeline': 'test'}
        evaluator = CobaltEvaluator(config, bag)
        assert evaluator._eval_type == 'llm_judge'
        assert evaluator._threshold == 0.9
        assert evaluator._model == 'claude-3'
        assert evaluator._criteria == 'Is it accurate?'
        assert evaluator._apikey == 'test-key-123'

    def test_invalid_eval_type_falls_back_to_similarity(self):
        config = {'eval_type': 'nonexistent'}
        evaluator = CobaltEvaluator(config, {})
        assert evaluator._eval_type == 'similarity'

    def test_threshold_as_string(self):
        config = {'threshold': '0.85'}
        evaluator = CobaltEvaluator(config, {})
        assert evaluator._threshold == 0.85


class TestSemanticEvaluation:
    """Test semantic similarity evaluation."""

    def test_high_similarity(self):
        evaluator = CobaltEvaluator({'threshold': 0.3}, {})
        result = evaluator.evaluate_semantic(
            'The capital of France is Paris',
            'Paris is the capital of France',
        )
        assert result['evaluator'] == 'semantic'
        assert result['score'] > 0.0
        assert result['passed'] is True
        assert 'reasoning' in result

    def test_low_similarity(self):
        evaluator = CobaltEvaluator({'threshold': 0.9}, {})
        result = evaluator.evaluate_semantic(
            'The weather is sunny today',
            'Python is a programming language',
        )
        assert result['evaluator'] == 'semantic'
        assert result['score'] < 0.9
        assert result['passed'] is False

    def test_empty_output(self):
        evaluator = CobaltEvaluator({'threshold': 0.5}, {})
        result = evaluator.evaluate_semantic('', 'some expected text')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_empty_expected(self):
        evaluator = CobaltEvaluator({'threshold': 0.5}, {})
        result = evaluator.evaluate_semantic('some output', '')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_both_empty(self):
        evaluator = CobaltEvaluator({'threshold': 0.5}, {})
        result = evaluator.evaluate_semantic('', '')
        assert result['score'] == 1.0
        assert result['passed'] is True

    def test_identical_text_scores_high(self):
        evaluator = CobaltEvaluator({'threshold': 0.9}, {})
        text = 'The quick brown fox jumps over the lazy dog'
        result = evaluator.evaluate_semantic(text, text)
        assert result['score'] == 1.0
        assert result['passed'] is True

    def test_threshold_override(self):
        evaluator = CobaltEvaluator({'threshold': 0.1}, {})
        result = evaluator.evaluate_semantic(
            'hello world',
            'hello world',
            threshold=0.99,
        )
        assert result['score'] == 1.0
        assert result['passed'] is True


class TestLLMJudgeEvaluation:
    """Test LLM-as-judge evaluation (mocked)."""

    def test_llm_judge_no_apikey(self):
        evaluator = CobaltEvaluator({'eval_type': 'llm_judge', 'apikey': ''}, {})
        result = evaluator.evaluate_llm_judge('some output', 'expected')
        assert result['passed'] is False
        assert 'API key' in result['reasoning']
        assert result['evaluator'] == 'llm_judge'

    def test_llm_judge_empty_output(self):
        evaluator = CobaltEvaluator({'eval_type': 'llm_judge', 'apikey': 'key'}, {})
        result = evaluator.evaluate_llm_judge('', 'expected')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_llm_judge_with_mocked_cobalt(self):
        """Test that the evaluator calls cobalt correctly when available."""
        mock_evaluator_instance = MagicMock()
        mock_evaluator_instance.evaluate_llm_judge.return_value = {
            'score': 0.85,
            'reasoning': 'Output is accurate and well-structured',
        }

        with patch('eval_cobalt.cobalt_evaluator._cobalt_available', True), patch('eval_cobalt.cobalt_evaluator.Evaluator', return_value=mock_evaluator_instance):
            evaluator = CobaltEvaluator({'eval_type': 'llm_judge', 'apikey': 'test-key', 'threshold': 0.7}, {})
            result = evaluator.evaluate_llm_judge('The answer is 42', 'expected 42')

        assert result['score'] == 0.85
        assert result['passed'] is True
        assert result['evaluator'] == 'llm_judge'

    def test_llm_judge_cobalt_exception(self):
        """Test graceful handling when cobalt raises an exception."""
        mock_evaluator_instance = MagicMock()
        mock_evaluator_instance.evaluate_llm_judge.side_effect = RuntimeError('API timeout')

        with patch('eval_cobalt.cobalt_evaluator._cobalt_available', True), patch('eval_cobalt.cobalt_evaluator.Evaluator', return_value=mock_evaluator_instance):
            evaluator = CobaltEvaluator({'eval_type': 'llm_judge', 'apikey': 'test-key', 'threshold': 0.5}, {})
            result = evaluator.evaluate_llm_judge('some output', 'expected')

        assert result['score'] == 0.0
        assert result['passed'] is False
        assert 'RuntimeError' in result['reasoning']


class TestCustomEvaluation:
    """Test custom function evaluation."""

    def test_custom_with_dict_return(self):
        def my_eval(output, expected):
            return {'score': 0.95, 'reasoning': 'Looks great'}

        evaluator = CobaltEvaluator({'eval_type': 'custom', 'threshold': 0.5}, {})
        result = evaluator.evaluate_custom('output', 'expected', eval_fn=my_eval)
        assert result['score'] == 0.95
        assert result['passed'] is True
        assert result['evaluator'] == 'custom'

    def test_custom_with_numeric_return(self):
        def my_eval(output, expected):
            return 0.6

        evaluator = CobaltEvaluator({'eval_type': 'custom', 'threshold': 0.5}, {})
        result = evaluator.evaluate_custom('output', 'expected', eval_fn=my_eval)
        assert result['score'] == 0.6
        assert result['passed'] is True

    def test_custom_no_function_provided(self):
        evaluator = CobaltEvaluator({'eval_type': 'custom'}, {})
        result = evaluator.evaluate_custom('output', 'expected')
        assert result['score'] == 0.0
        assert result['passed'] is False
        assert 'No custom evaluation function' in result['reasoning']

    def test_custom_function_raises_exception(self):
        def bad_eval(output, expected):
            raise ValueError('broken')

        evaluator = CobaltEvaluator({'eval_type': 'custom', 'threshold': 0.5}, {})
        result = evaluator.evaluate_custom('output', 'expected', eval_fn=bad_eval)
        assert result['score'] == 0.0
        assert result['passed'] is False
        assert 'ValueError' in result['reasoning']

    def test_custom_function_unexpected_return_type(self):
        def string_eval(output, expected):
            return 'not a score'

        evaluator = CobaltEvaluator({'eval_type': 'custom', 'threshold': 0.5}, {})
        result = evaluator.evaluate_custom('output', 'expected', eval_fn=string_eval)
        assert result['score'] == 0.0
        assert 'Unexpected return type' in result['reasoning']


class TestThresholdEnforcement:
    """Test pass/fail threshold enforcement across evaluator types."""

    def test_exact_threshold_passes(self):
        result = CobaltEvaluator._make_result(0.7, 0.7, 'test', 'test')
        assert result['passed'] is True

    def test_below_threshold_fails(self):
        result = CobaltEvaluator._make_result(0.69, 0.7, 'test', 'test')
        assert result['passed'] is False

    def test_above_threshold_passes(self):
        result = CobaltEvaluator._make_result(0.71, 0.7, 'test', 'test')
        assert result['passed'] is True

    def test_score_clamped_to_0_1(self):
        result = CobaltEvaluator._make_result(1.5, 0.7, 'test', 'test')
        assert result['score'] == 1.0

        result = CobaltEvaluator._make_result(-0.5, 0.7, 'test', 'test')
        assert result['score'] == 0.0


class TestEvaluateDispatch:
    """Test the evaluate() dispatch method."""

    def test_dispatch_similarity(self):
        evaluator = CobaltEvaluator({'eval_type': 'similarity', 'threshold': 0.3}, {})
        result = evaluator.evaluate('hello world', 'hello world')
        assert result['evaluator'] == 'semantic'

    def test_dispatch_llm_judge(self):
        evaluator = CobaltEvaluator({'eval_type': 'llm_judge', 'apikey': ''}, {})
        result = evaluator.evaluate('hello', 'hello')
        assert result['evaluator'] == 'llm_judge'

    def test_dispatch_custom(self):
        evaluator = CobaltEvaluator({'eval_type': 'custom'}, {})
        result = evaluator.evaluate('hello', 'hello')
        assert result['evaluator'] == 'custom'

    def test_dispatch_with_override(self):
        evaluator = CobaltEvaluator({'eval_type': 'similarity', 'apikey': ''}, {})
        result = evaluator.evaluate('hello', 'hello', eval_type='llm_judge')
        assert result['evaluator'] == 'llm_judge'


class TestDeepCopyPrevention:
    """Test that deep copy prevents mutation of the original answer."""

    def test_deep_copy_prevents_mutation(self):
        original = MockAnswer()
        original.setAnswer('original text')

        copied = copy.deepcopy(original)
        copied.setAnswer('mutated text')

        assert original.getText() == 'original text'
        assert copied.getText() == 'mutated text'


class TestIInstanceWriteAnswers:
    """Test the IInstance.writeAnswers method with mocked infrastructure."""

    def _make_iinstance(self):
        """Create a mock IInstance with the required IGlobal evaluator."""
        from eval_cobalt.IInstance import IInstance

        inst = IInstance.__new__(IInstance)

        # Mock IGlobal with an evaluator
        mock_iglobal = MagicMock()
        evaluator = CobaltEvaluator({'eval_type': 'similarity', 'threshold': 0.3}, {})
        mock_iglobal._evaluator = evaluator
        inst.IGlobal = mock_iglobal

        # Mock the instance object (C++ bridge)
        inst.instance = MagicMock()

        return inst

    def test_writeAnswers_forwards_original(self):
        inst = self._make_iinstance()

        answer = MockAnswer()
        answer.setAnswer('test answer text')

        inst.writeAnswers(answer)

        # Should be called twice: once with the original, once with eval result
        assert inst.instance.writeAnswers.call_count == 2

    def test_writeAnswers_emits_eval_metadata(self):
        inst = self._make_iinstance()

        answer = MockAnswer()
        answer.setAnswer('test answer text')

        inst.writeAnswers(answer)

        # The second call should be the evaluation result (JSON answer)
        calls = inst.instance.writeAnswers.call_args_list
        assert len(calls) == 2

        eval_answer = calls[1][0][0]
        assert eval_answer.isJson() is True
        json_data = eval_answer.getJson()
        assert 'cobalt_score' in json_data
        assert 'cobalt_passed' in json_data
        assert 'cobalt_evaluator' in json_data
        assert 'cobalt_reasoning' in json_data

    def test_writeAnswers_passes_through_when_no_evaluator(self):
        from eval_cobalt.IInstance import IInstance

        inst = IInstance.__new__(IInstance)
        mock_iglobal = MagicMock()
        mock_iglobal._evaluator = None
        inst.IGlobal = mock_iglobal
        inst.instance = MagicMock()

        answer = MockAnswer()
        answer.setAnswer('test')

        inst.writeAnswers(answer)

        # Should forward once without evaluation
        assert inst.instance.writeAnswers.call_count == 1

    def test_writeAnswers_deep_copies_answer(self):
        inst = self._make_iinstance()

        answer = MockAnswer()
        answer.setAnswer('original')

        inst.writeAnswers(answer)

        # Original should not be mutated
        assert answer.getText() == 'original'


class TestIGlobalLifecycle:
    """Test IGlobal beginGlobal/endGlobal lifecycle."""

    def test_begin_global_creates_evaluator(self):
        from eval_cobalt.IGlobal import IGlobal

        iglobal = IGlobal.__new__(IGlobal)

        # Mock the IEndpoint
        mock_endpoint = MagicMock()
        mock_endpoint.endpoint.openMode = 'RUN'
        mock_endpoint.endpoint.bag = {'test': True}
        iglobal.IEndpoint = mock_endpoint

        # Mock glb
        mock_glb = MagicMock()
        mock_glb.logicalType = 'eval_cobalt'
        mock_glb.connConfig = {'eval_type': 'similarity', 'threshold': 0.8}
        iglobal.glb = mock_glb

        iglobal.beginGlobal()

        assert iglobal._evaluator is not None

    def test_begin_global_config_mode_skips(self):
        from eval_cobalt.IGlobal import IGlobal

        iglobal = IGlobal.__new__(IGlobal)

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint.openMode = sys.modules['rocketlib'].OPEN_MODE.CONFIG
        iglobal.IEndpoint = mock_endpoint

        iglobal._evaluator = None
        iglobal.beginGlobal()

        assert iglobal._evaluator is None

    def test_end_global_clears_evaluator(self):
        from eval_cobalt.IGlobal import IGlobal

        iglobal = IGlobal.__new__(IGlobal)
        iglobal._evaluator = MagicMock()

        iglobal.endGlobal()

        assert iglobal._evaluator is None
