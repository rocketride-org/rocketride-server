"""Unit tests for this module's _depends_hooks.py (#2681).

This is a plain depends.py excludes hook (see that module's "Hook files"
section), so it is testable on its own: no depends.py involved, only sys.argv. Discovery itself — that depends.py finds this file wherever it lives, not
just under its own requirements.txt's directory — is covered in
packages/server/engine-lib/rocketlib-python/tests/test_depends.py.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

HOOK_PATH = Path(__file__).parents[4] / 'src' / 'ai' / 'common' / 'torch' / '_depends_hooks.py'
SPEC = importlib.util.spec_from_file_location('ai_common_torch_depends_hooks', HOOK_PATH)
HOOKS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(HOOKS)


def test_no_model_server_does_nothing(monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py'])
    assert HOOKS.excludes(['torch', 'numpy']) is None


@pytest.mark.parametrize('flag', ['--hosted', '--shared-host', '--modelserver='])
def test_without_a_model_server_address_torch_stays_allowed(monkeypatch, flag):
    """--modelserver is the switch: a hosted engine without a model server (a local SaaS server) installs torch."""
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', flag])
    assert HOOKS.excludes(['torch', 'numpy']) is None


@pytest.mark.parametrize(
    'packages',
    [
        ['requests', 'numpy'],  # not resolved yet: pre-excluded as a race guard
        ['sentence-transformers', 'torch', 'nvidia-cublas-cu12'],  # already resolved: refused
        ['TorchVision', 'numpy'],  # name casing is normalised before matching
    ],
)
def test_model_server_refuses_once_torch_is_in_the_plan(monkeypatch, packages):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--modelserver=wss://model.example:443'])
    forbidden = {'torch', 'torchvision', 'torchaudio'}
    present = forbidden & {p.lower() for p in packages}

    if present:
        with pytest.raises(RuntimeError, match='never installed when a model server is configured'):
            HOOKS.excludes(packages)
    else:
        assert sorted(HOOKS.excludes(packages)) == sorted(forbidden)
