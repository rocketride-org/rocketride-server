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

# ruff: noqa: F811  (imported pytest fixtures are used by name as test arguments)
"""Isolation stamp and deploy hardening (#1022 PR1, design sections 1, 8, Appendix C).

* ``resolve_app_pins`` stamps each entry with ``firstParty`` / ``isolated`` from
  ``resolve_isolation(app_id, winning_row_org)``; with the mode ``off`` it adds
  nothing; the binding org never leaves it. (T31)
* ``handle_app_add`` removes ``platform`` from the caller's metadata (only the
  seeder writes it), validates ``appManifest.network`` with ``validate_network``
  and ``appManifest.capabilities`` against ``capabilities.json``, and refuses the
  deploy on failure, in every mode. (T36, T37, T38)
* the OSS base ``is_first_party`` is ``metadata.platform is True`` and the
  binding org is ``local``; the seeder is the only writer of the flag.
"""

from __future__ import annotations

import pytest

import ai.modules.shell.shell as shell_mod

# Reuse the deploy suite's fakes: the real handler runs over its in-memory registry.
from tests.ai.account.test_app_deploy import (  # noqa: F401  (fixtures are injected by name)
    _add_request,
    _app_zip,
    _FakeConn,
    content_store,
    registry as deploy_registry,
)
from tests.ai.modules.shell import isolation_support as sup


def _ao():
    return sup.load_module('ai.modules.shell.app_origin')


@pytest.fixture
def stamp_env(tmp_path, monkeypatch):
    """A valid ``enforce`` configuration (the stamp only needs the mode and the app list)."""
    static = sup.write_static_tree(tmp_path)
    monkeypatch.setattr(shell_mod, '_shell_root', str(static / 'shell'))
    sup.apply_env(monkeypatch, sup.valid_env())

    def set_vars(**overrides):
        for name, value in overrides.items():
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)

    return set_vars


@pytest.fixture
def pins(monkeypatch):
    """A SaaS-edition fake registry; ``first_party`` models PR4a's AppProduct rule."""
    return sup.FakeRegistry().install(monkeypatch, saas=True)


# ---------------------------------------------------------------------------
# T31 the stamp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_app_pins_stamps_first_party(pins, stamp_env):
    """T31 (behavioural): the scope-walk winner's binding org decides ``firstParty``; ``isolated`` follows.

    * a platform app bound by the platform org is first party, not isolated;
    * a platform-looking id bound by ANOTHER org is isolated (``rocketride.evil``);
    * an app the account does not know as the platform's (no AppProduct) is isolated;
    * a gated platform app (``requiredPermissions``) arriving through connect is first party.
    """
    from ai.account.app_deploy import resolve_app_pins

    pins.add('rocketride.home', 1, org='platform-org', platform=True)
    pins.add('rocketride.evil', 1, org='evil-org')  # a non-platform org publishing a platform-looking id
    pins.add('acme.thirdparty', 1, org='acme-org')  # no AppProduct: unknown to the platform
    pins.add('rocketride.gated', 1, org='platform-org', platform=True, required=['app.finance'])
    pins.add('acme.teamapp', 1, org='acme-org', audience=('team', 't1'), deploy_state='private')

    entries = {e['id']: e for e in await resolve_app_pins('org-1', 'u1', ['t1'])}
    assert set(entries) == {'rocketride.home', 'rocketride.evil', 'acme.thirdparty', 'rocketride.gated', 'acme.teamapp'}

    for app_id, first_party in (
        ('rocketride.home', True),
        ('rocketride.gated', True),
        ('rocketride.evil', False),
        ('acme.thirdparty', False),
        ('acme.teamapp', False),
    ):
        entry = entries[app_id]
        assert entry.get('firstParty') is first_party, app_id
        assert entry.get('isolated') is (not first_party), app_id
        assert 'bindingOrgId' not in entry and 'orgId' not in entry, app_id


@pytest.mark.asyncio
async def test_a_platform_app_published_by_two_orgs_is_stamped_by_the_winner(pins, stamp_env):
    """T31: the stamp follows the row that WINS the scope walk (lowest org id on a tie), not any row."""
    from ai.account.app_deploy import resolve_app_pins

    pins.add('rocketride.home', 1, org='aaa-evil')  # wins the tie (lowest org id), not the platform's
    pins.add('rocketride.home', 2, org='platform-org', platform=True)
    entries = await resolve_app_pins('org-1', 'u1', [])
    (entry,) = [e for e in entries if e['id'] == 'rocketride.home']
    assert entry['registryVersion'] == 1
    assert (entry.get('firstParty'), entry.get('isolated')) == (False, True)


@pytest.mark.asyncio
async def test_stamp_fails_closed_when_the_account_check_errors(pins, stamp_env, monkeypatch):
    """T31: an account that cannot answer ``is_first_party`` never makes an app first party."""
    from ai.account import account
    from ai.account.app_deploy import resolve_app_pins

    async def broken(app_id, binding_org_id):
        raise RuntimeError('database unavailable')

    monkeypatch.setattr(account, 'is_first_party', broken, raising=False)
    pins.add('rocketride.home', 1, org='platform-org', platform=True)
    (entry,) = await resolve_app_pins('org-1', 'u1', [])
    assert (entry.get('firstParty'), entry.get('isolated')) == (False, True)


@pytest.mark.asyncio
async def test_optin_isolates_only_listed_apps_and_never_first_party(pins, stamp_env):
    """T31: ``optin`` isolates the listed third-party apps only; first party stays in-realm even if listed."""
    from ai.account.app_deploy import resolve_app_pins

    stamp_env(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS='acme.listed,rocketride.home')
    pins.add('acme.listed', 1, org='acme-org')
    pins.add('acme.unlisted', 1, org='acme-org')
    pins.add('rocketride.home', 1, org='platform-org', platform=True)
    entries = {e['id']: e for e in await resolve_app_pins('org-1', 'u1', [])}
    assert entries['acme.listed']['isolated'] is True
    assert entries['acme.unlisted']['isolated'] is False and entries['acme.unlisted']['firstParty'] is False
    assert entries['rocketride.home']['isolated'] is False and entries['rocketride.home']['firstParty'] is True


@pytest.mark.asyncio
async def test_resolve_app_pins_off_adds_nothing(pins, stamp_env):
    """T31/T40 (guard): with the mode ``off`` an entry has no ``firstParty`` or ``isolated`` key at all."""
    from ai.account.app_deploy import resolve_app_pins

    stamp_env(RR_APP_ISOLATION=None)
    pins.add('acme.thirdparty', 1, org='acme-org')
    pins.add('rocketride.home', 1, org='platform-org', platform=True)
    for entry in await resolve_app_pins('org-1', 'u1', []):
        assert 'firstParty' not in entry and 'isolated' not in entry, entry['id']


class _Rail:
    """A fake account whose ``deployments_versions`` returns one rail per app id (on org ``local``)."""

    def __init__(self, rails):
        self.rails = rails
        self.orgs = []

    async def deployments_versions(self, org_id, app_id):
        self.orgs.append(org_id)
        return [dict(e) for e in self.rails.get(app_id, [])]


def _row(version, metadata, kind='app'):
    return {'version': version, 'kind': kind, 'metadata': metadata}


SEEDED = {'platform': True, 'build': {'status': 'ok', 'seeded': True}}
USER_DEPLOY = {'build': {'status': 'ok'}}


@pytest.mark.asyncio
async def test_oss_base_is_first_party_rule(monkeypatch):
    """T31: OSS base = every app version is the seeder's (``metadata.platform is True``) AND binding org ``local``."""
    from ai.account.base import AccountBase

    method = sup.need(AccountBase, 'is_first_party')
    fake = _Rail(
        {
            'rocketride.home': [_row(1, SEEDED)],
            'acme.mine': [_row(1, {})],
            'acme.liar': [_row(1, {'platform': 'true'})],
        }
    )
    assert await method(fake, 'rocketride.home', 'local') is True
    assert await method(fake, 'rocketride.home', 'acme-org') is False  # platform flag, wrong binding org
    assert await method(fake, 'acme.mine', 'local') is False
    assert await method(fake, 'acme.liar', 'local') is False  # only the boolean True counts
    assert await method(fake, 'acme.unknown', 'local') is False


@pytest.mark.asyncio
async def test_oss_seeded_app_plus_one_user_deploy_is_not_first_party():
    """T31 (G4 S6): one version on the rail that the seeder did not write makes the app third party."""
    from ai.account.base import AccountBase

    fake = _Rail({'rocketride.home': [_row(2, USER_DEPLOY), _row(1, SEEDED)]})
    assert await AccountBase.is_first_party(fake, 'rocketride.home', 'local') is False


@pytest.mark.asyncio
async def test_oss_legacy_seeded_rows_use_the_build_stamp_and_platform_wins():
    """T31 (G4 S6): rows seeded before the platform flag carry only ``build.seeded``; where both exist, platform decides."""
    from ai.account.base import AccountBase

    legacy = {'build': {'status': 'ok', 'seeded': True}}
    fake = _Rail(
        {
            'rocketride.legacy': [_row(1, legacy)],
            'rocketride.mixed': [_row(2, SEEDED), _row(1, legacy)],
            'rocketride.denied': [_row(1, {'platform': False, 'build': {'status': 'ok', 'seeded': True}})],
        }
    )
    assert await AccountBase.is_first_party(fake, 'rocketride.legacy', 'local') is True
    assert await AccountBase.is_first_party(fake, 'rocketride.mixed', 'local') is True
    assert await AccountBase.is_first_party(fake, 'rocketride.denied', 'local') is False


@pytest.mark.asyncio
async def test_oss_first_party_reads_only_app_rows():
    """T31 (G4 S6): a pipe row on the same rail (any metadata) neither makes nor breaks first party."""
    from ai.account.base import AccountBase

    pipe_claims = {'platform': True, 'build': {'seeded': True}}
    fake = _Rail(
        {
            'rocketride.home': [_row(2, {}, kind='pipe'), _row(1, SEEDED)],
            'acme.pipeonly': [_row(1, pipe_claims, kind='pipe')],
        }
    )
    assert await AccountBase.is_first_party(fake, 'rocketride.home', 'local') is True
    assert await AccountBase.is_first_party(fake, 'acme.pipeonly', 'local') is False


@pytest.mark.asyncio
async def test_deployments_publish_strips_server_owned_keys_from_pipes():
    """G4 S6: the shared publish door drops platform, approvedCapabilities and build from a pipe's metadata."""
    from types import SimpleNamespace

    from ai.account.base import AccountBase

    calls = []

    class Backend:
        async def publish(self, org_id, project_id, pipeline, actor, comment, metadata=None, state=None):
            calls.append(metadata)
            return {'version': 1}

    fake = SimpleNamespace(_deployment_backend=lambda: Backend())
    metadata = {'platform': True, 'approvedCapabilities': ['fs.app'], 'build': {'seeded': True}, 'note': 1}
    await AccountBase.deployments_publish(fake, 'local', 'p1', {'kind': 'pipe', 'name': 'P'}, {}, metadata=metadata)
    await AccountBase.deployments_publish(fake, 'local', 'p1', {'name': 'P'}, {}, metadata=dict(metadata))
    assert calls[0] == {'note': 1, 'platform': False} and calls[1] == {'note': 1, 'platform': False}
    # app artifacts come only through handle_app_add (which strips the caller's keys) and the seeder
    await AccountBase.deployments_publish(fake, 'local', 'a1', {'kind': 'app'}, {}, metadata=dict(metadata))
    assert calls[2] == metadata


@pytest.mark.asyncio
async def test_seeded_deployments_carry_the_platform_flag(monkeypatch, tmp_path):
    """T31: ``seed_app`` is the ONE writer of ``metadata.platform`` (the seeder's rows are the platform's)."""
    from ai.account import seed_apps

    monkeypatch.setattr(seed_apps, '_local_bundle_root', lambda app_id: str(tmp_path / app_id))

    async def copied(app_id, artifact_path):
        return 1

    monkeypatch.setattr(seed_apps, 'copy_bundle_to_store', copied)
    published = []

    class Registry:
        async def deployments_publish(self, org_id, app_id, artifact, actor, *, comment, metadata, state):
            published.append(metadata)
            return {'version': 1, 'artifactPath': f'.deployments/{app_id}/v1-abcdef12.json', 'metadata': metadata}

    entry = {'id': 'rocketride.home', 'name': 'Home', 'version': '1.0.0'}
    await seed_apps.seed_app(Registry(), 'local', entry, seed_apps.SYSTEM_ACTOR)
    assert published[0].get('platform') is True


# ---------------------------------------------------------------------------
# T36 platform cannot be set by a caller
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_app_add_strips_platform(deploy_registry, content_store):
    """T36 (behavioural): ``metadata.platform`` from the caller never reaches the stored deployment.

    Today the caller's metadata is merged verbatim, so any developer could mark
    their own deployment as the platform's.
    """
    from ai.account.app_deploy import handle_app_add

    conn = _FakeConn()
    result = await handle_app_add(
        conn, _add_request(data=_app_zip(), metadata={'platform': True, 'projectId': 'wc-1', 'note': 'keep me'})
    )
    assert result['success'] is True
    stored = deploy_registry.publish_calls[0]['metadata']
    assert stored['platform'] is False  # written explicitly by the server (G4 round 2 SHOULD-3)
    assert stored['projectId'] == 'wc-1' and stored['note'] == 'keep me'  # the rest of the caller's metadata survives
    assert 'platform' not in stored['manifest']


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [True, False, 'true', 1, {'x': 1}])
async def test_platform_is_stripped_whatever_its_value(value, deploy_registry, content_store):
    """T36: any shape of the key is removed, not only ``true``."""
    from ai.account.app_deploy import handle_app_add

    await handle_app_add(_FakeConn(), _add_request(data=_app_zip(), metadata={'platform': value}))
    assert deploy_registry.publish_calls[0]['metadata']['platform'] is False


# ---------------------------------------------------------------------------
# T37 appManifest.network
# ---------------------------------------------------------------------------

BAD_NETWORK = [
    'https://a.example.com;',
    "https://a.example.com 'unsafe-eval'",
    "'unsafe-eval'",
    '*',
    'https://*.example.com',
    'https:',
    'data:',
    'blob:',
    'https://a.example.com b.example.com',  # whitespace: a second source
    ' https://a.example.com',
    'https://a.example.com ',
    'https://a.example.com/path',
    'https://a.example.com?x=1',
    'https://a.example.com#f',
    'https://user@a.example.com',
    'http://a.example.com',  # plain http
    'https://localhost',
    'https://localhost:8080',
    'https://127.0.0.1',
    'https://10.0.0.1:443',
    'https://[::1]',
    'https://[::1]:8443',
    'https://a.example.com:0',
    'https://a.example.com:70000',
    'https://a.example.com:65536',
    'https://a.example.com:',
    'https://a.example.com\n',
    'https://a.example.com\r\nx',
    'https://A.EXAMPLE.COM',  # lowercase only
    'https://singlelabel',
    'https://-a.example.com',
    'https://a-.example.com',
    'https://a..example.com',
    'https://' + 'a' * 64 + '.example.com',  # a label of 64 characters
    'https://a.example.com:\u0668\u0660',  # Unicode digits are not a port (G4 L6)
    'https://a.example.com:\u00b2',
    '',
    None,
    5,
    ['https://a.example.com'],
]


@pytest.mark.parametrize('entry', BAD_NETWORK, ids=lambda e: repr(e)[:40])
def test_network_grammar_negatives(entry):
    """T37: ``validate_network`` refuses every entry of the negative table and names it."""
    validate = sup.need(_ao(), 'validate_network')
    with pytest.raises(ValueError):
        validate([entry])


@pytest.mark.parametrize(
    'entry', ['https://app.example', 'https://api.app.example', 'https://saas.example', 'https://x.saas.example']
)
def test_network_refuses_the_shell_hosts(entry, monkeypatch):
    """T37 (G4 M2): a network origin on a shell host (or RR_APP_URL's) is refused, in every mode."""
    validate = sup.need(_ao(), 'validate_network')
    sup.apply_env(monkeypatch, {'RR_SHELL_ORIGINS': 'https://app.example', 'RR_APP_URL': 'https://saas.example'})
    with pytest.raises(ValueError):
        validate([entry])
    assert validate(['https://api.example.com']) == ['https://api.example.com']


def test_network_grammar_positives_and_limits():
    """T37: the strict ``https://host[:port]`` grammar, at most 8 entries, normalised to a list of strings."""
    validate = sup.need(_ao(), 'validate_network')
    good = [
        'https://api.example.com',
        'https://cdn.example.org:8443',
        'https://a-b.c1.example.io:1',
        'https://x.yz:65535',
    ]
    assert list(validate(good)) == good
    assert list(validate([])) == []
    assert len(validate(['https://h%d.example.com' % i for i in range(8)])) == 8
    with pytest.raises(ValueError):
        validate(['https://h%d.example.com' % i for i in range(9)])  # at most 8
    with pytest.raises(ValueError):
        validate('https://api.example.com')  # a list, not a string
    with pytest.raises(ValueError):
        validate(None)


@pytest.mark.asyncio
@pytest.mark.parametrize('entry', [e for e in BAD_NETWORK if isinstance(e, str) and e][:12] + ['*', 'data:'])
async def test_deploy_refuses_a_bad_network_entry(entry, deploy_registry, content_store):
    """T37 (behavioural): ``handle_app_add`` refuses the deploy naming ``network``; nothing is registered or stored.

    Today the manifest is stored verbatim, so ``network`` could later be spliced into a CSP.
    """
    from ai.account.app_deploy import handle_app_add

    manifest = {'id': 'acme.brandy', 'name': 'Brandy', 'network': [entry]}
    result = await handle_app_add(_FakeConn(), _add_request(data=_app_zip(manifest=manifest)))
    assert result['success'] is False, entry
    assert 'network' in result['message']
    assert deploy_registry.publish_calls == []


@pytest.mark.asyncio
async def test_deploy_refuses_network_that_is_not_a_list_or_too_long(deploy_registry, content_store):
    """T37: shape errors are refused too."""
    from ai.account.app_deploy import handle_app_add

    for network in ('https://a.example.com', {'a': 1}, ['https://h%d.example.com' % i for i in range(9)]):
        manifest = {'id': 'acme.brandy', 'name': 'Brandy', 'network': network}
        result = await handle_app_add(_FakeConn(), _add_request(data=_app_zip(manifest=manifest)))
        assert result['success'] is False
        assert 'network' in result['message']
    assert deploy_registry.publish_calls == []


@pytest.mark.asyncio
async def test_deploy_accepts_a_valid_network_and_an_absent_one(deploy_registry, content_store):
    """T37 control: a valid list is stored as declared; an absent field is the old behaviour."""
    from ai.account.app_deploy import handle_app_add

    manifest = {'id': 'acme.brandy', 'name': 'Brandy', 'network': ['https://api.example.com']}
    assert (await handle_app_add(_FakeConn(), _add_request(data=_app_zip(manifest=manifest))))['success'] is True
    assert deploy_registry.publish_calls[0]['metadata']['manifest']['network'] == ['https://api.example.com']
    assert (await handle_app_add(_FakeConn(), _add_request(data=_app_zip())))['success'] is True
    assert 'network' not in deploy_registry.publish_calls[1]['metadata']['manifest']


# ---------------------------------------------------------------------------
# T38 appManifest.capabilities
# ---------------------------------------------------------------------------


@pytest.fixture
def capabilities_file(tmp_path, monkeypatch):
    """The data file ``handle_app_add`` validates against: ``<_shell_root>/isolation/capabilities.json``."""
    static = sup.write_static_tree(tmp_path)
    monkeypatch.setattr(shell_mod, '_shell_root', str(static / 'shell'))
    return static


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'capabilities',
    [
        ['admin'],
        ['core', 'root'],
        ['pipelines.run', 'pipelines.RUN'],
        ['fs'],
        ['*'],
        [''],
        [None],
        [5],
        [['core']],
        'core',
        {'core': True},
        ['core', 'core;x'],
        ['pipelines.run\n'],
    ],
    ids=repr,
)
async def test_capabilities_rejects_unknown_names(capabilities, capabilities_file, deploy_registry, content_store):
    """T38 (behavioural): a capability that is not in ``capabilities.json`` (or not a list of names) refuses the deploy."""
    from ai.account.app_deploy import handle_app_add

    manifest = {'id': 'acme.brandy', 'name': 'Brandy', 'capabilities': capabilities}
    result = await handle_app_add(_FakeConn(), _add_request(data=_app_zip(manifest=manifest)))
    assert result['success'] is False, capabilities
    assert 'capabilities' in result['message']
    assert deploy_registry.publish_calls == []


@pytest.mark.asyncio
async def test_capabilities_accepts_known_names_and_absent(capabilities_file, deploy_registry, content_store):
    """T38 control: the v1 names pass; an absent field is unchanged behaviour (the grant is the admin's, not the manifest's)."""
    from ai.account.app_deploy import handle_app_add

    manifest = {'id': 'acme.brandy', 'name': 'Brandy', 'capabilities': ['core', 'pipelines.run', 'fs.app']}
    assert (await handle_app_add(_FakeConn(), _add_request(data=_app_zip(manifest=manifest))))['success'] is True
    assert (await handle_app_add(_FakeConn(), _add_request(data=_app_zip())))['success'] is True
    # a request is not a grant: nothing in the stored metadata approves it
    assert 'approvedCapabilities' not in deploy_registry.publish_calls[0]['metadata']
    assert 'approvedCapabilities' not in deploy_registry.publish_calls[0]['metadata']['manifest']


def _grant_account(*, previous=None, read_fails=False, rollback_fails=False):
    """A fake account whose registry records every grant write (``(caps, only_if)``) and whose history write fails."""
    writes = []

    class _Backend:
        async def set_approved_capabilities(self, org_id, app_id, version, caps, only_if=None):
            writes.append((list(caps), None if only_if is None else list(only_if)))
            if only_if is not None and rollback_fails:
                raise RuntimeError('registry down')
            return {'version': version, 'metadata': {'approvedCapabilities': list(caps)}}

    class _Account:
        def _deployment_backend(self):
            return _Backend()

        async def deployments_versions(self, org_id, app_id):
            if read_fails:
                raise RuntimeError('registry read failed')
            return [{'version': 1, 'metadata': {'approvedCapabilities': list(previous)} if previous else {}}]

        async def deployments_history_append(self, *args, **kwargs):
            raise RuntimeError('audit store down')

    return _Account(), writes


@pytest.mark.asyncio
async def test_a_grant_whose_audit_entry_fails_is_rolled_back_only_if_still_the_stored_grant(monkeypatch):
    """The audit write fails: the earlier grant is restored, but only while the stored value is still this call's."""
    from ai.account.base import AccountBase

    ao = _ao()
    monkeypatch.setattr(ao, 'known_capabilities', lambda: frozenset({'core', 'pipelines.run'}))
    account, writes = _grant_account(previous=['core'])

    with pytest.raises(RuntimeError, match='audit store down'):
        await AccountBase.set_approved_capabilities(
            account, 'org', 'acme.app', 1, ['core', 'pipelines.run'], {'id': 'admin'}
        )
    assert writes == [(['core', 'pipelines.run'], None), (['core'], ['core', 'pipelines.run'])]


@pytest.mark.asyncio
async def test_a_failed_rollback_is_logged_and_the_audit_error_still_surfaces(monkeypatch):
    """A rollback that fails does not hide the audit failure, and it is logged at warning level."""
    import rocketlib
    from ai.account.base import AccountBase

    ao = _ao()
    monkeypatch.setattr(ao, 'known_capabilities', lambda: frozenset({'core', 'pipelines.run'}))
    logged = []
    monkeypatch.setattr(rocketlib, 'warning', lambda message: logged.append(message), raising=False)
    account, writes = _grant_account(rollback_fails=True)

    with pytest.raises(RuntimeError, match='audit store down'):
        await AccountBase.set_approved_capabilities(
            account, 'org', 'acme.app', 1, ['core', 'pipelines.run'], {'id': 'admin'}
        )
    assert len(writes) == 2
    assert len(logged) == 1 and 'could not be rolled back' in logged[0] and 'registry down' in logged[0]


@pytest.mark.asyncio
async def test_a_grant_is_not_written_when_the_earlier_grant_cannot_be_read(monkeypatch):
    """A read error stops the call before any write: it never becomes a rollback to the default grant."""
    from ai.account.base import AccountBase

    ao = _ao()
    monkeypatch.setattr(ao, 'known_capabilities', lambda: frozenset({'core', 'pipelines.run'}))
    account, writes = _grant_account(read_fails=True)

    with pytest.raises(RuntimeError, match='registry read failed'):
        await AccountBase.set_approved_capabilities(
            account, 'org', 'acme.app', 1, ['core', 'pipelines.run'], {'id': 'admin'}
        )
    assert writes == []


@pytest.mark.asyncio
async def test_approved_capabilities_still_defaults_to_core_on_a_read_error():
    """The reading side keeps its fail-safe answer: an unreadable registry grants only ``core``."""
    from ai.account.base import AccountBase

    class _Account:
        async def deployments_versions(self, org_id, app_id):
            raise RuntimeError('registry read failed')

    assert await AccountBase.approved_capabilities(_Account(), 'org', 'acme.app', 1) == ['core']
