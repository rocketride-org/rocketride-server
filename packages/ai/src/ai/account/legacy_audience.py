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
The audience spellings a registry file written before plan 2.5 may hold.

The file registry (``FileDeploymentBackend``, the OSS and desktop backend)
keeps its publications in ``meta.json``. A file written before the one
audience grammar spells an audience in one of four retired ways. This module
holds the ONE function that knows them: the backend calls it when it reads a
meta, so the retired spellings are translated at read time and written back
in the new form by the next write. No other server code knows them (the
repository's gate test refuses them everywhere else).

    user~<uid>    ->  =user/<uid>
    team~<tid>    ->  =team/<tid>
    ~public       ->  @public
    <tid>         ->  =team/<tid>      (a bare team id)
"""

from .audience import PUBLIC_AUDIENCE, is_audience, normalize_audience, team_audience, user_audience

# ==== The retired spellings ======================================================

_OLD_USER = 'user~'
_OLD_TEAM = 'team~'
_OLD_PUBLIC = '~public'


# ==== Translation ================================================================


def translate_legacy_audience(value: str) -> str:
    """
    An audience from a registry file, in the one grammar.

    Args:
        value: A publish-map key, a pointer slot or a history row's
            ``teamId`` as the file holds it: an audience already, or one of
            the four retired spellings.

    Returns:
        The audience (``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` or
        ``@public``).

    Raises:
        AudienceError: The value is empty, or names an id the grammar cannot
            carry.
    """
    if is_audience(value):
        return normalize_audience(value)
    value = str(value or '')
    if value == _OLD_PUBLIC:
        return PUBLIC_AUDIENCE
    if value.startswith(_OLD_USER):
        return user_audience(value[len(_OLD_USER) :])
    if value.startswith(_OLD_TEAM):
        return team_audience(value[len(_OLD_TEAM) :])
    return team_audience(value)


__all__ = ['translate_legacy_audience']
