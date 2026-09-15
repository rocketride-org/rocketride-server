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
Single reader that turns a Microsoft 365 tool node's `access` enum and gate
toggles into one resolved object: the Graph scopes to request, plus the
write/destructive gates the node's tool functions check at invoke time.
Sibling of google_access.py; scope names are Graph permission names
('Mail.Read'), not URLs.
"""

from __future__ import annotations

from dataclasses import dataclass


class MicrosoftAccessError(PermissionError):
    """Raised when a gated operation runs without the config enabling it."""


@dataclass(frozen=True)
class AccessSpec:
    """Per-service access contract: tier->scopes, default tier, honored gate flags."""

    scopes: dict[str, list[str]]
    default: str
    flags: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        """Validate the spec at construction."""
        if not self.scopes:
            raise MicrosoftAccessError('AccessSpec.scopes must declare at least one tier')
        if self.default not in self.scopes:
            raise MicrosoftAccessError(
                f'AccessSpec default tier {self.default!r} is not a defined tier; expected one of {sorted(self.scopes)}'
            )


@dataclass(frozen=True)
class MicrosoftAccess:
    """Resolved access for one node: granted scopes, write capability, and gate flags."""

    tier: str
    scopes: list[str]
    can_write: bool
    flags: dict[str, bool]

    def require_write(self, op: str) -> None:
        """Raise if the node is read-only."""
        if not self.can_write:
            raise MicrosoftAccessError(
                f'{op} needs write access, but this node is read-only '
                f'(access={self.tier!r}). Raise the access level to enable it.'
            )

    def require_flag(self, name: str, op: str) -> None:
        """Raise if the named destructive gate is not enabled."""
        if not self.flags.get(name, False):
            raise MicrosoftAccessError(
                f'{op} is gated by {name!r}, which is off by default. Enable {name!r} in the node config to allow it.'
            )


def _scope_satisfied(required: str, granted: set[str]) -> bool:
    """
    True when a granted Graph scope covers the required one, including supersets.

    Graph semantics: '<Family>.ReadWrite' supersets '<Family>.Read';
    '<scope>.All' supersets the same scope without '.All'; and
    '<Family>.ReadWrite.All' supersets the family's Read/ReadWrite scopes only
    (never action scopes such as 'Mail.Send', which Graph grants separately).
    """
    if required in granted:
        return True
    base = required[: -len('.All')] if required.endswith('.All') else required
    family = base.split('.')[0]
    candidates = {base, f'{base}.All'}
    if base.endswith('.Read'):
        rw = base[: -len('.Read')] + '.ReadWrite'
        candidates |= {rw, f'{rw}.All'}
    if base.endswith(('.Read', '.ReadWrite')):
        candidates |= {f'{family}.ReadWrite.All'}
    return bool(candidates & granted)


def missing_scopes(granted: set[str], required: list[str]) -> list[str]:
    """
    Required scopes not satisfied by the granted set.

    Fail-open when the grant is unknown (empty set): older tokens may lack a
    scope field, and the absence of evidence must not block validation.
    """
    if not granted:
        return []
    return [s for s in required if not _scope_satisfied(s, granted)]


def _resolve_flags(config: dict, spec: AccessSpec) -> dict[str, bool]:
    """Resolve declared gate flags, rejecting non-bool config values."""
    # Strict: a destructive gate must fail loud on misconfig, not coerce.
    flags: dict[str, bool] = {}
    for name in spec.flags:
        if name not in config:
            flags[name] = False
            continue
        value = config[name]
        if type(value) is not bool:
            raise MicrosoftAccessError(f'flag {name!r} must be a boolean, got {value!r} ({type(value).__name__})')
        flags[name] = value
    return flags


def resolve_microsoft_access(config: dict, spec: AccessSpec) -> MicrosoftAccess:
    """Resolve a node's config + AccessSpec into a MicrosoftAccess (scopes + gates)."""
    tier = (str(config.get('access') or '').strip()) or spec.default
    if tier not in spec.scopes:
        raise MicrosoftAccessError(f'unknown access tier {tier!r}; expected one of {sorted(spec.scopes)}')
    return MicrosoftAccess(
        tier=tier,
        scopes=list(spec.scopes[tier]),
        can_write=tier != 'readonly',
        flags=_resolve_flags(config, spec),
    )


EXCEL = AccessSpec(
    # Graph's workbook API documents delegated Files.ReadWrite as the least
    # privileged scope for EVERY endpoint, reads included (Files.Read is not
    # accepted), so both tiers request it; 'readonly' is enforced node-side by
    # require_write on the mutating tools.
    scopes={'readonly': ['Files.ReadWrite'], 'write': ['Files.ReadWrite']},
    default='write',
)
WORD = AccessSpec(
    scopes={'readonly': ['Files.Read'], 'write': ['Files.ReadWrite']},
    default='write',
)
ONEDRIVE = AccessSpec(
    # The invite gate also uses User.ReadBasic.All, but that scope is REQUESTED
    # (widget/broker), never REQUIRED here: personal Microsoft accounts cannot
    # grant directory scopes, and requiring it would block their whole write
    # tier. Without it the invite gate fails closed at runtime.
    scopes={'readonly': ['Files.Read'], 'write': ['Files.ReadWrite']},
    default='write',
    flags=('allowPublicSharing', 'allowHardDelete'),
)
OUTLOOK_MAIL = AccessSpec(
    scopes={
        'readonly': ['Mail.Read'],
        'send': ['Mail.Read', 'Mail.Send'],
        'modify': ['Mail.ReadWrite', 'Mail.Send'],
    },
    default='modify',
    flags=('allowHardDelete',),
)
OUTLOOK_CALENDAR = AccessSpec(
    scopes={
        'readonly': ['Calendars.Read'],
        'write': ['Calendars.ReadWrite'],
    },
    default='write',
)
