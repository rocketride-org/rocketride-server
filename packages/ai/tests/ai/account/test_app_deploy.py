# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Contract tests for app publish control (``rrext_deploy_app``) + the rail's app branch.

DEPLOY = copy code to the server (the generic ``rrext_deploy add`` verb;
``handle_app_add`` is its app branch — zip transport, unpacked at receipt).
The REVIEW state lives on the DEPLOYMENT (private -> submit -> ready |
rejected); ``submit`` flips it, admin approve/reject move it on. PUBLISH
binds a deployment to an audience (user | team | public; no org rung) as a
pure pointer (born 'enabled') — a public binding needs a 'ready' deployment,
internal bindings accept any non-'failed' one. App ids are partitioned by the
caller's developer namespace, and a version's bundle is only reachable when a
caller-visible binding serves it (public counts only when the deployment is
'ready') or the caller deployed it — the security contract under test.

The registry backend (``account.deployments_*`` + ``publish_*``) is faked
with an in-memory registry; the handler's own logic (argument validation,
target resolution, the scope walk, the entitlement checks) runs for real.
"""

import io
import json
import zipfile
from types import SimpleNamespace

import pytest

from ai.account import account as account_singleton
from ai.account import dev_overlay
from ai.account.app_deploy import (
    _REPLY_MAX_CHARS,
    entitled_version_dirs,
    handle_app_add,
    handle_deploy_app,
    open_version_dirs,
    resolve_app_pins,
)
from ai.account.store import Store


# =============================================================================
# FAKES — conn + in-memory deployments registry
# =============================================================================


class _FakeConn:
    """Minimal TaskConn stand-in: account info + response builders."""

    def __init__(self, user_id='u1', org_id='org1', teams=None, authenticated=True, developer_id='acme'):
        # Account info mirrors the dict-shaped organization the handler accepts
        self._account_info = (
            SimpleNamespace(
                userId=user_id,
                displayName='User One',
                email='u1@example.com',
                organization={'id': org_id, 'teams': teams or [], 'developerId': developer_id},
            )
            if authenticated
            else None
        )
        # Content writes go through Store.file_store(internal) — the process
        # singleton (see the content_store fixture) — NOT through conn state,
        # so no store fake exists here to drift from the real surface.
        self._server = SimpleNamespace()

    def build_response(self, request, body=None):
        """Success envelope — shape is this fake's own convention."""
        return {'success': True, 'body': body or {}}

    def build_error(self, request, message):
        """Error envelope — shape is this fake's own convention."""
        return {'success': False, 'message': message}


class _FakeRegistry:
    """In-memory rail + publish rows patched over the account singleton."""

    def __init__(self):
        # Registry entries: [{version, sha256, state, metadata, publishedBy, ...}]
        self.versions = []
        # Registry version -> artifact dict
        self.artifacts = {}
        # (app_id, audience_key) -> publish row (contract shape)
        self.publishes = {}
        # Call records for assertions
        self.publish_calls = []
        self.set_calls = []
        # Appended history rows (the review-thread writer's capture)
        self.history = []

    def add_version(
        self, version, app_version, publisher_id='dev1', kind='app', state='ready', manifest=None, build='ok'
    ):
        """Seed one deployed registry version + its artifact.

        ``build`` is the version's metadata.build.status — 'ok' by default
        (a servable version is the normal case; the worker stamps it after
        compiling); pass 'queued'/'building'/'failed' to exercise the built
        gates, or None to omit the build blob entirely (an unbuilt row).
        """
        metadata = {'manifest': manifest or {'name': 'Brandy', 'version': app_version}}
        if build is not None:
            metadata['build'] = {'status': build}
        self.versions.append(
            {
                'version': version,
                'sha256': f'sha-{version}',
                'state': state,
                'metadata': metadata,
                'publishedAt': 1000 + version,
                'publishedBy': {'userId': publisher_id, 'display': 'Dev', 'email': 'dev@example.com'},
                'comment': f'v{app_version}',
                # Same shape the real backend records — the content home (and
                # therefore the servable dist/ dir) derives from this path.
                'artifactPath': f'orgs/org1/files/.deployments/acme.brandy/v{version:06d}-fakesha{version}.json',
            }
        )
        self.artifacts[version] = {
            'kind': kind,
            'appId': 'acme.brandy',
            'moduleId': 'acme_brandy',
            'name': 'Brandy',
            'appVersion': app_version,
        }

    @staticmethod
    def _key(audience):
        """The fake's audience key (mirrors the backends' encodings)."""
        return f'{audience["type"]}~{audience.get("id", "")}'

    def seed_publish(self, audience, version, art_state=None):
        """Bind one audience to a version (binding born 'enabled').

        The REVIEW state lives on the deployment, so ``art_state`` (when
        given) sets that version's deployment state; the read fakes join it
        back onto the row as ``artifactState``.
        """
        if art_state is not None:
            for v in self.versions:
                if int(v.get('version', 0)) == int(version):
                    v['state'] = art_state
        self.publishes[('acme.brandy', self._key(audience))] = {
            'orgId': 'org1',
            'appId': 'acme.brandy',
            'audience': dict(audience),
            'version': version,
            'state': 'enabled',
            'snapshot': {'name': 'Brandy'},
            'publishedAt': 2000 + version,
        }

    def install(self, monkeypatch):
        """Patch the account singleton's rail + publish methods."""

        async def deployments_versions(org_id, project_id):
            # The rail is ORG-scoped (every fake row belongs to org1) — the
            # serving resolvers' developer-org arm depends on this scoping.
            return list(self.versions) if org_id in ('org1', 'local') else []

        async def deployments_artifact(org_id, project_id, version):
            return self.artifacts[version]

        async def deployments_publish(org_id, project_id, artifact, actor, comment='', metadata=None, state=None):
            self.publish_calls.append({'artifact': artifact, 'actor': actor, 'comment': comment, 'metadata': metadata})
            version = len(self.versions) + 1
            entry = {
                'version': version,
                'sha256': 'sha-new',
                'state': state or ('private' if artifact.get('kind') == 'app' else 'ready'),
                'metadata': metadata or {},
                'publishedAt': 3000,
                'publishedBy': actor,
                'comment': comment,
                # Same shape the real backend records — handle_app_add derives
                # the content home from this path's .json sibling.
                'artifactPath': f'orgs/{org_id}/files/.deployments/{project_id}/v{version:06d}-shanew00.json',
            }
            self.versions.append(entry)
            self.artifacts[entry['version']] = artifact
            return entry

        def _art_state(version):
            """The deployment's review state (from the rail), for publish rows."""
            for v in self.versions:
                if int(v.get('version', 0)) == int(version):
                    return str(v.get('state') or '')
            return ''

        def _art_build(version):
            """The deployment's build status (from the rail), for publish rows."""
            for v in self.versions:
                if int(v.get('version', 0)) == int(version):
                    metadata = v.get('metadata') or {}
                    return str((metadata.get('build') or {}).get('status') or '')
            return ''

        async def set_artifact_state(org_id, project_id, version, new_state, actor):
            # The REAL transition guard runs in the fake too — a handler
            # requesting an edge the backend forbids must fail HERE, not
            # only in production (the mock-drift lesson).
            from ai.account.deployment_backend import _assert_review_transition

            for v in self.versions:
                if int(v.get('version', 0)) == int(version):
                    _assert_review_transition(str(v.get('state') or ''), new_state)
                    v['state'] = new_state
                    return dict(v)
            raise KeyError(version)

        async def publish_set(org_id, kind, app_id, audience, version, snapshot, actor):
            row = {
                'orgId': org_id,
                'appId': app_id,
                # The real backends key by {type,id} and DECODE the audience
                # from the key on the way out — the resolver's display keys
                # (name/handle) land in history data, never on publish rows.
                'audience': {'type': audience['type'], 'id': audience.get('id', '')},
                'version': version,
                'state': 'enabled',
                'artifactState': _art_state(version),
                'snapshot': dict(snapshot or {}),
                'publishedAt': 4000,
            }
            self.publishes[(app_id, self._key(audience))] = row
            self.set_calls.append({'audience': dict(audience), 'version': version, 'snapshot': snapshot})
            return row

        def _art_path(version):
            """The deployment's registry JSON path, for publish rows."""
            for v in self.versions:
                if int(v.get('version', 0)) == int(version):
                    return str(v.get('artifactPath') or '')
            return ''

        def _with_state(row):
            """Refresh the joined artifactState/artifactBuild/artifactPath
            (the deployment may have moved) — the same join both real
            backends perform.
            """
            return {
                **row,
                'artifactState': _art_state(row.get('version')),
                'artifactBuild': _art_build(row.get('version')),
                'artifactPath': _art_path(row.get('version')),
            }

        async def publish_get(org_id, kind, app_id, audience):
            row = self.publishes.get((app_id, self._key(audience)))
            return None if not row or row.get('state') == 'removed' else _with_state(row)

        async def publish_of_app(org_id, kind, app_id):
            return [
                _with_state(r)
                for (aid, _), r in self.publishes.items()
                if aid == app_id and r.get('state') != 'removed'
            ]

        async def publish_list(org_id, kind, audiences):
            keys = {self._key(a) for a in audiences}
            return [
                _with_state(r)
                for (aid, key), r in self.publishes.items()
                if key in keys and r.get('state') != 'removed'
            ]

        async def publish_set_state(org_id, kind, app_id, audience, state, actor):
            row = self.publishes[(app_id, self._key(audience))]
            row['state'] = state
            return _with_state(row)

        async def deployments_history_append(org_id, project_id, action, actor, version=None, data=None):
            self.history.append(
                {
                    'orgId': org_id,
                    'projectId': project_id,
                    'action': action,
                    'actor': actor,
                    'version': version,
                    'data': data,
                }
            )

        for name, fn in (
            ('deployments_versions', deployments_versions),
            ('deployments_artifact', deployments_artifact),
            ('deployments_publish', deployments_publish),
            ('set_artifact_state', set_artifact_state),
            ('publish_set', publish_set),
            ('publish_get', publish_get),
            ('publish_of_app', publish_of_app),
            ('publish_list', publish_list),
            ('publish_set_state', publish_set_state),
            ('deployments_history_append', deployments_history_append),
        ):
            monkeypatch.setattr(account_singleton, name, fn, raising=False)


def _request(subcommand, **args):
    """Build a raw rrext_deploy_app DAP request dict."""
    return {'command': 'rrext_deploy_app', 'arguments': {'subcommand': subcommand, 'appId': 'acme.brandy', **args}}


@pytest.fixture
def registry(monkeypatch):
    """Fresh in-memory registry installed over the account singleton."""
    reg = _FakeRegistry()
    reg.install(monkeypatch)
    return reg


@pytest.fixture
def content_store(monkeypatch, tmp_path):
    """The REAL Store singleton over a temp filesystem backend.

    The receipt's content writes go through Store.file_store with the
    internal identity — the actual resolve_scope path runs, and the bytes
    land under this directory. No store fake: a call against a method the
    real Store lacks fails here exactly as it would in production.
    """
    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{tmp_path}')
    Store.reset()
    yield tmp_path
    Store.reset()


def _written(root):
    """Physical files under the temp store root: relative posix path -> bytes."""
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}


@pytest.fixture
def quiet_push(monkeypatch):
    """Silence the publish handler's manifest refresh push; record calls."""
    calls = []

    async def push_refresh(server, user_id, source):
        calls.append({'user_id': user_id, 'source': source})

    monkeypatch.setattr(dev_overlay, 'push_refresh', push_refresh)
    return calls


# Standard team roster used across tests: caller is in team t1 ('Development')
_TEAMS = [{'id': 't1', 'name': 'Development'}]

AUD_USER = {'type': 'user', 'id': 'u1'}
AUD_TEAM = {'type': 'team', 'id': 't1'}
AUD_PUBLIC = {'type': 'public', 'id': ''}


# =============================================================================
# AUTH + ARGUMENT VALIDATION
# =============================================================================


@pytest.mark.asyncio
async def test_requires_authenticated_connection(registry):
    """An unauthenticated connection is refused outright."""
    conn = _FakeConn(authenticated=False)
    result = await handle_deploy_app(conn, _request('versions'))
    assert result['success'] is False
    assert 'authenticated' in result['message']


@pytest.mark.asyncio
async def test_requires_app_id(registry):
    """Every subcommand requires an appId."""
    conn = _FakeConn()
    request = {'command': 'rrext_deploy_app', 'arguments': {'subcommand': 'versions'}}
    result = await handle_deploy_app(conn, request)
    assert result['success'] is False
    assert 'appId' in result['message']


@pytest.mark.asyncio
async def test_unknown_subcommand_errors(registry):
    """An unknown subcommand reports itself instead of falling through."""
    conn = _FakeConn()
    result = await handle_deploy_app(conn, _request('promote'))
    assert result['success'] is False
    assert 'promote' in result['message']


# =============================================================================
# ADD — the generic rail door's app branch (zip transport)
# =============================================================================


def _app_zip(manifest=None, files=None):
    """An in-memory app SOURCE zip: src/ + package.json (+extras).

    Mirrors a REAL app's package.json shape: the semver at the TOP level
    (the control plane), the appManifest block without a version field.
    """
    manifest = manifest if manifest is not None else {'id': 'acme.brandy', 'name': 'Brandy'}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('src/App.tsx', 'export default () => null')
        archive.writestr('package.json', json.dumps({'name': 'brandy', 'version': '1.0.0', 'appManifest': manifest}))
        for name, content in (files or {}).items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _add_request(**args):
    """A raw rrext_deploy add request dict (kind='app' branch)."""
    return {'command': 'rrext_deploy', 'arguments': {'subcommand': 'add', 'kind': 'app', **args}}


@pytest.mark.asyncio
async def test_add_requires_data_and_valid_zip(registry):
    """The app branch refuses missing data, junk bytes, and manifest-less zips."""
    conn = _FakeConn()
    assert (await handle_app_add(conn, _add_request()))['success'] is False
    assert (await handle_app_add(conn, _add_request(data=b'not-a-zip')))['success'] is False

    # A zip without package.json/appManifest names the real problem
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('src/App.tsx', 'x')
    result = await handle_app_add(conn, _add_request(data=buffer.getvalue()))
    assert result['success'] is False
    assert 'package.json' in result['message']


@pytest.mark.asyncio
async def test_add_unpacks_zip_and_returns_rail_entry(registry, content_store):
    """The zip is retained at bundle/, unpacked at source/, and registered kind:'app'."""
    conn = _FakeConn()
    data = _app_zip(files={'assets/logo.svg': 'svg'})
    result = await handle_app_add(conn, _add_request(data=data, comment='first cut', metadata={'projectId': 'wc-1'}))

    # Registry records the app artifact with the FULL manifest as metadata
    assert len(registry.publish_calls) == 1
    call = registry.publish_calls[0]
    assert call['artifact']['kind'] == 'app'
    assert call['artifact']['appVersion'] == '1.0.0'
    assert call['metadata']['manifest']['id'] == 'acme.brandy'
    assert call['metadata']['projectId'] == 'wc-1'  # client working-copy provenance

    # The build lifecycle is born WITH the row: queued, attempt 0 — the rail
    # row IS the build job record (dist/ is written by the worker later).
    assert call['metadata']['build']['status'] == 'queued'

    # Content: retained transport zip + the unpacked SOURCE tree (dist/ is
    # the build worker's to write) — the artifact's .deployments sibling
    # directory, ONE convention with the platform seeder
    writes = _written(content_store)
    home = 'orgs/org1/files/.deployments/acme.brandy/v000001-shanew00'
    assert f'{home}/bundle/acme.brandy-v000001.zip' in writes
    assert writes[f'{home}/source/src/App.tsx'] == b'export default () => null'
    assert f'{home}/source/assets/logo.svg' in writes

    # One generic response shape for every kind: add -> {artifact}
    entry = result['body']['artifact']
    assert entry['registryVersion'] == 1
    assert entry['appVersion'] == '1.0.0'
    assert entry['message'] == 'first cut'
    # The deploy response reports the queued build immediately
    assert entry['buildStatus'] == 'queued'
    # Deploying published nothing anywhere
    assert registry.set_calls == []


@pytest.mark.asyncio
async def test_add_ticks_uploaded_on_the_card(registry, content_store):
    """A successful receipt broadcasts the org-scoped 'uploaded' card tick —
    the first server-side word of the build status ticker (the client's own
    'uploading' state hands over here; the worker ticks the rest).
    """
    conn = _FakeConn()
    events = []

    async def broadcast_server_event(event_type, message, org_id=None):
        events.append({'message': message, 'org_id': org_id})

    conn._server = SimpleNamespace(broadcast_server_event=broadcast_server_event)
    result = await handle_app_add(conn, _add_request(data=_app_zip()))
    assert result['success'] is True

    ticks = [e for e in events if e['message'].get('event') == 'apaevt_build_status']
    assert len(ticks) == 1
    assert ticks[0]['org_id'] == 'org1'
    body = ticks[0]['message']['body']
    assert (body['appId'], body['version'], body['status']) == ('acme.brandy', 1, 'uploaded')


@pytest.mark.asyncio
async def test_add_rejects_unsafe_zip_entries(registry, content_store):
    """Path traversal inside the archive is refused before any write."""
    conn = _FakeConn()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('remoteEntry.js', 'x')
        archive.writestr('package.json', json.dumps({'appManifest': {'id': 'acme.brandy', 'name': 'B'}}))
        archive.writestr('../escape.js', 'evil')
    result = await handle_app_add(conn, _add_request(data=buffer.getvalue()))
    assert result['success'] is False
    assert 'unsafe path' in result['message']
    assert _written(content_store) == {}


@pytest.mark.asyncio
async def test_add_rejects_foreign_namespace_app_id(registry, content_store):
    """Deploy fails fast when the manifest declares an app id outside the
    caller org's developer namespace — the impersonation ('I am org xyz but
    declare rocketride.pipeBuilder') dies before any artifact is created.
    """
    conn = _FakeConn(developer_id='xyz')
    data = _app_zip(manifest={'id': 'rocketride.pipeBuilder', 'name': 'Fake', 'version': '1.0.0'})
    result = await handle_app_add(conn, _add_request(data=data))
    assert result['success'] is False
    assert 'namespace' in result['message']
    assert registry.publish_calls == []
    assert _written(content_store) == {}


@pytest.mark.asyncio
async def test_add_requires_a_developer_id(registry):
    """An org with no developer id owns no namespace and cannot deploy apps."""
    conn = _FakeConn(developer_id=None)
    result = await handle_app_add(conn, _add_request(data=_app_zip()))
    assert result['success'] is False
    assert 'developer id' in result['message']
    assert registry.publish_calls == []


@pytest.mark.asyncio
async def test_add_rejects_oversized_zip_upload(registry, content_store, monkeypatch):
    """The upload cap is measured on the ZIPPED byte count and refused
    before ANY parsing — an over-cap payload never reaches the zip parser,
    the manifest read, the registry, or the store (the payload here is not
    even a valid archive, proving the cap runs first).
    """
    monkeypatch.setattr('ai.account.app_deploy._ZIP_MAX_ZIPPED', 1024)
    conn = _FakeConn()
    result = await handle_app_add(conn, _add_request(data=b'\0' * 4096))
    assert result['success'] is False
    assert 'upload cap' in result['message']
    assert registry.publish_calls == []
    assert _written(content_store) == {}


@pytest.mark.asyncio
async def test_add_rejects_zip_bomb_on_actual_size(registry, content_store, monkeypatch):
    """The unpacked cap is measured on REAL decompressed bytes, not the
    attacker-controlled declared size — a highly-compressible entry over the
    limit is refused before any registry row or file write.
    """
    # 200MB of zeros compresses to a few KB — the classic declared-size lie.
    monkeypatch.setattr('ai.account.app_deploy._ZIP_MAX_UNPACKED', 8 * 1024 * 1024)
    conn = _FakeConn()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('remoteEntry.js', 'x')
        archive.writestr('package.json', json.dumps({'appManifest': {'id': 'acme.brandy', 'name': 'B'}}))
        archive.writestr('bomb.bin', b'\0' * (32 * 1024 * 1024))
    result = await handle_app_add(conn, _add_request(data=buffer.getvalue()))
    assert result['success'] is False
    assert 'unpacks past' in result['message']
    # Nothing was registered and nothing was written.
    assert registry.publish_calls == []
    assert _written(content_store) == {}


@pytest.mark.asyncio
async def test_add_withdraws_stale_pending_reviews(registry, content_store):
    """Deploying a new version WITHDRAWS every other version still in
    'submit' (the queue only ever reviews current work — submit → private,
    history 'withdrawn'); 'ready' and 'rejected' rows are untouched.
    """
    registry.add_version(1, '1.0.0', state='submit')
    registry.add_version(2, '1.1.0', state='ready')
    registry.add_version(3, '1.1.5', state='rejected')
    conn = _FakeConn()
    result = await handle_app_add(conn, _add_request(data=_app_zip()))
    assert result['success'] is True

    states = {int(v['version']): str(v['state']) for v in registry.versions}
    assert states[1] == 'private'  # withdrawn — was in review, now superseded
    assert states[2] == 'ready'  # approved rows keep serving the store
    assert states[3] == 'rejected'  # terminal rows never move
    assert states[4] == 'private'  # the new row, born draft


@pytest.mark.asyncio
async def test_add_app_version_is_package_json_top_level_only(registry, content_store):
    """package.json is the CONTROL-PLANE truth: appVersion comes from its
    top-level ``version``, full stop. The appManifest block is a projection
    (store listing / shell loading) — a stray ``appManifest.version`` can
    never shadow the app's real semver.
    """
    conn = _FakeConn()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('src/App.tsx', 'x')
        archive.writestr(
            'package.json',
            json.dumps(
                {
                    'name': 'brandy',
                    'version': '1.2.0',
                    # Decoy: the projection claims a different version — ignored.
                    'appManifest': {'id': 'acme.brandy', 'name': 'Brandy', 'version': '9.9.9'},
                }
            ),
        )
    result = await handle_app_add(conn, _add_request(data=buffer.getvalue()))
    assert result['success'] is True
    assert registry.publish_calls[0]['artifact']['appVersion'] == '1.2.0'
    assert result['body']['artifact']['appVersion'] == '1.2.0'
    # The stored manifest projection is verbatim — not mutated by the receipt.
    assert registry.publish_calls[0]['metadata']['manifest']['version'] == '9.9.9'


@pytest.mark.asyncio
async def test_add_content_write_failure_flips_row_to_failed(registry, content_store, monkeypatch):
    """A version whose content never fully lands is compensated: partial
    writes are removed and the allocated registry row flips to 'failed'
    (unpublishable, unservable) instead of surviving as a publishable
    no-bytes version.
    """
    from ai.account.file_store import FileStore

    real_write = FileStore.write

    async def failing_write(self, path, data):
        # The bundle write succeeds; the first source write dies — the
        # partial-content shape a mid-flight crash leaves behind.
        if '/source/' in path:
            raise OSError('disk full')
        return await real_write(self, path, data)

    monkeypatch.setattr(FileStore, 'write', failing_write)
    conn = _FakeConn()
    result = await handle_app_add(conn, _add_request(data=_app_zip()))

    assert result['success'] is False
    assert 'marked failed' in result['message']
    # The allocated row was compensated to 'failed' — never publishable
    assert registry.versions[0]['state'] == 'failed'
    # The partial bundle write was cleaned up
    assert _written(content_store) == {}


# =============================================================================
# ADD — workspace-relative layout (metadata.appRoot)
# =============================================================================


def _workspace_zip(app_root='apps/brandy-ui', manifest=None, files=None):
    """An in-memory WORKSPACE-RELATIVE source zip: the app under ``app_root``,
    include extras (e.g. a shared source dir) at their own workspace paths.
    """
    manifest = manifest if manifest is not None else {'id': 'acme.brandy', 'name': 'Brandy'}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(f'{app_root}/src/App.tsx', 'export default () => null')
        archive.writestr(
            f'{app_root}/package.json', json.dumps({'name': 'brandy', 'version': '1.0.0', 'appManifest': manifest})
        )
        for name, content in (files or {}).items():
            archive.writestr(name, content)
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_add_workspace_layout_reads_manifest_at_app_root(registry, content_store):
    """With metadata.appRoot the manifest is read from <appRoot>/package.json,
    the tree unpacks verbatim (include extras at their own paths), and appRoot
    itself persists with the caller metadata for the build worker.
    """
    conn = _FakeConn()
    data = _workspace_zip(files={'apps/shared/src/util.ts': 'export const u = 1'})
    result = await handle_app_add(
        conn,
        _add_request(data=data, metadata={'projectId': 'wc-1', 'appRoot': 'apps/brandy-ui'}),
    )
    assert result['success'] is True

    # The manifest came from the nested package.json, and appRoot persisted
    call = registry.publish_calls[0]
    assert call['metadata']['manifest']['id'] == 'acme.brandy'
    assert call['metadata']['appRoot'] == 'apps/brandy-ui'

    # The workspace tree unpacked AS-IS — relative references between the app
    # and its include extras survive because nothing was re-rooted
    writes = _written(content_store)
    home = 'orgs/org1/files/.deployments/acme.brandy/v000001-shanew00'
    assert writes[f'{home}/source/apps/brandy-ui/src/App.tsx'] == b'export default () => null'
    assert writes[f'{home}/source/apps/shared/src/util.ts'] == b'export const u = 1'


@pytest.mark.asyncio
async def test_add_workspace_layout_missing_manifest_names_the_path(registry, content_store):
    """A wrong appRoot names the exact package.json path it looked for."""
    conn = _FakeConn()
    result = await handle_app_add(
        conn,
        _add_request(data=_workspace_zip(), metadata={'appRoot': 'apps/ghost'}),
    )
    assert result['success'] is False
    assert 'apps/ghost/package.json' in result['message']
    assert registry.publish_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'app_root',
    ['/apps/brandy-ui', 'apps/brandy-ui/', 'apps/../secrets', 'apps/./brandy-ui', 'apps\\brandy-ui', 'C:/apps'],
)
async def test_add_rejects_unsafe_app_root(registry, content_store, app_root):
    """The appRoot value is guarded like a zip entry — absolute paths,
    traversal, dot segments, backslashes, and drive letters are refused
    before any read.
    """
    conn = _FakeConn()
    result = await handle_app_add(conn, _add_request(data=_workspace_zip(), metadata={'appRoot': app_root}))
    assert result['success'] is False
    assert 'unsafe' in result['message']
    assert registry.publish_calls == []


# =============================================================================
# PUBLISH — bind a deployment to an audience (user | team | public)
# =============================================================================


@pytest.mark.asyncio
async def test_publish_requires_registry_version_int(registry):
    """Publishing rejects a missing or non-int version (semver is display-only)."""
    conn = _FakeConn()
    result = await handle_deploy_app(conn, _request('publish', version='1.0.0', target='@team/Development'))
    assert result['success'] is False
    assert 'version' in result['message']


@pytest.mark.asyncio
@pytest.mark.parametrize('target', ['@nope', '@team/ghost', '@org'])
async def test_publish_rejects_unknown_targets(registry, target):
    """Malformed targets, non-member teams, and the retired org rung are refused."""
    registry.add_version(1, '1.0.0')
    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target=target))
    assert result['success'] is False
    assert registry.set_calls == []


@pytest.mark.asyncio
async def test_publish_user_blocked_without_entitlement(registry, quiet_push):
    """A user cannot publish a version to themselves that they cannot reach."""
    registry.add_version(1, '1.0.0', publisher_id='someone-else')

    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target='@user'))

    assert result['success'] is False
    assert 'Not entitled' in result['message']
    assert registry.set_calls == []


@pytest.mark.asyncio
async def test_publish_user_allowed_for_deployer(registry, quiet_push):
    """The developer self-publish flow: deploying a version entitles you to publish it."""
    registry.add_version(1, '1.0.0', publisher_id='u1')

    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target='@user'))

    assert result['success'] is True
    row = result['body']['publish']
    # The binding is a pure pointer born 'enabled' — publish-and-go, no approval
    assert (row['audience'], row['state']) == (AUD_USER, 'enabled')
    # The manifest snapshot rode along from the entry's metadata
    assert registry.set_calls[0]['snapshot']['name'] == 'Brandy'
    # The audience the backend received is self-describing: the resolver
    # stamped the display facts the history row will store verbatim.
    sent = registry.set_calls[0]['audience']
    assert (sent['handle'], sent['name']) == ('@me', 'User One')
    # The acting user's manifest is refreshed (data + signal)
    assert quiet_push == [{'user_id': 'u1', 'source': 'app-publish'}]


@pytest.mark.asyncio
async def test_publish_team_needs_membership_only(registry, quiet_push):
    """Team publishing is membership-gated; the binding is born 'enabled'.

    Internal (@team/@me) bindings accept any internal-eligible deployment,
    including one still 'private' (not yet submitted for review).
    """
    registry.add_version(1, '1.0.0', publisher_id='someone-else', state='private')

    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target='@team/Development'))

    assert result['success'] is True
    assert result['body']['publish']['state'] == 'enabled'
    # The team NAME was dereferenced at resolution — the history row never
    # needs a second lookup to say which team.
    sent = registry.set_calls[0]['audience']
    assert (sent['handle'], sent['name'], sent['id']) == ('@team/Development', 'Development', 't1')


@pytest.mark.asyncio
async def test_public_publish_requires_dev_org_and_ready_deployment(registry, quiet_push):
    """A public binding needs a registered developer org AND an approved
    ('ready') deployment. The review state lives on the deployment: a fresh
    'private' version cannot go public until it is submitted and approved.
    """
    # A freshly-deployed app is deployment-state 'private' (not yet reviewed).
    registry.add_version(1, '1.0.0', publisher_id='u1', state='private')

    # No developerId on the org — no namespace is owned, so nothing publishes
    plain = _FakeConn(teams=_TEAMS, developer_id=None)
    refused = await handle_deploy_app(plain, _request('publish', version=1, target='@public'))
    assert refused['success'] is False
    assert 'developer' in refused['message']

    # Developer org, but the deployment is not yet approved — public refused.
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')
    unapproved = await handle_deploy_app(dev, _request('publish', version=1, target='@public'))
    assert unapproved['success'] is False
    assert 'not approved for the store' in unapproved['message']

    # Once the deployment is 'ready' (approved), the public binding is created.
    registry.versions[0]['state'] = 'ready'
    result = await handle_deploy_app(dev, _request('publish', version=1, target='@public'))
    assert result['success'] is True
    assert result['body']['publish']['state'] == 'enabled'


@pytest.mark.asyncio
async def test_submit_is_latest_only(registry, quiet_push):
    """Only the NEWEST non-'failed' version may enter review — review
    tracks current work; older code that should ship is deployed again
    (new review = new version). A 'failed' newest row never shadows the
    real newest.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='private')
    registry.add_version(2, '1.1.0', publisher_id='u1', state='private')
    registry.add_version(3, '1.2.0', publisher_id='u1', state='failed')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    refused = await handle_deploy_app(dev, _request('submit', version=1))
    assert refused['success'] is False
    assert 'newest' in refused['message']
    assert registry.versions[0]['state'] == 'private'  # nothing moved

    # v2 is the newest LIVE version — the failed v3 does not shadow it.
    result = await handle_deploy_app(dev, _request('submit', version=2))
    assert result['success'] is True
    assert registry.versions[1]['state'] == 'submit'


@pytest.mark.asyncio
async def test_withdraw_cancels_a_pending_review(registry, quiet_push):
    """The developer's own cancel: withdraw flips submit -> private (back to
    draft, out of the admin queue). Only 'submit' withdraws — every other
    state is refused with the version's actual state named — and only the
    developer org may do it.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='submit')
    registry.add_version(2, '1.1.0', publisher_id='u1', state='ready')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    result = await handle_deploy_app(dev, _request('withdraw', version=1))
    assert result['success'] is True
    assert result['body']['artifact']['state'] == 'private'
    assert registry.versions[0]['state'] == 'private'

    # A version not in review is refused, naming its actual state.
    refused = await handle_deploy_app(dev, _request('withdraw', version=2))
    assert refused['success'] is False
    assert 'not in review' in refused['message']
    assert registry.versions[1]['state'] == 'ready'

    # Only the developer namespace owner may withdraw.
    registry.versions[0]['state'] = 'submit'
    outsider = _FakeConn(teams=_TEAMS, developer_id='evil')
    blocked = await handle_deploy_app(outsider, _request('withdraw', version=1))
    assert blocked['success'] is False


@pytest.mark.asyncio
async def test_reply_appends_a_developer_thread_row(registry):
    """The developer half of the review conversation: reply writes ONE
    'reply' history row under the home org with side 'developer', version
    unstamped unless given. No state moves, no broadcast.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='submit')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    result = await handle_deploy_app(dev, _request('reply', message='On it - fix coming'))
    assert result['success'] is True
    assert result['body'] == {'replied': True, 'appId': 'acme.brandy'}
    assert len(registry.history) == 1
    row = registry.history[0]
    assert row['orgId'] == 'org1'
    assert row['projectId'] == 'acme.brandy'
    assert row['action'] == 'reply'
    assert row['version'] is None
    assert row['data'] == {'side': 'developer', 'message': 'On it - fix coming'}
    assert row['actor']['userId'] == 'u1'
    assert registry.versions[0]['state'] == 'submit'  # nothing moved

    # The version-stamped variant records the registry int on the row.
    versioned = await handle_deploy_app(dev, _request('reply', message='About v1', version=1))
    assert versioned['success'] is True
    assert registry.history[1]['version'] == 1


@pytest.mark.asyncio
async def test_reply_works_before_any_deploy(registry):
    """An empty rail still accepts a reply — the developer may open the
    conversation before the first submission (home-org resolution falls
    back to the caller org); only the namespace gate applies.
    """
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    result = await handle_deploy_app(dev, _request('reply', message='Question before I submit'))
    assert result['success'] is True
    assert len(registry.history) == 1
    assert registry.history[0]['data']['side'] == 'developer'


@pytest.mark.asyncio
async def test_reply_validates_message_and_gates(registry):
    """Refusals: empty/whitespace message, over-cap message, non-int
    version, foreign namespace, unregistered developer — and the history
    stream stays EMPTY on every refusal.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='submit')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    empty = await handle_deploy_app(dev, _request('reply', message='   '))
    assert empty['success'] is False
    assert 'message is required' in empty['message']

    over = await handle_deploy_app(dev, _request('reply', message='x' * (_REPLY_MAX_CHARS + 1)))
    assert over['success'] is False
    assert str(_REPLY_MAX_CHARS) in over['message']

    badver = await handle_deploy_app(dev, _request('reply', message='hi', version='1'))
    assert badver['success'] is False
    assert 'registry version' in badver['message']

    # Outside the caller org's developer namespace.
    outsider = _FakeConn(teams=_TEAMS, developer_id='evil')
    foreign = await handle_deploy_app(outsider, _request('reply', message='hi'))
    assert foreign['success'] is False
    assert 'namespace' in foreign['message']

    # No developer id registered at all.
    unregistered = _FakeConn(teams=_TEAMS, developer_id=None)
    blocked = await handle_deploy_app(unregistered, _request('reply', message='hi'))
    assert blocked['success'] is False
    assert 'developer id' in blocked['message']

    assert registry.history == []


@pytest.mark.asyncio
async def test_build_log_serves_the_stored_log(registry, content_store):
    """build_log reads the durable build.log beside the version's artifacts
    (developer-org only); a version with no log answers '' — a normal
    answer, not an error — and an unknown version is refused.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='private', build='failed')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    # Seed the log where the worker writes it: the artifactPath minus .json.
    content_root = 'orgs/org1/files/.deployments/acme.brandy/v000001-fakesha1'
    await Store.instance()._store.write_bytes(
        f'{content_root}/build.log', b'== install ==\n$ pnpm install\n\n== failed (install) ==\n[install] exit 1'
    )

    result = await handle_deploy_app(dev, _request('build_log', version=1))
    assert result['success'] is True
    assert result['body']['appId'] == 'acme.brandy'
    assert result['body']['version'] == 1
    assert '== failed (install) ==' in result['body']['log']

    # Missing log file = empty log, not an error.
    registry.add_version(2, '1.1.0', publisher_id='u1', state='private')
    empty = await handle_deploy_app(dev, _request('build_log', version=2))
    assert empty['success'] is True
    assert empty['body']['log'] == ''

    # Unknown version is refused by name.
    missing = await handle_deploy_app(dev, _request('build_log', version=9))
    assert missing['success'] is False
    assert 'no registry version 9' in missing['message']

    # Version must be an int.
    badver = await handle_deploy_app(dev, _request('build_log', version='1'))
    assert badver['success'] is False


@pytest.mark.asyncio
async def test_submit_flips_the_deployment_into_review(registry, quiet_push):
    """The 'Submit for review' verb flips the DEPLOYMENT private -> submit."""
    registry.add_version(1, '1.0.0', publisher_id='u1', state='private')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    result = await handle_deploy_app(dev, _request('submit', version=1))
    assert result['success'] is True
    assert result['body']['artifact']['state'] == 'submit'
    assert registry.versions[0]['state'] == 'submit'

    # Only the developer namespace owner may submit.
    outsider = _FakeConn(teams=_TEAMS, developer_id='evil')
    refused = await handle_deploy_app(outsider, _request('submit', version=1))
    assert refused['success'] is False


class _EventConn:
    """Receiving-side connection fake for review-state push targeting."""

    def __init__(self, org_id='', perms=None, auth='rr_session'):
        self._account_info = SimpleNamespace(
            userId='u-recv',
            auth=auth,
            organization={'id': org_id} if org_id else None,
            sysPermissions=perms or [],
        )
        self.events = []

    async def send_event(self, name, body=None):
        """Record every push so the test asserts exact delivery."""
        self.events.append((name, body))


@pytest.mark.asyncio
async def test_review_transitions_push_both_signals(registry, quiet_push):
    """submit/withdraw push the org-scoped rail invalidation AND the typed
    app:statusChanged event — delivered to the owning org and to cross-org
    reviewers (sys.app/sys.admin), never to strangers or task sockets.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1', state='private')
    dev = _FakeConn(teams=_TEAMS, developer_id='acme')

    broadcasts = []

    async def broadcast_server_event(event_type, message, org_id=None, user_id=None):
        broadcasts.append((message['event'], message['body'], org_id))

    owner = _EventConn(org_id='org1')
    reviewer = _EventConn(org_id='other-org', perms=['sys.app'])
    stranger = _EventConn(org_id='other-org')
    task_socket = _EventConn(org_id='org1', auth='pk_task')
    dev._server = SimpleNamespace(
        broadcast_server_event=broadcast_server_event,
        _connections={'a': owner, 'b': reviewer, 'c': stranger, 'd': task_socket},
    )

    result = await handle_deploy_app(dev, _request('submit', version=1))
    assert result['success'] is True
    # Signal 1: the org-scoped apaevt_deploy invalidation.
    assert broadcasts == [
        ('apaevt_deploy', {'orgId': 'org1', 'teamId': '', 'projectId': 'acme.brandy', 'action': 'submit'}, 'org1')
    ]
    # Signal 2: the typed status push — owner org + reviewer only.
    submit_body = {'appId': 'acme.brandy', 'version': 1, 'status': 'submit'}
    assert owner.events == [('app:statusChanged', submit_body)]
    assert reviewer.events == [('app:statusChanged', submit_body)]
    assert stranger.events == []
    assert task_socket.events == []

    # Withdraw pushes the same pair with the returned-to-draft state.
    broadcasts.clear()
    owner.events.clear()
    reviewer.events.clear()
    result = await handle_deploy_app(dev, _request('withdraw', version=1))
    assert result['success'] is True
    assert broadcasts == [
        ('apaevt_deploy', {'orgId': 'org1', 'teamId': '', 'projectId': 'acme.brandy', 'action': 'private'}, 'org1')
    ]
    withdraw_body = {'appId': 'acme.brandy', 'version': 1, 'status': 'private'}
    assert owner.events == [('app:statusChanged', withdraw_body)]
    assert reviewer.events == [('app:statusChanged', withdraw_body)]
    assert stranger.events == []
    assert task_socket.events == []


@pytest.mark.asyncio
async def test_publish_blocked_outside_developer_namespace(registry, quiet_push):
    """THE cross-org guarantee: an org can only publish app ids inside its own
    developer namespace — to ANY audience. An attacker who got a rival's (or a
    forged, via the pipe path) app id onto their own rail still cannot bind it,
    because acme.brandy is not in the 'evil' namespace. This is what makes
    cross-org impersonation of an app id impossible.
    """
    registry.add_version(1, '9.9.9', publisher_id='u1', state='ready')
    attacker = _FakeConn(teams=_TEAMS, developer_id='evil')

    # Every audience is refused — public, team, and self alike.
    for target in ('@public', '@team/Development', '@user'):
        refused = await handle_deploy_app(attacker, _request('publish', version=1, target=target))
        assert refused['success'] is False
        assert 'namespace' in refused['message'], target
    # Nothing was ever bound.
    assert registry.set_calls == []


@pytest.mark.asyncio
async def test_publish_allowed_inside_own_namespace(registry, quiet_push):
    """The guarantee never blocks the owner: acme may publish acme.brandy."""
    registry.add_version(1, '1.0.0', publisher_id='u1', state='ready')
    registry.add_version(2, '2.0.0', publisher_id='u1', state='ready')
    owner = _FakeConn(teams=_TEAMS, developer_id='acme')

    result = await handle_deploy_app(owner, _request('publish', version=2, target='@public'))
    assert result['success'] is True


@pytest.mark.asyncio
async def test_publish_failed_artifact_never_publishes(registry, quiet_push):
    """A 'failed' artifact is unpublishable to ANY audience."""
    registry.add_version(1, '1.0.0', publisher_id='u1', state='failed')
    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target='@team/Development'))
    assert result['success'] is False
    assert 'failed processing' in result['message']


# =============================================================================
# WHERE — the caller-visible reverse index
# =============================================================================


@pytest.mark.asyncio
async def test_where_lists_visible_rows_with_deployment_states(registry):
    """The reverse index shows the caller's user/team bindings + the public
    binding; each pin's ``state`` is the bound DEPLOYMENT's review state.
    """
    registry.add_version(1, '1.0.0', state='ready')
    registry.add_version(2, '1.1.0', state='submit')
    registry.seed_publish(AUD_USER, 1)
    registry.seed_publish(AUD_TEAM, 2)
    registry.seed_publish(AUD_PUBLIC, 2)
    registry.seed_publish({'type': 'user', 'id': 'someone-else'}, 2)  # invisible

    conn = _FakeConn(teams=_TEAMS)  # developer of acme.brandy -> sees all states
    result = await handle_deploy_app(conn, _request('where'))

    pins = {(p['rung'], p['handle'], p['version'], p['state']) for p in result['body']['pins']}
    # Personal reads back as '@me' — the ONE personal spelling everywhere
    # ('@user' stays accepted on input, never shown).
    assert pins == {
        ('personal', '@me', 1, 'ready'),
        ('team', '@team/Development', 2, 'submit'),
        ('public', '@public', 2, 'submit'),
    }


# =============================================================================
# DISABLE / REMOVE — audience state flips
# =============================================================================


@pytest.mark.asyncio
async def test_disable_flips_the_audience_row(registry):
    """disable/remove resolve the target audience and flip its row state."""
    registry.add_version(1, '1.0.0')
    registry.seed_publish(AUD_TEAM, 1)

    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('disable', target='@team/Development'))
    assert result['success'] is True
    assert result['body']['publish']['state'] == 'disabled'


# =============================================================================
# SERVING RESOLVERS — the /apps/<appId>/v<N>/ route's entitlement backing
# =============================================================================
# The `entry` verb is retired: nothing is minted. Clients construct the
# stable versioned URL from a version number, and the serve route asks
# these resolvers which versions the caller may fetch.


def _info(user_id='u1', org_id='org1', teams=None):
    """The AccountInfo stand-in the serve-route resolvers receive."""
    return SimpleNamespace(
        userId=user_id,
        organization={'id': org_id, 'teams': _TEAMS if teams is None else teams},
    )


# The dist/ dir the fake's v1 artifactPath maps to — the .json sibling's
# content dir (the layout both the build worker and the seeder write).
_V1_DIST = 'orgs/org1/files/.deployments/acme.brandy/v000001-fakesha1/dist'


@pytest.mark.asyncio
async def test_entitled_dirs_from_visible_publishes(registry):
    """An enabled caller-visible binding entitles its version's dist tree."""
    registry.add_version(1, '1.0.0')
    registry.seed_publish(AUD_TEAM, 1)

    assert await entitled_version_dirs(_info(), 'acme.brandy') == {1: _V1_DIST}
    # A caller outside the team AND outside the developer org has no road
    # to it (org2 has no rail for the app; the binding is team-scoped).
    assert await entitled_version_dirs(_info(user_id='u2', org_id='org2', teams=[]), 'acme.brandy') == {}


@pytest.mark.asyncio
async def test_entitled_public_counts_only_when_deployment_ready(registry):
    """A public binding on an un-approved deployment grants nothing; once the
    DEPLOYMENT is 'ready' it serves everyone — anonymous callers included.
    """
    registry.add_version(1, '1.0.0', publisher_id='someone-else', state='submit')
    registry.seed_publish(AUD_PUBLIC, 1)

    assert await entitled_version_dirs(None, 'acme.brandy') == {}

    registry.versions[0]['state'] = 'ready'
    assert await entitled_version_dirs(None, 'acme.brandy') == {1: _V1_DIST}


@pytest.mark.asyncio
async def test_entitled_developer_org_before_any_publish(registry):
    """The developer ORG's own built rail is entitled with no binding at all
    (the developer flow — the version picker lists the rail published or
    not). Org-scoped: every org member gets serving parity with the DEPLOY
    view's rail visibility; a caller from another org gets nothing.
    """
    registry.add_version(1, '1.0.0', publisher_id='u1')

    assert await entitled_version_dirs(_info(), 'acme.brandy') == {1: _V1_DIST}
    # Same org, different user — the rail is the ORG's, not the deployer's.
    assert await entitled_version_dirs(_info(user_id='u2', teams=[]), 'acme.brandy') == {1: _V1_DIST}
    # Another org entirely: no rail, no binding, no road.
    assert await entitled_version_dirs(_info(user_id='u3', org_id='org2', teams=[]), 'acme.brandy') == {}


# =============================================================================
# BUILT GATE — a version serves/submits/publishes only once its build is ok
# =============================================================================


@pytest.mark.asyncio
async def test_entitled_excludes_unbuilt_and_failed_builds(registry):
    """An unbuilt version has an empty dist/ — never entitled, bound or not."""
    registry.add_version(1, '1.0.0', publisher_id='u1', build='building')
    registry.add_version(2, '1.0.1', publisher_id='u1', build='failed')
    registry.seed_publish(AUD_TEAM, 1)

    assert await entitled_version_dirs(_info(), 'acme.brandy') == {}


@pytest.mark.asyncio
async def test_open_dirs_serve_every_built_version(registry):
    """OSS serving is open: every BUILT version resolves, unbuilt never."""
    registry.add_version(1, '1.0.0')
    registry.add_version(2, '1.1.0', build='building')

    assert await open_version_dirs('acme.brandy') == {1: _V1_DIST}


@pytest.mark.asyncio
async def test_submit_requires_green_build(registry):
    """Every review-queue entry must be a real, servable candidate — submit
    refuses a version whose own build has not completed. Deploying NEW
    versions is never gated; the gate is per-version and self-referential.
    """
    registry.add_version(1, '1.0.0', state='private', build='building')
    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('submit', version=1))
    assert result['success'] is False
    assert 'still building' in result['message']

    # The build goes green -> the same submit succeeds.
    registry.versions[0]['metadata']['build']['status'] = 'ok'
    result = await handle_deploy_app(conn, _request('submit', version=1))
    assert result['success'] is True
    assert result['body']['artifact']['state'] == 'submit'


@pytest.mark.asyncio
async def test_publish_refuses_unbuilt_version(registry, quiet_push):
    """A binding must never point at a version with no servable bytes."""
    registry.add_version(1, '1.0.0', state='private', build='queued')
    conn = _FakeConn(teams=_TEAMS)
    result = await handle_deploy_app(conn, _request('publish', version=1, target='@team/Development'))
    assert result['success'] is False
    assert 'still building' in result['message']
    assert registry.set_calls == []


@pytest.mark.asyncio
async def test_resolve_app_pins_skips_unbuilt_versions(registry):
    """The scope walk serves a pin only once its version's build is ok —
    an unbuilt pin is silently absent from the manifest until then.
    """
    registry.add_version(1, '1.0.0', state='ready', build='building')
    registry.seed_publish(AUD_PUBLIC, 1)

    from ai.account.app_deploy import resolve_app_pins as resolve

    assert await resolve('org1', 'u1', ['t1']) == []

    registry.versions[0]['metadata']['build']['status'] = 'ok'
    resolved = await resolve('org1', 'u1', ['t1'])
    assert [e['id'] for e in resolved] == ['acme.brandy']


# =============================================================================
# RESOLVE — the manifest scope walk (user > team > public; serving gate)
# =============================================================================


@pytest.mark.asyncio
async def test_resolve_app_pins_most_specific_audience_wins(registry):
    """On id collisions the user binding beats team, team beats public."""
    registry.add_version(1, '1.0.0', state='ready')
    registry.add_version(2, '1.1.0', state='private')
    registry.seed_publish(AUD_PUBLIC, 1)  # deployment 1 is 'ready' -> public serves
    registry.seed_publish(AUD_USER, 2)  # deployment 2 is 'private' -> internal serves

    resolved = await resolve_app_pins('org1', 'u1', ['t1'])

    assert len(resolved) == 1
    assert resolved[0]['id'] == 'acme.brandy'
    assert resolved[0]['version'] == '1.1.0'
    assert resolved[0]['public'] is False
    # The wire carries the version NUMBER, never a URL — clients construct
    # /apps/<appId>/v<N>/remoteEntry.js from registryVersion themselves.
    assert resolved[0]['registryVersion'] == 2
    assert 'entry' not in resolved[0]


@pytest.mark.asyncio
async def test_resolve_public_serves_only_ready_deployments(registry):
    """A public binding whose deployment is not 'ready' never reaches the store;
    a disabled binding never serves.
    """
    registry.add_version(1, '1.0.0', state='submit')
    registry.seed_publish(AUD_PUBLIC, 1)  # deployment still in review -> hidden

    resolved = await resolve_app_pins('org1', 'other-user', [])
    assert resolved == []

    # Approve the deployment -> the public store now serves it.
    registry.versions[0]['state'] = 'ready'
    resolved = await resolve_app_pins('org1', 'other-user', [])
    assert [r['id'] for r in resolved] == ['acme.brandy']
    assert resolved[0]['public'] is True


@pytest.mark.asyncio
async def test_resolve_internal_serves_unapproved_but_not_failed(registry):
    """Internal (team/user) bindings serve any internal-eligible deployment
    ('private'/'submit'/'ready') but never a 'failed' one.
    """
    registry.add_version(1, '1.0.0', state='submit')
    registry.seed_publish(AUD_TEAM, 1)

    resolved = await resolve_app_pins('org1', 'u1', ['t1'])
    assert [r['id'] for r in resolved] == ['acme.brandy']

    registry.versions[0]['state'] = 'failed'
    resolved = await resolve_app_pins('org1', 'u1', ['t1'])
    assert resolved == []
