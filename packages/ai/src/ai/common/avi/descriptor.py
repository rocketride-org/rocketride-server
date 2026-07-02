"""Audio/video stream descriptor helper (parse + optional enrich).

A stream *descriptor* is a small JSON document delivered on the media ``BEGIN``
payload so a receiving node knows what stream it is about to consume — the source
backlink, size, duration, fps, ... — *before* the raw bytes arrive. Today a receiver
gets only an ``AVI_ACTION`` + mime + bytes and must buffer blindly.

This module is the Python (consumer) half of a cross-language pair (no shared code, only
a shared JSON contract). The producer is the C++ ``buildStreamDescriptor()``
(``store/core/stream_descriptor.hpp``, called from ``Binder::buildBeginPayload()``), which
builds the descriptor from ``currentEntry`` on the media ``BEGIN``. Here
:func:`descriptor_from_payload` parses that JSON back into a :class:`Doc`. Canonical keys
live in ``testdata/descriptor_keys.json`` and are asserted on each side.

Wire contract (canonical keys mirrored in ``testdata/descriptor_keys.json`` and the
engine protocol doc):

* The descriptor is a :class:`Doc` whose ``type`` is one of :data:`STREAM_TYPES` and
  whose ``page_content`` is ``None``. Its ``metadata`` is a :class:`DocMetadata`
  carrying the standard source backlink plus media fields (added dynamically via the
  model's ``extra='allow'``).
* ``metadata.objectId`` and the ``type`` marker are what identify a payload as a
  descriptor. ``chunkId`` is required by :class:`DocMetadata` but is not meaningful for
  a whole stream, so the parser defaults it to ``0`` when absent — the C++ builder need
  not emit it.
* ``model_dump(exclude_none=True)`` means unset optional fields are **omitted, not
  null**, so the per-stream key set varies. Consumers must read optionals defensively.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ai.common.schema import Doc, DocMetadata

# Doc.type values that mark a payload as a stream descriptor.
STREAM_TYPES = ('VideoStream', 'AudioStream', 'ImageStream')

# Map a node-facing lane kind to the descriptor Doc type.
_KIND_TO_TYPE = {'video': 'VideoStream', 'audio': 'AudioStream', 'image': 'ImageStream'}

# origin values: how the media entered the pipeline.
ORIGINS = ('ingested', 'extracted', 'generated')

# Source-backlink metadata keys the builder always emits for a real (non-generated)
# stream. Kept in sync with testdata/descriptor_keys.json.
REQUIRED_METADATA_KEYS = (
    'objectId',
    'parent',
    'permissionId',
    'signature',
    'nodeId',
    'origin',
    'source_mime',
    'size',
    'stream_index',
)

# Best-effort media keys (omitted when unknown).
OPTIONAL_COMMON_KEYS = ('start_offset', 'duration', 'container_mime')
OPTIONAL_VIDEO_KEYS = ('fps', 'width', 'height')
OPTIONAL_AUDIO_KEYS = ('sample_rate', 'channels', 'format')

# Required by DocMetadata but not part of the stream contract; the parser supplies it.
_PARSER_DEFAULTED = {'chunkId': 0}


def descriptor_to_payload(doc: Doc) -> bytes:
    """Serialize a stream descriptor to UTF-8 JSON bytes for the ``BEGIN`` payload.

    Args:
        doc: The stream descriptor document (``type`` in :data:`STREAM_TYPES`).

    Returns:
        UTF-8 encoded JSON bytes. ``ensure_ascii=False`` keeps non-ASCII ``parent``
        paths (e.g. emoji) intact; both sides treat the payload as UTF-8.
    """
    return json.dumps(doc.toDict(), ensure_ascii=False).encode('utf-8')


def descriptor_from_payload(buffer: Optional[bytes]) -> Optional[Doc]:
    """Parse a media ``BEGIN`` payload into a stream descriptor.

    Args:
        buffer: The raw ``BEGIN`` byte slot. May be empty (no descriptor) or arbitrary
            non-descriptor bytes.

    Returns:
        The parsed :class:`Doc`, or ``None`` when the payload is empty, not valid UTF-8
        JSON, or not a stream descriptor. Returning ``None`` (never raising) keeps a
        raw-byte ``BEGIN`` safe and prevents a corrupt payload from killing the stream.
    """
    if not buffer:
        return None
    try:
        data = json.loads(bytes(buffer).decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get('type') not in STREAM_TYPES:
        return None
    metadata = data.get('metadata')
    if not isinstance(metadata, dict) or 'objectId' not in metadata:
        return None
    # chunkId is required by DocMetadata but has no meaning for a whole stream.
    for key, value in _PARSER_DEFAULTED.items():
        metadata.setdefault(key, value)
    try:
        return Doc.fromDict(data)
    except Exception:
        # Shape looked like a descriptor but failed model validation → treat as absent.
        return None


def build_stream_descriptor(pInstance: Any, kind: str, **media_fields: Any) -> Doc:
    """Build a (partial) stream descriptor from a node instance plus media fields.

    Python does NOT build the authoritative descriptor — the C++ engine does at
    ``Binder::writeX``. This helper is for optional producer enrichment and for tests:
    it wraps the instance's source backlink (via :class:`DocMetadata`) plus any known
    media fields into a :class:`Doc`.

    Args:
        pInstance: A node instance exposing ``instance.currentObject`` (used by
            :class:`DocMetadata` to auto-fill the source backlink). ``None`` is allowed
            for tests that pass all fields explicitly via ``media_fields``.
        kind: The lane kind — ``'video'``, ``'audio'`` or ``'image'``.
        **media_fields: Media attributes to stamp onto the metadata (e.g. ``duration``,
            ``fps``, ``source_mime``, ``size``, ``stream_index``, ``origin``). ``None``
            values are skipped so they are omitted from the payload.

    Returns:
        A :class:`Doc` descriptor with ``page_content=None``.

    Raises:
        ValueError: If ``kind`` is not video/audio/image.
    """
    doc_type = _KIND_TO_TYPE.get(kind)
    if doc_type is None:
        raise ValueError(f'Unknown stream kind: {kind!r} (expected one of video|audio|image)')
    metadata = DocMetadata(pInstance) if pInstance is not None else DocMetadata(**_extract_backlink(media_fields))
    for key, value in media_fields.items():
        if value is not None:
            setattr(metadata, key, value)
    return Doc(type=doc_type, page_content=None, metadata=metadata)


def _extract_backlink(media_fields: dict) -> dict:
    """Pull DocMetadata's required fields out of ``media_fields`` for the no-instance path.

    :class:`DocMetadata` requires ``objectId`` and ``chunkId``; when no ``pInstance`` is
    given (tests), take ``objectId`` from ``media_fields`` and default ``chunkId=0``.
    """
    return {'objectId': media_fields.get('objectId', ''), 'chunkId': 0}
