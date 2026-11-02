"""
Unit tests for ai.common.store.store_global_base.StoreGlobalBase and
ai.common.store.store_instance_base.StoreInstanceBase.

The base classes are ABCs with three abstract driver hooks (``_open_store``,
``_sub_key``, ``_probe_connection``). Tests use a concrete ``_TestableGlobal``
that supplies a fake store, then drive the shared lifecycle with a stubbed
``IEndpoint``/``glb`` and monkeypatched ``Config``/embedding so no engine or
real driver is needed.

The behaviors pinned here are the ones a regression in this shared file could
silently break across all eight store nodes at once — including the two
review-driven fixes (the lane ``store is None`` guards and ``endGlobal``
clearing the transform key), which otherwise have no test.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from rocketlib import OPEN_MODE

import ai.common.store.store_global_base as sgb
from ai.common.store.store_global_base import StoreGlobalBase
from ai.common.store.store_instance_base import StoreInstanceBase


# ---------------------------------------------------------------------------
# Fakes / test subclasses
# ---------------------------------------------------------------------------


class _FakeStore:
    """Minimal stand-in for a DocumentStoreBase with the attrs _sub_key reads."""

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
    """Concrete StoreGlobalBase: fake store, deterministic sub-key, no-op probe."""

    serverName = 'defaultname'

    def __init__(self, store):
        self._store_to_return = store
        self._conn_config = {}
        self.opened = False

    def getConnConfig(self):
        # Bypass the filter/endpoint config plumbing; tests inject directly.
        return self._conn_config

    def _open_store(self, logical_type, conn_config, bag):
        self.opened = True
        return self._store_to_return

    def _sub_key(self) -> str:
        return f'{self.store.host}/{self.store.port}/{self.store.collection}'

    def _probe_connection(self, config) -> None:
        return


class _TestableInstance(StoreInstanceBase):
    """Concrete StoreInstanceBase with no per-driver overrides (the common case)."""


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def warnings(monkeypatch):
    """Capture rocketlib.warning calls made from the base module."""
    captured = []
    monkeypatch.setattr(sgb, 'warning', lambda msg: captured.append(msg))
    return captured


def _make(open_mode=OPEN_MODE.SOURCE, store=None):
    g = _TestableGlobal(store=store if store is not None else _FakeStore())
    g.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=open_mode, bag={}))
    g.glb = SimpleNamespace(logicalType='teststore', connConfig={})
    return g


def _patch_config(monkeypatch, node_config, embedding=(None, None)):
    """Stub Config.getNodeConfig (serverName source) and getMultiProviderConfig."""
    monkeypatch.setattr(sgb.Config, 'getNodeConfig', staticmethod(lambda lt, cc: node_config))
    monkeypatch.setattr(sgb.Config, 'getMultiProviderConfig', staticmethod(lambda kind, cc: embedding))


# ---------------------------------------------------------------------------
# 1. CONFIG mode short-circuits before the driver is loaded
# ---------------------------------------------------------------------------


def test_config_mode_returns_before_open_store(monkeypatch):
    """CONFIG open mode returns before _open_store; store stays None (driver never imported)."""
    _patch_config(monkeypatch, {})
    g = _make(open_mode=OPEN_MODE.CONFIG)
    g.beginGlobal()
    assert g.opened is False
    assert g.store is None


# ---------------------------------------------------------------------------
# 2. serverName resolution from merged config
# ---------------------------------------------------------------------------


def test_server_name_taken_from_config_when_present(monkeypatch):
    """A non-blank string serverName in the merged config overrides the class default."""
    _patch_config(monkeypatch, {'serverName': 'custom'})
    g = _make()
    g.beginGlobal()
    assert g.serverName == 'custom'


@pytest.mark.parametrize('node_config', [{}, {'serverName': ''}, {'serverName': '   '}, {'serverName': 123}])
def test_server_name_default_survives_when_absent_blank_or_non_string(monkeypatch, node_config):
    """The class default survives when serverName is missing, blank, or not a string."""
    _patch_config(monkeypatch, node_config)
    g = _make()
    g.beginGlobal()
    assert g.serverName == 'defaultname'


# ---------------------------------------------------------------------------
# 3. _wire_embedding
# ---------------------------------------------------------------------------


def test_wire_embedding_leaves_query_none_without_embedding_block(monkeypatch):
    """With no embedding provider, embed_query stays None (tools fall back to keyword)."""
    _patch_config(monkeypatch, {}, embedding=(None, None))
    g = _make()
    g.beginGlobal()
    assert g.embed_query is None
    assert g.embed_model_name is None


def test_wire_embedding_warns_instead_of_raising_when_getembedding_throws(monkeypatch, warnings):
    """If getEmbedding raises, beginGlobal warns and leaves embed_query None rather than failing."""
    _patch_config(monkeypatch, {}, embedding=('provider', {'k': 'v'}))

    import ai.common.embedding as emb

    def _boom(provider, config, bag):
        raise RuntimeError('no model here')

    monkeypatch.setattr(emb, 'getEmbedding', _boom)

    g = _make()
    g.beginGlobal()  # must not raise
    assert g.embed_query is None
    assert any('tool path embedder unavailable' in w for w in warnings)


# ---------------------------------------------------------------------------
# 4. transform key format
# ---------------------------------------------------------------------------


def test_transform_key_format(monkeypatch):
    """TRANFORM_KEY_TAG_NAME is f'{logicalType}://{sub_key.lower()}/status'."""
    _patch_config(monkeypatch, {})
    g = _make()
    g.beginGlobal()
    # sub_key = 'Host/5555/Coll' -> lowercased in the key
    assert g.TRANFORM_KEY_TAG_NAME == 'teststore://host/5555/coll/status'


# ---------------------------------------------------------------------------
# 5. endGlobal clears store, embedder AND the transform key
# ---------------------------------------------------------------------------


def test_end_global_clears_state_and_transform_key(monkeypatch):
    """The endGlobal teardown drops store/embed_query/embed_model_name and clears the transform key."""
    _patch_config(monkeypatch, {})
    g = _make()
    g.beginGlobal()
    assert g.TRANFORM_KEY_TAG_NAME  # set by beginGlobal

    g.endGlobal()
    assert g.store is None
    assert g.embed_query is None
    assert g.embed_model_name is None
    assert g.TRANFORM_KEY_TAG_NAME == ''


# ---------------------------------------------------------------------------
# 6. lane handlers guard a missing store
# ---------------------------------------------------------------------------


def _instance_with_store(store):
    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = SimpleNamespace(store=store)
    return inst


def test_write_questions_raises_when_store_missing():
    """The writeQuestions lane raises 'No document store' when the store is absent."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception, match='No document store'):
        inst.writeQuestions(SimpleNamespace())


def test_write_documents_raises_when_store_missing():
    """The writeDocuments lane raises 'No document store' when the store is absent."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception, match='No document store'):
        inst.writeDocuments([])


def test_render_object_raises_when_store_missing():
    """The renderObject lane raises 'No document store' when the store is absent."""
    inst = _instance_with_store(None)
    with pytest.raises(Exception, match='No document store'):
        inst.renderObject(SimpleNamespace(hasVectorBatchId=True, vectorBatchId='b', objectId='o'))


def test_lane_handlers_delegate_to_store_when_present():
    """With a store present, the three lanes delegate to it."""
    store = _FakeStore()
    inst = _instance_with_store(store)

    inst.writeQuestions(SimpleNamespace())
    inst.writeDocuments([{'x': 1}])

    kinds = [c[0] for c in store.calls]
    assert kinds == ['search', 'add']


# ---------------------------------------------------------------------------
# 5. allow_write resolution from merged config (#2587)
# ---------------------------------------------------------------------------


class _ManagedGlobal(_TestableGlobal):
    """A driver whose store is shared or managed: writes through tools are off unless configured."""

    allow_write = False


@pytest.mark.parametrize(
    'value, expected', [(True, True), ('true', True), ('on', True), (False, False), ('false', False), ('0', False)]
)
def test_allow_write_taken_from_config_when_present(monkeypatch, value, expected):
    """A configured allow_write wins over the class default, with config-style string parsing."""
    _patch_config(monkeypatch, {'allow_write': value})
    g = _make()
    g.beginGlobal()
    assert g.allow_write is expected


@pytest.mark.parametrize('node_config', [{}, {'allow_write': None}, {'allow_write': 'maybe'}])
def test_allow_write_class_default_survives_when_absent_or_unrecognised(monkeypatch, node_config):
    """An absent or garbage value falls back to the driver's class default.

    True for an ordinary store, False for a managed one, so no existing driver changes behaviour.
    """
    _patch_config(monkeypatch, node_config)
    g = _make()
    g.beginGlobal()
    assert g.allow_write is True

    managed = _ManagedGlobal(store=_FakeStore())
    managed.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    managed.glb = SimpleNamespace(logicalType='managedstore', connConfig={})
    managed.beginGlobal()
    assert managed.allow_write is False


def test_managed_driver_can_be_opened_up_through_config(monkeypatch):
    """The node owner opts in with allow_write=true on a driver that defaults to off."""
    _patch_config(monkeypatch, {'allow_write': 'true'})
    managed = _ManagedGlobal(store=_FakeStore())
    managed.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    managed.glb = SimpleNamespace(logicalType='managedstore', connConfig={})
    managed.beginGlobal()
    assert managed.allow_write is True


# ---------------------------------------------------------------------------
# 6. expose_tools resolution from merged config (#2631 review)
# ---------------------------------------------------------------------------


class _ManagedToolsGlobal(_TestableGlobal):
    """A driver whose store is shared or managed: the tool surface is off unless configured."""

    expose_tools = False


@pytest.mark.parametrize(
    'value, expected', [(True, True), ('true', True), ('on', True), (False, False), ('false', False), ('0', False)]
)
def test_expose_tools_taken_from_config_when_present(monkeypatch, value, expected):
    """A configured expose_tools wins over the class default, with config-style string parsing."""
    _patch_config(monkeypatch, {'expose_tools': value})
    g = _make()
    g.beginGlobal()
    assert g.expose_tools is expected


@pytest.mark.parametrize('node_config', [{}, {'expose_tools': None}, {'expose_tools': 'maybe'}])
def test_expose_tools_class_default_survives_when_absent_or_unrecognised(monkeypatch, node_config):
    """An absent or garbage value falls back to the driver's class default: on for an ordinary store, off for a managed one."""
    _patch_config(monkeypatch, node_config)
    g = _make()
    g.beginGlobal()
    assert g.expose_tools is True

    managed = _ManagedToolsGlobal(store=_FakeStore())
    managed.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    managed.glb = SimpleNamespace(logicalType='managedstore', connConfig={})
    managed.beginGlobal()
    assert managed.expose_tools is False


def test_managed_driver_tools_can_be_exposed_through_config(monkeypatch):
    """The node owner opts in with expose_tools=true on a driver that defaults to off."""
    _patch_config(monkeypatch, {'expose_tools': 'true'})
    managed = _ManagedToolsGlobal(store=_FakeStore())
    managed.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    managed.glb = SimpleNamespace(logicalType='managedstore', connConfig={})
    managed.beginGlobal()
    assert managed.expose_tools is True


# ---------------------------------------------------------------------------
# A credential still written as an unfilled ${ROCKETRIDE_...}
# ---------------------------------------------------------------------------


class _KeyedGlobal(_TestableGlobal):
    """A driver that sends ``apikey`` to its server."""

    credential_fields = ('apikey',)

    def __init__(self, store):
        super().__init__(store)
        self.probed = False

    def _probe_connection(self, config) -> None:
        self.probed = True


def _keyed(conn_config):
    g = _KeyedGlobal(store=_FakeStore())
    g.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    g.glb = SimpleNamespace(logicalType='teststore', connConfig=conn_config)
    g._conn_config = conn_config
    return g


def test_an_unfilled_key_stops_the_store_before_it_opens(monkeypatch):
    config = {'apikey': '${ROCKETRIDE_QDRANT_KEY}'}
    _patch_config(monkeypatch, config)
    g = _keyed(config)

    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_QDRANT_KEY was found'):
        g.beginGlobal()
    assert not g.opened, 'the driver opened a connection with the placeholder as its key'


def test_an_unfilled_key_is_reported_at_save_time_without_a_probe(monkeypatch, warnings):
    config = {'apikey': '${ROCKETRIDE_QDRANT_KEY}'}
    _patch_config(monkeypatch, config)
    g = _keyed(config)

    g.validateConfig()

    assert not g.probed, 'the probe sent the placeholder to the server'
    assert any('no variable named ROCKETRIDE_QDRANT_KEY was found' in w for w in warnings)


@pytest.mark.parametrize('config', [{'apikey': 'a-real-key'}, {'apikey': ''}, {}])
def test_a_filled_empty_or_absent_key_opens_the_store(monkeypatch, config):
    _patch_config(monkeypatch, config)
    g = _keyed(config)

    g.beginGlobal()

    assert g.opened


def test_a_driver_without_credential_fields_is_not_checked(monkeypatch):
    _patch_config(monkeypatch, {'apikey': '${ROCKETRIDE_NOT_SENT}'})
    g = _make()

    g.beginGlobal()

    assert g.opened
