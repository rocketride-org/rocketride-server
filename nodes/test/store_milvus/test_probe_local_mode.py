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

"""The Milvus save-time probe sends the token to a cloud server only, and resolves the stored config first."""

import sys
import types
from types import SimpleNamespace

import pytest
from rocketlib.config import ConfigError


import nodes.store_milvus.IValidator as validator


@pytest.fixture
def probe(monkeypatch):
    """The probe with pymilvus and depends stood in; returns the connect calls and warnings."""
    calls = []
    pymilvus = types.ModuleType('pymilvus')
    pymilvus.connections = SimpleNamespace(connect=lambda **kw: calls.append(kw), disconnect=lambda alias: None)
    pymilvus.utility = SimpleNamespace(get_server_version=lambda using=None: '2.4')
    pymilvus.exceptions = SimpleNamespace(MilvusException=type('MilvusException', (Exception,), {}))
    depends = types.ModuleType('depends')
    depends.depends = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, 'pymilvus', pymilvus)
    monkeypatch.setitem(sys.modules, 'depends', depends)
    monkeypatch.setattr(validator, 'warning', lambda msg: calls.append({'warning': msg}))
    # The unfilled-credential message is logged by the shared helper's module (ai.common.config)
    helper_module = sys.modules[validator.warn_if_credential_unresolved.__module__]
    monkeypatch.setattr(helper_module, 'warning', lambda msg: calls.append({'warning': msg}))
    return calls


def _validator(conn_config):
    v = validator.IValidator()
    v.glb = SimpleNamespace(logicalType='milvus', connConfig=conn_config)
    return v


def test_a_local_server_gets_no_token(probe):
    """The local branch has no key; the probe connects by host and port."""
    _validator({'profile': 'local', 'collection': 'docs'}).validateConfig()

    assert probe == [{'alias': 'validate', 'host': 'localhost', 'port': 19530, 'timeout': 5}]


def test_a_cloud_server_still_gets_its_token(probe):
    """In cloud mode the probe connects by URI with the token."""
    _validator({'cloud': {'host': 'https://x.cloud', 'apikey': 'tok'}, 'collection': 'docs'}).validateConfig()

    assert probe == [{'alias': 'validate', 'uri': 'https://x.cloud:443', 'token': 'tok', 'timeout': 5}]


def test_an_unfilled_cloud_token_is_reported_and_not_sent(probe):
    """A ${...} no variable filled names the variable instead of reaching the server."""
    _validator({'cloud': {'host': 'x.cloud', 'apikey': '${ROCKETRIDE_MILVUS_KEY}'}}).validateConfig()

    assert len(probe) == 1 and 'ROCKETRIDE_MILVUS_KEY' in probe[0]['warning']


def test_a_bad_collection_name_is_reported_before_connecting(probe):
    _validator({'profile': 'local', 'collection': 'bad-name'}).validateConfig()

    assert len(probe) == 1 and 'Invalid collection name' in probe[0]['warning']


def test_a_missing_cloud_key_fails_the_schema_check(probe):
    """The cloud branch requires the key: the resolver refuses before any probe."""
    with pytest.raises(ConfigError, match='apikey'):
        _validator({'cloud': {'host': 'x.cloud'}}).validateConfig()
    assert probe == []
