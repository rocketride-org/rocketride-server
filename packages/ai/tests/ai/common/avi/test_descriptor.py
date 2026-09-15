"""Unit tests for ai.common.avi.descriptor (stream descriptor parse/serialize).

Covers the round-trip (build -> to_payload -> from_payload), the safety contract
(empty / non-JSON / non-descriptor payloads parse to None so raw BEGINs stay safe),
the exclude_none behaviour (unset optionals are omitted), and a guardrail that the
canonical fixture testdata/contracts/descriptor_keys.json stays in sync with the module constants.
"""

import json
from pathlib import Path

import pytest

from ai.common.avi import descriptor as D
from ai.common.avi.descriptor import (
    build_stream_descriptor,
    descriptor_from_payload,
    descriptor_to_payload,
)
from ai.common.schema import DocMetadata

# Canonical key fixture — a cross-language contract in the shared testdata corpus (also
# synced into the engtest `datasets` folder, so the C++ builder-conformance test reads the
# same file). From this test, parents[6] is the repo root.
_FIXTURE = Path(__file__).resolve().parents[6] / 'testdata' / 'contracts' / 'descriptor_keys.json'


# ---------------------------------------------------------------------------
# round-trip
# ---------------------------------------------------------------------------


def test_video_round_trip_preserves_backlink_and_media_fields():
    """A built video descriptor survives to_payload -> from_payload unchanged."""
    doc = build_stream_descriptor(
        None,
        'video',
        objectId='abc123',
        parent='/inbox/interview.mp4',
        permissionId=12,
        signature='sig',
        nodeId='node-7',
        origin='ingested',
        source_mime='video/mp4',
        size=734003200,
        stream_index=0,
        duration=240.0,
        fps=25,
        width=1920,
        height=1080,
    )
    parsed = descriptor_from_payload(descriptor_to_payload(doc))
    assert parsed is not None
    assert parsed.type == 'VideoStream'
    assert parsed.page_content is None
    assert parsed.metadata.objectId == 'abc123'
    assert parsed.metadata.parent == '/inbox/interview.mp4'
    assert parsed.metadata.source_mime == 'video/mp4'
    assert parsed.metadata.size == 734003200
    assert parsed.metadata.fps == 25


def test_audio_round_trip_and_non_ascii_parent():
    """Audio descriptor with a non-ASCII parent path round-trips as UTF-8."""
    doc = build_stream_descriptor(
        None,
        'audio',
        objectId='abc123',
        parent='/inbox/интервью 🎧.mp4',
        permissionId=0,
        signature='sig',
        nodeId='n',
        origin='extracted',
        source_mime='video/mp4',
        size=100,
        stream_index=0,
        sample_rate=16000,
        channels=1,
        format='wav',
    )
    parsed = descriptor_from_payload(descriptor_to_payload(doc))
    assert parsed is not None
    assert parsed.type == 'AudioStream'
    assert parsed.metadata.parent == '/inbox/интервью 🎧.mp4'
    assert parsed.metadata.sample_rate == 16000


def test_image_round_trip_carries_media_detail():
    """An image descriptor round-trips; image dims reuse the video width/height keys."""
    doc = build_stream_descriptor(
        None,
        'image',
        objectId='img1',
        parent='/inbox/deck.pptx',
        permissionId=0,
        signature='sig',
        nodeId='fg',
        origin='extracted',
        source_mime='video/mp4',
        size=51200,
        stream_index=2,
        width=1920,
        height=1080,
        resource_name='media1.mp4 @ deck.pptx',
    )
    parsed = descriptor_from_payload(descriptor_to_payload(doc))
    assert parsed is not None
    assert parsed.type == 'ImageStream'
    assert parsed.metadata.stream_index == 2
    assert parsed.metadata.width == 1920
    assert parsed.metadata.resource_name == 'media1.mp4 @ deck.pptx'


def test_unset_optionals_are_omitted_not_null():
    """exclude_none: a descriptor built without duration/fps omits those keys entirely."""
    doc = build_stream_descriptor(
        None,
        'video',
        objectId='x',
        parent='/f.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='ingested',
        source_mime='video/mp4',
        size=10,
        stream_index=0,
    )
    payload = json.loads(descriptor_to_payload(doc).decode('utf-8'))
    assert 'duration' not in payload['metadata']
    assert 'fps' not in payload['metadata']


# ---------------------------------------------------------------------------
# safety: bad payloads -> None (never raise)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('buffer', [None, b'', b'   ', b'not-json', b'\xff\xfe\x00', b'42', b'"a string"'])
def test_non_descriptor_payloads_return_none(buffer):
    """Empty, non-JSON, or non-object payloads must parse to None, not raise."""
    assert descriptor_from_payload(buffer) is None


def test_json_without_stream_type_returns_none():
    """A valid JSON object that is not a stream descriptor (wrong type) -> None."""
    payload = json.dumps({'type': 'Document', 'metadata': {'objectId': 'x'}}).encode('utf-8')
    assert descriptor_from_payload(payload) is None


def test_descriptor_without_objectid_returns_none():
    """A stream-typed payload missing the objectId backlink -> None."""
    payload = json.dumps({'type': 'VideoStream', 'metadata': {'source_mime': 'video/mp4'}}).encode('utf-8')
    assert descriptor_from_payload(payload) is None


def test_missing_chunkid_is_defaulted():
    """The parser supplies chunkId=0 when the wire omits it (DocMetadata requires it)."""
    payload = json.dumps(
        {'type': 'VideoStream', 'metadata': {'objectId': 'x', 'source_mime': 'video/mp4', 'stream_index': 0}}
    ).encode('utf-8')
    parsed = descriptor_from_payload(payload)
    assert parsed is not None
    assert parsed.metadata.chunkId == 0


def test_build_stream_descriptor_rejects_unknown_kind():
    """Only video|audio|image are valid stream kinds."""
    with pytest.raises(ValueError):
        build_stream_descriptor(None, 'text', objectId='x')


# ---------------------------------------------------------------------------
# derived-document provenance: attach_source / attach_name / swap_ext
# ---------------------------------------------------------------------------


def _video_descriptor(**overrides):
    """A parsed video descriptor for a standalone BBC clip (overridable)."""
    fields = dict(
        objectId='v1',
        parent='/inbox/BBC - Tear down this wall.mp4',
        permissionId=0,
        signature='sig',
        nodeId='n',
        origin='ingested',
        source_mime='video/mp4',
        size=12838904,
        stream_index=0,
        duration=74.05,
        width=1280,
        height=720,
    )
    fields.update(overrides)
    return build_stream_descriptor(None, 'video', **fields)


def test_attach_source_stamps_media_detail_only():
    """attach_source copies media detail, never the identity/security backlink."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_source(md, _video_descriptor())
    assert md.source['source_mime'] == 'video/mp4'
    assert md.source['duration'] == 74.05
    assert md.source['width'] == 1280
    assert md.source['stream_index'] == 0
    for excluded in ('objectId', 'parent', 'permissionId', 'signature', 'nodeId', 'origin'):
        assert excluded not in md.source


def test_attach_source_noop_without_descriptor():
    """A None descriptor leaves metadata.source unset (so toDict omits it)."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_source(md, None)
    assert getattr(md, 'source', None) is None


def test_attach_name_one_to_many():
    """One-to-many: <stem>.<marker><index>.<ext>."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_name(md, _video_descriptor(), index=0, marker='frame', ext='png')
    assert md.name == 'BBC - Tear down this wall.frame0.png'


def test_attach_name_one_to_one_and_extensionless():
    """One-to-one swaps to <stem>.<ext>; no ext yields an extensionless name."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_name(md, _video_descriptor(), ext='png')
    assert md.name == 'BBC - Tear down this wall.png'
    md2 = DocMetadata(objectId='doc2', chunkId=0)
    D.attach_name(md2, _video_descriptor(), index=3, marker='frame')
    assert md2.name == 'BBC - Tear down this wall.frame3'


def test_attach_name_prefers_resource_name():
    """The inner file name (resource_name) wins over the container parent."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_name(md, _video_descriptor(resource_name='media1.mp4'), index=1, ext='png')
    assert md.name == 'media1.frame1.png'


def test_attach_name_noop_without_source_name():
    """No descriptor -> no name (never a bare '.frame0.png')."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    D.attach_name(md, None, index=0, ext='png')
    assert getattr(md, 'name', None) is None


def test_derived_name_string_forms():
    """derived_name returns the same string attach_name would set (or None)."""
    d = _video_descriptor()
    assert D.derived_name(d, index=0, marker='frame', ext='png') == 'BBC - Tear down this wall.frame0.png'
    assert D.derived_name(d, index=2, marker='segment', ext='txt') == 'BBC - Tear down this wall.segment2.txt'
    assert D.derived_name(d, index=5, marker='frame') == 'BBC - Tear down this wall.frame5'  # extensionless
    assert D.derived_name(d, ext='png') == 'BBC - Tear down this wall.png'  # one-to-one
    assert D.derived_name(None, index=0, ext='png') is None


def test_swap_ext():
    """swap_ext replaces a real trailing extension, else appends; None-safe."""
    assert D.swap_ext('BBC - Tear down this wall.frame0.png', 'txt') == 'BBC - Tear down this wall.frame0.txt'
    assert D.swap_ext('photo.png', 'txt') == 'photo.txt'
    assert D.swap_ext('BBC.frame0', 'txt') == 'BBC.frame0.txt'  # 'frame0' not a real ext -> append
    assert D.swap_ext('name', 'txt') == 'name.txt'
    assert D.swap_ext(None, 'txt') is None


def test_rename_ext_swaps_on_a_copy():
    """rename_ext swaps the name extension without mutating the input metadata."""
    md = DocMetadata(objectId='doc1', chunkId=0)
    md.name = 'BBC - Tear down this wall.frame0.png'
    out = D.rename_ext(md, 'txt')
    assert out.name == 'BBC - Tear down this wall.frame0.txt'
    assert md.name == 'BBC - Tear down this wall.frame0.png'  # input untouched
    # No name -> returned unchanged; None -> None (both safe).
    md2 = DocMetadata(objectId='doc2', chunkId=0)
    assert D.rename_ext(md2, 'txt') is md2
    assert D.rename_ext(None, 'txt') is None


def test_source_media_detail_nests_prior_source():
    """source_media_detail carries a prior nested `source` forward (chain) + includes name."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05, 'width': 1280, 'height': 720}
    frame = build_stream_descriptor(
        None,
        'image',
        objectId='v1',
        parent='/inbox/BBC.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='image/png',
        size=40213,
        stream_index=0,
        name='BBC.frame0.png',
        source=video,
    )
    layer = D.source_media_detail(frame)
    assert layer['source_mime'] == 'image/png'
    assert layer['size'] == 40213
    assert layer['name'] == 'BBC.frame0.png'
    assert layer['source'] == video  # the prior chain, nested
    for excluded in ('objectId', 'parent', 'permissionId', 'signature', 'nodeId', 'origin'):
        assert excluded not in layer


def test_image_source_layer_builds_and_nests():
    """image_source_layer synthesizes an image self-layer with the prior source nested."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05}
    layer = D.image_source_layer(
        size=40213, width=1280, height=720, stream_index=3, name='BBC.frame3.png', prior_source=video
    )
    assert layer == {
        'source_mime': 'image/png',
        'size': 40213,
        'width': 1280,
        'height': 720,
        'stream_index': 3,
        'name': 'BBC.frame3.png',
        'source': video,
    }
    # absent fields omitted; no prior_source -> no nested source
    assert D.image_source_layer(size=100) == {'source_mime': 'image/png', 'size': 100}


def test_source_chain_three_levels():
    """A video -> frame -> thumbnail chain nests three levels deep."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05}
    frame_desc = build_stream_descriptor(
        None,
        'image',
        objectId='v1',
        parent='/BBC.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='image/png',
        size=40213,
        stream_index=0,
        name='BBC.frame0.png',
        source=video,
    )
    frame_layer = D.source_media_detail(frame_desc)  # {frame, source:{video}}
    thumb_layer = D.image_source_layer(
        size=1234, width=128, height=128, name='BBC.frame0.png', prior_source=frame_layer
    )
    assert thumb_layer['source'] == frame_layer
    assert thumb_layer['source']['source'] == video  # three deep


# ---------------------------------------------------------------------------
# image-lane helpers: image_dims / inherited_or_derived_name /
# image_begin_payload / forward_enriched_image
# ---------------------------------------------------------------------------


def _png_bytes(width=8, height=4):
    """A tiny real PNG for dimension / round-trip assertions."""
    import io
    from PIL import Image

    buf = io.BytesIO()
    Image.new('RGB', (width, height), (10, 20, 30)).save(buf, format='PNG')
    return buf.getvalue()


def _image_descriptor(**overrides):
    """A parsed frame descriptor (image/png) carrying a nested video `source`."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05}
    fields = dict(
        objectId='v1',
        parent='/inbox/BBC.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='image/png',
        size=40213,
        stream_index=0,
        name='BBC.frame0.png',
        source=video,
    )
    fields.update(overrides)
    return build_stream_descriptor(None, 'image', **fields)


def test_image_dims_reads_header_else_none():
    """image_dims returns (w, h) for a real image and (None, None) for anything else."""
    assert D.image_dims(_png_bytes(8, 4)) == (8, 4)
    assert D.image_dims(b'not an image') == (None, None)
    assert D.image_dims(b'') == (None, None)


def test_inherited_or_derived_name():
    """One-to-one name inherits the input's name, else derives <stem>.<ext>; None-safe."""
    assert D.inherited_or_derived_name(_image_descriptor(), ext='png') == 'BBC.frame0.png'  # inherited
    # no name on the input -> derive from the source stem
    assert D.inherited_or_derived_name(_video_descriptor(), ext='png') == 'BBC - Tear down this wall.png'
    assert D.inherited_or_derived_name(None, ext='png') is None


def test_image_begin_payload_shape_and_nesting():
    """image_begin_payload assembles {origin,size,dims,source,name} and nests a prior chain."""
    payload = json.loads(
        D.image_begin_payload(_image_descriptor(), size=1234, width=128, height=128, name='BBC.frame0.png').decode(
            'utf-8'
        )
    )
    assert payload['origin'] == 'extracted'
    assert payload['size'] == 1234
    assert payload['width'] == 128 and payload['height'] == 128
    assert payload['name'] == 'BBC.frame0.png'
    assert payload['source']['source_mime'] == 'image/png'  # the frame layer
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}  # video nested
    # no descriptor + absent dims/name -> just {origin, size}
    assert json.loads(D.image_begin_payload(None, size=10).decode('utf-8')) == {'origin': 'extracted', 'size': 10}


class _CaptureInstance:
    """Minimal stand-in for a node's ``self.instance``: records writeImage calls."""

    def __init__(self):
        self.calls = []

    def writeImage(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))


def test_forward_enriched_image_emits_enriched_triplet():
    """forward_enriched_image emits BEGIN(enriched)/WRITE/END with nested source + inherited name."""
    from rocketlib import AVI_ACTION

    inst = _CaptureInstance()
    img = _png_bytes(8, 4)
    D.forward_enriched_image(inst, _image_descriptor(), 'image/png', img)

    assert len(inst.calls) == 3
    (a0, m0, b0), (a1, m1, b1), (a2, m2, _b2) = inst.calls
    assert (a0, a1, a2) == (AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END)
    assert m0 == m1 == m2 == 'image/png'
    assert b1 == img  # WRITE carries the exact bytes
    payload = json.loads(b0.decode('utf-8'))
    assert payload['size'] == len(img)
    assert payload['width'] == 8 and payload['height'] == 4  # best-effort decoded from bytes
    assert payload['name'] == 'BBC.frame0.png'  # inherited (one-to-one)
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}  # video nested


# ---------------------------------------------------------------------------
# audio / video lane helpers: audio_begin_payload / video_begin_payload /
# forward_enriched_audio / forward_enriched_video
#
# These lanes had no producer helper, so their producers sent a bare BEGIN and
# the engine filled `size` in from the source object — the wrong number for a
# synthesized stream. Two differences from the image lane are deliberate and
# asserted below: `size` is optional (a streaming producer cannot know it), and
# `origin` defaults to 'generated' rather than 'extracted'.
# ---------------------------------------------------------------------------


def _audio_descriptor(**overrides):
    """A parsed audio descriptor carrying a nested video `source`."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05}
    fields = dict(
        objectId='v1',
        parent='/inbox/BBC.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='audio/wav',
        size=8820,
        stream_index=0,
        name='BBC.track0.wav',
        source=video,
    )
    fields.update(overrides)
    return build_stream_descriptor(None, 'audio', **fields)


def test_audio_begin_payload_shape_and_nesting():
    """audio_begin_payload assembles {origin,size,detail,source,name} and nests a prior chain."""
    payload = json.loads(
        D.audio_begin_payload(
            _audio_descriptor(),
            size=4410,
            duration=0.5,
            sample_rate=24000,
            channels=1,
            format='wav',
            name='speech.wav',
        ).decode('utf-8')
    )
    assert payload['origin'] == 'generated'  # these producers synthesize, they do not extract
    assert payload['size'] == 4410
    assert payload['duration'] == 0.5
    assert payload['sample_rate'] == 24000 and payload['channels'] == 1
    assert payload['format'] == 'wav'
    assert payload['name'] == 'speech.wav'
    assert payload['source']['source_mime'] == 'audio/wav'  # the audio layer
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}  # video nested


def test_video_begin_payload_shape_and_nesting():
    """video_begin_payload does the same with the video-side detail keys."""
    payload = json.loads(
        D.video_begin_payload(
            _video_descriptor(), size=98765, duration=12.5, fps=30, width=1280, height=720, name='out.mp4'
        ).decode('utf-8')
    )
    assert payload['origin'] == 'generated'
    assert payload['size'] == 98765
    assert payload['duration'] == 12.5 and payload['fps'] == 30
    assert payload['width'] == 1280 and payload['height'] == 720
    assert payload['name'] == 'out.mp4'
    assert payload['source']['source_mime'] == 'video/mp4'


def test_media_begin_payloads_omit_what_they_were_not_told():
    """`size` is optional here: a producer streaming its bytes cannot know the total.

    Omitting the key leaves the engine's own fallback in place, which is honest;
    inventing a number would make every consumer read the stream as truncated.
    """
    assert json.loads(D.audio_begin_payload(None).decode('utf-8')) == {'origin': 'generated'}
    assert json.loads(D.video_begin_payload(None).decode('utf-8')) == {'origin': 'generated'}
    assert json.loads(D.audio_begin_payload(None, size=10, origin='ingested').decode('utf-8')) == {
        'origin': 'ingested',
        'size': 10,
    }


class _CaptureMediaInstance:
    """Minimal stand-in for a node's ``self.instance``: records writeAudio/writeVideo calls."""

    def __init__(self):
        self.calls = []

    def writeAudio(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))

    def writeVideo(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))


def test_forward_enriched_audio_emits_enriched_triplet():
    """forward_enriched_audio emits BEGIN(enriched)/WRITE/END and declares the real size."""
    from rocketlib import AVI_ACTION

    inst = _CaptureMediaInstance()
    clip = b'RIFF' + b'\x00' * 60
    D.forward_enriched_audio(inst, _audio_descriptor(), 'audio/wav', clip, format='wav', name='speech.wav')

    assert len(inst.calls) == 3
    (a0, m0, b0), (a1, m1, b1), (a2, m2, _b2) = inst.calls
    assert (a0, a1, a2) == (AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END)
    assert m0 == m1 == m2 == 'audio/wav'
    assert b1 == clip  # WRITE carries the exact bytes
    payload = json.loads(b0.decode('utf-8'))
    assert payload['size'] == len(clip)  # the clip's own length, not the source object's
    assert payload['format'] == 'wav'
    assert payload['name'] == 'speech.wav'
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}


def test_forward_enriched_video_emits_enriched_triplet():
    """The video counterpart, declaring the encoded video's own byte length."""
    from rocketlib import AVI_ACTION

    inst = _CaptureMediaInstance()
    movie = b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 40
    D.forward_enriched_video(inst, None, 'video/mp4', movie, fps=30, duration=2.0, name='out.mp4')

    assert len(inst.calls) == 3
    (a0, m0, b0), (_a1, _m1, b1), (a2, _m2, _b2) = inst.calls
    assert (a0, a2) == (AVI_ACTION.BEGIN, AVI_ACTION.END)
    assert m0 == 'video/mp4'
    assert b1 == movie
    payload = json.loads(b0.decode('utf-8'))
    assert payload == {'origin': 'generated', 'size': len(movie), 'duration': 2.0, 'fps': 30, 'name': 'out.mp4'}


# ---------------------------------------------------------------------------
# guardrail: fixture <-> module constants stay in sync
# ---------------------------------------------------------------------------


def test_fixture_matches_module_constants():
    """Fixture descriptor_keys.json must agree with the module constants.

    Adding/renaming a key without updating both sides then fails CI.
    """
    fixture = json.loads(_FIXTURE.read_text(encoding='utf-8'))
    assert tuple(fixture['doc']['type_values']) == D.STREAM_TYPES
    assert tuple(fixture['origin_values']) == D.ORIGINS
    md = fixture['metadata']
    assert tuple(md['required']) == D.REQUIRED_METADATA_KEYS
    assert tuple(md['optional_common']) == D.OPTIONAL_COMMON_KEYS
    assert tuple(md['optional_video']) == D.OPTIONAL_VIDEO_KEYS
    assert tuple(md['optional_audio']) == D.OPTIONAL_AUDIO_KEYS


def test_parser_accepts_every_canonical_key():
    """Consumer conformance: descriptor_from_payload parses a descriptor carrying every
    canonical metadata key, preserving each one.

    Pairs with the C++ builder-conformance test (which asserts the builder emits only
    canonical keys): together they enforce that the C++-produced key set and the
    Python-consumed key set both agree with the descriptor_keys.json contract.
    """
    fixture = json.loads(_FIXTURE.read_text(encoding='utf-8'))
    m = fixture['metadata']
    keys = m['required'] + m['optional_common'] + m['optional_video'] + m['optional_audio']

    # Type-correct sample per canonical key (DocMetadata validates its declared fields).
    int_keys = {'permissionId', 'size', 'stream_index', 'width', 'height', 'sample_rate'}
    float_keys = {'start_offset', 'duration', 'fps'}

    def sample(k):
        if k in int_keys:
            return 1
        if k in float_keys:
            return 1.5
        return f'{k}-value'

    metadata = {k: sample(k) for k in keys}
    payload = json.dumps({'type': 'VideoStream', 'metadata': metadata}).encode('utf-8')

    parsed = descriptor_from_payload(payload)
    assert parsed is not None
    for k in keys:
        assert getattr(parsed.metadata, k, None) is not None, f'canonical key {k!r} not preserved by the parser'
