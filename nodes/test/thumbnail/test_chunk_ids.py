# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression coverage for sequential thumbnail document identities."""

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

from rocketlib import AVI_ACTION

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

thumbnail_module = importlib.import_module('thumbnail.IInstance')
IInstance = thumbnail_module.IInstance


class _Capture:
    """Minimal engine binding that records emitted thumbnail documents."""

    def __init__(self):
        self.documents = []
        self.currentObject = SimpleNamespace(
            objectId='album-1',
            path='/inbox/album.pdf',
            permissionId=0,
            componentId='thumbnail-test',
        )

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane == 'documents'

    def writeDocuments(self, documents):  # noqa: N802 (engine method name)
        self.documents.extend(documents)


class _Endpoint:
    endpoint = SimpleNamespace(jobConfig={'nodeId': 'thumbnail-node'})


def _drive_image(inst, payload):
    """Send one complete image stream and swallow the engine preventDefault signal."""
    for action, buffer in (
        (AVI_ACTION.BEGIN, b''),
        (AVI_ACTION.WRITE, payload),
        (AVI_ACTION.END, b''),
    ):
        try:
            inst.writeImage(action, 'image/png', buffer)
        except Exception:
            pass


def test_sequential_images_receive_distinct_chunk_ids(monkeypatch):
    """Every thumbnail from one object must have a stable, unique document key."""
    image = SimpleNamespace(width=640, height=480)
    thumbnail = SimpleNamespace(width=128, height=96)
    monkeypatch.setattr(thumbnail_module.ImageProcessor, 'load_image_from_bytes', lambda _: image)
    monkeypatch.setattr(thumbnail_module.ImageProcessor, 'get_thumbnail', lambda _: thumbnail)
    monkeypatch.setattr(thumbnail_module.ImageProcessor, 'get_base64', lambda _: 'dGh1bWJuYWls')

    inst = IInstance()
    inst.instance = _Capture()
    inst.IEndpoint = _Endpoint()
    inst.open(inst.instance.currentObject)

    _drive_image(inst, b'first-image')
    _drive_image(inst, b'second-image')
    _drive_image(inst, b'third-image')

    assert [doc.metadata.chunkId for doc in inst.instance.documents] == [0, 1, 2]
