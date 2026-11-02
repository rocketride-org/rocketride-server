"""ai.eaas — a bare --modelserver port names the model server on this host.

Tasks receive the address as given; a bare port carries no host for a launcher
to remap, and the client SDK would read the digits as a hostname.
"""

import pytest

from ai.eaas import _normalize_modelserver


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
