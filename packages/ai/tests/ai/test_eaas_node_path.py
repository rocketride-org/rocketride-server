# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""An EaaS started with the retired --node_path still parses its arguments."""

import sys

import pytest

from ai.eaas import create_parser


def test_node_path_is_accepted_and_hidden():
    parser = create_parser()

    assert parser.parse_args(['--node_path=/workspace']).node_path == '/workspace'
    assert '--node_path' not in parser.format_help()


@pytest.mark.parametrize('value', ['/workspace', ''])
async def test_a_launcher_that_still_passes_node_path_is_told_where_nodes_go(monkeypatch, value):
    from ai import eaas

    class Stop(Exception):
        pass

    def stop():
        raise Stop

    warned = []
    monkeypatch.setattr(eaas, 'warning', warned.append)
    monkeypatch.setattr(eaas, '_require_writable_task_data', stop)
    monkeypatch.setattr(sys, 'argv', ['eaas.py', f'--node_path={value}'])

    with pytest.raises(Stop):
        await eaas.run()

    assert warned == ["--node_path is no longer read: put a custom node in the engine's nodes/ directory"]
