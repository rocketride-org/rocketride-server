"""
Unit tests for ai.common.store.store_global_base.StoreGlobalBase and
ai.common.store.store_instance_base.StoreInstanceBase.

The base is an ABC with one abstract driver hook (``_open_store``). Tests use a
concrete ``_TestableGlobal`` that supplies a fake store and drive the shared
lifecycle with a stubbed ``IEndpoint``/``glb``. The config is the real
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
# 1. beginGlobal opens the driver on the resolved view
# ---------------------------------------------------------------------------


def test_begin_global_hands_the_resolved_view_to_the_driver():
    """The hook receives the logical type, the resolved config (defaults applied, active branch flat) and the bag."""
    g = _make({'profile': 'local', 'collection': 'docs'})
    g.beginGlobal()

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
    assert g.store is g._store_to_return


def test_a_key_the_schema_does_not_declare_stops_the_start():
    """Resolving is validating: an unknown key is named and the driver never opens."""
    g = _make({'bogus': 1})
    with pytest.raises(ConfigError, match='bogus'):
        g.beginGlobal()
    assert g.opened is False


# ---------------------------------------------------------------------------
# 2. serverName resolution from the resolved config
# ---------------------------------------------------------------------------


def test_server_name_taken_from_config_when_present():
    """A non-blank serverName in the resolved config overrides the class default."""
    g = _make({'serverName': 'custom'})
    g.beginGlobal()
    assert g.serverName == 'custom'


def test_a_blank_server_name_keeps_the_class_default():
    """A blank value passes the resolver as written and names no namespace: the class default stands."""
    g = _make({'serverName': ''})
    g.beginGlobal()
    assert g.serverName == 'defaultname'


def test_a_non_string_server_name_is_a_config_error():
    """The schema types serverName (string, minLength 1); the base no longer papers over a bad value."""
    g = _make({'serverName': 123})
    with pytest.raises(ConfigError, match='serverName'):
        g.beginGlobal()


# ---------------------------------------------------------------------------
# 3. endGlobal clears the store
# ---------------------------------------------------------------------------


def test_end_global_clears_store():
    """The endGlobal teardown drops the store."""
    g = _make()
    g.beginGlobal()
    assert g.store is not None

    g.endGlobal()
    assert g.store is None


# ---------------------------------------------------------------------------
# 4. lane handlers guard a missing store
# ---------------------------------------------------------------------------


def _instance_with_store(store):
    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = SimpleNamespace(store=store)
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
# 5. The two tool switches: declared by the definition, else the class default
# ---------------------------------------------------------------------------


class _ManagedGlobal(_TestableGlobal):
    """A driver whose store is shared or managed: tools and writes are off unless configured."""

    expose_tools = False
    allow_write = False


def test_switches_default_off_on_a_managed_node_and_on_elsewhere():
    """The RocketRide vector definition declares both switches off; qdrant declares none, so the class defaults stand."""
    managed = _make({}, logical_type='rocketride_vector', cls=_ManagedGlobal)
    managed.beginGlobal()
    assert (managed.expose_tools, managed.allow_write) == (False, False)

    g = _make({})
    g.beginGlobal()
    assert (g.expose_tools, g.allow_write) == (True, True)


@pytest.mark.parametrize('switch', ['expose_tools', 'allow_write'])
def test_a_managed_driver_can_be_opened_up_through_config(switch):
    """The node owner opts in with the switch set to true on a driver that defaults to off."""
    managed = _make({switch: True}, logical_type='rocketride_vector', cls=_ManagedGlobal)
    managed.beginGlobal()
    assert getattr(managed, switch) is True
    other = 'allow_write' if switch == 'expose_tools' else 'expose_tools'
    assert getattr(managed, other) is False


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

    assert g.opened and g.opened_with[1]['apikey'] == 'a-real-key'


def test_a_branch_without_the_credential_is_not_checked():
    """The local branch has no key; ``_credentials`` reads nothing and the store opens."""
    g = _make({'profile': 'local'}, cls=_KeyedGlobal)

    g.beginGlobal()

    assert g.opened


def test_a_driver_without_credential_fields_is_not_checked():
    g = _make(_cloud('${ROCKETRIDE_NOT_SENT}'))

    g.beginGlobal()

    assert g.opened
