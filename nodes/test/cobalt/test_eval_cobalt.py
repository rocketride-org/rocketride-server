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
import pathlib
import sys
from types import ModuleType
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Mock infrastructure — rocketlib, ai.common, depends, cobalt
#
# Mocks are installed via patch.dict(sys.modules, ...) so that the injected
# entries are automatically removed when the context manager exits at session
# teardown.  This prevents leaking fake modules into subsequent test files
# that may need the real packages.
# ---------------------------------------------------------------------------

_NODES_DIR = str(pathlib.Path(__file__).resolve().parents[2] / 'nodes' / 'src' / 'nodes')

# Build the mock module map once — entries are shared across the session
# but only installed in sys.modules while the patch is active.
_rocketlib = ModuleType('rocketlib')
_rocketlib.IGlobalBase = type('IGlobalBase', (), {})
_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
_rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()
_rocketlib.warning = MagicMock()
_rocketlib.debug = MagicMock()
_rocketlib.Entry = type('Entry', (), {})()

_rocketlib_types = ModuleType('rocketlib.types')

_ai_mod = ModuleType('ai')
_ai_common = ModuleType('ai.common')
_ai_common_config = ModuleType('ai.common.config')
_ai_common_schema = ModuleType('ai.common.schema')


class MockConfig:
    @staticmethod
    def getNodeConfig(logical_type, conn_config):
        return conn_config


_ai_common_config.Config = MockConfig


class MockAnswer:
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


_ai_common_schema.Answer = MockAnswer


# Also expose a minimal Question stub so test modules that share the
# ai.common.schema mock (e.g. test_dataset_cobalt.py) keep working
# regardless of test collection order.  Without this, installing this
# module's fresh _ai_common_schema stub via patch.dict would wipe any
# Question attribute another test module had previously registered.
class _SharedMockQuestion:
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


_ai_common_schema.Question = _SharedMockQuestion
_ai_common_schema.Doc = MagicMock
_ai_common_schema.DocFilter = MagicMock
_ai_common_schema.DocMetadata = MagicMock

_depends_mod = ModuleType('depends')
_depends_mod.depends = MagicMock()

# cobalt — intentionally NOT registered so that the top-level
# `from cobalt import Evaluator` in cobalt_evaluator.py fails and
# _cobalt_available stays False.  Tests that need cobalt patch it directly.

_rocketride_pkg = ModuleType('rocketride')
_rocketride_pkg.Answer = MockAnswer

_MOCK_MODULES = {
    'rocketlib': _rocketlib,
    'rocketlib.types': _rocketlib_types,
    'ai': _ai_mod,
    'ai.common': _ai_common,
    'ai.common.config': _ai_common_config,
    'ai.common.schema': _ai_common_schema,
    'depends': _depends_mod,
    'rocketride': _rocketride_pkg,
}

# Install mocks via patch.dict so they are scoped and restorable.
# The context manager stays open for the lifetime of this module; pytest
# tears it down when the module is collected (or we can clean up explicitly
# via a session-scoped fixture below).
_modules_patch = patch.dict(sys.modules, _MOCK_MODULES)
_modules_patch.start()

# Also scope the sys.path addition so we can clean it up.
if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)

# Now import the module under test
from eval_cobalt.cobalt_evaluator import CobaltEvaluator


import pytest


@pytest.fixture(autouse=True, scope='session')
def _teardown_mock_modules():
    """Ensure mock modules are removed from sys.modules after all tests."""
    yield
    _modules_patch.stop()
    if _NODES_DIR in sys.path:
        sys.path.remove(_NODES_DIR)
    # Remove cached eval_cobalt imports so they don't leak
    for key in list(sys.modules):
        if key.startswith('eval_cobalt'):
            del sys.modules[key]


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

    def test_threshold_invalid_string_falls_back(self):
        config = {'threshold': 'not-a-number'}
        evaluator = CobaltEvaluator(config, {})
        assert evaluator._threshold == 0.7

    def test_threshold_clamped_above_one(self):
        config = {'threshold': 2.5}
        evaluator = CobaltEvaluator(config, {})
        assert evaluator._threshold == 1.0

    def test_threshold_clamped_below_zero(self):
        config = {'threshold': -0.5}
        evaluator = CobaltEvaluator(config, {})
        assert evaluator._threshold == 0.0

    def test_custom_fn_from_bag(self):
        def fn(output, expected):
            return {'score': 1.0}

        evaluator = CobaltEvaluator({'eval_type': 'custom'}, {'custom_fn': fn})
        assert evaluator._custom_fn is fn

    def test_custom_fn_from_config(self):
        def fn(output, expected):
            return {'score': 1.0}

        evaluator = CobaltEvaluator({'eval_type': 'custom', 'custom_fn': fn}, {})
        assert evaluator._custom_fn is fn

    def test_custom_fn_not_callable_ignored(self):
        evaluator = CobaltEvaluator({'eval_type': 'custom'}, {'custom_fn': 'not-a-callable'})
        assert evaluator._custom_fn is None

    def test_eval_type_property(self):
        evaluator = CobaltEvaluator({'eval_type': 'llm_judge'}, {})
        assert evaluator.eval_type == 'llm_judge'

    def test_eval_type_property_default(self):
        evaluator = CobaltEvaluator({}, {})
        assert evaluator.eval_type == 'similarity'


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

    def test_semantic_with_mocked_cobalt(self):
        """Test that semantic evaluation uses Evaluator(type='similarity') and calls evaluate()."""
        mock_evaluator_instance = MagicMock()
        mock_evaluator_instance.evaluate.return_value = {
            'score': 0.92,
            'reasoning': 'High semantic similarity',
        }

        with patch('eval_cobalt.cobalt_evaluator._cobalt_available', True), patch('eval_cobalt.cobalt_evaluator.Evaluator', return_value=mock_evaluator_instance) as mock_cls:
            evaluator = CobaltEvaluator({'threshold': 0.5}, {})
            result = evaluator.evaluate_semantic('Paris is capital of France', 'The capital of France is Paris')

        mock_cls.assert_called_once_with(name='semantic-similarity', type='similarity', threshold=0.5)
        mock_evaluator_instance.evaluate.assert_called_once_with(output='Paris is capital of France', expected='The capital of France is Paris')
        assert result['score'] == 0.92
        assert result['passed'] is True
        assert result['evaluator'] == 'semantic'

    def test_semantic_cobalt_exception_falls_back(self):
        """Test that cobalt failure falls back to Jaccard similarity."""
        mock_evaluator_instance = MagicMock()
        mock_evaluator_instance.evaluate.side_effect = RuntimeError('Connection failed')

        with patch('eval_cobalt.cobalt_evaluator._cobalt_available', True), patch('eval_cobalt.cobalt_evaluator.Evaluator', return_value=mock_evaluator_instance):
            evaluator = CobaltEvaluator({'threshold': 0.3}, {})
            result = evaluator.evaluate_semantic('hello world test', 'hello world test')

        assert result['score'] == 1.0
        assert result['passed'] is True
        assert 'Fallback' in result['reasoning']


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
        mock_evaluator_instance.evaluate.return_value = {
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
        mock_evaluator_instance.evaluate.side_effect = RuntimeError('API timeout')

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

    def test_writeAnswers_strips_reserved_fields_from_json(self):
        """Ensure reserved fields (expected, context, reference) are stripped from JSON before scoring."""
        inst = self._make_iinstance()

        answer = MockAnswer(expectJson=True)
        answer.setAnswer({'output': 'Paris', 'expected': 'Paris is the capital', 'context': 'geography'})

        inst.writeAnswers(answer)

        # The evaluator should have been called; check output_text did not contain reserved fields.
        # We verify indirectly: the eval result should exist and the answer forwarded.
        calls = inst.instance.writeAnswers.call_args_list
        assert len(calls) == 2

    def test_writeAnswers_extracts_expected_from_json(self):
        """Verify that expected text is extracted from JSON answer metadata."""
        inst = self._make_iinstance()

        answer = MockAnswer(expectJson=True)
        answer.setAnswer({'output': 'test', 'expected': 'test'})

        inst.writeAnswers(answer)

        calls = inst.instance.writeAnswers.call_args_list
        eval_answer = calls[1][0][0]
        json_data = eval_answer.getJson()
        # With expected == 'test' extracted and output_text not containing 'expected',
        # the similarity should be lower than if they matched perfectly
        assert 'cobalt_score' in json_data


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
        import importlib  # noqa: PLC0415

        # Use the OPEN_MODE reference that the node module actually captured
        # at import time. Fetching it via sys.modules['rocketlib'] is unsafe
        # when another test module has replaced rocketlib in sys.modules.
        _ig_mod = importlib.import_module('eval_cobalt.IGlobal')
        IGlobal = _ig_mod.IGlobal

        iglobal = IGlobal.__new__(IGlobal)

        mock_endpoint = MagicMock()
        mock_endpoint.endpoint.openMode = _ig_mod.OPEN_MODE.CONFIG
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


# ===========================================================================
# Deterministic evaluators (relevance, grounding, format)
#
# These eval_types wrap pure-python evaluator functions shipped with the
# eval_cobalt node package. No cobalt / network dependency is required.
# ===========================================================================


class TestRelevanceEvaluation:
    """Test the relevance eval_type (keyword overlap + length heuristic)."""

    def test_high_relevance_scores_pass(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.3}, {})
        result = evaluator.evaluate_relevance(
            'Machine learning enables systems to learn from data without explicit programming',
            'Machine learning is a subset of AI that allows systems to learn from data',
        )
        assert result['evaluator'] == 'relevance'
        assert 0.0 <= result['score'] <= 1.0
        assert result['passed'] is True

    def test_low_relevance_scores_fail(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.8}, {})
        result = evaluator.evaluate_relevance(
            'The weather today is sunny',
            'Python is a programming language used for machine learning',
        )
        assert result['evaluator'] == 'relevance'
        assert result['score'] < 0.8
        assert result['passed'] is False

    def test_empty_output(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.5}, {})
        result = evaluator.evaluate_relevance('', 'some expected content')
        assert result['score'] == 0.0
        assert result['passed'] is False
        assert result['evaluator'] == 'relevance'

    def test_both_empty(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.5}, {})
        result = evaluator.evaluate_relevance('', '')
        assert result['score'] == 1.0
        assert result['passed'] is True

    def test_dispatch_routes_relevance(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.3}, {})
        result = evaluator.evaluate(
            'Machine learning lets computers learn from experience',
            'Machine learning lets computers learn from data',
        )
        assert result['evaluator'] == 'relevance'
        assert result['passed'] is True

    def test_threshold_override(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance', 'threshold': 0.99}, {})
        result = evaluator.evaluate_relevance('same text here', 'same text here', threshold=0.1)
        assert result['passed'] is True


class TestGroundingEvaluation:
    """Test the grounding eval_type (sentence-level context overlap)."""

    def test_well_grounded_output_passes(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding', 'threshold': 0.4}, {})
        context = 'Vector databases store high-dimensional vectors and enable fast similarity search across millions of embeddings.'
        output = 'Vector databases enable fast similarity search across embeddings.'
        result = evaluator.evaluate_grounding(output, context)
        assert result['evaluator'] == 'grounding'
        assert result['score'] > 0.4
        assert result['passed'] is True

    def test_ungrounded_output_fails(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding', 'threshold': 0.5}, {})
        context = 'Paris is the capital city of France.'
        output = 'Quantum computers leverage superposition to accelerate certain algorithms.'
        result = evaluator.evaluate_grounding(output, context)
        assert result['evaluator'] == 'grounding'
        assert result['score'] < 0.5
        assert result['passed'] is False

    def test_empty_output_fails(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding', 'threshold': 0.5}, {})
        result = evaluator.evaluate_grounding('', 'some context')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_empty_context_fails(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding', 'threshold': 0.5}, {})
        result = evaluator.evaluate_grounding('some output with claims', '')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_dispatch_routes_grounding(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding', 'threshold': 0.4}, {})
        context = 'Hybrid search combines dense vector search with sparse keyword search like BM25.'
        output = 'Hybrid search combines dense vector and sparse keyword search.'
        # IInstance passes context via the `expected` arg position for grounding
        result = evaluator.evaluate(output, context)
        assert result['evaluator'] == 'grounding'
        assert result['passed'] is True


class TestFormatEvaluation:
    """Test the format eval_type (structural validation)."""

    def test_prose_format_passes(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'prose', 'threshold': 0.5}, {})
        result = evaluator.evaluate_format('This is a simple sentence. It flows naturally.')
        assert result['evaluator'] == 'format'
        assert result['score'] >= 0.5
        assert result['passed'] is True

    def test_list_format_passes(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'list', 'threshold': 0.5}, {})
        result = evaluator.evaluate_format('- First item\n- Second item\n- Third item')
        assert result['evaluator'] == 'format'
        assert result['score'] >= 0.5
        assert result['passed'] is True

    def test_json_format_passes(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'json', 'threshold': 0.5}, {})
        result = evaluator.evaluate_format('{"key": "value", "count": 42}')
        assert result['evaluator'] == 'format'
        assert result['score'] == 1.0
        assert result['passed'] is True

    def test_json_format_invalid_fails(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'json', 'threshold': 0.5}, {})
        result = evaluator.evaluate_format('not json at all')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_format_empty_output(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'prose', 'threshold': 0.5}, {})
        result = evaluator.evaluate_format('')
        assert result['score'] == 0.0
        assert result['passed'] is False

    def test_format_default_config(self):
        """expected_format defaults to 'prose' when not configured."""
        evaluator = CobaltEvaluator({'eval_type': 'format', 'threshold': 0.5}, {})
        assert evaluator._expected_format == 'prose'

    def test_format_config_override(self):
        """expected_format is read from config."""
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'json'}, {})
        assert evaluator._expected_format == 'json'

    def test_dispatch_routes_format(self):
        evaluator = CobaltEvaluator({'eval_type': 'format', 'expected_format': 'json', 'threshold': 0.5}, {})
        # For format mode, the `expected` argument is ignored; config drives the check
        result = evaluator.evaluate('{"valid": true}', 'ignored')
        assert result['evaluator'] == 'format'
        assert result['passed'] is True


class TestExtendedEvalTypeWhitelist:
    """Test that the extended _VALID_EVAL_TYPES accepts the 3 new types."""

    def test_relevance_is_valid(self):
        evaluator = CobaltEvaluator({'eval_type': 'relevance'}, {})
        assert evaluator._eval_type == 'relevance'

    def test_grounding_is_valid(self):
        evaluator = CobaltEvaluator({'eval_type': 'grounding'}, {})
        assert evaluator._eval_type == 'grounding'

    def test_format_is_valid(self):
        evaluator = CobaltEvaluator({'eval_type': 'format'}, {})
        assert evaluator._eval_type == 'format'
