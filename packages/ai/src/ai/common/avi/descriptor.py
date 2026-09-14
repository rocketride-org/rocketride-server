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

from rocketlib import AVI_ACTION
from ai.common.schema import Doc, DocMetadata

# Doc.type values that mark a payload as a stream descriptor.
STREAM_TYPES = ('VideoStream', 'AudioStream', 'ImageStream')

# Map a node-facing lane kind to the descriptor Doc type.
_KIND_TO_TYPE = {'video': 'VideoStream', 'audio': 'AudioStream', 'image': 'ImageStream'}

# origin values: how the media entered the pipeline.
ORIGINS = ('ingested', 'extracted', 'generated')

# Source-backlink metadata keys the C++ builder always emits for a real (non-generated)
# stream. `origin` is excluded: buildStreamDescriptor() never defaults it (only Tika/node
# enrichment sets it), so a bare native BEGIN can omit it. Synced to descriptor_keys.json.
REQUIRED_METADATA_KEYS = (
    'objectId',
    'parent',
    'permissionId',
    'signature',
    'nodeId',
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

# A provenance "hop layer" = the media detail above + the derived `name` that identifies
# this hop's output. Used to nest a source chain across multi-hop transforms.
SOURCE_LAYER_KEYS = SOURCE_DETAIL_KEYS + ('name',)

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


def _project_source_layer(md) -> dict:
    """Build one provenance hop layer from a stream/document metadata.

    The layer is this hop's media detail + ``name`` (the fields in
    :data:`SOURCE_LAYER_KEYS` that are present) **plus** the prior hop's own ``source``
    preserved nested underneath — so chains nest to arbitrary depth by recursion of the
    data itself, with no per-hop bookkeeping.

    Args:
        md: A :class:`DocMetadata` (from a descriptor or a document), or None.

    Returns:
        dict: The hop layer, empty when ``md`` is None or carries nothing projectable.
    """
    if md is None:
        return {}
    layer = {k: getattr(md, k) for k in SOURCE_LAYER_KEYS if getattr(md, k, None) is not None}
    prior = getattr(md, 'source', None)  # the already-nested chain from the input
    if prior:
        layer['source'] = prior
    return layer


def source_media_detail(descriptor: Optional[Doc]) -> dict:
    """Project a source stream descriptor into one provenance hop layer.

    Media detail + ``name`` + the descriptor's own nested ``source`` (the prior chain).
    Empty when the descriptor is absent.

    Args:
        descriptor: A parsed stream descriptor, or None.

    Returns:
        dict: The hop layer (see :func:`_project_source_layer`).
    """
    if descriptor is None or descriptor.metadata is None:
        return {}
    return _project_source_layer(descriptor.metadata)


def image_source_layer(
    *,
    size: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    stream_index: Optional[int] = None,
    name: Optional[str] = None,
    prior_source: Optional[dict] = None,
) -> dict:
    """Synthesize a self-describing image-stream hop layer from known values.

    For a node that has the decoded image but no upstream descriptor to project (e.g.
    thumbnail's documents lane): builds ``{source_mime: 'image/png', ...present detail...,
    name, source: <prior chain>}``. Absent fields are omitted.

    Args:
        size: The image's byte length.
        width: The image width in pixels.
        height: The image height in pixels.
        stream_index: The per-stream index (e.g. the frame ordinal).
        name: The document's derived name.
        prior_source: The input's own ``source`` (the prior chain) to nest.

    Returns:
        dict: The hop layer.
    """
    layer = {'source_mime': 'image/png'}
    for k, v in (('size', size), ('width', width), ('height', height), ('stream_index', stream_index), ('name', name)):
        if v is not None:
            layer[k] = v
    if prior_source:
        layer['source'] = prior_source
    return layer


def image_dims(image_bytes: Optional[bytes]) -> tuple:
    """Best-effort ``(width, height)`` of an encoded image, or ``(None, None)`` on failure.

    Reads the image header via Pillow (no full pixel decode). Never raises, so a caller can
    always attempt it before emitting an image ``BEGIN`` enrichment.

    Args:
        image_bytes: The encoded image bytes.

    Returns:
        tuple: ``(width, height)``, or ``(None, None)`` when the bytes are not a readable image.
    """
    try:
        import io
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as img:
            return img.width, img.height
    except Exception:
        return None, None


# Image MIME -> file extension for a derived output name (default 'png').
_MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}


def _ext_for_mime(mime: Optional[str]) -> str:
    """Map an image MIME type to a file extension for a derived name (default ``'png'``)."""
    return _MIME_EXT.get((mime or '').lower(), 'png')


def inherited_or_derived_name(descriptor: Optional[Doc], *, ext: str) -> Optional[str]:
    """The one-to-one output name: keep the input's own ``name`` if present, else derive one.

    A one-to-one transform (thumbnail, background removal, an annotated frame, ...) represents
    the *same* logical image as its input, so it keeps the input's ``name``; a raw, un-named
    input falls back to ``<source-stem>.<ext>``.

    Args:
        descriptor: The input stream descriptor, or None.
        ext: Extension for the derived fallback (used only when the input carries no name).

    Returns:
        The name, or None when neither an inherited nor a derivable name exists.
    """
    md = descriptor.metadata if (descriptor is not None and descriptor.metadata is not None) else None
    inherited = getattr(md, 'name', None) if md is not None else None
    return inherited or derived_name(descriptor, ext=ext)


def _media_begin_payload(
    descriptor: Optional[Doc],
    *,
    size: Optional[int],
    origin: str,
    name: Optional[str],
    **detail: Any,
) -> bytes:
    """Assemble a media ``BEGIN`` enrichment payload — the shape shared by all three lanes.

    Top level describes the stream being emitted, the input's provenance is projected and
    nested under ``source`` (so an existing chain nests to any depth), and ``name`` labels
    this hop's output. Absent fields are omitted, which is what keeps the C++ merge clean:
    it fills only keys the producer did not supply.

    Args:
        descriptor: The input stream descriptor to project as ``source``, or None.
        size: The emitted stream's byte length. Omitted when None — a producer that streams
            its bytes cannot know the total before the first one goes out.
        origin: How the stream entered this hop.
        name: The output's name (omitted when None).
        **detail: Lane-specific media fields (``duration``, ``fps``, ``channels``, ...).
            None values are skipped.

    Returns:
        bytes: UTF-8 JSON enrichment for the media ``BEGIN``.
    """
    payload: dict = {'origin': origin}
    if size is not None:
        payload['size'] = size
    for key, value in detail.items():
        if value is not None:
            payload[key] = value
    source = source_media_detail(descriptor)
    if source:
        payload['source'] = source
    if name:
        payload['name'] = name
    return json.dumps(payload).encode('utf-8')


def image_begin_payload(
    descriptor: Optional[Doc],
    *,
    size: int,
    width: Optional[int] = None,
    height: Optional[int] = None,
    name: Optional[str] = None,
    origin: str = 'extracted',
) -> bytes:
    """Build the ImageStream ``BEGIN`` enrichment for an image produced from media.

    Top level describes the emitted image itself (``origin``, ``size``, optional dims); the
    input's provenance is projected and nested under ``source`` (via :func:`source_media_detail`,
    so an existing chain nests to any depth); ``name`` labels this hop's output. Absent optional
    fields are omitted so ``model_dump(exclude_none=True)`` stays clean.

    Single source of truth for the enrichment shape shared by ``frame_grabber`` (one-to-many,
    passes an indexed ``name``), ``thumbnail`` and the image->image transform nodes (one-to-one,
    via :func:`forward_enriched_image`).

    Args:
        descriptor: The input stream descriptor to project as ``source``, or None.
        size: The emitted image's byte length.
        width: The emitted image width in pixels (omitted when None).
        height: The emitted image height in pixels (omitted when None).
        name: The output's derived name (omitted when None).
        origin: How the image entered this hop; defaults to ``'extracted'``.

    Returns:
        bytes: UTF-8 JSON enrichment for the image ``BEGIN``.
    """
    return _media_begin_payload(descriptor, size=size, origin=origin, name=name, width=width, height=height)


def forward_enriched_image(
    instance: Any,
    descriptor: Optional[Doc],
    mime: str,
    image_bytes: bytes,
    *,
    width: Optional[int] = None,
    height: Optional[int] = None,
    origin: str = 'extracted',
) -> None:
    """Emit a one-to-one transformed image with nested source provenance.

    Replaces the bare ``writeImage(BEGIN)/WRITE/END`` triplet in an image->image node: the
    ``BEGIN`` carries an enrichment payload (:func:`image_begin_payload`) that projects the input
    ``descriptor`` under ``source`` plus an inherited-or-derived ``name``, so the source chain
    nests across this hop. Dimensions are best-effort read from ``image_bytes`` when not supplied.

    Args:
        instance: The node's ``self.instance`` (exposes ``writeImage``).
        descriptor: The input stream descriptor captured on this object's ``BEGIN``, or None.
        mime: The output image MIME type (e.g. ``'image/png'``, ``'image/jpeg'``).
        image_bytes: The encoded output image.
        width: Output width in pixels; best-effort decoded from ``image_bytes`` when None.
        height: Output height in pixels; best-effort decoded from ``image_bytes`` when None.
        origin: How the image entered this hop; defaults to ``'extracted'``.
    """
    if width is None or height is None:
        width, height = image_dims(image_bytes)
    name = inherited_or_derived_name(descriptor, ext=_ext_for_mime(mime))
    payload = image_begin_payload(
        descriptor, size=len(image_bytes), width=width, height=height, name=name, origin=origin
    )
    instance.writeImage(AVI_ACTION.BEGIN, mime, payload)
    instance.writeImage(AVI_ACTION.WRITE, mime, image_bytes)
    instance.writeImage(AVI_ACTION.END, mime)


# ---------------------------------------------------------------------------
# Audio / video producers
#
# The image lane has declared its stream size since frame_grabber shipped; the
# other two never had a helper, so their producers send a bare BEGIN and the C++
# fills `size` in from the *source object's* Entry.size. For a synthesized stream
# — text-to-speech, a composed video — that number describes the input, not the
# output, and a consumer comparing bytes against it concludes the stream was
# truncated. These give those producers the same way to state what they are
# about to send.
#
# `size` is optional here, unlike on the image lane: a producer that streams its
# bytes from a provider cannot know the total before the first one goes out, and
# omitting the key is honest where guessing is not. `origin` defaults to
# 'generated' rather than 'extracted' — these producers synthesize or ingest,
# they do not extract from a container.
# ---------------------------------------------------------------------------


def audio_begin_payload(
    descriptor: Optional[Doc],
    *,
    size: Optional[int] = None,
    duration: Optional[float] = None,
    sample_rate: Optional[int] = None,
    channels: Optional[int] = None,
    format: Optional[str] = None,
    name: Optional[str] = None,
    origin: str = 'generated',
) -> bytes:
    """Build the AudioStream ``BEGIN`` enrichment for an audio stream this node produces.

    Args:
        descriptor: The input stream descriptor to project as ``source``, or None.
        size: The emitted clip's byte length; omit when the bytes are still streaming.
        duration: Playing time in seconds (omitted when None).
        sample_rate: Samples per second (omitted when None).
        channels: Channel count (omitted when None).
        format: Container/codec short name, e.g. ``'wav'`` (omitted when None).
        name: The output's name (omitted when None).
        origin: How the audio entered this hop; defaults to ``'generated'``.

    Returns:
        bytes: UTF-8 JSON enrichment for the audio ``BEGIN``.
    """
    return _media_begin_payload(
        descriptor,
        size=size,
        origin=origin,
        name=name,
        duration=duration,
        sample_rate=sample_rate,
        channels=channels,
        format=format,
    )


def video_begin_payload(
    descriptor: Optional[Doc],
    *,
    size: Optional[int] = None,
    duration: Optional[float] = None,
    fps: Optional[float] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    name: Optional[str] = None,
    origin: str = 'generated',
) -> bytes:
    """Build the VideoStream ``BEGIN`` enrichment for a video stream this node produces.

    Args:
        descriptor: The input stream descriptor to project as ``source``, or None.
        size: The emitted video's byte length; omit when the bytes are still streaming.
        duration: Playing time in seconds (omitted when None).
        fps: Frames per second (omitted when None).
        width: Frame width in pixels (omitted when None).
        height: Frame height in pixels (omitted when None).
        name: The output's name (omitted when None).
        origin: How the video entered this hop; defaults to ``'generated'``.

    Returns:
        bytes: UTF-8 JSON enrichment for the video ``BEGIN``.
    """
    return _media_begin_payload(
        descriptor,
        size=size,
        origin=origin,
        name=name,
        duration=duration,
        fps=fps,
        width=width,
        height=height,
    )


def forward_enriched_audio(
    instance: Any,
    descriptor: Optional[Doc],
    mime: str,
    audio_bytes: bytes,
    *,
    duration: Optional[float] = None,
    sample_rate: Optional[int] = None,
    channels: Optional[int] = None,
    format: Optional[str] = None,
    name: Optional[str] = None,
    origin: str = 'generated',
) -> None:
    """Emit a whole audio clip as one enriched stream.

    For a producer holding the complete clip in memory, which is every audio producer
    today. One that writes in chunks builds the payload with :func:`audio_begin_payload`
    and drives the triplet itself.

    Unlike the image equivalent this derives no ``name``: these producers have no inbound
    stream descriptor to derive one from, so a caller that wants a name passes it.

    Args:
        instance: Anything exposing ``writeAudio`` — a node's ``self.instance``, or a pipe.
        descriptor: The input stream descriptor to nest as ``source``, or None.
        mime: The audio MIME type, e.g. ``'audio/wav'``.
        audio_bytes: The complete encoded clip.
        duration: Playing time in seconds.
        sample_rate: Samples per second.
        channels: Channel count.
        format: Container/codec short name.
        name: The output's name.
        origin: How the audio entered this hop; defaults to ``'generated'``.
    """
    payload = audio_begin_payload(
        descriptor,
        size=len(audio_bytes),
        duration=duration,
        sample_rate=sample_rate,
        channels=channels,
        format=format,
        name=name,
        origin=origin,
    )
    instance.writeAudio(AVI_ACTION.BEGIN, mime, payload)
    instance.writeAudio(AVI_ACTION.WRITE, mime, audio_bytes)
    instance.writeAudio(AVI_ACTION.END, mime)


def forward_enriched_video(
    instance: Any,
    descriptor: Optional[Doc],
    mime: str,
    video_bytes: bytes,
    *,
    duration: Optional[float] = None,
    fps: Optional[float] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    name: Optional[str] = None,
    origin: str = 'generated',
) -> None:
    """Emit a whole video as one enriched stream.

    The counterpart to :func:`forward_enriched_audio`; a producer that writes the video in
    chunks uses :func:`video_begin_payload` and drives the triplet itself.

    Args:
        instance: Anything exposing ``writeVideo`` — a node's ``self.instance``, or a pipe.
        descriptor: The input stream descriptor to nest as ``source``, or None.
        mime: The video MIME type, e.g. ``'video/mp4'``.
        video_bytes: The complete encoded video.
        duration: Playing time in seconds.
        fps: Frames per second.
        width: Frame width in pixels.
        height: Frame height in pixels.
        name: The output's name.
        origin: How the video entered this hop; defaults to ``'generated'``.
    """
    payload = video_begin_payload(
        descriptor,
        size=len(video_bytes),
        duration=duration,
        fps=fps,
        width=width,
        height=height,
        name=name,
        origin=origin,
    )
    instance.writeVideo(AVI_ACTION.BEGIN, mime, payload)
    instance.writeVideo(AVI_ACTION.WRITE, mime, video_bytes)
    instance.writeVideo(AVI_ACTION.END, mime)


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
