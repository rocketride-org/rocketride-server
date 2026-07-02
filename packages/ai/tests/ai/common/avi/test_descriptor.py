"""Unit tests for ai.common.avi.descriptor (stream descriptor parse/serialize).

Covers the round-trip (build -> to_payload -> from_payload), the safety contract
(empty / non-JSON / non-descriptor payloads parse to None so raw BEGINs stay safe),
the exclude_none behaviour (unset optionals are omitted), and a guardrail that the
canonical fixture testdata/descriptor_keys.json stays in sync with the module constants.
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

# Repo-root testdata/descriptor_keys.json. From this file, parents[6] is the repo root:
# .../packages/ai/tests/ai/common/avi/test_descriptor.py
#  [0]=avi [1]=common [2]=ai(tests) [3]=tests [4]=ai(package) [5]=packages [6]=<repo root>.
_FIXTURE = Path(__file__).resolve().parents[6] / 'testdata' / 'descriptor_keys.json'


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
# guardrail: fixture <-> module constants stay in sync
# ---------------------------------------------------------------------------


def test_fixture_matches_module_constants():
    """Fixture testdata/descriptor_keys.json must agree with the module constants.

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
