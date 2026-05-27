# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ModelServerOCR``'s img2table v1.x / v2.x compatibility shim.

The shim lives in ``nodes/src/nodes/ocr/IGlobal.py`` and needs to keep working
against both img2table majors:

- v1.x: subclass implements ``content()`` + ``to_ocr_dataframe()`` and the base
  ``OCRInstance.of()`` orchestrates them, returning an ``OCRDataframe``.
- v2.x: subclass overrides ``of()`` directly, returning an ``OCRData`` whose
  ``records`` dict is keyed by page number.

The OCR engine is stubbed (no model server / no real OCR backend), and
``IGlobal.py`` is loaded directly by file path so the engine venv's
``rocketlib`` / ``ai.common.*`` / ``depends`` are not required. ``sys.modules``
is snapshotted/restored around the stubbing so no state leaks into peer tests
in the same pytest session.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=ocr --verbose
"""

import contextlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Iterator

import pytest

# ---------------------------------------------------------------------------
# Scoped sys.modules manipulation
# ---------------------------------------------------------------------------
#
# IGlobal.py's top-level imports pull in engine-internal modules
# (rocketlib / ai.common.* / depends) and trigger img2table → cv2 → numpy. We
# need those to resolve at exec time but we MUST NOT leave our stubs lying in
# sys.modules afterwards: sibling tests in the same pytest session would
# either pick them up by accident or be unable to install their own.
#
# Mirror the snapshot/restore pattern used by
# nodes/test/chroma/test_convert_filter_explicit_none.py.

_STUB_NAMES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.config',
    'ai.common.opencv',
    'depends',
)


class _IGlobalBase:
    """Stand-in for ``rocketlib.IGlobalBase`` — only the name needs to exist."""


class _Config:
    """Stand-in for ``ai.common.config.Config``."""

    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        """Return an empty config; ``ModelServerOCR.__init__`` doesn't read it."""
        return {}


def _noop(*_a: object, **_kw: object) -> None:
    """No-op stub for ``rocketlib.debug`` and ``depends.depends``."""


def _install_min_stubs() -> None:
    """Plant just-enough fake modules so ``IGlobal.py``'s imports resolve."""

    def _mk(name: str, **attrs: object) -> None:
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = _IGlobalBase
    rocketlib.debug = _noop
    sys.modules['rocketlib'] = rocketlib

    ai = types.ModuleType('ai')
    ai.__path__ = []  # mark as package so sub-imports resolve
    sys.modules['ai'] = ai
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    sys.modules['ai.common'] = ai_common

    _mk('ai.common.config', Config=_Config)
    _mk('ai.common.opencv', cv2=object())
    _mk('depends', depends=_noop)


@contextlib.contextmanager
def _scoped_stubs() -> Iterator[None]:
    """
    Install stub modules for the duration of the block, restoring on exit.

    Also defends against sibling-test pollution: if a previous test (e.g.
    ``nodes/test/atlas/test_isdeleted_filter.py``) replaced ``sys.modules['numpy']``
    with a ``MagicMock``, ``cv2`` (pulled in transitively by img2table) cannot
    load against it. We pop those fake numpy/cv2 entries inside the scope and
    restore them on exit, so the previous test's state is preserved for any
    test that runs after us.
    """
    snapshot = {name: sys.modules.get(name) for name in _STUB_NAMES}

    numpy_snapshot: dict[str, types.ModuleType] = {}
    for name in list(sys.modules):
        if name == 'numpy' or name.startswith('numpy.') or name == 'cv2':
            mod = sys.modules[name]
            # Real packages have __path__; real modules have __file__. Anything
            # missing both is a stub (e.g. MagicMock) we need to evict so the
            # real engine package can load.
            if not hasattr(mod, '__path__') and not hasattr(mod, '__file__'):
                numpy_snapshot[name] = mod
                del sys.modules[name]

    _install_min_stubs()
    try:
        yield
    finally:
        for name, mod in snapshot.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod
        for name, mod in numpy_snapshot.items():
            sys.modules[name] = mod


# ---------------------------------------------------------------------------
# Load IGlobal.py under the scoped stubs
# ---------------------------------------------------------------------------

_iglobal_path = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'ocr' / 'IGlobal.py'

with _scoped_stubs():
    # ``importorskip`` honours the scoped numpy/cv2 cleanup — if img2table
    # itself isn't installed in this env, the whole module is skipped.
    pytest.importorskip('img2table', reason='img2table not installed in test env')

    import numpy as np  # noqa: E402  — real numpy bound here, survives restore

    _spec = importlib.util.spec_from_file_location('_ocr_iglobal_direct', _iglobal_path)
    _iglobal_mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_iglobal_mod)

ModelServerOCR = _iglobal_mod.ModelServerOCR
_IMG2TABLE_V2 = _iglobal_mod._IMG2TABLE_V2


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _StubOcr:
    """Stand-in for an ``ai.common.models`` OCR engine returning a canned result."""

    def __init__(self, result: dict) -> None:
        """
        Args:
            result: dict shaped like a model-server OCR response
                (``{'text': str, 'boxes': [...]}``) returned from every ``read``.
        """
        self.result = result
        self.calls: list[bytes] = []

    def read(self, image_bytes: bytes) -> dict:
        """Record the call and return the pre-configured result."""
        self.calls.append(image_bytes)
        return self.result


class _StubDocument:
    """Minimal img2table-like document exposing ``.images`` as numpy arrays."""

    def __init__(self, n_pages: int = 1) -> None:
        """
        Args:
            n_pages: how many blank 10x20 RGB pages to attach to ``.images``.
        """
        self.images = [np.zeros((10, 20, 3), dtype=np.uint8) for _ in range(n_pages)]


@pytest.fixture
def adapter():
    """A ``ModelServerOCR`` with a stubbed OCR engine returning one bbox match."""
    a = ModelServerOCR(engine='doctr')
    a._ocr = _StubOcr({'text': '', 'boxes': [{'bbox': [0, 0, 5, 5], 'text': 'hi', 'confidence': 0.9}]})
    return a


# ---------------------------------------------------------------------------
# _format_to_v2_records — pure helper, behaviour identical on both majors
# ---------------------------------------------------------------------------


def test_format_to_v2_records_with_boxes(adapter) -> None:
    """Each entry in ``boxes`` becomes one v2 word-record with rounded confidence."""
    result = {
        'text': 'ignored when boxes present',
        'boxes': [
            {'bbox': [1, 2, 3, 4], 'text': 'hello', 'confidence': 0.8},
            {'bbox': [5, 6, 7, 8], 'text': 'world', 'confidence': 1.0},
        ],
    }

    records = adapter._format_to_v2_records(result, (10, 20, 3), page=0)

    assert records == [
        {
            'id': 'word_1_1',
            'parent': 'word_1_1',
            'value': 'hello',
            'confidence': 80,
            'x1': 1,
            'y1': 2,
            'x2': 3,
            'y2': 4,
        },
        {
            'id': 'word_1_2',
            'parent': 'word_1_2',
            'value': 'world',
            'confidence': 100,
            'x1': 5,
            'y1': 6,
            'x2': 7,
            'y2': 8,
        },
    ]


def test_format_to_v2_records_text_only_uses_image_bbox(adapter) -> None:
    """A bare ``text`` field (no boxes) yields one record covering the whole image."""
    records = adapter._format_to_v2_records({'text': 'fallback', 'boxes': []}, (10, 20, 3), page=2)

    assert records == [
        {
            'id': 'word_3_1',
            'parent': 'word_3_1',
            'value': 'fallback',
            'confidence': 100,
            'x1': 0,
            'y1': 0,
            'x2': 20,
            'y2': 10,
        }
    ]


def test_format_to_v2_records_empty(adapter) -> None:
    """An empty result produces no records."""
    assert adapter._format_to_v2_records({'text': '', 'boxes': []}, (10, 20, 3), 0) == []


def test_format_to_v2_records_skips_non_dict_boxes(adapter) -> None:
    """Non-dict entries in ``boxes`` are ignored (defensive against bad results)."""
    result = {
        'text': '',
        'boxes': [
            'garbage',
            {'bbox': [0, 0, 1, 1], 'text': 'ok', 'confidence': 0.5},
            None,
        ],
    }

    records = adapter._format_to_v2_records(result, (10, 20, 3), page=0)

    assert len(records) == 1
    assert records[0]['value'] == 'ok'
    assert records[0]['confidence'] == 50


def test_format_to_v2_records_skips_malformed_bbox(adapter) -> None:
    """Boxes with short or non-numeric ``bbox`` values are skipped, not raised."""
    result = {
        'text': '',
        'boxes': [
            {'bbox': [1, 2, 3], 'text': 'too-short', 'confidence': 1.0},
            {'bbox': 'not-a-list', 'text': 'wrong-type', 'confidence': 1.0},
            {'bbox': [1, 'x', 3, 4], 'text': 'non-numeric', 'confidence': 1.0},
            {'bbox': [10, 20, 30, 40], 'text': 'good', 'confidence': 0.5},
        ],
    }

    records = adapter._format_to_v2_records(result, (10, 20, 3), page=0)

    assert len(records) == 1
    assert records[0]['value'] == 'good'


def test_format_to_v2_records_text_fallback_when_all_boxes_invalid(adapter) -> None:
    """If every entry in ``boxes`` is malformed but ``text`` is set, fall back to text."""
    result = {
        'text': 'document-level',
        'boxes': [
            {'bbox': [1, 2], 'text': 'bad', 'confidence': 1.0},
            'garbage',
        ],
    }

    records = adapter._format_to_v2_records(result, (10, 20, 3), page=0)

    assert len(records) == 1
    assert records[0]['value'] == 'document-level'
    assert records[0]['x2'] == 20  # full-image bbox from image_shape


# ---------------------------------------------------------------------------
# of() — branches on the installed img2table major
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _IMG2TABLE_V2, reason='requires img2table >= 2.0')
def test_of_returns_ocrdata_on_v2(adapter) -> None:
    """v2: ``of()`` returns an ``OCRData`` with records keyed by page."""
    from img2table.ocr._types import OCRData

    out = adapter.of(_StubDocument(n_pages=2))

    assert isinstance(out, OCRData)
    assert set(out.records.keys()) == {0, 1}
    assert out.records[0][0]['value'] == 'hi'
    assert out.records[0][0]['confidence'] == 90
    # Page index must propagate into the per-record id.
    assert out.records[1][0]['id'] == 'word_2_1'


@pytest.mark.skipif(not _IMG2TABLE_V2, reason='requires img2table >= 2.0')
def test_of_empty_pages_still_return_ocrdata_v2(adapter) -> None:
    """v2: pages with no detected text yield ``OCRData`` carrying empty record lists.

    ``None`` is reserved for "couldn't process at all" — see the no-images test
    below — so downstream code can rely on a non-None ``OCRData`` whenever the
    document actually had pages.
    """
    from img2table.ocr._types import OCRData

    adapter._ocr = _StubOcr({'text': '', 'boxes': []})

    out = adapter.of(_StubDocument(n_pages=2))

    assert isinstance(out, OCRData)
    assert out.records == {0: [], 1: []}


@pytest.mark.skipif(not _IMG2TABLE_V2, reason='requires img2table >= 2.0')
def test_of_returns_none_for_document_with_no_images_v2(adapter) -> None:
    """v2: a document with no images returns ``None`` — nothing to extract."""

    class _Empty:
        images: list = []

    assert adapter.of(_Empty()) is None


@pytest.mark.skipif(_IMG2TABLE_V2, reason='requires img2table < 2.0')
def test_of_delegates_to_base_class_on_v1(adapter) -> None:
    """v1: ``of()`` defers to the base class, which builds an ``OCRDataframe``."""
    from img2table.ocr.data import OCRDataframe

    out = adapter.of(_StubDocument())

    assert isinstance(out, OCRDataframe)


# ---------------------------------------------------------------------------
# Legacy v1 surface — must keep working because v1's base-class of() drives it
# ---------------------------------------------------------------------------


def test_content_returns_easyocr_format(adapter) -> None:
    """``content()`` (called by v1's base ``of``) yields per-page EasyOCR tuples."""
    pages = adapter.content(_StubDocument())

    assert len(pages) == 1
    bbox_points, text, conf = pages[0][0]
    assert text == 'hi'
    assert conf == 0.9
    assert bbox_points == [[0, 0], [5, 0], [5, 5], [0, 5]]
