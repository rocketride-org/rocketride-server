# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for `view_pipeline` (tools/canvas.py): paths, workspace, limits, and secrets.

The workspace cases mirror the builder's rule in
apps/rocket-ui/src/surfaces/workspace/vfs/workspace.ts (resolveWorkspaceScope
and toStorePath): a short `.projects/...` path is read from the development
team's shared files when the sign-in has a valid development team.
"""

import json

import pytest
from mcp.client import Client

from ai.modules.mcp import apps
from ai.modules.mcp.tools import canvas

from .conftest import FakeEngineClient

TEAM_ROOT = '@/Team/=team_A/.projects'

# Canary values that must never leave the server.
CANARY_LITERAL = 'sk-canary-literal-7f3a9b'
CANARY_REFERENCE = '${ROCKETRIDE_CANARY_KEY}'
CANARY_TOKEN = 'canary-secure-parameters-token'
CANARY_NESTED = 'pg-canary-nested-password'
CANARY_PROFILE = 'canary-profile-bearer-91c2'
CANARIES = (CANARY_LITERAL, CANARY_REFERENCE, CANARY_TOKEN, CANARY_NESTED, CANARY_PROFILE, 'ROCKETRIDE_CANARY_KEY')

CATALOG = {
    'services': {
        'webhook': {
            'title': 'Webhook',
            'classType': ['source'],
            'lanes': {'_source': ['tags']},
            'invoke': {},
            'capabilities': 0,
            'icon': 'webhook.svg',
            'description': 'Receives HTTP requests',
            'Pipe': {'schema': {'properties': {'apikey': {'type': 'string'}}}},
        },
        'llm_openai': {
            'title': 'OpenAI',
            'classType': ['llm'],
            'lanes': {'questions': ['answers']},
            'capabilities': 1024,
            'icon': 'openai.svg',
        },
        'db_postgres': {'title': 'PostgreSQL', 'lanes': {'tags': []}, 'icon': 'postgres.svg'},
    },
    'icons': {
        'webhook.svg': '<svg id="webhook"/>',
        'openai.svg': '<svg id="openai"/>',
        'postgres.svg': '<svg id="postgres"/>',
        'unused.svg': '<svg id="unused"/>',
    },
    'version': 3,
}


class StoreEngine(FakeEngineClient):
    """A fake engine with a small file store and an access rule like the real one.

    Paths under a prefix in ``denied`` raise the store's uniform refusal, the
    same text `account/file_store.py` uses for a team the caller is not in.
    """

    def __init__(self, files=None, *, workspace_root='.projects', denied=(), catalog=None, stat_sizes=None):
        super().__init__(services=catalog if catalog is not None else CATALOG, workspace_root=workspace_root)
        self.files = dict(files or {})
        self.denied = tuple(denied)
        self.stat_sizes = dict(stat_sizes or {})
        self.read_paths = []

    def _check(self, path):
        if path.startswith(self.denied) and self.denied:
            raise RuntimeError('Access denied for scoped path')

    async def fs_stat(self, path):
        self.fs_stat_calls.append(path)
        self._check(path)
        if path.endswith('/dir.pipe'):
            return {'exists': True, 'type': 'dir'}
        if path not in self.files:
            return {'exists': False}
        size = self.stat_sizes.get(path, len(self.files[path].encode('utf-8')))
        return {'exists': True, 'type': 'file', 'size': size, 'modified': 1700000000}

    async def fs_read_string(self, path):
        self.read_paths.append(path)
        self._check(path)
        return self.files[path]


def _pipe(components, **extra):
    return json.dumps({'components': components, **extra})


def _simple_components():
    return [
        {'id': 'webhook_1', 'provider': 'webhook', 'ui': {'position': {'x': 0, 'y': 0}}},
        {
            'id': 'llm_1',
            'provider': 'llm_openai',
            'name': 'Answerer',
            'input': [{'lane': 'questions', 'from': 'webhook_1'}],
        },
        {'id': 'db_1', 'provider': 'db_postgres', 'input': [{'lane': 'tags', 'from': 'webhook_1'}]},
    ]


async def _call(engine, args):
    return await canvas._view_pipeline(engine, None, args)


# -- path rules ------------------------------------------------------------


@pytest.mark.parametrize(
    'path',
    [
        None,
        '',
        42,
        'invoices.pipe',
        '/.projects/invoices.pipe',
        '.projects/../secrets.pipe',
        '.projects/a/../../b.pipe',
        '.projects\\invoices.pipe',
        '.projects/invoices.json',
        '.projects/invoices.txt',
        '.projects/invoices',
        '.projects/.pipe',
        '.projects/',
        '.projects//x.pipe',
        '.templates/t.pipe',
        'users/someone/files/.projects/x.pipe',
        '@/Team/=team_A/other/x.pipe',
        '@/Team/=../x/.projects/x.pipe',
        '@/Team/team_A/.projects/x.pipe',
        '@/Org/=org_1/.projects/x.pipe',
        '.projects/new\nline.pipe',
    ],
)
async def test_invalid_paths_are_refused_before_any_read(path):
    engine = StoreEngine()

    result = await _call(engine, {'path': path})

    assert result['ok'] is False
    assert result['error_type'] == 'InvalidPath'
    assert result['message'] == 'view_pipeline only opens pipeline files (.pipe or .pipe.json) under .projects.'
    assert result['hint'] == 'Call store_list with path .projects to find one.'
    assert result['workspace'] == '.projects'
    assert engine.fs_stat_calls == [] and engine.read_paths == []


@pytest.mark.parametrize(
    'path',
    [
        '.projects/invoices.pipe',
        '.projects/team/sub/invoices.pipe.json',
        '.projects/my..notes.pipe',
        '@/Team/=team_A/.projects/x.pipe',
    ],
)
def test_valid_paths(path):
    assert canvas.is_valid_path(path)


# -- workspace -------------------------------------------------------------


async def test_private_workspace_reads_the_short_path_as_given():
    engine = StoreEngine({'.projects/invoices.pipe': _pipe(_simple_components())})

    result = await _call(engine, {'path': '.projects/invoices.pipe'})

    assert result['ok'] is True
    assert result['path'] == '.projects/invoices.pipe'
    assert result['workspace'] == '.projects'
    assert engine.read_paths == ['.projects/invoices.pipe']


async def test_team_workspace_reads_the_short_path_from_the_team_root():
    # The builder writes `@/Team/=<id>/.projects/<name>.pipe` (workspace.ts toStorePath).
    engine = StoreEngine({f'{TEAM_ROOT}/invoices.pipe': _pipe(_simple_components())}, workspace_root=TEAM_ROOT)

    result = await _call(engine, {'path': '.projects/invoices.pipe'})

    assert result['ok'] is True
    assert result['path'] == f'{TEAM_ROOT}/invoices.pipe'
    assert result['workspace'] == TEAM_ROOT
    assert engine.read_paths == [f'{TEAM_ROOT}/invoices.pipe']


async def test_a_full_team_path_is_used_as_given():
    other = '@/Team/=team_B/.projects/shared.pipe'
    engine = StoreEngine({other: _pipe(_simple_components())}, workspace_root=TEAM_ROOT)

    result = await _call(engine, {'path': other})

    assert result['ok'] is True
    assert result['path'] == other
    assert result['workspace'] == TEAM_ROOT
    assert engine.read_paths == [other]


async def test_a_store_refusal_is_access_denied_and_leaks_nothing():
    other = '@/Team/=team_B/.projects/secret.pipe'
    engine = StoreEngine(
        {other: _pipe([{'id': 'n1', 'provider': 'webhook', 'name': 'Team B private node'}])},
        workspace_root=TEAM_ROOT,
        denied=('@/Team/=team_B/',),
    )

    result = await _call(engine, {'path': other})

    assert result == {
        'ok': False,
        'error_type': 'AccessDenied',
        'message': f"You don't have access to the pipeline at {other}.",
        'hint': f'Call store_list with path {TEAM_ROOT} to see the pipelines you can open.',
        'path': other,
        'workspace': TEAM_ROOT,
    }
    assert engine.read_paths == []


async def test_a_refusal_on_read_is_access_denied_too():
    class DenyRead(StoreEngine):
        async def fs_read_string(self, path):
            raise PermissionError('Access denied for scoped path')

    engine = DenyRead({'.projects/x.pipe': _pipe([])})

    result = await _call(engine, {'path': '.projects/x.pipe'})

    assert result['error_type'] == 'AccessDenied'


async def test_any_other_store_failure_is_not_reported_as_access_denied():
    class Broken(StoreEngine):
        async def fs_stat(self, path):
            raise RuntimeError('storage backend unavailable')

    with pytest.raises(RuntimeError, match='storage backend unavailable'):
        await _call(Broken(), {'path': '.projects/x.pipe'})


# -- not found, size, format ------------------------------------------------


@pytest.mark.parametrize('path', ['.projects/missing.pipe', '.projects/dir.pipe'])
async def test_missing_file_or_directory_is_not_found(path):
    engine = StoreEngine(workspace_root=TEAM_ROOT)

    result = await _call(engine, {'path': path})

    resolved = f'{TEAM_ROOT}/{path[len(".projects/") :]}'
    assert result['error_type'] == 'NotFound'
    assert result['message'] == f'No pipeline file at {resolved}.'
    assert result['hint'] == f'Call store_list with path {TEAM_ROOT} to see the saved pipelines.'
    assert result['path'] == resolved and result['workspace'] == TEAM_ROOT
    assert engine.read_paths == []


async def test_a_file_over_the_limit_is_refused_before_it_is_read():
    engine = StoreEngine({'.projects/big.pipe': '{}'}, stat_sizes={'.projects/big.pipe': 2_097_153})

    result = await _call(engine, {'path': '.projects/big.pipe'})

    assert result['error_type'] == 'PipelineTooLarge'
    assert result['message'] == 'This pipeline file is too large to show (2,097,153 bytes, the limit is 2,097,152).'
    assert result['hint'] is None
    assert result['size'] == 2_097_153
    assert engine.read_paths == []


async def test_a_file_at_the_limit_is_read():
    body = _pipe([])
    body = body + ' ' * (canvas.MAX_FILE_BYTES - len(body))
    engine = StoreEngine({'.projects/edge.pipe': body})

    result = await _call(engine, {'path': '.projects/edge.pipe'})

    assert result['ok'] is True


async def test_a_file_that_grew_past_the_limit_after_the_stat_is_refused():
    engine = StoreEngine(
        {'.projects/grew.pipe': ' ' * (canvas.MAX_FILE_BYTES + 1)}, stat_sizes={'.projects/grew.pipe': 10}
    )

    result = await _call(engine, {'path': '.projects/grew.pipe'})

    assert result['error_type'] == 'PipelineTooLarge'


@pytest.mark.parametrize(
    'body', ['not json', '[1, 2]', '{"name": "no components"}', '{"components": {"a": 1}}', '"text"', '{"pipeline": 5}']
)
async def test_a_file_that_is_not_a_pipeline_is_invalid(body):
    engine = StoreEngine({'.projects/x.pipe': body})

    result = await _call(engine, {'path': '.projects/x.pipe'})

    assert result['error_type'] == 'InvalidPipeline'
    assert result['message'] == 'The file at .projects/x.pipe is not a pipeline.'
    assert result['hint'] is None
    assert result['workspace'] == '.projects'


async def test_the_pipeline_envelope_form_is_accepted():
    engine = StoreEngine(
        {'.projects/x.pipe.json': json.dumps({'pipeline': {'name': 'Wrapped', 'components': _simple_components()}})}
    )

    result = await _call(engine, {'path': '.projects/x.pipe.json'})

    assert result['ok'] is True
    assert result['name'] == 'Wrapped'
    assert result['node_count'] == 3


async def test_an_empty_pipeline_is_ok_with_no_nodes():
    engine = StoreEngine({'.projects/empty.pipe': _pipe([])})

    result = await _call(engine, {'path': '.projects/empty.pipe'})

    assert result['ok'] is True
    assert result['nodes'] == [] and result['node_count'] == 0 and result['truncated'] is False
    assert result['name'] == 'empty'


# -- result shape ------------------------------------------------------------


async def test_summary_and_widget_payload():
    engine = StoreEngine({'.projects/invoices.pipe': _pipe(_simple_components(), name='Invoices')})

    result = await _call(engine, {'path': '.projects/invoices.pipe'})

    assert result['name'] == 'Invoices'
    assert result['description'] == ''
    assert result['nodes'] == [
        {'id': 'webhook_1', 'provider': 'webhook', 'title': 'Webhook'},
        {'id': 'llm_1', 'provider': 'llm_openai', 'title': 'Answerer'},
        {'id': 'db_1', 'provider': 'db_postgres', 'title': 'PostgreSQL'},
    ]
    assert result['connections'] == [
        {'from': 'webhook_1', 'to': 'llm_1', 'lane': 'questions'},
        {'from': 'webhook_1', 'to': 'db_1', 'lane': 'tags'},
    ]
    payload = result['_meta'][canvas.CANVAS_META_KEY]
    assert payload['pipeline']['components'][0] == {
        'id': 'webhook_1',
        'provider': 'webhook',
        'config': {},
        'ui': {'position': {'x': 0, 'y': 0}},
    }
    # Only the display fields, and only the icons in use.
    assert payload['services']['webhook'] == {
        'title': 'Webhook',
        'classType': ['source'],
        'lanes': {'_source': ['tags']},
        'invoke': {},
        'capabilities': 0,
        'icon': 'webhook.svg',
    }
    assert set(payload['services']) == {'webhook', 'llm_openai', 'db_postgres'}
    assert set(payload['icons']) == {'webhook.svg', 'openai.svg', 'postgres.svg'}
    assert engine.get_services_calls == 1


async def test_control_connections_are_listed():
    components = [
        {'id': 'agent_1', 'provider': 'agent'},
        {'id': 'llm_1', 'provider': 'llm_openai', 'control': [{'classType': 'llm', 'from': 'agent_1'}]},
    ]
    engine = StoreEngine({'.projects/a.pipe': _pipe(components)})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    assert result['connections'] == [{'from': 'agent_1', 'to': 'llm_1', 'control': 'llm'}]


async def test_a_provider_missing_from_the_catalog_is_drawn_with_its_name():
    components = [
        {'id': 'x_1', 'provider': 'retired_node'},
        {'id': 'llm_1', 'provider': 'llm_openai', 'input': [{'lane': 'questions', 'from': 'x_1'}]},
    ]
    engine = StoreEngine({'.projects/a.pipe': _pipe(components)})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    assert result['ok'] is True
    assert result['nodes'][0] == {'id': 'x_1', 'provider': 'retired_node', 'title': 'retired_node'}
    payload = result['_meta'][canvas.CANVAS_META_KEY]
    assert 'retired_node' not in payload['services']
    assert payload['pipeline']['components'][0]['provider'] == 'retired_node'


async def test_more_than_200_nodes_are_truncated_without_dangling_connections():
    components = [
        {'id': f'n{i}', 'provider': 'webhook', **({'input': [{'lane': 'tags', 'from': f'n{i - 1}'}]} if i else {})}
        for i in range(250)
    ]
    components[10]['input'].append({'lane': 'tags', 'from': 'n240'})
    engine = StoreEngine({'.projects/big.pipe': _pipe(components)})

    result = await _call(engine, {'path': '.projects/big.pipe'})

    assert result['node_count'] == 250
    assert result['truncated'] is True
    assert len(result['nodes']) == 200
    kept = {node['id'] for node in result['nodes']}
    assert all(c['from'] in kept and c['to'] in kept for c in result['connections'])
    drawn = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components']
    assert len(drawn) == 200
    assert all(entry['from'] in kept for c in drawn for entry in c.get('input', []))


async def test_text_is_clipped():
    components = [
        {'id': 'n1', 'provider': 'webhook', 'name': 'N' * 500, 'description': 'D' * 5000},
        {'id': 'note', 'provider': 'annotation', 'ui': {'nodeType': 'annotation'}, 'config': {'content': 'C' * 30000}},
    ]
    engine = StoreEngine({'.projects/a.pipe': _pipe(components, name='P' * 500, description='Q' * 5000)})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    drawn = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components']
    assert len(drawn[0]['name']) == 200 and len(drawn[0]['description']) == 2000
    assert len(drawn[1]['config']['content']) == 20000
    assert len(result['name']) == 200 and len(result['description']) == 2000


async def test_an_annotation_keeps_only_its_text_and_safe_colours():
    components = [
        {
            'id': 'note',
            'provider': 'annotation',
            'ui': {'nodeType': 'annotation', 'position': {'x': 5, 'y': 6}, 'formDataValid': True},
            'config': {
                'content': '# Read me',
                'bgColor': 'var(--rr-annotation-bg-default)',
                'fgColor': 'url(https://example.test/x.png)',
                'extra': 'dropped',
            },
        },
    ]
    engine = StoreEngine({'.projects/a.pipe': _pipe(components)})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    note = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components'][0]
    assert note['config'] == {'content': '# Read me', 'bgColor': 'var(--rr-annotation-bg-default)'}
    assert note['ui'] == {'nodeType': 'annotation', 'position': {'x': 5, 'y': 6}}


async def test_a_node_drawn_as_a_note_keeps_no_settings_unless_it_is_the_note_provider():
    # Another provider cannot pass its settings off as a note, at the top or inside a group.
    fake = {
        'id': 'n',
        'provider': 'llm_openai',
        'ui': {'nodeType': 'annotation'},
        'config': {'content': '${ROCKETRIDE_REVIEW_KEY}', 'bgColor': '#ffffff'},
    }
    group = {
        'id': 'g',
        'provider': 'group',
        'ui': {'nodeType': 'group'},
        'config': {'pipeline': {'components': [dict(fake, id='inner')]}},
    }
    engine = StoreEngine({'.projects/a.pipe': _pipe([fake, group])})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    components = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components']
    assert components[0]['config'] == {}
    assert components[1]['config']['pipeline']['components'][0]['config'] == {}
    assert 'ROCKETRIDE_REVIEW_KEY' not in json.dumps(result)


@pytest.mark.parametrize(
    'color, kept',
    [
        ('#1a2b3c', True),
        ('#fff', True),
        ('var(--rr-annotation-bg-default)', True),
        ('canaryapikey', False),
        ('red', False),
        ('rgb(1, 2, 3)', False),
        ('var(--other-token)', False),
        ('url(https://example.test/x.png)', False),
    ],
)
async def test_a_note_colour_is_a_hex_value_or_a_builder_token(color, kept):
    note = {
        'id': 'note',
        'provider': 'annotation',
        'ui': {'nodeType': 'annotation'},
        'config': {'content': 'Hi', 'bgColor': color},
    }
    engine = StoreEngine({'.projects/a.pipe': _pipe([note])})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    config = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components'][0]['config']
    assert ('bgColor' in config) is kept


async def test_ui_keeps_only_drawing_fields_with_numeric_points():
    components = [
        {
            'id': 'n1',
            'provider': 'webhook',
            'ui': {
                'position': {'x': '1', 'y': 2},
                'measured': {'width': 150, 'height': 40},
                'nodeType': 'script',
                'parentId': 'g',
                'secret': CANARY_LITERAL,
            },
        },
    ]
    engine = StoreEngine({'.projects/a.pipe': _pipe(components)})

    result = await _call(engine, {'path': '.projects/a.pipe'})

    drawn = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components'][0]
    assert drawn['ui'] == {'measured': {'width': 150, 'height': 40}, 'parentId': 'g'}


async def test_groups_keep_cleaned_children_to_a_depth_of_8_and_count_the_rest():
    def nest(depth):
        child = {'id': f'leaf{depth}', 'provider': 'webhook', 'config': {'apikey': CANARY_LITERAL}}
        if depth == 0:
            return child
        return {
            'id': f'g{depth}',
            'provider': 'group',
            'ui': {'nodeType': 'group'},
            'config': {'apikey': CANARY_LITERAL, 'pipeline': {'components': [nest(depth - 1)]}},
        }

    engine = StoreEngine({'.projects/g.pipe': _pipe([nest(10)])})

    result = await _call(engine, {'path': '.projects/g.pipe'})

    depth = 0
    node = result['_meta'][canvas.CANVAS_META_KEY]['pipeline']['components'][0]
    while node.get('config', {}).get('pipeline'):
        assert set(node['config']) == {'pipeline'}
        node = node['config']['pipeline']['components'][0]
        depth += 1
    assert depth == canvas.MAX_GROUP_DEPTH
    assert node['config'] == {}
    # Eleven nodes in the file: the two below the depth limit are counted, not drawn.
    assert len(result['nodes']) == 9
    assert result['node_count'] == 11
    assert result['truncated'] is True
    assert CANARY_LITERAL not in json.dumps(result)


# -- secrets -----------------------------------------------------------------


def _canary_pipeline():
    return {
        'name': 'Canary',
        'components': [
            {
                'id': 'llm_1',
                'provider': 'llm_openai',
                'config': {
                    'profile': 'custom',
                    'apikey': CANARY_LITERAL,
                    'custom': {'apikey': CANARY_REFERENCE, 'headers': [{'Authorization': f'Bearer {CANARY_PROFILE}'}]},
                    'parameters': {'secureParameters': {'secure': ['apikey'], 'token': CANARY_TOKEN}},
                },
                'ui': {'position': {'x': 0, 'y': 0}, 'formDataValid': True, 'config': {'apikey': CANARY_LITERAL}},
            },
            {
                'id': 'group_1',
                'provider': 'group',
                'ui': {'nodeType': 'group', 'position': {'x': 300, 'y': 0}},
                'config': {
                    'password': CANARY_NESTED,
                    'pipeline': {
                        'components': [
                            {
                                'id': 'db_1',
                                'provider': 'db_postgres',
                                'config': {
                                    'password': CANARY_NESTED,
                                    'secureParameters': {'secure': ['password'], 'token': CANARY_TOKEN},
                                },
                                'input': [{'lane': 'tags', 'from': 'llm_1', 'note': CANARY_LITERAL}],
                                'ui': {'parentId': 'group_1', 'position': {'x': 10, 'y': 10}},
                            }
                        ]
                    },
                },
            },
            {
                'id': 'note',
                'provider': 'annotation',
                'ui': {'nodeType': 'annotation'},
                'config': {'content': 'A plain note', 'token': CANARY_TOKEN},
            },
        ],
    }


async def test_no_secret_reaches_the_model_or_the_widget_over_the_wire(tmp_path):
    import ai.modules.mcp.handlers as handlers_mod

    engine = StoreEngine({'.projects/canary.pipe': json.dumps(_canary_pipeline())})
    (tmp_path / 'pipeline-canvas.html').write_text('<!doctype html><html><body>c</body></html>', encoding='utf-8')
    server = handlers_mod.build_mcp_server(lambda: engine, apps_dir=tmp_path)
    async with Client(server) as client:
        result = await client.call_tool('view_pipeline', {'path': '.projects/canary.pipe'})

    wire = json.dumps(result.model_dump(by_alias=True, mode='json'))
    for canary in CANARIES:
        assert canary not in wire, canary
    assert result.is_error is False
    # The drawing is all there: three top-level nodes and the nested database.
    payload = result.meta[canvas.CANVAS_META_KEY]
    assert [c['id'] for c in payload['pipeline']['components']] == ['llm_1', 'group_1', 'note']
    nested = payload['pipeline']['components'][1]['config']['pipeline']['components'][0]
    assert nested == {
        'id': 'db_1',
        'provider': 'db_postgres',
        'config': {},
        'input': [{'lane': 'tags', 'from': 'llm_1'}],
        'ui': {'position': {'x': 10, 'y': 10}, 'parentId': 'group_1'},
    }
    # The model reads the summary only: no `_meta` in its text or structured copy.
    assert '_meta' not in json.loads(result.content[0].text)
    assert '_meta' not in result.structured_content
    assert result.structured_content['node_count'] == 4


async def test_view_pipeline_is_a_read_only_tool_linked_to_the_canvas():
    from ai.modules.mcp.tooling import ToolRegistry

    registry = ToolRegistry()
    canvas.register(registry)
    (tool,) = registry.tools()

    assert tool.name == 'view_pipeline'
    assert tool.input_schema['required'] == ['path']
    assert tool.meta == {'ui': {'resourceUri': apps.PIPELINE_CANVAS_URI}}
    assert (tool.annotations.read_only_hint, tool.annotations.destructive_hint, tool.annotations.open_world_hint) == (
        True,
        False,
        False,
    )
