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
db_clickhouse DSN tests: the resolved config -> connection params -> SQLAlchemy URL.

The config reaches ``_connection_params`` the way ``beginGlobal`` hands it over:
through the real resolver, against the engine's schema for the real
services.json. No ClickHouse server is needed.
"""

import importlib
import sys
import types
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'db_clickhouse'
_LOGICAL_TYPE = 'db_clickhouse'


@pytest.fixture(scope='module')
def IGlobal():
    """Load db_clickhouse/IGlobal.py as a submodule of a synthetic package."""
    names = ('db_clickhouse', 'db_clickhouse.IGlobal')
    saved = {name: sys.modules.get(name) for name in names}
    package = types.ModuleType('db_clickhouse')
    package.__path__ = [str(NODE_DIR)]
    sys.modules['db_clickhouse'] = package
    try:
        yield importlib.import_module('db_clickhouse.IGlobal').IGlobal
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


@pytest.fixture
def g(IGlobal):
    """A bare IGlobal instance (no engine/lifecycle needed for these methods)."""
    return IGlobal.__new__(IGlobal)


def _resolve(conn_config):
    """Resolve a stored node config exactly as IGlobal.beginGlobal() would."""
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return resolveConfig(schema, conn_config)


# ---------------------------------------------------------------------------
# _connection_params
# ---------------------------------------------------------------------------


def test_connection_params_defaults(g):
    """An unconfigured node yields the schema defaults; the password is unset; tls off."""
    p = g._connection_params(_resolve({}))
    assert p == {
        'host': 'localhost',
        'user': 'default',
        'password': '',
        'database': 'default',
        'table': 'table',
        'tls': '',
    }


def test_connection_params_strips_but_keeps_password_whitespace(g):
    """Host/user/db/table are stripped; password is preserved verbatim."""
    p = g._connection_params(
        _resolve({'host': '  h  ', 'user': ' u ', 'database': ' db ', 'table': ' t ', 'password': '  pw  '})
    )
    assert (p['host'], p['user'], p['database'], p['table']) == ('h', 'u', 'db', 't')
    assert p['password'] == '  pw  '


def test_connection_params_null_values_mean_use_the_default(g):
    """A stored null is "unset": the resolver supplies the default instead of raising."""
    p = g._connection_params(_resolve({'host': None, 'user': None, 'password': None, 'database': None, 'table': None}))
    assert p == {
        'host': 'localhost',
        'user': 'default',
        'password': '',
        'database': 'default',
        'table': 'table',
        'tls': '',
    }


@pytest.mark.parametrize('value, expected', [(True, 'true'), (False, '')])
def test_connection_params_tls_flag(g, value, expected):
    """The tls boolean becomes the flag string _build_connection_url reads."""
    assert g._connection_params(_resolve({'tls': value}))['tls'] == expected


@pytest.mark.parametrize('stored', [{'tls': 'true'}, {'tls': '1'}, {'table': 42}, {'host': 7}])
def test_connection_params_refuses_wrongly_typed_values(stored):
    """Type coercion is gone: a string where the schema says boolean (or a number for a string) is a hard error."""
    with pytest.raises(ConfigError):
        _resolve(stored)


# ---------------------------------------------------------------------------
# _build_connection_url
# ---------------------------------------------------------------------------


def test_build_url_plaintext_local(g):
    """Without tls: plain native DSN, no port forced, no secure param."""
    url = g._build_connection_url(g._connection_params(_resolve({'host': 'localhost', 'user': 'u', 'password': 'p'})))
    assert url == 'clickhouse+native://u:p@localhost/default'


def test_build_url_tls_bare_host_defaults_to_9440(g):
    """With tls and no explicit port: assume the ClickHouse Cloud native TLS port 9440 and add ?secure=true."""
    url = g._build_connection_url(
        g._connection_params(_resolve({'host': 'cloud.example.com', 'user': 'default', 'password': 'pw', 'tls': True}))
    )
    assert url == 'clickhouse+native://default:pw@cloud.example.com:9440/default?secure=true'


def test_build_url_tls_keeps_explicit_port(g):
    """An explicit port is respected even when tls is on."""
    url = g._build_connection_url(
        g._connection_params(_resolve({'host': 'cloud.example.com:9000', 'password': 'pw', 'tls': True}))
    )
    assert url == 'clickhouse+native://default:pw@cloud.example.com:9000/default?secure=true'


def test_build_url_url_encodes_password(g):
    """Special characters in the password are URL-encoded so the DSN stays valid."""
    url = g._build_connection_url(g._connection_params(_resolve({'host': 'h', 'user': 'u', 'password': 'p@s/s#1'})))
    assert 'p%40s%2Fs%231' in url
    assert url == 'clickhouse+native://u:p%40s%2Fs%231@h/default'


def test_build_url_url_encodes_user_and_database(g):
    """User and database with reserved characters are URL-encoded, not just the password."""
    url = g._build_connection_url(
        g._connection_params(_resolve({'host': 'h', 'user': 'a@b', 'password': 'p', 'database': 'db/1'}))
    )
    assert url == 'clickhouse+native://a%40b:p@h/db%2F1'


def test_build_url_tls_ipv6_bare_defaults_to_9440(g):
    """A bracketed IPv6 literal with no port gets :9440 appended (brackets preserved)."""
    url = g._build_connection_url(g._connection_params(_resolve({'host': '[::1]', 'password': 'pw', 'tls': True})))
    assert url == 'clickhouse+native://default:pw@[::1]:9440/default?secure=true'


def test_build_url_tls_ipv6_keeps_explicit_port(g):
    """A bracketed IPv6 literal that already has a port is left unchanged."""
    url = g._build_connection_url(g._connection_params(_resolve({'host': '[::1]:9000', 'password': 'pw', 'tls': True})))
    assert url == 'clickhouse+native://default:pw@[::1]:9000/default?secure=true'


# ---------------------------------------------------------------------------
# _max_validation_attempts / _db_description
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'stored, expected', [({}, 5), ({'max_attempts': 9}, 9), ({'max_attempts': 1}, 1), ({'max_attempts': 20}, 20)]
)
def test_max_validation_attempts(g, stored, expected):
    """max_attempts arrives as the resolved integer, defaulted to 5."""
    assert g._max_validation_attempts(_resolve(stored)) == expected


@pytest.mark.parametrize(
    'stored', [{'max_attempts': 0}, {'max_attempts': -3}, {'max_attempts': 100}, {'max_attempts': '7'}]
)
def test_max_validation_attempts_out_of_range_is_refused(stored):
    """The documented 1..20 bounds are enforced by the resolver, not clamped by the node."""
    with pytest.raises(ConfigError):
        _resolve(stored)


@pytest.mark.parametrize(
    'stored, expected', [({}, ''), ({'db_description': 'sales events'}, 'sales events'), ({'db_description': None}, '')]
)
def test_db_description_always_returns_str(g, stored, expected):
    """_db_description honors its -> str contract; a stored null means the default."""
    result = g._db_description(_resolve(stored))
    assert isinstance(result, str)
    assert result == expected
