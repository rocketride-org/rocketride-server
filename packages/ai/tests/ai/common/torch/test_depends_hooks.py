"""Unit tests for this module's _depends_hooks.py (#2681).

This is a plain depends.py excludes hook (see that module's "Hook files"
section), so it is testable on its own: no depends.py involved, only the
hosting module that ships next to it. Discovery itself — that depends.py finds this file wherever it lives, not
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


def test_not_hosted_does_nothing(monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py'])
    assert HOOKS.excludes(['torch', 'numpy']) is None


def test_shared_host_alone_does_nothing(monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--shared-host'])
    assert HOOKS.excludes(['torch', 'numpy']) is None


@pytest.mark.parametrize(
    'packages',
    [
        ['requests', 'numpy'],  # not resolved yet: pre-excluded as a race guard
        ['sentence-transformers', 'torch', 'nvidia-cublas-cu12'],  # already resolved: refused
        ['TorchVision', 'numpy'],  # name casing is normalised before matching
    ],
)
def test_hosted_refuses_once_torch_is_in_the_plan(monkeypatch, packages):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--hosted'])
    forbidden = {'torch', 'torchvision', 'torchaudio'}
    present = forbidden & {p.lower() for p in packages}

    if present:
        with pytest.raises(RuntimeError, match='never installed on a hosted engine'):
            HOOKS.excludes(packages)
    else:
        assert sorted(HOOKS.excludes(packages)) == sorted(forbidden)
