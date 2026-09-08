# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================


"""Word service bindings, docx round-trip helpers, and response cleaners."""

from __future__ import annotations

import re

import functools
import urllib.parse

from .. import graph_client

SERVICE = graph_client.GraphService(product='Word', superset_scopes=frozenset({'Files.ReadWrite.All'}))

token_scope_report = functools.partial(graph_client.token_scope_report, SERVICE)
request = functools.partial(graph_client.request, SERVICE)

WORD_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def _seg(value: str) -> str:
    """URL-encode a single path segment (item ids may contain '!' etc.)."""
    return urllib.parse.quote(value, safe='')


_ITEM_ID_RE = re.compile(r'[A-Za-z0-9!]{15,}$')


def looks_like_item_id(value: str) -> bool:
    """True for Graph item-id-shaped tokens (or the 'root' alias) — see it()."""
    return value == 'root' or bool(_ITEM_ID_RE.fullmatch(value))


def it(base: str, item: str) -> str:
    """Item address for a drive path ('Docs/report.docx', containing '/') or a single-segment item id.

    Mirrors onedrive/client.py's ``it()`` helper — defined locally here per
    the Task 9 brief rather than importing across service subpackages. A path
    may have multiple already-valid segments, so each segment is
    percent-encoded (``safe='/'`` preserves the separators) before being
    interpolated into the ``root:/{path}:`` addressing form — an unencoded
    space raises ``http.client.InvalidURL`` and an unencoded ``#`` truncates
    the path, silently addressing the wrong item.
    """
    if looks_like_item_id(item):
        return f'{base}/drive/items/{_seg(item)}'
    return f'{base}/drive/root:/{urllib.parse.quote(item, safe="/")}:'


def download_docx(auth, base: str, file: str) -> tuple[bytes, str]:
    """Return (bytes, etag) for a drive path or item id.

    Fetches metadata first for the eTag, then the binary content, so a
    subsequent :func:`upload_docx` can send it back as an ``If-Match``
    precondition.
    """
    meta = request(auth, 'GET', it(base, file))
    content = request(auth, 'GET', it(base, file) + '/content', binary=True)
    return content, meta.get('eTag', '')


def upload_docx(auth, base: str, file: str, blob: bytes, etag: str) -> dict:
    """Re-upload with If-Match so concurrent edits fail readably, not last-writer-wins.

    ``etag`` empty/falsy (e.g. a brand-new file) omits the header — there is
    nothing to match against yet.
    """
    return request(
        auth,
        'PUT',
        it(base, file) + '/content',
        data=blob,
        content_type=WORD_CONTENT_TYPE,
        extra_headers={'If-Match': etag} if etag else None,
    )


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def clean_item(item: dict) -> dict:
    return {k: item.get(k) for k in ('id', 'name', 'webUrl', 'eTag', 'lastModifiedDateTime') if k in item}
