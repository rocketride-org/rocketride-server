"""Agent-catalog assertions for zero-argument MCP tools (issue #1404).

Proves, through the *real* ``agent_rocketride`` on-demand catalog builder
(``planner._build_all_tool_descriptions`` — the exact path the issue names),
that after normalization a zero-argument MCP tool appears in the catalog with a
genuine ``properties`` map, so a strict reasoning model keeps it instead of
dropping it.

The ``agent_langchain`` path is covered by code (it reads the same ``inputSchema``
key this PR now emits) plus the transport/normalization tests in
``test_zero_arg_tools.py``; it is not re-exercised here because constructing its
pydantic tool models from a dynamically-loaded module is environment-fragile.
"""

import importlib.util
import json
import os
import sys
import types

import pytest

_HERE = os.path.dirname(__file__)
_NODES = os.path.join(_HERE, '..', '..', 'src', 'nodes')
sys.path.insert(0, os.path.join(_NODES, 'tool_mcp_client'))

from mcp_schema import NOOP_ARG_NAME, normalize_tool_input_schema  # noqa: E402

_PLANNER_PY = os.path.join(_NODES, 'agent_rocketride', 'planner.py')


def _load_module(path, modname):
    """Load a node source file under a unique module name, registered in
    ``sys.modules`` before exec.
    """
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


try:
    _planner = _load_module(_PLANNER_PY, '_rr_agent_rocketride_planner_under_test')
    _IMPORT_ERR = None
except Exception as exc:  # pragma: no cover - env without engine libs
    _planner = None
    _IMPORT_ERR = exc

pytestmark = pytest.mark.skipif(_planner is None, reason=f'agent_rocketride planner not importable: {_IMPORT_ERR}')

# The schema an MCP zero-argument tool now carries after normalization.
_ZERO_ARG_SCHEMA = normalize_tool_input_schema(None)


def _catalog_for(descriptor):
    ctx = types.SimpleNamespace(tools=types.SimpleNamespace(list=[descriptor]))
    return _planner._build_all_tool_descriptions(ctx)


def test_rocketride_on_demand_catalog_lists_zero_arg_tool_with_real_property():
    """After normalization a zero-argument MCP tool appears in the on-demand
    catalog with a non-empty ``properties`` map — the exact path issue #1404
    reports.
    """
    descriptor = {
        'name': 'stub.no_schema_tool',
        'description': 'Zero-argument MCP tool',
        'inputSchema': _ZERO_ARG_SCHEMA,
    }
    catalog = _catalog_for(descriptor)
    assert 'stub.no_schema_tool' in catalog

    line = json.loads(catalog.splitlines()[0])
    props = line['inputSchema']['properties']
    assert props and NOOP_ARG_NAME in props


def test_rocketride_catalog_bare_schema_has_no_properties_pre_fix():
    """Documents the pre-fix hazard: a bare ``{'type': 'object'}`` descriptor
    serializes into the catalog with no ``properties`` — the degenerate shape
    reasoning models drop. Normalization at the MCP source is what prevents it.
    """
    bare = {'name': 'srv.tool', 'description': 'd', 'inputSchema': {'type': 'object'}}
    line = json.loads(_catalog_for(bare).splitlines()[0])
    assert not line['inputSchema'].get('properties')
