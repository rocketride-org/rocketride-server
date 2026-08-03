# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the OCR node's ``documents`` input lane (``IInstance.writeDocuments``).

Guards two defects that survived since the initial commit because the fulltest
feeds ``image/png``, which ``_determine_lane`` routes to the ``image`` lane:

- ``self.IGlobal.reader(image_data)`` — neither ``Reader`` nor ``ReaderBase``
  defines ``__call__``, so it raised ``TypeError`` on the first document.
- ``self.writeText(text)`` — that is ``IInstanceBase``'s inbound handler, whose
  body is ``pass``. The emitter is ``self.instance.writeText``.

``IInstance.py`` is loaded by file path under a synthetic parent package so its
``from .IGlobal import IGlobal`` resolves without the engine venv.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=ocr --verbose
"""

import base64
import contextlib
import importlib.util
import sys
import threading
import types
from pathlib import Path
from typing import Iterator

import pytest

_PKG = '_ocr_pkg_under_test'

_STUB_NAMES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.avi',
    'ai.common.avi.descriptor',
    'numpy',
    'PIL',
    'PIL.Image',
    _PKG,
    f'{_PKG}.IGlobal',
)


class _AVI_ACTION:
    BEGIN, WRITE, END = 0, 1, 2


class _Entry:
    pass


class _Doc:
    """Stand-in for ``ai.common.schema.Doc``."""

    def __init__(self, type: str, page_content: str, metadata: dict | None = None) -> None:
        self.type = type
        self.page_content = page_content
        self.metadata = metadata or {}

    def model_copy(self) -> '_Doc':
        return _Doc(self.type, self.page_content, dict(self.metadata))


class _IInstanceBase:
    """Stand-in for ``rocketlib.IInstanceBase``.

    ``writeText`` mirrors the real inbound handler, which is a ``pass`` body —
    here it records instead, so a test can prove it is not used as an emitter.
    """

    def writeText(self, text) -> None:
        self.inbound_writeText.append(text)

    def preventDefault(self) -> str:
        return 'prevented'


def _install_min_stubs() -> None:
    def _mk(name: str, **attrs: object) -> None:
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m

    _mk('rocketlib', IInstanceBase=_IInstanceBase, AVI_ACTION=_AVI_ACTION, Entry=_Entry)

    ai = types.ModuleType('ai')
    ai.__path__ = []
    sys.modules['ai'] = ai
    for name in ('ai.common', 'ai.common.avi'):
        m = types.ModuleType(name)
        m.__path__ = []
        sys.modules[name] = m

    _mk('ai.common.schema', Doc=_Doc)
    _mk('ai.common.avi.descriptor', rename_ext=lambda metadata, ext: metadata)
    _mk('numpy', array=lambda *a, **kw: None)

    pil = types.ModuleType('PIL')
    pil.__path__ = []
    sys.modules['PIL'] = pil
    pil_image = types.ModuleType('PIL.Image')
    pil_image.open = lambda *a, **kw: None
    sys.modules['PIL.Image'] = pil_image
    pil.Image = pil_image

    # Synthetic parent so IInstance.py's `from .IGlobal import IGlobal` resolves
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = []
    sys.modules[_PKG] = pkg
    _mk(f'{_PKG}.IGlobal', IGlobal=object)


@contextlib.contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Install stub modules for the duration of the block, restoring on exit."""
    snapshot = {name: sys.modules.get(name) for name in _STUB_NAMES}
    _install_min_stubs()
    try:
        yield
    finally:
        for name, mod in snapshot.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


_iinstance_path = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'ocr' / 'IInstance.py'

with _scoped_stubs():
    _spec = importlib.util.spec_from_file_location(f'{_PKG}.IInstance', _iinstance_path)
    assert _spec is not None and _spec.loader is not None
    _iinstance_mod = importlib.util.module_from_spec(_spec)
    _iinstance_mod.__package__ = _PKG
    sys.modules[f'{_PKG}.IInstance'] = _iinstance_mod
    _spec.loader.exec_module(_iinstance_mod)
    sys.modules.pop(f'{_PKG}.IInstance', None)

IInstance = _iinstance_mod.IInstance


class _StubReader:
    """Stand-in for ``ocr.Reader``. Deliberately defines no ``__call__``."""

    def __init__(self, result) -> None:
        self.result = result
        self.calls: list[bytes] = []

    def read(self, image_data):
        self.calls.append(bytes(image_data))
        return self.result


class _StubIGlobal:
    def __init__(self, reader: _StubReader) -> None:
        self.reader = reader
        self.readerLock = threading.Lock()
        # no `table_ocr` attribute, so extract_tables_from_image returns early


class _StubInstance:
    def __init__(self, lanes: tuple[str, ...]) -> None:
        self._lanes = lanes
        self.texts: list = []
        self.documents: list = []

    def hasListener(self, lane: str) -> bool:
        return lane in self._lanes

    def writeText(self, text) -> None:
        self.texts.append(text)

    def writeTable(self, table) -> None:
        pass

    def writeDocuments(self, docs) -> None:
        self.documents.append(docs)


PNG_BYTES = b'\x89PNG\r\n\x1a\n-not-a-real-png-but-opaque-to-the-node'


def _make(lanes: tuple[str, ...] = ('text',), result='hello world'):
    node = IInstance.__new__(IInstance)
    node.inbound_writeText = []
    node.IGlobal = _StubIGlobal(_StubReader(result))
    node.instance = _StubInstance(lanes)
    return node


def _doc() -> _Doc:
    return _Doc(type='Image', page_content=base64.b64encode(PNG_BYTES).decode())


class TestReaderIsInvokedCorrectly:
    def test_calls_read_not_the_instance(self) -> None:
        node = _make()
        node.writeDocuments([_doc()])

        assert node.IGlobal.reader.calls == [PNG_BYTES]

    def test_reader_is_not_callable(self) -> None:
        """The old code did reader(image_data); nothing in the MRO allows that."""
        reader = _StubReader('x')
        assert not callable(reader)
        with pytest.raises(TypeError, match='not callable'):
            reader(PNG_BYTES)


class TestTextIsEmitted:
    def test_text_goes_to_the_emitter(self) -> None:
        node = _make(result='hello world')
        node.writeDocuments([_doc()])

        assert node.instance.texts == ['hello world']

    def test_inbound_handler_is_not_used_as_emitter(self) -> None:
        """self.writeText is IInstanceBase's inbound handler — a `pass` body."""
        node = _make()
        node.writeDocuments([_doc()])

        assert node.inbound_writeText == [], 'text was sent to the inbound handler and lost'

    def test_no_text_lane_means_no_emit(self) -> None:
        node = _make(lanes=())
        node.writeDocuments([_doc()])

        assert node.instance.texts == []

    def test_list_result_is_joined(self) -> None:
        node = _make(result=['hello', 'world'])
        node.writeDocuments([_doc()])

        assert node.instance.texts == ['hello world']


class TestDocumentsLane:
    def test_emits_converted_documents(self) -> None:
        node = _make(lanes=('documents',), result='extracted')
        assert node.writeDocuments([_doc()]) == 'prevented'

        assert len(node.instance.documents) == 1
        (txtdoc,) = node.instance.documents[0]
        assert txtdoc.type == 'Document'
        assert txtdoc.page_content == 'extracted'

    def test_rejects_non_image_documents(self) -> None:
        node = _make()
        with pytest.raises(ValueError, match='must be "image"'):
            node.writeDocuments([_Doc(type='Document', page_content='')])
