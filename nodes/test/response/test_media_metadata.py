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

import pytest
from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from response.IInstance import IInstance  # noqa: E402


@pytest.fixture(autouse=True)
def _spool_dir(tmp_path, monkeypatch):
    # The response node spools each lane to disk before persisting; point it at tmp.
    monkeypatch.setenv('ROCKETRIDE_LIVE_MEDIA_DIR', str(tmp_path))


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
    file_store = None
    client_id = None
    transmit_media = False


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


# ---------------------------------------------------------------------------
# Several streams on one lane within a single object
#
# scan_cropper and frame_grabber fan one object out into many images, all down `image`.
# The pipeline runs as a call chain, so the next stream's BEGIN arrives before the previous
# stream's END — the buffer is already complete by then and must not be thrown away.
# ---------------------------------------------------------------------------


def _sized_payload(size, name, kind='image'):
    """A descriptor declaring `size` bytes, so completeness is decidable."""
    doc = build_stream_descriptor(
        None,
        kind,
        objectId='o1',
        parent='/inbox/scan',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='image/jpeg',
        size=size,
        stream_index=0,
        name=name,
        source=None,
    )
    return descriptor_to_payload(doc)


def test_second_begin_keeps_the_first_stream():
    """The case that silently returned an empty image: complete buffer, END still pending."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'a.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'AAAA')  # exactly the declared size
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'BBBB')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert len(entries) == 2, 'both streams must reach the response'
    assert all(e['image'] for e in entries), 'neither entry may be an empty payload'
    assert [e['metadata']['name'] for e in entries] == ['a.jpg', 'b.jpg'], (
        'each entry keeps its own descriptor, not whichever arrived last'
    )


def test_late_end_adds_no_empty_entry():
    """The settled stream's END arrives afterwards and must be ignored."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'a.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'AAAA')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'BBBB')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')  # b.jpg's own END
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')  # a.jpg's late END

    entries = inst.instance.currentObject.response['image']
    assert len(entries) == 2, 'the late END must not append a payload-less third entry'


def test_truncated_stream_is_dropped():
    """Short of its declared size, so it really was cut off."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(99, 'partial.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'AA')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'BBBB')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert [e['metadata']['name'] for e in entries] == ['b.jpg']


def test_zero_length_stream_produces_no_entry():
    """A stream that declares no bytes and sends none: nothing to return.

    Matches the sink, which opens its write handle on the first non-empty chunk and so
    never creates a file for an empty stream.
    """
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(0, 'empty.jpg'))
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    assert 'image' not in inst.instance.currentObject.response


def test_zero_length_stream_followed_by_another_is_not_emitted():
    """The settle path must agree with the END path about empty streams."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(0, 'empty.jpg'))
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'BBBB')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert [e['metadata']['name'] for e in entries] == ['b.jpg']


def test_bytes_arriving_against_a_zero_declaration_are_dropped():
    """A descriptor claiming 0 bytes while sending some is not trusted.

    Documents the consequence rather than endorsing it: the declared size is the only
    completeness signal available, so a wrong declaration costs the stream.
    """
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(0, 'liar.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'XXXX')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'BBBB')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert [e['metadata']['name'] for e in entries] == ['b.jpg']


def test_three_streams_in_a_row_all_survive():
    """scan_cropper's real shape: one object fanned out into several images."""
    inst = _make_instance()
    for name in ('a.jpg', 'b.jpg', 'c.jpg'):
        inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, name))
        inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'ABCD')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert [e['metadata']['name'] for e in entries] == ['a.jpg', 'b.jpg', 'c.jpg']
    assert all(e['image'] for e in entries)


def test_settle_is_a_no_op_on_a_lane_that_never_began():
    """The first BEGIN of an object has nothing to settle, and lanes stay independent."""
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'a.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'ABCD')
    # An audio stream beginning must not settle, or emit anything for, the image lane.
    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/mpeg', _sized_payload(2, 'a.mp3', kind='audio'))
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/mpeg', b'ZZ')
    inst.writeAudio(AVI_ACTION.END, 'audio/mpeg', b'')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    response = inst.instance.currentObject.response
    assert [e['metadata']['name'] for e in response['image']] == ['a.jpg']
    assert [e['metadata']['name'] for e in response['audio']] == ['a.mp3']


def test_emitted_stream_is_not_emitted_twice_by_the_next_begin():
    """After emitting, the buffer is empty but the declared size is still on record.

    Settle must not read that as another complete stream, or every emitted stream would be
    followed by a duplicate carrying no payload.
    """
    inst = _make_instance()
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(0, 'zero.jpg'))
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'a.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'ABCD')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')  # emits a.jpg, buffer now empty
    inst.writeImage(AVI_ACTION.BEGIN, 'image/jpeg', _sized_payload(4, 'b.jpg'))
    inst.writeImage(AVI_ACTION.WRITE, 'image/jpeg', b'WXYZ')
    inst.writeImage(AVI_ACTION.END, 'image/jpeg', b'')

    entries = inst.instance.currentObject.response['image']
    assert [e['metadata']['name'] for e in entries] == ['a.jpg', 'b.jpg']
