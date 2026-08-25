# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the capability tools (`tools/capability.py`): `store_read`,
`store_list`, `store_stat`, `store_get_url`, `save_template`, `load_template`,
`deploy_add`, `deploy_list`, `deploy_status`, `deploy_remove`, `deploy_update`.
"""

import pytest

from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import capability
from ai.modules.mcp.tools import register_all


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
        'deploy_add',
        'deploy_list',
        'deploy_status',
        'deploy_remove',
        'deploy_update',
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
        'deploy_add',
        'deploy_list',
        'deploy_status',
        'deploy_remove',
        'deploy_update',
    ):
        assert registry.handler(name) is not None


def test_env_tools_are_gone():
    registry = ToolRegistry()
    capability.register(registry)
    names = {t.name for t in registry.tools()}
    assert 'set_env' not in names
    assert 'list_env_keys' not in names


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


# --- deploy_add -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_add_requires_pipeline(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    with pytest.raises(ValueError):
        await registry.handler('deploy_add')(fake_engine, None, {})


@pytest.mark.asyncio
async def test_deploy_add_passes_schedule_through(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'source': 'a', 'components': []}

    result = await registry.handler('deploy_add')(fake_engine, None, {'pipeline': pipeline, 'schedule': '0 0 * * *'})

    assert result == {'ok': True, 'deployment': {'project_id': 'dep-1'}}
    assert fake_engine.deploys_added == [{'pipeline': pipeline, 'schedule': '0 0 * * *'}]


@pytest.mark.asyncio
async def test_deploy_add_without_schedule_passes_none(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'source': 'a', 'components': []}

    result = await registry.handler('deploy_add')(fake_engine, None, {'pipeline': pipeline})

    assert result['ok'] is True
    assert fake_engine.deploys_added == [{'pipeline': pipeline, 'schedule': None}]


# --- deploy_list ------------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_list_returns_deployments(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_list')(fake_engine, None, {})

    assert result['ok'] is True
    assert result['deployments'] == [{'project_id': 'dep-1'}]
    assert result['count'] == 1
    assert fake_engine.deploy_list_calls == 1


# --- deploy_status -----------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_status_requires_project_id(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_status')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_deploy_status_returns_record(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_status')(fake_engine, None, {'project_id': 'dep-1'})

    assert result == {'ok': True, 'deployment': {'project_id': 'dep-1', 'state': 'active'}}
    assert fake_engine.deploy_status_calls == ['dep-1']


# --- deploy_remove -----------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_remove_requires_project_id(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_remove')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_deploy_remove_returns_removed(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_remove')(fake_engine, None, {'project_id': 'dep-1'})

    assert result == {'ok': True, 'removed': 'dep-1'}
    assert fake_engine.deploy_removed == ['dep-1']


# --- deploy_update -----------------------------------------------------------


@pytest.mark.asyncio
async def test_deploy_update_requires_project_id(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_update')(fake_engine, None, {'schedule': '0 * * * *'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


@pytest.mark.asyncio
async def test_deploy_update_requires_a_change(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_update')(fake_engine, None, {'project_id': 'dep-1'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.deploy_updated == []


@pytest.mark.asyncio
async def test_deploy_update_schedule_only(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)

    result = await registry.handler('deploy_update')(
        fake_engine, None, {'project_id': 'dep-1', 'schedule': '0 * * * *'}
    )

    assert result == {'ok': True, 'project_id': 'dep-1', 'updated': ['schedule']}
    assert fake_engine.deploy_updated == [{'project_id': 'dep-1', 'pipeline': None, 'schedule': '0 * * * *'}]


@pytest.mark.asyncio
async def test_deploy_update_inline_pipeline(fake_engine):
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'components': []}

    result = await registry.handler('deploy_update')(fake_engine, None, {'project_id': 'dep-1', 'pipeline': pipeline})

    assert result == {'ok': True, 'project_id': 'dep-1', 'updated': ['pipeline']}
    assert fake_engine.deploy_updated == [{'project_id': 'dep-1', 'pipeline': pipeline, 'schedule': None}]


@pytest.mark.asyncio
async def test_deploy_update_pipeline_and_schedule(fake_engine):
    """Both fields at once: `updated` lists them in contract order."""
    registry = ToolRegistry()
    capability.register(registry)
    pipeline = {'components': []}

    result = await registry.handler('deploy_update')(
        fake_engine, None, {'project_id': 'dep-1', 'pipeline': pipeline, 'schedule': '0 * * * *'}
    )

    assert result == {'ok': True, 'project_id': 'dep-1', 'updated': ['pipeline', 'schedule']}
    assert fake_engine.deploy_updated == [{'project_id': 'dep-1', 'pipeline': pipeline, 'schedule': '0 * * * *'}]


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
