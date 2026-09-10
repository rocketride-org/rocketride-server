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
