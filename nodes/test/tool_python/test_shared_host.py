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
from unittest.mock import MagicMock

import pytest
from ai.common.config import Config
from rocketlib import OPEN_MODE

from nodes.tool_python.IGlobal import IGlobal

_FLAGS = ('--hosted', '--shared-host')
_CONFIG = {'allowedModules': [{'moduleName': 'os'}]}


def _begin(monkeypatch, *flags):
    monkeypatch.setattr(sys, 'argv', [*(a for a in sys.argv if a not in _FLAGS), *flags])
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(_CONFIG)))
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.IEndpoint = MagicMock()
    iglobal.IEndpoint.endpoint.openMode = OPEN_MODE.SOURCE
    iglobal.glb = MagicMock()
    iglobal.beginGlobal()
    return iglobal


@pytest.mark.parametrize('flags', [('--hosted', '--shared-host'), ('--shared-host',)])
def test_shared_host_drops_allowed_modules(monkeypatch, flags):
    assert _begin(monkeypatch, *flags).allowed_modules is None


@pytest.mark.parametrize('flags', [(), ('--hosted',)])
def test_allowed_modules_kept_off_the_engine_host(monkeypatch, flags):
    assert _begin(monkeypatch, *flags).allowed_modules == {'os'}
