# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Checks on core/services.common.supabase.json (the shared connection fields)."""

from __future__ import annotations

from ._support import NODE_DIR, config_key, load_common_fields

API_FIELDS = {'supabase.authType', 'supabase.url', 'supabase.secretKey', 'supabase.access'}
PG_FIELDS = {
    'supabase.pooler.host',
    'supabase.pooler.user',
    'supabase.pooler.password',
    'supabase.pooler.database',
    'supabase.access',
}


def test_shared_fields_exist():
    fields = load_common_fields()
    assert API_FIELDS | PG_FIELDS <= set(fields)


def test_config_keys_are_what_the_code_reads():
    """The engine strips the namespace; supabase_client reads these exact keys."""
    keys = {config_key(f) for f in load_common_fields()}
    assert keys == {'authType', 'url', 'secretKey', 'access', 'host', 'user', 'password', 'database'}


def test_secrets_are_secure():
    fields = load_common_fields()
    for name in ('supabase.secretKey', 'supabase.pooler.password'):
        assert fields[name].get('secure') is True
        assert fields[name]['ui']['ui:widget'] == 'password'


def test_access_defaults_to_read():
    access = load_common_fields()['supabase.access']
    assert access['default'] == 'read'
    assert [v[0] for v in access['enum']] == ['read', 'write', 'admin']


def test_auth_type_is_key_only_and_shows_key_fields():
    auth = load_common_fields()['supabase.authType']
    assert auth['default'] == 'key'
    assert [v[0] for v in auth['enum']] == ['key']
    assert auth['conditional'] == [{'value': 'key', 'properties': ['supabase.url', 'supabase.secretKey']}]


def test_no_postgresdb_fields_in_shared_file():
    """postgresdb.* is db_postgres's (and Database's) private namespace: a global
    definition would be deep-merged into db_postgres's own fields.
    """
    assert not [f for f in load_common_fields() if f.startswith('postgresdb.')]


def test_icon_and_requirements_present():
    assert (NODE_DIR / 'supabase.svg').is_file()
    reqs = (NODE_DIR / 'requirements.txt').read_text()
    assert 'supabase' in reqs and 'psycopg2-binary' in reqs
