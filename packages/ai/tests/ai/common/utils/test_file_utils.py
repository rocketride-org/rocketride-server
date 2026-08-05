# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for ``ai.common.utils.file_utils`` (decode_data_url, guess_filename)."""

from __future__ import annotations

import base64

from ai.common.utils import decode_data_url, guess_filename


# --- decode_data_url ------------------------------------------------------


def test_decode_base64_data_url() -> None:
    """A ``data:<mime>;base64,...`` value decodes to (bytes, mime)."""
    payload = b'{"a": 1}'
    b64 = base64.b64encode(payload).decode('ascii')
    raw, mime = decode_data_url(f'data:application/json;base64,{b64}')
    assert raw == payload
    assert mime == 'application/json'


def test_decode_data_url_with_extra_params() -> None:
    """Extra data-url params (e.g. ``;name=...``) before ``;base64`` are tolerated."""
    b64 = base64.b64encode(b'hello').decode('ascii')
    raw, mime = decode_data_url(f'data:application/json;name=schema.json;base64,{b64}')
    assert raw == b'hello'
    assert mime == 'application/json'


def test_decode_url_encoded_data_url() -> None:
    """A non-base64 data-url is URL-decoded as text."""
    raw, mime = decode_data_url('data:text/plain,hello%20world')
    assert raw == b'hello world'
    assert mime == 'text/plain'


def test_decode_bare_base64_string() -> None:
    """A bare base64 string (no data: prefix) decodes to bytes."""
    raw, mime = decode_data_url(base64.b64encode(b'xyz').decode('ascii'))
    assert raw == b'xyz'
    assert mime is None


def test_decode_bare_plain_text() -> None:
    """A bare non-base64 string falls back to raw UTF-8 bytes."""
    raw, _mime = decode_data_url('not base64 at all {{{')
    assert raw == b'not base64 at all {{{'


# --- guess_filename -------------------------------------------------------


def test_guess_filename_detects_type() -> None:
    """A recognizable buffer yields ``upload.<detected-ext>`` (default ignored)."""
    assert guess_filename(b'%PDF-1.7 ...', 'bin') == 'upload.pdf'
    assert guess_filename(b'\x89PNG\r\n\x1a\n', 'bin') == 'upload.png'


def test_guess_filename_falls_back_to_default_extension() -> None:
    """Unrecognized or empty content uses the supplied default extension."""
    assert guess_filename(b'random unknown bytes', 'pdf') == 'upload.pdf'
    assert guess_filename(b'', 'png') == 'upload.png'
