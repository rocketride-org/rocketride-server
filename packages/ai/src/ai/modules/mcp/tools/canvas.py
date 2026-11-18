# Copyright 2026 Aparavi Software AG. MIT License.
"""Canvas tool: `view_pipeline` shows one saved pipeline as a read-only diagram.

A saved pipeline is a ``.pipe`` or ``.pipe.json`` file in the caller's
workspace, under ``.projects/``. The builder roots the workspace in the
development team's shared files when the account has a development team
(``@/Team/=<teamId>/.projects``); ``EngineClient.get_workspace_root`` applies
the same rule, and a short ``.projects/...`` path is read from that root. A
full ``@/Team/=<id>/.projects/...`` path is used as given. The file store
checks access as it does for ``store_read``: this tool never widens it.

A saved pipeline can hold secrets: literal keys, ``${ROCKETRIDE_*}``
references and encrypted ``secureParameters`` blocks, all inside node
``config``. So the result is built from an allow-list and never carries node
settings. Nothing here resolves variables, validates or decrypts.

Two payloads go out. The model reads a small summary (``content`` and
``structuredContent``). The widget alone reads the result's ``_meta`` under
``rocketride/canvas``: the cleaned pipeline, the catalog entries for its
providers, and the icons they use.
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from ..apps import PIPELINE_CANVAS_URI
from ..tooling import ToolHints, ToolRegistry
from ._common import engine_call as _engine_call

TOOL_NAME = 'view_pipeline'

# The `_meta` key that carries the widget payload.
CANVAS_META_KEY = 'rocketride/canvas'

# Limits.
MAX_FILE_BYTES = 2_097_152
MAX_NODES = 200
MAX_GROUP_DEPTH = 8
MAX_NAME_CHARS = 200
MAX_DESCRIPTION_CHARS = 2_000
MAX_ANNOTATION_CHARS = 20_000
MAX_ID_CHARS = 200
MAX_COLOR_CHARS = 64

PIPELINE_EXTENSIONS = ('.pipe', '.pipe.json')
PROJECTS_PREFIX = '.projects/'

# `@/Team/=<id>/.projects/...`, with the builder's team id pattern.
_TEAM_PATH = re.compile(r'^@/Team/=([A-Za-z0-9][A-Za-z0-9_.-]*)/\.projects/')

# Node types the builder draws (canvas/types.ts INodeType).
_DEFAULT, _GROUP, _ANNOTATION = 'default', 'group', 'annotation'
_NODE_TYPES = (_DEFAULT, _GROUP, _ANNOTATION)

# Annotation colours are drawn as inline CSS. Accept only the two forms the
# builder writes (its colour picker's hex value, or its default --rr-* token),
# so no other text, and nothing that can load a resource, rides in a colour.
_SAFE_COLOR = re.compile(r'^(#[0-9a-fA-F]{3,8}|var\(--rr-[A-Za-z0-9-]+\))$')

# The catalog fields the widget draws a node with. Everything else in a
# catalog entry (schemas, defaults, documentation links) stays out.
_SERVICE_FIELDS = ('title', 'classType', 'lanes', 'invoke', 'capabilities', 'icon')

_VIEW_PIPELINE_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {
            'type': 'string',
            'description': (
                'Pipeline file in the workspace, starting with .projects/ and ending in .pipe or .pipe.json, '
                'for example .projects/invoices.pipe'
            ),
        },
    },
    'required': ['path'],
}

_DESCRIPTION = (
    "Show one of the user's saved pipelines as a read-only diagram. Use this when the user asks to see, "
    'review or explain a saved pipeline. Pass a path that starts with .projects/, for example '
    ".projects/invoices.pipe. It is read from the user's active RocketRide workspace, which is the "
    "development team's shared files when the user has a development team. The result's workspace field "
    'is the folder to pass to store_list to find pipelines. Returns the nodes and connections. It never '
    'returns node settings or secrets.'
)


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------


def is_valid_path(path: Any) -> bool:
    """True for a pipeline file under ``.projects/`` or a team's ``.projects/``.

    No ``..`` segment, no backslash, no leading slash and no control
    character. The file store normalizes and authorizes the path again.
    """
    if not isinstance(path, str) or not path or len(path) > 1024:
        return False
    if path.startswith('/') or '\\' in path or any(ord(ch) < 32 or ord(ch) == 127 for ch in path):
        return False
    if '..' in path.split('/'):
        return False
    if not path.endswith(PIPELINE_EXTENSIONS):
        return False
    if path.startswith(PROJECTS_PREFIX):
        rest = path[len(PROJECTS_PREFIX) :]
    else:
        match = _TEAM_PATH.match(path)
        if not match:
            return False
        rest = path[match.end() :]
    # Something must name the file itself: `.projects/.pipe` is not a pipeline.
    name = rest.rsplit('/', 1)[-1]
    return bool(rest) and name not in PIPELINE_EXTENSIONS and '' not in rest.split('/')


def resolve_path(path: str, workspace: str) -> str:
    """The store path to read: a short path is read from the active workspace root."""
    if path.startswith(PROJECTS_PREFIX) and workspace != '.projects':
        return workspace[: -len('.projects')] + path
    return path


# --------------------------------------------------------------------------
# Cleaning
# --------------------------------------------------------------------------


def _text(value: Any, limit: int) -> Optional[str]:
    """``value`` clipped to ``limit`` characters, or None when it is not text."""
    if not isinstance(value, str):
        return None
    return value[:limit]


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float('inf'), float('-inf')):
        return None
    return value


def _point(value: Any, keys: Tuple[str, str]) -> Optional[Dict[str, float]]:
    if not isinstance(value, dict):
        return None
    out = {}
    for key in keys:
        number = _number(value.get(key))
        if number is None:
            return None
        out[key] = number
    return out


def _clean_ui(ui: Any) -> Dict[str, Any]:
    """Only the drawing fields of ``ui``: position, measured, nodeType, parentId."""
    if not isinstance(ui, dict):
        return {}
    out: Dict[str, Any] = {}
    position = _point(ui.get('position'), ('x', 'y'))
    if position is not None:
        out['position'] = position
    measured = _point(ui.get('measured'), ('width', 'height'))
    if measured is not None:
        out['measured'] = measured
    if ui.get('nodeType') in _NODE_TYPES:
        out['nodeType'] = ui['nodeType']
    parent_id = _text(ui.get('parentId'), MAX_ID_CHARS)
    if parent_id:
        out['parentId'] = parent_id
    return out


def _connections(value: Any, kind_key: str) -> List[Dict[str, str]]:
    """``input`` (kind ``lane``) or ``control`` (kind ``classType``) entries, strings only."""
    out = []
    for entry in value if isinstance(value, list) else []:
        if not isinstance(entry, dict):
            continue
        kind = _text(entry.get(kind_key), MAX_ID_CHARS)
        source = _text(entry.get('from'), MAX_ID_CHARS)
        if kind and source:
            out.append({kind_key: kind, 'from': source})
    return out


def _node_type(component: Dict[str, Any]) -> str:
    ui = component.get('ui')
    node_type = ui.get('nodeType') if isinstance(ui, dict) else None
    if node_type in _NODE_TYPES:
        return node_type
    return _ANNOTATION if component.get('provider') == _ANNOTATION else _DEFAULT


def _annotation_config(config: Any) -> Dict[str, str]:
    """The three fields an annotation is drawn with: its text and two colours."""
    config = config if isinstance(config, dict) else {}
    out: Dict[str, str] = {}
    content = _text(config.get('content'), MAX_ANNOTATION_CHARS)
    if content:
        out['content'] = content
    for key in ('bgColor', 'fgColor'):
        color = _text(config.get(key), MAX_COLOR_CHARS)
        if color and _SAFE_COLOR.match(color.strip()):
            out[key] = color.strip()
    return out


class _Cleaner:
    """Builds the allow-listed pipeline, keeping at most MAX_NODES nodes."""

    def __init__(self) -> None:
        self.total = 0
        self.kept: List[Dict[str, Any]] = []

    def count(self, components: Any, depth: int = 0) -> None:
        """Count every component, nested groups included (to MAX_GROUP_DEPTH)."""
        for raw in components if isinstance(components, list) else []:
            if not isinstance(raw, dict):
                continue
            self.total += 1
            if depth < MAX_GROUP_DEPTH and _node_type(raw) == _GROUP:
                self.count(_children(raw), depth + 1)

    def clean(self, components: Any, depth: int = 0) -> List[Dict[str, Any]]:
        """Clean ``components`` in file order until MAX_NODES are kept."""
        out = []
        for raw in components if isinstance(components, list) else []:
            if len(self.kept) >= MAX_NODES:
                break
            component = self._clean_one(raw, depth)
            if component is not None:
                out.append(component)
        return out

    def _clean_one(self, raw: Any, depth: int) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        component_id = _text(raw.get('id'), MAX_ID_CHARS)
        provider = _text(raw.get('provider'), MAX_ID_CHARS)
        if not component_id or not provider:
            return None
        node_type = _node_type(raw)
        out: Dict[str, Any] = {'id': component_id, 'provider': provider}
        name = _text(raw.get('name'), MAX_NAME_CHARS)
        if name:
            out['name'] = name
        description = _text(raw.get('description'), MAX_DESCRIPTION_CHARS)
        if description:
            out['description'] = description
        # Node settings never leave the server, with two exceptions the drawing
        # needs: a note's text and colours (only for the note provider itself,
        # so another node cannot pass its settings off as a note) and a group's
        # nodes, cleaned the same way.
        out['config'] = (
            _annotation_config(raw.get('config')) if node_type == _ANNOTATION and provider == _ANNOTATION else {}
        )
        inputs = _connections(raw.get('input'), 'lane')
        if inputs:
            out['input'] = inputs
        controls = _connections(raw.get('control'), 'classType')
        if controls:
            out['control'] = controls
        ui = _clean_ui(raw.get('ui'))
        if ui:
            out['ui'] = ui
        self.kept.append(out)
        if node_type == _GROUP and depth < MAX_GROUP_DEPTH:
            children = self.clean(_children(raw), depth + 1)
            if children:
                out['config'] = {'pipeline': {'components': children}}
        return out


def _children(component: Dict[str, Any]) -> Any:
    config = component.get('config')
    pipeline = config.get('pipeline') if isinstance(config, dict) else None
    return pipeline.get('components') if isinstance(pipeline, dict) else None


def _drop_dangling(kept: List[Dict[str, Any]]) -> None:
    """Remove connections to nodes that were not kept (truncation, bad files)."""
    ids = {component['id'] for component in kept}
    for component in kept:
        for key in ('input', 'control'):
            if key in component:
                component[key] = [entry for entry in component[key] if entry['from'] in ids]
                if not component[key]:
                    del component[key]


def clean_pipeline(pipeline: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]], int]:
    """Return ``(cleaned pipeline, every kept component flattened, total node count)``."""
    cleaner = _Cleaner()
    components = pipeline.get('components')
    cleaner.count(components)
    cleaned = cleaner.clean(components)
    _drop_dangling(cleaner.kept)
    return {'components': cleaned}, cleaner.kept, cleaner.total


def load_pipeline_text(text: str) -> Optional[Dict[str, Any]]:
    """Parse a pipeline file: the bare object or a ``pipeline`` envelope, with a components list."""
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None
    if isinstance(data, dict) and isinstance(data.get('pipeline'), dict):
        data = data['pipeline']
    if not isinstance(data, dict) or not isinstance(data.get('components'), list):
        return None
    return data


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------


def _error(error_type: str, message: str, hint: Optional[str], *, path: str, workspace: str) -> dict:
    return {
        'ok': False,
        'error_type': error_type,
        'message': message,
        'hint': hint,
        'path': path,
        'workspace': workspace,
    }


def _is_access_denied(exc: BaseException) -> bool:
    return isinstance(exc, PermissionError) or 'access denied' in str(exc).lower()


def _catalog_slice(catalog: Any, providers: List[str]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Display fields for each provider in the graph, and only the icons they use."""
    catalog = catalog if isinstance(catalog, dict) else {}
    services = catalog.get('services') if isinstance(catalog.get('services'), dict) else {}
    icons = catalog.get('icons') if isinstance(catalog.get('icons'), dict) else {}
    out_services: Dict[str, Any] = {}
    out_icons: Dict[str, str] = {}
    for provider in providers:
        entry = services.get(provider)
        if not isinstance(entry, dict):
            continue
        out_services[provider] = {key: entry[key] for key in _SERVICE_FIELDS if key in entry}
        icon = entry.get('icon')
        if isinstance(icon, str) and isinstance(icons.get(icon), str):
            out_icons[icon] = icons[icon]
    return out_services, out_icons


def _summary(kept: List[Dict[str, Any]], services: Dict[str, Any]) -> Tuple[List[dict], List[dict]]:
    """The model's view: each node's id, provider and title, and every connection."""
    nodes = []
    connections = []
    for component in kept:
        title = (
            component.get('name') or (services.get(component['provider']) or {}).get('title') or component['provider']
        )
        nodes.append({'id': component['id'], 'provider': component['provider'], 'title': title})
        for entry in component.get('input', []):
            connections.append({'from': entry['from'], 'to': component['id'], 'lane': entry['lane']})
        for entry in component.get('control', []):
            connections.append({'from': entry['from'], 'to': component['id'], 'control': entry['classType']})
    return nodes, connections


def _file_name(path: str) -> str:
    name = path.rsplit('/', 1)[-1]
    for extension in ('.pipe.json', '.pipe'):
        if name.endswith(extension):
            return name[: -len(extension)]
    return name


async def _view_pipeline(client, tasks, args: Dict[str, Any]) -> dict:
    workspace, err = await _engine_call(client.get_workspace_root(), TOOL_NAME)
    if err:
        return err

    given = args.get('path')
    if not is_valid_path(given):
        return _error(
            'InvalidPath',
            'view_pipeline only opens pipeline files (.pipe or .pipe.json) under .projects.',
            f'Call store_list with path {workspace} to find one.',
            path=given if isinstance(given, str) else '',
            workspace=workspace,
        )
    path = resolve_path(given, workspace)

    def not_found() -> dict:
        return _error(
            'NotFound',
            f'No pipeline file at {path}.',
            f'Call store_list with path {workspace} to see the saved pipelines.',
            path=path,
            workspace=workspace,
        )

    def denied() -> dict:
        return _error(
            'AccessDenied',
            f"You don't have access to the pipeline at {path}.",
            f'Call store_list with path {workspace} to see the pipelines you can open.',
            path=path,
            workspace=workspace,
        )

    def too_large(size: int) -> dict:
        result = _error(
            'PipelineTooLarge',
            f'This pipeline file is too large to show ({size:,} bytes, the limit is 2,097,152).',
            None,
            path=path,
            workspace=workspace,
        )
        result['size'] = size
        return result

    # Stat first, so a huge file is refused before it is read.
    try:
        stat, err = await _engine_call(client.fs_stat(path), TOOL_NAME)
    except Exception as exc:  # noqa: BLE001 - only an access refusal is mapped here; the rest re-raises
        if _is_access_denied(exc):
            return denied()
        raise
    if err:
        return err
    stat = stat if isinstance(stat, dict) else {}
    if not stat.get('exists') or stat.get('type') not in ('file', 'both'):
        return not_found()
    size = stat.get('size')
    if isinstance(size, int) and size > MAX_FILE_BYTES:
        return too_large(size)

    try:
        text, err = await _engine_call(client.fs_read_string(path), TOOL_NAME)
    except Exception as exc:  # noqa: BLE001 - only an access refusal is mapped here; the rest re-raises
        if _is_access_denied(exc):
            return denied()
        raise
    if err:
        return err
    text = text if isinstance(text, str) else ''
    # The file can grow between the stat and the read.
    size = len(text.encode('utf-8'))
    if size > MAX_FILE_BYTES:
        return too_large(size)

    pipeline = load_pipeline_text(text)
    if pipeline is None:
        return _error('InvalidPipeline', f'The file at {path} is not a pipeline.', None, path=path, workspace=workspace)

    cleaned, kept, total = clean_pipeline(pipeline)
    providers = sorted({component['provider'] for component in kept})
    catalog, err = await _engine_call(client.get_services(), TOOL_NAME)
    if err:
        return err
    services, icons = _catalog_slice(catalog, providers)
    nodes, connections = _summary(kept, services)

    return {
        'ok': True,
        'path': path,
        'workspace': workspace,
        'name': _text(pipeline.get('name'), MAX_NAME_CHARS) or _file_name(path),
        'description': _text(pipeline.get('description'), MAX_DESCRIPTION_CHARS) or '',
        'node_count': total,
        'truncated': total > len(kept),
        'nodes': nodes,
        'connections': connections,
        # Widget only: the dispatcher moves this to CallToolResult._meta.
        '_meta': {CANVAS_META_KEY: {'pipeline': cleaned, 'services': services, 'icons': icons}},
    }


def register(registry: ToolRegistry) -> None:
    """Register `view_pipeline` against ``registry``."""
    registry.register(
        TOOL_NAME,
        _DESCRIPTION,
        _VIEW_PIPELINE_SCHEMA,
        ui_resource_uri=PIPELINE_CANVAS_URI,
        hints=ToolHints.reads(
            "Reads one saved pipeline file from the caller's store and returns its graph without node settings."
        ),
    )(_view_pipeline)
