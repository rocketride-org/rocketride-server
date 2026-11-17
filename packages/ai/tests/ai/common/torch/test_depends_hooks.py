# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Unit tests for this module's _depends_hooks.py: torch stays out of an install plan in model server mode only.

This is a plain depends.py excludes hook (see that module's "Hook files"
section), so it is testable on its own: no depends.py involved, only the
hosting module that ships next to it. Discovery itself, that depends.py finds
this file wherever it lives, is covered in
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
def test_hosted_shared_host_and_an_empty_model_server_do_nothing(monkeypatch, flag):
    """Only a configured model server keeps torch out of an install; a hosted engine without one loads it."""
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
def test_model_server_mode_refuses_once_torch_is_in_the_plan(monkeypatch, packages):
    monkeypatch.setattr(sys, 'argv', ['engine', 'node.py', '--modelserver=localhost:5590'])
    forbidden = {'torch', 'torchvision', 'torchaudio'}
    present = forbidden & {p.lower() for p in packages}

    if present:
        with pytest.raises(RuntimeError, match='never installed in model server mode'):
            HOOKS.excludes(packages)
    else:
        assert sorted(HOOKS.excludes(packages)) == sorted(forbidden)
