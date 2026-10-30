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
    return {
        'host': 'https://search.example',
        'collection': 'docs',
        'auth': {'enabled': auth_enabled, 'username': 'reader', 'password': PLACEHOLDER},
    }


def _iglobal(logical_type, conn_config):
    from nodes.store_elasticsearch.IGlobal import IGlobal

    glb = IGlobal.__new__(IGlobal)
    glb.glb = MagicMock(logicalType=logical_type, connConfig=conn_config)
    glb.IEndpoint = MagicMock()
    glb.search_enabled = False
    glb.store = None
    glb.getConnConfig = lambda: conn_config
    return glb


def _client_module():
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


def test_opensearch_with_basic_auth_stops_on_an_unfilled_password():
    conn_config = _opensearch_config(auth_enabled=True)
    module, client = _client_module()

    with (
        patch.dict(sys.modules, {OPENSEARCH_CLIENT: module}),
        patch('nodes.store_elasticsearch.IGlobal.IGlobalTransform.beginGlobal', return_value=None),
        pytest.raises(UnresolvedCredentialError, match=MISSING),
    ):
        _iglobal('opensearch', conn_config)._begin_opensearch(conn_config)

    client.assert_not_called()


def test_opensearch_without_basic_auth_never_reads_the_password():
    conn_config = _opensearch_config(auth_enabled=False)
    module, client = _client_module()

    with (
        patch.dict(sys.modules, {OPENSEARCH_CLIENT: module}),
        patch('nodes.store_elasticsearch.IGlobal.IGlobalTransform.beginGlobal', return_value=None),
    ):
        _iglobal('opensearch', conn_config)._begin_opensearch(conn_config)

    assert client.call_args.kwargs['password'] is None


def test_the_opensearch_save_time_ping_is_not_sent_with_an_unfilled_password(warnings):
    conn_config = _opensearch_config(auth_enabled=True)
    module, client = _client_module()

    with patch.dict(sys.modules, {OPENSEARCH_CLIENT: module}):
        _iglobal('opensearch', conn_config)._validate_opensearch()

    assert any(MISSING in line for line in warnings)
    client.assert_not_called()


def test_the_elasticsearch_save_time_health_check_is_not_sent_with_an_unfilled_key(monkeypatch, warnings):
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda logical_type, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()

    with patch.dict(sys.modules, {'elasticsearch': elasticsearch}):
        _iglobal('elasticsearch', {'apikey': PLACEHOLDER})._validate_elasticsearch()

    assert any(MISSING in line for line in warnings)
    elasticsearch.Elasticsearch.assert_not_called()


def test_the_elasticsearch_store_does_not_open_with_an_unfilled_key(monkeypatch):
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    helpers = types.ModuleType('elasticsearch.helpers')
    helpers.bulk, helpers.scan = MagicMock(), MagicMock()
    helpers.BulkIndexError = type('BulkIndexError', (Exception,), {})

    with patch.dict(sys.modules, {'elasticsearch': elasticsearch, 'elasticsearch.helpers': helpers}):
        sys.modules.pop('nodes.store_elasticsearch.elasticsearch_store', None)
        from nodes.store_elasticsearch.elasticsearch_store import Store

        with pytest.raises(UnresolvedCredentialError, match=MISSING):
            Store('elasticsearch', {'apikey': PLACEHOLDER}, {})

    elasticsearch.Elasticsearch.assert_not_called()
