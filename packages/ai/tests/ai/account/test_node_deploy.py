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

    def __init__(self, user_id='u1', org_id='org1', authenticated=True, teams=None):
        self._account_info = (
            SimpleNamespace(
                userId=user_id,
                displayName='User One',
                email='u1@example.com',
                organization={'id': org_id, 'teams': teams or [], 'developerId': 'acme'},
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
        self.bound = []
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

        # The bind side, reading back exactly what the publish above wrote —
        # deployTo binds the version it just created, so a fake that invented
        # its own rows would not be testing the seam that matters.
        async def deployments_versions(org_id, project_id):
            return [p['entry'] for p in self.published if p['projectId'] == project_id]

        async def deployments_artifact(org_id, project_id, version):
            for pub in self.published:
                if pub['projectId'] == project_id and pub['entry']['version'] == version:
                    return pub['artifact']
            return None

        async def publish_set(org_id, kind, node_id, audience, version, snapshot, actor):
            row = {'kind': kind, 'nodeId': node_id, 'audience': audience, 'version': version, 'state': 'enabled'}
            self.bound.append(row)
            return row

        monkeypatch.setattr(account, 'deployments_publish', deployments_publish)
        monkeypatch.setattr(account, 'set_artifact_state', set_artifact_state)
        monkeypatch.setattr(account, 'audit', audit)
        monkeypatch.setattr(account, 'deployments_versions', deployments_versions)
        monkeypatch.setattr(account, 'deployments_artifact', deployments_artifact)
        monkeypatch.setattr(account, 'publish_set', publish_set)


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
# DEPENDENCIES — what the node needs, and what it may not bring
# =============================================================================


class TestRequirements:
    """A node's own requirements.txt, and the file it may not carry."""

    @pytest.mark.asyncio
    async def test_requirements_ride_on_the_artifact(self, registry, content_store):
        # On the artifact, not only inside the bundle: a resolver decides
        # whether it can run the node before it downloads it.
        zip_bytes = _node_zip(files={'requirements.txt': 'httpx\npydantic\n'})
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=zip_bytes))
        assert registry.published[0]['artifact']['requirements'] == ['httpx', 'pydantic']

    @pytest.mark.asyncio
    async def test_comments_and_blank_lines_are_dropped(self, registry, content_store):
        zip_bytes = _node_zip(files={'requirements.txt': '# needed for the API\n\nhttpx\n\n# and this\nrich\n'})
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=zip_bytes))
        assert registry.published[0]['artifact']['requirements'] == ['httpx', 'rich']

    @pytest.mark.asyncio
    async def test_a_node_without_requirements_declares_none(self, registry, content_store):
        await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        assert registry.published[0]['artifact']['requirements'] == []

    @pytest.mark.asyncio
    async def test_an_overrides_file_is_refused(self, registry, content_store):
        # overrides.txt REPLACES what other packages declare, engine-wide.
        zip_bytes = _node_zip(files={'overrides.txt': 'urllib3==1.0\n'})
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=zip_bytes))
        assert result['success'] is False
        assert 'overrides.txt' in result['message']
        assert not registry.published
        assert not _written(content_store)

    @pytest.mark.asyncio
    async def test_an_oversized_requirements_file_is_refused(self, registry, content_store):
        zip_bytes = _node_zip(files={'requirements.txt': 'x\n' * 40000})
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=zip_bytes))
        assert result['success'] is False
        assert not registry.published


# =============================================================================
# ONE-STEP PUBLISH + BIND — the CLI's --deploy-to
# =============================================================================


class TestDeployTo:
    """Publishing and binding in one call, the way the CLI already sends it."""

    @staticmethod
    def _member_of(team_id='t1', name='Platform'):
        """A caller who belongs to one team, so @team targets can resolve."""
        return _FakeConn(teams=[{'id': team_id, 'name': name}])

    @pytest.mark.asyncio
    async def test_a_bare_team_binds_in_one_step(self, registry, content_store):
        # The CLI spells --deploy-to as a plain team, with no '@'.
        result = await node_deploy.handle_node_add(
            self._member_of(), _add_request(data=_node_zip(), deployTo='Platform')
        )
        assert result['success'] is True
        assert registry.bound[0]['audience']['type'] == 'team'
        assert registry.bound[0]['audience']['id'] == 't1'

    @pytest.mark.asyncio
    async def test_it_binds_the_version_it_just_published(self, registry, content_store):
        await node_deploy.handle_node_add(self._member_of(), _add_request(data=_node_zip(), deployTo='Platform'))
        await node_deploy.handle_node_add(self._member_of(), _add_request(data=_node_zip(), deployTo='Platform'))
        # The second call pins v2, not the version that happened to be first.
        assert [row['version'] for row in registry.bound] == [1, 2]

    @pytest.mark.asyncio
    async def test_an_at_target_passes_through(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip(), deployTo='@me'))
        assert result['success'] is True
        assert registry.bound[0]['audience']['type'] == 'user'

    @pytest.mark.asyncio
    async def test_without_deploy_to_the_version_stays_inert(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip()))
        assert result['success'] is True
        assert registry.published
        assert not registry.bound

    @pytest.mark.asyncio
    async def test_a_team_the_caller_is_not_in_is_refused(self, registry, content_store):
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip(), deployTo='Strangers'))
        assert result['success'] is False
        assert not registry.bound

    @pytest.mark.asyncio
    async def test_a_failed_bind_leaves_the_version_published(self, registry, content_store):
        # The bytes landed and the version is real — only the pointer failed,
        # so the error says so and the caller can bind without re-uploading.
        result = await node_deploy.handle_node_add(_FakeConn(), _add_request(data=_node_zip(), deployTo='Strangers'))
        assert 'published' in result['message']
        assert registry.published[0]['entry']['version'] == 1
        assert registry.states == []


# =============================================================================
# CONTROL — publishing leaves a version inert; these verbs make it reachable
# =============================================================================


class _ControlRegistry:
    """Registry stand-in for the control verbs (rail, pins)."""

    def __init__(self):
        self.versions = {}
        self.artifacts = {}
        self.deployed = []
        self.states = []
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

        async def publish_set(org_id, kind, node_id, audience, version, snapshot, actor):
            row = {'kind': kind, 'nodeId': node_id, 'audience': audience, 'version': version, 'state': 'enabled'}
            self.deployed.append(row)
            return row

        async def publish_of_app(org_id, kind, node_id):
            return [r for r in self.listed if r.get('nodeId') == node_id]

        async def publish_set_state(org_id, kind, node_id, audience, state, actor):
            row = {'kind': kind, 'nodeId': node_id, 'audience': audience, 'state': state}
            self.states.append(row)
            return row

        monkeypatch.setattr(account, 'deployments_versions', deployments_versions)
        monkeypatch.setattr(account, 'deployments_artifact', deployments_artifact)
        monkeypatch.setattr(account, 'publish_set', publish_set)
        monkeypatch.setattr(account, 'publish_of_app', publish_of_app)
        monkeypatch.setattr(account, 'publish_set_state', publish_set_state)


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
        control.add_version('my_node', 1, '1.0.0')
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1))
        assert result['success'] is True
        assert control.deployed[0]['version'] == 1
        assert result['body']['audience']['type'] == 'user'

    @pytest.mark.asyncio
    async def test_a_version_that_does_not_exist_is_refused(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=99))
        assert result['success'] is False
        assert not control.deployed

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
        control.add_version('my_node', 1, '1.0.0')
        control.add_version('my_node', 2, '1.1.0')
        await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=2))
        await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1))
        assert [d['version'] for d in control.deployed] == [2, 1]


class TestWhere:
    """The reverse index — which audience holds which version."""

    @pytest.mark.asyncio
    async def test_only_this_nodes_pins_are_returned(self, control):
        control.listed = [
            {'nodeId': 'my_node', 'audience': {'type': 'user', 'id': 'u1'}, 'version': 3},
            {'nodeId': 'other_node', 'audience': {'type': 'user', 'id': 'u1'}, 'version': 9},
        ]
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('where'))
        assert [row['nodeId'] for row in result['body']['pins']] == ['my_node']


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


class TestWithdrawal:
    """Stopping a binding — the version itself is immutable and stays put."""

    @pytest.mark.asyncio
    async def test_disable_stops_serving_one_binding(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('disable'))
        assert result['success'] is True
        assert control.states[0]['state'] == 'disabled'

    @pytest.mark.asyncio
    async def test_remove_takes_the_row_out(self, control):
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('remove'))
        assert result['success'] is True
        assert control.states[0]['state'] == 'removed'

    @pytest.mark.asyncio
    async def test_withdrawal_names_the_audience_it_acted_on(self, control):
        # Disabling for one team must not touch what another team sees.
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('disable', target='@me'))
        assert result['body']['audience']['type'] == 'user'

    @pytest.mark.asyncio
    async def test_the_version_survives_a_withdrawal(self, control):
        # Nothing about the artifact is touched, which is what keeps a later
        # rollback to that same version possible.
        control.add_version('my_node', 1, '1.0.0')
        await node_deploy.handle_node_deploy(_FakeConn(), _control_request('remove'))
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('versions'))
        assert [row['registryVersion'] for row in result['body']['versions']] == [1]


class TestReachControls:
    """What a caller may expose, and how far.

    Most of the bar lives in the shared target resolver; what is checked here
    is that the node surface applies it, plus the ownership rule the public
    rung adds.
    """

    @pytest.mark.asyncio
    async def test_a_team_you_do_not_belong_to_is_refused(self, control):
        control.add_version('my_node', 1, '1.0.0')
        result = await node_deploy.handle_node_deploy(
            _FakeConn(), _control_request('deploy', version=1, target='@team/strangers')
        )
        assert result['success'] is False
        assert not control.deployed

    @pytest.mark.asyncio
    async def test_the_org_target_is_refused_with_the_alternative(self, control):
        control.add_version('my_node', 1, '1.0.0')
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1, target='@org'))
        assert result['success'] is False
        assert 'team' in result['message'], 'the error should point at the team that replaces it'

    @pytest.mark.asyncio
    async def test_public_reach_requires_the_node_to_be_in_your_namespace(self, control):
        # Private reach is partitioned by org, so 'my_node' is fine there.
        # Public reach is one shared space: first-come would own the name.
        control.add_version('my_node', 1, '1.0.0')
        result = await node_deploy.handle_node_deploy(
            _FakeConn(), _control_request('deploy', version=1, target='@public')
        )
        assert result['success'] is False
        assert 'namespace' in result['message']
        assert not control.deployed

    @pytest.mark.asyncio
    async def test_a_namespaced_node_may_go_public(self, control):
        control.add_version('acme.my_node', 1, '1.0.0')
        request = {
            'command': 'rrext_deploy_node',
            'arguments': {'subcommand': 'deploy', 'nodeId': 'acme.my_node', 'version': 1, 'target': '@public'},
        }
        result = await node_deploy.handle_node_deploy(_FakeConn(), request)
        assert result['success'] is True, result.get('message')
        assert control.deployed[0]['audience']['type'] == 'public'

    @pytest.mark.asyncio
    async def test_private_reach_needs_no_namespace(self, control):
        control.add_version('my_node', 1, '1.0.0')
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('deploy', version=1, target='@me'))
        assert result['success'] is True, result.get('message')

    @pytest.mark.asyncio
    async def test_withdrawing_publicly_is_gated_the_same_way(self, control):
        # The reach check applies to taking something down, not only to
        # putting it up: the bar is the audience, not the direction.
        result = await node_deploy.handle_node_deploy(_FakeConn(), _control_request('disable', target='@public'))
        assert result['success'] is False
        assert not control.states


# =============================================================================
# AVAILABILITY — the scope walk that answers "which nodes do I have"
# =============================================================================


class _PinRegistry:
    """Binding rows plus the artifacts they point at."""

    def __init__(self):
        self.rows = []
        self.artifacts = {}

    def pin(
        self,
        node_id,
        version,
        audience_type,
        audience_id='',
        org_id='org1',
        state='enabled',
        artifact_state='ready',
        name=None,
    ):
        self.rows.append(
            {
                'nodeId': node_id,
                'version': version,
                'audience': {'type': audience_type, 'id': audience_id},
                'orgId': org_id,
                'state': state,
                'artifactState': artifact_state,
                'snapshot': {'name': name} if name else {},
            }
        )
        self.artifacts[(org_id, node_id, version)] = {
            'kind': 'node',
            'nodeId': node_id,
            'name': name or node_id,
            'nodeVersion': f'{version}.0.0',
            'runtime': 'python',
            'requirements': ['httpx'],
            'bundleSha256': f'sha-{version}',
        }

    def install(self, monkeypatch):
        from ai.account import account

        async def publish_list(org_id, kind, audiences):
            wanted = {(a['type'], a.get('id', '')) for a in audiences}
            return [r for r in self.rows if (r['audience']['type'], r['audience']['id']) in wanted]

        async def deployments_artifact(org_id, node_id, version):
            return self.artifacts.get((org_id, node_id, version))

        monkeypatch.setattr(account, 'publish_list', publish_list)
        monkeypatch.setattr(account, 'deployments_artifact', deployments_artifact)


@pytest.fixture
def pins(monkeypatch):
    reg = _PinRegistry()
    reg.install(monkeypatch)
    return reg


class TestAvailability:
    """resolve_node_pins — the one answer the picker and the resolver share."""

    @pytest.mark.asyncio
    async def test_a_personal_pin_is_available(self, pins):
        pins.pin('my_node', 3, 'user', 'u1')
        entries = await node_deploy.resolve_node_pins('org1', 'u1', [])
        assert [(e['id'], e['version'], e['rung']) for e in entries] == [('my_node', 3, 'personal')]

    @pytest.mark.asyncio
    async def test_the_more_specific_rung_wins(self, pins):
        # Same node pinned three ways; the user's own pin is what runs.
        pins.pin('my_node', 1, 'public')
        pins.pin('my_node', 2, 'team', 't1')
        pins.pin('my_node', 3, 'user', 'u1')
        entries = await node_deploy.resolve_node_pins('org1', 'u1', ['t1'])
        assert len(entries) == 1
        assert entries[0]['version'] == 3

    @pytest.mark.asyncio
    async def test_a_team_pin_beats_a_public_one(self, pins):
        pins.pin('my_node', 1, 'public')
        pins.pin('my_node', 2, 'team', 't1')
        entries = await node_deploy.resolve_node_pins('org1', 'u1', ['t1'])
        assert entries[0]['version'] == 2

    @pytest.mark.asyncio
    async def test_a_disabled_binding_never_serves(self, pins):
        pins.pin('my_node', 3, 'user', 'u1', state='disabled')
        assert await node_deploy.resolve_node_pins('org1', 'u1', []) == []

    @pytest.mark.asyncio
    async def test_a_failed_version_never_serves(self, pins):
        pins.pin('my_node', 3, 'user', 'u1', artifact_state='failed')
        assert await node_deploy.resolve_node_pins('org1', 'u1', []) == []

    @pytest.mark.asyncio
    async def test_public_reach_demands_a_ready_version(self, pins):
        # Internal reach tolerates a version still settling; public does not.
        pins.pin('my_node', 3, 'public', artifact_state='building')
        assert await node_deploy.resolve_node_pins('org1', 'u1', []) == []

    @pytest.mark.asyncio
    async def test_requirements_ride_on_the_entry(self, pins):
        # So a caller knows what the node needs before fetching it.
        pins.pin('my_node', 3, 'user', 'u1')
        entries = await node_deploy.resolve_node_pins('org1', 'u1', [])
        assert entries[0]['requirements'] == ['httpx']
        assert entries[0]['bundleSha256'] == 'sha-3'

    @pytest.mark.asyncio
    async def test_a_team_the_caller_is_not_in_is_not_walked(self, pins):
        pins.pin('other_node', 1, 'team', 't9')
        assert await node_deploy.resolve_node_pins('org1', 'u1', ['t1']) == []

    @pytest.mark.asyncio
    async def test_distinct_nodes_all_come_back(self, pins):
        pins.pin('node_a', 1, 'user', 'u1')
        pins.pin('node_b', 2, 'team', 't1')
        entries = await node_deploy.resolve_node_pins('org1', 'u1', ['t1'])
        assert sorted(e['id'] for e in entries) == ['node_a', 'node_b']

    @pytest.mark.asyncio
    async def test_a_binding_without_its_artifact_is_skipped(self, pins):
        pins.pin('my_node', 3, 'user', 'u1')
        pins.artifacts.clear()
        assert await node_deploy.resolve_node_pins('org1', 'u1', []) == []
