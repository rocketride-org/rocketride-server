# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
An Elasticsearch or OpenSearch credential a saved variable did not fill never reaches the server.

The node reads the resolved config: the Elasticsearch key exists on the two
cloud branches, the OpenSearch password on the basic-auth branch. An unfilled
${...} stops the store before the client is built and stops the save-time
probe before the request, naming the variable.
"""

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

from ai.common import config as config_module
from ai.common.config import UnresolvedCredentialError

import nodes.store_elasticsearch.IValidator as validator
from nodes.store_elasticsearch.IGlobal import IGlobal

PLACEHOLDER = '${ROCKETRIDE_SEARCH_SECRET}'
MISSING = 'no variable named ROCKETRIDE_SEARCH_SECRET was found'


def _resolve(logical_type, conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    return resolveConfig(rocketlib.getServiceSchema(logical_type), conn_config)


def _iglobal(logical_type):
    glb = IGlobal.__new__(IGlobal)
    glb.glb = SimpleNamespace(logicalType=logical_type)
    glb.IEndpoint = MagicMock()
    return glb


def _validator(logical_type, conn_config):
    v = validator.IValidator()
    v.glb = SimpleNamespace(logicalType=logical_type, connConfig=conn_config)
    return v


@pytest.fixture
def opensearch_client(monkeypatch):
    """A stand-in OpenSearchClient class, installed where the node imports it."""
    client = MagicMock()
    module = types.ModuleType('nodes.store_elasticsearch.opensearch_client')
    module.OpenSearchClient = client
    monkeypatch.setitem(sys.modules, 'nodes.store_elasticsearch.opensearch_client', module)
    return client


@pytest.fixture
def warnings(monkeypatch):
    """Warnings from the save-time helper, which logs through ai.common.config."""
    captured = []
    monkeypatch.setattr(config_module, 'warning', captured.append)
    return captured


def test_opensearch_with_basic_auth_stops_on_an_unfilled_password(opensearch_client):
    """With basic auth on, an unfilled password stops the node before the client is built."""
    config = _resolve('opensearch', {'basic': {'password': PLACEHOLDER}})

    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        _iglobal('opensearch')._begin_opensearch(config)

    opensearch_client.assert_not_called()


def test_opensearch_without_basic_auth_has_no_password(opensearch_client):
    """Without basic auth the password is not part of the config, so the client gets none."""
    config = _resolve('opensearch', {'auth': 'none'})

    _iglobal('opensearch')._begin_opensearch(config)

    assert 'password' not in config
    assert opensearch_client.call_args.kwargs['password'] is None


def test_the_opensearch_password_is_required_with_basic_auth():
    """The basic-auth branch requires the password: the resolver names it."""
    with pytest.raises(ConfigError, match='password'):
        _resolve('opensearch', {})


def test_the_opensearch_save_time_ping_is_not_sent_with_an_unfilled_password(opensearch_client, warnings):
    """The save-time ping is not sent with an unfilled password; a warning names the variable."""
    _validator('opensearch', {'basic': {'password': PLACEHOLDER}}).validateConfig()

    assert any(MISSING in line for line in warnings)
    opensearch_client.assert_not_called()


def test_the_elasticsearch_save_time_health_check_is_not_sent_with_an_unfilled_key(monkeypatch, warnings):
    """The save-time health check is not sent with an unfilled API key; a warning names the variable."""
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = MagicMock()
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)

    _validator(
        'elasticsearch', {'profile': 'cloud-hosted', 'cloud-hosted': {'host': 'h', 'apikey': PLACEHOLDER}}
    ).validateConfig()

    assert any(MISSING in line for line in warnings)
    elasticsearch.Elasticsearch.assert_not_called()


def test_the_elasticsearch_store_does_not_open_with_an_unfilled_key(monkeypatch):
    """The Elasticsearch store refuses to open with an unfilled API key and never builds the client."""
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
    store_module = 'nodes.store_elasticsearch.elasticsearch_store'
    monkeypatch.setitem(sys.modules, store_module, sys.modules.get(store_module))
    sys.modules.pop(store_module, None)
    from nodes.store_elasticsearch.elasticsearch_store import Store

    # The store holds the stand-in client, so the check that it is never built
    # below is a real check.
    assert sys.modules[store_module].Elasticsearch is elasticsearch.Elasticsearch

    config = _resolve(
        'elasticsearch', {'profile': 'cloud-serverless', 'cloud-serverless': {'host': 'h', 'apikey': PLACEHOLDER}}
    )
    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        Store('elasticsearch', config, {})

    elasticsearch.Elasticsearch.assert_not_called()
