# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: frame_grabber numbers frames within the object (#1963).

One object can carry several video streams, and each video's frame positions start at
zero. Naming frames by that position made the second video repeat the first one's chunk
ids and names — and when both videos share a parent, the derived stems match too, so
nothing told them apart.

Drives ``_frame_callback`` directly: that is where a decoded frame enters the node, and
it keeps the test clear of ffmpeg. The extractor's own side of #1963 — a restart handing
over stale frame info — is covered in ``packages/ai/tests/ai/common/avi/test_frame.py``.
"""

import json
import struct
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from frame_grabber.IInstance import IInstance  # noqa: E402


def _png(width=2, height=1):
    """A structurally valid PNG, so the node's best-effort dimension read succeeds."""

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    raw = b''.join(b'\x00' + b'\x00' * 3 * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


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

    def __init__(self, listeners=('documents', 'image')):
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


def _descriptor():
    """A video descriptor whose stem is the same for every stream of this object."""
    return build_stream_descriptor(
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


def _instance(listeners=('documents', 'image')):
    """A frame_grabber node wired to capture what it emits."""
    inst = IInstance()
    inst.instance = _Capture(listeners)
    inst.IEndpoint = _Endpoint()
    inst._watermark = False
    inst._source_descriptor = _descriptor()
    inst.open(None)
    return inst


def _begin_names(inst):
    """The `name` each image BEGIN enrichment carries, in order."""
    names = []
    for action, _mime, buffer in inst.instance.images:
        if action == AVI_ACTION.BEGIN and buffer:
            names.append(json.loads(bytes(buffer).decode('utf-8')).get('name'))
    return names


def test_two_videos_in_one_object_do_not_repeat_chunk_ids():
    """Both videos report frames 0 and 1; the object must still see four chunks."""
    inst = _instance()

    for frame_number in (0, 1):  # first video
        inst._frame_callback(_png(), frame_number, frame_number / 30.0)
    for frame_number in (0, 1):  # second video, positions start again
        inst._frame_callback(_png(), frame_number, frame_number / 30.0)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1, 2, 3]


def test_two_videos_in_one_object_do_not_repeat_names():
    """The stems match when both streams share a parent, so the index has to differ."""
    inst = _instance()

    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)
    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)

    names = [doc.metadata.name for doc in inst.instance.docs]
    assert names == ['clip.frame0.png', 'clip.frame1.png', 'clip.frame2.png', 'clip.frame3.png']
    assert len(set(names)) == 4, 'a name identifies one frame of the object'


def test_the_image_lane_is_named_the_same_way():
    """Both lanes label the frame, and they must agree."""
    inst = _instance()

    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)
    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)

    assert _begin_names(inst) == [doc.metadata.name for doc in inst.instance.docs]


def test_the_true_position_in_the_video_is_kept():
    """Renaming must not lose where the frame actually came from."""
    inst = _instance()

    inst._frame_callback(_png(), 0, 0.0)
    inst._frame_callback(_png(), 30, 1.0)

    assert [doc.metadata.frame_number for doc in inst.instance.docs] == [0, 30]
    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1]


def test_the_ordinal_restarts_for_the_next_object():
    """Chunk ids number an object's own frames, so they begin again with each object."""
    inst = _instance()
    inst._frame_callback(_png(), 0, 0.0)
    inst._frame_callback(_png(), 1, 0.0)

    inst.open(None)  # the engine opens the next object
    inst._frame_callback(_png(), 0, 0.0)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1, 0]


def test_the_end_of_sequence_marker_advances_nothing():
    """`image is None` signals the stream ended; it is not a frame."""
    inst = _instance()

    inst._frame_callback(None, 0, 0.0)
    inst._frame_callback(_png(), 0, 0.0)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0]


def test_frames_are_counted_with_only_the_image_lane_wired():
    """The ordinal advances per frame, not per listener."""
    inst = _instance(listeners=('image',))

    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)
    for frame_number in (0, 1):
        inst._frame_callback(_png(), frame_number, 0.0)

    assert inst.instance.docs == []
    assert _begin_names(inst) == ['clip.frame0.png', 'clip.frame1.png', 'clip.frame2.png', 'clip.frame3.png']
