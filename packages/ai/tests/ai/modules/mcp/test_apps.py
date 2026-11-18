# Copyright 2026 Aparavi Software AG. MIT License.
"""Contract tests for MCP Apps (embedded UI) plumbing."""

import json

import pytest
from mcp.client import Client

from ai.modules.mcp import apps
from ai.modules.mcp.tooling import ToolRegistry


def _dummy_schema():
    return {'type': 'object', 'properties': {}}


def test_registry_emits_ui_meta_only_when_linked():
    registry = ToolRegistry()

    @registry.register('plain_tool', 'no ui', _dummy_schema())
    async def _plain(client, tasks, args):
        return {}

    @registry.register('ui_tool', 'has ui', _dummy_schema(), ui_resource_uri='ui://rocketride/x.html')
    async def _ui(client, tasks, args):
        return {}

    tools = {t.name: t for t in registry.tools()}
    assert tools['plain_tool'].meta is None
    assert tools['ui_tool'].meta == {'ui': {'resourceUri': 'ui://rocketride/x.html'}}
    # The wire field must be _meta (host compatibility).
    dumped = tools['ui_tool'].model_dump(by_alias=True, exclude_none=True)
    assert dumped['_meta'] == {'ui': {'resourceUri': 'ui://rocketride/x.html'}}


@pytest.fixture
def apps_dir(tmp_path):
    (tmp_path / 'pipelines-table.html').write_text('<!doctype html><html><body>widget</body></html>', encoding='utf-8')
    (tmp_path / 'trace-viewer.html').write_text('<!doctype html><html><body>trace</body></html>', encoding='utf-8')
    return tmp_path


@pytest.mark.asyncio
async def test_ui_resource_listed_and_served(fake_engine, apps_dir):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=apps_dir)
    async with Client(server) as client:
        listed = await client.list_resources()
        uris = [str(r.uri) for r in listed.resources]
        assert apps.PIPELINES_TABLE_URI in uris
        ui_res = next(r for r in listed.resources if str(r.uri) == apps.PIPELINES_TABLE_URI)
        assert ui_res.mime_type == apps.UI_MIME_TYPE

        read = await client.read_resource(apps.PIPELINES_TABLE_URI)
        assert read.contents[0].mime_type == apps.UI_MIME_TYPE
        assert 'widget' in read.contents[0].text


@pytest.mark.asyncio
async def test_no_widget_bundle_means_no_ui_surface(fake_engine, tmp_path):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=tmp_path)
    assert apps.UI_EXTENSION_ID not in server.extensions
    async with Client(server) as client:
        listed = await client.list_resources()
        assert apps.PIPELINES_TABLE_URI not in [str(r.uri) for r in listed.resources]


def test_extension_capability_declared_when_widget_exists(fake_engine, apps_dir):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=apps_dir)
    assert server.extensions[apps.UI_EXTENSION_ID] == {'mimeTypes': [apps.UI_MIME_TYPE]}


@pytest.mark.asyncio
async def test_list_running_pipelines_links_widget(fake_engine, apps_dir):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=apps_dir)
    async with Client(server) as client:
        tools = await client.list_tools()
        tool = next(t for t in tools.tools if t.name == 'list_running_pipelines')
        assert tool.meta == {'ui': {'resourceUri': apps.PIPELINES_TABLE_URI}}


@pytest.mark.asyncio
async def test_tool_results_carry_structured_content(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.call_tool('list_running_pipelines', {})
    assert result.structured_content is not None
    assert result.structured_content['ok'] is True
    assert json.loads(result.content[0].text) == result.structured_content


@pytest.mark.asyncio
async def test_server_reports_nonempty_version(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        info = client.server_info
    assert info is not None and info.version


def _csp(*connect):
    return {'ui': {'csp': {'connectDomains': list(connect), 'resourceDomains': []}}}


def test_ui_resource_csp_stamped_when_origin_known(apps_dir, monkeypatch):
    spec = apps.AppSpec(
        uri='ui://rocketride/x.html',
        filename='pipelines-table.html',
        title='X',
        needs_engine_origin=True,
    )
    monkeypatch.setattr(apps, 'APPS', [spec])
    listed = apps.list_ui_resources(apps_dir, engine_origin='http://localhost:5565')
    assert listed[0].meta == _csp('http://localhost:5565')


def test_every_widget_declares_an_empty_csp_without_origin_or_flag(apps_dir):
    listed = apps.list_ui_resources(apps_dir)
    assert listed  # an empty list would vacuously pass the CSP check below
    assert all(r.meta == _csp() for r in listed)


@pytest.fixture
def all_apps_dir(tmp_path):
    for spec in apps.APPS:
        (tmp_path / spec.filename).write_text(
            f'<!doctype html><html><body>{spec.title}</body></html>', encoding='utf-8'
        )
    return tmp_path


@pytest.mark.asyncio
@pytest.mark.parametrize('ui_domain', [None, 'https://widgets.example.test'])
async def test_list_and_read_carry_the_same_meta(fake_engine, all_apps_dir, ui_domain):
    """Same _meta on list and read, and the dropper's CSP is the engine's bare origin.

    The domain goes only under ChatGPT's key, and only when one is set.
    """
    import ai.modules.mcp.handlers as handlers_mod

    server = handlers_mod.build_mcp_server(
        lambda: fake_engine,
        apps_dir=all_apps_dir,
        engine_origin='https://user:secret@Engine.Example.TEST:443/base/',
        ui_domain=ui_domain,
    )
    async with Client(server) as client:
        listed = {str(r.uri): r for r in (await client.list_resources()).resources}
        for spec in apps.APPS:
            content = (await client.read_resource(spec.uri)).contents[0]
            expected = _csp('https://engine.example.test') if spec.needs_engine_origin else _csp()
            if ui_domain:
                expected[apps.OPENAI_WIDGET_DOMAIN_KEY] = ui_domain
            # Hosts read the wire name, _meta, on the content item itself.
            assert content.model_dump(by_alias=True, exclude_none=True)['_meta'] == expected, spec.uri
            assert listed[spec.uri].meta == content.meta, spec.uri
            assert 'domain' not in content.meta['ui'], spec.uri  # never ui.domain: Claude rejects a foreign value


@pytest.mark.asyncio
async def test_run_dropper_pipe_links_dropper_widget(fake_engine, tmp_path):
    import ai.modules.mcp.handlers as handlers_mod

    (tmp_path / 'dropper.html').write_text('<!doctype html><html><body>d</body></html>', encoding='utf-8')
    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=tmp_path)
    async with Client(server) as client:
        tools = await client.list_tools()
        tool = next(t for t in tools.tools if t.name == 'run_dropper_pipe')
        assert tool.meta == {'ui': {'resourceUri': apps.DROPPER_URI}}
        listed = await client.list_resources()
        assert apps.DROPPER_URI in [str(r.uri) for r in listed.resources]


def test_read_ui_resource_unknown_uri_returns_none(apps_dir):
    assert apps.read_ui_resource('ui://rocketride/nope.html', apps_dir) is None


def test_read_ui_resource_missing_bundle_returns_none(tmp_path):
    assert apps.read_ui_resource(apps.PIPELINES_TABLE_URI, tmp_path) is None


@pytest.mark.asyncio
async def test_list_resources_stamps_csp_from_engine_origin_without_building_client(tmp_path):
    """`engine_origin` is threaded straight from the caller (see __init__.py's
    `_base_url_from_uri`) rather than by calling `engine_factory().base_url` --
    `list_resources` must not construct an EngineClient at all (Task 5's
    handlers.py:146 simplification).
    """
    import ai.modules.mcp.handlers as handlers_mod

    (tmp_path / 'dropper.html').write_text('<!doctype html><html><body>d</body></html>', encoding='utf-8')

    def _engine_factory_must_not_be_called():
        raise AssertionError('list_resources must not call engine_factory()')

    server = handlers_mod.build_mcp_server(
        _engine_factory_must_not_be_called, apps_dir=tmp_path, engine_origin='http://localhost:5565'
    )
    async with Client(server) as client:
        listed = await client.list_resources()
    dropper = next(r for r in listed.resources if str(r.uri) == apps.DROPPER_URI)
    assert dropper.meta == _csp('http://localhost:5565')


def test_trace_viewer_spec_registered():
    spec = next(s for s in apps.APPS if s.uri == apps.TRACE_VIEWER_URI)
    assert spec.filename == 'trace-viewer.html'
    # All data flows over the tool bridge — no engine-origin CSP needed.
    assert spec.needs_engine_origin is False


def test_pipeline_canvas_spec_registered():
    spec = next(s for s in apps.APPS if s.uri == apps.PIPELINE_CANVAS_URI)
    assert spec.filename == 'pipeline-canvas.html'
    assert spec.title == 'Pipeline canvas'
    # The drawing comes in the tool result; the widget makes no request.
    assert spec.needs_engine_origin is False


@pytest.mark.asyncio
async def test_view_pipeline_links_canvas_widget_and_canvas_is_served(fake_engine, tmp_path):
    import ai.modules.mcp.handlers as handlers_mod

    (tmp_path / 'pipeline-canvas.html').write_text('<!doctype html><html><body>c</body></html>', encoding='utf-8')
    server = handlers_mod.build_mcp_server(lambda: fake_engine, apps_dir=tmp_path)
    async with Client(server) as client:
        tools = await client.list_tools()
        tool = next(t for t in tools.tools if t.name == 'view_pipeline')
        assert tool.meta == {'ui': {'resourceUri': apps.PIPELINE_CANVAS_URI}}
        listed = await client.list_resources()
        canvas = next(r for r in listed.resources if str(r.uri) == apps.PIPELINE_CANVAS_URI)
        assert canvas.name == 'Pipeline canvas'
        # The widget makes no request: an empty CSP, like every widget without the engine origin.
        assert canvas.meta == _csp()
        read = await client.read_resource(apps.PIPELINE_CANVAS_URI)
        assert read.contents[0].mime_type == apps.UI_MIME_TYPE
        assert 'c</body>' in read.contents[0].text
        assert read.contents[0].meta == _csp()
