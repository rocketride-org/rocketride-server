# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""ai.eaas — the model server address tasks are given is a full one."""

import sys
from unittest.mock import AsyncMock

import pytest

from ai import eaas
from ai.eaas import create_parser, modelserver_of
from ai.modules.task.launcher.docker import rewrite_loopback


@pytest.mark.parametrize(
    'argv, expected',
    [
        ([], None),
        (['--modelserver=5590'], 'localhost:5590'),
        (['--modelserver= 5590 '], 'localhost:5590'),
        (['--modelserver=localhost:5590'], 'localhost:5590'),
        (['--modelserver=127.0.0.1:5590'], '127.0.0.1:5590'),
        (['--modelserver=192.168.1.100:5590'], '192.168.1.100:5590'),
        (['--modelserver=model.rocketride.dev:443'], 'model.rocketride.dev:443'),
        (['--modelserver=wss://model.rocketride.dev:443'], 'wss://model.rocketride.dev:443'),
    ],
)
def test_modelserver_bare_port_becomes_a_full_address(argv, expected):
    """A bare port names this host; every other form reaches tasks as given."""
    assert modelserver_of(create_parser().parse_args(argv)) == expected


def test_modelserver_bare_port_reaches_a_container_through_the_host_gateway():
    """What a bare port becomes is an address the docker runtime rewrites for a container."""
    address = modelserver_of(create_parser().parse_args(['--modelserver=5590']))
    assert rewrite_loopback(address) == 'host.docker.internal:5590'


async def test_run_gives_the_server_the_full_address(monkeypatch):
    """run() builds the configuration through modelserver_of: the server, and so every task, gets host:port."""
    from ai.account import account

    seen = {}

    class FakeServer:
        """A WebServer that keeps the configuration it is given and serves nothing."""

        def __init__(self, config, standardEndpoints):
            """Keep the configuration run() built."""
            seen.update(config)

        def use(self, name):
            """Take a module; nothing to load here."""

        async def serve(self):
            """Return at once."""

    monkeypatch.setattr(sys, 'argv', ['eaas.py', '--modelserver=5590'])
    monkeypatch.setattr(eaas, 'WebServer', FakeServer)
    monkeypatch.setattr(eaas, '_require_writable_task_data', lambda: None)
    monkeypatch.setattr(account, 'init_account', AsyncMock())

    await eaas.run()

    assert seen['modelserver'] == 'localhost:5590'
