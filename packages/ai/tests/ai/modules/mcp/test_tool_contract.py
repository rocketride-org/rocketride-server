# Copyright 2026 Aparavi Software AG. MIT License.
"""The tool contract hosts rely on: annotations, reasons, upfront loading, instructions.

Every tool in ``register_all`` must declare all three annotation booleans with a
reason. A new registration fails ``test_every_tool_sets_all_three_hints_explicitly``
until it passes ``hints=`` and adds a row to ``EXPECTED_HINTS``.
"""

import pytest
from mcp.client import Client

from ai.modules.mcp import apps
from ai.modules.mcp import handlers
from ai.modules.mcp.handlers import build_mcp_server
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import register_all

from .conftest import EXPECTED_TOOL_NAMES

# (readOnlyHint, destructiveHint, openWorldHint), same table as docs/public/mcp/http/tools.md.
EXPECTED_HINTS = {
    'list_components': (True, False, False),
    'describe_component': (True, False, False),
    'resolve_config': (True, False, False),
    'validate_pipeline': (False, True, True),
    'describe_pipeline': (True, False, False),
    'run_pipeline': (False, True, True),
    'run_dropper_pipe': (False, True, True),
    'send_data': (False, True, True),
    'terminate': (False, True, False),
    'send_files': (False, True, True),
    'store_read': (True, False, False),
    'store_list': (True, False, False),
    'store_stat': (True, False, False),
    'store_get_url': (True, False, False),
    'save_template': (False, True, False),
    'load_template': (True, False, False),
    'deploy_add': (False, True, False),
    'deploy_list': (True, False, False),
    'deploy_status': (True, False, False),
    'deploy_versions': (True, False, False),
    'deploy_to_team': (False, True, False),
    'deploy_set_schedule': (False, True, False),
    'deploy_enable': (False, True, False),
    'deploy_disable': (False, True, False),
    'deploy_remove': (False, True, False),
    'monitor': (True, False, False),
    'list_running_pipelines': (True, False, False),
    'log_chapters': (True, False, False),
    'log_read': (True, False, False),
    'log_traces': (True, False, False),
    'log_trace': (True, False, False),
    'scaffold_node': (True, False, False),
    'list_integrations': (True, False, False),
}

CORE_WORKFLOW_TOOLS = {'list_components', 'describe_component', 'validate_pipeline', 'run_pipeline'}

# Claude Code's limit on what it reads upfront for one description or instructions text.
_UPFRONT_LIMIT_CHARS = 4096


@pytest.fixture
def registry():
    registry = ToolRegistry(local_engine=True)
    register_all(registry)
    return registry


def _annotation_triples(registry):
    return {
        tool.name: (
            tool.annotations.read_only_hint,
            tool.annotations.destructive_hint,
            tool.annotations.open_world_hint,
        )
        for tool in registry.tools()
    }


def test_every_tool_sets_all_three_hints_explicitly(registry):
    tools = registry.tools()

    assert {tool.name for tool in tools} == set(EXPECTED_TOOL_NAMES)
    for tool in tools:
        assert tool.annotations is not None, f'{tool.name} has no annotations'
        assert isinstance(tool.annotations.read_only_hint, bool), tool.name
        assert isinstance(tool.annotations.destructive_hint, bool), tool.name
        assert isinstance(tool.annotations.open_world_hint, bool), tool.name


def test_hints_match_the_pinned_table(registry):
    assert _annotation_triples(registry) == EXPECTED_HINTS


def test_every_tool_has_a_reason(registry):
    for name in registry.names():
        assert registry.hints(name).reason.strip(), name


def test_read_only_tools_are_never_destructive(registry):
    for name, (read_only, destructive, _open_world) in _annotation_triples(registry).items():
        assert not (read_only and destructive), name


def test_open_world_tools_are_exactly_the_execution_tools_and_validate_pipeline(registry):
    open_world = {name for name, triple in _annotation_triples(registry).items() if triple[2]}

    assert open_world == {'run_pipeline', 'run_dropper_pipe', 'send_data', 'send_files', 'validate_pipeline'}


def test_always_load_is_exactly_the_core_workflow_tools(registry):
    tools = registry.tools()

    assert {tool.name for tool in tools if (tool.meta or {}).get('anthropic/alwaysLoad') is True} == CORE_WORKFLOW_TOOLS
    assert not [tool.name for tool in tools if 'anthropic/maxResultSizeChars' in (tool.meta or {})]


def test_widget_meta_is_preserved_next_to_other_meta(registry):
    log_traces = next(tool for tool in registry.tools() if tool.name == 'log_traces')

    assert log_traces.meta['ui']['resourceUri'] == apps.TRACE_VIEWER_URI


def test_descriptions_and_instructions_fit_claude_code_upfront_limit(registry):
    for tool in registry.tools():
        assert len(tool.description) < _UPFRONT_LIMIT_CHARS, tool.name
    assert len(handlers.SERVER_INSTRUCTIONS) < _UPFRONT_LIMIT_CHARS
    assert handlers.SERVER_INSTRUCTIONS.startswith('RocketRide')


def test_server_instructions_name_every_offered_tool():
    missing = [name for name in EXPECTED_TOOL_NAMES if name not in handlers.SERVER_INSTRUCTIONS]

    assert missing == []


@pytest.mark.asyncio
@pytest.mark.parametrize(('mode', 'protocol_version'), [('auto', '2026-07-28'), ('legacy', '2025-11-25')])
async def test_server_advertises_instructions(fake_engine, mode, protocol_version):
    async with Client(build_mcp_server(lambda: fake_engine), mode=mode) as client:
        assert client.instructions == handlers.SERVER_INSTRUCTIONS
        assert client.protocol_version == protocol_version


def test_three_corrected_descriptions(registry):
    descriptions = {tool.name: tool.description for tool in registry.tools()}

    assert 'zero client-side' not in descriptions['validate_pipeline']
    assert 'single-component form' in descriptions['validate_pipeline']
    assert 'status' in descriptions['list_running_pipelines']
    assert 'not terminated' in descriptions['deploy_remove']
