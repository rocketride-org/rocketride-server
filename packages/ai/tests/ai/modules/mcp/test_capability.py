# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the capability tools (`tools/capability.py`): `store_read`,
`store_list`, `store_stat`, `store_get_url`, `save_template`, `load_template`,
and the deployment tools (`deploy_add`, `deploy_list`, `deploy_status`,
`deploy_versions`, `deploy_to_team`, `deploy_set_schedule`, `deploy_enable`,
`deploy_disable`, `deploy_remove`).
"""

import asyncio

import pytest

from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import capability
from ai.modules.mcp.tools import register_all

from .conftest import FAKE_ARTIFACT, FAKE_DEPLOYMENT

DEPLOY_TOOL_NAMES = (
    'deploy_add',
    'deploy_list',
    'deploy_status',
    'deploy_versions',
    'deploy_to_team',
    'deploy_set_schedule',
    'deploy_enable',
    'deploy_disable',
    'deploy_remove',
)


# --- registration -------------------------------------------------------


def test_register_all_registers_all_capability_tools():
    registry = ToolRegistry()

    register_all(registry)

    assert {
        'store_read',
        'store_list',
        'store_stat',
        'store_get_url',
        'save_template',
        'load_template',
        *DEPLOY_TOOL_NAMES,
    } <= set(registry.names())


def test_capability_register_binds_handlers_directly():
    registry = ToolRegistry()

    capability.register(registry)

    for name in (
        'store_read',
        'store_list',
        'store_stat',
        'store_get_url',
        'save_template',
        'load_template',
        *DEPLOY_TOOL_NAMES,
    ):
        assert registry.handler(name) is not None


def test_env_tools_are_gone():
    registry = ToolRegistry()
    capability.register(registry)
    names = {t.name for t in registry.tools()}
    assert 'set_env' not in names
    assert 'list_env_keys' not in names


def test_pre_deploy_2_tools_are_gone():
    """`deploy_update` wrapped an SDK method removed with deploy-2 (#1764);
    its operations are now deploy_add + deploy_to_team / deploy_set_schedule.
    """
    registry = ToolRegistry()
    capability.register(registry)

    assert 'deploy_update' not in registry.names()


# --- store_read -------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_read_requires_path(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_read')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_store_read_returns_content(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_read')(fake_engine, None, {'path': 'foo/bar.txt'})

    assert result == {'ok': True, 'path': 'foo/bar.txt', 'content': 'file contents'}


# --- store_list --------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_list_defaults_to_root(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_list')(fake_engine, None, {})

    assert result == {'ok': True, 'path': '', 'listing': {'entries': []}}


@pytest.mark.asyncio
async def test_store_list_with_explicit_path(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_list')(fake_engine, None, {'path': 'sub/dir'})

    assert result == {'ok': True, 'path': 'sub/dir', 'listing': {'entries': []}}


# --- store_stat ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_stat_requires_path(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_stat')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_store_stat_returns_stat(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_stat')(fake_engine, None, {'path': 'a/b.txt'})

    assert result == {
        'ok': True,
        'path': 'a/b.txt',
        'stat': {'exists': True, 'type': 'file', 'size': 12, 'modified': 1700000000},
    }
    assert fake_engine.fs_stat_calls == ['a/b.txt']


# --- store_get_url -------------------------------------------------------------


@pytest.mark.asyncio
async def test_store_get_url_requires_path(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_get_url')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_store_get_url_returns_url(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_get_url')(fake_engine, None, {'path': 'a/b.txt'})

    assert result == {
        'ok': True,
        'path': 'a/b.txt',
        'url': 'https://signed.example/f?sig=abc',
        'expires_in': 3600,
    }
    assert fake_engine.fs_get_url_calls == [{'path': 'a/b.txt', 'expires_in': 3600, 'download_name': None}]


@pytest.mark.asyncio
async def test_store_get_url_forwards_expires_in_and_download_name(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('store_get_url')(
        fake_engine, None, {'path': 'a/b.txt', 'expires_in': 60, 'download_name': 'x.txt'}
    )

    assert result['ok'] is True
    assert result['url'] == 'https://signed.example/f?sig=abc'
    assert fake_engine.fs_get_url_calls == [{'path': 'a/b.txt', 'expires_in': 60, 'download_name': 'x.txt'}]


# --- save_template -----------------------------------------------------------


@pytest.mark.asyncio
async def test_save_template_requires_template_id(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('save_template')(fake_engine, None, {'pipeline': {'source': 'a'}})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.saved_templates == []


@pytest.mark.asyncio
async def test_save_template_requires_pipeline(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    with pytest.raises(ValueError):
        await registry.handler('save_template')(fake_engine, None, {'template_id': 'tmpl-1'})


@pytest.mark.asyncio
async def test_save_template_persists_pipeline(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'source': 'a', 'components': []}

    result = await registry.handler('save_template')(fake_engine, None, {'template_id': 'tmpl-1', 'pipeline': pipeline})

    assert result == {'ok': True, 'template_id': 'tmpl-1'}
    assert fake_engine.saved_templates == [{'template_id': 'tmpl-1', 'pipeline': pipeline}]


# --- load_template -------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_template_requires_template_id(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('load_template')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_load_template_returns_pipeline(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'source': 'webhook_1', 'components': [{'id': 'c1', 'type': 'ocr'}]}
    await registry.handler('save_template')(fake_engine, None, {'template_id': 'tmpl-1', 'pipeline': pipeline})

    result = await registry.handler('load_template')(fake_engine, None, {'template_id': 'tmpl-1'})

    # Regression guard: get_template round-trips the raw pipeline dict (no
    # wrapping record), so the top-level `source`/`components` must survive
    # the save -> load round-trip intact, not come back as None.
    assert result == {'ok': True, 'template_id': 'tmpl-1', 'pipeline': pipeline}
    assert result['pipeline']['source'] == 'webhook_1'
    assert result['pipeline']['components'] == [{'id': 'c1', 'type': 'ocr'}]


# --- deployments: shared ----------------------------------------------------------


def _deploy_registry():
    registry = ToolRegistry()
    capability.register(registry)
    return registry


# Every (tool, minimal valid args) pair, for the arg-validation and timeout
# contracts every deploy tool shares.
_DEPLOY_TOOL_ARGS = {
    'deploy_add': {'pipeline': {'name': 'demo', 'project_id': 'proj-1', 'components': []}},
    'deploy_list': {},
    'deploy_status': {'project_id': 'proj-1', 'team_id': 'team-1'},
    'deploy_versions': {'project_id': 'proj-1'},
    'deploy_to_team': {'project_id': 'proj-1', 'version': 3, 'team_id': 'team-1'},
    'deploy_set_schedule': {
        'project_id': 'proj-1',
        'source_id': 'webhook_1',
        'schedule': '*/15 * * * *',
        'team_id': 'team-1',
    },
    'deploy_enable': {'project_id': 'proj-1', 'team_id': 'team-1'},
    'deploy_disable': {'project_id': 'proj-1', 'team_id': 'team-1'},
    'deploy_remove': {'project_id': 'proj-1', 'team_id': 'team-1'},
}

# The required string ids per tool (deploy_add's pipeline raises instead).
_DEPLOY_REQUIRED_IDS = [
    (tool, key)
    for tool, args in _DEPLOY_TOOL_ARGS.items()
    for key in args
    if key in ('project_id', 'team_id', 'source_id', 'schedule')
]


def test_deploy_tool_schemas_require_what_the_handlers_require():
    registry = _deploy_registry()
    schemas = {tool.name: tool.input_schema for tool in registry.tools()}

    for tool, args in _DEPLOY_TOOL_ARGS.items():
        assert set(schemas[tool].get('required', [])) == set(args), tool


@pytest.mark.asyncio
@pytest.mark.parametrize(('tool', 'key'), _DEPLOY_REQUIRED_IDS)
async def test_deploy_tools_reject_a_missing_required_id(fake_engine, tool, key):
    args = {k: v for k, v in _DEPLOY_TOOL_ARGS[tool].items() if k != key}

    result = await _deploy_registry().handler(tool)(fake_engine, None, args)

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert key in result['message']
    assert fake_engine.deploy_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize('tool', list(_DEPLOY_TOOL_ARGS))
async def test_deploy_tools_return_an_in_band_timeout(fake_engine, monkeypatch, tool):
    import ai.modules.mcp.tools._common as common

    async def _wedged(*args, **kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(common, 'DEFAULT_TIMEOUT_SECONDS', 0.01)
    seam = {
        'deploy_status': 'deploy_get',
        'deploy_to_team': 'deploy_deploy',
    }.get(tool, tool)
    monkeypatch.setattr(fake_engine, seam, _wedged)

    result = await _deploy_registry().handler(tool)(fake_engine, None, dict(_DEPLOY_TOOL_ARGS[tool]))

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


# --- deploy_add -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_add_requires_pipeline(fake_engine):
    with pytest.raises(ValueError):
        await _deploy_registry().handler('deploy_add')(fake_engine, None, {})


@pytest.mark.asyncio
async def test_deploy_add_registers_a_version(fake_engine):
    pipeline = {'name': 'demo', 'project_id': 'proj-1', 'components': []}

    result = await _deploy_registry().handler('deploy_add')(fake_engine, None, {'pipeline': pipeline})

    assert result == {'ok': True, 'artifact': FAKE_ARTIFACT}
    assert fake_engine.deploy_calls == [{'op': 'add', 'pipeline': pipeline, 'comment': None, 'deploy_to': None}]


@pytest.mark.asyncio
async def test_deploy_add_unwraps_a_pipeline_wrapper(fake_engine):
    pipeline = {'name': 'demo', 'project_id': 'proj-1', 'components': []}

    await _deploy_registry().handler('deploy_add')(fake_engine, None, {'pipeline': {'pipeline': pipeline}})

    assert fake_engine.deploy_calls[0]['pipeline'] == pipeline


@pytest.mark.asyncio
async def test_deploy_add_passes_comment_and_deploy_to(fake_engine):
    pipeline = {'name': 'demo', 'project_id': 'proj-1', 'components': []}
    fake_engine.deploy_results['add'] = {'artifact': FAKE_ARTIFACT, 'deployment': FAKE_DEPLOYMENT}

    result = await _deploy_registry().handler('deploy_add')(
        fake_engine, None, {'pipeline': pipeline, 'comment': 'prompt fix', 'deploy_to': 'team-1'}
    )

    assert result == {'ok': True, 'artifact': FAKE_ARTIFACT, 'deployment': FAKE_DEPLOYMENT}
    assert fake_engine.deploy_calls == [
        {'op': 'add', 'pipeline': pipeline, 'comment': 'prompt fix', 'deploy_to': 'team-1'}
    ]


@pytest.mark.asyncio
async def test_deploy_add_timeout_warns_against_a_blind_retry(fake_engine, monkeypatch):
    import ai.modules.mcp.tools._common as common

    async def _wedged(*args, **kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(common, 'DEFAULT_TIMEOUT_SECONDS', 0.01)
    monkeypatch.setattr(fake_engine, 'deploy_add', _wedged)

    result = await _deploy_registry().handler('deploy_add')(fake_engine, None, dict(_DEPLOY_TOOL_ARGS['deploy_add']))

    assert result['error_type'] == 'Timeout'
    assert 'deploy_versions' in result['hint']


# --- deploy_list ------------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_list_unwraps_the_list_envelope(fake_engine):
    """Regression: the SDK returns {rows,total,page,pageSize}; `count` is the
    row count, never the envelope's key count.
    """
    fake_engine.deploy_results['list'] = {
        'rows': [FAKE_DEPLOYMENT, {**FAKE_DEPLOYMENT, 'teamId': 'team-2'}],
        'total': 7,
        'page': 2,
        'pageSize': 2,
    }

    result = await _deploy_registry().handler('deploy_list')(fake_engine, None, {})

    assert result == {
        'ok': True,
        'deployments': [FAKE_DEPLOYMENT, {**FAKE_DEPLOYMENT, 'teamId': 'team-2'}],
        'count': 2,
        'total': 7,
        'page': 2,
        'pageSize': 2,
    }
    assert fake_engine.deploy_calls == [
        {'op': 'list', 'team_id': None, 'page': None, 'page_size': None, 'search': None, 'filters': None, 'sort': None}
    ]


@pytest.mark.asyncio
async def test_deploy_list_passes_filters_through(fake_engine):
    args = {
        'team_id': 'team-1',
        'page': 2,
        'page_size': 10,
        'search': 'demo',
        'filters': {'state': 'enabled'},
        'sort': [{'field': 'updatedAt', 'dir': 'desc'}],
    }

    await _deploy_registry().handler('deploy_list')(fake_engine, None, args)

    assert fake_engine.deploy_calls == [{'op': 'list', **args}]


@pytest.mark.asyncio
@pytest.mark.parametrize('tool', ['deploy_list', 'deploy_versions'])
@pytest.mark.parametrize('key', ['page', 'page_size'])
async def test_deploy_list_tools_reject_bad_paging(fake_engine, tool, key):
    for bad_value in (0, -1, True, '2'):
        args = {**_DEPLOY_TOOL_ARGS[tool], key: bad_value}
        result = await _deploy_registry().handler(tool)(fake_engine, None, args)
        assert result['ok'] is False, bad_value
        assert result['error_type'] == 'BadRequest', bad_value
    assert fake_engine.deploy_calls == []


# --- deploy_status -----------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_status_gets_one_team_deployment(fake_engine):
    result = await _deploy_registry().handler('deploy_status')(
        fake_engine, None, {'project_id': 'proj-1', 'team_id': 'team-1'}
    )

    assert result == {'ok': True, 'deployment': FAKE_DEPLOYMENT}
    assert fake_engine.deploy_calls == [{'op': 'get', 'project_id': 'proj-1', 'team_id': 'team-1'}]


# --- deploy_versions ---------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_versions_unwraps_the_list_envelope(fake_engine):
    result = await _deploy_registry().handler('deploy_versions')(
        fake_engine, None, {'project_id': 'proj-1', 'page': 1, 'page_size': 20}
    )

    assert result == {
        'ok': True,
        'project_id': 'proj-1',
        'versions': [FAKE_ARTIFACT, {'version': 2}],
        'count': 2,
        'total': 2,
        'page': 1,
        'pageSize': 50,
    }
    assert fake_engine.deploy_calls == [{'op': 'versions', 'project_id': 'proj-1', 'page': 1, 'page_size': 20}]


# --- deploy_to_team ----------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_to_team_points_the_team_at_a_version(fake_engine):
    result = await _deploy_registry().handler('deploy_to_team')(
        fake_engine, None, {'project_id': 'proj-1', 'version': 3, 'team_id': 'team-1'}
    )

    assert result == {'ok': True, 'deployment': FAKE_DEPLOYMENT}
    assert fake_engine.deploy_calls == [{'op': 'deploy', 'project_id': 'proj-1', 'version': 3, 'team_id': 'team-1'}]


@pytest.mark.asyncio
async def test_deploy_to_team_requires_an_integer_version(fake_engine):
    for bad_value in (None, 0, '3', 3.0, True):
        args = {'project_id': 'proj-1', 'team_id': 'team-1'}
        if bad_value is not None:
            args['version'] = bad_value
        result = await _deploy_registry().handler('deploy_to_team')(fake_engine, None, args)
        assert result['ok'] is False, bad_value
        assert result['error_type'] == 'BadRequest', bad_value
        assert 'version' in result['message'], bad_value
    assert fake_engine.deploy_calls == []


# --- deploy_set_schedule -----------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_set_schedule_sets_one_source_schedule(fake_engine):
    args = {'project_id': 'proj-1', 'source_id': 'webhook_1', 'schedule': '*/15 * * * *', 'team_id': 'team-1'}

    result = await _deploy_registry().handler('deploy_set_schedule')(fake_engine, None, args)

    assert result == {'ok': True, 'deployment': FAKE_DEPLOYMENT}
    assert fake_engine.deploy_calls == [{'op': 'set_schedule', **args, 'ttl': None}]


@pytest.mark.asyncio
async def test_deploy_set_schedule_passes_ttl(fake_engine):
    args = {'project_id': 'proj-1', 'source_id': 'webhook_1', 'schedule': 'manual', 'team_id': 'team-1', 'ttl': 600}

    await _deploy_registry().handler('deploy_set_schedule')(fake_engine, None, args)

    assert fake_engine.deploy_calls == [{'op': 'set_schedule', **args}]


@pytest.mark.asyncio
async def test_deploy_set_schedule_rejects_a_bad_ttl(fake_engine):
    for bad_value in (0, -5, True, '60'):
        args = {**_DEPLOY_TOOL_ARGS['deploy_set_schedule'], 'ttl': bad_value}
        result = await _deploy_registry().handler('deploy_set_schedule')(fake_engine, None, args)
        assert result['ok'] is False, bad_value
        assert result['error_type'] == 'BadRequest', bad_value
    assert fake_engine.deploy_calls == []


# --- deploy_enable / deploy_disable / deploy_remove --------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('tool', 'op', 'state'),
    [
        ('deploy_enable', 'enable', 'enabled'),
        ('deploy_disable', 'disable', 'disabled'),
        ('deploy_remove', 'remove', 'removed'),
    ],
)
async def test_deploy_state_tools_return_the_updated_record(fake_engine, tool, op, state):
    result = await _deploy_registry().handler(tool)(fake_engine, None, {'project_id': 'proj-1', 'team_id': 'team-1'})

    assert result['ok'] is True
    assert result['deployment']['state'] == state
    assert fake_engine.deploy_calls == [{'op': op, 'project_id': 'proj-1', 'team_id': 'team-1'}]


@pytest.mark.asyncio
async def test_store_get_url_rejects_invalid_expires_in(fake_engine):
    """Zero, negative, boolean, and string expires_in all return BadRequest
    without reaching the engine seam.
    """
    registry = ToolRegistry()
    capability.register(registry)

    for bad_value in (0, -5, True, '60'):
        result = await registry.handler('store_get_url')(fake_engine, None, {'path': 'f.txt', 'expires_in': bad_value})
        assert result['ok'] is False, bad_value
        assert result['error_type'] == 'BadRequest', bad_value
    assert fake_engine.fs_get_url_calls == []
