# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: thumbnail numbers its documents within the object (#1964).

One object can deliver several image streams — a cropper's crops, a frame grabber's
frames — and each thumbnail is its own chunk of that object. Every one of them used to
claim chunk 0, so a consumer keyed on ``(objectId, chunkId)`` kept overwriting one row.

``ImageProcessor`` is stubbed: the identity of the pixels is irrelevant here, and the
node's own image handling is covered elsewhere.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

from rocketlib import AVI_ACTION

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from thumbnail.IInstance import IInstance  # noqa: E402

# Reached through the class rather than by importing the submodule: the package's
# __init__ binds the name `IInstance` to the class, so `thumbnail.IInstance` is the
# class and not the module it lives in.
thumbnail_module = sys.modules[IInstance.__module__]


class _FakeThumb:
    """Stands in for the PIL image a thumbnail would be."""

    width = 128
    height = 128


class _FakeImageProcessor:
    """Enough of ``ImageProcessor`` for the document path."""

    @staticmethod
    def load_image_from_bytes(data):
        return _FakeThumb()

    @staticmethod
    def get_thumbnail(image):
        return _FakeThumb()

    @staticmethod
    def get_base64(image):
        return 'YmFzZTY0'

    @staticmethod
    def get_bytes(image):
        return b'\x89PNG-thumb'


class _Obj:
    """Minimal currentObject: what DocMetadata reads off the instance context."""

    objectId = 'obj-1'
    parent = '/inbox/album.png'
    permissionId = 0
    componentId = 'comp-test'
    hasName = False
    name = None
    path = '/inbox/album.png'


class _Capture:
    """Stand-in for the engine binding (``self.instance``)."""

    def __init__(self, listeners=('documents',)):
        self.docs = []
        self.images = []
        self._listeners = listeners
        self.currentObject = _Obj()

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane in self._listeners

    def writeDocuments(self, documents):  # noqa: N802 (engine method name)
        self.docs.extend(documents)

    def writeImage(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.images.append((action, mime, buffer))


class _Endpoint:
    """Stand-in for ``IEndpoint``: DocMetadata reads the node id off jobConfig."""

    def __init__(self):
        self.endpoint = SimpleNamespace(jobConfig={'nodeId': 'test-node'})


def _instance(monkeypatch, listeners=('documents',)):
    """A thumbnail node wired to capture documents, with image handling stubbed."""
    monkeypatch.setattr(thumbnail_module, 'ImageProcessor', _FakeImageProcessor)
    inst = IInstance()
    inst.instance = _Capture(listeners)
    inst.IEndpoint = _Endpoint()
    inst.preventDefault = lambda: 'PREVENT_DEFAULT'
    inst.open(None)
    return inst


def _stream(inst, data=b'\x89PNG-source'):
    """One complete image stream through the node."""
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', data)
    inst.writeImage(AVI_ACTION.END, 'image/png')


def test_each_stream_of_one_object_gets_its_own_chunk_id(monkeypatch):
    """The case that collapsed a fan-out object into a single chunk."""
    inst = _instance(monkeypatch)

    for _ in range(3):
        _stream(inst)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1, 2]


def test_a_single_stream_still_starts_at_zero(monkeypatch):
    """The ordinary one-image object is unchanged."""
    inst = _instance(monkeypatch)

    _stream(inst)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0]


def test_the_counter_restarts_for_the_next_object(monkeypatch):
    """Chunk ids number an object's own chunks, so they begin again with each object."""
    inst = _instance(monkeypatch)
    _stream(inst)
    _stream(inst)

    inst.open(None)  # the engine opens the next object
    _stream(inst)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1, 0]


def test_nothing_is_numbered_when_no_one_listens_for_documents(monkeypatch):
    """With only the image lane wired there are no documents to number."""
    inst = _instance(monkeypatch, listeners=('image',))

    _stream(inst)

    assert inst.instance.docs == []
