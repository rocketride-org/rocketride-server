"""The stdio MCP client refuses to start under a hosted engine.

A hosted engine starts task subprocesses with ``--hosted`` (see
``task_engine.CONST_HOSTED_CHILD_FLAG``). The engine already refuses stdio MCP
pipelines before launch; this is the node's own second layer, and it must
refuse before any process is launched.
"""

import os
import subprocess
import sys

import pytest

_NODE_SRC = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'tool_mcp_client')
sys.path.insert(0, _NODE_SRC)

from mcp_stdio_client import McpStdioClient  # noqa: E402


def test_hosted_engine_refuses_stdio_before_launching(monkeypatch):
    launched = []
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **k: launched.append(a))
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])

    with pytest.raises(RuntimeError, match='not available on RocketRide Cloud'):
        McpStdioClient(command='true', args=[]).start()
    assert launched == []


def test_without_the_flag_start_reaches_popen(monkeypatch):
    class _Launched(Exception):
        pass

    def _popen(*_a, **_k):
        raise _Launched()

    monkeypatch.setattr(subprocess, 'Popen', _popen)
    monkeypatch.setattr(sys, 'argv', [a for a in sys.argv if a != '--hosted'])

    with pytest.raises(_Launched):
        McpStdioClient(command='true', args=[]).start()
