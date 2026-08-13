# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Regression tests for ``Reader._to_bytes`` in ``nodes/src/nodes/ocr/ocr.py``.

``writeImage`` accumulates the image into a ``bytearray``, which is not a
``bytes`` subclass. Before the fix it fell through to
``str(image_data).encode('utf-8')`` and PIL was handed the object's repr.

``ocr.py`` is loaded by file path with ``rocketlib``/``ai.common.*`` stubbed,
mirroring ``test_model_server_ocr.py``.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=ocr --verbose
"""

import contextlib
import importlib.util
import io
import sys
import types
from pathlib import Path
from typing import Iterator

import pytest

# numpy/PIL are stubbed too: the bytes-like branch under test touches neither, and
# a fresh OSS dist has no Pillow (the image nodes are in skip_nodes, so nothing
# triggers its depends()). Requiring them would make this guard skip silently there.
_STUB_NAMES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.config',
    'ai.common.models',
    'ai.common.reader',
    'numpy',
    'PIL',
    'PIL.Image',
)

# 2x2 red PNG, so no image library is needed to produce a valid fixture
PNG_2X2 = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x02'
    b'\x00\x00\x00\xfd\xd4\x9as\x00\x00\x00\x16IDATx\x9cc\xfc\xcf\xc0\xc0\xc0\xc0'
    b'\xc0\xc4\xc0\xc0\xc0\xc0\xc0\x00\x00\r\x1d\x01\x03j\xc2\x9b\xe9\x00\x00\x00'
    b'\x00IEND\xaeB`\x82'
)


class _ReaderBase:
    """Stand-in for ``ai.common.reader.ReaderBase`` — only the name needs to exist."""

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass


class _Config:
    """Stand-in for ``ai.common.config.Config``."""

    @staticmethod
    def getNodeConfig(*_a: object, **_kw: object) -> dict:
        return {}


def _noop(*_a: object, **_kw: object) -> None:
    """No-op stub for ``rocketlib.debug``."""


class _Engine:
    """Stand-in for the ai.common.models OCR engine classes."""

    def __init__(self, *_a: object, **_kw: object) -> None:
        pass


class _NDArray:
    """Stand-in for ``numpy.ndarray`` — only needs to be a type for isinstance."""


class _PILImage:
    """Stand-in for ``PIL.Image.Image`` — only needs to be a type for isinstance."""


def _install_min_stubs() -> None:
    """Plant just-enough fake modules so ``ocr.py``'s imports resolve."""

    def _mk(name: str, **attrs: object) -> None:
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m

    _mk('rocketlib', debug=_noop)

    ai = types.ModuleType('ai')
    ai.__path__ = []  # mark as package so sub-imports resolve
    sys.modules['ai'] = ai
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    sys.modules['ai.common'] = ai_common

    _mk('ai.common.config', Config=_Config)
    _mk('ai.common.reader', ReaderBase=_ReaderBase)
    _mk('ai.common.models', EasyOCR=_Engine, DocTR=_Engine, Surya=_Engine, TrOCR=_Engine)
    _mk('numpy', ndarray=_NDArray)

    pil = types.ModuleType('PIL')
    pil.__path__ = []
    sys.modules['PIL'] = pil
    pil_image = types.ModuleType('PIL.Image')
    pil_image.Image = _PILImage
    sys.modules['PIL.Image'] = pil_image
    pil.Image = pil_image


@contextlib.contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Install stub modules for the duration of the block, restoring on exit."""
    snapshot = {name: sys.modules.get(name) for name in _STUB_NAMES}

    # A sibling test's MagicMock numpy would break the real numpy/PIL imports
    numpy_snapshot: dict[str, types.ModuleType] = {}
    for name in list(sys.modules):
        if name == 'numpy' or name.startswith('numpy.'):
            mod = sys.modules[name]
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


_ocr_path = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'ocr' / 'ocr.py'

with _scoped_stubs():
    _spec = importlib.util.spec_from_file_location('_ocr_under_test', _ocr_path)
    assert _spec is not None and _spec.loader is not None
    _ocr = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_ocr)

Reader = _ocr.Reader


@pytest.fixture
def reader() -> object:
    """A ``Reader`` with ``__init__`` bypassed — ``_to_bytes`` needs no engine."""
    return Reader.__new__(Reader)


def _png_bytes() -> bytes:
    return PNG_2X2


class TestToBytesPassthrough:
    """Bytes-like inputs must survive byte-identical."""

    def test_bytes_unchanged(self, reader: object) -> None:
        raw = _png_bytes()
        assert reader._to_bytes(raw) == raw

    def test_bytearray_unchanged(self, reader: object) -> None:
        """The #1525 regression: writeImage hands over a bytearray, not bytes."""
        raw = _png_bytes()
        out = reader._to_bytes(bytearray(raw))
        assert isinstance(out, bytes)
        assert out == raw

    def test_memoryview_unchanged(self, reader: object) -> None:
        raw = _png_bytes()
        out = reader._to_bytes(memoryview(raw))
        assert isinstance(out, bytes)
        assert out == raw


class TestToBytesRegression:
    """The specific corruption shape #1525 produced."""

    def test_bytearray_is_not_stringified(self, reader: object) -> None:
        raw = _png_bytes()
        out = reader._to_bytes(bytearray(raw))
        assert not out.startswith(b'bytearray('), 'bytearray was stringified to its repr'
        assert len(out) == len(raw), 'length changed - input was re-encoded, not passed through'

    def test_result_is_decodable_by_pil(self, reader: object) -> None:
        """Only this assertion needs real Pillow; the guards above must not."""
        Image = pytest.importorskip('PIL.Image', reason='Pillow not installed in test env')

        out = reader._to_bytes(bytearray(_png_bytes()))
        with Image.open(io.BytesIO(out)) as img:
            assert img.format == 'PNG'
            assert img.size == (2, 2)


class TestToBytesUnsupported:
    """An unsupported type is a bug, not data to be silently re-encoded."""

    @pytest.mark.parametrize('bad', ['a string', 42, None, {'not': 'an image'}])
    def test_unsupported_type_raises(self, reader: object, bad: object) -> None:
        with pytest.raises(TypeError, match='cannot convert'):
            reader._to_bytes(bad)

    def test_error_names_the_offending_type(self, reader: object) -> None:
        with pytest.raises(TypeError, match='dict'):
            reader._to_bytes({'not': 'an image'})
