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

"""Tests for the Cobalt Dataset Loader node.

All tests use mocks to avoid real file I/O and external dependencies.
"""

import sys
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Mock infrastructure: rocketlib, engLib, ai.common, cobalt, depends
# ---------------------------------------------------------------------------

# Names of every module we mock — used by the session fixture to restore
# sys.modules after the entire test run.
_MOCK_MODULE_NAMES = [
    'engLib',
    'rocketlib',
    'depends',
    'ai',
    'ai.common',
    'ai.common.config',
    'ai.common.schema',
    'rocketride',
    'json5',
    'cobalt',
]


def _install_mocks():
    """Install mock modules so the node code can be imported without the engine."""
    # Mock engLib (C++ bindings)
    mock_englib = ModuleType('engLib')
    mock_englib.Entry = MagicMock
    mock_englib.Filters = MagicMock
    mock_englib.IFilterInstance = MagicMock
    sys.modules['engLib'] = mock_englib

    # Mock rocketlib
    mock_rocketlib = ModuleType('rocketlib')

    class _IGlobalBase:
        IEndpoint = None
        glb = None

        def preventDefault(self):
            raise Exception('No default to prevent')

        def beginGlobal(self):
            pass

        def endGlobal(self):
            pass

    class _IInstanceBase:
        IEndpoint = None
        IGlobal = None
        instance = None

        def preventDefault(self):
            raise Exception('No default to prevent')

        def writeQuestions(self, question):
            pass

    mock_rocketlib.IGlobalBase = _IGlobalBase
    mock_rocketlib.IInstanceBase = _IInstanceBase
    mock_rocketlib.Entry = MagicMock
    mock_rocketlib.OPEN_MODE = MagicMock()
    mock_rocketlib.debug = lambda msg: None
    mock_rocketlib.warning = lambda msg: None
    mock_rocketlib.getServiceDefinition = MagicMock(return_value={})
    mock_rocketlib.IJson = MagicMock()
    sys.modules['rocketlib'] = mock_rocketlib

    # Mock depends
    mock_depends = ModuleType('depends')
    mock_depends.depends = lambda *a, **kw: None
    sys.modules['depends'] = mock_depends

    # Mock ai.common.config
    mock_ai = ModuleType('ai')
    mock_ai_common = ModuleType('ai.common')
    mock_ai_common_config = ModuleType('ai.common.config')
    mock_ai_common_schema = ModuleType('ai.common.schema')

    class _MockConfig:
        @staticmethod
        def getNodeConfig(logical_type, conn_config):
            return conn_config

    mock_ai_common_config.Config = _MockConfig
    mock_ai.common = mock_ai_common
    mock_ai_common.config = mock_ai_common_config
    mock_ai_common.schema = mock_ai_common_schema

    # Mock Question and Answer in schema
    class _MockQuestion:
        def __init__(self, **kwargs):
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

    mock_ai_common_schema.Question = _MockQuestion
    mock_ai_common_schema.Answer = MagicMock
    mock_ai_common_schema.Doc = MagicMock
    mock_ai_common_schema.DocFilter = MagicMock
    mock_ai_common_schema.DocMetadata = MagicMock

    sys.modules['ai'] = mock_ai
    sys.modules['ai.common'] = mock_ai_common
    sys.modules['ai.common.config'] = mock_ai_common_config
    sys.modules['ai.common.schema'] = mock_ai_common_schema

    # Mock rocketride (used by ai.common.schema re-exports)
    mock_rocketride = ModuleType('rocketride')
    sys.modules['rocketride'] = mock_rocketride

    # Mock json5 (used by ai.common.config internally)
    if 'json5' not in sys.modules:
        sys.modules['json5'] = ModuleType('json5')


_original_modules = {name: sys.modules.get(name) for name in _MOCK_MODULE_NAMES}
_original_path = sys.path[:]

# Install mocks at module level so node imports below succeed.
_install_mocks()


@pytest.fixture(autouse=True, scope='session')
def _restore_modules():
    """Restore sys.modules after the entire test session completes."""
    yield
    sys.path[:] = _original_path
    for name, orig in _original_modules.items():
        if orig is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = orig


# ---------------------------------------------------------------------------
# Mock Cobalt Dataset class
# ---------------------------------------------------------------------------


class MockDataset:
    """Mock of cobalt.Dataset that stores items and supports chainable transforms."""

    def __init__(self, items):
        """Initialize with a list of item dicts."""
        self._items = list(items)

    @classmethod
    def from_items(cls, items):
        return cls(items)

    @classmethod
    def from_file(cls, path):
        # Return pre-configured test data based on extension
        if path.endswith('.json'):
            return cls([{'input': 'json-q1', 'expected': 'json-a1'}, {'input': 'json-q2', 'expected': 'json-a2'}])
        elif path.endswith('.csv'):
            return cls([{'input': 'csv-q1', 'expected': 'csv-a1'}, {'input': 'csv-q2', 'expected': 'csv-a2'}, {'input': 'csv-q3', 'expected': 'csv-a3'}])
        return cls([])

    @classmethod
    def from_jsonl(cls, path):
        return cls([{'input': 'jsonl-q1', 'expected': 'jsonl-a1'}, {'input': 'jsonl-q2', 'expected': 'jsonl-a2'}])

    def filter(self, fn):
        return MockDataset([item for item in self._items if fn(item)])

    def sample(self, n):
        # Deterministic 'sample' for testing: take first n items
        return MockDataset(self._items[:n])

    def slice(self, start, end):
        return MockDataset(self._items[start:end])

    def map(self, fn):
        return MockDataset([fn(item) for item in self._items])

    def __iter__(self):
        """Iterate over dataset items."""
        return iter(self._items)

    def __len__(self):
        """Return number of items in the dataset."""
        return len(self._items)


# Patch cobalt module with our mock
mock_cobalt = ModuleType('cobalt')
mock_cobalt.Dataset = MockDataset
sys.modules['cobalt'] = mock_cobalt


# ---------------------------------------------------------------------------
# Now import the actual node code
# ---------------------------------------------------------------------------
from nodes.dataset_cobalt.dataset_loader import DatasetLoader
from nodes.dataset_cobalt.IGlobal import IGlobal
from nodes.dataset_cobalt.IInstance import IInstance


# ---------------------------------------------------------------------------
# Helper: create a loader with given config
# ---------------------------------------------------------------------------
def _make_loader(source_type='file', file_path='', sample_size=0, items=None, **extra):
    config = {
        'source_type': source_type,
        'file_path': file_path,
        'sample_size': sample_size,
        'items': items or [],
        **extra,
    }
    return DatasetLoader(config, {})


# ===========================================================================
# DatasetLoader tests
# ===========================================================================


class TestLoadFromJsonFile:
    """Test loading from JSON file (mocked)."""

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    @patch('os.path.isfile', return_value=True)
    def test_load_json_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        loader = _make_loader(file_path='/data/test.json')
        items = loader.load_from_file('/data/test.json')
        assert len(items) == 2
        assert items[0]['input'] == 'json-q1'
        assert items[1]['expected'] == 'json-a2'

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    @patch('os.path.isfile', return_value=True)
    def test_load_json_via_load_method(self, mock_isfile, mock_cwd, mock_realpath):
        loader = _make_loader(source_type='file', file_path='/data/test.json')
        items = loader.load()
        assert len(items) == 2


class TestLoadFromCsvFile:
    """Test loading from CSV file (mocked)."""

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    @patch('os.path.isfile', return_value=True)
    def test_load_csv_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        loader = _make_loader(file_path='/data/test.csv')
        items = loader.load_from_file('/data/test.csv')
        assert len(items) == 3
        assert items[0]['input'] == 'csv-q1'


class TestLoadFromJsonlFile:
    """Test loading from JSONL file (mocked)."""

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    @patch('os.path.isfile', return_value=True)
    def test_load_jsonl_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        loader = _make_loader(file_path='/data/test.jsonl')
        items = loader.load_from_file('/data/test.jsonl')
        assert len(items) == 2
        assert items[0]['input'] == 'jsonl-q1'


class TestLoadFromInlineItems:
    """Test loading from inline items."""

    def test_load_inline_items(self):
        inline = [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]
        loader = _make_loader(source_type='inline', items=inline)
        items = loader.load_from_items(inline)
        assert len(items) == 2
        assert items[0]['input'] == 'q1'

    def test_load_inline_via_load_method(self):
        inline = [{'input': 'q1', 'expected': 'a1'}]
        loader = _make_loader(source_type='inline', items=inline)
        items = loader.load()
        assert len(items) == 1

    def test_load_inline_empty_raises(self):
        loader = _make_loader(source_type='inline', items=[])
        with pytest.raises(ValueError, match='non-empty list'):
            loader.load_from_items([])

    def test_load_inline_none_raises(self):
        loader = _make_loader(source_type='inline', items=None)
        with pytest.raises(ValueError, match='non-empty list'):
            loader.load_from_items(None)


class TestSampleTransform:
    """Test sample transformation (random subset)."""

    def test_sample_limits_items(self):
        items = [{'input': f'q{i}', 'expected': f'a{i}'} for i in range(10)]
        loader = _make_loader(sample_size=3)
        result = loader.apply_transforms(items, {'sample_size': 3})
        assert len(result) == 3

    def test_sample_bounded_to_dataset_size(self):
        items = [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]
        loader = _make_loader(sample_size=100)
        result = loader.apply_transforms(items, {'sample_size': 100})
        # Sample bounded to 2 (dataset size), so result <= 2
        assert len(result) <= 2

    def test_sample_zero_skips(self):
        items = [{'input': f'q{i}'} for i in range(5)]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'sample_size': 0})
        assert len(result) == 5


class TestFilterTransform:
    """Test filter transformation."""

    def test_filter_by_field_value(self):
        items = [
            {'input': 'q1', 'category': 'math'},
            {'input': 'q2', 'category': 'science'},
            {'input': 'q3', 'category': 'math'},
        ]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'filter_field': 'category', 'filter_value': 'math'})
        assert len(result) == 2
        assert all(item['category'] == 'math' for item in result)

    def test_filter_no_match_returns_empty(self):
        items = [{'input': 'q1', 'category': 'math'}]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'filter_field': 'category', 'filter_value': 'history'})
        assert len(result) == 0

    def test_filter_empty_field_skips(self):
        items = [{'input': 'q1'}, {'input': 'q2'}]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'filter_field': '', 'filter_value': 'x'})
        assert len(result) == 2


class TestSliceTransform:
    """Test slice transformation."""

    def test_slice_range(self):
        items = [{'input': f'q{i}'} for i in range(10)]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'slice_start': 2, 'slice_end': 5})
        assert len(result) == 3
        assert result[0]['input'] == 'q2'

    def test_slice_zero_end_skips(self):
        items = [{'input': f'q{i}'} for i in range(5)]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'slice_start': 0, 'slice_end': 0})
        assert len(result) == 5

    def test_slice_end_before_start_skips(self):
        items = [{'input': f'q{i}'} for i in range(5)]
        loader = _make_loader()
        result = loader.apply_transforms(items, {'slice_start': 5, 'slice_end': 2})
        assert len(result) == 5


class TestToQuestions:
    """Test to_questions conversion."""

    def test_basic_conversion(self):
        items = [{'input': 'What is 2+2?', 'expected': '4', 'id': 'test-001'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert len(questions) == 1
        assert questions[0]['text'] == 'What is 2+2?'
        assert questions[0]['metadata']['expected'] == '4'
        assert questions[0]['metadata']['dataset_id'] == 'test-001'
        assert questions[0]['metadata']['cobalt_source'] is True

    def test_fallback_to_text_field(self):
        items = [{'text': 'alt text field'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['text'] == 'alt text field'

    def test_fallback_to_question_field(self):
        items = [{'question': 'question field'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['text'] == 'question field'

    def test_extra_fields_preserved_in_metadata(self):
        items = [{'input': 'q1', 'expected': 'a1', 'difficulty': 'hard', 'category': 'math'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['metadata']['difficulty'] == 'hard'
        assert questions[0]['metadata']['category'] == 'math'

    def test_empty_input_gives_empty_text(self):
        items = [{'other_field': 'value'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['text'] == ''


class TestEmptyDatasetHandling:
    """Test empty dataset handling."""

    def test_apply_transforms_on_empty_list(self):
        loader = _make_loader()
        result = loader.apply_transforms([], {'sample_size': 5})
        assert result == []

    def test_to_questions_on_empty_list(self):
        loader = _make_loader()
        questions = loader.to_questions([])
        assert questions == []


class TestPathValidation:
    """Test path validation and security."""

    @patch('os.path.isfile', return_value=False)
    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    def test_missing_file_raises(self, mock_cwd, mock_realpath, mock_isfile):
        loader = _make_loader(file_path='/data/nonexistent.json')
        with pytest.raises(FileNotFoundError, match='not found'):
            loader.load_from_file('/data/nonexistent.json')

    def test_path_traversal_raises(self):
        loader = _make_loader(file_path='/data/../../../etc/passwd')
        with pytest.raises(ValueError, match='traversal'):
            loader.load_from_file('/data/../../../etc/passwd')

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/safe/workdir')
    def test_absolute_path_outside_workdir_raises(self, mock_cwd, mock_realpath):
        loader = _make_loader(file_path='/etc/secrets.json')
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file('/etc/secrets.json')

    @patch('os.path.realpath', side_effect=lambda p: '/safe/workdir_evil/test.json' if 'evil' in p else p)
    @patch('os.getcwd', return_value='/safe/workdir')
    def test_sibling_prefix_attack_raises(self, mock_cwd, mock_realpath):
        """Sibling prefix like /safe/workdir_evil/ must not pass startswith check."""
        loader = _make_loader(file_path='/safe/workdir_evil/test.json')
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file('/safe/workdir_evil/test.json')

    @patch('os.path.realpath', side_effect=lambda p: '/tmp/evil/data.json' if 'symlink' in p else p)
    @patch('os.getcwd', return_value='/safe/workdir')
    def test_symlink_resolved_outside_workdir_raises(self, mock_cwd, mock_realpath):
        """Symlink resolving outside cwd must be rejected."""
        loader = _make_loader(file_path='/safe/workdir/symlink_data.json')
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file('/safe/workdir/symlink_data.json')

    @patch('os.path.isfile', return_value=True)
    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    def test_unsupported_extension_raises(self, mock_cwd, mock_realpath, mock_isfile):
        loader = _make_loader(file_path='/data/test.xml')
        with pytest.raises(ValueError, match='Unsupported'):
            loader.load_from_file('/data/test.xml')


# ===========================================================================
# IInstance tests
# ===========================================================================


class TestIInstanceEmitsQuestions:
    """Test IInstance emits correct number of questions."""

    def _make_instance(self, questions):
        """Create a mock IInstance with prepared questions."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._questions = questions
        inst.instance = MagicMock()
        return inst

    def test_emits_all_questions(self):
        questions = [
            {'text': 'q1', 'metadata': {'expected': 'a1', 'dataset_id': '1', 'cobalt_source': True}},
            {'text': 'q2', 'metadata': {'expected': 'a2', 'dataset_id': '2', 'cobalt_source': True}},
            {'text': 'q3', 'metadata': {'expected': 'a3', 'dataset_id': '3', 'cobalt_source': True}},
        ]
        inst = self._make_instance(questions)

        # Create a mock Question template
        template = sys.modules['ai.common.schema'].Question()
        inst.writeQuestions(template)

        assert inst.instance.writeQuestions.call_count == 3

    def test_empty_questions_skips(self):
        inst = self._make_instance([])
        template = sys.modules['ai.common.schema'].Question()
        inst.writeQuestions(template)
        assert inst.instance.writeQuestions.call_count == 0

    def test_none_questions_skips(self):
        inst = self._make_instance(None)
        template = sys.modules['ai.common.schema'].Question()
        inst.writeQuestions(template)
        assert inst.instance.writeQuestions.call_count == 0


class TestDeepCopyPreventsMutation:
    """Test deep copy prevents mutation between emitted items."""

    def test_mutations_do_not_leak(self):
        questions = [
            {'text': 'q1', 'metadata': {'expected': 'a1', 'dataset_id': '1', 'cobalt_source': True}},
            {'text': 'q2', 'metadata': {'expected': 'a2', 'dataset_id': '2', 'cobalt_source': True}},
        ]
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._questions = questions
        inst.instance = MagicMock()

        emitted = []

        def capture_question(q):
            emitted.append(q)

        inst.instance.writeQuestions.side_effect = capture_question

        template = sys.modules['ai.common.schema'].Question()
        inst.writeQuestions(template)

        # Each emitted question should be a distinct object
        assert len(emitted) == 2
        assert emitted[0] is not emitted[1]

        # Mutating one should not affect the other
        emitted[0].questions.append('mutated')
        assert 'mutated' not in emitted[1].questions


# ===========================================================================
# IGlobal lifecycle tests
# ===========================================================================


class TestIGlobalLifecycle:
    """Test IGlobal lifecycle (beginGlobal / endGlobal)."""

    def _make_global(self, config):
        """Create a mock IGlobal with given config."""
        g = IGlobal()
        g.IEndpoint = MagicMock()
        g.IEndpoint.endpoint.bag = {}
        g.IEndpoint.endpoint.connConfig = config
        g.glb = MagicMock()
        g.glb.connConfig = config
        g.glb.logicalType = 'dataset_cobalt'
        return g

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/data')
    @patch('os.path.isfile', return_value=True)
    def test_begin_and_end_global(self, mock_isfile, mock_cwd, mock_realpath):
        config = {'source_type': 'file', 'file_path': '/data/test.json', 'sample_size': 0}
        g = self._make_global(config)

        g.beginGlobal()
        assert g._loader is not None
        assert isinstance(g._dataset, list)
        assert isinstance(g._questions, list)
        assert len(g._questions) == 2  # MockDataset returns 2 items for .json

        g.endGlobal()
        assert g._loader is None
        assert g._dataset is None
        assert g._questions is None

    def test_begin_global_inline(self):
        items = [{'input': 'inline-q1', 'expected': 'inline-a1'}]
        config = {'source_type': 'inline', 'items': items, 'sample_size': 0}
        g = self._make_global(config)

        g.beginGlobal()
        assert len(g._questions) == 1
        assert g._questions[0]['text'] == 'inline-q1'

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value='/missing')
    @patch('os.path.isfile', return_value=False)
    def test_begin_global_missing_file_graceful(self, mock_isfile, mock_cwd, mock_realpath):
        config = {'source_type': 'file', 'file_path': '/missing/data.json', 'sample_size': 0}
        g = self._make_global(config)

        # Should not raise; warns internally and sets empty dataset
        g.beginGlobal()
        assert g._dataset == []
        assert g._questions == []

    def test_begin_global_config_mode_skips(self):
        config = {'source_type': 'inline', 'items': [{'input': 'q1', 'expected': 'a1'}], 'sample_size': 0}
        g = self._make_global(config)
        g.IEndpoint.endpoint.openMode = sys.modules['rocketlib'].OPEN_MODE.CONFIG

        g.beginGlobal()
        # Should not load anything in CONFIG mode
        assert not hasattr(g, '_loader') or g._loader is None

    def test_validate_config_negative_sample(self):
        config = {'source_type': 'inline', 'sample_size': -5}
        g = self._make_global(config)

        # Should not raise; just warns
        g.validateConfig()

    def test_validate_config_path_traversal(self):
        config = {'source_type': 'file', 'file_path': '/etc/../../../passwd', 'sample_size': 0}
        g = self._make_global(config)

        # Should not raise; just warns
        g.validateConfig()


# ===========================================================================
# Review-fix regression tests
# ===========================================================================


class TestNullFallbackChain:
    """Fix 5: None-aware fallback for to_questions field resolution."""

    def test_explicit_empty_string_not_skipped(self):
        """An explicit empty string in 'input' should NOT fall through to 'text'."""
        items = [{'input': '', 'text': 'should not use this'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['text'] == ''

    def test_none_input_falls_through_to_text(self):
        items = [{'input': None, 'text': 'fallback text'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['text'] == 'fallback text'

    def test_answer_field_used_for_expected(self):
        """The 'answer' field should be a valid fallback for expected output."""
        items = [{'input': 'q', 'answer': 'the answer'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['metadata']['expected'] == 'the answer'

    def test_explicit_empty_expected_not_skipped(self):
        items = [{'input': 'q', 'expected': '', 'output': 'should not use'}]
        loader = _make_loader()
        questions = loader.to_questions(items)
        assert questions[0]['metadata']['expected'] == ''


class TestInlineJsonStringParsing:
    """Fix 6: Inline items can arrive as a JSON string from textarea input."""

    def test_json_string_parsed_to_list(self):
        json_str = '[{"input": "q1", "expected": "a1"}]'
        loader = _make_loader(source_type='inline', items=[{'input': 'placeholder'}])
        items = loader.load_from_items(json_str)
        assert len(items) == 1

    def test_invalid_json_string_raises(self):
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match='Failed to parse'):
            loader.load_from_items('{not valid json')

    def test_json_string_non_array_raises(self):
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match='non-empty list'):
            loader.load_from_items('{"not": "an array"}')


class TestGoldAnswerNotInContext:
    """Fix 2: Expected output must NOT appear in prompt context (addContext)."""

    def test_expected_output_in_metadata_not_context(self):
        questions = [
            {'text': 'q1', 'metadata': {'expected': 'secret_answer', 'dataset_id': '1', 'cobalt_source': True}},
        ]
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._questions = questions
        inst.instance = MagicMock()

        emitted = []
        inst.instance.writeQuestions.side_effect = lambda q: emitted.append(q)

        template = sys.modules['ai.common.schema'].Question()
        inst.writeQuestions(template)

        assert len(emitted) == 1
        # The context list must NOT contain the expected answer
        assert 'secret_answer' not in emitted[0].context
        # But metadata should have it
        assert emitted[0].metadata.get('expected') == 'secret_answer'


class TestValidatePathHelper:
    """Fix 1 + 8: Shared _validate_path helper used by loader and IGlobal."""

    def test_validate_path_rejects_sibling_prefix(self):
        from nodes.dataset_cobalt.dataset_loader import _validate_path

        with patch('os.path.realpath', side_effect=lambda p: p):
            with patch('os.getcwd', return_value='/safe/workdir'):
                with pytest.raises(ValueError, match='outside'):
                    _validate_path('/safe/workdir_evil/test.json')

    def test_validate_path_accepts_valid_child(self):
        from nodes.dataset_cobalt.dataset_loader import _validate_path

        with patch('os.path.realpath', side_effect=lambda p: p):
            with patch('os.getcwd', return_value='/safe/workdir'):
                result = _validate_path('/safe/workdir/data/test.json')
                assert result == '/safe/workdir/data/test.json'

    def test_validate_path_rejects_dotdot(self):
        from nodes.dataset_cobalt.dataset_loader import _validate_path

        with pytest.raises(ValueError, match='traversal'):
            _validate_path('/data/../../../etc/passwd')
