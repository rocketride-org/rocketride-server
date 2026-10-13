# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The OSS account's environment verbs are write-only (saas#809).

``get_env`` lists the ROCKETRIDE_* names in os.environ with every value
replaced by ENV_MASK. ``set_env`` merges: a value is set, None deletes, the
mask keeps what is stored, and the mask itself can never be stored. The
SaaS handlers follow the same contract, so a client sees one behaviour.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from ai.account.oss import ENV_MASK, Account


class _Conn:
    def build_response(self, request, body=None):
        return {'ok': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'ok': False, 'message': message}


def _req(sub, **args):
    return {'command': 'rrext_account_me', 'arguments': {'subcommand': sub, **args}}


def _call(sub, **args):
    account = Account.__new__(Account)  # the constructor needs a server; the verbs do not
    return asyncio.run(account.handle_account(_Conn(), _req(sub, **args)))


@pytest.fixture
def env_file(monkeypatch, tmp_path):
    """A clean ROCKETRIDE_* environment and a .env beside a fake executable."""
    for key in [k for k in os.environ if k.startswith('ROCKETRIDE_')]:
        monkeypatch.delenv(key)
    monkeypatch.setattr('sys.executable', str(tmp_path / 'engine'))
    return tmp_path / '.env'


def _env_file_dict(path):
    if not path.exists():
        return {}
    lines = [line.strip() for line in path.read_text().splitlines()]
    return dict(line.split('=', 1) for line in lines if line and not line.startswith('#'))


def test_get_env_masks_every_value(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'sk-one')
    monkeypatch.setenv('ROCKETRIDE_B', 'sk-two')
    monkeypatch.setenv('OTHER', 'not-listed')

    resp = _call('get_env')

    assert resp == {'ok': True, 'body': {'env': {'ROCKETRIDE_A': ENV_MASK, 'ROCKETRIDE_B': ENV_MASK}}}
    assert 'sk-one' not in repr(resp)


def test_set_env_sets_and_keeps_the_rest(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'old-a')
    monkeypatch.setenv('ROCKETRIDE_B', 'old-b')

    resp = _call('set_env', env={'ROCKETRIDE_A': 'new-a'})

    assert resp == {'ok': True, 'body': {'updated': True}}
    assert os.environ['ROCKETRIDE_A'] == 'new-a' and os.environ['ROCKETRIDE_B'] == 'old-b'
    assert _env_file_dict(env_file) == {'ROCKETRIDE_A': 'new-a', 'ROCKETRIDE_B': 'old-b'}


def test_set_env_none_deletes_from_memory_and_file(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'a')
    monkeypatch.setenv('ROCKETRIDE_B', 'b')
    _call('set_env', env={'ROCKETRIDE_A': 'a'})  # the file holds both

    _call('set_env', env={'ROCKETRIDE_A': None})

    assert 'ROCKETRIDE_A' not in os.environ and os.environ['ROCKETRIDE_B'] == 'b'
    assert _env_file_dict(env_file) == {'ROCKETRIDE_B': 'b'}


def test_set_env_delete_list_removes_names(env_file, monkeypatch):
    """What the SDKs send: values in `env`, deletions in `delete`."""
    monkeypatch.setenv('ROCKETRIDE_A', 'a')
    monkeypatch.setenv('ROCKETRIDE_B', 'b')

    _call('set_env', env={'ROCKETRIDE_C': 'c'}, delete=['ROCKETRIDE_A'])

    assert 'ROCKETRIDE_A' not in os.environ
    assert _env_file_dict(env_file) == {'ROCKETRIDE_B': 'b', 'ROCKETRIDE_C': 'c'}


def test_set_env_mask_keeps_the_stored_value(env_file, monkeypatch):
    """The round trip a client makes: get_env, edit one, send it all back."""
    monkeypatch.setenv('ROCKETRIDE_A', 'keep-me')
    monkeypatch.setenv('ROCKETRIDE_B', 'b')

    names = _call('get_env')['body']['env']
    names['ROCKETRIDE_B'] = 'new-b'
    _call('set_env', env=names)

    assert os.environ['ROCKETRIDE_A'] == 'keep-me' and os.environ['ROCKETRIDE_B'] == 'new-b'
    assert _env_file_dict(env_file) == {'ROCKETRIDE_A': 'keep-me', 'ROCKETRIDE_B': 'new-b'}


def test_set_env_never_stores_the_mask(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'a')

    resp = _call('set_env', env={'ROCKETRIDE_NEW': ENV_MASK, 'ROCKETRIDE_B': 'b'})

    assert resp['ok'] is False and 'ROCKETRIDE_NEW' in resp['message']
    assert 'ROCKETRIDE_NEW' not in os.environ and 'ROCKETRIDE_B' not in os.environ
    assert not env_file.exists()


def test_set_env_rejects_unsupported_names_and_writes_nothing(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'a')

    resp = _call('set_env', env={'OPENAI_API_KEY': 'sk-secret-value', 'ROCKETRIDE_B': 'b'})

    assert resp['ok'] is False and 'OPENAI_API_KEY' in resp['message']
    assert 'sk-secret-value' not in resp['message'] and 'b' != os.environ.get('ROCKETRIDE_B')
    assert os.environ['ROCKETRIDE_A'] == 'a'
    assert not env_file.exists()


def test_set_env_writes_a_non_ascii_value_on_any_locale(env_file, monkeypatch):
    """The .env file is UTF-8 regardless of the process locale (the loader reads UTF-8)."""
    monkeypatch.setattr('locale.getpreferredencoding', lambda do_setlocale=True: 'ascii')

    resp = _call('set_env', env={'ROCKETRIDE_A': 'cl\u00e9-\u00f1'})

    assert resp == {'ok': True, 'body': {'updated': True}}
    assert env_file.read_text(encoding='utf-8') == 'ROCKETRIDE_A=cl\u00e9-\u00f1\n'


def test_env_keys_lists_names_only(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_B', 'b')
    monkeypatch.setenv('ROCKETRIDE_A', 'a')

    assert _call('env_keys') == {'ok': True, 'body': {'keys': ['ROCKETRIDE_A', 'ROCKETRIDE_B']}}


def test_other_commands_still_require_saas():
    account = Account.__new__(Account)
    with pytest.raises(NotImplementedError):
        asyncio.run(account.handle_account(_Conn(), {'command': 'rrext_account_org', 'arguments': {}}))
