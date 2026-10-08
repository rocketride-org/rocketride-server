"""ai.eaas — a bare --modelserver port names the model server on this host.

Tasks receive the address as given; a bare port carries no host for a launcher
to remap, and the client SDK would read the digits as a hostname.
"""

import sys
from unittest.mock import AsyncMock

import pytest

from ai import eaas
from ai.eaas import _normalize_modelserver
from ai.modules.task.launcher.docker import rewrite_loopback


@pytest.mark.parametrize(
    ('address', 'expected'),
    [
        ('5590', 'localhost:5590'),
        ('localhost:5590', 'localhost:5590'),
        ('192.168.1.100:5590', '192.168.1.100:5590'),
        ('wss://model.rocketride.dev:443', 'wss://model.rocketride.dev:443'),
    ],
)
def test_modelserver_address(address, expected):
    assert _normalize_modelserver(address) == expected


def test_a_bare_port_reaches_a_task_container_through_the_host_gateway():
    """What a bare port becomes is an address the docker runtime moves to the host gateway."""
    assert rewrite_loopback(_normalize_modelserver('5590')) == 'host.docker.internal:5590'


async def test_run_gives_the_server_the_full_address(monkeypatch):
    """run() normalizes --modelserver: the server, and so every task, gets host:port."""
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
    monkeypatch.setattr(eaas, '_make_engine_private', lambda: None)
    monkeypatch.setattr(account, 'init_account', AsyncMock())

    await eaas.run()

    assert seen['modelserver'] == 'localhost:5590'
