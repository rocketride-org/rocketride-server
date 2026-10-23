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
