"""The stdio MCP client refuses to start on the engine's host.

A hosted engine starts a task that shares its host with ``--shared-host`` (see
the ``hosting`` module). The engine already refuses stdio MCP pipelines before
launch; this is the node's own second layer, and it must refuse before any
process is launched. ``--hosted`` alone does not refuse: that task runs on a
host of its own.
"""

import os
import subprocess
import sys

import pytest

_NODE_SRC = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'tool_mcp_client')
sys.path.insert(0, _NODE_SRC)

from mcp_stdio_client import McpStdioClient  # noqa: E402

_FLAGS = ('--hosted', '--shared-host')


class _Launched(Exception):
    pass


def _argv_with(monkeypatch, *flags):
    monkeypatch.setattr(sys, 'argv', [*(a for a in sys.argv if a not in _FLAGS), *flags])


def _popen_raises(monkeypatch):
    def _popen(*_a, **_k):
        raise _Launched()

    monkeypatch.setattr(subprocess, 'Popen', _popen)


@pytest.mark.parametrize('flags', [('--hosted', '--shared-host'), ('--shared-host',)])
def test_shared_host_refuses_stdio_before_launching(monkeypatch, flags):
    launched = []
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **k: launched.append(a))
    _argv_with(monkeypatch, *flags)

    with pytest.raises(RuntimeError, match='not available on RocketRide Cloud'):
        McpStdioClient(command='true', args=[]).start()
    assert launched == []


@pytest.mark.parametrize('flags', [(), ('--hosted',)])
def test_without_shared_host_start_reaches_popen(monkeypatch, flags):
    _popen_raises(monkeypatch)
    _argv_with(monkeypatch, *flags)

    with pytest.raises(_Launched):
        McpStdioClient(command='true', args=[]).start()
