# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The node branch of ``rrext_deploy add``.

Nodes ride the registry apps and pipes already use, so what these tests pin is
the adapter: that a node zip becomes a ``kind:'node'`` artifact, that its
content lands beside that artifact, that the node's own manifest — not the
caller — decides the id, and that a bad archive leaves nothing behind.

The fakes and fixtures follow ``test_app_deploy.py``: an in-memory registry
over the account singleton, and the REAL Store over a temp filesystem, so a
call against a method the store does not have fails here as it would live.
"""

from __future__ import annotations

import io
import json
import zipfile
from types import SimpleNamespace

import pytest

from ai.account import node_deploy
from ai.account.store import Store


# =============================================================================
# FAKES
# =============================================================================


class _FakeConn:
    """Minimal TaskConn stand-in: account info + response builders."""

    def __init__(self, user_id='u1', org_id='org1', authenticated=True):
        self._account_info = (
            SimpleNamespace(
                userId=user_id,
                displayName='User One',
                email='u1@example.com',
                organization={'id': org_id, 'teams': [], 'developerId': 'acme'},
            )
            if authenticated
            else None
        )
        self._server = SimpleNamespace()

    def build_response(self, request, body=None):
        return {'success': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'success': False, 'message': message}


class _FakeRegistry:
    """In-memory registry patched over the account singleton."""

    def __init__(self):
        self.published = []
        self.states = []
        self.audits = []
        self.next_version = 1

    def install(self, monkeypatch):
        from ai.account import account

        async def deployments_publish(org_id, project_id, artifact, actor, comment='', metadata=None, **kwargs):
            version = self.next_version
            self.next_version += 1
            entry = {
                'version': version,
                'sha256': f'sha-{version}',
                'metadata': metadata or {},
                'artifactPath': f'orgs/{org_id}/files/.deployments/{project_id}/v{version:06d}-fake.json',
            }
            self.published.append(
                {'orgId': org_id, 'projectId': project_id, 'artifact': artifact, 'comment': comment, 'entry': entry}
            )
            return entry

        async def set_artifact_state(org_id, project_id, version, state, actor):
            self.states.append({'projectId': project_id, 'version': version, 'state': state})

        async def audit(user_id, area, action, request_data=None, org_id=None):
            self.audits.append({'action': action, 'data': request_data})

        monkeypatch.setattr(account, 'deployments_publish', deployments_publish)
        monkeypatch.setattr(account, 'set_artifact_state', set_artifact_state)
        monkeypatch.setattr(account, 'audit', audit)


@pytest.fixture
def registry(monkeypatch):
    reg = _FakeRegistry()
    reg.install(monkeypatch)
    return reg


@pytest.fixture
def content_store(monkeypatch, tmp_path):
    """The REAL Store over a temp filesystem backend."""
    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{tmp_path}')
    Store.reset()
    yield tmp_path
    Store.reset()


def _written(root):
    """Physical files under the temp store root: relative posix path -> bytes."""
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}


def _node_zip(manifest=None, files=None):
    """An in-memory node directory zip: services.json at the root + sources."""
    manifest = (
        manifest
        if manifest is not None
        else {'protocol': 'my_node://', 'title': 'My Node', 'version': '1.2.0', 'classType': ['transform']}
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('services.json', json.dumps(manifest))
        archive.writestr('IInstance.py', 'class IInstance:\n    pass\n')
        for name, content in (files or {}).items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _add_request(**args):
    """A raw rrext_deploy add request dict, node branch."""
    return {'command': 'rrext_deploy', 'arguments': {'subcommand': 'add', 'kind': 'node', **args}}


# =============================================================================
# THE ARTIFACT
# =============================================================================


class TestArtifact:
    """What the registry ends up holding for a node version."""

    @pytest.mark.asyncio
    async def test_the_artifact_is_kind_node(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        assert registry.published[0]['artifact']['kind'] == 'node'

    @pytest.mark.asyncio
    async def test_the_id_comes_from_the_manifest_not_the_caller(self, registry, content_store):
        # A caller naming a different node must not decide where it publishes.
        await node_deploy.handle_node_add(
            _FakeConn(), _add_request(data=_node_zip(), nodeId='something_else', name='Impostor')
        )
        assert registry.published[0]['artifact']['nodeId'] == 'my_node'
        assert registry.published[0]['projectId'] == 'my_node'

    @pytest.mark.asyncio
    async def test_the_display_name_and_version_ride_along(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        artifact = registry.published[0]['artifact']
        assert artifact['name'] == 'My Node'
        assert artifact['nodeVersion'] == '1.2.0'

    @pytest.mark.asyncio
    async def test_the_runtime_is_recorded_from_the_first_version(self, registry, content_store):
        # Native nodes (#1577) ship per-platform content; a resolver has to
        # know what it is fetching before it fetches it.
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        assert registry.published[0]['artifact']['runtime'] == node_deploy.RUNTIME_PYTHON

    @pytest.mark.asyncio
    async def test_the_bundle_digest_is_recorded(self, registry, content_store):
        data = _node_zip()
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=data))
        import hashlib

        assert registry.published[0]['artifact']['bundleSha256'] == hashlib.sha256(data).hexdigest()


# =============================================================================
# THE CONTENT
# =============================================================================


class TestContent:
    """Where the bytes land, and in what shape."""

    @pytest.mark.asyncio
    async def test_the_transport_zip_is_retained(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        paths = _written(content_store)
        assert any('/bundle/my_node-v000001.zip' in p for p in paths), sorted(paths)

    @pytest.mark.asyncio
    async def test_the_source_tree_is_unpacked(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        paths = _written(content_store)
        assert any(p.endswith('/source/services.json') for p in paths), sorted(paths)
        assert any(p.endswith('/source/IInstance.py') for p in paths), sorted(paths)

    @pytest.mark.asyncio
    async def test_content_sits_beside_its_artifact(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        # The version number names the directory, so two versions never mix.
        assert any('v000001' in p for p in _written(content_store))


# =============================================================================
# REFUSALS — nothing is registered when the input is bad
# =============================================================================


class TestRefusals:
    """A refused deploy must leave no version behind."""

    @pytest.mark.asyncio
    async def test_an_unauthenticated_connection_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(authenticated=False), _add_request(data=_node_zip()))
        assert result['success'] is False
        assert not registry.published

    @pytest.mark.asyncio
    async def test_missing_data_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request())
        assert result['success'] is False
        assert 'required' in result['message']
        assert not registry.published

    @pytest.mark.asyncio
    async def test_text_instead_of_a_binary_frame_is_refused(self, registry, content_store):
        # A str would make zipfile raise TypeError and escape as a 500.
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data='not bytes'))
        assert result['success'] is False
        assert 'binary' in result['message']
        assert not registry.published

    @pytest.mark.asyncio
    async def test_a_non_zip_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=b'not a zip at all'))
        assert result['success'] is False
        assert 'zip' in result['message']
        assert not registry.published

    @pytest.mark.asyncio
    async def test_a_zip_without_a_manifest_is_refused(self, registry, content_store):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('IInstance.py', 'pass')
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=buffer.getvalue()))
        assert result['success'] is False
        assert 'services.json' in result['message']
        assert not registry.published

    @pytest.mark.asyncio
    async def test_a_manifest_without_an_id_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(
            _FakeConn(), _add_request(data=_node_zip(manifest={'title': 'Nameless'}))
        )
        assert result['success'] is False
        assert not registry.published

    @pytest.mark.asyncio
    async def test_a_traversal_entry_is_refused_before_publishing(self, registry, content_store):
        # The archive guard runs BEFORE the registry row, so a hostile zip
        # never leaves a version with no bytes behind it.
        result = await node_deploy.handle_node_add(
            _FakeConn(), _add_request(data=_node_zip(files={'../escape.py': 'pass'}))
        )
        assert result['success'] is False
        assert not registry.published
        assert not _written(content_store)

    @pytest.mark.asyncio
    async def test_an_unsafe_node_id_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(
            _FakeConn(), _add_request(data=_node_zip(manifest={'protocol': '../../etc://', 'title': 'Bad'}))
        )
        assert result['success'] is False
        assert not registry.published


# =============================================================================
# CONTROL — publishing leaves a version inert; these verbs make it reachable
# =============================================================================


class _ControlRegistry:
    """Registry stand-in for the control verbs (rail, pins)."""

    def __init__(self):
        self.versions = {}
        self.artifacts = {}
        self.deployed = []
        self.listed = []

    def add_version(self, node_id, version, node_version, runtime='python'):
        self.versions.setdefault(node_id, []).append(
            {
                'version': version,
                'sha256': f'sha-{version}',
                'state': 'ready',
                'publishedAt': 1000 + version,
                'publishedBy': {'display': 'Dev'},
                'comment': f'v{node_version}',
            }
        )
        self.artifacts[(node_id, version)] = {
            'kind': 'node',
            'nodeId': node_id,
            'nodeVersion': node_version,
            'runtime': runtime,
        }

    def install(self, monkeypatch):
        from ai.account import account

        async def deployments_versions(org_id, project_id):
            return self.versions.get(project_id, [])

        async def deployments_artifact(org_id, project_id, version):
            return self.artifacts.get((project_id, version))

        async def deployments_deploy(org_id, team_id, project_id, version, actor):
            record = {'projectId': project_id, 'teamId': team_id, 'version': version}
            self.deployed.append(record)
            return record

        async def deployments_list(org_id, team_id):
            return self.listed

        monkeypatch.setattr(account, 'deployments_versions', deployments_versions)
        monkeypatch.setattr(account, 'deployments_artifact', deployments_artifact)
        monkeypatch.setattr(account, 'deployments_deploy', deployments_deploy)
        monkeypatch.setattr(account, 'deployments_list', deployments_list)


@pytest.fixture
def control(monkeypatch):
    reg = _ControlRegistry()
    reg.install(monkeypatch)
    return reg


def _control_request(subcommand, **args):
    return {
        'command': 'rrext_deploy_node',
        'arguments': {'subcommand': subcommand, 'nodeId': 'my_node', **args},
    }


class TestVersions:
    """The rail: what has been published, newest first."""

    @pytest.mark.asyncio
    async def test_newest_version_comes_first(self, control):
        control.add_version('my_node', 1, '1.0.0')
        control.add_version('my_node', 2, '1.1.0')
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('versions'))
        rail = result['body']['versions']
        assert [row['registryVersion'] for row in rail] == [2, 1]

    @pytest.mark.asyncio
    async def test_the_row_carries_the_nodes_own_version_and_runtime(self, control):
        control.add_version('my_node', 1, '1.2.0')
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('versions'))
        row = result['body']['versions'][0]
        assert row['nodeVersion'] == '1.2.0'
        assert row['runtime'] == 'python'

    @pytest.mark.asyncio
    async def test_a_node_with_no_versions_is_an_empty_rail(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('versions'))
        assert result['body']['versions'] == []


class TestDeploy:
    """Pinning: first release, update and rollback are all this one verb."""

    @pytest.mark.asyncio
    async def test_pinning_defaults_to_the_caller(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1))
        assert result['success'] is True
        assert control.deployed[0]['version'] == 1
        assert result['body']['audience']['type'] == 'user'

    @pytest.mark.asyncio
    async def test_the_registry_version_is_required_as_an_int(self, control):
        # The node's own semver is not it: two versions can carry the same
        # nodeVersion, and only one of them is this registry row.
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version='1.2.0'))
        assert result['success'] is False
        assert 'registry version' in result['message']
        assert not control.deployed

    @pytest.mark.asyncio
    async def test_an_unknown_target_is_refused(self, control):
        result = await node_deploy.handle_node_deploy(
            _FakeConn(), _control_request('deploy', version=1, target='@nowhere')
        )
        assert result['success'] is False
        assert not control.deployed

    @pytest.mark.asyncio
    async def test_rollback_is_the_same_verb(self, control):
        await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=2))
        await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1))
        assert [d['version'] for d in control.deployed] == [2, 1]


class TestWhere:
    """The reverse index — which audience holds which version."""

    @pytest.mark.asyncio
    async def test_only_this_nodes_pins_are_returned(self, control):
        control.listed = [
            {'projectId': 'my_node', 'teamId': 'u1', 'version': 3},
            {'projectId': 'other_node', 'teamId': 'u1', 'version': 9},
        ]
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('where'))
        assert result['body']['pins'] == [{'audience': 'u1', 'version': 3}]


class TestControlRefusals:
    @pytest.mark.asyncio
    async def test_an_unauthenticated_connection_is_refused(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(authenticated=False), _control_request('versions'))
        assert result['success'] is False

    @pytest.mark.asyncio
    async def test_a_missing_node_id_is_refused(self, control):
        request = {'command': 'rrext_deploy_node', 'arguments': {'subcommand': 'versions'}}
        result = await node_deploy.handle_node_deploy(_FakeConn(), request)
        assert result['success'] is False
        assert 'nodeId' in result['message']

    @pytest.mark.asyncio
    async def test_an_unknown_subcommand_is_named_in_the_error(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('teleport'))
        assert result['success'] is False
        assert 'teleport' in result['message']
