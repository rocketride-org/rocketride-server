# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: the response node surfaces stream `metadata` identically on all
three multimedia lanes (image, audio, video).

Each lane accumulates BEGIN/WRITE/END and emits a single entry
``{mime_type, <lane>, metadata}`` where ``metadata`` is the descriptor parsed from the
BEGIN payload. Drives the real ``IInstance`` with real descriptor helpers.
"""

import base64
import sys
from pathlib import Path

from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from response.IInstance import IInstance  # noqa: E402


class _Obj:
    """Minimal engine currentObject: a response dict plus the flags close() reads."""

    def __init__(self):
        self.response = {}
        self.url = 'null://Stream/clip'
        self.hasMetadata = False
        self.hasName = False
        self.hasPath = False


class _Inst:
    def __init__(self):
        self.currentObject = _Obj()


class _Glob:
    """laneName=None + empty lanes -> _getkey falls back to the lane name itself."""

    laneName = None
    lanes = None


def _descriptor_payload(kind, source_mime):
    """A stream descriptor for `kind` (video/audio/image) with a nested prior source."""
    prior = {'source_mime': 'video/mp4', 'duration': 12.5}
    doc = build_stream_descriptor(
        None,
        kind,
        objectId='o1',
        parent='/inbox/clip',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime=source_mime,
        size=999,
        stream_index=0,
        name='clip.out',
        source=prior,
    )
    return descriptor_to_payload(doc)


def _drive(inst, method_name, mime, kind, source_mime):
    """Send BEGIN(descriptor)/WRITE(bytes)/END through one write* method."""
    method = getattr(inst, method_name)
    method(AVI_ACTION.BEGIN, mime, _descriptor_payload(kind, source_mime))
    method(AVI_ACTION.WRITE, mime, b'\x00\x01\x02\x03')
    method(AVI_ACTION.END, mime, b'')


def _make_instance():
    inst = IInstance()
    inst.instance = _Inst()
    inst.IGlobal = _Glob()
    inst.open(None)  # initializes the per-lane media state
    return inst


def test_all_three_media_lanes_emit_same_shape_with_metadata():
    """Media lanes image / audio / video - each produce one {mime_type, <lane>, metadata} entry."""
    cases = [
        ('writeImage', 'image', 'image/png'),
        ('writeAudio', 'audio', 'audio/mpeg'),
        ('writeVideo', 'video', 'video/mp4'),
    ]
    for method_name, lane, mime in cases:
        inst = _make_instance()
        _drive(inst, method_name, mime, lane, mime)

        entries = inst.instance.currentObject.response[lane]
        assert len(entries) == 1, f'{lane}: expected one entry'
        entry = entries[0]

        # Identical shape across all three lanes.
        assert set(entry.keys()) == {'mime_type', lane, 'metadata'}, f'{lane}: keys differ'
        assert entry['mime_type'] == mime
        assert base64.b64decode(entry[lane]) == b'\x00\x01\x02\x03'  # the accumulated stream

        # metadata is the sanitized provenance projection: media detail + nested source.
        md = entry['metadata']
        assert md['source_mime'] == mime
        assert md['name'] == 'clip.out'
        assert md['source'] == {'source_mime': 'video/mp4', 'duration': 12.5}

        # The identity/security backlink is stripped — never leaked to the client response.
        for leaked in ('objectId', 'parent', 'permissionId', 'signature', 'nodeId', 'origin'):
            assert leaked not in md, f'{lane}: {leaked} leaked into response metadata'


def test_media_lane_without_descriptor_omits_metadata():
    """A bare BEGIN (no descriptor) yields an entry without a metadata key — still valid."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')  # not a descriptor
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'xy')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    entry = inst.instance.currentObject.response['image'][0]
    assert set(entry.keys()) == {'mime_type', 'image'}
    assert 'metadata' not in entry
