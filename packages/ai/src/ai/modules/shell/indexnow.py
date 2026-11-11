# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
IndexNow: tell search engines which public pages changed, when they change.

On only with ``RR_INDEXNOW_KEY`` (8 to 128 of ``[A-Za-z0-9-]``) and an
``RR_APP_URL`` on an ``https://`` origin: then the key is served at
``/<key>.txt``, where the IndexNow engines (Bing, Yandex, Seznam, Naver and
others share submissions) verify that it belongs to the host, and every
aggregate swap submits the listed pages whose content changed since the last
build, plus the pages that build listed which are now gone or unlisted
(IndexNow covers deleted URLs). Otherwise nothing is served or submitted.

A page's content is its manifest entry (every declared field, but not its
production version, build path or binding time, which change with each
publish of its app) plus the sha256 of its snapshot. A version's build
output never changes, so a snapshot is read again only when its page moves
to another version; a read that fails counts as a change. A page without a
production version has no snapshot to read, so it shows none.

Changes are measured against the last real build this process read in
full. The first one is a baseline (a restart submits nothing), a build that
fell back to the legacy page list is ignored, and the pages of an app absent
from a build (unpublished, made non-public, or skipped for a store error)
are kept from the last build instead of reported gone, so a transient skip
and its recovery submit nothing. The cost: a wholly unpublished app's URLs
are never submitted as removed.

One background task does the work, off the request path, in swap order; a
build swapped in while it works is coalesced with any later one. Snapshot
reads run at most ``MAX_CONCURRENT_READS`` at a time, and a build's reads are
bounded by ``READ_SECONDS``. A build whose reads time out is retried by the
task itself, after ``RETRY_SECONDS`` doubling up to ``MAX_RETRY_SECONDS``,
until it succeeds or a later build supersedes it; a baseline is never
superseded, so the changes of the build after it are not lost. A build's
URLs go in POSTs of at most 10,000 each (the protocol's cap), one after
another, each bounded by ``TIMEOUT_SECONDS``. Failures and refusals are
logged as warnings and never affect the rebuild. The paths of a failed or
refused batch are kept (at most ``_MAX_FAILED``) and go out with the next
submission; an accepted batch clears its paths.
"""

import asyncio
import hashlib
import re
from dataclasses import dataclass, replace
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple
from urllib.parse import urlsplit

import httpx
from fastapi.responses import PlainTextResponse

from ai.web import Request

from rocketlib import debug, warning

from . import public_pages
from .contract import MAX_SNAPSHOT_BYTES, Page
from .pages import snapshot_path
from .public_pages import Aggregate
from .settings import indexnow_key
from .shell import app_url

ENDPOINT = 'https://api.indexnow.org/indexnow'
TIMEOUT_SECONDS = 5.0
READ_SECONDS = 30.0
RETRY_SECONDS = 30.0
MAX_RETRY_SECONDS = 600.0
MAX_CONCURRENT_READS = 8
_KEY = re.compile(r'[A-Za-z0-9-]{8,128}')
_MAX_URLS = 10000  # the protocol's per-request cap
_MAX_FAILED = 50000  # paths kept for resubmission; beyond it the rest are dropped


@dataclass(frozen=True)
class _Content:
    """What a listed page shows: its manifest entry, and its snapshot's store path and sha256.

    ``digest`` is '' when the page shows no snapshot (none declared, no
    production version, or one over ``MAX_SNAPSHOT_BYTES``, which crawlers
    never get) and None when the snapshot could not be read.
    """

    entry: Page
    snapshot: str = ''
    digest: Optional[str] = ''


# path -> content of the last real build's listed pages (None until the baseline).
_last: Optional[Dict[str, _Content]] = None
# The newest build not yet diffed, and the task diffing builds.
_pending: Optional[Aggregate] = None
_worker: Optional[asyncio.Task] = None
# Paths of batches that failed or were refused, merged into the next submission.
_failed: Set[str] = set()


def key() -> str:
    """The configured IndexNow key.

    Returns:
        The key from ``RR_INDEXNOW_KEY``, or '' when absent or malformed.
    """
    value = indexnow_key()
    if not _KEY.fullmatch(value):
        return ''
    return value


def enabled() -> bool:
    """Whether this engine serves the key file and submits.

    Returns:
        True with a valid key and an ``https://`` ``RR_APP_URL``.
    """
    return bool(key()) and app_url().startswith('https://')


async def _content(page: Page, last: Optional[_Content], reads: asyncio.Semaphore) -> _Content:
    entry = replace(page, dist_dir='', version=None, published_at=None)
    if not page.snapshot:
        return _Content(entry)
    try:
        path = snapshot_path(page)
    except ValueError:
        # No production version to read it from: crawlers get the shell
        # document, so the page shows no snapshot (not a failed read).
        return _Content(entry)
    if last is not None and last.snapshot == path and last.digest is not None:
        return _Content(entry, path, last.digest)
    try:
        async with reads:
            # Stat first, as serving does: a snapshot over the cap is never
            # downloaded, and crawlers get the shell document instead.
            info = await public_pages.artifact_file_info(path)
            if info['size'] > MAX_SNAPSHOT_BYTES:
                return _Content(entry, path, '')
            raw = await public_pages.read_artifact_file(path)
    except Exception as exc:
        warning(f'[indexnow] {page.path}: snapshot {page.snapshot!r} unreadable, counted as changed: {exc}')
        return _Content(entry, '', None)
    return _Content(entry, path, hashlib.sha256(raw).hexdigest())


async def _contents(pages: List[Page], last: Dict[str, _Content]) -> Dict[str, _Content]:
    reads = asyncio.Semaphore(MAX_CONCURRENT_READS)
    found = await asyncio.gather(*(_content(p, last.get(p.path), reads) for p in pages))
    return {p.path: c for p, c in zip(pages, found)}


def _changed(last: Optional[_Content], now: _Content) -> bool:
    return last is None or last.entry != now.entry or last.digest != now.digest or now.digest is None


def diff(
    last: Dict[str, _Content], now: Dict[str, _Content], apps: Iterable[str]
) -> Tuple[List[str], Dict[str, _Content]]:
    """Compare this build's listed pages with the last build's.

    A page the last build listed is submitted when it is gone or unlisted,
    unless its app is absent from this build: then it is kept as it was.

    Args:
        last: The last real build's listed pages, by path.
        now: This build's listed pages, by path.
        apps: The app ids with any page in this build.

    Returns:
        ``(paths to submit, the new last build)``, the paths sorted.
    """
    present: Set[str] = set(apps)
    kept = {path: c for path, c in last.items() if path not in now and c.entry.app_id not in present}
    paths = [path for path, c in now.items() if _changed(last.get(path), c)]
    paths += [path for path in last if path not in now and path not in kept]
    return sorted(paths), {**kept, **now}


async def _process(aggregate: Aggregate) -> bool:
    """Diff ``aggregate`` against the last build and submit the changes; False when its reads timed out."""
    global _last
    if not enabled():
        return True
    k, base = key(), app_url()
    listed = [p for p in aggregate.pages() if p.listed]
    try:
        now = await asyncio.wait_for(_contents(listed, _last or {}), READ_SECONDS)
    except asyncio.TimeoutError:
        warning(f'[indexnow] reading the snapshots timed out after {READ_SECONDS:g}s; the build will be retried')
        return False
    if _last is None:
        _last = now
        return True
    changed, _last = diff(_last, now, (p.app_id for p in aggregate.exact.values()))
    paths = sorted(_failed.union(changed))
    for start in range(0, len(paths), _MAX_URLS):
        batch = paths[start : start + _MAX_URLS]
        if await submit(base, k, [base + path for path in batch]):
            _failed.difference_update(batch)
        else:
            _keep_failed(batch)
    return True


def _keep_failed(batch: List[str]) -> None:
    """Remember the paths of a failed ``batch`` for the next submission, up to ``_MAX_FAILED`` in all."""
    room = _MAX_FAILED - len(_failed)
    kept = [path for path in batch if path in _failed]
    kept += [path for path in batch if path not in _failed][: max(room, 0)]
    dropped = len(batch) - len(kept)
    _failed.update(kept)
    if dropped:
        warning(f'[indexnow] {dropped} failed URL(s) dropped: more than {_MAX_FAILED} are waiting for resubmission')


def _backoff() -> Iterator[float]:
    """The waits before each retry of a timed-out build: ``RETRY_SECONDS``, doubling up to ``MAX_RETRY_SECONDS``."""
    wait = RETRY_SECONDS
    while True:
        yield wait
        wait = min(wait * 2, MAX_RETRY_SECONDS)


def _client() -> Any:
    return httpx.AsyncClient(timeout=TIMEOUT_SECONDS)


async def _post(payload: dict) -> Any:
    async with _client() as client:
        return await client.post(ENDPOINT, json=payload)


async def submit(base: str, k: str, urls: List[str]) -> bool:
    """POST ``urls`` for the host of ``base``; the outcome is logged, never raised.

    Args:
        base: The public origin (``RR_APP_URL`` without a trailing slash).
        k: The IndexNow key.
        urls: The absolute URLs to submit, at most ``_MAX_URLS``.

    Returns:
        True when IndexNow accepted the batch (a 2xx answer), False when the
        POST failed, timed out or was refused.
    """
    payload = {'host': urlsplit(base).hostname, 'key': k, 'keyLocation': f'{base}/{k}.txt', 'urlList': urls}
    try:
        response = await asyncio.wait_for(_post(payload), TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        warning(f'[indexnow] submitting {len(urls)} URL(s) timed out after {TIMEOUT_SECONDS:g}s')
        return False
    except Exception as exc:
        warning(f'[indexnow] submitting {len(urls)} URL(s) failed: {exc}')
        return False
    if 200 <= response.status_code < 300:
        debug(f'[indexnow] submitted {len(urls)} URL(s): HTTP {response.status_code}')
        return True
    warning(f'[indexnow] {len(urls)} URL(s) refused: HTTP {response.status_code}')
    return False


async def _drain() -> None:
    global _pending
    retry: Optional[Aggregate] = None
    waits = _backoff()
    while retry is not None or _pending is not None:
        if retry is not None:
            await asyncio.sleep(next(waits))
            # A later build supersedes a timed-out one, except a baseline, which must land first.
            if _last is not None and _pending is not None:
                retry = None
        if retry is not None:
            aggregate, retry = retry, None
        else:
            aggregate, _pending = _pending, None
        try:
            done = await _process(aggregate)
        except Exception as exc:
            warning(f'[indexnow] could not diff the new build: {exc}')
            done = True
        if done:
            waits = _backoff()
        else:
            retry = aggregate


def on_swap(old: Aggregate, new: Aggregate) -> None:
    """Aggregate swap listener: queue a real build for the background diff and submission.

    Nothing is queued for the legacy page list or when IndexNow is off.
    Called with no running event loop, it queues nothing: the build is
    diffed with the next swap.

    Args:
        old: The aggregate swapped out (unused).
        new: The aggregate swapped in.
    """
    global _pending, _worker
    if new.legacy or not enabled():
        return
    _pending = new
    if _worker is not None and not _worker.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Rebuilds swap inside the event loop; a synchronous caller's build waits for the next swap.
        debug('[indexnow] no running event loop: the build is diffed with the next one')
        return
    _worker = loop.create_task(_drain())


async def key_file(request: Request) -> PlainTextResponse:
    """``GET /<key>.txt``: the key, which IndexNow engines fetch to verify the host.

    Args:
        request: The incoming request (unused).

    Returns:
        The key as plain text.
    """
    return PlainTextResponse(key())
