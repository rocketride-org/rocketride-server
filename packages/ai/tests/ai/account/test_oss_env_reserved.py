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

"""OSS account env handlers and the database broker credential.

``ROCKETRIDE_*`` is the namespace a client can read (``get_env``), rewrite
(``set_env``) and expand into any node config (``${ROCKETRIDE_...}``). The
names below belong to the engine, not to the client: the broker credential
mints ANY tenant's DSN, and the DSN delivery names are the engine's own. They
must not be listed, readable, expandable, creatable, changeable or deletable
through those paths (in ``os.environ`` or in the ``.env`` file).
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

from ai.account.oss import Account
from ai.modules.task.pipeline import resolve_pipeline_env

RESERVED = {
    'ROCKETRIDE_DB_BROKER_URL': 'https://operator-broker.internal/provision',
    'ROCKETRIDE_DB_BROKER_TOKEN': 'OPERATOR-BROKER-TOKEN',
    'ROCKETRIDE_DB_DSNS': '{"org": "postgresql://engine-owned"}',
    'ROCKETRIDE_DB_DSN': 'postgresql://engine-owned-single',
    'ROCKETRIDE_DB_RESOLVE_ERROR': 'engine-owned reason',
}
USER = {'ROCKETRIDE_OPENAI_KEY': 'user-key', 'ROCKETRIDE_DB_HOTDATA_KEY': 'hotdata-key'}


class _Conn:
    def build_response(self, request, body=None):
        return body


@pytest.fixture()
def server(monkeypatch, tmp_path):
    """An OSS server whose operator configured a broker, with a scratch .env."""
    monkeypatch.setattr(os, 'environ', {'PATH': os.environ.get('PATH', ''), **RESERVED, **USER})
    monkeypatch.setattr(sys, 'executable', str(tmp_path / 'engine'))  # the .env lives next to it
    env_file = tmp_path / '.env'
    env_file.write_text(
        '# operator settings\n'
        + ''.join(f'{k}={v}\n' for k, v in RESERVED.items())
        + ''.join(f'{k}={v}\n' for k, v in USER.items())
        + 'NOT_ROCKETRIDE=keep\n'
    )
    return env_file


def _call(sub, **args):
    request = {'command': 'rrext_account_me', 'arguments': {'subcommand': sub, **args}}
    return asyncio.run(Account().handle_account(_Conn(), request))


def _env_file_pairs(path):
    pairs = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            pairs[key] = value
    return pairs


def test_get_env_hides_the_engine_owned_names(server):
    env = _call('get_env')['env']
    assert set(env) == set(USER)  # ROCKETRIDE_DB_HOTDATA_KEY and friends stay visible
    assert not set(env) & set(RESERVED)


def test_env_keys_hides_the_engine_owned_names(server):
    assert _call('env_keys')['keys'] == sorted(USER)


def test_a_client_round_trip_leaves_the_reserved_values_alone(server):
    """A UI reads get_env, edits a key and writes the lot back."""
    env = _call('get_env')['env']
    env['ROCKETRIDE_OPENAI_KEY'] = 'edited'
    _call('set_env', env=env)
    assert os.environ['ROCKETRIDE_OPENAI_KEY'] == 'edited'
    assert {k: os.environ[k] for k in RESERVED} == RESERVED
    assert {k: v for k, v in _env_file_pairs(server).items() if k in RESERVED} == RESERVED


def test_set_env_without_the_reserved_names_does_not_delete_them(server):
    _call('set_env', env={'ROCKETRIDE_FOO': '1'})
    assert {k: os.environ[k] for k in RESERVED} == RESERVED
    assert {k: v for k, v in _env_file_pairs(server).items() if k in RESERVED} == RESERVED
    assert 'ROCKETRIDE_OPENAI_KEY' not in os.environ  # ordinary names keep replace-all semantics
    assert _env_file_pairs(server)['NOT_ROCKETRIDE'] == 'keep'


def test_set_env_cannot_change_a_reserved_name(server):
    _call(
        'set_env',
        env={'ROCKETRIDE_DB_BROKER_URL': 'https://attacker.example/collect', 'ROCKETRIDE_DB_DSNS': '{"org": "x"}'},
    )
    assert os.environ['ROCKETRIDE_DB_BROKER_URL'] == RESERVED['ROCKETRIDE_DB_BROKER_URL']
    assert os.environ['ROCKETRIDE_DB_DSNS'] == RESERVED['ROCKETRIDE_DB_DSNS']
    assert 'attacker.example' not in server.read_text()


def test_set_env_cannot_create_a_reserved_name(server):
    for name in RESERVED:
        del os.environ[name]
    server.write_text('')
    _call('set_env', env=dict(RESERVED))
    assert not set(os.environ) & set(RESERVED)
    assert not set(_env_file_pairs(server)) & set(RESERVED)


def test_merged_env_omits_the_reserved_names(server):
    merged = asyncio.run(Account().get_merged_env('u', 'o', 't'))
    assert not set(merged) & set(RESERVED)
    assert merged['ROCKETRIDE_OPENAI_KEY'] == 'user-key'


def test_a_pipeline_cannot_expand_the_broker_credential(server):
    """${ROCKETRIDE_DB_BROKER_TOKEN} in a node config (an imported .pipe) must not
    turn into the operator's token.
    """
    merged = asyncio.run(Account().get_merged_env('u', 'o', 't'))
    pipeline = {
        'components': [
            {
                'id': 'x',
                'provider': 'webhook',
                'config': {
                    'header': '${ROCKETRIDE_DB_BROKER_TOKEN}',
                    'url': '${ROCKETRIDE_DB_BROKER_URL}',
                    'key': '${ROCKETRIDE_OPENAI_KEY}',
                },
            }
        ]
    }
    config = resolve_pipeline_env(pipeline, merged)['components'][0]['config']
    assert config['header'] == '${ROCKETRIDE_DB_BROKER_TOKEN}'
    assert config['url'] == '${ROCKETRIDE_DB_BROKER_URL}'
    assert config['key'] == 'user-key'
    assert 'OPERATOR-BROKER-TOKEN' not in str(config)
