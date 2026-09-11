"""Unit tests for the shared model-loader base helpers (no torch needed: ``ai.common.torch`` is faked)."""

import sys
import threading
import types
from types import SimpleNamespace

import pytest

import ai.common.models.base as basemod


@pytest.fixture
def fake_torch(monkeypatch):
    """Install a fake ``ai.common.torch`` whose flags start as (matmul=False, cudnn=True) — torch's defaults."""
    torch = SimpleNamespace(
        backends=SimpleNamespace(
            cuda=SimpleNamespace(matmul=SimpleNamespace(allow_tf32=False)),
            cudnn=SimpleNamespace(allow_tf32=True),
        )
    )
    mod = types.ModuleType('ai.common.torch')
    mod.torch = torch
    monkeypatch.setitem(sys.modules, 'ai.common.torch', mod)
    monkeypatch.setattr(basemod, '_tf32_users', {'tf32': 0, 'strict': 0})
    monkeypatch.setattr(basemod, '_tf32_saved', None)
    return torch


def _flags(torch):
    return torch.backends.cuda.matmul.allow_tf32, torch.backends.cudnn.allow_tf32


def test_tf32_context_sets_both_flags_and_restores(fake_torch):
    with basemod.tf32_context(True):
        assert _flags(fake_torch) == (True, True)
    assert _flags(fake_torch) == (False, True)

    with basemod.tf32_context(False):
        assert _flags(fake_torch) == (False, False)
    assert _flags(fake_torch) == (False, True)
    assert basemod._tf32_saved is None


def test_tf32_context_nested_restores_once_on_outermost_exit(fake_torch):
    with basemod.tf32_context(True):
        with basemod.tf32_context(True):
            assert _flags(fake_torch) == (True, True)
        # Inner exit must not restore the originals while the outer scope is live.
        assert _flags(fake_torch) == (True, True)
    assert _flags(fake_torch) == (False, True)


def test_tf32_context_strict_fp32_wins_while_overlapping(fake_torch):
    with basemod.tf32_context(True):
        with basemod.tf32_context(False):
            assert _flags(fake_torch) == (False, False)
        assert _flags(fake_torch) == (True, True)  # back to the outer user's setting
    assert _flags(fake_torch) == (False, True)


def test_tf32_context_concurrent_exit_does_not_restore_stale_values(fake_torch):
    """A enters, B enters, A exits, B exits: the pre-A originals must come back.

    With per-scope save/restore B would have snapshotted A's already-enabled
    flags as its 'original' and left TF32 stuck on after the last exit.
    """
    a_inside = threading.Event()
    a_release = threading.Event()
    b_inside = threading.Event()
    b_release = threading.Event()

    def user_a():
        with basemod.tf32_context(True):
            a_inside.set()
            a_release.wait(5)

    def user_b():
        with basemod.tf32_context(True):
            b_inside.set()
            b_release.wait(5)

    ta = threading.Thread(target=user_a)
    tb = threading.Thread(target=user_b)
    ta.start()
    assert a_inside.wait(5)
    tb.start()
    assert b_inside.wait(5)
    assert _flags(fake_torch) == (True, True)

    a_release.set()
    ta.join(5)
    assert _flags(fake_torch) == (True, True)  # B still active: nothing restored yet

    b_release.set()
    tb.join(5)
    assert _flags(fake_torch) == (False, True)
    assert basemod._tf32_users == {'tf32': 0, 'strict': 0}
    assert basemod._tf32_saved is None


def test_tf32_context_restores_on_error(fake_torch):
    with pytest.raises(RuntimeError):
        with basemod.tf32_context(True):
            raise RuntimeError('forward failed')
    assert _flags(fake_torch) == (False, True)
    assert basemod._tf32_users == {'tf32': 0, 'strict': 0}
