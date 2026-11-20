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


def test_opensearch_with_basic_auth_stops_on_an_unfilled_password(monkeypatch):
    """With basic auth on, an unfilled password stops the store before the client is built.

    Args:
        monkeypatch (pytest.MonkeyPatch): installs the stand-in client module.
    """
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
    """Without basic auth, the password is never read, so the client gets none.

    Args:
        monkeypatch (pytest.MonkeyPatch): installs the stand-in client module.
    """
    conn_config = _opensearch_config(auth_enabled=False)
    module, client = _client_module()
    monkeypatch.setitem(sys.modules, OPENSEARCH_CLIENT, module)

    with patch('nodes.store_elasticsearch.IGlobal.IGlobalTransform.beginGlobal', return_value=None):
        _iglobal('opensearch', conn_config)._begin_opensearch(conn_config)

    assert client.call_args.kwargs['password'] is None


def test_the_opensearch_save_time_ping_is_not_sent_with_an_unfilled_password(monkeypatch, warnings):
    """The save-time ping is not sent with an unfilled password; a warning names the variable.

    Args:
        monkeypatch (pytest.MonkeyPatch): installs the stand-in client module.
        warnings (list): warnings logged by the save-time helper.
    """
    conn_config = _opensearch_config(auth_enabled=True)
    module, client = _client_module()
    monkeypatch.setitem(sys.modules, OPENSEARCH_CLIENT, module)

    _iglobal('opensearch', conn_config)._validate_opensearch()

    assert any(MISSING in line for line in warnings)
    client.assert_not_called()


def test_the_elasticsearch_save_time_health_check_is_not_sent_with_an_unfilled_key(monkeypatch, warnings):
    """The save-time health check is not sent with an unfilled API key; a warning names the variable.

    Args:
        monkeypatch (pytest.MonkeyPatch): stubs the node config and installs the stand-in client module.
        warnings (list): warnings logged by the save-time helper.
    """
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda logical_type, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)

    _iglobal('elasticsearch', {'apikey': PLACEHOLDER})._validate_elasticsearch()

    assert any(MISSING in line for line in warnings)
    elasticsearch.Elasticsearch.assert_not_called()


def test_the_elasticsearch_store_does_not_open_with_an_unfilled_key(monkeypatch):
    """The Elasticsearch store refuses to open with an unfilled API key and never builds the client.

    Args:
        monkeypatch (pytest.MonkeyPatch): stubs the node config and installs the stand-in client modules.
    """
    config = {'host': 'localhost', 'port': 9200, 'index': 'docs', 'apikey': PLACEHOLDER}
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, conn_config: dict(config)))
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    helpers = types.ModuleType('elasticsearch.helpers')
    helpers.bulk, helpers.scan = MagicMock(), MagicMock()
    helpers.BulkIndexError = type('BulkIndexError', (Exception,), {})

    import nodes.store_elasticsearch as package

    # Importing the module below also binds it as an attribute of the package.
    # monkeypatch restores the sys.modules entries but not that attribute, so
    # restore it too, or a later test could get this stand-in-backed module from
    # the package.
    monkeypatch.setattr(package, 'elasticsearch_store', getattr(package, 'elasticsearch_store', None), raising=False)
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)
    monkeypatch.setitem(sys.modules, 'elasticsearch.helpers', helpers)
    # setitem records what the entry held (or that it was absent) and puts it back
    # at teardown; the del lets the import below load the store against the
    # stand-ins.
    store_module = 'nodes.store_elasticsearch.elasticsearch_store'
    monkeypatch.setitem(sys.modules, store_module, sys.modules.get(store_module))
    del sys.modules[store_module]
    from nodes.store_elasticsearch.elasticsearch_store import Store

    # The store holds the stand-in client, so the check that it is never built
    # below is a real check.
    assert sys.modules[store_module].Elasticsearch is elasticsearch.Elasticsearch

    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        Store('elasticsearch', {'apikey': PLACEHOLDER}, {})

    elasticsearch.Elasticsearch.assert_not_called()
