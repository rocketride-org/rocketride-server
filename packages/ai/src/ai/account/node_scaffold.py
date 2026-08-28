# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node scaffolder: render a complete, valid custom-node folder from a few inputs.

One source of truth for every surface. The VSCode extension, the web builder and
Claude all call ``rrext_node_dev`` (subcommand ``scaffold``) and write the returned
file map, so a node
scaffolded from any host is byte-identical. A node is a folder under
``nodes/src/nodes/<name>/`` (or a workspace ``--node_path``) holding a
``services.json`` plus Python ``IGlobal``/``IInstance``[/``IEndpoint``] classes; the
engine discovers it with no central registration (see docs/README-node-schema.md).

The ``name`` is the node's frozen identity: it becomes the ``protocol`` key the
``.pipe`` stores, so renaming it later breaks every pipe that used the node. We
validate it hard here and never let a scaffold emit an invalid one.
"""

import json
import re
from typing import Dict, List, Optional

# The node name is the protocol key the pipe persists — lock it to a safe, stable
# identifier so a rename never silently breaks saved pipelines.
_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{1,63}$')

# 'filter' consumes lanes and emits lanes (IGlobal + IInstance). 'source' originates
# data on the '_source' lane and needs an IEndpoint factory. These map to the
# services.json 'register' key exactly as the loader expects.
_KINDS = ('filter', 'source')

_LICENSE = """# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""


def _prefix(name: str) -> str:
    """CamelCase prefix the engine adds/removes converting URLs <=> paths (my_node -> MyNode)."""
    return ''.join(part.capitalize() for part in name.split('_'))


def _services_json(
    name: str, title: str, kind: str, class_type: List[str], lanes: Dict[str, List[str]], description: str
) -> str:
    """The services.json manifest. Plain JSON (a subset of the JSONC the loader reads)."""
    register = 'filter' if kind == 'filter' else 'endpoint'
    manifest = {
        'title': title,
        'protocol': f'{name}://',
        'classType': class_type,
        'capabilities': [],
        'register': register,
        'node': 'python',
        'path': f'nodes.{name}',
        'prefix': _prefix(name),
        'description': [description] if description else [f'{title} node.'],
        'icon': f'{name}.svg',
        'lanes': lanes,
        'fields': {},
        'shape': [{'section': 'Pipe', 'title': title, 'properties': []}],
    }
    return json.dumps(manifest, indent=2) + '\n'


def _init_py(kind: str) -> str:
    lines = [_LICENSE, '', 'from .IGlobal import IGlobal as IGlobal', 'from .IInstance import IInstance as IInstance']
    if kind == 'source':
        lines.append('from .IEndpoint import IEndpoint as IEndpoint')
    return '\n'.join(lines) + '\n'


def _iglobal_py() -> str:
    """Shared per-task state. Loads requirements outside config mode, like every node."""
    return (
        _LICENSE
        + """
from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    def beginGlobal(self) -> None:
        # In CONFIG mode the canvas only needs the manifest, so skip loading the driver.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            import os
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)
"""
    )


def _iinstance_filter_py() -> str:
    """Per-object worker for a filter. Ships as a pass-through; the author fills in the transform."""
    return (
        _LICENSE
        + '''
from rocketlib import IInstanceBase, Entry
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, object: Entry) -> None:
        """Start of a new input object. Reset any per-object state here."""
        pass

    def writeText(self, text: str) -> None:
        """Called for each text input. Transform it, then emit downstream.

        Emit with ``self.instance.write*`` (writeText/writeDocuments/writeTable/...).
        This default re-emits the text unchanged — replace it with your logic.
        """
        self.instance.writeText(text)
'''
    )


def _iinstance_source_py() -> str:
    """Per-object worker for a source. The IEndpoint drives it; this handles produced objects."""
    return (
        _LICENSE
        + '''
from rocketlib import IInstanceBase, Entry
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, object: Entry) -> None:
        """Start of a new produced object. Reset any per-object state here."""
        pass
'''
    )


def _iendpoint_py(title: str) -> str:
    """Source factory. Override beginEndpoint to start producing on the '_source' lane."""
    return (
        _LICENSE
        + f'''
from rocketlib import IEndpointBase


class IEndpoint(IEndpointBase):
    """Source endpoint for the {title} node.

    A source originates data. Start producing from ``beginEndpoint`` (open a
    connection, a poll loop, a webhook, ...); for each item open an object and
    emit it on the node's output lane with ``self.write*``. This stub loads and
    appears in the catalog; fill in production below.
    """

    def beginEndpoint(self) -> None:
        # TODO: start producing here (open your source, then open objects and emit).
        pass
'''
    )


def _readme_md(name: str, title: str, kind: str) -> str:
    return f"""# {title}

Custom `{kind}` node (`{name}://`). Scaffolded by the RocketRide Node Builder.

- `services.json` — manifest (identity, lanes, config UI). The `protocol` is the
  frozen node id; renaming it breaks saved pipelines.
- `IGlobal.py` / `IInstance.py`{' / `IEndpoint.py`' if kind == 'source' else ''} — the Python implementation.
- `requirements.txt` — runtime deps (no version pins for shared libraries).

Edit the stubs, then validate and test from the Node Builder.
"""


def _placeholder_svg(title: str) -> str:
    """A neutral square-with-initial icon so the node renders on the canvas immediately."""
    initial = (title.strip()[:1] or '?').upper()
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">'
        '<rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" opacity="0.15"/>'
        f'<text x="12" y="16" text-anchor="middle" font-size="12" font-family="sans-serif" '
        f'fill="currentColor">{initial}</text></svg>\n'
    )


def _default_lanes(kind: str) -> Dict[str, List[str]]:
    # A filter consumes and emits text by default; a source originates text on '_source'.
    return {'_source': ['text']} if kind == 'source' else {'text': ['text']}


def scaffold_node(
    name: str,
    title: Optional[str] = None,
    kind: str = 'filter',
    class_type: Optional[List[str]] = None,
    lanes: Optional[Dict[str, List[str]]] = None,
    description: Optional[str] = None,
) -> Dict[str, str]:
    """Render a full node folder as a ``{relative_path: file_contents}`` map.

    Args:
        name: node id / protocol key. Lowercase ``[a-z][a-z0-9_]{1,63}``. Frozen.
        title: canvas display name (defaults to a Title Case of ``name``).
        kind: ``'filter'`` (consumes+emits lanes) or ``'source'`` (originates data).
        class_type: catalog category, e.g. ``['text']``. Defaults by kind.
        lanes: input->[outputs] map. Defaults by kind.
        description: one-line node description.

    Returns:
        Map of relative path to contents, ready to write under ``<node>/``.

    Raises:
        ValueError: on an invalid name or unknown kind.
    """
    if not _NAME_RE.match(name or ''):
        raise ValueError(
            f'invalid node name {name!r}: use lowercase letters, digits and underscores '
            f'(start with a letter), 2-64 chars — it becomes the frozen protocol id'
        )
    if kind not in _KINDS:
        raise ValueError(f'unknown node kind {kind!r}: expected one of {_KINDS}')

    title = title or _prefix(name)
    class_type = class_type or (['source'] if kind == 'source' else ['text'])
    lanes = lanes or _default_lanes(kind)
    description = description or ''

    files: Dict[str, str] = {
        'services.json': _services_json(name, title, kind, class_type, lanes, description),
        '__init__.py': _init_py(kind),
        'IGlobal.py': _iglobal_py(),
        'requirements.txt': '',
        'VERSION': '1.0.0\n',
        'README.md': _readme_md(name, title, kind),
        f'{name}.svg': _placeholder_svg(title),
    }
    if kind == 'source':
        files['IInstance.py'] = _iinstance_source_py()
        files['IEndpoint.py'] = _iendpoint_py(title)
    else:
        files['IInstance.py'] = _iinstance_filter_py()
    return files
