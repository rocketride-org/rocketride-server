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
    scopes: dict[str, list[str]]  # access tier -> OAuth scopes
    default: str  # tier used when config omits access
    flags: tuple[str, ...] = ()  # config boolean field names honored
    readonly_tiers: frozenset[str] = frozenset({'readonly'})


@dataclass(frozen=True)
class GoogleAccess:
    tier: str
    scopes: list[str]
    can_write: bool
    flags: dict[str, bool]

    def require_write(self, op: str) -> None:
        if not self.can_write:
            raise GoogleAccessError(
                f'{op} needs write access, but this node is read-only '
                f'(access={self.tier!r}). Raise the access level to enable it.'
            )

    def require_flag(self, name: str, op: str) -> None:
        if not self.flags.get(name, False):
            raise GoogleAccessError(
                f'{op} is gated by {name!r}, which is off by default. Enable {name!r} in the node config to allow it.'
            )


def resolve_google_access(config: dict, spec: AccessSpec) -> GoogleAccess:
    tier = config.get('access') or spec.default
    if tier not in spec.scopes:
        raise GoogleAccessError(f'unknown access tier {tier!r}; expected one of {sorted(spec.scopes)}')
    flags = {name: bool(config.get(name, False)) for name in spec.flags}
    return GoogleAccess(
        tier=tier,
        scopes=list(spec.scopes[tier]),
        can_write=tier not in spec.readonly_tiers,
        flags=flags,
    )


_G = 'https://www.googleapis.com/auth'

GMAIL = AccessSpec(
    scopes={
        'readonly': [f'{_G}/gmail.readonly'],
        'modify': [f'{_G}/gmail.modify'],
        'send': [f'{_G}/gmail.modify', f'{_G}/gmail.send'],
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
