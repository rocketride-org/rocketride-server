# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Resolver-level gate tests for the OneDrive service's two destructive/public
flags (``allowHardDelete``, ``allowPublicSharing``). Both flags, and the
``ONEDRIVE`` AccessSpec that declares them, already exist from Task 1 —
these tests exercise them directly through ``resolve_microsoft_access``
rather than mocking Graph, since the IInstance methods that call
``require_flag`` are thin pass-throughs (see task-6-brief.md).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# core/ is a flat dir of engine-loaded modules (no __init__.py) and nodes/src is
# not on pytest's pythonpath, so import the module by adding its dir to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
from microsoft_access import (  # noqa: E402
    ONEDRIVE,
    MicrosoftAccessError,
    resolve_microsoft_access,
)


def test_hard_delete_gate_off_by_default_blocks():
    acc = resolve_microsoft_access({'access': 'write'}, ONEDRIVE)
    with pytest.raises(MicrosoftAccessError, match='allowHardDelete'):
        acc.require_flag('allowHardDelete', 'onedrive_permanently_delete')


def test_hard_delete_gate_on_allows():
    acc = resolve_microsoft_access({'access': 'write', 'allowHardDelete': True}, ONEDRIVE)
    acc.require_flag('allowHardDelete', 'onedrive_permanently_delete')  # must not raise


def test_public_sharing_gate_off_by_default_blocks():
    acc = resolve_microsoft_access({'access': 'write'}, ONEDRIVE)
    with pytest.raises(MicrosoftAccessError, match='allowPublicSharing'):
        acc.require_flag('allowPublicSharing', 'onedrive_create_sharing_link (scope=anonymous)')


def test_public_sharing_gate_on_allows():
    acc = resolve_microsoft_access({'access': 'write', 'allowPublicSharing': True}, ONEDRIVE)
    acc.require_flag('allowPublicSharing', 'onedrive_create_sharing_link (scope=anonymous)')  # must not raise


def test_both_gates_independent():
    # Enabling one flag must not implicitly enable the other.
    acc = resolve_microsoft_access({'access': 'write', 'allowHardDelete': True}, ONEDRIVE)
    acc.require_flag('allowHardDelete', 'x')  # must not raise
    with pytest.raises(MicrosoftAccessError, match='allowPublicSharing'):
        acc.require_flag('allowPublicSharing', 'y')


def test_gates_default_tier_is_write():
    # ONEDRIVE's default tier is 'write'; flags are independent of tier but the
    # resolver must still accept the default config shape used by write tools.
    acc = resolve_microsoft_access({}, ONEDRIVE)
    assert acc.tier == 'write'
    assert acc.can_write
    with pytest.raises(MicrosoftAccessError):
        acc.require_flag('allowHardDelete', 'x')


def test_readonly_tier_gates_still_enforced():
    # A readonly node with the flags on: require_flag alone does not imply
    # write access — callers must also call require_write for write ops.
    acc = resolve_microsoft_access({'access': 'readonly', 'allowHardDelete': True}, ONEDRIVE)
    assert not acc.can_write
    acc.require_flag('allowHardDelete', 'x')  # flag check passes independent of tier
    with pytest.raises(MicrosoftAccessError, match='read-only'):
        acc.require_write('onedrive_permanently_delete')
