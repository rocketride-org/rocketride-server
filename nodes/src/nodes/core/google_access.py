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
Single reader that turns a Google tool node's `access` enum and capability
toggles into one resolved object: the OAuth scopes to request, plus the
write/destructive gates the node's tool functions check at invoke time.
"""

from __future__ import annotations

from dataclasses import dataclass


class GoogleAccessError(PermissionError):
    """Raised when a gated operation runs without the config enabling it."""


@dataclass(frozen=True)
class AccessSpec:
    """Per-API access contract: tier->scopes, default tier, and honored gate flags."""

    scopes: dict[str, list[str]]  # access tier -> OAuth scopes
    default: str  # tier used when config omits access
    flags: tuple[str, ...] = ()  # config boolean field names honored

    def __post_init__(self) -> None:
        """Validate the spec at construction."""
        if not self.scopes:
            raise GoogleAccessError('AccessSpec.scopes must declare at least one tier')
        if self.default not in self.scopes:
            raise GoogleAccessError(
                f'AccessSpec default tier {self.default!r} is not a defined tier; expected one of {sorted(self.scopes)}'
            )


@dataclass(frozen=True)
class GoogleAccess:
    """Resolved access for one node: granted scopes, write capability, and gate flags."""

    tier: str
    scopes: list[str]
    can_write: bool
    flags: dict[str, bool]

    def require_write(self, op: str) -> None:
        """Raise if the node is read-only."""
        if not self.can_write:
            raise GoogleAccessError(
                f'{op} needs write access, but this node is read-only '
                f'(access={self.tier!r}). Raise the access level to enable it.'
            )

    def require_flag(self, name: str, op: str) -> None:
        """Raise if the named destructive gate is not enabled."""
        if not self.flags.get(name, False):
            raise GoogleAccessError(
                f'{op} is gated by {name!r}, which is off by default. Enable {name!r} in the node config to allow it.'
            )


def _resolve_flags(config: dict, spec: AccessSpec) -> dict[str, bool]:
    """Resolve declared gate flags, rejecting non-bool config values."""
    # Strict: a destructive gate must fail loud on misconfig, not coerce. Only an
    # explicit bool True enables; a present non-bool ('false', 1, 'no') is an error.
    flags: dict[str, bool] = {}
    for name in spec.flags:
        if name not in config:
            flags[name] = False
            continue
        value = config[name]
        if type(value) is not bool:
            raise GoogleAccessError(f'flag {name!r} must be a boolean, got {value!r} ({type(value).__name__})')
        flags[name] = value
    return flags


def resolve_google_access(config: dict, spec: AccessSpec) -> GoogleAccess:
    """Resolve a node's config + AccessSpec into a GoogleAccess (scopes + gates)."""
    # Blank/omitted access means "use the default tier" (e.g. an empty UI field).
    # Any other non-string value is malformed config and must raise rather than
    # silently fall through to the default.
    raw = config.get('access')
    if raw is None or raw == '':
        tier = spec.default
    elif not isinstance(raw, str):
        raise GoogleAccessError(f'access must be a string tier name, got {type(raw).__name__}')
    else:
        tier = raw
    if tier not in spec.scopes:
        raise GoogleAccessError(f'unknown access tier {tier!r}; expected one of {sorted(spec.scopes)}')
    tier_scopes = spec.scopes[tier]
    # Writable iff at least one granted scope is not a Google read-only scope
    # (those end in '.readonly'). Derived from scopes so it can't drift from grant.
    return GoogleAccess(
        tier=tier,
        scopes=list(tier_scopes),
        can_write=any(not s.endswith('.readonly') for s in tier_scopes),
        flags=_resolve_flags(config, spec),
    )


_G = 'https://www.googleapis.com/auth'

# The full mailbox scope is its own host, not under _G/. Only this scope can
# permanently delete (messages.delete); gmail.modify only trashes.
_GMAIL_FULL = 'https://mail.google.com/'

GMAIL = AccessSpec(
    scopes={
        'readonly': [f'{_G}/gmail.readonly'],
        'modify': [f'{_G}/gmail.modify'],
        'send': [f'{_G}/gmail.modify', f'{_G}/gmail.send'],
        # settings.basic: filters, IMAP, POP, vacation, forwarding addresses
        'settings': [f'{_G}/gmail.modify', f'{_G}/gmail.settings.basic'],
        # settings.sharing: sendAs write, delegation, S/MIME management
        'settings_sharing': [f'{_G}/gmail.modify', f'{_G}/gmail.settings.basic', f'{_G}/gmail.settings.sharing'],
        'full': [_GMAIL_FULL],  # superset: read/modify/send/permanent-delete
    },
    default='modify',
    flags=('allowHardDelete',),
)
DRIVE = AccessSpec(
    scopes={'readonly': [f'{_G}/drive.readonly'], 'write': [f'{_G}/drive']},
    default='write',
    flags=('allowPublicSharing', 'allowHardDelete'),
)
SHEETS = AccessSpec(
    scopes={'readonly': [f'{_G}/spreadsheets.readonly'], 'write': [f'{_G}/spreadsheets']},
    default='write',
)
DOCS = AccessSpec(
    scopes={'readonly': [f'{_G}/documents.readonly'], 'write': [f'{_G}/documents']},
    default='write',
)
CALENDAR = AccessSpec(
    scopes={'readonly': [f'{_G}/calendar.readonly'], 'write': [f'{_G}/calendar']},
    default='write',
    flags=('allowDelete',),
)
SLIDES = AccessSpec(
    scopes={'readonly': [f'{_G}/presentations.readonly'], 'write': [f'{_G}/presentations']},
    default='write',
)
PEOPLE = AccessSpec(
    scopes={
        'readonly': [f'{_G}/contacts.readonly', f'{_G}/directory.readonly'],
        'write': [f'{_G}/contacts', f'{_G}/directory.readonly'],
    },
    default='write',
    flags=('allowDelete',),
)
