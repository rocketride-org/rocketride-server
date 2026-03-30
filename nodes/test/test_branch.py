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

"""
Tests for the Conditional Branch pipeline node.

Covers:
- BranchEngine condition evaluators (contains, regex, length, score_threshold,
  field_equals, sentiment, always_true, always_false)
- Rule ordering and first-match-wins semantics
- Default lane routing when no rules match
- IGlobal / IInstance lifecycle (import-level validation)
- Deep copy mutation prevention
- services.json contract validation
"""

import copy
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
NODES_SRC = Path(__file__).parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

# ---------------------------------------------------------------------------
# Mock engine runtime modules before any node import
# ---------------------------------------------------------------------------


class _MockIGlobalBase:
    IEndpoint = None
    glb = None

    def beginGlobal(self):
        pass

    def endGlobal(self):
        pass


class _MockIInstanceBase:
    IGlobal = None
    IEndpoint = None
    instance = None

    def beginInstance(self):
        pass

    def endInstance(self):
        pass

    def preventDefault(self):
        raise Exception('PreventDefault')

    def writeText(self, text):
        pass

    def writeQuestions(self, q):
        pass

    def writeDocuments(self, docs):
        pass

    def writeAnswers(self, a):
        pass

    def writeTable(self, t):
        pass

    def writeImage(self, *args):
        pass

    def writeAudio(self, *args):
        pass

    def writeVideo(self, *args):
        pass

    def writeClassifications(self, *args):
        pass

    def open(self, obj):
        pass

    def closing(self):
        pass

    def close(self):
        pass


class _MockOPEN_MODE:
    CONFIG = 'CONFIG'
    SOURCE = 'SOURCE'
    TARGET = 'TARGET'


class _MockQuestion:
    def __init__(self, **kwargs):
        self.questions = []
        self.context = []

    def addQuestion(self, text):
        self.questions.append({'text': text})

    def addContext(self, ctx):
        self.context.append(ctx)

    def getPrompt(self):
        parts = [q['text'] for q in self.questions]
        return ' '.join(parts) if parts else ''

    def model_dump(self):
        return {'questions': self.questions, 'context': self.context}


class _MockAnswer:
    def __init__(self, **kwargs):
        self._text = kwargs.get('text', '')

    def getText(self):
        return self._text

    def setText(self, text):
        self._text = text

    def model_dump(self):
        return {'text': self._text}


def _install_mocks():
    """Install mock modules for rocketlib, ai.common.schema, etc."""
    mock_rocketlib = types.ModuleType('rocketlib')
    mock_rocketlib.IGlobalBase = _MockIGlobalBase
    mock_rocketlib.IInstanceBase = _MockIInstanceBase
    mock_rocketlib.OPEN_MODE = _MockOPEN_MODE
    mock_rocketlib.Entry = MagicMock
    mock_rocketlib.debug = lambda *a, **kw: None

    mock_ai = types.ModuleType('ai')
    mock_ai_common = types.ModuleType('ai.common')
    mock_ai_schema = types.ModuleType('ai.common.schema')
    mock_ai_schema.Question = _MockQuestion
    mock_ai_schema.Answer = _MockAnswer
    mock_ai_schema.Doc = MagicMock

    mock_ai_config = types.ModuleType('ai.common.config')
    mock_config_cls = MagicMock()
    mock_config_cls.getNodeConfig = Mock(return_value={})
    mock_ai_config.Config = mock_config_cls

    mock_ai.common = mock_ai_common
    mock_ai_common.schema = mock_ai_schema
    mock_ai_common.config = mock_ai_config

    sys.modules['rocketlib'] = mock_rocketlib
    sys.modules['rocketlib.types'] = MagicMock()
    sys.modules['ai'] = mock_ai
    sys.modules['ai.common'] = mock_ai_common
    sys.modules['ai.common.schema'] = mock_ai_schema
    sys.modules['ai.common.config'] = mock_ai_config
    sys.modules['depends'] = MagicMock()
    sys.modules['engLib'] = MagicMock()


_install_mocks()

# NOW we can safely import the branch node
from branch.branch_engine import BranchEngine  # noqa: E402


# =============================================================================
# Helpers
# =============================================================================


def _engine(rules=None, default_lane='questions'):
    """Create a BranchEngine with the given rules and default lane."""
    return BranchEngine({'rules': rules or [], 'default_lane': default_lane})


# =============================================================================
# Contains condition
# =============================================================================


class TestContainsCondition:
    """Tests for BranchEngine.contains()."""

    def test_any_mode_single_keyword_match(self):
        result = BranchEngine.contains('I love artificial intelligence', 'artificial', 'any')
        assert result['matched'] is True

    def test_any_mode_multiple_keywords_one_matches(self):
        result = BranchEngine.contains('The weather is nice today', 'rain,snow,nice', 'any')
        assert result['matched'] is True

    def test_any_mode_no_match(self):
        result = BranchEngine.contains('Hello world', 'python,java,rust', 'any')
        assert result['matched'] is False

    def test_all_mode_all_present(self):
        result = BranchEngine.contains('python and java are languages', 'python,java', 'all')
        assert result['matched'] is True

    def test_all_mode_partial_match(self):
        result = BranchEngine.contains('python is great', 'python,java', 'all')
        assert result['matched'] is False

    def test_case_insensitive(self):
        result = BranchEngine.contains('PYTHON is Amazing', 'python,amazing', 'all')
        assert result['matched'] is True

    def test_empty_text(self):
        result = BranchEngine.contains('', 'keyword', 'any')
        assert result['matched'] is False

    def test_empty_keywords(self):
        result = BranchEngine.contains('some text', '', 'any')
        assert result['matched'] is False

    def test_whitespace_in_keywords(self):
        result = BranchEngine.contains('hello world', ' hello , world ', 'all')
        assert result['matched'] is True


# =============================================================================
# Regex condition
# =============================================================================


class TestRegexCondition:
    """Tests for BranchEngine.regex()."""

    def test_match(self):
        result = BranchEngine.regex('order-12345', r'order-\d+')
        assert result['matched'] is True

    def test_no_match(self):
        result = BranchEngine.regex('hello world', r'^\d+$')
        assert result['matched'] is False

    def test_invalid_regex_does_not_crash(self):
        result = BranchEngine.regex('test', r'[invalid')
        assert result['matched'] is False
        assert 'invalid regex' in result['details']

    def test_empty_text(self):
        result = BranchEngine.regex('', r'.*')
        assert result['matched'] is False  # empty text guard

    def test_empty_pattern(self):
        result = BranchEngine.regex('some text', '')
        assert result['matched'] is False


# =============================================================================
# Length condition
# =============================================================================


class TestLengthCondition:
    """Tests for BranchEngine.length()."""

    def test_within_range(self):
        result = BranchEngine.length('hello', 3, 10)
        assert result['matched'] is True

    def test_too_short(self):
        result = BranchEngine.length('hi', 5, 100)
        assert result['matched'] is False

    def test_too_long(self):
        result = BranchEngine.length('a very long string indeed', 1, 5)
        assert result['matched'] is False

    def test_no_min(self):
        result = BranchEngine.length('hi', None, 100)
        assert result['matched'] is True

    def test_no_max(self):
        result = BranchEngine.length('hello world', 3, None)
        assert result['matched'] is True

    def test_exact_boundary(self):
        result = BranchEngine.length('hello', 5, 5)
        assert result['matched'] is True

    def test_empty_text(self):
        result = BranchEngine.length('', 0, 10)
        assert result['matched'] is True


# =============================================================================
# Score threshold condition
# =============================================================================


class TestScoreThresholdCondition:
    """Tests for BranchEngine.score_threshold()."""

    def test_gte_pass(self):
        result = BranchEngine.score_threshold(0.8, 0.5, '>=')
        assert result['matched'] is True

    def test_gte_fail(self):
        result = BranchEngine.score_threshold(0.3, 0.5, '>=')
        assert result['matched'] is False

    def test_gte_equal(self):
        result = BranchEngine.score_threshold(0.5, 0.5, '>=')
        assert result['matched'] is True

    def test_lte_pass(self):
        result = BranchEngine.score_threshold(0.3, 0.5, '<=')
        assert result['matched'] is True

    def test_lte_fail(self):
        result = BranchEngine.score_threshold(0.8, 0.5, '<=')
        assert result['matched'] is False

    def test_eq_pass(self):
        result = BranchEngine.score_threshold(0.5, 0.5, '==')
        assert result['matched'] is True

    def test_eq_fail(self):
        result = BranchEngine.score_threshold(0.6, 0.5, '==')
        assert result['matched'] is False

    def test_gt_pass(self):
        result = BranchEngine.score_threshold(0.6, 0.5, '>')
        assert result['matched'] is True

    def test_gt_boundary(self):
        result = BranchEngine.score_threshold(0.5, 0.5, '>')
        assert result['matched'] is False

    def test_lt_pass(self):
        result = BranchEngine.score_threshold(0.3, 0.5, '<')
        assert result['matched'] is True

    def test_lt_boundary(self):
        result = BranchEngine.score_threshold(0.5, 0.5, '<')
        assert result['matched'] is False

    def test_unknown_operator(self):
        result = BranchEngine.score_threshold(0.5, 0.5, '!=')
        assert result['matched'] is False
        assert 'unknown operator' in result['details']


# =============================================================================
# Field equals condition
# =============================================================================


class TestFieldEqualsCondition:
    """Tests for BranchEngine.field_equals()."""

    def test_match(self):
        result = BranchEngine.field_equals({'category': 'science'}, 'category', 'science')
        assert result['matched'] is True

    def test_no_match(self):
        result = BranchEngine.field_equals({'category': 'art'}, 'category', 'science')
        assert result['matched'] is False

    def test_missing_field(self):
        result = BranchEngine.field_equals({'name': 'test'}, 'category', 'science')
        assert result['matched'] is False

    def test_non_dict_metadata(self):
        result = BranchEngine.field_equals('not a dict', 'field', 'value')
        assert result['matched'] is False

    def test_numeric_value_string_comparison(self):
        result = BranchEngine.field_equals({'priority': 1}, 'priority', '1')
        assert result['matched'] is True


# =============================================================================
# Sentiment condition
# =============================================================================


class TestSentimentCondition:
    """Tests for BranchEngine.sentiment()."""

    def test_positive(self):
        result = BranchEngine.sentiment('This is a great and wonderful product!')
        assert result['matched'] is True
        assert result['details'] == 'positive'

    def test_negative(self):
        result = BranchEngine.sentiment('This is terrible, I hate it and it failed.')
        assert result['matched'] is True
        assert result['details'] == 'negative'

    def test_neutral(self):
        result = BranchEngine.sentiment('The meeting is at 3pm in room 204.')
        assert result['matched'] is True
        assert result['details'] == 'neutral'

    def test_empty_text(self):
        result = BranchEngine.sentiment('')
        assert result['details'] == 'neutral'

    def test_mixed_but_positive_dominant(self):
        # More positive words than negative
        result = BranchEngine.sentiment('Great amazing excellent product, but one bad feature')
        assert result['details'] == 'positive'

    def test_mixed_but_negative_dominant(self):
        # More negative words than positive
        result = BranchEngine.sentiment('Terrible awful horrible product, but one nice feature')
        assert result['details'] == 'negative'


# =============================================================================
# Always true / always false
# =============================================================================


class TestConstantConditions:
    """Tests for always_true and always_false."""

    def test_always_true(self):
        result = BranchEngine.always_true()
        assert result['matched'] is True

    def test_always_false(self):
        result = BranchEngine.always_false()
        assert result['matched'] is False


# =============================================================================
# Evaluate method
# =============================================================================


class TestEvaluate:
    """Tests for BranchEngine.evaluate() dispatch."""

    def test_evaluate_contains(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': 'python is cool'},
            {'type': 'contains', 'keywords': 'python'},
        )
        assert result['matched'] is True

    def test_evaluate_regex(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': 'error-404'},
            {'type': 'regex', 'pattern': r'error-\d+'},
        )
        assert result['matched'] is True

    def test_evaluate_length(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': 'short'},
            {'type': 'length', 'min': 1, 'max': 10},
        )
        assert result['matched'] is True

    def test_evaluate_score_threshold(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': '', 'score': 0.9},
            {'type': 'score_threshold', 'threshold': 0.5, 'operator': '>='},
        )
        assert result['matched'] is True

    def test_evaluate_field_equals(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': '', 'metadata': {'lang': 'en'}},
            {'type': 'field_equals', 'field': 'lang', 'value': 'en'},
        )
        assert result['matched'] is True

    def test_evaluate_sentiment_with_expected(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': 'I love this amazing product'},
            {'type': 'sentiment', 'expected': 'positive'},
        )
        assert result['matched'] is True

    def test_evaluate_sentiment_mismatch(self):
        engine = _engine()
        result = engine.evaluate(
            {'text': 'I love this amazing product'},
            {'type': 'sentiment', 'expected': 'negative'},
        )
        assert result['matched'] is False

    def test_evaluate_always_true(self):
        engine = _engine()
        result = engine.evaluate({'text': ''}, {'type': 'always_true'})
        assert result['matched'] is True

    def test_evaluate_always_false(self):
        engine = _engine()
        result = engine.evaluate({'text': ''}, {'type': 'always_false'})
        assert result['matched'] is False

    def test_evaluate_unknown_type(self):
        engine = _engine()
        result = engine.evaluate({'text': ''}, {'type': 'nonexistent'})
        assert result['matched'] is False
        assert 'unknown' in result['details']


# =============================================================================
# Route method -- first match wins + default lane
# =============================================================================


class TestRoute:
    """Tests for BranchEngine.route() rule ordering and default lane."""

    def test_first_match_wins(self):
        rules = [
            {'condition': {'type': 'contains', 'keywords': 'python'}, 'lane': 'answers'},
            {'condition': {'type': 'always_true'}, 'lane': 'questions'},
        ]
        engine = _engine(rules, default_lane='questions')
        lane = engine.route({'text': 'python is great'})
        assert lane == 'answers'

    def test_second_rule_matches(self):
        rules = [
            {'condition': {'type': 'contains', 'keywords': 'java'}, 'lane': 'answers'},
            {'condition': {'type': 'contains', 'keywords': 'python'}, 'lane': 'questions'},
        ]
        engine = _engine(rules)
        lane = engine.route({'text': 'python rocks'})
        assert lane == 'questions'

    def test_no_match_returns_default(self):
        rules = [
            {'condition': {'type': 'contains', 'keywords': 'java'}, 'lane': 'answers'},
        ]
        engine = _engine(rules, default_lane='questions')
        lane = engine.route({'text': 'hello world'})
        assert lane == 'questions'

    def test_empty_rules_returns_default(self):
        engine = _engine([], default_lane='answers')
        lane = engine.route({'text': 'anything'})
        assert lane == 'answers'

    def test_multiple_rules_evaluation(self):
        rules = [
            {'condition': {'type': 'contains', 'keywords': 'error'}, 'lane': 'answers'},
            {'condition': {'type': 'length', 'min': 100}, 'lane': 'answers'},
            {'condition': {'type': 'always_true'}, 'lane': 'questions'},
        ]
        engine = _engine(rules, default_lane='answers')
        # Text is short and has no "error" -- third rule (always_true) matches
        lane = engine.route({'text': 'short text'})
        assert lane == 'questions'

    def test_route_with_explicit_rules_overrides_config(self):
        engine = _engine(
            [{'condition': {'type': 'always_true'}, 'lane': 'answers'}],
            default_lane='questions',
        )
        explicit = [{'condition': {'type': 'always_false'}, 'lane': 'answers'}]
        lane = engine.route({'text': 'test'}, rules=explicit)
        assert lane == 'questions'  # explicit rules don't match, falls to default


# =============================================================================
# IGlobal / IInstance lifecycle -- import validation
# =============================================================================


class TestModuleImports:
    """Verify the node module can be imported without a running engine."""

    def test_branch_engine_import(self):
        from branch.branch_engine import BranchEngine as BE

        assert BE is not None

    def test_init_exports(self):
        import branch

        assert hasattr(branch, 'IGlobal')
        assert hasattr(branch, 'IInstance')

    def test_iglobal_has_begin_end(self):
        from branch.IGlobal import IGlobal

        assert hasattr(IGlobal, 'beginGlobal')
        assert hasattr(IGlobal, 'endGlobal')

    def test_iinstance_has_write_methods(self):
        from branch.IInstance import IInstance

        assert hasattr(IInstance, 'writeQuestions')
        assert hasattr(IInstance, 'writeAnswers')


# =============================================================================
# IInstance routing integration
# =============================================================================


class TestIInstanceRouting:
    """Integration tests for IInstance write methods with mocked engine."""

    def _make_instance(self, rules=None, default_lane='questions'):
        from branch.IInstance import IInstance

        inst = IInstance()
        # Set up mock IGlobal with engine
        inst.IGlobal = MagicMock()
        inst.IGlobal.engine = BranchEngine(
            {
                'rules': rules or [],
                'default_lane': default_lane,
            }
        )
        # Set up mock instance (the C++ bridge)
        inst.instance = MagicMock()
        return inst

    def test_write_questions_routes_to_questions(self):
        inst = self._make_instance(
            rules=[{'condition': {'type': 'always_true'}, 'lane': 'questions'}],
        )
        question = _MockQuestion()
        question.addQuestion('What is Python?')
        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()

    def test_write_questions_routes_to_answers(self):
        inst = self._make_instance(
            rules=[{'condition': {'type': 'always_true'}, 'lane': 'answers'}],
        )
        question = _MockQuestion()
        question.addQuestion('What is Python?')
        inst.writeQuestions(question)
        inst.instance.writeAnswers.assert_called_once()

    def test_write_answers_routes_to_answers(self):
        inst = self._make_instance(
            rules=[{'condition': {'type': 'always_true'}, 'lane': 'answers'}],
        )
        answer = _MockAnswer(text='Python is a programming language.')
        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()

    def test_write_answers_routes_to_questions(self):
        inst = self._make_instance(
            rules=[{'condition': {'type': 'always_true'}, 'lane': 'questions'}],
        )
        answer = _MockAnswer(text='Python is a programming language.')
        inst.writeAnswers(answer)
        inst.instance.writeQuestions.assert_called_once()

    def test_default_lane_when_no_rules_match(self):
        inst = self._make_instance(
            rules=[{'condition': {'type': 'contains', 'keywords': 'java'}, 'lane': 'answers'}],
            default_lane='questions',
        )
        question = _MockQuestion()
        question.addQuestion('Tell me about Python')
        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()
        inst.instance.writeAnswers.assert_not_called()

    def test_deep_copy_prevents_mutation(self):
        """Verify that the routed question is a deep copy, not the original."""
        inst = self._make_instance(
            rules=[{'condition': {'type': 'always_true'}, 'lane': 'questions'}],
        )
        question = _MockQuestion()
        question.addQuestion('Original question')
        inst.writeQuestions(question)

        # Get the argument passed to writeQuestions
        routed = inst.instance.writeQuestions.call_args[0][0]

        # Mutate the original and ensure the routed copy is unaffected
        question.questions.append({'text': 'mutated'})
        assert len(routed.questions) == 1  # deep copy should be unaffected


# =============================================================================
# Deep copy standalone tests
# =============================================================================


class TestDeepCopy:
    """Ensure data is deep-copied before routing to prevent cross-branch mutation."""

    def test_question_mutation_prevention(self):
        original = {'text': 'original', 'metadata': {'key': 'value'}}
        routed = copy.deepcopy(original)
        original['text'] = 'mutated'
        original['metadata']['key'] = 'mutated'
        assert routed['text'] == 'original'
        assert routed['metadata']['key'] == 'value'

    def test_nested_list_mutation_prevention(self):
        original = {'items': [1, 2, {'nested': True}]}
        routed = copy.deepcopy(original)
        original['items'][2]['nested'] = False
        assert routed['items'][2]['nested'] is True


# =============================================================================
# Services.json contract validation
# =============================================================================


def _strip_json_comments(raw: str) -> str:
    """Remove JS-style // comments from JSON (respecting strings)."""
    cleaned = ''
    in_string = False
    i = 0
    while i < len(raw):
        if raw[i] == '"' and (i == 0 or raw[i - 1] != '\\'):
            in_string = not in_string
            cleaned += raw[i]
        elif not in_string and raw[i : i + 2] == '//':
            while i < len(raw) and raw[i] != '\n':
                i += 1
            continue
        else:
            cleaned += raw[i]
        i += 1
    return cleaned


class TestServicesJson:
    """Validate the services.json contract file."""

    @pytest.fixture(scope='class')
    def services(self):
        services_path = NODES_SRC / 'branch' / 'services.json'
        assert services_path.exists(), f'services.json not found at {services_path}'
        raw = services_path.read_text()
        cleaned = _strip_json_comments(raw)
        return json.loads(cleaned)

    def test_has_title(self, services):
        assert services['title'] == 'Conditional Branch'

    def test_has_protocol(self, services):
        assert services['protocol'] == 'branch://'

    def test_has_class_type(self, services):
        assert 'branch' in services['classType']

    def test_register_is_filter(self, services):
        assert services['register'] == 'filter'

    def test_node_is_python(self, services):
        assert services['node'] == 'python'

    def test_path_is_correct(self, services):
        assert services['path'] == 'nodes.branch'

    def test_has_questions_lane(self, services):
        lanes = services['lanes']
        assert 'questions' in lanes
        assert 'questions' in lanes['questions']
        assert 'answers' in lanes['questions']

    def test_has_answers_lane(self, services):
        lanes = services['lanes']
        assert 'answers' in lanes
        assert 'questions' in lanes['answers']
        assert 'answers' in lanes['answers']

    def test_has_profiles(self, services):
        profiles = services['preconfig']['profiles']
        assert 'keyword' in profiles
        assert 'regex' in profiles
        assert 'score' in profiles
        assert 'sentiment' in profiles
        assert 'custom' in profiles

    def test_has_test_cases(self, services):
        assert 'test' in services
        assert len(services['test']['cases']) >= 2

    def test_has_fields(self, services):
        fields = services['fields']
        assert 'condition_type' in fields
        assert 'keywords' in fields
        assert 'regex_pattern' in fields
        assert 'threshold' in fields
        assert 'operator' in fields
        assert 'field_name' in fields
        assert 'field_value' in fields
        assert 'default_lane' in fields

    def test_has_shape(self, services):
        assert len(services['shape']) >= 1
        assert services['shape'][0]['title'] == 'Conditional Branch'
