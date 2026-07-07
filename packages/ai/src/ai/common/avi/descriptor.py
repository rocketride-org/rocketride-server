"""Audio/video stream descriptor helper (parse + optional enrich).

A stream *descriptor* is a small JSON document delivered on the media ``BEGIN``
payload so a receiving node knows what stream it is about to consume — the source
backlink, size, duration, fps, ... — *before* the raw bytes arrive. Today a receiver
gets only an ``AVI_ACTION`` + mime + bytes and must buffer blindly.

This module is the Python (consumer) half of a cross-language pair (no shared code, only
a shared JSON contract). The producer is the C++ ``buildStreamDescriptor()``
(``store/core/stream_descriptor.hpp``, called from ``Binder::buildBeginPayload()``), which
builds the descriptor from ``currentEntry`` on the media ``BEGIN``. Here
:func:`descriptor_from_payload` parses that JSON back into a :class:`Doc`. Canonical keys are
the module constants below, mirrored in the guardrail fixture
``testdata/contracts/descriptor_keys.json``.

Wire contract (canonical keys mirrored in the guardrail fixture
``testdata/contracts/descriptor_keys.json``):

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
# stream. Kept in sync with the descriptor_keys.json guardrail fixture.
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
OPTIONAL_COMMON_KEYS = ('start_offset', 'duration', 'container_mime', 'resource_name')
OPTIONAL_VIDEO_KEYS = ('fps', 'width', 'height')
OPTIONAL_AUDIO_KEYS = ('sample_rate', 'channels', 'format')

# Media-detail fields projected onto a derived document's `source` block: the stream
# fields a document does not already carry via its own DocMetadata (which supplies the
# identity/backlink objectId/parent/permissionId/signature/nodeId). Identity/security and
# `origin` are excluded; only media detail (mime/size/dims/timing/codec) is kept.
SOURCE_DETAIL_KEYS = (
    ('source_mime', 'size', 'stream_index') + OPTIONAL_COMMON_KEYS + OPTIONAL_VIDEO_KEYS + OPTIONAL_AUDIO_KEYS
)

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


# ---------------------------------------------------------------------------
# Derived-document provenance: stamp a media source's detail + a name onto a
# document produced from it (frame_grabber frames, transcript segments, ...).
# One implementation, consumed by every media -> document node.
# ---------------------------------------------------------------------------


def _source_stem(descriptor: Optional[Doc]) -> Optional[str]:
    """The source media's own file name without extension, from the descriptor.

    Args:
        descriptor: A parsed stream descriptor (:func:`descriptor_from_payload`), or None.

    Returns:
        The basename of ``resource_name`` (else ``parent``) with its extension dropped,
        or ``None`` when no descriptor / name is available.
    """
    if descriptor is None or descriptor.metadata is None:
        return None
    md = descriptor.metadata
    base = getattr(md, 'resource_name', None) or getattr(md, 'parent', None)
    if not base:
        return None
    base = base.replace('\\', '/').rsplit('/', 1)[-1]  # basename
    return base.rsplit('.', 1)[0] or base  # drop extension (keep dotfiles)


def source_media_detail(descriptor: Optional[Doc]) -> dict:
    """Media-detail-only projection of a source stream descriptor's metadata.

    Returns the fields a derived document does not already carry via its own
    :class:`DocMetadata` (identity/backlink). Empty when the descriptor is absent.

    Args:
        descriptor: A parsed stream descriptor, or None.

    Returns:
        dict: The media-detail fields (:data:`SOURCE_DETAIL_KEYS`) present on the descriptor.
    """
    if descriptor is None or descriptor.metadata is None:
        return {}
    md = descriptor.metadata
    return {k: getattr(md, k) for k in SOURCE_DETAIL_KEYS if getattr(md, k, None) is not None}


def attach_source(metadata: DocMetadata, descriptor: Optional[Doc]) -> DocMetadata:
    """Stamp the source stream's media detail onto ``metadata.source`` (in place).

    No-op when the descriptor is absent or carries no media detail, so
    ``model_dump(exclude_none=True)`` stays clean.

    Args:
        metadata: The output document's metadata to enrich.
        descriptor: The source stream descriptor, or None.

    Returns:
        The same ``metadata`` (for chaining).
    """
    detail = source_media_detail(descriptor)
    if detail:
        metadata.source = detail
    return metadata


def derived_name(
    descriptor: Optional[Doc],
    *,
    index: Optional[int] = None,
    marker: str = 'frame',
    ext: Optional[str] = None,
) -> Optional[str]:
    """Build the derived-document name string from the source media.

    ``<stem>.<marker><index>.<ext>`` for one-to-many (``index`` given); ``<stem>.<ext>``
    for one-to-one. The extension is omitted when ``ext`` is None (e.g. embeddings).

    Args:
        descriptor: The source stream descriptor, or None.
        index: Per-item index for one-to-many outputs; omit for one-to-one.
        marker: Item marker for one-to-many names (e.g. ``'frame'``, ``'segment'``).
        ext: Output extension (e.g. ``'png'``, ``'txt'``); omit for extensionless outputs.

    Returns:
        The derived name, or ``None`` when the source has no name.
    """
    stem = _source_stem(descriptor)
    if not stem:
        return None
    name = stem if index is None else f'{stem}.{marker}{index}'
    return f'{name}.{ext}' if ext else name


def attach_name(
    metadata: DocMetadata,
    descriptor: Optional[Doc],
    *,
    index: Optional[int] = None,
    marker: str = 'frame',
    ext: Optional[str] = None,
) -> DocMetadata:
    """Stamp a human-readable ``metadata.name`` derived from the source media (in place).

    Thin wrapper over :func:`derived_name`; no-op when the source has no name, so a bare
    ``.frame0.png`` is never emitted.

    Args:
        metadata: The output document's metadata to enrich.
        descriptor: The source stream descriptor, or None.
        index: Per-item index for one-to-many nodes; omit for one-to-one.
        marker: Item marker for one-to-many names (e.g. ``'frame'``, ``'segment'``).
        ext: Output extension (e.g. ``'png'``, ``'txt'``); omit for extensionless outputs.

    Returns:
        The same ``metadata`` (for chaining).
    """
    name = derived_name(descriptor, index=index, marker=marker, ext=ext)
    if name:
        metadata.name = name
    return metadata


def swap_ext(name: Optional[str], ext: str) -> Optional[str]:
    """Replace a derived name's trailing file extension: ``a.b.png`` -> ``a.b.<ext>``.

    Only swaps a real trailing extension (short alphanumeric after the last dot); when
    the name has none (e.g. an extensionless embedding name), the new extension is
    appended instead. ``None`` in -> ``None`` out.

    Args:
        name: The existing document name, or None.
        ext: The extension to set (without a leading dot).

    Returns:
        The renamed string, or None when ``name`` is falsy.
    """
    if not name:
        return None
    stem, dot, last = name.rpartition('.')
    if dot and last.isalnum() and len(last) <= 5:
        return f'{stem}.{ext}'
    return f'{name}.{ext}'


def rename_ext(metadata: Optional[DocMetadata], ext: str) -> Optional[DocMetadata]:
    """Return ``metadata`` with its ``name``'s extension swapped to ``ext``.

    For a node that changes a document's content type (e.g. image -> text): copies the
    metadata **before** mutating (so a shared/upstream metadata object is not altered)
    and swaps the name extension via :func:`swap_ext`. Returns the input unchanged when
    it is None or carries no name.

    Args:
        metadata: The document metadata to rename, or None.
        ext: The new extension (without a leading dot).

    Returns:
        A renamed copy, or the original ``metadata`` when there is nothing to rename.
    """
    if metadata is None or not getattr(metadata, 'name', None):
        return metadata
    renamed = metadata.model_copy()
    renamed.name = swap_ext(renamed.name, ext)
    return renamed
