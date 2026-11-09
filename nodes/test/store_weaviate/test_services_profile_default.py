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
What the Weaviate node's stored config resolves to.

The host type is one selector with one default, so an unconfigured node
connects to a local server out of the box, and every branch the selector
offers resolves to a usable connection.
"""

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig


def _resolve(conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    schema = rocketlib.getServiceSchema('weaviate')
    assert schema is not None, 'weaviate is not registered with the engine'
    return resolveConfig(schema, conn_config)


def test_an_unconfigured_node_connects_to_a_local_server():
    """The default branch ships a usable host, not an empty one to fill in."""
    config = _resolve({})

    assert config['profile'] == 'local'
    assert (config['host'], config['port'], config['grpc_port']) == ('localhost', 8080, 50051)
    assert config['collection'] == 'ROCKETRIDE'
    assert 'apikey' not in config


def test_the_cloud_branch_needs_a_host_and_a_key():
    """Weaviate Cloud has no default host; the key is the credential and required."""
    with pytest.raises(ConfigError) as raised:
        _resolve({'profile': 'cloud'})
    assert 'host' in str(raised.value) and 'apikey' in str(raised.value)

    config = _resolve({'profile': 'cloud', 'cloud': {'host': 'c.weaviate.cloud', 'apikey': 'k'}})
    assert (config['host'], config['apikey']) == ('c.weaviate.cloud', 'k')
    assert 'port' not in config and 'grpc_port' not in config


def test_switching_branches_keeps_the_other_branch_values():
    """A stored cloud block survives switching back to local: it is carried, not validated."""
    config = _resolve({'profile': 'local', 'cloud': {'host': 'c.weaviate.cloud'}, 'local': {'port': 9999}})

    assert config['profile'] == 'local' and config['port'] == 9999


def test_a_stale_branch_value_is_an_error():
    with pytest.raises(ConfigError, match='profile'):
        _resolve({'profile': 'hybrid'})
