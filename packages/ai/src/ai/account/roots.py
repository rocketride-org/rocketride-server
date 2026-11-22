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
Roots: the one grammar for "whose" (plan 2.5).

Store paths, task addresses, publish targets, publication audiences and run
owners all open with the same optional first part, the ROOT, which says whose
space is meant. This module is the only reader and the only writer of that
grammar: ``parse_root`` splits a text into its root and the rest, and
``format_root`` writes a root back. Every other module calls these two and
decides nothing about spelling itself.

    (none)               reports/q3.pdf          the caller's own, or the ladder
    @me                  @me/reports/q3.pdf      the caller
    @<team>              @Development/kb         a team, by name
    @org                 @org/policies           the caller's active org
    @spec                @spec/acme.docBrain     the caller's spec runs
    @public              @public/acme.docBrain   the store
    =user/<uid>          =user/1234/notes        a user, by id
    =team/<tid>          =team/1234/kb           a team, by id
    =org/<oid>           =org/1234/policies      an org, by id
    =control/<32 hex>    =control/1234abcd...    a control, by id (the whole token)

Spelling rules:

- Root words (``me``, ``org``, ``spec``, ``public``, and the kind words
  ``user``, ``team``, ``org``, ``control`` of an id root) and team names match
  ignoring case; the server writes words in lowercase and names in the casing
  it was given. Ids compare exactly.
- A first segment that starts with ``@`` or ``=`` is always grammar, and under
  any root the first entry name may not start with either.
- An ``=`` root requires its id. A control root is the whole token: nothing
  may follow it.
- Normalization runs before parsing: backslashes are separators, leading
  separators drop, empty and ``.`` segments collapse, so ``\\=team\\x``,
  ``/=team/x`` and ``=team//x`` all decide as ``=team/x``.
- An unknown form raises ``RootError``. There is no default branch.

Team names are part of the grammar (``@<team>``), so the rule for what a team
may be called lives here too: ``RESERVED_TEAM_NAMES``, ``team_name_key`` and
``check_team_name``.
"""

import re
from typing import NamedTuple

# ==== Vocabulary =================================================================

#: The root kinds ``parse_root`` returns.
KIND_NONE = 'none'
KIND_ME = 'me'
KIND_TEAM = 'team'
KIND_ORG = 'org'
KIND_SPEC = 'spec'
KIND_PUBLIC = 'public'
KIND_USER = 'user'
KIND_CONTROL = 'control'

#: The ``@`` words that are roots of their own (never team names).
_NAME_WORDS = (KIND_ME, KIND_ORG, KIND_SPEC, KIND_PUBLIC)

#: The kinds an ``=`` root may name.
_ID_KINDS = (KIND_USER, KIND_TEAM, KIND_ORG, KIND_CONTROL)

#: Words no team may be named, compared with ``team_name_key`` (so in any case).
RESERVED_TEAM_NAMES = frozenset({'me', 'org', 'spec', 'public', 'team', 'user'})

#: A control id: 32 lowercase hex digits (plan 1).
_CONTROL_ID = re.compile(r'^[0-9a-f]{32}$')


# ==== Errors =====================================================================


class RootError(ValueError):
    """A text is not in the root grammar, or a root cannot be written."""


class RetiredRootError(RootError):
    """
    A text opens with a retired root word, ``@team`` or ``@user``.

    Each grammar that reads roots names the replacement in its own terms (a
    publish target says "publish to", a task address "write"), so the word
    rides on the error and the reader composes its own message.

    Attributes:
        word: ``team`` or ``user``, the retired word as the grammar keys it.
    """

    def __init__(self, word: str, message: str):
        super().__init__(message)
        self.word = word


# ==== The parsed root ============================================================


class Root(NamedTuple):
    """
    A parsed root and what follows it.

    Attributes:
        kind: ``none``, ``me``, ``team``, ``org``, ``spec``, ``public``,
            ``user`` or ``control``.
        ref: The team name (``@<team>``) or the id (an ``=`` root); ``''`` for
            a root that carries neither.
        by_id: True for an ``=`` root (``ref`` is an id, compared exactly),
            False for an ``@`` root or no root.
        rest: The normalized text after the root, ``''`` when nothing follows.
    """

    kind: str
    ref: str
    by_id: bool
    rest: str


# ==== Team names =================================================================


def team_name_key(name: str) -> str:
    """
    The key two team names are compared by: the trimmed name, casefolded.

    Two names with one key are the same name everywhere: in the unique
    constraint of the teams table, in ``@<team>`` resolution and in the
    reserved-word check.

    Args:
        name: A team display name.

    Returns:
        The casefolded, trimmed name.
    """
    return str(name or '').strip().casefold()


def check_team_name(name: str) -> str:
    """
    Refuse a team name the root grammar cannot carry, and return it trimmed.

    A team is addressed as ``@<name>``, so its name must be one path segment
    that is not a root word.

    Args:
        name: The proposed display name.

    Returns:
        The trimmed name.

    Raises:
        RootError: The name is empty, is ``.`` or ``..``, starts with ``@`` or
            ``=``, holds a separator or a control character, or is a reserved
            word in any case.
    """
    trimmed = str(name or '').strip()
    if not trimmed:
        raise RootError('Team name must not be empty')
    if trimmed in ('.', '..'):
        raise RootError("Team name must not be '.' or '..'")
    if trimmed.startswith('@'):
        raise RootError("Team name must not start with '@'")
    if trimmed.startswith('='):
        raise RootError("Team name must not start with '=' (reserved for id references)")
    if any(c in '/\\' or ord(c) < 0x20 for c in trimmed):
        raise RootError('Team name must not contain / \\ or control characters')
    if team_name_key(trimmed) in RESERVED_TEAM_NAMES:
        raise RootError(f'Team name {trimmed!r} is reserved (me, org, spec, public, team and user name roots)')
    return trimmed


# ==== Ids ========================================================================


def check_id(value: str, what: str = 'id') -> str:
    """
    Refuse an id that cannot be one segment of a root, and return it.

    Ids become physical path segments (``teams/<tid>/files``) and segments of
    composed strings (``=team/<tid>``), so an id is non-empty, holds no
    separator or control character, and starts with none of ``@``, ``=``, ``.``.

    Args:
        value: The id.
        what: Its name in the error message.

    Returns:
        The id, unchanged.

    Raises:
        RootError: The id is unusable.
    """
    if not isinstance(value, str) or not value:
        raise RootError(f'{what} is required')
    if value.startswith(('@', '=', '.')) or any(c in '/\\' or ord(c) < 0x20 for c in value):
        raise RootError(f'{what} contains invalid characters: {value!r}')
    return value


# ==== Parsing ====================================================================


def _segments(text: str) -> 'list[str]':
    """
    Normalize a text into its segments.

    Backslashes are separators, empty and ``.`` segments drop (so leading and
    doubled separators vanish), and ``..`` is refused: no spelling of a root
    may walk out of it.

    Args:
        text: The raw text.

    Returns:
        The non-empty segments, in order.

    Raises:
        RootError: The text is not a string, or holds a ``..`` segment.
    """
    if not isinstance(text, str):
        raise RootError('a rooted text must be a string')
    parts = [part for part in text.replace('\\', '/').split('/') if part and part != '.']
    if '..' in parts:
        raise RootError(f'Path traversal not allowed: {text}')
    return parts


def _check_first_entry(parts: 'list[str]') -> None:
    """
    Refuse a first entry name that looks like grammar.

    Under any root the first entry may not start with ``@`` or ``=``: such a
    name would shadow, or be shadowed by, a root.

    Args:
        parts: The segments after the root.

    Raises:
        RootError: The first entry starts with ``@`` or ``=``.
    """
    if parts and parts[0].startswith('='):
        raise RootError("Names starting with '=' are reserved for id roots")
    if parts and parts[0].startswith('@'):
        raise RootError("Names starting with '@' are reserved for roots")


def parse_root(text: str) -> Root:
    """
    Split a text into its root and the rest. THE parser of the root grammar.

    Normalization runs first, so every spelling of one location decides as
    one root. A text whose first segment starts with neither ``@`` nor ``=``
    has no root. Every other first segment must be one of the forms in the
    module docstring; anything else raises.

    Args:
        text: A store path, a task address, a publish target, an audience or
            an owner.

    Returns:
        The parsed ``Root``.

    Raises:
        RootError: The text is not in the grammar.
    """
    parts = _segments(text)

    # Step 1: no root at all
    if not parts or not parts[0].startswith(('@', '=')):
        return Root(KIND_NONE, '', False, '/'.join(parts))
    head = parts[0]

    # Step 2: an @ root is a word or a team name
    if head.startswith('@'):
        name = head[1:]
        if not name:
            raise RootError("'@' needs a root: @me, @<team>, @org, @spec or @public")
        key = team_name_key(name)
        tail = parts[1:]
        _check_first_entry(tail)
        if key in _NAME_WORDS:
            return Root(key, '', False, '/'.join(tail))
        # The words a team can never be named are no roots either: '@team/x'
        # and '@user' are the retired spellings, refused by name
        if key == KIND_TEAM:
            raise RetiredRootError(KIND_TEAM, "'@team' is not a root: name the team (@<name>) or write =team/<tid>")
        if key == KIND_USER:
            raise RetiredRootError(KIND_USER, "'@user' is not a root: write @me")
        return Root(KIND_TEAM, check_team_name(name), False, '/'.join(tail))

    # Step 3: an = root names its kind, then its id
    kind = head[1:].casefold()
    if kind not in _ID_KINDS:
        raise RootError(f'Unknown id root {head!r} (only =user/<uid>, =team/<tid>, =org/<oid> and =control/<id> exist)')
    if len(parts) < 2:
        raise RootError(f'={kind}/ requires an id')
    ident = check_id(parts[1], f'={kind} id')
    tail = parts[2:]
    if kind == KIND_CONTROL:
        # A control root is the whole token, never a root before a path
        if not _CONTROL_ID.match(ident):
            raise RootError('=control/ requires a control id of 32 lowercase hex digits')
        if tail:
            raise RootError('=control/<id> is a whole address: nothing may follow it')
        return Root(KIND_CONTROL, ident, True, '')
    _check_first_entry(tail)
    return Root(kind, ident, True, '/'.join(tail))


# ==== Writing ====================================================================


def format_root(kind: str, ref: str = '', by_id: bool = False, rest: str = '') -> str:
    """
    Write a root, and what follows it, in the one spelling the server uses.

    The inverse of ``parse_root``: words in lowercase, a team name in the
    casing given, an id exactly.

    Args:
        kind: The root kind (``Root.kind``).
        ref: The team name or the id; ``''`` for a root that carries neither.
        by_id: True to write an ``=`` root.
        rest: The text after the root.

    Returns:
        The rooted text, with no trailing separator.

    Raises:
        RootError: The kind is unknown, the root needs a reference it was not
            given (or was given one it cannot carry), or ``rest`` is not a
            plain path under the root.
    """
    # Step 1: the root itself
    if by_id:
        if kind not in _ID_KINDS:
            raise RootError(f'Unknown id root kind: {kind!r}')
        ident = check_id(ref, f'={kind} id')
        if kind == KIND_CONTROL and not _CONTROL_ID.match(ident):
            raise RootError('=control/ requires a control id of 32 lowercase hex digits')
        head = f'={kind}/{ident}'
    elif kind == KIND_NONE:
        if ref:
            raise RootError('a text with no root carries no reference')
        head = ''
    elif kind in _NAME_WORDS:
        if ref:
            raise RootError(f'@{kind} carries no reference')
        head = f'@{kind}'
    elif kind == KIND_TEAM:
        head = f'@{check_team_name(ref)}'
    else:
        raise RootError(f'Unknown root kind: {kind!r}')

    # Step 2: what follows it
    tail = _segments(rest)
    if kind == KIND_CONTROL and tail:
        raise RootError('=control/<id> is a whole address: nothing may follow it')
    if kind == KIND_NONE:
        if tail and tail[0].startswith(('@', '=')):
            raise RootError('a text with no root may not start with @ or =')
    else:
        _check_first_entry(tail)
    return '/'.join(([head] if head else []) + tail)
