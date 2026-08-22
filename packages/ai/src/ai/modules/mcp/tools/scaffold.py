# Copyright 2026 Aparavi Software AG. MIT License.
"""Node scaffolding: emit a local node that loads on the first try.

The literals here follow the tree rather than the docs, because the documented
contract is wrong in three places:

- ``preconfig`` is marked optional in README-node-schema.md, but
  ``Config.getNodeConfig`` raises without it and nearly every ``IGlobal`` calls
  that at load, so a node without it hard-fails.
- ``depends()`` is documented as running in ``__init__.py``. The real nodes call
  it from ``IGlobal.beginGlobal``, and third-party imports must follow it.
- The "Adding a New Node" example shows a plain class with a ``process()``
  method, which nothing in the engine calls.

Two the docs omit: a ``services.json`` without ``protocol`` is not registered as
a service at all, and ``register`` must be ``filter`` or ``endpoint`` or the node
loads but can never be instantiated.
"""

import keyword
import re
from typing import Any, Dict

from ..errors import _bad
from ..tooling import ToolRegistry
from ._common import engine_call

# Handler and argument per input lane, so the skeleton compiles for the lane it
# was asked for instead of always assuming text.
_LANE_HANDLERS = {
    'text': ('writeText', 'text: str'),
    'documents': ('writeDocuments', 'documents: list'),
    'questions': ('writeQuestions', 'question'),
    'answers': ('writeAnswers', 'answer'),
    'table': ('writeTable', 'table: str'),
    'json': ('writeJson', 'data'),
    'tags': ('writeTag', 'tag'),
}

_NAME_RE = re.compile(r'^[a-z][a-z0-9_]*$')

_SERVICES_JSON = """{{
\t"title": "{title}",
\t"protocol": "{name}://",
\t"classType": ["{class_type}"],
\t"capabilities": [],
\t"register": "filter",
\t"node": "python",
\t"path": "local_nodes.{name}",
\t"prefix": "{name}",
\t"description": ["TODO: describe what this node does."],
\t"documentation": "https://docs.rocketride.org",
\t"lanes": {{
\t\t"{lane_in}": ["{lane_out}"]
\t}},
\t"preconfig": {{
\t\t"default": "default",
\t\t"profiles": {{
\t\t\t"default": {{}}
\t\t}}
\t}},
\t"fields": {{}},
\t"shape": []
}}
"""

_INIT_PY = """from .IGlobal import IGlobal
from .IInstance import IInstance

__all__ = [
    'IGlobal',
    'IInstance',
]
"""

_PARENT_INIT_PY = '# Marks local_nodes as a package so the engine can import local_nodes.<name>.\n'

_REQUIREMENTS = '# One pinned dependency per line, installed by depends() in IGlobal.beginGlobal.\n'

_IGLOBAL_PY = '''import os

from rocketlib import IGlobalBase, OPEN_MODE

from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Per-pipeline state for the {name} node."""

    def beginGlobal(self):
        """Install dependencies and resolve config once per pipeline run."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # Config mode only asks for the schema, so the driver is not needed.
            return

        from depends import depends  # type: ignore

        # depends() runs here rather than in __init__.py, and any third-party
        # import has to come after it or the first load fails.
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

    def endGlobal(self):
        """Release whatever beginGlobal acquired."""
        self.config = None
'''

_IINSTANCE_PY = '''from rocketlib import IInstanceBase

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Per-object handler for the {name} node."""

    IGlobal: IGlobal

    def {handler}(self, {arg}):
        """TODO: process the incoming {lane_in} and forward the result.

        The engine runs its own forward after this returns unless
        preventDefault() raises, so forwarding explicitly and returning normally
        delivers twice. Keep preventDefault() last if this forwards, and drop it
        entirely if this only mutates in place.
        """
        self.instance.{handler}({arg_name})
        return self.preventDefault()
'''


def _class_types(services: Dict[str, Any]) -> set:
    """Every classType in use across the catalog, so the allowed set cannot drift."""
    found = set()
    for service in (services or {}).values():
        types = service.get('classType') if isinstance(service, dict) else None
        if isinstance(types, list):
            found.update(v for v in types if isinstance(v, str))
    return found


def _lane_names(services: Dict[str, Any]) -> set:
    """Every lane name in use, on either side of a catalog lane map."""
    found = set()
    for service in (services or {}).values():
        lanes = service.get('lanes') if isinstance(service, dict) else None
        if not isinstance(lanes, dict):
            continue
        found.update(k for k in lanes if isinstance(k, str))
        for outs in lanes.values():
            if isinstance(outs, list):
                found.update(v for v in outs if isinstance(v, str))
    return found


async def _scaffold_node(client, tasks, args: Dict[str, Any]) -> dict:
    name = args.get('name')
    if not name:
        return _bad('name is required', 'pick a lowercase identifier, e.g. my_node')
    # Dispatch does not apply the tool's inputSchema, so a non-string arrives intact
    # and would reach the regex as a TypeError instead of an actionable answer.
    if not isinstance(name, str) or not _NAME_RE.match(name) or keyword.iskeyword(name):
        return _bad(
            f'name must be a lowercase Python identifier, got {name!r}',
            'the engine imports local_nodes.<name>, so it has to be importable',
        )

    lane_in = args.get('lane_in') or 'text'
    lane_out = args.get('lane_out') or lane_in
    class_type = args.get('class_type') or lane_in
    for label, value in (('lane_in', lane_in), ('lane_out', lane_out), ('class_type', class_type)):
        if not isinstance(value, str):
            return _bad(f'{label} must be a string, got {value!r}', 'call list_components for the names in use')

    if lane_in not in _LANE_HANDLERS:
        return _bad(
            f'no handler template for lane {lane_in!r}',
            f'supported lanes: {", ".join(sorted(_LANE_HANDLERS))}',
        )

    services, err = await engine_call(client.get_services(), 'scaffold_node')
    if err:
        return err

    # Validate against the live catalog so the allowed sets follow the engine
    # rather than a list here that drifts as nodes are added.
    catalog = (services or {}).get('services') or {}
    known_types = _class_types(catalog)
    if known_types and class_type not in known_types:
        return _bad(
            f'unknown class_type {class_type!r}',
            f'call list_components, or use one in service today: {", ".join(sorted(known_types))}',
        )

    known_lanes = _lane_names(catalog)
    for label, lane in (('lane_in', lane_in), ('lane_out', lane_out)):
        if known_lanes and lane not in known_lanes:
            return _bad(
                f'unknown {label} {lane!r}',
                f'lanes in service today: {", ".join(sorted(known_lanes))}',
            )

    handler, arg = _LANE_HANDLERS[lane_in]
    title = name.replace('_', ' ').title()

    files = {
        'local_nodes/__init__.py': _PARENT_INIT_PY,
        f'local_nodes/{name}/__init__.py': _INIT_PY,
        f'local_nodes/{name}/services.json': _SERVICES_JSON.format(
            title=title, name=name, class_type=class_type, lane_in=lane_in, lane_out=lane_out
        ),
        f'local_nodes/{name}/IGlobal.py': _IGLOBAL_PY.format(name=name),
        f'local_nodes/{name}/IInstance.py': _IINSTANCE_PY.format(
            name=name, handler=handler, arg=arg, arg_name=arg.split(':')[0], lane_in=lane_in
        ),
        f'local_nodes/{name}/requirements.txt': _REQUIREMENTS,
    }

    return {
        'ok': True,
        'name': name,
        'provider': name,
        'files': files,
        'next_steps': [
            'Write these files under the workspace passed as --node_path.',
            f'Reference the node in a .pipe as "provider": "{name}", since the provider is the protocol.',
            'Restart the engine: node manifests are read once at startup.',
        ],
    }


def register(registry: ToolRegistry) -> None:
    """Register the scaffolding tool against ``registry``."""
    registry.register(
        'scaffold_node',
        'Emit a local node skeleton that loads on the first try, with the manifest keys and file '
        'layout the engine actually requires. Returns files to write; it writes nothing itself.',
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Lowercase identifier, e.g. my_node'},
                'lane_in': {'type': 'string', 'description': 'Input lane the node handles; defaults to text'},
                'lane_out': {'type': 'string', 'description': 'Output lane it emits; defaults to lane_in'},
                'class_type': {'type': 'string', 'description': 'Component class; defaults to lane_in'},
            },
            'required': ['name'],
        },
    )(_scaffold_node)
