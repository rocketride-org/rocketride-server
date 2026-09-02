# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The OSS node catalog: a public shelf of user-published capsules.

What is pinned here is what the SaaS implementation will have to keep true when
it swaps the file backend for DB rows: versions are immutable and never
overwritten, a published node is visible to everyone, price is recorded but
never enforced, removal hides without destroying, and the bytes handed back are
checked against the digest recorded when they were published.
"""

import pytest

from ai.account.node_catalog_backend import FileNodeCatalogBackend, artifact_sha256
from ai.account.store import StorageError


class FakeStore:
    """In-memory IStore covering what the catalog backend calls."""

    def __init__(self):
        self.files = {}
        self.versions = {}
        self._counter = 0

    async def write_bytes(self, filename, data):
        self.files[filename] = bytes(data)
        self._bump(filename)

    async def read_bytes(self, filename):
        if filename not in self.files:
            raise StorageError(f'not found: {filename}')
        return self.files[filename]

    async def write_file(self, filename, data):
        self.files[filename] = data.encode('utf-8') if isinstance(data, str) else data
        self._bump(filename)

    async def read_file(self, filename):
        if filename not in self.files:
            raise StorageError(f'not found: {filename}')
        return self.files[filename].decode('utf-8')

    async def read_file_with_metadata(self, filename):
        return await self.read_file(filename), self.versions[filename]

    async def write_file_atomic(self, filename, data, expected_version=None):
        if expected_version is not None and self.versions.get(filename) != expected_version:
            from ai.account.store import VersionMismatchError

            raise VersionMismatchError('stale')
        await self.write_file(filename, data)
        return self.versions[filename]

    async def list_entries(self, prefix='', *, recursive=True, include_files=True, include_dirs=True):
        seen = set()
        for path in self.files:
            if not path.startswith(prefix):
                continue
            rest = path[len(prefix) :]
            if '/' in rest:
                seen.add(rest.split('/')[0])
        return [{'name': name, 'type': 'dir'} for name in sorted(seen)]

    def _bump(self, filename):
        self._counter += 1
        self.versions[filename] = f'v{self._counter}'


@pytest.fixture
def catalog():
    return FileNodeCatalogBackend(FakeStore())


ACTOR = {'id': 'u1', 'name': 'Ariel', 'email': 'a@example.com'}
OTHER = {'id': 'u2', 'name': 'Someone Else', 'email': 'b@example.com'}


async def test_publishing_makes_a_node_visible_to_everyone(catalog):
    entry = await catalog.publish('demo_node', b'CAPSULE', ACTOR, title='Demo Node')

    assert entry['name'] == 'demo_node'
    assert entry['title'] == 'Demo Node'
    assert entry['author']['name'] == 'Ariel'
    assert entry['state'] == 'published'
    # Nothing scopes the listing: a catalog anyone can read is the point.
    assert [e['name'] for e in await catalog.list()] == ['demo_node']


async def test_a_price_is_recorded_and_never_enforced(catalog):
    await catalog.publish('paid_node', b'CAPSULE', ACTOR, price_cents=1900)
    entry = (await catalog.list())[0]

    assert entry['priceCents'] == 1900
    # Fetching a paid node is not blocked here — charging is the billing
    # layer's question, and in OSS there is no billing at all.
    assert (await catalog.fetch('paid_node'))['capsule']


async def test_free_is_simply_zero(catalog):
    await catalog.publish('free_node', b'CAPSULE', ACTOR)
    assert (await catalog.list())[0]['priceCents'] == 0


async def test_a_negative_price_is_refused(catalog):
    with pytest.raises(ValueError):
        await catalog.publish('demo_node', b'CAPSULE', ACTOR, price_cents=-1)


async def test_republishing_adds_a_version_and_never_overwrites(catalog):
    await catalog.publish('demo_node', b'FIRST', ACTOR, version_label='1.0.0')
    await catalog.publish('demo_node', b'SECOND', ACTOR, version_label='1.1.0')

    detail = await catalog.get('demo_node')
    assert detail['latest'] == 2
    assert detail['versionLabel'] == '1.1.0'
    assert [v['version'] for v in detail['versions']] == [2, 1]
    # Both artifacts are still there, each under its own digest.
    assert (await catalog.fetch('demo_node', version=1))['sha256'] == artifact_sha256(b'FIRST')
    assert (await catalog.fetch('demo_node', version=2))['sha256'] == artifact_sha256(b'SECOND')


async def test_fetch_returns_the_latest_by_default(catalog):
    await catalog.publish('demo_node', b'FIRST', ACTOR)
    await catalog.publish('demo_node', b'SECOND', ACTOR)
    assert (await catalog.fetch('demo_node'))['version'] == 2


async def test_fetch_verifies_the_recorded_digest(catalog):
    await catalog.publish('demo_node', b'CAPSULE', ACTOR)
    # Someone tampered with the stored artifact.
    path = next(p for p in catalog._store.files if p.endswith('.rrc'))
    catalog._store.files[path] = b'TAMPERED'

    with pytest.raises(StorageError):
        await catalog.fetch('demo_node')


async def test_unpublish_hides_without_destroying(catalog):
    await catalog.publish('demo_node', b'CAPSULE', ACTOR)
    await catalog.unpublish('demo_node', ACTOR)

    assert await catalog.list() == []
    # The artifact still resolves, so an install someone already did keeps working.
    assert (await catalog.fetch('demo_node'))['capsule']
    assert [e['name'] for e in await catalog.list(include_removed=True)] == ['demo_node']


async def test_unpublishing_something_never_published_is_refused(catalog):
    with pytest.raises(ValueError):
        await catalog.unpublish('demo_node', ACTOR)


async def test_the_first_publisher_stays_the_author(catalog):
    await catalog.publish('demo_node', b'FIRST', ACTOR)
    await catalog.publish('demo_node', b'SECOND', OTHER)

    entry = await catalog.get('demo_node')
    assert entry['author']['name'] == 'Ariel'
    # But the version records who actually pushed it.
    assert entry['versions'][0]['publishedBy']['name'] == 'Someone Else'


async def test_search_matches_what_a_person_reads_on_the_card(catalog):
    await catalog.publish('ticket_feed', b'A', ACTOR, title='Ticket Feed', description='Reads a support queue')
    await catalog.publish('sentiment_tagger', b'B', OTHER, title='Sentiment Tagger')

    assert [e['name'] for e in await catalog.list(search='ticket')] == ['ticket_feed']
    assert [e['name'] for e in await catalog.list(search='support queue')] == ['ticket_feed']
    assert [e['name'] for e in await catalog.list(search='Someone')] == ['sentiment_tagger']
    assert await catalog.list(search='nothing here') == []


async def test_an_unsafe_name_never_becomes_a_path(catalog):
    for bad in ('../evil', 'Demo', 'a', '', 'has space', 'x/y'):
        with pytest.raises(ValueError):
            await catalog.publish(bad, b'CAPSULE', ACTOR)


async def test_an_empty_capsule_is_refused(catalog):
    with pytest.raises(ValueError):
        await catalog.publish('demo_node', b'', ACTOR)


async def test_get_and_fetch_on_an_unknown_node(catalog):
    assert await catalog.get('demo_node') is None
    with pytest.raises(ValueError):
        await catalog.fetch('demo_node')


async def test_fetching_a_version_that_does_not_exist(catalog):
    await catalog.publish('demo_node', b'CAPSULE', ACTOR)
    with pytest.raises(ValueError):
        await catalog.fetch('demo_node', version=7)


async def test_an_empty_catalog_lists_nothing(catalog):
    assert await catalog.list() == []


# ---------------------------------------------------------------------------
# Card metadata: what the store card needs, taken from the node itself
# ---------------------------------------------------------------------------


def _real_capsule(**over):
    """A capsule built from a scaffolded node, so services.json is the real shape."""
    from ai.account.capsule import pack_capsule
    from ai.account.node_scaffold import scaffold_node

    files = scaffold_node(
        name=over.get('name', 'ticket_feed'),
        title=over.get('title', 'Ticket Feed'),
        kind='filter',
        description=over.get('description', 'Reads a support queue'),
    )
    return pack_capsule(over.get('name', 'ticket_feed'), files)


async def test_the_card_fields_come_from_the_node_itself(catalog):
    # The author publishes without retyping any of it.
    entry = await catalog.publish('ticket_feed', _real_capsule(), ACTOR)

    assert entry['title'] == 'Ticket Feed'
    assert entry['description'] == 'Reads a support queue'
    assert entry['categories'], 'classType becomes the store category'
    assert entry['icon'].startswith('<svg'), 'the node ships its own icon'


async def test_an_explicit_title_overrides_the_declared_one(catalog):
    entry = await catalog.publish('ticket_feed', _real_capsule(), ACTOR, title='Support Queue Reader')
    assert entry['title'] == 'Support Queue Reader'


async def test_a_capsule_without_metadata_still_publishes(catalog):
    # Not every capsule is scaffolded; the card falls back to the name.
    entry = await catalog.publish('bare_node', b'not-a-zip', ACTOR)
    assert entry['title'] == 'bare_node'
    assert entry['categories'] == []
    assert entry['icon'] == ''
