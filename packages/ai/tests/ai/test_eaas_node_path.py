# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""An EaaS started with the retired --node_path still parses its arguments."""

from ai.eaas import create_parser


def test_node_path_is_accepted_and_hidden():
    parser = create_parser()

    assert parser.parse_args(['--node_path=/workspace']).node_path == '/workspace'
    assert '--node_path' not in parser.format_help()
