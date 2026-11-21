"""
Unit tests for ai.common.store.store_global_base.StoreGlobalBase and
ai.common.store.store_instance_base.StoreInstanceBase.

The base is an ABC with one abstract driver hook (``_open_store``). Tests use a
concrete ``_TestableGlobal`` that supplies a fake store and drive the shared
lifecycle with a stubbed ``IEndpoint``/``glb``; a call's settings are the resolver's view with the call's
params overlaid, as ``IInstance.settings`` builds them. The config is the real
resolver's view of a converted definition registered with the engine: the
qdrant node (a selector with the key on its cloud branch, no tool switches)
and the RocketRide vector node (both tool switches declared, off by default).

The behaviors pinned here are the ones a regression in this shared file could
silently break across all nine store nodes at once, including the lane
``store is None`` guards, which otherwise have no test.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from rocketlib.config import ConfigError

from ai.common.config import UnresolvedCredentialError
from ai.common.schema import Doc, DocMetadata
from ai.common.store.store_global_base import StoreGlobalBase
from ai.common.store.store_instance_base import NO_STORE_MESSAGE, StoreInstanceBase


# ---------------------------------------------------------------------------
# Fakes / test subclasses
# ---------------------------------------------------------------------------


class _FakeStore:
    """Minimal stand-in for a DocumentStoreBase."""

    def __init__(self):
        self.host = 'Host'
        self.port = 5555
        self.collection = 'Coll'
        self.calls = []

    def dispatchSearch(self, instance, question):
        self.calls.append(('search', question))

    def addChunks(self, documents):
        self.calls.append(('add', documents))

    def render(self, objectId, callback):
        self.calls.append(('render', objectId))


class _TestableGlobal(StoreGlobalBase):
    """Concrete StoreGlobalBase: fake store, records what the hook received."""

    serverName = 'defaultname'

    def __init__(self, store):
        self._store_to_return = store
        self.opened = False
        self.opened_with = None

    def _open_store(self, logical_type, config, bag):
        self.opened = True
        self.opened_with = (logical_type, config, bag)
        return self._store_to_return


class _TestableInstance(StoreInstanceBase):
    """Concrete StoreInstanceBase with no per-driver overrides (the common case)."""


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make(conn_config=None, logical_type='qdrant', cls=_TestableGlobal, store=None):
    """A global on the stored config ``conn_config`` of the converted node ``logical_type``."""
    g = cls(store=store if store is not None else _FakeStore())
    g.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(bag={'bag': 1}))
    # qdrant's default branch is the cloud, whose key is required: the tests start local unless they say otherwise
    conn_config = dict(conn_config or {})
    if logical_type == 'qdrant':
        conn_config.setdefault('profile', 'local')
    g.glb = SimpleNamespace(logicalType=logical_type, connConfig=conn_config)
    return g


# ---------------------------------------------------------------------------
# 1. beginGlobal opens nothing; store_for opens the driver on the call's settings
# ---------------------------------------------------------------------------


def _call(g, **params):
    """The settings of one call: the control's config with the call's params over it."""
    return g._resolved().overlay(params)


def test_begin_global_opens_no_store():
    """The collection is a parameter: nothing is opened before a call names one."""
    g = _make({'profile': 'local'})
    g.beginGlobal()
    assert g.opened is False
    assert len(g._stores) == 0


def test_store_for_hands_the_calls_settings_to_the_driver():
    """The hook receives the logical type, the call's settings (defaults applied, active branch flat) and the bag."""
    g = _make({'profile': 'local', 'collection': 'docs'})
    g.beginGlobal()

    store = g.store_for(_call(g))

    logical_type, config, bag = g.opened_with
    assert logical_type == 'qdrant'
    assert (config['profile'], config['host'], config['port'], config['collection']) == (
        'local',
        'localhost',
        6333,
        'docs',
    )
    assert 'apikey' not in config
    assert bag == {'bag': 1}
    assert store is g._store_to_return


class _CountingGlobal(_TestableGlobal):
    """Opens a new fake store per call of the hook, and counts them."""

    def _open_store(self, logical_type, config, bag):
        super()._open_store(logical_type, config, bag)
        store = _FakeStore()
        store.collection = config['collection']
        self.opened_count = getattr(self, 'opened_count', 0) + 1
        return store


def test_two_collections_on_one_control_without_rebuilding_the_global():
    """One control serves two calls that name two collections; a third call reuses the first store."""
    g = _make({'profile': 'local'}, cls=_CountingGlobal)
    g.beginGlobal()

    first = g.store_for(_call(g, collection='alpha'))
    second = g.store_for(_call(g, collection='beta'))
    again = g.store_for(_call(g, collection='alpha'))

    assert (first.collection, second.collection) == ('alpha', 'beta')
    assert again is first
    assert g.opened_count == 2


def test_the_tool_surface_settings_do_not_open_another_store():
    """The serverName setting only labels the tools: two calls that differ in it share one store."""
    g = _make({'profile': 'local'}, cls=_CountingGlobal)
    g.beginGlobal()

    first = g.store_for(_call(g, serverName='one'))
    second = g.store_for(_call(g, serverName='two'))

    assert first is second
    assert g.opened_count == 1


def test_the_store_cache_is_bounded():
    """Past STORE_CACHE_MAX collections the least recently used store is dropped and reopened on its next use."""
    from ai.common.store.store_global_base import STORE_CACHE_MAX

    g = _make({'profile': 'local'}, cls=_CountingGlobal)
    g.beginGlobal()
    for i in range(STORE_CACHE_MAX + 1):
        g.store_for(_call(g, collection=f'c{i}'))

    assert len(g._stores) == STORE_CACHE_MAX
    g.store_for(_call(g, collection='c0'))
    assert g.opened_count == STORE_CACHE_MAX + 2


@pytest.mark.parametrize('key', ['collection', 'score', 'serverName'])
def test_a_param_read_through_the_global_config_raises(key):
    """The IGlobal's view refuses a param: it is per call and lives in the instance's settings."""
    g = _make({'profile': 'local'})
    with pytest.raises(ConfigError):
        g.config[key]


def test_a_key_the_schema_does_not_declare_stops_the_start():
    """Resolving is validating: an unknown key is named and the driver never opens."""
    g = _make({'bogus': 1})
    with pytest.raises(ConfigError, match='bogus'):
        g.beginGlobal()
    assert g.opened is False


# ---------------------------------------------------------------------------
# 2. serverName is the call's: read by the tool mixin, not resolved at start
# ---------------------------------------------------------------------------


def _instance_on(g, **params):
    """An instance of one call on the control ``g``."""
    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = g
    inst._settings = _call(g, **params)
    return inst


def test_server_name_taken_from_the_call_when_present():
    """A non-blank serverName in the call's settings overrides the class default."""
    g = _make({'profile': 'local'})
    g.beginGlobal()
    assert _instance_on(g, serverName='custom')._vectordb_server_name() == 'custom'
    assert g.serverName == 'defaultname'


def test_a_blank_server_name_keeps_the_class_default():
    """A blank value names no namespace: the class default stands."""
    g = _make({'profile': 'local', 'serverName': ''})
    g.beginGlobal()
    assert _instance_on(g)._vectordb_server_name() == 'defaultname'


def test_a_non_string_server_name_is_a_config_error():
    """The schema types serverName (string, minLength 1); the base no longer papers over a bad value."""
    g = _make({'serverName': 123})
    with pytest.raises(ConfigError, match='serverName'):
        g.beginGlobal()


# ---------------------------------------------------------------------------
# 3. endGlobal drops every store
# ---------------------------------------------------------------------------


def test_end_global_drops_the_stores():
    """The endGlobal teardown drops the cache; a lane after it says the store is not open."""
    g = _make({'profile': 'local'})
    g.beginGlobal()
    g.store_for(_call(g))
    assert len(g._stores) == 1

    g.endGlobal()
    assert g._stores is None


# ---------------------------------------------------------------------------
# 4. lane handlers guard a missing store
# ---------------------------------------------------------------------------


class _OneStoreGlobal:
    """A stand-in IGlobal: one store for every call, or no cache at all when ``store`` is None."""

    def __init__(self, store):
        self.store = store
        self._stores = None if store is None else {}

    def store_for(self, settings):
        return self.store


def _instance_with_store(store):
    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = _OneStoreGlobal(store)
    inst._settings = {}
    return inst


def _assert_says_the_store_is_not_open(message: str) -> None:
    """The missing-store refusal says what is wrong and what to check (#2476)."""
    assert message == NO_STORE_MESSAGE
    assert message == 'Vector store connection is unavailable. Check its connection settings and startup errors.'


def test_write_questions_raises_when_store_missing():
    """The writeQuestions lane refuses when the store is absent, saying it is not open."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception) as excinfo:
        inst.writeQuestions(SimpleNamespace())
    _assert_says_the_store_is_not_open(str(excinfo.value))


def test_write_documents_raises_when_store_missing():
    """The writeDocuments lane refuses when the store is absent, saying it is not open."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception) as excinfo:
        inst.writeDocuments([])
    _assert_says_the_store_is_not_open(str(excinfo.value))


def test_render_object_raises_when_store_missing():
    """The renderObject lane refuses when the store is absent, saying it is not open."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception) as excinfo:
        inst.renderObject(SimpleNamespace(hasVectorBatchId=True, vectorBatchId='b', objectId='o'))
    _assert_says_the_store_is_not_open(str(excinfo.value))


def test_lane_handlers_delegate_to_store_when_present():
    """With a store present, the three lanes delegate to it."""
    store = _FakeStore()
    inst = _instance_with_store(store)
    # The engine opens the object before its lanes write; a filter in the pipe, not its endpoint
    inst.IGlobal.glb = SimpleNamespace(logicalType='store')
    inst.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(logicalType='source'))
    inst.open(None)

    inst.writeQuestions(SimpleNamespace())
    inst.writeDocuments([Doc(page_content='x', metadata=DocMetadata(objectId='o', chunkId=0))])

    kinds = [c[0] for c in store.calls]
    assert kinds == ['search', 'add']


# ---------------------------------------------------------------------------
# 5. The two tool switches: the call's setting where declared, else the class default
# ---------------------------------------------------------------------------


class _ManagedGlobal(_TestableGlobal):
    """A driver whose store is shared or managed: tools and writes are off unless a call opens them."""

    expose_tools = False
    allow_write = False


def test_switches_default_off_on_a_managed_node_and_on_elsewhere():
    """The RocketRide vector definition declares both switches off; qdrant declares none, so the class defaults stand."""
    managed = _make({}, logical_type='rocketride_vector', cls=_ManagedGlobal)
    managed.beginGlobal()
    inst = _instance_on(managed)
    assert (inst._vectordb_expose_tools(), inst._vectordb_allow_write()) == (False, False)

    g = _make({'profile': 'local'})
    g.beginGlobal()
    inst = _instance_on(g)
    assert (inst._vectordb_expose_tools(), inst._vectordb_allow_write()) == (True, True)


@pytest.mark.parametrize('switch', ['expose_tools', 'allow_write'])
def test_a_managed_driver_can_be_opened_up_by_a_call(switch):
    """A call opts in with the switch set to true on a driver that defaults to off; the next call does not."""
    managed = _make({}, logical_type='rocketride_vector', cls=_ManagedGlobal)
    managed.beginGlobal()
    other = 'allow_write' if switch == 'expose_tools' else 'expose_tools'

    opened = _instance_on(managed, **{switch: True})
    assert getattr(opened, f'_vectordb_{switch}')() is True
    assert getattr(opened, f'_vectordb_{other}')() is False
    assert getattr(_instance_on(managed), f'_vectordb_{switch}')() is False


@pytest.mark.parametrize('switch', ['expose_tools', 'allow_write'])
@pytest.mark.parametrize('value', ['true', 'maybe', 1])
def test_a_switch_is_a_boolean_or_a_config_error(switch, value):
    """The schema types the switches: a string or a number is refused, never parsed."""
    managed = _make({switch: value}, logical_type='rocketride_vector', cls=_ManagedGlobal)
    with pytest.raises(ConfigError, match=switch):
        managed.beginGlobal()


def test_a_switch_the_definition_does_not_declare_is_a_config_error():
    """The qdrant definition declares no tool switches, so writing one is an unknown key."""
    g = _make({'allow_write': True})
    with pytest.raises(ConfigError, match='allow_write'):
        g.beginGlobal()


# ---------------------------------------------------------------------------
# 6. A credential still written as an unfilled ${ROCKETRIDE_...}
# ---------------------------------------------------------------------------


class _KeyedGlobal(_TestableGlobal):
    """A driver that sends ``apikey`` to its server."""

    credential_fields = ('apikey',)


def _cloud(apikey):
    return {'profile': 'cloud', 'cloud': {'host': 'x.qdrant.io', 'apikey': apikey}}


def test_an_unfilled_key_stops_the_store_before_it_opens():
    g = _make(_cloud('${ROCKETRIDE_QDRANT_KEY}'), cls=_KeyedGlobal)

    with pytest.raises(UnresolvedCredentialError, match='no variable named ROCKETRIDE_QDRANT_KEY was found'):
        g.beginGlobal()
    assert not g.opened, 'the driver opened a connection with the placeholder as its key'


def test_a_filled_key_opens_the_store():
    g = _make(_cloud('a-real-key'), cls=_KeyedGlobal)

    g.beginGlobal()
    g.store_for(_call(g))

    assert g.opened and g.opened_with[1]['apikey'] == 'a-real-key'


def test_a_branch_without_the_credential_is_not_checked():
    """The local branch has no key; ``_credentials`` reads nothing and the store opens."""
    g = _make({'profile': 'local'}, cls=_KeyedGlobal)

    g.beginGlobal()
    g.store_for(_call(g))

    assert g.opened


def test_a_driver_without_credential_fields_is_not_checked():
    g = _make(_cloud('${ROCKETRIDE_NOT_SENT}'))

    g.beginGlobal()
    g.store_for(_call(g))

    assert g.opened
