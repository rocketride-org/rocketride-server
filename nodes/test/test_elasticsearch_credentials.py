# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Elasticsearch and OpenSearch: an unfilled ${ROCKETRIDE_...} credential fails with its name, unsent.

Elasticsearch checks its API key when the store opens and before the save-time
health check. OpenSearch checks its password the same way, only when basic auth is
on: without it the password is never sent. The clients are stand-ins.
"""

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

import ai.common.config as config_module
from ai.common.config import Config, UnresolvedCredentialError

PLACEHOLDER = '${ROCKETRIDE_SEARCH_SECRET}'
MISSING = 'no variable named ROCKETRIDE_SEARCH_SECRET was found'
OPENSEARCH_CLIENT = 'nodes.store_elasticsearch.opensearch_client'


def _opensearch_config(auth_enabled):
    """Build a minimal OpenSearch connection config with a placeholder password."""
    return {
        'host': 'https://search.example',
        'collection': 'docs',
        'auth': {'enabled': auth_enabled, 'username': 'reader', 'password': PLACEHOLDER},
    }


def _iglobal(logical_type, conn_config):
    """Create an uninitialized IGlobal instance bound to the given connection config."""
    from nodes.store_elasticsearch.IGlobal import IGlobal

    glb = IGlobal.__new__(IGlobal)
    glb.glb = MagicMock(logicalType=logical_type, connConfig=conn_config)
    glb.IEndpoint = MagicMock()
    glb.search_enabled = False
    glb.store = None
    glb.getConnConfig = lambda: conn_config
    return glb


def _client_module():
    """Create a stub opensearch_client module and its OpenSearchClient mock."""
    client = MagicMock()
    module = types.ModuleType(OPENSEARCH_CLIENT)
    module.OpenSearchClient = client
    return module, client


@pytest.fixture
def warnings(monkeypatch):
    """Warnings from the save-time helper, which logs through ai.common.config."""
    captured = []
    monkeypatch.setattr(config_module, 'warning', captured.append)
    return captured


def test_opensearch_with_basic_auth_stops_on_an_unfilled_password(monkeypatch):
    """Reject an unresolved basic-auth password before constructing OpenSearchClient."""
    conn_config = _opensearch_config(auth_enabled=True)
    module, client = _client_module()
    monkeypatch.setitem(sys.modules, OPENSEARCH_CLIENT, module)

    with (
        patch('nodes.store_elasticsearch.IGlobal.IGlobalTransform.beginGlobal', return_value=None),
        pytest.raises(UnresolvedCredentialError, match=MISSING),
    ):
        _iglobal('opensearch', conn_config)._begin_opensearch(conn_config)

    client.assert_not_called()


def test_opensearch_without_basic_auth_never_reads_the_password(monkeypatch):
    """Ignore an unfilled password when basic auth is disabled."""
    conn_config = _opensearch_config(auth_enabled=False)
    module, client = _client_module()
    monkeypatch.setitem(sys.modules, OPENSEARCH_CLIENT, module)

    with patch('nodes.store_elasticsearch.IGlobal.IGlobalTransform.beginGlobal', return_value=None):
        _iglobal('opensearch', conn_config)._begin_opensearch(conn_config)

    assert client.call_args.kwargs['password'] is None


def test_the_opensearch_save_time_ping_is_not_sent_with_an_unfilled_password(monkeypatch, warnings):
    """Warn and skip the OpenSearch ping when the basic-auth password is an unfilled placeholder."""
    conn_config = _opensearch_config(auth_enabled=True)
    module, client = _client_module()
    monkeypatch.setitem(sys.modules, OPENSEARCH_CLIENT, module)

    _iglobal('opensearch', conn_config)._validate_opensearch()

    assert any(MISSING in line for line in warnings)
    client.assert_not_called()


def test_the_elasticsearch_save_time_health_check_is_not_sent_with_an_unfilled_key(monkeypatch, warnings):
    """Warn and skip the Elasticsearch health check when the API key is an unfilled placeholder."""
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda logical_type, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)

    _iglobal('elasticsearch', {'apikey': PLACEHOLDER})._validate_elasticsearch()

    assert any(MISSING in line for line in warnings)
    elasticsearch.Elasticsearch.assert_not_called()


def test_the_elasticsearch_store_does_not_open_with_an_unfilled_key(monkeypatch):
    """Raise UnresolvedCredentialError before constructing Elasticsearch when apikey is unfilled."""
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    helpers = types.ModuleType('elasticsearch.helpers')
    helpers.bulk, helpers.scan = MagicMock(), MagicMock()
    helpers.BulkIndexError = type('BulkIndexError', (Exception,), {})

    import nodes.store_elasticsearch as package

    # Patch only the stubbed entries rather than snapshotting all of sys.modules
    # with patch.dict: importing elasticsearch_store loads numpy for the first
    # time, and evicting numpy on teardown breaks subsequent numpy imports in
    # the same process (#3025).
    store_mod_name = 'nodes.store_elasticsearch.elasticsearch_store'
    if not hasattr(package, 'elasticsearch_store'):
        monkeypatch.setattr(package, 'elasticsearch_store', None, raising=False)
    monkeypatch.delattr(package, 'elasticsearch_store', raising=False)
    if store_mod_name not in sys.modules:
        monkeypatch.setitem(sys.modules, store_mod_name, None)
    monkeypatch.delitem(sys.modules, store_mod_name, raising=False)
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)
    monkeypatch.setitem(sys.modules, 'elasticsearch.helpers', helpers)

    from nodes.store_elasticsearch.elasticsearch_store import Store

    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        Store('elasticsearch', {'apikey': PLACEHOLDER}, {})

    elasticsearch.Elasticsearch.assert_not_called()


def test_numpy_remains_importable_after_store_credential_check():
    """Verify numpy stays in sys.modules and remains importable after credential test teardown."""
    assert 'elasticsearch' not in sys.modules
    assert 'nodes.store_elasticsearch.elasticsearch_store' not in sys.modules
    assert 'numpy' in sys.modules
    import numpy as np

    assert hasattr(np, 'array')
