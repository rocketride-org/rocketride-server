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
Cached service catalog: the server-side view of the engine's node services.

The engine parses every node's ``services.*.json`` once at startup and holds
the definitions in memory, but its bulk accessor (``getServiceDefinitions``)
re-assembles the full result — every service's configuration schema included
— on every call. This module pays that cost ONCE on first use, enriches each
entry with its node's icon, and serves two cached views:

  summary — display fields per service plus a DEDUPLICATED icon table:
            everything a client needs to render the canvas / node palette.
            Returned by the bulk ``rrext_services`` call as::

                {
                  "services": { "<name>": { ..., "icon": "3" }, ... },
                  "icons":    { "3": "<svg .../>", ... },
                  "version":  N
                }

            Many nodes share an icon (byte-identical by convention), so
            each distinct SVG is stored once in ``icons`` and referenced
            by an opaque id. Ids are keyed by CONTENT, so two different
            icons that happen to share a filename never collide. Ids are
            stable only within one build — clients consume the response
            atomically and must not persist them across reloads.
  full    — the complete entry (configuration schema included): what the
            configure panel needs. Returned by the single-service call.
            Carries no icon at all — the client already has it from the
            summary.

Icons: the engine resolves each definition's ``icon`` field to the icon
file's ABSOLUTE path at load time (only the loader knows which directory a
services.json came from). That path is consumed here — the SVG text is
read into the icon table — and the path itself is dropped from both views
so server filesystem layout never reaches a client.

Invalidation: the cache mirrors the engine's in-memory definitions, so it
must be dropped whenever those change (node install / update / removal).
Call :func:`invalidate`; the next request rebuilds.
"""

import asyncio
from typing import Any, Dict, Optional, Tuple

from rocketlib import debug, getServiceDefinitions, warning

# Display fields that form a service summary. Everything else on a bulk
# entry is configuration schema, served only by the single-service view.
SUMMARY_FIELDS = (
    'title',
    'protocol',
    'prefix',
    'plans',
    'capabilities',
    'classType',
    'actions',
    'description',
    'lanes',
    'input',
    'invoke',
    'tile',
    'documentation',
)

# Build-once state: (master, summary) or None when the cache is cold.
# master:  name -> full entry (config schema + iconSvg, no icon path)
# summary: the complete rrext_services response body ({'services', 'version'})
_catalog: Optional[Tuple[Dict[str, Any], Dict[str, Any]]] = None
_lock = asyncio.Lock()
# Bumped by invalidate() so an in-flight build can detect staleness.
_generation = 0


def invalidate() -> None:
    """
    Drop the cached catalog so the next request rebuilds it.

    Call whenever the engine's service definitions change (node install,
    update, or removal). Safe to call at any time, including before first
    use.
    """
    global _catalog, _generation
    _generation += 1
    _catalog = None


def _read_icon(icon_path: Any) -> Optional[str]:
    """
    Read one icon file's SVG text, tolerating every failure.

    Args:
        icon_path: Absolute path from the engine's resolved ``icon`` field.

    Returns:
        The SVG text, or None when the path is unset/unreadable — a missing
        icon must never break the catalog (clients fall back to their
        built-in unknown icon). SVG is XML text, so it travels in the JSON
        response as a plain string — no base64. utf-8-sig strips a BOM if
        an icon file carries one.
    """
    if not icon_path or not isinstance(icon_path, str):
        return None
    try:
        with open(icon_path, 'r', encoding='utf-8-sig') as fh:
            return fh.read()
    except OSError as exc:
        warning(f'Service icon unreadable: {icon_path} ({exc})')
        return None


def _build() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Build the master list and the summary response from the engine.

    One expensive pass: fetch the bulk definitions from the engine, read
    every icon file (each distinct path once), and project the summary
    view with its deduplicated icon table. Runs in a worker thread (see
    :func:`_get_catalog`) so the event loop stays responsive.

    Returns:
        (master, summary) — see module docstring for shapes.
    """
    raw = getServiceDefinitions() or {}
    services = raw.get('services', {}) or {}

    master: Dict[str, Any] = {}
    summary_services: Dict[str, Any] = {}
    icons: Dict[str, str] = {}  # icon id -> SVG text
    id_by_content: Dict[str, str] = {}  # SVG text -> icon id (content dedup)
    svg_by_path: Dict[Any, Optional[str]] = {}  # path -> SVG (one read per file)

    for name, entry in services.items():
        # Full entry: everything except the icon — the server-local path
        # must not leak, and clients take icons from the summary table.
        full = dict(entry)
        icon_path = full.pop('icon', None)
        master[name] = full

        # Summary entry: display fields only, no config schema.
        brief = {k: full[k] for k in SUMMARY_FIELDS if k in full}

        # Icon: read each distinct file once, dedup the TABLE by content —
        # identical SVGs shared across nodes get one id, and two different
        # icons sharing a filename can never collide.
        if icon_path not in svg_by_path:
            svg_by_path[icon_path] = _read_icon(icon_path)
        icon_svg = svg_by_path[icon_path]
        if icon_svg is not None:
            icon_id = id_by_content.get(icon_svg)
            if icon_id is None:
                icon_id = str(len(icons))
                id_by_content[icon_svg] = icon_id
                icons[icon_id] = icon_svg
            brief['icon'] = icon_id
        summary_services[name] = brief

    summary = {
        'services': summary_services,
        'icons': icons,
        'version': raw.get('version'),
    }
    debug(f'Service catalog built: {len(master)} services, {len(icons)} distinct icons')
    return master, summary


async def _get_catalog() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Return the cached (master, summary), building it on first use.

    The lock collapses a thundering herd at boot into a single build; the
    build itself runs in a worker thread because the engine call and the
    icon reads are blocking.
    """
    global _catalog
    if _catalog is not None:
        return _catalog
    async with _lock:
        if _catalog is not None:
            return _catalog
        # Snapshot the generation before the build: invalidate() during the
        # build bumps it, and a stale result must not be published as the
        # shared cache.
        generation = _generation
        built = await asyncio.to_thread(_build)
        if generation == _generation:
            _catalog = built
        # Even when stale, the requesting call keeps its own snapshot — it
        # answers with the definitions that were live when it asked.
        return built


async def get_summary() -> Dict[str, Any]:
    """
    Return the cached bulk response body:
    ``{'services': {...}, 'icons': {...}, 'version'}``.

    Every service entry carries only the display fields plus an ``icon``
    id into the deduplicated ``icons`` table — the configuration schema
    is served by :func:`get_service`.
    """
    _, summary = await _get_catalog()
    return summary


async def get_service(name: str) -> Optional[Dict[str, Any]]:
    """
    Return one service's full entry (configuration schema included).

    Args:
        name: The service's logical type (e.g. ``'ocr'``).

    Returns:
        The full entry dict, or None when the service is unknown.
    """
    master, _ = await _get_catalog()
    return master.get(name)
