# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The OSS account's environment verbs are write-only (saas#827).

``get_env`` lists the ROCKETRIDE_* names in os.environ with every value
replaced by ENV_MASK. ``update_env``, and ``set_env`` for older clients, merge: a value is set, None deletes, the
mask keeps what is stored, and the mask itself can never be stored. The
SaaS handlers follow the same contract, so a client sees one behaviour.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from dotenv import dotenv_values

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
    """The .env as load_dotenv reads it at start-up."""
    return dict(dotenv_values(path)) if path.exists() else {}


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


def test_the_env_file_is_written_as_utf8_on_any_locale(env_file, monkeypatch):
    """The .env file is UTF-8 regardless of the process locale (the loader reads UTF-8)."""
    monkeypatch.setattr('locale.getpreferredencoding', lambda do_setlocale=True: 'ascii')

    Account._write_env_file(str(env_file), {'ROCKETRIDE_A': 'cl\u00e9-\u00f1'})

    assert env_file.read_text(encoding='utf-8') == "ROCKETRIDE_A='cl\u00e9-\u00f1'\n"


def test_env_keys_lists_names_only(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_B', 'b')
    monkeypatch.setenv('ROCKETRIDE_A', 'a')

    assert _call('env_keys') == {'ok': True, 'body': {'keys': ['ROCKETRIDE_A', 'ROCKETRIDE_B']}}


def test_other_commands_still_require_saas():
    account = Account.__new__(Account)
    with pytest.raises(NotImplementedError):
        asyncio.run(account.handle_account(_Conn(), {'command': 'rrext_account_org', 'arguments': {}}))


def test_update_env_is_the_merge_the_sdks_send(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'old-a')
    monkeypatch.setenv('ROCKETRIDE_B', 'old-b')

    resp = _call('update_env', env={'ROCKETRIDE_A': 'new-a'}, delete=['ROCKETRIDE_B'])

    assert resp == {'ok': True, 'body': {'updated': True}}
    assert os.environ['ROCKETRIDE_A'] == 'new-a' and 'ROCKETRIDE_B' not in os.environ
    assert _env_file_dict(env_file) == {'ROCKETRIDE_A': 'new-a'}


@pytest.mark.parametrize(
    'args',
    [
        {'env': {'ROCKETRIDE_A': 42}},
        {'env': {'ROCKETRIDE_A': {'nested': 'x'}}},
        {'env': ['ROCKETRIDE_A']},
        {'env': {}, 'delete': 'ROCKETRIDE_A'},
        {'env': {}, 'delete': [['ROCKETRIDE_A']]},
        {'env': {}, 'delete': [{'name': 'ROCKETRIDE_A'}]},
        {'env': {}, 'delete': [42]},
    ],
)
def test_a_value_that_is_not_a_string_writes_nothing(env_file, monkeypatch, args):
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')

    resp = _call('update_env', **args)

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert os.environ['ROCKETRIDE_A'] == 'kept' and not env_file.exists()


def test_a_env_file_that_cannot_be_read_leaves_memory_as_it_was(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')
    env_file.write_bytes(b'ROCKETRIDE_A=\xff\xfe legacy\n')

    resp = _call('update_env', env={'ROCKETRIDE_B': 'new'})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert os.environ['ROCKETRIDE_A'] == 'kept' and 'ROCKETRIDE_B' not in os.environ


def test_a_value_the_process_environment_cannot_hold_writes_nothing(env_file, monkeypatch):
    """Under an ASCII locale os.environ cannot hold a non-ASCII value: refused before memory or file change."""
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')
    encode = os.environ.encodevalue

    def ascii_locale(value):
        value.encode('ascii')
        return encode(value)

    monkeypatch.setattr(os.environ, 'encodevalue', ascii_locale)

    resp = _call('update_env', env={'ROCKETRIDE_B': 'cl\u00e9'})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert os.environ['ROCKETRIDE_A'] == 'kept' and 'ROCKETRIDE_B' not in os.environ
    assert not env_file.exists()


def test_a_name_the_process_environment_cannot_hold_writes_nothing(env_file, monkeypatch):
    """Under an ASCII locale os.environ cannot hold a non-ASCII name: refused before memory or file change."""
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')
    encode = os.environ.encodekey

    def ascii_locale(name):
        name.encode('ascii')
        return encode(name)

    monkeypatch.setattr(os.environ, 'encodekey', ascii_locale)

    resp = _call('update_env', env={'ROCKETRIDE_CL\u00c9': 'v'})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert os.environ['ROCKETRIDE_A'] == 'kept' and all(k != 'ROCKETRIDE_CL\u00c9' for k in os.environ)
    assert not env_file.exists()


@pytest.mark.parametrize(
    'name',
    [
        'ROCKETRIDE_A=B',
        'ROCKETRIDE_',
        'ROCKETRIDE_A B',
        'ROCKETRIDE_A\nX',
        'ROCKETRIDE_A\0',
        'ROCKETRIDE_A#B',
        "ROCKETRIDE_'A'",
    ],
)
def test_a_name_the_environment_cannot_hold_writes_nothing(env_file, monkeypatch, name):
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')

    resp = _call('update_env', env={name: 'value'})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert os.environ['ROCKETRIDE_A'] == 'kept' and not env_file.exists()


@pytest.mark.parametrize('value', ['a\nROCKETRIDE_INJECTED=1', 'a\rb', 'a\0b', 'x${HOME}y'])
def test_a_value_that_ends_a_env_line_writes_nothing(env_file, monkeypatch, value):
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')

    resp = _call('update_env', env={'ROCKETRIDE_B': value})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert value not in resp['message']
    assert 'ROCKETRIDE_B' not in os.environ and not env_file.exists()


def test_a_env_file_that_fails_to_write_is_left_as_it_was(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'kept')
    env_file.write_text('# mine\nROCKETRIDE_A=kept\n', encoding='utf-8')

    def full_disk(src, dst):
        raise OSError(28, 'No space left on device')

    monkeypatch.setattr(os, 'replace', full_disk)

    resp = _call('update_env', env={'ROCKETRIDE_B': 'new'})

    assert resp['ok'] is False and 'nothing was saved' in resp['message']
    assert env_file.read_text(encoding='utf-8') == '# mine\nROCKETRIDE_A=kept\n'
    assert [f.name for f in env_file.parent.iterdir()] == ['.env']
    assert 'ROCKETRIDE_B' not in os.environ


@pytest.mark.skipif(os.name == 'nt', reason='POSIX permission bits')
def test_a_rewritten_env_file_keeps_its_permissions(env_file, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_A', 'a')
    env_file.write_text('ROCKETRIDE_A=a\n', encoding='utf-8')
    env_file.chmod(0o640)

    assert _call('update_env', env={'ROCKETRIDE_B': 'b'})['ok'] is True

    assert env_file.stat().st_mode & 0o777 == 0o640
    assert _env_file_dict(env_file) == {'ROCKETRIDE_A': 'a', 'ROCKETRIDE_B': 'b'}


@pytest.mark.parametrize('name', ['ROCKETRIDE_my-key', 'ROCKETRIDE_a.b'])
def test_a_name_any_rocketride_scope_takes_is_saved(env_file, monkeypatch, name):
    assert _call('update_env', env={name: 'v'})['ok'] is True

    assert os.environ[name] == 'v' and _env_file_dict(env_file) == {name: 'v'}


def test_a_saved_value_reads_back_the_same_at_start_up(env_file, monkeypatch):
    """load_dotenv cuts an unquoted value at ' #' and strips its quotes and spaces."""
    values = {
        'ROCKETRIDE_A': 'abc #def',
        'ROCKETRIDE_B': 'x$HOME y',
        'ROCKETRIDE_C': '"quoted"',
        'ROCKETRIDE_D': "it's",
        'ROCKETRIDE_E': "back\\slash \\' end",
        'ROCKETRIDE_F': ' padded ',
    }

    assert _call('update_env', env=values)['ok'] is True

    assert _env_file_dict(env_file) == values
