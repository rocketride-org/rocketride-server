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

import importlib.machinery
import importlib.util
import os
import pathlib
import re
import sys
from types import ModuleType
from urllib.parse import quote
from unittest.mock import MagicMock, patch

import pytest


# Directory that contains the individual node packages (dataset_cobalt,
# eval_cobalt, ...). Adding it to sys.path lets us `import dataset_cobalt.*`
# directly, bypassing the top-level `nodes/__init__.py` which would otherwise
# try to `from depends import depends` and fail outside the engine runtime.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_NODES_DIR = str(_REPO_ROOT / 'nodes' / 'src' / 'nodes')


def _abs_test_path(*parts: str) -> str:
    """Build a platform-native absolute path for path-validation tests."""
    return os.path.join(os.path.abspath(os.sep), *parts)


_DATA_DIR = _abs_test_path('data')
_SAFE_WORKDIR = _abs_test_path('safe', 'workdir')
_SAFE_WORKDIR_EVIL = _abs_test_path('safe', 'workdir_evil')
_TMP_EVIL = _abs_test_path('tmp', 'evil')
_ETC_SECRETS = _abs_test_path('etc', 'secrets.json')
_ETC_PASSWD = _abs_test_path('etc', 'passwd')


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
    'ai.common.utils',
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
    mock_englib.debug = lambda *a, **kw: None
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

    class _IEndpointBase:
        endpoint = None

        def preventDefault(self):
            raise Exception('No default to prevent')

    mock_rocketlib.IGlobalBase = _IGlobalBase
    mock_rocketlib.IInstanceBase = _IInstanceBase
    mock_rocketlib.IEndpointBase = _IEndpointBase
    mock_rocketlib.Entry = MagicMock
    mock_rocketlib.OPEN_MODE = MagicMock()
    mock_rocketlib.debug = lambda msg: None
    mock_rocketlib.warning = lambda msg: None
    mock_rocketlib.monitorStatus = lambda msg: None
    mock_rocketlib.monitorCompleted = lambda size: None
    mock_rocketlib.monitorFailed = lambda size: None
    mock_rocketlib.getObject = lambda obj: MagicMock(url=obj.get('url'), name=obj.get('name'))
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
    mock_ai.__path__ = [str(_REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai')]
    mock_ai_common.__path__ = [str(_REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common')]

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

    class _MockQuestionText:
        def __init__(self, text=''):
            self.text = text

    mock_ai_common_schema.Question = _MockQuestion
    mock_ai_common_schema.QuestionText = _MockQuestionText
    mock_ai_common_schema.QuestionType = type('QuestionType', (), {'QUESTION': 'question'})()
    mock_ai_common_schema.Answer = MagicMock
    mock_ai_common_schema.Doc = MagicMock
    mock_ai_common_schema.DocFilter = MagicMock
    mock_ai_common_schema.DocMetadata = MagicMock
    mock_ai_common_schema.DocGroup = MagicMock

    # ai.common.utils pulls torch/cv2 through its package __init__, which this
    # environment does not have. Load the dependency-free metadata helper
    # straight from its file so the tests exercise the shipped merge logic
    # instead of a stub that could drift from it.
    mock_ai_common_utils = ModuleType('ai.common.utils')
    _metadata_path = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'metadata_utils.py'
    _metadata_spec = importlib.util.spec_from_file_location('ai.common.utils.metadata_utils', _metadata_path)
    _metadata_module = importlib.util.module_from_spec(_metadata_spec)
    _metadata_spec.loader.exec_module(_metadata_module)
    mock_ai_common_utils.merge_metadata = _metadata_module.merge_metadata
    mock_ai_common.utils = mock_ai_common_utils

    sys.modules['ai'] = mock_ai
    sys.modules['ai.common'] = mock_ai_common
    sys.modules['ai.common.config'] = mock_ai_common_config
    sys.modules['ai.common.schema'] = mock_ai_common_schema
    sys.modules['ai.common.utils'] = mock_ai_common_utils

    # Mock rocketride (used by ai.common.schema re-exports)
    mock_rocketride = ModuleType('rocketride')
    mock_rocketride.Question = _MockQuestion
    mock_rocketride.QuestionText = _MockQuestionText
    mock_rocketride.QuestionType = mock_ai_common_schema.QuestionType
    mock_rocketride.Answer = MagicMock
    mock_rocketride.Doc = MagicMock
    mock_rocketride.DocFilter = MagicMock
    mock_rocketride.DocMetadata = MagicMock
    mock_rocketride.DocGroup = MagicMock
    sys.modules['rocketride'] = mock_rocketride

    # Mock json5 (used by ai.common.config internally)
    if 'json5' not in sys.modules:
        sys.modules['json5'] = ModuleType('json5')


_original_modules: dict = {}
_original_path: list = []
_MISSING = object()


def _snapshot_modules():
    """Snapshot sys.modules entries before mock installation."""
    _original_modules.update({name: sys.modules.get(name, _MISSING) for name in _MOCK_MODULE_NAMES})
    _original_path[:] = sys.path[:]


def _restore_modules_impl():
    """Restore sys.modules to pre-mock state after importing node modules."""
    sys.path[:] = _original_path
    for name, orig in _original_modules.items():
        if orig is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = orig


# Snapshot before mocks are installed, then install mocks so node imports succeed.
_snapshot_modules()
if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)
_install_mocks()
_RUNTIME_MOCK_MODULES = {
    name: sys.modules[name]
    for name in (
        'depends',
        'ai',
        'ai.common',
        'ai.common.config',
        'ai.common.schema',
        'rocketride',
    )
}


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
            return cls(
                [
                    {'input': 'csv-q1', 'expected': 'csv-a1'},
                    {'input': 'csv-q2', 'expected': 'csv-a2'},
                    {'input': 'csv-q3', 'expected': 'csv-a3'},
                ]
            )
        return cls([])

    @classmethod
    def from_jsonl(cls, path):
        return cls([{'input': 'jsonl-q1', 'expected': 'jsonl-a1'}, {'input': 'jsonl-q2', 'expected': 'jsonl-a2'}])

    def filter(self, fn):
        # cobalt.Dataset.filter calls predicate(item, index) (cobalt/dataset.py:188-189).
        # A one-argument mock here made a one-argument production lambda look
        # correct while it dropped every row against the real library.
        return MockDataset([item for i, item in enumerate(self._items) if fn(item, i)])

    def sample(self, n):
        # Deterministic 'sample' for testing: take first n items
        return MockDataset(self._items[:n])

    def slice(self, start, end):
        return MockDataset(self._items[start:end])

    def map(self, fn):
        # cobalt.Dataset.map likewise calls fn(item, index) (cobalt/dataset.py:185-186).
        return MockDataset([fn(item, i) for i, item in enumerate(self._items)])

    def __iter__(self):
        """Iterate over dataset items."""
        return iter(self._items)

    def __len__(self):
        """Return number of items in the dataset."""
        return len(self._items)


# Patch cobalt module with our mock
mock_cobalt = ModuleType('cobalt')
mock_cobalt.__spec__ = importlib.machinery.ModuleSpec('cobalt', loader=None)
mock_cobalt.Dataset = MockDataset


# ---------------------------------------------------------------------------
# Now import the actual node code
# ---------------------------------------------------------------------------
from dataset_cobalt.dataset_loader import DatasetLoader, DatasetLoadError, row_identity
from dataset_cobalt.IEndpoint import IEndpoint
from dataset_cobalt.IGlobal import IGlobal
from dataset_cobalt.IInstance import IInstance

_restore_modules_impl()


@pytest.fixture(autouse=True)
def _runtime_mock_modules():
    """Install runtime-only mocks for lazy imports without leaking at collection."""
    overrides = {**_RUNTIME_MOCK_MODULES, 'cobalt': mock_cobalt}
    originals = {name: sys.modules.get(name, _MISSING) for name in overrides}
    sys.modules.update(overrides)
    try:
        yield
    finally:
        for name, original in originals.items():
            if original is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


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
    @patch('os.getcwd', return_value=_DATA_DIR)
    @patch('os.path.isfile', return_value=True)
    def test_load_json_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        path = os.path.join(_DATA_DIR, 'test.json')
        loader = _make_loader(file_path=path)
        items = loader.load_from_file(path)
        assert len(items) == 2
        assert items[0]['input'] == 'json-q1'
        assert items[1]['expected'] == 'json-a2'

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_DATA_DIR)
    @patch('os.path.isfile', return_value=True)
    def test_load_json_via_load_method(self, mock_isfile, mock_cwd, mock_realpath):
        loader = _make_loader(source_type='file', file_path=os.path.join(_DATA_DIR, 'test.json'))
        items = loader.load()
        assert len(items) == 2


class TestLoadFromCsvFile:
    """Test loading from CSV file (mocked)."""

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_DATA_DIR)
    @patch('os.path.isfile', return_value=True)
    def test_load_csv_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        path = os.path.join(_DATA_DIR, 'test.csv')
        loader = _make_loader(file_path=path)
        items = loader.load_from_file(path)
        assert len(items) == 3
        assert items[0]['input'] == 'csv-q1'


class TestLoadFromJsonlFile:
    """Test loading from JSONL file (mocked)."""

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_DATA_DIR)
    @patch('os.path.isfile', return_value=True)
    def test_load_jsonl_returns_items(self, mock_isfile, mock_cwd, mock_realpath):
        path = os.path.join(_DATA_DIR, 'test.jsonl')
        loader = _make_loader(file_path=path)
        items = loader.load_from_file(path)
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


class TestLoaderWithoutCobalt:
    """Regression: the loader must stay functional when basalt-ai-cobalt is absent.

    Before the pure-Python fallback, ``from cobalt import Dataset`` inside the
    file/inline loaders raised ImportError, which beginGlobal swallowed into an
    empty dataset (0 questions, warning only) — a silent no-op. These tests
    fail without the fallback because loading raises instead of returning items.
    """

    @staticmethod
    def _no_cobalt():
        # A ``None`` entry in sys.modules makes ``from cobalt import Dataset``
        # raise ImportError, simulating the package not being installed. The
        # autouse fixture installs the cobalt mock; this overrides it.
        return patch.dict(sys.modules, {'cobalt': None})

    def test_load_json_array_fallback_returns_items(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.json'
        f.write_text('[{"input": "q1", "expected": "a1"}, {"input": "q2", "expected": "a2"}]')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            items = loader.load_from_file(str(f))
        assert items == [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]

    def test_load_json_object_envelope_fallback(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.json'
        f.write_text('{"items": [{"input": "q1"}, {"input": "q2"}]}')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            items = loader.load_from_file(str(f))
        assert items == [{'input': 'q1'}, {'input': 'q2'}]

    def test_load_jsonl_fallback_skips_blank_lines(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.jsonl'
        f.write_text('{"input": "q1", "expected": "a1"}\n\n{"input": "q2", "expected": "a2"}\n')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            items = loader.load_from_file(str(f))
        assert items == [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]

    def test_load_csv_fallback_returns_items(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.csv'
        f.write_text('input,expected\nq1,a1\nq2,a2\n')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            items = loader.load_from_file(str(f))
        assert items == [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]

    def test_load_inline_fallback_returns_items(self):
        inline = [{'input': 'q1', 'expected': 'a1'}, {'input': 'q2', 'expected': 'a2'}]
        loader = _make_loader(source_type='inline', items=inline)
        with self._no_cobalt():
            items = loader.load_from_items(inline)
        assert items == inline

    def test_fallback_strips_utf8_bom(self, tmp_path, monkeypatch):
        """A BOM-prefixed file (Excel/Windows export) must parse, not error into empty."""
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'bom.json'
        f.write_text('[{"input": "q1"}]', encoding='utf-8-sig')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            assert loader.load_from_file(str(f)) == [{'input': 'q1'}]

    def test_fallback_rejects_non_dict_items(self, tmp_path, monkeypatch):
        """Scalar array elements must fail fast with a clear message, not deep in to_questions."""
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'scalars.json'
        f.write_text('[1, 2, 3]')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt(), pytest.raises(ValueError, match='is not an object'):
            loader.load_from_file(str(f))

    def test_fallback_reports_malformed_jsonl_line(self, tmp_path, monkeypatch):
        """A malformed JSONL line reports the file and real line number."""
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'bad.jsonl'
        f.write_text('{"input": "q1"}\nnot-json\n')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt(), pytest.raises(ValueError, match='line 2'):
            loader.load_from_file(str(f))

    def test_full_load_without_cobalt_yields_questions(self, tmp_path, monkeypatch):
        # End-to-end guard against the silent-empty-dataset regression: without
        # cobalt, load() -> apply_transforms() -> to_questions() must still
        # produce the questions rather than an empty list with only a warning.
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.jsonl'
        f.write_text('{"input": "q1", "expected": "a1"}\n{"input": "q2", "expected": "a2"}\n')
        loader = _make_loader(file_path=str(f))
        with self._no_cobalt():
            raw = loader.load()
            transformed = loader.apply_transforms(raw, {})
            questions = loader.to_questions(transformed)
        assert len(questions) == 2
        assert questions[0]['text'] == 'q1'
        assert questions[0]['metadata']['expected'] == 'a1'


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

    def test_both_lanes_keep_the_same_rows(self):
        """The cobalt lane must filter, not empty the dataset.

        cobalt's ``Dataset.filter`` calls ``predicate(item, index)``
        (cobalt/dataset.py:188-189). The loader passed a one-argument lambda,
        so the index landed in the slot the field name was bound to, every row
        compared ``item.get(<int>, '')`` against the value, and the cobalt lane
        returned nothing while the pure-Python lane returned the matching rows
        — no exception, no warning. The suite could not see it because
        ``MockDataset.filter`` also took one argument; it now mirrors the real
        two-argument contract.
        """
        items = [
            {'input': 'q1', 'category': 'math'},
            {'input': 'q2', 'category': 'science'},
            {'input': 'q3', 'category': 'math'},
        ]
        config = {'filter_field': 'category', 'filter_value': 'math'}
        loader = _make_loader()

        with_cobalt = loader.apply_transforms(items, config)
        with TestLoaderWithoutCobalt._no_cobalt():
            without_cobalt = loader.apply_transforms(items, config)

        assert [i['input'] for i in with_cobalt] == ['q1', 'q3']
        assert with_cobalt == without_cobalt


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
    @patch('os.getcwd', return_value=_DATA_DIR)
    def test_missing_file_raises(self, mock_cwd, mock_realpath, mock_isfile):
        path = os.path.join(_DATA_DIR, 'nonexistent.json')
        loader = _make_loader(file_path=path)
        with pytest.raises(FileNotFoundError, match='not found'):
            loader.load_from_file(path)

    def test_path_traversal_raises(self):
        path = os.path.join(_DATA_DIR, '..', '..', '..', 'etc', 'passwd')
        loader = _make_loader(file_path=path)
        with pytest.raises(ValueError, match='traversal'):
            loader.load_from_file(path)

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_SAFE_WORKDIR)
    def test_absolute_path_outside_workdir_raises(self, mock_cwd, mock_realpath):
        loader = _make_loader(file_path=_ETC_SECRETS)
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file(_ETC_SECRETS)

    @patch(
        'os.path.realpath', side_effect=lambda p: os.path.join(_SAFE_WORKDIR_EVIL, 'test.json') if 'evil' in p else p
    )
    @patch('os.getcwd', return_value=_SAFE_WORKDIR)
    def test_sibling_prefix_attack_raises(self, mock_cwd, mock_realpath):
        """Sibling prefix like /safe/workdir_evil/ must not pass startswith check."""
        path = os.path.join(_SAFE_WORKDIR_EVIL, 'test.json')
        loader = _make_loader(file_path=path)
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file(path)

    @patch('os.path.realpath', side_effect=lambda p: os.path.join(_TMP_EVIL, 'data.json') if 'symlink' in p else p)
    @patch('os.getcwd', return_value=_SAFE_WORKDIR)
    def test_symlink_resolved_outside_workdir_raises(self, mock_cwd, mock_realpath):
        """Symlink resolving outside cwd must be rejected."""
        path = os.path.join(_SAFE_WORKDIR, 'symlink_data.json')
        loader = _make_loader(file_path=path)
        with pytest.raises(ValueError, match='outside the working directory'):
            loader.load_from_file(path)

    @patch('os.path.isfile', return_value=True)
    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_DATA_DIR)
    def test_unsupported_extension_raises(self, mock_cwd, mock_realpath, mock_isfile):
        path = os.path.join(_DATA_DIR, 'test.xml')
        loader = _make_loader(file_path=path)
        with pytest.raises(ValueError, match='Unsupported'):
            loader.load_from_file(path)


# ===========================================================================
# IInstance tests
# ===========================================================================


def _dispatch(handler):
    """Run a lane handler the way the engine runs one, asserting it suppressed the default.

    The engine forwards a handler's incoming argument after the handler returns
    unless the handler raised ``Ec.PreventDefault`` (``__checkCallParent``,
    ``engLib/python/call.hpp``). ``IInstance.writeQuestions`` ends in
    ``preventDefault()`` on every exit, so calling it directly now raises;
    wrapping the call keeps these tests asserting on what the node emitted
    while pinning the suppression that keeps the emitted count exact.

    Args:
        handler: Zero-argument callable that invokes the lane handler.
    """
    with pytest.raises(Exception, match='No default to prevent'):
        handler()


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
        _dispatch(lambda: inst.writeQuestions(template))

        assert inst.instance.writeQuestions.call_count == 3

    def test_empty_questions_skips(self):
        inst = self._make_instance([])
        template = sys.modules['ai.common.schema'].Question()
        _dispatch(lambda: inst.writeQuestions(template))
        assert inst.instance.writeQuestions.call_count == 0

    def test_none_questions_skips(self):
        inst = self._make_instance(None)
        template = sys.modules['ai.common.schema'].Question()
        _dispatch(lambda: inst.writeQuestions(template))
        assert inst.instance.writeQuestions.call_count == 0

    def test_explicit_falsy_text_replaces_template_prompt(self):
        questions = [
            {'text': 0, 'metadata': {'expected': 'zero', 'dataset_id': '1', 'cobalt_source': True}},
        ]
        inst = self._make_instance(questions)
        emitted = []
        inst.instance.writeQuestions.side_effect = lambda q: emitted.append(q)

        template = sys.modules['ai.common.schema'].Question()
        template.addQuestion('template prompt')
        _dispatch(lambda: inst.writeQuestions(template))

        assert len(emitted) == 1
        assert emitted[0].questions == ['0']

    @pytest.mark.parametrize('text', ['', None])
    def test_empty_text_never_inherits_the_template_prompt(self, text):
        """An item with no text must not inherit the template's prompt.

        Regression for the review finding that `''` left `q.questions`
        untouched, so the emitted question carried the incoming template
        prompt instead of the dataset's (empty) prompt. The row is now
        skipped outright (see TestTextLessRowsAreSkipped), which satisfies
        that invariant more strongly: nothing carrying the template prompt
        is emitted at all.
        """
        questions = [
            {'text': text, 'metadata': {'expected': 'ref', 'dataset_id': '1', 'cobalt_source': True}},
        ]
        inst = self._make_instance(questions)
        emitted = []
        inst.instance.writeQuestions.side_effect = lambda q: emitted.append(q)

        template = sys.modules['ai.common.schema'].Question()
        template.addQuestion('template prompt')
        with patch('dataset_cobalt.IInstance.warning'):
            _dispatch(lambda: inst.writeQuestions(template))

        assert emitted == []


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
        _dispatch(lambda: inst.writeQuestions(template))

        # Each emitted question should be a distinct object
        assert len(emitted) == 2
        assert emitted[0] is not emitted[1]

        # Mutating one should not affect the other
        emitted[0].questions.append('mutated')
        assert 'mutated' not in emitted[1].questions


# ===========================================================================
# IEndpoint tests
# ===========================================================================


class TestIEndpointSource:
    """Test source endpoint emission for real pipeline entrypoint behavior."""

    def _make_endpoint(self, config):
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = config
        endpoint.endpoint.bag = {}
        return endpoint

    def test_scan_objects_emits_inline_questions(self):
        config = {
            'source_type': 'inline',
            'items': [
                {'input': 'q1', 'expected': 'a1'},
                {'input': 'q2', 'expected': 'a2'},
            ],
            'sample_size': 0,
        }
        endpoint = self._make_endpoint(config)
        entries = []

        endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert len(entries) == 2
        assert entries[0]['name'] == 'q1'
        assert entries[0]['objectTags']['text'] == 'q1'
        assert entries[0]['objectTags']['metadata']['expected'] == 'a1'
        assert entries[1]['objectTags']['text'] == 'q2'

    def test_endpoint_dataset_prefix_keys_are_normalized(self):
        config = {
            'dataset.source_type': 'inline',
            'dataset.items': '[{"input": "q", "expected": "a"}]',
            'dataset.sample_size': 0,
        }
        endpoint = self._make_endpoint(config)
        entries = []

        endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert len(entries) == 1
        assert entries[0]['objectTags']['text'] == 'q'
        assert entries[0]['objectTags']['metadata']['expected'] == 'a'

    def test_endpoint_reads_source_parameters_block(self):
        config = {
            'hideForm': True,
            'mode': 'Source',
            'type': 'dataset_cobalt',
            'parameters': {
                'profile': 'inline',
                'inline': {'source_type': 'inline', 'items': '[{"input": "q", "expected": "a"}]', 'sample_size': 0},
            },
        }
        endpoint = self._make_endpoint(config)
        entries = []

        endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert len(entries) == 1
        assert entries[0]['objectTags']['text'] == 'q'
        assert entries[0]['objectTags']['metadata']['expected'] == 'a'

    def test_endpoint_recovers_config_from_task_pipeline(self):
        endpoint = self._make_endpoint({'hideForm': True, 'mode': 'Source', 'type': 'dataset_cobalt'})
        endpoint.endpoint.taskConfig = {
            'pipeline': {
                'source': 'dataset_cobalt_1',
                'components': [
                    {
                        'id': 'dataset_cobalt_1',
                        'provider': 'dataset_cobalt',
                        'config': {
                            'parameters': {
                                'profile': 'inline',
                                'inline': {
                                    'source_type': 'inline',
                                    'items': '[{"input": "q", "expected": "a"}]',
                                    'sample_size': 0,
                                },
                            },
                        },
                    },
                ],
            },
        }
        entries = []

        endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert len(entries) == 1
        assert entries[0]['objectTags']['text'] == 'q'
        assert entries[0]['objectTags']['metadata']['expected'] == 'a'

    def test_render_object_sends_question_from_scan_entry(self):
        inst = IInstance()
        inst.instance = MagicMock()
        entry = MagicMock()
        entry.objectTags = {'text': 'q', 'metadata': {'expected': 'a'}}

        with pytest.raises(Exception, match='No default to prevent'):
            inst.renderObject(entry)

        emitted = inst.instance.sendQuestions.call_args.args[0]
        assert emitted.questions == ['q']
        assert emitted.metadata['expected'] == 'a'

    def test_render_object_preserves_falsy_text(self):
        inst = IInstance()
        inst.instance = MagicMock()
        entry = MagicMock()
        entry.objectTags = {'text': 0, 'metadata': {'expected': 'zero'}}

        with pytest.raises(Exception, match='No default to prevent'):
            inst.renderObject(entry)

        emitted = inst.instance.sendQuestions.call_args.args[0]
        assert emitted.questions == ['0']
        assert emitted.metadata['expected'] == 'zero'


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
    @patch('os.getcwd', return_value=_DATA_DIR)
    @patch('os.path.isfile', return_value=True)
    def test_begin_and_end_global(self, mock_isfile, mock_cwd, mock_realpath):
        config = {'source_type': 'file', 'file_path': os.path.join(_DATA_DIR, 'test.json'), 'sample_size': 0}
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
    @patch('os.getcwd', return_value=_abs_test_path('missing'))
    @patch('os.path.isfile', return_value=False)
    def test_begin_global_missing_file_raises(self, mock_isfile, mock_cwd, mock_realpath):
        """A dataset that cannot be loaded must abort init, not start empty.

        This used to warn and set an empty dataset, so a typo'd file_path
        produced a pipeline that initialised cleanly and evaluated nothing.
        """
        config = {
            'source_type': 'file',
            'file_path': os.path.join(_abs_test_path('missing'), 'data.json'),
            'sample_size': 0,
        }
        g = self._make_global(config)

        with pytest.raises(DatasetLoadError, match='Dataset file not found'):
            g.beginGlobal()

    def test_begin_global_config_mode_skips(self):
        config = {'source_type': 'inline', 'items': [{'input': 'q1', 'expected': 'a1'}], 'sample_size': 0}
        g = self._make_global(config)
        # Use the OPEN_MODE reference that the node module actually captured
        # at import time. Fetching it via sys.modules['rocketlib'] is unsafe
        # when another test module has replaced rocketlib in sys.modules.
        import importlib  # noqa: PLC0415

        _ig_mod = importlib.import_module('dataset_cobalt.IGlobal')
        g.IEndpoint.endpoint.openMode = _ig_mod.OPEN_MODE.CONFIG

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
        _dispatch(lambda: inst.writeQuestions(template))

        assert len(emitted) == 1
        # The context list must NOT contain the expected answer in any form
        # (including nested structures like ['expected: secret_answer']).
        assert 'secret_answer' not in repr(emitted[0].context)
        # But metadata should have it
        assert emitted[0].metadata.get('expected') == 'secret_answer'


class TestValidatePathHelper:
    """Fix 1 + 8: Shared _validate_path helper used by loader and IGlobal."""

    def test_validate_path_rejects_sibling_prefix(self):
        from dataset_cobalt.dataset_loader import _validate_path

        with patch('os.path.realpath', side_effect=lambda p: p):
            with patch('os.getcwd', return_value=_SAFE_WORKDIR):
                with pytest.raises(ValueError, match='outside'):
                    _validate_path(os.path.join(_SAFE_WORKDIR_EVIL, 'test.json'))

    def test_validate_path_accepts_valid_child(self):
        from dataset_cobalt.dataset_loader import _validate_path

        with patch('os.path.realpath', side_effect=lambda p: p):
            with patch('os.getcwd', return_value=_SAFE_WORKDIR):
                path = os.path.join(_SAFE_WORKDIR, 'data', 'test.json')
                result = _validate_path(path)
                assert result == path

    def test_validate_path_rejects_dotdot(self):
        from dataset_cobalt.dataset_loader import _validate_path

        with pytest.raises(ValueError, match='traversal'):
            _validate_path(os.path.join(_DATA_DIR, '..', '..', '..', 'etc', 'passwd'))


class TestExtractConfigMergesDefault:
    """Fix: _extractConfig merges nested 'default' over top-level config."""

    def _make_global(self, config):
        g = IGlobal()
        g.IEndpoint = MagicMock()
        g.IEndpoint.endpoint.bag = {}
        g.IEndpoint.endpoint.connConfig = config
        g.glb = MagicMock()
        g.glb.connConfig = config
        g.glb.logicalType = 'dataset_cobalt'
        return g

    def test_top_level_keys_preserved_after_unwrap(self):
        """Profile defaults like source_type must survive the 'default' unwrap."""
        raw_config = {
            'source_type': 'file',
            'default': {'file_path': '/data/test.json', 'sample_size': 5},
        }
        g = self._make_global(raw_config)
        result = g._extractConfig()
        assert result['source_type'] == 'file'
        assert result['file_path'] == '/data/test.json'
        assert result['sample_size'] == 5
        assert 'default' not in result

    def test_default_keys_override_top_level(self):
        """Keys inside 'default' should take precedence over top-level keys."""
        raw_config = {
            'source_type': 'inline',
            'default': {'source_type': 'file', 'file_path': '/data/test.json'},
        }
        g = self._make_global(raw_config)
        result = g._extractConfig()
        assert result['source_type'] == 'file'

    def test_no_default_key_returns_config_as_is(self):
        """Config without a 'default' key should be returned unchanged."""
        raw_config = {'source_type': 'file', 'file_path': '/data/test.json'}
        g = self._make_global(raw_config)
        result = g._extractConfig()
        assert result == raw_config

    def test_non_dict_default_is_ignored(self):
        """A non-dict 'default' value should not trigger unwrap."""
        raw_config = {'source_type': 'file', 'default': 'not-a-dict'}
        g = self._make_global(raw_config)
        result = g._extractConfig()
        assert result['default'] == 'not-a-dict'
        assert result['source_type'] == 'file'

    def test_dataset_prefix_keys_are_normalized(self):
        """UI field names should be stripped before DatasetLoader sees config."""
        raw_config = {
            'dataset.source_type': 'inline',
            'dataset.items': '[{"input": "q", "expected": "a"}]',
            'dataset.sample_size': 0,
        }
        g = self._make_global(raw_config)
        result = g._extractConfig()
        assert result['source_type'] == 'inline'
        assert result['items'] == '[{"input": "q", "expected": "a"}]'
        assert result['sample_size'] == 0


class TestInlineItemsMustBeMappings:
    """Inline items are validated at the loader, not deep in to_questions.

    A scalar element used to survive ``load_from_items`` and then raise
    ``AttributeError: 'str' object has no attribute 'get'`` inside
    ``to_questions``, which the node boundary swallows into a bare warning and
    an empty dataset — so a user pasting `["a", "b"]` got a silent no-op run.
    """

    def test_scalar_item_raises_with_index_and_type(self):
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match=r'index 0 in inline items is not an object'):
            loader.load_from_items(['bad', 'worse'])

    def test_error_names_the_offending_index(self):
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match=r'index 1 in inline items'):
            loader.load_from_items([{'input': 'ok'}, 'bad'])

    def test_error_reports_the_actual_type(self):
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match=r'got int'):
            loader.load_from_items([42])

    def test_json_string_of_scalars_is_rejected(self):
        """The textarea path is validated after parsing, not only the list path."""
        loader = _make_loader(source_type='inline')
        with pytest.raises(ValueError, match='is not an object'):
            loader.load_from_items('["a", "b"]')

    def test_valid_mappings_still_load(self):
        loader = _make_loader(source_type='inline')
        items = loader.load_from_items([{'input': 'q', 'expected': 'a'}])
        assert items == [{'input': 'q', 'expected': 'a'}]


class TestLoadFailureIsNotSuccess:
    """A dataset that cannot be loaded must not report a successful run.

    ``_load_questions`` used to catch FileNotFoundError / ValueError /
    ImportError / Exception, warn, and return ``[]``. ``scanObjects`` then took
    the "no questions to emit" branch and called ``monitorCompleted(0)``, so a
    typo'd ``file_path`` produced an engine-visible SUCCESSFUL run that had
    evaluated nothing. These tests fail without the fix because scanObjects
    returns normally instead of raising.
    """

    def _make_endpoint(self, config):
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = config
        endpoint.endpoint.bag = {}
        return endpoint

    @staticmethod
    def _real_reader():
        """Read the file on disk instead of the canned MockDataset contents."""
        return patch.dict(sys.modules, {'cobalt': None})

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_abs_test_path('missing'))
    @patch('os.path.isfile', return_value=False)
    def test_missing_file_raises_out_of_scan_objects(self, mock_isfile, mock_cwd, mock_realpath):
        endpoint = self._make_endpoint(
            {
                'source_type': 'file',
                'file_path': os.path.join(_abs_test_path('missing'), 'data.json'),
                'sample_size': 0,
            }
        )
        entries = []

        with pytest.raises(DatasetLoadError, match='Dataset file not found'):
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert entries == []

    def test_missing_file_does_not_report_a_clean_completion(self, monkeypatch, tmp_path):
        """The failing scan must never reach monitorCompleted."""
        monkeypatch.chdir(tmp_path)
        completed = []
        monkeypatch.setattr(
            sys.modules['dataset_cobalt.IEndpoint'],
            'monitorCompleted',
            lambda size: completed.append(size),
        )
        endpoint = self._make_endpoint(
            {'source_type': 'file', 'file_path': str(tmp_path / 'nope.json'), 'sample_size': 0}
        )

        with pytest.raises(DatasetLoadError):
            endpoint.scanObjects('', lambda entry: 0)

        assert completed == []

    def test_unsupported_extension_raises(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.txt'
        f.write_text('not a dataset')
        endpoint = self._make_endpoint({'source_type': 'file', 'file_path': str(f), 'sample_size': 0})

        with pytest.raises(DatasetLoadError, match='Unsupported file format'):
            endpoint.scanObjects('', lambda entry: 0)

    def test_scalar_rows_raise_rather_than_emitting_nothing(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'scalars.json'
        f.write_text('[1, 2, 3]')
        endpoint = self._make_endpoint({'source_type': 'file', 'file_path': str(f), 'sample_size': 0})

        with self._real_reader(), pytest.raises(DatasetLoadError, match='is not an object'):
            endpoint.scanObjects('', lambda entry: 0)

    def test_genuinely_empty_dataset_still_completes_cleanly(self, monkeypatch, tmp_path):
        """A dataset that IS readable and holds no rows keeps working."""
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'empty.json'
        f.write_text('[]')
        completed = []
        monkeypatch.setattr(
            sys.modules['dataset_cobalt.IEndpoint'],
            'monitorCompleted',
            lambda size: completed.append(size),
        )
        endpoint = self._make_endpoint({'source_type': 'file', 'file_path': str(f), 'sample_size': 0})
        entries = []

        with self._real_reader():
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert entries == []
        assert completed == [0]

    def test_filtered_to_zero_rows_still_completes_cleanly(self, monkeypatch, tmp_path):
        """A filter that matches nothing is an empty result, not a load failure."""
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.json'
        f.write_text('[{"input": "q1", "lang": "en"}]')
        completed = []
        monkeypatch.setattr(
            sys.modules['dataset_cobalt.IEndpoint'],
            'monitorCompleted',
            lambda size: completed.append(size),
        )
        endpoint = self._make_endpoint(
            {
                'source_type': 'file',
                'file_path': str(f),
                'sample_size': 0,
                'filter_field': 'lang',
                'filter_value': 'fr',
            }
        )

        with self._real_reader():
            endpoint.scanObjects('', lambda entry: 0)

        assert completed == [0]

    @patch('os.path.realpath', side_effect=lambda p: p)
    @patch('os.getcwd', return_value=_abs_test_path('missing'))
    @patch('os.path.isfile', return_value=False)
    def test_begin_global_leaves_no_half_loaded_state(self, mock_isfile, mock_cwd, mock_realpath):
        """Cleanup must still be safe to call after a failed beginGlobal."""
        g = IGlobal()
        g.IEndpoint = MagicMock()
        g.IEndpoint.endpoint.bag = {}
        config = {
            'source_type': 'file',
            'file_path': os.path.join(_abs_test_path('missing'), 'data.json'),
            'sample_size': 0,
        }
        g.IEndpoint.endpoint.connConfig = config
        g.glb = MagicMock()
        g.glb.connConfig = config
        g.glb.logicalType = 'dataset_cobalt'

        with pytest.raises(DatasetLoadError):
            g.beginGlobal()

        assert g._questions == []
        g.endGlobal()
        assert g._loader is None


class TestDependencyInstallFailureFallsBack:
    """README promise: a pure-Python fallback when basalt-ai-cobalt is absent.

    ``depends(requirements)`` used to be called OUTSIDE the try/except in both
    IGlobal and IEndpoint, so a dependency-INSTALL failure (no package index,
    resolution conflict) raised straight past the fallback and the documented
    behaviour was unreachable. These tests fail without the fix because the
    RuntimeError from depends() escapes.
    """

    @staticmethod
    def _failing_depends():
        mod = ModuleType('depends')

        def _boom(*_args, **_kwargs):
            raise RuntimeError('Failed to install requirements.txt: no index available')

        mod.depends = _boom
        # `cobalt: None` makes `from cobalt import Dataset` raise ImportError,
        # i.e. the install really did not land.
        return patch.dict(sys.modules, {'depends': mod, 'cobalt': None})

    def test_endpoint_still_emits_via_pure_python_reader(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.jsonl'
        f.write_text('{"input": "q1", "expected": "a1"}\n{"input": "q2", "expected": "a2"}\n')
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = {'source_type': 'file', 'file_path': str(f), 'sample_size': 0}
        endpoint.endpoint.bag = {}
        entries = []

        with self._failing_depends():
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert [e['objectTags']['text'] for e in entries] == ['q1', 'q2']

    def test_begin_global_still_prepares_questions(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.json'
        f.write_text('[{"input": "q1", "expected": "a1"}]')
        config = {'source_type': 'file', 'file_path': str(f), 'sample_size': 0}
        g = IGlobal()
        g.IEndpoint = MagicMock()
        g.IEndpoint.endpoint.bag = {}
        g.IEndpoint.endpoint.connConfig = config
        g.glb = MagicMock()
        g.glb.connConfig = config
        g.glb.logicalType = 'dataset_cobalt'

        with self._failing_depends():
            g.beginGlobal()

        assert [q['text'] for q in g._questions] == ['q1']

    def test_a_real_load_failure_still_raises_after_a_failed_install(self, monkeypatch, tmp_path):
        """Tolerating the install failure must not re-swallow load failures."""
        monkeypatch.chdir(tmp_path)
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = {
            'source_type': 'file',
            'file_path': str(tmp_path / 'nope.json'),
            'sample_size': 0,
        }
        endpoint.endpoint.bag = {}

        with self._failing_depends(), pytest.raises(DatasetLoadError, match='Dataset file not found'):
            endpoint.scanObjects('', lambda entry: 0)


class TestScanEntryIdentityIsStable:
    """The scan entry URL must be derived from the row, not minted per scan.

    It used to be ``f'dataset_cobalt://{index}/{uuid.uuid4()}'``, so the same
    logical row got a brand-new identity on every scan and nothing downstream
    could dedup a re-emitted row or resume a partial dataset.
    """

    def _scan(self, tmp_path, monkeypatch, payload):
        monkeypatch.chdir(tmp_path)
        f = tmp_path / 'data.json'
        f.write_text(payload)
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = {'source_type': 'file', 'file_path': str(f), 'sample_size': 0}
        endpoint.endpoint.bag = {}
        entries = []
        # Read the file on disk rather than MockDataset's canned contents.
        with patch.dict(sys.modules, {'cobalt': None}):
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)
        return entries

    def test_repeat_scans_produce_identical_urls(self, tmp_path, monkeypatch):
        payload = '[{"input": "q1", "expected": "a1"}, {"input": "q2", "expected": "a2"}]'
        first = self._scan(tmp_path, monkeypatch, payload)
        second = self._scan(tmp_path, monkeypatch, payload)

        assert [e['url'] for e in first] == [e['url'] for e in second]
        assert len({e['url'] for e in first}) == 2

    def test_no_uuid_in_the_url(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"input": "q1"}]')
        # A uuid4 renders as 8-4-4-4-12 hex with dashes; the identity must not
        # look like one, and must be reproducible.
        assert not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-', entries[0]['url'])

    def test_explicit_id_becomes_the_identity(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"id": "row-7", "input": "q1"}]')
        assert entries[0]['url'] == 'dataset_cobalt://1/row-7'

    def test_id_is_percent_encoded_for_the_url(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"id": "a/b c", "input": "q1"}]')
        assert entries[0]['url'] == 'dataset_cobalt://1/a%2Fb%20c'

    def test_zero_id_is_a_real_id_not_a_missing_one(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"id": 0, "input": "q1"}]')
        assert entries[0]['url'] == 'dataset_cobalt://1/0'

    def test_different_content_gets_a_different_identity(self, tmp_path, monkeypatch):
        one = self._scan(tmp_path, monkeypatch, '[{"input": "q1"}]')
        two = self._scan(tmp_path, monkeypatch, '[{"input": "q2"}]')
        assert one[0]['url'] != two[0]['url']

    def test_duplicate_rows_stay_distinct_entries(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"input": "q"}, {"input": "q"}]')
        assert entries[0]['url'] != entries[1]['url']

    def test_identity_survives_a_non_serialisable_value(self):
        import datetime

        item = {'text': 'q', 'metadata': {'when': datetime.date(2026, 9, 14)}}
        assert IEndpoint._identity_for_item(item)

    def test_url_identity_matches_the_dataset_id_join_key(self, tmp_path, monkeypatch):
        """The entry URL and the metadata join key must be the same string."""
        entries = self._scan(tmp_path, monkeypatch, '[{"input": "q1"}, {"id": "row-2", "input": "q2"}]')

        for index, entry in enumerate(entries, start=1):
            dataset_id = entry['objectTags']['metadata']['dataset_id']
            assert entry['url'] == f'dataset_cobalt://{index}/{quote(str(dataset_id), safe="")}'

    def test_id_less_row_url_carries_the_synthesized_identity(self, tmp_path, monkeypatch):
        entries = self._scan(tmp_path, monkeypatch, '[{"input": "q1"}]')
        assert entries[0]['url'].startswith('dataset_cobalt://1/sha256-')

    def test_the_ordinal_counts_emitted_rows_not_raw_ones(self, tmp_path, monkeypatch):
        """Text-less rows are dropped before the scan, so they take no ordinal.

        This is a contract change against the revision that emitted a question
        for every row: the same file's second and fourth rows used to scan as
        ``://2/a`` and ``://4/b``. The identity half is unaffected, which is
        what a consumer joins on; the ordinal is a position in the scan.
        """
        entries = self._scan(
            tmp_path,
            monkeypatch,
            '[{"expected": "only-a-reference"}, {"id": "a", "input": "q-a"}, '
            '{"text": ""}, {"id": "b", "input": "q-b"}]',
        )

        assert [e['url'] for e in entries] == ['dataset_cobalt://1/a', 'dataset_cobalt://2/b']


class TestDatasetIdIsAlwaysAddressable:
    """``item.get('id') or ''`` collapsed 0, False, '' and "no id" into one value.

    An evaluator correlating scores back to inputs by ``dataset_id`` (the join
    key eval_cobalt's README documents) could not then tell row 0 from a row
    with no id at all, nor one id-less row from another.
    """

    def test_zero_id_is_preserved(self):
        loader = _make_loader()
        questions = loader.to_questions([{'id': 0, 'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'] == 0

    def test_false_id_is_preserved(self):
        loader = _make_loader()
        questions = loader.to_questions([{'id': False, 'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'] is False

    def test_string_id_is_preserved(self):
        loader = _make_loader()
        questions = loader.to_questions([{'id': 'row-7', 'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'] == 'row-7'

    def test_missing_id_gets_a_synthesized_identity(self):
        loader = _make_loader()
        questions = loader.to_questions([{'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'].startswith('sha256-')

    def test_none_id_gets_a_synthesized_identity(self):
        loader = _make_loader()
        questions = loader.to_questions([{'id': None, 'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'].startswith('sha256-')

    def test_empty_string_id_gets_a_synthesized_identity(self):
        """'' is not addressable, so it cannot serve as a join key."""
        loader = _make_loader()
        questions = loader.to_questions([{'id': '', 'input': 'q'}])
        assert questions[0]['metadata']['dataset_id'].startswith('sha256-')

    def test_zero_and_missing_are_distinguishable(self):
        loader = _make_loader()
        questions = loader.to_questions([{'id': 0, 'input': 'a'}, {'input': 'b'}])
        assert questions[0]['metadata']['dataset_id'] != questions[1]['metadata']['dataset_id']

    def test_two_id_less_rows_do_not_collapse(self):
        loader = _make_loader()
        questions = loader.to_questions([{'input': 'a'}, {'input': 'b'}])
        assert questions[0]['metadata']['dataset_id'] != questions[1]['metadata']['dataset_id']

    def test_synthesized_id_is_stable_across_calls(self):
        loader = _make_loader()
        first = loader.to_questions([{'input': 'a', 'expected': 'b'}])
        second = loader.to_questions([{'input': 'a', 'expected': 'b'}])
        assert first[0]['metadata']['dataset_id'] == second[0]['metadata']['dataset_id']

    def test_row_identity_survives_a_non_serialisable_value(self):
        import datetime

        assert row_identity({'input': 'q', 'when': datetime.date(2026, 9, 14)}).startswith('sha256-')


class TestTextLessRowsAreSkipped:
    """A row carrying no prompt must not become a scored evaluation result.

    ``to_questions`` falls back to ``''`` when a row has none of
    ``input``/``text``/``question`` (a typo'd key, a renamed CSV column), so
    ``{'expected': 'Paris'}`` used to be emitted as a question with no prompt
    at all. Downstream the LLM answered an empty prompt and eval_cobalt scored
    the reply against the reference, recording a low score indistinguishable
    from a weak model. Both lanes - filter mode (``IInstance.writeQuestions``)
    and source mode (``IEndpoint.scanObjects`` /
    ``IInstance.renderObject``) - now skip such a row and say so once.
    """

    @staticmethod
    def _instance(questions):
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._questions = questions
        inst.instance = MagicMock()
        return inst

    @staticmethod
    def _endpoint(config):
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = config
        endpoint.endpoint.bag = {}
        return endpoint

    def test_the_reported_row_yields_no_question_dict_text(self):
        """The reviewer's row reaches both lanes as text ''."""
        loader = _make_loader()
        questions = loader.to_questions([{'expected': 'Paris'}])
        assert questions[0]['text'] == ''
        assert questions[0]['metadata']['expected'] == 'Paris'

    def test_filter_mode_skips_the_text_less_row(self):
        loader = _make_loader()
        questions = loader.to_questions([{'expected': 'Paris'}, {'input': 'q2', 'expected': 'a2'}])
        inst = self._instance(questions)
        emitted = []
        inst.instance.writeQuestions.side_effect = lambda q: emitted.append(q)

        template = sys.modules['ai.common.schema'].Question()
        with patch('dataset_cobalt.IInstance.warning') as mock_warning:
            _dispatch(lambda: inst.writeQuestions(template))

        assert [q.questions for q in emitted] == [['q2']]
        assert mock_warning.call_count == 1
        assert 'skipped 1 row(s) with no input text' in str(mock_warning.call_args)

    def test_filter_mode_keeps_a_falsey_but_present_text(self):
        """'0' is a legitimate prompt; only an absent/empty one is skipped."""
        questions = [
            {'text': 0, 'metadata': {'expected': 'zero'}},
            {'text': '0', 'metadata': {'expected': 'zero'}},
        ]
        inst = self._instance(questions)
        emitted = []
        inst.instance.writeQuestions.side_effect = lambda q: emitted.append(q)

        template = sys.modules['ai.common.schema'].Question()
        with patch('dataset_cobalt.IInstance.warning') as mock_warning:
            _dispatch(lambda: inst.writeQuestions(template))

        assert [q.questions for q in emitted] == [['0'], ['0']]
        assert mock_warning.call_count == 0

    def test_filter_mode_warns_once_for_many_skipped_rows(self):
        questions = [{'text': '', 'metadata': {'expected': str(i)}} for i in range(3)]
        inst = self._instance(questions)

        template = sys.modules['ai.common.schema'].Question()
        with patch('dataset_cobalt.IInstance.warning') as mock_warning:
            _dispatch(lambda: inst.writeQuestions(template))

        assert inst.instance.writeQuestions.call_count == 0
        assert mock_warning.call_count == 1
        assert 'skipped 3 row(s) with no input text' in str(mock_warning.call_args)

    def test_source_mode_scan_skips_the_text_less_row(self):
        endpoint = self._endpoint(
            {
                'source_type': 'inline',
                'items': [{'expected': 'Paris'}, {'input': 'q2', 'expected': 'a2'}],
                'sample_size': 0,
            }
        )
        entries = []

        with patch('dataset_cobalt.IEndpoint.warning') as mock_warning:
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert [e['objectTags']['text'] for e in entries] == ['q2']
        assert mock_warning.call_count == 1
        assert 'skipped 1 row(s) with no input text' in str(mock_warning.call_args)

    def test_source_mode_keeps_a_falsey_but_present_text(self):
        endpoint = self._endpoint(
            {
                'source_type': 'inline',
                'items': [{'input': 0, 'expected': 'zero'}],
                'sample_size': 0,
            }
        )
        entries = []

        with patch('dataset_cobalt.IEndpoint.warning') as mock_warning:
            endpoint.scanObjects('', lambda entry: entries.append(entry) or 0)

        assert [e['objectTags']['text'] for e in entries] == ['0']
        assert mock_warning.call_count == 0

    def test_render_object_does_not_send_a_text_less_entry(self):
        inst = IInstance()
        inst.instance = MagicMock()
        entry = MagicMock()
        entry.objectTags = {'text': '', 'metadata': {'expected': 'Paris'}}

        with patch('dataset_cobalt.IInstance.warning'), pytest.raises(Exception, match='No default to prevent'):
            inst.renderObject(entry)

        assert inst.instance.sendQuestions.call_count == 0

    def test_question_from_item_returns_none_for_a_text_less_row(self):
        from dataset_cobalt.common import question_from_item

        assert question_from_item({'metadata': {'expected': 'Paris'}}) is None
        assert question_from_item({'text': '', 'metadata': {}}) is None
        assert question_from_item({'text': None, 'metadata': {}}) is None
        assert question_from_item({'text': 0, 'metadata': {}}).questions == ['0']


class TestSampleSeedIsReproducible:
    """`dataset.seed` pins which rows Sample Size picks.

    The fallback lane used the process-global `random.sample`, so the same
    dataset and the same sample size produced a different subset on every run
    and disturbed global RNG state other nodes may rely on. A local
    `random.Random(seed)` fixes both. `random.Random(None)` still seeds from
    the OS, so a blank seed reproduces the previous behaviour exactly.
    """

    @staticmethod
    def _items(n=50):
        return [{'input': f'q{i}', 'expected': f'a{i}'} for i in range(n)]

    @staticmethod
    def _no_cobalt():
        return patch.dict(sys.modules, {'cobalt': None})

    def test_same_seed_gives_the_same_subset(self):
        loader = _make_loader()
        config = {'sample_size': 5, 'seed': 1234}
        with self._no_cobalt():
            first = loader.apply_transforms(self._items(), config)
            second = loader.apply_transforms(self._items(), config)
        assert [i['input'] for i in first] == [i['input'] for i in second]
        assert len(first) == 5

    def test_a_different_seed_gives_a_different_subset(self):
        loader = _make_loader()
        with self._no_cobalt():
            first = loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 1})
            second = loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 2})
        assert [i['input'] for i in first] != [i['input'] for i in second]

    @pytest.mark.parametrize(
        'config', [{'sample_size': 5}, {'sample_size': 5, 'seed': ''}, {'sample_size': 5, 'seed': None}]
    )
    def test_a_blank_seed_keeps_todays_behaviour(self, config):
        loader = _make_loader()
        with self._no_cobalt():
            result = loader.apply_transforms(self._items(), config)
        assert len(result) == 5
        assert all(item in self._items() for item in result)

    def test_the_global_rng_is_left_alone(self):
        """A local generator must not consume the process-global stream."""
        import random as _random

        loader = _make_loader()
        _random.seed(0)
        control = [_random.random() for _ in range(3)]

        _random.seed(0)
        with self._no_cobalt():
            loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 99})
        assert [_random.random() for _ in range(3)] == control

    def test_the_cobalt_lane_honours_the_same_seed(self):
        """Cobalt's Dataset.sample(n) takes no seed, so the node samples itself."""
        loader = _make_loader()
        config = {'sample_size': 5, 'seed': 4321}
        first = loader.apply_transforms(self._items(), config)
        second = loader.apply_transforms(self._items(), config)
        assert [i['input'] for i in first] == [i['input'] for i in second]
        assert len(first) == 5
        # MockDataset.sample(n) returns the first n items, so a result that is
        # not the head of the list proves the node did its own seeded draw
        # instead of delegating to the (seedless) cobalt Dataset.sample.
        assert [i['input'] for i in first] != ['q0', 'q1', 'q2', 'q3', 'q4']

    def test_the_two_lanes_agree_on_the_same_seed(self):
        """Seeded, the cobalt and pure-Python lanes must not diverge."""
        loader = _make_loader()
        config = {'sample_size': 5, 'seed': 777}
        with_cobalt = loader.apply_transforms(self._items(), config)
        with self._no_cobalt():
            without_cobalt = loader.apply_transforms(self._items(), config)
        assert [i['input'] for i in with_cobalt] == [i['input'] for i in without_cobalt]

    def test_an_unparseable_seed_is_reported(self):
        loader = _make_loader()
        with self._no_cobalt(), pytest.raises(ValueError):
            loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 'not-a-number'})

    @pytest.mark.parametrize('seed', [7.5, -0.5])
    def test_a_fractional_seed_is_rejected_rather_than_truncated(self, seed):
        """`int(7.5)` is 7, which pins a subset the user never asked for."""
        loader = _make_loader()
        with self._no_cobalt(), pytest.raises(ValueError, match='whole number'):
            loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': seed})

    def test_a_whole_float_seed_is_accepted(self):
        """7.0 is 7; only a fractional value is ambiguous."""
        loader = _make_loader()
        with self._no_cobalt():
            from_float = loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 7.0})
            from_int = loader.apply_transforms(self._items(), {'sample_size': 5, 'seed': 7})
        assert [i['input'] for i in from_float] == [i['input'] for i in from_int]

    def test_a_full_size_sample_keeps_the_original_order_in_both_lanes(self):
        """Seeded, a sample that covers the dataset must not shuffle one lane only.

        The fallback lane skips the draw when the sample covers everything, so
        the cobalt lane must skip it too: otherwise the same seed returns the
        same rows in a different order depending on whether cobalt is
        installed.
        """
        loader = _make_loader()
        items = self._items(5)
        config = {'sample_size': 5, 'seed': 1}

        with_cobalt = loader.apply_transforms(items, config)
        with self._no_cobalt():
            without_cobalt = loader.apply_transforms(items, config)

        expected = ['q0', 'q1', 'q2', 'q3', 'q4']
        assert [i['input'] for i in without_cobalt] == expected
        assert [i['input'] for i in with_cobalt] == expected

    def test_seed_is_declared_in_the_schema(self):
        """The user cannot pin the seed unless the panel offers the field."""
        import re

        schema_path = _REPO_ROOT / 'nodes' / 'src' / 'nodes' / 'dataset_cobalt' / 'services.json'
        raw = schema_path.read_text(encoding='utf-8')
        assert '"dataset.seed"' in raw
        default_block = re.search(r'"dataset\.default":\s*\{.*?\}', raw, re.S).group(0)
        assert 'dataset.seed' in default_block

    def test_the_seed_survives_config_extraction(self):
        """`dataset.seed` from the panel reaches the loader as `seed`."""
        endpoint = IEndpoint()
        endpoint.endpoint = MagicMock()
        endpoint.endpoint.logicalType = 'dataset_cobalt'
        endpoint.endpoint.serviceConfig = {
            'dataset.source_type': 'inline',
            'dataset.items': '[{"input": "q", "expected": "a"}]',
            'dataset.seed': 7,
        }
        endpoint.endpoint.bag = {}

        assert endpoint._extractConfig()['seed'] == 7


class TestSourceModeMetadataSurvivesTheEngineHandle:
    """`objectTags` is an engine IJson handle, not a dict, and the reference rode on it.

    A live run of ``examples/cobalt-evaluation.pipe`` against a real engine
    reached ``eval_cobalt`` with ``metadata == {}`` and scored all three rows
    0.0 with "One of output or expected is empty", while every unit test here
    passed: the tests hand ``renderObject`` a plain dict, and the engine hands
    it an ``IJson``. ``tags.get('metadata')`` then returns another ``IJson``,
    ``merge_metadata`` ignores every non-dict, and the reference answer was
    dropped on that one hop. ``common.plain_metadata`` converts the handle.
    """

    class _FakeIJson:
        """Minimal stand-in for the engine's IJson: dict-ish access plus toDict()."""

        def __init__(self, payload):
            """Wrap a payload the way the engine wraps an entry's objectTags."""
            self._payload = payload

        def get(self, key, default=None):
            """Return the member, itself wrapped when it is a mapping."""
            value = self._payload.get(key, default)
            return TestSourceModeMetadataSurvivesTheEngineHandle._FakeIJson(value) if isinstance(value, dict) else value

        def toDict(self):
            """Convert the handle to a plain dict, as the real binding does."""
            return dict(self._payload)

        def __bool__(self):
            """Report emptiness like the engine's handle does."""
            return bool(self._payload)

    def test_render_object_reads_metadata_through_the_engine_handle(self):
        inst = IInstance()
        inst.instance = MagicMock()
        entry = MagicMock()
        entry.objectTags = self._FakeIJson({'text': 'q', 'metadata': {'expected': 'a', 'dataset_id': 'row-1'}})

        _dispatch(lambda: inst.renderObject(entry))

        emitted = inst.instance.sendQuestions.call_args.args[0]
        assert emitted.questions == ['q']
        assert emitted.metadata['expected'] == 'a', (
            'the reference did not survive the source-mode hop: objectTags is an IJson handle, '
            'so its metadata member is not the dict merge_metadata requires'
        )
        assert emitted.metadata['dataset_id'] == 'row-1'

    def test_plain_metadata_converts_only_what_it_can(self):
        from dataset_cobalt.common import plain_metadata

        assert plain_metadata({'expected': 'a'}) == {'expected': 'a'}
        assert plain_metadata(self._FakeIJson({'expected': 'a'})) == {'expected': 'a'}
        assert plain_metadata(None) == {}
        assert plain_metadata('') == {}
        assert plain_metadata("{'expected': 'a'}") == {}

    def test_plain_metadata_copies_rather_than_aliases(self):
        from dataset_cobalt.common import plain_metadata

        source = {'expected': 'a'}
        converted = plain_metadata(source)
        converted['expected'] = 'b'

        assert source['expected'] == 'a'
