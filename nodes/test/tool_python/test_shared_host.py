# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""tool_python offers no extra modules on the engine's host.

A task that shares the engine's host gets ``--shared-host`` (see the
``hosting`` module); there the node drops its ``allowedModules`` setting and
the sandbox keeps to its default modules. ``--hosted`` alone keeps the setting.
"""

import sys
from types import SimpleNamespace

import pytest

from nodes.tool_python.IGlobal import IGlobal

_FLAGS = ('--hosted', '--shared-host')
_CONFIG = {'allowedModules': [{'moduleName': 'os'}]}


def _begin(monkeypatch, *flags, config=_CONFIG):
    """Start the node's IGlobal on a stored config; ``self.config`` resolves it through the engine's schema."""
    monkeypatch.setattr(sys, 'argv', [*(a for a in sys.argv if a not in _FLAGS), *flags])
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.glb = SimpleNamespace(logicalType='tool_python', connConfig=dict(config))
    iglobal.beginGlobal()
    return iglobal


def test_unset_timeout_means_the_sandbox_default(monkeypatch):
    assert _begin(monkeypatch, config={}).timeout is None
    assert _begin(monkeypatch, config={}).allowed_modules is None


def test_timeout_is_read_as_stored_and_bounded_by_the_schema(monkeypatch):
    from rocketlib.config import ConfigError

    assert _begin(monkeypatch, config={'timeout': 30}).timeout == 30
    with pytest.raises(ConfigError, match='"timeout"'):
        _begin(monkeypatch, config={'timeout': 0})


@pytest.mark.parametrize('flags', [('--hosted', '--shared-host'), ('--shared-host',)])
def test_shared_host_drops_allowed_modules(monkeypatch, flags):
    assert _begin(monkeypatch, *flags).allowed_modules is None


@pytest.mark.parametrize('flags', [(), ('--hosted',)])
def test_allowed_modules_kept_off_the_engine_host(monkeypatch, flags):
    assert _begin(monkeypatch, *flags).allowed_modules == {'os'}
