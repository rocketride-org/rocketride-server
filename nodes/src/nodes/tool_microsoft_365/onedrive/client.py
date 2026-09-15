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


"""OneDrive service bindings, addressing helpers, and response cleaners."""

from __future__ import annotations

import re

import functools
import json
import urllib.error
import urllib.parse
import urllib.request

from .. import graph_client

SERVICE = graph_client.GraphService(product='OneDrive', superset_scopes=frozenset({'Files.ReadWrite.All'}))

token_scope_report = functools.partial(graph_client.token_scope_report, SERVICE)
request = functools.partial(graph_client.request, SERVICE)

# Graph's ceiling for a single PUT .../content upload; above this a resumable
# upload session is required.
SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
# Graph's recommended resumable-upload chunk size (a multiple of 320 KiB).
CHUNK_SIZE = 5 * 1024 * 1024
# Above this, onedrive_download returns a downloadUrl instead of inlining bytes.
DOWNLOAD_INLINE_LIMIT = 1024 * 1024


def _seg(value: str) -> str:
    """URL-encode a single path segment (item/permission ids may contain '!' etc.)."""
    return urllib.parse.quote(value, safe='')


_ITEM_ID_RE = re.compile(r'[A-Za-z0-9!]{15,}$')


def looks_like_item_id(value: str) -> bool:
    """True for Graph item-id-shaped tokens (or the 'root' alias) — see it()."""
    return value == 'root' or bool(_ITEM_ID_RE.fullmatch(value))


def it(base: str, item: str) -> str:
    """Item address for a drive path ('Docs/a.pdf', containing '/') or a single-segment item id.

    A path may have multiple already-valid segments, so each segment is
    percent-encoded (``safe='/'`` preserves the separators) before being
    interpolated into the ``root:/{path}:`` addressing form — an unencoded
    space raises ``http.client.InvalidURL`` and an unencoded ``#`` truncates
    the path, silently addressing the wrong item. A bare item id is a single
    path component and is URL-escaped via ``_seg``. Leading/trailing
    separators are dropped, so ``''``, ``'/'`` and ``'root'`` all address the
    drive root (``root://:`` is not a valid Graph path).
    """
    item = item.strip('/')
    if not item or looks_like_item_id(item):
        return f'{base}/drive/items/{_seg(item or "root")}'
    return f'{base}/drive/root:/{urllib.parse.quote(item, safe="/")}:'


def parent_ref(target_folder: str) -> dict:
    """``parentReference`` body for a target given as a drive path or an item id."""
    if looks_like_item_id(target_folder):
        return {'id': target_folder}
    return {'path': f'/drive/root:/{urllib.parse.quote(target_folder, safe="/")}'}


def upload_chunk(auth, session_url: str, chunk: bytes, start: int, end: int, total: int) -> dict:
    """PUT one chunk of a resumable upload session directly via urllib.

    The session ``uploadUrl`` Graph returns is pre-authenticated and lives on
    a non-Graph host, so the chunk PUT must **not** carry a bearer token (the
    shared ``graph_client.request()`` always attaches one and only allows
    Graph hosts), which is why this call goes straight through urllib. It
    reuses ``graph_client._urlopen`` — the module's one HTTP seam — so tests
    can monkeypatch every Graph call, chunked or not, in one place.

    A chunk PUT is idempotent by ``Content-Range``, so transient failures
    (429/5xx and connection errors) are retried with the same bounded
    exponential backoff as ``request()``: up to 4 attempts, sleeping 1s, 2s,
    4s (or a capped numeric ``Retry-After``).
    """
    del auth  # accepted for call-site symmetry; the session URL is pre-authenticated
    req = urllib.request.Request(
        session_url,
        data=chunk,
        headers={
            'Content-Length': str(len(chunk)),
            'Content-Range': f'bytes {start}-{end}/{total}',
            'Content-Type': 'application/octet-stream',
        },
        method='PUT',
    )
    for attempt in range(4):
        try:
            with graph_client._urlopen(req, timeout=60) as resp:
                raw = resp.read()
            return json.loads(raw.decode()) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            if exc.code in graph_client._RETRY_STATUSES and attempt < 3:
                graph_client._time.sleep(_retry_delay(exc, attempt))
                continue
            try:
                detail = exc.read().decode(errors='replace')
            except Exception:
                detail = str(exc)
            raise graph_client.GraphError(
                f'OneDrive: chunked upload failed (HTTP {exc.code}; {detail[:200]}).'
            ) from exc
        except OSError as exc:
            # URLError (connect failures) and bare socket errors such as
            # TimeoutError/ConnectionResetError raised by urlopen or resp.read()
            # are all OSError; HTTPError is handled above.
            if attempt < 3:
                graph_client._time.sleep(2**attempt)
                continue
            raise graph_client.GraphError(f'OneDrive: chunked upload failed (connection error: {exc}).') from exc
    raise RuntimeError('upload_chunk: retry loop exhausted unexpectedly')  # unreachable


def _retry_delay(exc: urllib.error.HTTPError, attempt: int) -> float:
    """Backoff for a retryable chunk PUT: capped numeric Retry-After, else 1s/2s/4s."""
    retry_after = exc.headers.get('Retry-After') if exc.headers else None
    if retry_after:
        try:
            return min(max(float(retry_after), 0.0), graph_client._MAX_RETRY_AFTER)
        except ValueError:
            pass  # HTTP-date Retry-After: fall back to exponential backoff
    return float(2**attempt)


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------

_ITEM_FIELDS = ('id', 'name', 'size', 'webUrl', 'folder', 'file', 'lastModifiedDateTime')


def clean_item(item: dict) -> dict:
    out = {k: item.get(k) for k in _ITEM_FIELDS if k in item}
    parent = item.get('parentReference')
    if isinstance(parent, dict) and 'path' in parent:
        out['parentReference'] = {'path': parent.get('path')}
    return out


def clean_permission(p: dict) -> dict:
    return {k: p.get(k) for k in ('id', 'roles', 'link', 'grantedToV2', 'grantedToIdentitiesV2') if k in p}
