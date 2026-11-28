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
from urllib.parse import urlsplit

import mcp.types as types

UI_MIME_TYPE = 'text/html;profile=mcp-app'
UI_EXTENSION_ID = 'io.modelcontextprotocol/ui'
# ChatGPT's alias for the widget domain (its docs: a compatibility alias for _meta.ui.domain).
OPENAI_WIDGET_DOMAIN_KEY = 'openai/widgetDomain'

PIPELINES_TABLE_URI = 'ui://rocketride/pipelines-table.html'
DROPPER_URI = 'ui://rocketride/dropper.html'
TRACE_VIEWER_URI = 'ui://rocketride/trace-viewer.html'
PIPELINE_CANVAS_URI = 'ui://rocketride/pipeline-canvas.html'

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
    AppSpec(
        uri=PIPELINE_CANVAS_URI,
        filename='pipeline-canvas.html',
        title='Pipeline canvas',
    ),
]


def extension_capability() -> dict:
    return {'mimeTypes': [UI_MIME_TYPE]}


def available_apps(apps_dir: Optional[Path] = None) -> List[AppSpec]:
    """Specs whose built HTML bundle actually exists on disk."""
    base = apps_dir if apps_dir is not None else _APPS_DIST
    return [spec for spec in APPS if (base / spec.filename).is_file()]


def spec_for_uri(uri: str) -> Optional[AppSpec]:
    """The registered spec for a ``ui://`` URI, or None."""
    return next((spec for spec in APPS if spec.uri == uri), None)


def origin_of(url: Optional[str]) -> Optional[str]:
    """Return ``scheme://host[:port]`` for an http(s) URL, or None.

    A CSP source must be a bare origin, and the engine URL can carry a path or
    userinfo when ``ROCKETRIDE_URI`` is set by hand. The host is lowercased,
    userinfo, path, query and fragment are dropped, and a default port (80 for
    http, 443 for https) is left out. Anything that is not an http or https URL
    with a host, or has a bad port, gives None.
    """
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or '').lower()
    if scheme not in ('http', 'https') or not host:
        return None
    if ':' in host:
        host = f'[{host}]'
    if port is None or (scheme, port) in (('http', 80), ('https', 443)):
        return f'{scheme}://{host}'
    return f'{scheme}://{host}:{port}'


def ui_meta(spec: AppSpec, engine_origin: Optional[str], ui_domain: Optional[str]) -> dict:
    """The ``_meta`` value for one widget resource.

    The same value goes on the ``resources/list`` entry and on the
    ``resources/read`` content item, so the two never differ. Hosts that follow
    the MCP Apps spec, ChatGPT among them, read it from the read result.

    Every widget declares a CSP. The bundles are single files with no outside
    scripts, styles, fonts or frames, so ``resourceDomains`` is empty, and
    ``frameDomains`` and ``baseUriDomains`` are left out so the host's default
    of none applies. Only the dropper talks to the network: it uploads to the
    engine, so its ``connectDomains`` holds the engine origin when there is one.

    ``ui_domain`` (``MCP_UI_DOMAIN``) goes only under ChatGPT's own key,
    ``openai/widgetDomain``, never as ``ui.domain``: each host has its own
    domain format, and Claude shows an error instead of the app when
    ``ui.domain`` is not its hash of the connector URL. Hosts other than
    ChatGPT get no domain and use their default sandbox origin.
    """
    connect: List[str] = []
    if spec.needs_engine_origin:
        origin = origin_of(engine_origin)
        if origin:
            connect.append(origin)
    meta: dict = {'ui': {'csp': {'connectDomains': connect, 'resourceDomains': []}}}
    if ui_domain:
        meta[OPENAI_WIDGET_DOMAIN_KEY] = ui_domain
    return meta


def list_ui_resources(
    apps_dir: Optional[Path] = None,
    engine_origin: Optional[str] = None,
    ui_domain: Optional[str] = None,
) -> List[types.Resource]:
    return [
        types.Resource(
            uri=spec.uri,
            name=spec.title,
            mime_type=UI_MIME_TYPE,
            meta=ui_meta(spec, engine_origin, ui_domain),
        )
        for spec in available_apps(apps_dir)
    ]


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
