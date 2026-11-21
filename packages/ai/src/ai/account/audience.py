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
Audience: the strings the server composes about "whose" (plan 2.5).

Four strings, one home. This module is the only code that composes or decodes
them; every other module calls it and no client parses any of them. Each is
written in the root grammar (``roots.py``):

- An AUDIENCE says who a publication serves: ``=user/<uid>``, ``=team/<tid>``,
  ``=org/<oid>`` or ``@public``. It is the publish row's key, the ``teamId``
  of a deployment row and of a deploy event, and the audience of a task row.
- An OWNER says who owns a run: ``=user/<uid>``, ``=team/<tid>`` or
  ``=org/<oid>``. It names the tree a run's log and files live in.
- A TARGET says where a publish goes: ``@me``, ``@<team>``, ``@org``,
  ``@public``, or any audience. Every audience is a valid target, so a client
  passes a row's audience back unchanged.
- A HANDLE is what a person reads: ``@me``, ``@<team>``, ``@org``,
  ``@public``, ``=team/<tid>`` for a team the caller cannot name, and
  ``Personal`` for another user's space.

Rows also carry a RUNG: ``me``, ``personal``, ``team``, ``org`` or ``public``.

Every decoder raises ``AudienceError`` on a form it does not know. None
defaults to a team.
"""

from typing import Any, Dict, Mapping, NamedTuple, Optional, Tuple

from .roots import (
    KIND_ME,
    KIND_ORG,
    KIND_PUBLIC,
    KIND_TEAM,
    KIND_USER,
    RootError,
    format_root,
    parse_root,
)

# ==== Vocabulary =================================================================

#: The audience of the store.
PUBLIC_AUDIENCE = format_root(KIND_PUBLIC)

#: The kinds an audience may be.
AUDIENCE_KINDS = (KIND_USER, KIND_TEAM, KIND_ORG, KIND_PUBLIC)

#: The kinds an owner may be.
OWNER_KINDS = (KIND_USER, KIND_TEAM, KIND_ORG)

#: The rungs a row may carry.
RUNG_ME = 'me'
RUNG_PERSONAL = 'personal'
RUNG_TEAM = 'team'
RUNG_ORG = 'org'
RUNG_PUBLIC = 'public'

#: The handle of another user's personal space.
HANDLE_PERSONAL = 'Personal'

#: The longest audience a stored column must hold: ``=team/`` and a 36-character id.
AUDIENCE_MAX_LENGTH = 48


# ==== Errors =====================================================================


class AudienceError(ValueError):
    """A text is not an audience, an owner or a target, or one cannot be composed."""


# ==== Shapes =====================================================================


class Audience(NamedTuple):
    """
    A decoded audience.

    Attributes:
        kind: ``user``, ``team``, ``org`` or ``public``.
        id: The user, team or org id; ``''`` for the store.
    """

    kind: str
    id: str


class Owner(NamedTuple):
    """
    A decoded owner.

    Attributes:
        kind: ``user``, ``team`` or ``org``.
        id: The user, team or org id.
    """

    kind: str
    id: str


class Target(NamedTuple):
    """
    A decoded publish target.

    Attributes:
        kind: ``me``, ``team``, ``org``, ``public`` or ``user``.
        ref: The team name (``@<team>``) or the id (an ``=`` target); ``''``
            for ``@me``, ``@org`` and ``@public``.
        by_id: True for an ``=`` target.
    """

    kind: str
    ref: str
    by_id: bool


# ==== Audiences ==================================================================


def compose_audience(kind: str, ident: str = '') -> str:
    """
    Compose an audience.

    Args:
        kind: ``user``, ``team``, ``org`` or ``public``.
        ident: The user, team or org id; nothing for the store.

    Returns:
        ``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` or ``@public``.

    Raises:
        AudienceError: The kind is unknown, an id is missing or unusable, or
            the store was given an id.
    """
    if kind == KIND_PUBLIC:
        if ident:
            raise AudienceError('the store audience carries no id')
        return PUBLIC_AUDIENCE
    if kind not in OWNER_KINDS:
        raise AudienceError(f'Unknown audience kind: {kind!r}')
    try:
        return format_root(kind, ident, by_id=True)
    except RootError as e:
        raise AudienceError(str(e)) from e


def user_audience(user_id: str) -> str:
    """The audience of a user's personal space, ``=user/<uid>``."""
    return compose_audience(KIND_USER, user_id)


def team_audience(team_id: str) -> str:
    """The audience of a team, ``=team/<tid>``."""
    return compose_audience(KIND_TEAM, team_id)


def org_audience(org_id: str) -> str:
    """The audience of an organization, ``=org/<oid>``."""
    return compose_audience(KIND_ORG, org_id)


def parse_audience(text: str) -> Audience:
    """
    Decode an audience.

    Args:
        text: ``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` or ``@public``.

    Returns:
        The decoded ``Audience``.

    Raises:
        AudienceError: The text is any other form: a name root, a bare id, a
            root followed by a path, or nothing.
    """
    try:
        root = parse_root(text)
    except RootError as e:
        raise AudienceError(f'Not an audience: {text!r} ({e})') from e
    if root.rest:
        raise AudienceError(f'Not an audience: {text!r} (nothing may follow the root)')
    if root.kind == KIND_PUBLIC and not root.by_id:
        return Audience(KIND_PUBLIC, '')
    if root.by_id and root.kind in OWNER_KINDS:
        return Audience(root.kind, root.ref)
    raise AudienceError(f'Not an audience: {text!r} (expected =user/<uid>, =team/<tid>, =org/<oid> or @public)')


def normalize_audience(text: str) -> str:
    """
    An audience in the one spelling the server stores and compares.

    Args:
        text: An audience in any spelling the grammar reads.

    Returns:
        The composed audience.

    Raises:
        AudienceError: The text is not an audience.
    """
    return compose_audience(*parse_audience(text))


def is_audience(text: Any) -> bool:
    """True when ``text`` decodes as an audience."""
    try:
        parse_audience(text)
    except AudienceError:
        return False
    return True


def audience_fields(text: str) -> Dict[str, str]:
    """
    An audience as the ``{type, id}`` pair the publish verbs take.

    Args:
        text: An audience.

    Returns:
        ``{'type': kind, 'id': id}``.

    Raises:
        AudienceError: The text is not an audience.
    """
    audience = parse_audience(text)
    return {'type': audience.kind, 'id': audience.id}


def audience_of_fields(fields: Mapping[str, Any]) -> str:
    """
    The audience a ``{type, id}`` pair names.

    Args:
        fields: A mapping with ``type`` (``user``, ``team``, ``org`` or
            ``public``) and ``id``.

    Returns:
        The composed audience.

    Raises:
        AudienceError: The mapping is not one, or its type is unknown.
    """
    if not isinstance(fields, Mapping):
        raise AudienceError('an audience must be an object with a type')
    kind = fields.get('type')
    if kind == KIND_PUBLIC:
        # The store's pair carries an empty id by contract; an id there is ignored
        return PUBLIC_AUDIENCE
    if kind not in OWNER_KINDS:
        raise AudienceError(f'Unknown audience type: {kind!r}')
    return compose_audience(kind, str(fields.get('id') or ''))


# ==== Owners =====================================================================


def compose_owner(kind: str, ident: str) -> str:
    """
    Compose an owner.

    Args:
        kind: ``user``, ``team`` or ``org``.
        ident: The user, team or org id.

    Returns:
        ``=user/<uid>``, ``=team/<tid>`` or ``=org/<oid>``.

    Raises:
        AudienceError: The kind is unknown or the id is missing or unusable.
    """
    if kind not in OWNER_KINDS:
        raise AudienceError(f'Unknown owner kind: {kind!r}')
    return compose_audience(kind, ident)


def parse_owner(text: str) -> Owner:
    """
    Decode an owner.

    Args:
        text: ``=user/<uid>``, ``=team/<tid>`` or ``=org/<oid>``.

    Returns:
        The decoded ``Owner``.

    Raises:
        AudienceError: The text is any other form; the store owns no run.
    """
    try:
        audience = parse_audience(text)
    except AudienceError as e:
        raise AudienceError(str(e).replace('Not an audience', 'Not an owner', 1)) from e
    if audience.kind not in OWNER_KINDS:
        raise AudienceError(f'Not an owner: {text!r} (expected =user/<uid>, =team/<tid> or =org/<oid>)')
    return Owner(audience.kind, audience.id)


# ==== Targets ====================================================================


def parse_target(text: str) -> Target:
    """
    Decode a publish target.

    Args:
        text: ``@me``, ``@<team>``, ``@org``, ``@public`` or any audience.

    Returns:
        The decoded ``Target``. Resolving it (a team name to its id, ``@me``
        to the caller) and deciding who may publish there is the door's work.

    Raises:
        AudienceError: The text is any other form: ``@spec``, a control, a
            bare word, or a root followed by a path.
    """
    try:
        root = parse_root(text)
    except RootError as e:
        raise AudienceError(f'Not a publish target: {text!r} ({e})') from e
    if root.rest:
        raise AudienceError(f'Not a publish target: {text!r} (nothing may follow the root)')
    if root.by_id:
        if root.kind in OWNER_KINDS:
            return Target(root.kind, root.ref, True)
    elif root.kind in (KIND_ME, KIND_ORG, KIND_PUBLIC):
        return Target(root.kind, '', False)
    elif root.kind == KIND_TEAM:
        return Target(KIND_TEAM, root.ref, False)
    raise AudienceError(
        f'Not a publish target: {text!r} (expected @me, @<team>, @org, @public, =team/<tid>, =org/<oid> or =user/<uid>)'
    )


def compose_target(kind: str, ref: str = '', by_id: bool = False) -> str:
    """
    Compose a publish target.

    Args:
        kind: ``me``, ``team``, ``org``, ``public`` or ``user``.
        ref: The team name, or the id of an ``=`` target.
        by_id: True to compose an ``=`` target.

    Returns:
        The target text.

    Raises:
        AudienceError: The combination is not a target.
    """
    try:
        text = format_root(kind, ref, by_id=by_id)
    except RootError as e:
        raise AudienceError(str(e)) from e
    # Round-trip through the decoder: only a form it reads is a target
    parse_target(text)
    return text


# ==== Deploy run scopes ==========================================================


def deploy_scope_of(text: str, caller_id: str) -> Tuple[str, str]:
    """
    The deploy-run scope a row's audience names, for one reader.

    A deployment row's ``teamId`` is its audience, and a client passes it
    back unchanged to the run-log reader and the task monitor, whose scope is
    a team's deploy continuum or the reader's own personal one.

    Args:
        text: The row's audience.
        caller_id: The reader's user id.

    Returns:
        ``(team_id, 'deploy')`` for a team; ``('', 'deploy')`` for the
        reader's own personal space.

    Raises:
        AudienceError: The text is not an audience, or names a scope these
            readers do not address by audience: another user's personal
            space, an org, or the store.
    """
    decoded = parse_audience(text)
    if decoded.kind == KIND_TEAM:
        return decoded.id, 'deploy'
    if decoded.kind == KIND_USER and caller_id and decoded.id == caller_id:
        return '', 'deploy'
    raise AudienceError(f'{text!r} names no deploy run this reader can address (a team, or your own personal space)')


# ==== Rungs and handles ==========================================================


def rung_of(audience: str, caller_id: str = '') -> str:
    """
    The rung a publication sits on, as its reader sees it.

    Args:
        audience: The publication's audience.
        caller_id: The reader's user id.

    Returns:
        ``me`` for the reader's own personal space, ``personal`` for another
        user's, ``team``, ``org`` or ``public``.

    Raises:
        AudienceError: The text is not an audience.
    """
    decoded = parse_audience(audience)
    if decoded.kind == KIND_USER:
        return RUNG_ME if caller_id and decoded.id == caller_id else RUNG_PERSONAL
    return {KIND_TEAM: RUNG_TEAM, KIND_ORG: RUNG_ORG, KIND_PUBLIC: RUNG_PUBLIC}[decoded.kind]


def compose_handle(
    audience: str,
    caller_id: str = '',
    team_names: Optional[Mapping[str, str]] = None,
    org_id: str = '',
) -> str:
    """
    The display of an audience, for one reader.

    Args:
        audience: The audience to show.
        caller_id: The reader's user id.
        team_names: The team names the reader can see, by team id.
        org_id: The reader's active org; when given, another org shows by id.

    Returns:
        ``@me``, ``@<team>``, ``@org``, ``@public``, ``=team/<tid>`` for a
        team the reader cannot name, ``=org/<oid>`` for an org that is not
        the reader's active one, or ``Personal`` for another user's space.

    Raises:
        AudienceError: The text is not an audience.
    """
    decoded = parse_audience(audience)
    if decoded.kind == KIND_PUBLIC:
        return PUBLIC_AUDIENCE
    if decoded.kind == KIND_USER:
        return format_root(KIND_ME) if caller_id and decoded.id == caller_id else HANDLE_PERSONAL
    if decoded.kind == KIND_ORG:
        if org_id and decoded.id != org_id:
            return compose_audience(KIND_ORG, decoded.id)
        return format_root(KIND_ORG)
    name = str((team_names or {}).get(decoded.id) or '').strip()
    if name:
        try:
            return format_root(KIND_TEAM, name)
        except RootError:
            # A name the grammar cannot carry is no handle: show the id form
            pass
    return compose_audience(KIND_TEAM, decoded.id)


def describe(
    audience: str,
    caller_id: str = '',
    team_names: Optional[Mapping[str, str]] = None,
    org_id: str = '',
) -> Dict[str, str]:
    """
    The three fields a row carries about its audience.

    Args:
        audience: The row's audience.
        caller_id: The reader's user id.
        team_names: The team names the reader can see, by team id.
        org_id: The reader's active org.

    Returns:
        ``{'audience', 'rung', 'handle'}``.

    Raises:
        AudienceError: The text is not an audience.
    """
    text = normalize_audience(audience)
    return {
        'audience': text,
        'rung': rung_of(text, caller_id),
        'handle': compose_handle(text, caller_id, team_names, org_id),
    }


__all__ = [
    'AUDIENCE_KINDS',
    'AUDIENCE_MAX_LENGTH',
    'Audience',
    'AudienceError',
    'HANDLE_PERSONAL',
    'OWNER_KINDS',
    'Owner',
    'PUBLIC_AUDIENCE',
    'RUNG_ME',
    'RUNG_ORG',
    'RUNG_PERSONAL',
    'RUNG_PUBLIC',
    'RUNG_TEAM',
    'Target',
    'audience_fields',
    'audience_of_fields',
    'compose_audience',
    'compose_handle',
    'compose_owner',
    'compose_target',
    'deploy_scope_of',
    'describe',
    'is_audience',
    'normalize_audience',
    'org_audience',
    'parse_audience',
    'parse_owner',
    'parse_target',
    'rung_of',
    'team_audience',
    'user_audience',
]
