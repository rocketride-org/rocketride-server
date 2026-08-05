"""Helpers for handling uploaded file data shared across nodes."""

import base64
import binascii
from typing import Optional, Tuple
from urllib.parse import unquote

import filetype


def decode_data_url(value: str) -> Tuple[bytes, Optional[str]]:
    """Decode a ``data:<mime>;base64,...`` upload (or a bare string) to (bytes, mime).

    Accepts the value produced by the ``data-url`` upload widget. A bare
    (non-data-url) string is treated as base64 if it decodes cleanly, otherwise
    as raw UTF-8 text.
    """
    mime: Optional[str] = None
    payload = value

    if value.startswith('data:'):
        header, _, payload = value.partition(',')  # header e.g. data:application/json;base64
        meta = header[len('data:') :]
        mime = meta.split(';', 1)[0] or None
        if ';base64' in meta:
            return base64.b64decode(payload, validate=True), mime
        # Non-base64 data-urls are URL-encoded text
        return unquote(payload).encode('utf-8'), mime

    # Bare value: try base64, fall back to raw text
    try:
        return base64.b64decode(payload, validate=True), mime
    except (binascii.Error, ValueError):
        return payload.encode('utf-8'), mime


def guess_filename(data: bytes, default_extension: str) -> str:
    """Guess a typed filename (``upload.<ext>``) from a buffer via the ``filetype`` package.

    Useful when an upstream source delivers raw bytes with no name and a
    downstream API infers the document type from the filename. Falls back to
    ``default_extension`` when the type can't be determined.
    """
    kind = filetype.guess(data)
    extension = kind.extension if kind is not None else default_extension
    return f'upload.{extension}'
