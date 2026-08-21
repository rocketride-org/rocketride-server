# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the node scaffolding tool (`tools/scaffold.py`).

The tool exists because the documented node contract is wrong in several
places, so these assert the emitted skeleton against the engine's real
requirements rather than against the docs.
"""

import ast
import json

import pytest

from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import scaffold


def _registry():
    registry = ToolRegistry()
    scaffold.register(registry)
    return registry


async def _scaffold(fake_engine, **args):
    args.setdefault('name', 'my_node')
    return await _registry().handler('scaffold_node')(fake_engine, None, args)


@pytest.fixture
def catalog_engine(fake_engine):
    """A fake engine whose catalog covers the lanes and class types these tests use."""
    fake_engine._services = {
        'services': {
            'question': {'classType': ['text'], 'lanes': {'text': ['questions']}},
            'ocr': {'classType': ['image'], 'lanes': {'image': ['text', 'documents']}},
            'ner': {'classType': ['documents'], 'lanes': {'documents': ['documents']}},
        }
    }
    return fake_engine


@pytest.mark.asyncio
async def test_every_generated_python_file_compiles(catalog_engine):
    """A skeleton that does not import is worse than no skeleton."""
    result = await _scaffold(catalog_engine)

    py = {p: c for p, c in result['files'].items() if p.endswith('.py')}
    assert len(py) == 4, f'expected the parent init, the node init, IGlobal and IInstance, got {sorted(py)}'
    for path, content in py.items():
        ast.parse(content)  # raises SyntaxError if the template is malformed


@pytest.mark.asyncio
async def test_manifest_carries_the_keys_the_engine_actually_requires(catalog_engine):
    """
    The four traps that stop a node loading, none of them stated correctly in the docs.

    preconfig is documented optional but Config.getNodeConfig raises without it;
    a manifest without protocol is never registered as a service; register must
    name a factory type; and the import path is local_nodes.<name>.
    """
    result = await _scaffold(catalog_engine, name='my_node')

    manifest = json.loads(result['files']['local_nodes/my_node/services.json'])

    assert manifest['protocol'] == 'my_node://'
    assert manifest['register'] == 'filter'
    assert manifest['path'] == 'local_nodes.my_node'
    assert 'preconfig' in manifest, 'documented optional, but getNodeConfig raises without it'
    assert manifest['preconfig']['default'] in manifest['preconfig']['profiles'], (
        'the default profile must name a profile that exists, or resolution raises at load'
    )


@pytest.mark.asyncio
async def test_the_provider_is_the_protocol(catalog_engine):
    """Naming a component by its title instead of its protocol is the issue's own example."""
    result = await _scaffold(catalog_engine, name='my_node')

    assert result['provider'] == 'my_node'
    assert any('provider is the protocol' in step for step in result['next_steps'])


@pytest.mark.asyncio
async def test_the_parent_package_marker_is_included(catalog_engine):
    """The engine imports local_nodes.<name>, so the parent needs to be a package."""
    result = await _scaffold(catalog_engine)

    assert 'local_nodes/__init__.py' in result['files']


@pytest.mark.asyncio
async def test_depends_is_called_from_iglobal_not_init(catalog_engine):
    """README-nodes.md puts depends() in __init__.py and contradicts itself later."""
    result = await _scaffold(catalog_engine, name='my_node')

    assert 'depends(' in result['files']['local_nodes/my_node/IGlobal.py']
    assert 'depends(' not in result['files']['local_nodes/my_node/__init__.py']


@pytest.mark.asyncio
async def test_the_handler_matches_the_requested_lane(catalog_engine):
    """A text skeleton for a documents node would not run."""
    result = await _scaffold(catalog_engine, name='doc_node', lane_in='documents', lane_out='documents')

    instance = result['files']['local_nodes/doc_node/IInstance.py']
    assert 'def writeDocuments(self, documents: list):' in instance
    assert 'self.instance.writeDocuments(documents)' in instance


@pytest.mark.asyncio
async def test_class_type_is_checked_against_the_live_catalog(catalog_engine):
    """The allowed set follows the engine, so it cannot drift as nodes are added."""
    result = await _scaffold(catalog_engine, class_type='not_a_class')

    assert result['ok'] is False
    assert 'not_a_class' in result['message']
    assert 'text' in result['hint'], 'the hint should name what is actually available'


@pytest.mark.asyncio
async def test_a_name_that_is_not_importable_is_rejected(catalog_engine):
    """The engine imports local_nodes.<name>, so a bad name fails at load, not here."""
    for bad in ('My-Node', '9lives', 'class', 'my node'):
        result = await _scaffold(catalog_engine, name=bad)
        assert result['ok'] is False, f'{bad!r} should be rejected'


@pytest.mark.asyncio
async def test_an_unsupported_lane_is_refused_rather_than_guessed(catalog_engine):
    """Emitting a handler for a lane with no template would produce a node that cannot run."""
    result = await _scaffold(catalog_engine, lane_in='audio')

    assert result['ok'] is False
    assert 'audio' in result['message']


@pytest.mark.asyncio
async def test_the_tool_writes_nothing_itself(catalog_engine):
    """Files come back for the caller to write, matching load_pipeline's stance on reads."""
    result = await _scaffold(catalog_engine)

    assert isinstance(result['files'], dict)
    assert all(isinstance(c, str) for c in result['files'].values())
