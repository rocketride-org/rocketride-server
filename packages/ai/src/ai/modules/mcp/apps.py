# Copyright 2026 Aparavi Software AG. MIT License.
"""MCP Apps (io.modelcontextprotocol/ui): embedded widget resources.

Widgets are single-file HTML bundles built by ``builder mcp-widgets:build``
from the vite workspace embedded at ``apps/`` next to this module, straight
into ``apps/dist/`` (the ai:build syncDir carries only that dist into the
server dist — the workspace's sources and node_modules are excluded). Each widget is served as
a ``ui://`` resource with the profile mimeType; tools opt in by registering
with ``ui_resource_uri`` (see tooling.py). Hosts without the UI extension see
the plain JSON tool results, unchanged.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import mcp.types as types

UI_MIME_TYPE = 'text/html;profile=mcp-app'
UI_EXTENSION_ID = 'io.modelcontextprotocol/ui'

PIPELINES_TABLE_URI = 'ui://rocketride/pipelines-table.html'
DROPPER_URI = 'ui://rocketride/dropper.html'
TRACE_VIEWER_URI = 'ui://rocketride/trace-viewer.html'

_APPS_DIST = Path(__file__).parent / 'apps' / 'dist'


@dataclass(frozen=True)
class AppSpec:
    uri: str
    filename: str
    title: str
    needs_engine_origin: bool = False


APPS: List[AppSpec] = [
    AppSpec(
        uri=PIPELINES_TABLE_URI,
        filename='pipelines-table.html',
        title='Running pipelines',
    ),
    AppSpec(
        uri=DROPPER_URI,
        filename='dropper.html',
        title='Drop files',
        needs_engine_origin=True,
    ),
    AppSpec(
        uri=TRACE_VIEWER_URI,
        filename='trace-viewer.html',
        title='Pipeline trace',
    ),
]


def extension_capability() -> dict:
    return {'mimeTypes': [UI_MIME_TYPE]}


def available_apps(apps_dir: Optional[Path] = None) -> List[AppSpec]:
    """Specs whose built HTML bundle actually exists on disk."""
    base = apps_dir if apps_dir is not None else _APPS_DIST
    return [spec for spec in APPS if (base / spec.filename).is_file()]


def list_ui_resources(apps_dir: Optional[Path] = None, engine_origin: Optional[str] = None) -> List[types.Resource]:
    out = []
    for spec in available_apps(apps_dir):
        meta = None
        if spec.needs_engine_origin and engine_origin:
            meta = {'ui': {'csp': {'connectDomains': [engine_origin]}}}
        out.append(types.Resource(uri=spec.uri, name=spec.title, mime_type=UI_MIME_TYPE, meta=meta))
    return out


# Widget bundles are static after the build; cache reads per path with the
# mtime in the value, so the request path skips repeated blocking file I/O
# while a rebuilt bundle still invalidates naturally. Bounded by the number
# of specs (one entry per widget path).
_HTML_CACHE: dict = {}


def read_ui_resource(uri: str, apps_dir: Optional[Path] = None) -> Optional[str]:
    """Return the widget HTML for ``uri``, or None if unknown/not built."""
    base = apps_dir if apps_dir is not None else _APPS_DIST
    for spec in APPS:
        if spec.uri == uri:
            path = base / spec.filename
            try:
                mtime_ns = path.stat().st_mtime_ns
            except OSError:
                continue
            cached = _HTML_CACHE.get(str(path))
            if cached is None or cached[0] != mtime_ns:
                cached = (mtime_ns, path.read_text(encoding='utf-8'))
                _HTML_CACHE[str(path)] = cached
            return cached[1]
    return None
