"""Unit tests for rocketlib hosting.py — the two flags a hosted engine gives a task.

Each question has its own flag: ``--hosted`` alone does not mean the task
shares the engine's host, and ``--shared-host`` alone does not make it hosted.
"""

import sys

import pytest

import hosting


@pytest.mark.parametrize(
    ('flags', 'hosted', 'shared_host'),
    [
        ([], False, False),
        (['--hosted'], True, False),
        (['--shared-host'], False, True),
        (['--hosted', '--shared-host'], True, True),
    ],
)
def test_each_flag_answers_its_own_question(monkeypatch, flags, hosted, shared_host):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', *flags])

    assert hosting.is_hosted() is hosted
    assert hosting.is_shared_host() is shared_host


@pytest.mark.parametrize(
    'argv, address',
    [
        (['engine', 'node.py'], None),
        (['engine', 'node.py', '--modelserver='], None),
        (['engine', 'node.py', '--modelserver=localhost:5590'], 'localhost:5590'),
        (['engine', 'node.py', '--modelserver=wss://model.rocketride.dev:443'], 'wss://model.rocketride.dev:443'),
        (['engine', 'node.py', '--modelserver=first', '--modelserver=second'], 'first'),
        (['engine', 'node.py', '--hosted'], None),
    ],
)
def test_model_server_address_reads_the_first_non_empty_flag(monkeypatch, argv, address):
    """The address is returned as given; an empty value is no model server; --hosted alone is none."""
    monkeypatch.setattr(sys, 'argv', argv)
    assert hosting.model_server_address() == address
    assert hosting.delegates_to_model_server() is (address is not None)
