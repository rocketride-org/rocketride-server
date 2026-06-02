# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the ClickHouse node's only dialect-specific logic:
``IGlobal._connection_params`` and ``IGlobal._build_connection_url``.

Everything else (schema reflection, query execution, insertion) is inherited
unchanged from ``ai.common.database`` and is covered by that package's tests
(``packages/ai/tests/ai/common/database/test_db_base.py``). The genuinely new
ClickHouse code is the native-protocol DSN builder and its TLS branch, so that
is what we pin here.

The node module imports ``from ai.common.database import DatabaseGlobalBase``,
which would pull SQLAlchemy + rocketlib. We stub a trivial base into
``sys.modules`` and load ``IGlobal.py`` directly by file path so the test runs
without the full engine environment (mirroring how test_contracts mocks
engine libs).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'db_clickhouse'


@pytest.fixture(scope='module')
def IGlobal():
    """Load db_clickhouse/IGlobal.py with a stubbed ai.common.database base."""
    # Stub the ai.common.database package so the node import resolves without
    # SQLAlchemy/rocketlib. DatabaseGlobalBase only needs to be a plain base —
    # the two methods under test do not touch any base machinery.
    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    ai_db = types.ModuleType('ai.common.database')

    class _StubBase:  # noqa: D401 - trivial stand-in for DatabaseGlobalBase
        """Minimal stand-in so the concrete subclass is instantiable."""

    ai_db.DatabaseGlobalBase = _StubBase
    ai.common = ai_common
    ai_common.database = ai_db
    saved = {k: sys.modules.get(k) for k in ('ai', 'ai.common', 'ai.common.database')}
    sys.modules.update({'ai': ai, 'ai.common': ai_common, 'ai.common.database': ai_db})

    try:
        spec = importlib.util.spec_from_file_location('db_clickhouse_iglobal', NODE_DIR / 'IGlobal.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        yield mod.IGlobal
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


@pytest.fixture
def g(IGlobal):
    """A bare IGlobal instance (no engine/lifecycle needed for these methods)."""
    return IGlobal.__new__(IGlobal)


# ---------------------------------------------------------------------------
# _connection_params
# ---------------------------------------------------------------------------


def test_connection_params_defaults(g):
    """Empty config yields ClickHouse-appropriate defaults; tls off."""
    p = g._connection_params({})
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
    p = g._connection_params({'host': '  h  ', 'user': ' u ', 'database': ' db ', 'table': ' t ', 'password': '  pw  '})
    assert (p['host'], p['user'], p['database'], p['table']) == ('h', 'u', 'db', 't')
    assert p['password'] == '  pw  '


@pytest.mark.parametrize(
    'value, expected',
    [
        (True, 'true'),
        ('true', 'true'),
        ('True', 'true'),
        ('1', 'true'),
        ('yes', 'true'),
        ('on', 'true'),
        (False, ''),
        ('false', ''),
        ('0', ''),
        ('', ''),
        (None, ''),
    ],
)
def test_connection_params_tls_parsing(g, value, expected):
    """The tls flag accepts booleans and common truthy/falsey strings; 'false' is not truthy."""
    assert g._connection_params({'tls': value})['tls'] == expected


# ---------------------------------------------------------------------------
# _build_connection_url
# ---------------------------------------------------------------------------


def test_build_url_plaintext_local(g):
    """Without tls: plain native DSN, no port forced, no secure param."""
    url = g._build_connection_url(g._connection_params({'host': 'localhost', 'user': 'u', 'password': 'p'}))
    assert url == 'clickhouse+native://u:p@localhost/default'


def test_build_url_tls_bare_host_defaults_to_9440(g):
    """With tls and no explicit port: assume the ClickHouse Cloud native TLS port 9440 and add ?secure=true."""
    url = g._build_connection_url(
        g._connection_params({'host': 'cloud.example.com', 'user': 'default', 'password': 'pw', 'tls': True})
    )
    assert url == 'clickhouse+native://default:pw@cloud.example.com:9440/default?secure=true'


def test_build_url_tls_keeps_explicit_port(g):
    """An explicit port is respected even when tls is on."""
    url = g._build_connection_url(
        g._connection_params({'host': 'cloud.example.com:9000', 'password': 'pw', 'tls': 'true'})
    )
    assert url == 'clickhouse+native://default:pw@cloud.example.com:9000/default?secure=true'


def test_build_url_url_encodes_password(g):
    """Special characters in the password are URL-encoded so the DSN stays valid."""
    url = g._build_connection_url(g._connection_params({'host': 'h', 'user': 'u', 'password': 'p@s/s#1'}))
    assert 'p%40s%2Fs%231' in url
    assert url == 'clickhouse+native://u:p%40s%2Fs%231@h/default'


# ---------------------------------------------------------------------------
# _max_validation_attempts
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cfg, expected',
    [
        ({}, 5),
        ({'max_attempts': 9}, 9),
        ({'max_attempts': '7'}, 7),
        ({'max_attempts': 'nope'}, 5),
        ({'max_attempts': None}, 5),
    ],
)
def test_max_validation_attempts(g, cfg, expected):
    """max_attempts is read as int with a safe fallback of 5."""
    assert g._max_validation_attempts(cfg) == expected
