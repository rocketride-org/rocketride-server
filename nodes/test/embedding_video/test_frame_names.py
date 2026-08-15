# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: embedding_video names frames within the object (#1965).

One object can carry several video streams, and each video's frame positions start at
zero. Naming a frame by that position made the second video repeat the first one's
names — and when both streams share a parent the derived stems match too, so nothing
told the two sets apart.

Drives the real ``writeVideo`` BEGIN/WRITE/END with OpenCV and the embedding model
stubbed: the frames' pixels and the vector they produce are irrelevant here, only the
labelling is. Both are reached through ``from ... import`` inside ``_process_video``, so
patching the module attribute is what the node actually resolves at call time.
"""

import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import ai.common.image
import ai.common.opencv
import pytest
from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from embedding_video.IInstance import IInstance  # noqa: E402

FRAMES_PER_VIDEO = 2


class _FakeCapture:
    """A VideoCapture that yields a fixed number of frames and nothing more."""

    def __init__(self, frames):
        self._frames = frames
        self._pos = 0

    def isOpened(self):  # noqa: N802 (OpenCV method name)
        return True

    def get(self, prop):
        return {_FakeCv2.CAP_PROP_FPS: 1.0, _FakeCv2.CAP_PROP_FRAME_COUNT: float(self._frames)}.get(prop, 0.0)

    def set(self, prop, value):
        if prop == _FakeCv2.CAP_PROP_POS_FRAMES:
            self._pos = int(value)

    def read(self):
        if self._pos >= self._frames:
            return False, None
        self._pos += 1
        return True, object()  # an opaque "frame"; nothing here inspects pixels

    def release(self):
        pass


class _FakeBuffer:
    def tobytes(self):
        return b'\x89PNG-frame'


class _FakeCv2:
    """Only the surface `_process_video` touches."""

    CAP_PROP_FPS = 5
    CAP_PROP_FRAME_COUNT = 7
    CAP_PROP_POS_FRAMES = 1

    @staticmethod
    def VideoCapture(path):  # noqa: N802 (OpenCV factory name)
        return _FakeCapture(FRAMES_PER_VIDEO)

    @staticmethod
    def imencode(ext, frame):
        return True, _FakeBuffer()


class _FakeImageProcessor:
    @staticmethod
    def load_image_from_bytes(data):
        return object()

    @staticmethod
    def get_base64(image):
        return 'YmFzZTY0'


class _Obj:
    """Minimal currentObject: what DocMetadata reads off the instance context."""

    objectId = 'v1'
    parent = '/inbox/clip.mp4'
    permissionId = 0
    componentId = 'comp-test'
    hasName = False
    name = None
    path = '/inbox/clip.mp4'


class _Capture:
    """Stand-in for the engine binding (``self.instance``)."""

    def __init__(self):
        self.docs = []
        self.currentObject = _Obj()

    def writeDocuments(self, documents):  # noqa: N802 (engine method name)
        self.docs.extend(documents)


class _Endpoint:
    """Stand-in for ``IEndpoint``: DocMetadata reads the node id off jobConfig."""

    def __init__(self):
        self.endpoint = SimpleNamespace(jobConfig={'nodeId': 'test-node'})


class _FakeGlobal:
    """The extraction settings and embedding model `_process_video` reads."""

    start_time = 0.0
    duration = 0.0
    frame_interval = 1.0
    max_frames = 0
    max_video_size_bytes = 10 * 1024 * 1024

    def __init__(self):
        self.device_lock = threading.Lock()
        self.embedding = SimpleNamespace(
            create_image_embedding=lambda image: [0.1, 0.2],
            model_name='test-model',
        )


def _descriptor_payload():
    """A video descriptor whose stem is the same for every stream of this object."""
    doc = build_stream_descriptor(
        None,
        'video',
        objectId='v1',
        parent='/inbox/clip.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        source_mime='video/mp4',
        size=1024,
        stream_index=0,
    )
    return descriptor_to_payload(doc)


@pytest.fixture
def node(monkeypatch):
    """An embedding_video node with OpenCV and the embedding model stubbed."""
    monkeypatch.setattr(ai.common.opencv, 'cv2', _FakeCv2)
    monkeypatch.setattr(ai.common.image, 'ImageProcessor', _FakeImageProcessor)

    inst = IInstance()
    inst.instance = _Capture()
    inst.IEndpoint = _Endpoint()
    inst.IGlobal = _FakeGlobal()
    inst.open(None)
    return inst


def _video(inst, payload=None):
    """One complete video stream through the node."""
    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', _descriptor_payload() if payload is None else payload)
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'fake-video-bytes')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')


def test_two_videos_in_one_object_do_not_repeat_frame_names(node):
    """The case #1965 reports: both videos yield frames 0 and 1 at the same stem."""
    _video(node)
    _video(node)

    names = [doc.metadata.name for doc in node.instance.docs]
    assert names == ['clip.frame0', 'clip.frame1', 'clip.frame2', 'clip.frame3']
    assert len(set(names)) == 4, 'a name identifies one frame of the object'


def test_names_and_chunk_ids_agree(node):
    """Both label the same frame, so they must not drift apart."""
    _video(node)
    _video(node)

    for doc in node.instance.docs:
        assert doc.metadata.name == f'clip.frame{doc.metadata.chunkId}'


def test_the_true_position_in_the_video_is_kept(node):
    """Renaming must not lose where the frame actually came from."""
    _video(node)
    _video(node)

    # fps 1.0 and a 1s interval, so each video contributes positions 0 and 1.
    assert [doc.metadata.frame_number for doc in node.instance.docs] == [0, 1, 0, 1]


def test_a_single_video_is_unchanged(node):
    """The ordinary one-video object still numbers from zero."""
    _video(node)

    assert [doc.metadata.name for doc in node.instance.docs] == ['clip.frame0', 'clip.frame1']


def test_a_video_without_a_descriptor_emits_no_name(node):
    """Nothing to derive a stem from, so `attach_name` stays a no-op."""
    _video(node, payload=b'')

    assert node.instance.docs, 'frames are still embedded without a descriptor'
    assert all(getattr(doc.metadata, 'name', None) is None for doc in node.instance.docs)
