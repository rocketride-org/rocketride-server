"""
Unit tests for the shared Google access/gate resolver (core/google_access.py).

Pure logic, no server or live API needed:

    pytest nodes/test/core/test_google_access.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
from google_access import (  # noqa: E402
    CALENDAR,
    DRIVE,
    DOCS,
    GMAIL,
    PEOPLE,
    SHEETS,
    SLIDES,
    AccessSpec,
    GoogleAccess,
    GoogleAccessError,
    resolve_google_access,
)

_G = 'https://www.googleapis.com/auth'

# A small spec used for the resolver's own behavior (independent of the per-app specs)
_FIXTURE = AccessSpec(
    scopes={'readonly': [f'{_G}/thing.readonly'], 'write': [f'{_G}/thing']},
    default='write',
    flags=('allowDelete', 'allowPublic'),
)


# ---------------------------------------------------------------------------
# resolve_google_access: tier -> scopes
# ---------------------------------------------------------------------------


def test_resolves_named_tier_to_its_scopes():
    access = resolve_google_access({'access': 'readonly'}, _FIXTURE)
    assert access.tier == 'readonly'
    assert access.scopes == [f'{_G}/thing.readonly']


def test_applies_default_tier_when_access_omitted():
    access = resolve_google_access({}, _FIXTURE)
    assert access.tier == 'write'
    assert access.scopes == [f'{_G}/thing']


def test_blank_access_falls_back_to_default():
    access = resolve_google_access({'access': ''}, _FIXTURE)
    assert access.tier == 'write'


def test_unknown_tier_raises():
    with pytest.raises(GoogleAccessError):
        resolve_google_access({'access': 'superuser'}, _FIXTURE)


# ---------------------------------------------------------------------------
# can_write
# ---------------------------------------------------------------------------


def test_write_tier_can_write():
    assert resolve_google_access({'access': 'write'}, _FIXTURE).can_write is True


def test_readonly_tier_cannot_write():
    assert resolve_google_access({'access': 'readonly'}, _FIXTURE).can_write is False


# ---------------------------------------------------------------------------
# require_write
# ---------------------------------------------------------------------------


def test_require_write_noop_on_write_tier():
    access = resolve_google_access({'access': 'write'}, _FIXTURE)
    access.require_write('thing_create')  # must not raise


def test_require_write_raises_on_readonly_tier():
    access = resolve_google_access({'access': 'readonly'}, _FIXTURE)
    with pytest.raises(GoogleAccessError):
        access.require_write('thing_create')


# ---------------------------------------------------------------------------
# require_flag
# ---------------------------------------------------------------------------


def test_require_flag_noop_when_flag_true():
    access = resolve_google_access({'access': 'write', 'allowDelete': True}, _FIXTURE)
    access.require_flag('allowDelete', 'thing_delete')  # must not raise


def test_require_flag_raises_when_flag_false():
    access = resolve_google_access({'access': 'write', 'allowDelete': False}, _FIXTURE)
    with pytest.raises(GoogleAccessError):
        access.require_flag('allowDelete', 'thing_delete')


def test_require_flag_raises_when_flag_absent():
    access = resolve_google_access({'access': 'write'}, _FIXTURE)
    with pytest.raises(GoogleAccessError):
        access.require_flag('allowDelete', 'thing_delete')


def test_flags_populated_from_config():
    access = resolve_google_access({'access': 'write', 'allowDelete': True, 'allowPublic': False}, _FIXTURE)
    assert access.flags == {'allowDelete': True, 'allowPublic': False}


def test_only_declared_flags_are_read():
    # A config boolean not declared in the spec must not leak into flags.
    access = resolve_google_access({'access': 'write', 'undeclared': True}, _FIXTURE)
    assert 'undeclared' not in access.flags


# ---------------------------------------------------------------------------
# Per-app specs
# ---------------------------------------------------------------------------


def test_gmail_send_tier_includes_modify_and_send_scopes():
    access = resolve_google_access({'access': 'send'}, GMAIL)
    assert f'{_G}/gmail.modify' in access.scopes
    assert f'{_G}/gmail.send' in access.scopes


def test_gmail_default_is_modify():
    assert resolve_google_access({}, GMAIL).tier == 'modify'


def test_gmail_modify_is_writeable():
    assert resolve_google_access({'access': 'modify'}, GMAIL).can_write is True


def test_gmail_declares_allow_hard_delete_flag():
    assert 'allowHardDelete' in GMAIL.flags


def test_drive_declares_public_sharing_and_hard_delete_flags():
    assert set(DRIVE.flags) == {'allowPublicSharing', 'allowHardDelete'}


def test_people_readonly_includes_directory_scope():
    access = resolve_google_access({'access': 'readonly'}, PEOPLE)
    assert f'{_G}/directory.readonly' in access.scopes


def test_calendar_and_people_declare_allow_delete():
    assert 'allowDelete' in CALENDAR.flags
    assert 'allowDelete' in PEOPLE.flags


@pytest.mark.parametrize('spec', [SHEETS, DOCS, SLIDES])
def test_simple_editor_apps_have_no_flags_and_default_write(spec):
    assert spec.flags == ()
    assert spec.default == 'write'
    assert resolve_google_access({}, spec).can_write is True


@pytest.mark.parametrize('spec', [GMAIL, DRIVE, SHEETS, DOCS, CALENDAR, SLIDES, PEOPLE])
def test_every_spec_has_a_readonly_tier_that_cannot_write(spec):
    access = resolve_google_access({'access': 'readonly'}, spec)
    assert access.can_write is False


@pytest.mark.parametrize('spec', [GMAIL, DRIVE, SHEETS, DOCS, CALENDAR, SLIDES, PEOPLE])
def test_default_tier_is_a_valid_tier(spec):
    assert spec.default in spec.scopes


def test_resolver_returns_googleaccess_instance():
    assert isinstance(resolve_google_access({}, GMAIL), GoogleAccess)
