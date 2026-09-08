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

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# core/ is a flat dir of engine-loaded modules (no __init__.py) and nodes/src is
# not on pytest's pythonpath, so import the module by adding its dir to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
from microsoft_access import (  # noqa: E402
    EXCEL,
    ONEDRIVE,
    OUTLOOK_MAIL,
    MicrosoftAccessError,
    missing_scopes,
    resolve_microsoft_access,
)


def test_default_tier_and_write():
    acc = resolve_microsoft_access({}, EXCEL)
    assert acc.tier == 'write'
    assert acc.scopes == ['Files.ReadWrite']
    assert acc.can_write


def test_readonly_blocks_write():
    acc = resolve_microsoft_access({'access': 'readonly'}, EXCEL)
    assert not acc.can_write
    with pytest.raises(MicrosoftAccessError, match='read-only'):
        acc.require_write('update_range')


def test_unknown_tier_fails_loud():
    with pytest.raises(MicrosoftAccessError):
        resolve_microsoft_access({'access': 'admin'}, EXCEL)


def test_gate_flag_default_off_and_non_bool_rejected():
    acc = resolve_microsoft_access({}, ONEDRIVE)
    with pytest.raises(MicrosoftAccessError, match='allowHardDelete'):
        acc.require_flag('allowHardDelete', 'permanently_delete')
    with pytest.raises(MicrosoftAccessError, match='boolean'):
        resolve_microsoft_access({'allowPublicSharing': 'true'}, ONEDRIVE)


def test_onedrive_write_tier_never_requires_directory_scope():
    # User.ReadBasic.All is requested at sign-in (widget/broker) for the invite
    # gate, but must never be REQUIRED here: personal accounts cannot grant
    # directory scopes, and requiring it would block their entire write tier.
    acc = resolve_microsoft_access({}, ONEDRIVE)
    assert acc.scopes == ['Files.ReadWrite']
    assert 'User.ReadBasic.All' not in acc.scopes
    assert resolve_microsoft_access({'access': 'readonly'}, ONEDRIVE).scopes == ['Files.Read']


def test_mail_tiers():
    scopes = resolve_microsoft_access({'access': 'send'}, OUTLOOK_MAIL).scopes
    assert scopes == ['Mail.Read', 'Mail.Send']
    assert resolve_microsoft_access({}, OUTLOOK_MAIL).tier == 'modify'


def test_scope_supersets():
    # ReadWrite satisfies Read; .All satisfies non-.All;
    # ReadWrite.All satisfies everything in family
    assert missing_scopes({'Files.ReadWrite'}, ['Files.Read']) == []
    assert missing_scopes({'Mail.ReadWrite'}, ['Mail.Read']) == []
    assert missing_scopes({'Files.Read.All'}, ['Files.Read']) == []
    expected = ['Files.Read', 'Files.ReadWrite']
    assert missing_scopes({'Files.ReadWrite.All'}, expected) == []
    assert missing_scopes({'Mail.Read'}, ['Mail.Send']) == ['Mail.Send']
    # Family-wide ReadWrite.All never satisfies an action scope (Mail.Send is
    # a separate Graph grant), only the family's Read/ReadWrite scopes.
    assert missing_scopes({'Mail.ReadWrite.All'}, ['Mail.Send']) == ['Mail.Send']
    assert missing_scopes({'Mail.ReadWrite.All'}, ['Mail.Read', 'Mail.ReadWrite']) == []
    # Fail-open on unknown grant (empty set), mirroring google_access
    assert missing_scopes(set(), ['Mail.Send']) == []


def test_excel_readonly_tier_requests_files_readwrite():
    # Graph workbook endpoints accept only delegated Files.ReadWrite, even for
    # reads; readonly stays a node-side write gate, not a narrower scope.
    ro = resolve_microsoft_access({'access': 'readonly'}, EXCEL)
    assert ro.scopes == ['Files.ReadWrite']
    assert ro.can_write is False
