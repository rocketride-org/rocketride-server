# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Deciding which published nodes a run has to fetch.

What these pin is the decision, not the fetching: that a pipeline of stock
nodes resolves to nothing at all, that a node with no pin stops the run before
any bytes move, and that the failure names what is missing and where it looked.
"""

from __future__ import annotations

import pytest

from ai.account import node_resolve


def _pipeline(*providers):
    """A pipeline shell carrying one component per provider named."""
    return {'components': [{'provider': name, 'config': {}} for name in providers]}


@pytest.fixture
def published(monkeypatch):
    """Whatever the caller has pins for, keyed by node id."""
    entries = {}

    async def resolve_node_pins(org_id, user_id, team_ids):
        return list(entries.values())

    monkeypatch.setattr(node_resolve, 'resolve_node_pins', resolve_node_pins)

    def add(node_id, version=1, **extra):
        entries[node_id] = {'id': node_id, 'version': version, 'requirements': [], **extra}

    return add


# =============================================================================
# DETECTION
# =============================================================================


class TestProviders:
    """Reading what a pipeline asks for."""

    def test_every_provider_is_named(self):
        assert node_resolve.providers_of(_pipeline('llm_openai', 'store_chroma')) == {'llm_openai', 'store_chroma'}

    def test_a_provider_used_twice_counts_once(self):
        assert node_resolve.providers_of(_pipeline('llm_openai', 'llm_openai')) == {'llm_openai'}

    def test_a_pipeline_with_no_components_asks_for_nothing(self):
        assert node_resolve.providers_of({}) == set()

    def test_malformed_components_are_skipped_not_fatal(self):
        # A pipeline is user input; a stray null must not take the run down
        # before it starts.
        pipeline = {'components': [None, 'nonsense', {'provider': 'llm_openai'}, {'no_provider': 1}]}
        assert node_resolve.providers_of(pipeline) == {'llm_openai'}

    def test_missing_is_what_the_engine_lacks(self):
        assert node_resolve.missing_from({'a', 'b'}, {'b'}) == {'a'}


# =============================================================================
# THE PLAN
# =============================================================================


class TestPlan:
    """What a run has to go and get, before anything moves."""

    @pytest.mark.asyncio
    async def test_a_pipeline_of_stock_nodes_resolves_nothing(self, published):
        # The common case: no lookup, no fetch, no cost.
        plan = await node_resolve.plan_for(_pipeline('llm_openai'), {'llm_openai'}, 'org1', 'u1', [])
        assert plan == []

    @pytest.mark.asyncio
    async def test_a_published_node_is_planned_with_its_version(self, published):
        published('ticket_feed', version=3)
        plan = await node_resolve.plan_for(_pipeline('llm_openai', 'ticket_feed'), {'llm_openai'}, 'org1', 'u1', [])
        assert [(entry['id'], entry['version']) for entry in plan] == [('ticket_feed', 3)]

    @pytest.mark.asyncio
    async def test_an_unpinned_node_stops_the_run(self, published):
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['ticket_feed']

    @pytest.mark.asyncio
    async def test_the_failure_names_the_node_and_the_org(self, published):
        # "not found" is a dead end; naming the org tells someone what to do.
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed'), set(), 'acme', 'u1', [])
        assert 'ticket_feed' in str(caught.value)
        assert 'acme' in str(caught.value)

    @pytest.mark.asyncio
    async def test_one_unresolvable_node_stops_the_whole_run(self, published):
        # Not "fetch what we can": a run missing one of its nodes cannot work,
        # so it fails before downloading the others.
        published('ticket_feed')
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed', 'sentiment'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['sentiment']

    @pytest.mark.asyncio
    async def test_every_missing_node_is_reported_at_once(self, published):
        # Fixing them one run at a time would be miserable.
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('b_node', 'a_node'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['a_node', 'b_node']

    @pytest.mark.asyncio
    async def test_a_node_the_engine_carries_is_never_looked_up(self, published):
        # A published node sharing a name with a built-in must not shadow it:
        # what the engine has already wins, and nothing is fetched.
        published('llm_openai', version=9)
        plan = await node_resolve.plan_for(_pipeline('llm_openai'), {'llm_openai'}, 'org1', 'u1', [])
        assert plan == []


# =============================================================================
# FETCH AND MATERIALISE
# =============================================================================
#
# These publish a node for real through handle_node_add and then resolve it
# back, over the REAL Store on a temp filesystem. That is deliberate: publish
# and resolve agree on where a bundle lives only by convention, and a fake
# store on both sides would let those two drift apart without a test noticing.


import io  # noqa: E402
import json  # noqa: E402
import zipfile  # noqa: E402
from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from ai.account import node_deploy  # noqa: E402
from ai.account.store import Store  # noqa: E402


class _Conn:
    def __init__(self, org_id='org1'):
        self._account_info = SimpleNamespace(
            userId='u1',
            displayName='User One',
            email='u1@example.com',
            organization={'id': org_id, 'teams': [], 'developerId': 'acme'},
        )
        self._server = SimpleNamespace()

    def build_response(self, request, body=None):
        return {'success': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'success': False, 'message': message}


def _zip(files=None, manifest=None):
    manifest = manifest or {'protocol': 'ticket_feed://', 'title': 'Ticket Feed', 'version': '1.2.0'}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('services.json', json.dumps(manifest))
        archive.writestr('IInstance.py', 'class IInstance:\n    pass\n')
        for name, content in (files or {}).items():
            archive.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def live(monkeypatch, tmp_path):
    """A real Store plus a registry that remembers what was published."""
    from ai.account import account

    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{tmp_path / "store"}')
    Store.reset()
    published = []
    reads = {'count': 0}

    async def deployments_publish(org_id, project_id, artifact, actor, comment='', metadata=None, **kwargs):
        version = len(published) + 1
        entry = {
            'version': version,
            'sha256': f'sha-{version}',
            'metadata': metadata or {},
            'artifactPath': f'orgs/{org_id}/files/.deployments/{project_id}/v{version:06d}-abcd1234.json',
        }
        published.append({'projectId': project_id, 'artifact': artifact, 'entry': entry})
        return entry

    async def deployments_versions(org_id, project_id):
        return [p['entry'] for p in published if p['projectId'] == project_id]

    async def set_artifact_state(org_id, project_id, version, state, actor):
        pass

    async def audit(*args, **kwargs):
        pass

    monkeypatch.setattr(account, 'deployments_publish', deployments_publish)
    monkeypatch.setattr(account, 'deployments_versions', deployments_versions)
    monkeypatch.setattr(account, 'set_artifact_state', set_artifact_state)
    monkeypatch.setattr(account, 'audit', audit)
    monkeypatch.setattr(node_resolve, 'cache_root', lambda: str(tmp_path / 'cache'))

    real_read = None

    async def counted_read(self, filename):
        reads['count'] += 1
        return await real_read(self, filename)

    async def publish(files=None, manifest=None):
        """Publish a node and hand back the entry a resolver would plan."""
        result = await node_deploy.handle_node_add(
            _Conn(),
            {
                'command': 'rrext_deploy',
                'arguments': {'subcommand': 'add', 'kind': 'node', 'data': _zip(files, manifest)},
            },
        )
        assert result['success'] is True, result
        artifact = published[-1]['artifact']
        return {
            'id': artifact['nodeId'],
            'version': result['body']['artifact']['version'],
            'bundleSha256': artifact['bundleSha256'],
            'requirements': artifact['requirements'],
        }

    yield SimpleNamespace(publish=publish, reads=reads, run_root=str(tmp_path / 'run'), published=published)
    Store.reset()


class TestMaterialise:
    """Bringing a published node onto a machine that does not have it."""

    @pytest.mark.asyncio
    async def test_the_node_directory_is_restored(self, live):
        entry = await live.publish()
        written = await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        placed = Path(written[0])
        assert placed.name == 'ticket_feed'
        assert (placed / 'services.json').exists()
        assert (placed / 'IInstance.py').read_text().startswith('class IInstance')

    @pytest.mark.asyncio
    async def test_the_package_marker_is_written_by_the_resolver(self, live):
        # It is the PARENT of the node directory, so it is not in the bundle.
        entry = await live.publish()
        await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert (Path(live.run_root) / 'local_nodes' / '__init__.py').exists()

    @pytest.mark.asyncio
    async def test_it_lands_where_the_engine_imports_from(self, live):
        # local_nodes/<id>/ — so the manifest's own path resolves untouched.
        entry = await live.publish()
        written = await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert Path(written[0]) == Path(live.run_root) / 'local_nodes' / 'ticket_feed'

    @pytest.mark.asyncio
    async def test_a_digest_mismatch_refuses_before_unpacking(self, live):
        entry = await live.publish()
        entry['bundleSha256'] = 'f' * 64
        with pytest.raises(node_resolve.BundleMismatch):
            await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert not (Path(live.run_root) / 'local_nodes').exists()

    @pytest.mark.asyncio
    async def test_a_version_with_no_digest_is_refused(self, live):
        entry = await live.publish()
        entry['bundleSha256'] = ''
        with pytest.raises(node_resolve.BundleMismatch):
            await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')

    @pytest.mark.asyncio
    async def test_the_second_run_reuses_the_cache(self, live):
        entry = await live.publish()
        await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        slot = node_resolve.cache_slot('ticket_feed', entry['bundleSha256'])
        assert Path(slot).is_dir()
        # A second materialise finds the slot and never touches the store.
        node_resolve.clean(live.run_root)
        await node_resolve.materialise([entry], str(Path(live.run_root) / 'second'), 'org1', 'u1')
        assert (Path(live.run_root) / 'second' / 'local_nodes' / 'ticket_feed' / 'services.json').exists()

    @pytest.mark.asyncio
    async def test_no_partial_slot_survives_a_failure(self, live):
        entry = await live.publish()
        entry['bundleSha256'] = 'f' * 64
        with pytest.raises(node_resolve.BundleMismatch):
            await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        leftovers = list(Path(node_resolve.cache_root()).rglob('*.partial'))
        assert leftovers == []

    @pytest.mark.asyncio
    async def test_clean_drops_the_run_tree_and_keeps_the_cache(self, live):
        entry = await live.publish()
        await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        node_resolve.clean(live.run_root)
        assert not (Path(live.run_root) / 'local_nodes').exists()
        assert Path(node_resolve.cache_slot('ticket_feed', entry['bundleSha256'])).is_dir()

    @pytest.mark.asyncio
    async def test_requirements_travel_with_the_node(self, live):
        # The resolver has to be able to see them on disk to act on them.
        entry = await live.publish(files={'requirements.txt': 'httpx\n'})
        written = await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert (Path(written[0]) / 'requirements.txt').read_text() == 'httpx\n'
        assert entry['requirements'] == ['httpx']


class TestRequirements:
    """A published node's dependencies, which the engine's startup sweep misses."""

    @pytest.fixture
    def installs(self, monkeypatch):
        """Record what the engine installer was asked to install."""
        calls = []
        monkeypatch.setattr(node_resolve, '_install', lambda path: calls.append(path))
        return calls

    @pytest.mark.asyncio
    async def test_declared_requirements_are_installed(self, live, installs):
        entry = await live.publish(files={'requirements.txt': 'httpx\n'})
        written = await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        # Installed from the materialised copy, so the path exists on disk.
        assert installs == [str(Path(written[0]) / 'requirements.txt')]

    @pytest.mark.asyncio
    async def test_a_node_without_requirements_installs_nothing(self, live, installs):
        entry = await live.publish()
        await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert installs == []

    @pytest.mark.asyncio
    async def test_an_unsatisfiable_node_fails_the_run_by_name(self, live, monkeypatch):
        # Against the constraints lock a conflict is refused rather than
        # settled by downgrading someone else's package — so the run stops,
        # and it says which node could not fit.
        def boom(path):
            raise RuntimeError('httpx==9.9 conflicts with the lock')

        monkeypatch.setattr(node_resolve, '_install', boom)
        entry = await live.publish(files={'requirements.txt': 'httpx==9.9\n'})
        with pytest.raises(node_resolve.DependencyFailure) as caught:
            await node_resolve.materialise([entry], live.run_root, 'org1', 'u1')
        assert 'ticket_feed' in str(caught.value)
