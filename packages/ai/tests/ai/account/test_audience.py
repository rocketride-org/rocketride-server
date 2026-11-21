# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The strings the server composes about "whose" (plan 2.5): ``audience.py``.

Audiences, owners, targets, rungs and handles: every form composes and
decodes, and every other form raises (no decoder defaults to a team). The
retired spellings are pinned in ``test_legacy_audience.py``, the test file
of the one translator that knows them.
"""

import pytest

from ai.account.audience import (
    AUDIENCE_MAX_LENGTH,
    PUBLIC_AUDIENCE,
    Audience,
    AudienceError,
    Owner,
    Target,
    audience_fields,
    audience_of_fields,
    compose_audience,
    compose_handle,
    compose_owner,
    compose_target,
    describe,
    is_audience,
    normalize_audience,
    org_audience,
    parse_audience,
    parse_owner,
    parse_target,
    rung_of,
    team_audience,
    user_audience,
)

#: A valid control id.
CONTROL = '1234abcd' * 4

#: Forms that are no audience (and no owner).
NOT_AUDIENCES = [
    '',
    't1',
    '@me',
    '@org',
    '@spec',
    '@Development',
    '=user/u1/x',
    '=team/t1/kb',
    '@public/x',
    f'=control/{CONTROL}',
    '=team',
    '@/Team/=t1',
    '=nope/x',
]


# ============================================================================
# Audiences
# ============================================================================


class TestAudience:
    """``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` and ``@public``: nothing else."""

    def test_composes_every_kind(self):
        assert user_audience('u1') == '=user/u1'
        assert team_audience('t1') == '=team/t1'
        assert org_audience('o1') == '=org/o1'
        assert compose_audience('public') == PUBLIC_AUDIENCE == '@public'

    @pytest.mark.parametrize(
        ('text', 'expected'),
        [
            ('=user/u1', Audience('user', 'u1')),
            ('=team/t1', Audience('team', 't1')),
            ('=org/o1', Audience('org', 'o1')),
            ('@public', Audience('public', '')),
            ('@PUBLIC', Audience('public', '')),
            ('=TEAM/T1', Audience('team', 'T1')),
            ('/=team//t1/', Audience('team', 't1')),
        ],
    )
    def test_parses(self, text, expected):
        assert parse_audience(text) == expected

    @pytest.mark.parametrize('text', NOT_AUDIENCES)
    def test_refuses_every_other_form(self, text):
        with pytest.raises(AudienceError, match='Not an audience'):
            parse_audience(text)
        assert not is_audience(text)

    def test_refuses_a_non_string(self):
        for value in (None, 7, {'type': 'team', 'id': 't1'}):
            with pytest.raises(AudienceError):
                parse_audience(value)
            assert not is_audience(value)

    @pytest.mark.parametrize(
        ('kind', 'ident', 'message'),
        [
            ('team', '', 'required'),
            ('user', 'a/b', 'invalid characters'),
            ('org', '@x', 'invalid characters'),
            ('public', 'x', 'carries no id'),
            ('control', CONTROL, 'Unknown audience kind'),
            ('me', '', 'Unknown audience kind'),
            ('nope', 'x', 'Unknown audience kind'),
        ],
    )
    def test_compose_refuses(self, kind, ident, message):
        with pytest.raises(AudienceError, match=message):
            compose_audience(kind, ident)

    def test_normalizes_to_the_stored_spelling(self):
        assert normalize_audience('=TEAM/t1') == '=team/t1'
        assert normalize_audience('@Public') == '@public'
        assert normalize_audience('\\=user\\u1') == '=user/u1'

    def test_round_trips(self):
        for text in ('=user/u1', '=team/t1', '=org/o1', '@public'):
            assert compose_audience(*parse_audience(text)) == text

    def test_a_36_character_id_fits_the_stored_width(self):
        longest = team_audience('12345678-1234-1234-1234-123456789012')
        assert len(longest) <= AUDIENCE_MAX_LENGTH == 48
        assert len(user_audience('12345678-1234-1234-1234-123456789012')) <= AUDIENCE_MAX_LENGTH

    def test_the_type_id_pair(self):
        assert audience_fields('=team/t1') == {'type': 'team', 'id': 't1'}
        assert audience_fields('@public') == {'type': 'public', 'id': ''}
        assert audience_of_fields({'type': 'user', 'id': 'u1'}) == '=user/u1'
        assert audience_of_fields({'type': 'org', 'id': 'o1'}) == '=org/o1'
        assert audience_of_fields({'type': 'public', 'id': ''}) == '@public'
        assert audience_of_fields({'type': 'public'}) == '@public'

    def test_the_type_id_pair_refuses(self):
        for bad in ({'type': 'nope', 'id': 'x'}, {'id': 'x'}, {'type': 'team', 'id': ''}, 'team', None):
            with pytest.raises(AudienceError):
                audience_of_fields(bad)


# ============================================================================
# Owners
# ============================================================================


class TestOwner:
    """An owner is a user, a team or an org; the store owns no run."""

    def test_composes_and_parses(self):
        for kind in ('user', 'team', 'org'):
            text = compose_owner(kind, 'x1')
            assert text == f'={kind}/x1'
            assert parse_owner(text) == Owner(kind, 'x1')

    def test_the_store_owns_nothing(self):
        with pytest.raises(AudienceError, match='Not an owner'):
            parse_owner('@public')
        with pytest.raises(AudienceError, match='Unknown owner kind'):
            compose_owner('public', '')

    @pytest.mark.parametrize('text', NOT_AUDIENCES)
    def test_refuses_every_other_form(self, text):
        with pytest.raises(AudienceError, match='Not an owner'):
            parse_owner(text)


# ============================================================================
# Targets
# ============================================================================


class TestTarget:
    """``@me``, ``@<team>``, ``@org``, ``@public`` or any audience."""

    @pytest.mark.parametrize(
        ('text', 'expected'),
        [
            ('@me', Target('me', '', False)),
            ('@ME', Target('me', '', False)),
            ('@Development', Target('team', 'Development', False)),
            ('@org', Target('org', '', False)),
            ('@public', Target('public', '', False)),
            ('=team/t1', Target('team', 't1', True)),
            ('=org/o1', Target('org', 'o1', True)),
            ('=user/u1', Target('user', 'u1', True)),
        ],
    )
    def test_parses(self, text, expected):
        assert parse_target(text) == expected

    def test_every_audience_is_a_target(self):
        for text in ('=user/u1', '=team/t1', '=org/o1', '@public'):
            parse_target(text)

    @pytest.mark.parametrize(
        'text',
        [
            '@spec',
            f'=control/{CONTROL}',
            '@me/x',
            '=team/t1/x',
            't1',
            'Development',
            '',
            '@team/Development',
            '@user',
        ],
    )
    def test_refuses(self, text):
        with pytest.raises(AudienceError, match='Not a publish target'):
            parse_target(text)

    def test_compose(self):
        assert compose_target('me') == '@me'
        assert compose_target('team', 'Development') == '@Development'
        assert compose_target('team', 't1', by_id=True) == '=team/t1'
        assert compose_target('public') == '@public'
        with pytest.raises(AudienceError):
            compose_target('spec')
        with pytest.raises(AudienceError):
            compose_target('control', CONTROL, by_id=True)


# ============================================================================
# Rungs and handles
# ============================================================================


class TestRungAndHandle:
    """What a reader sees: the rung, and the handle composed for them."""

    def test_rungs(self):
        assert rung_of('=user/u1', 'u1') == 'me'
        assert rung_of('=user/u2', 'u1') == 'personal'
        assert rung_of('=user/u1', '') == 'personal'
        assert rung_of('=team/t1', 'u1') == 'team'
        assert rung_of('=org/o1', 'u1') == 'org'
        assert rung_of('@public', 'u1') == 'public'

    def test_handles(self):
        names = {'t1': 'Development'}
        assert compose_handle('=user/u1', 'u1') == '@me'
        assert compose_handle('=user/u2', 'u1') == 'Personal'
        assert compose_handle('=team/t1', 'u1', names) == '@Development'
        assert compose_handle('=team/t9', 'u1', names) == '=team/t9'
        assert compose_handle('=org/o1', 'u1', org_id='o1') == '@org'
        assert compose_handle('=org/o9', 'u1', org_id='o1') == '=org/o9'
        assert compose_handle('@public', 'u1') == '@public'

    def test_a_name_the_grammar_cannot_carry_shows_by_id(self):
        # A team named before the reserved-word rule
        assert compose_handle('=team/t1', 'u1', {'t1': 'Public'}) == '=team/t1'
        assert compose_handle('=team/t1', 'u1', {'t1': '@Dev'}) == '=team/t1'

    def test_describe(self):
        assert describe('=TEAM/t1', 'u1', {'t1': 'Development'}) == {
            'audience': '=team/t1',
            'rung': 'team',
            'handle': '@Development',
        }
        assert describe('=user/u1', 'u1') == {'audience': '=user/u1', 'rung': 'me', 'handle': '@me'}

    def test_unknown_forms_raise(self):
        for bad in ('t1', '@me', '=team/t1/x'):
            with pytest.raises(AudienceError):
                rung_of(bad, 'u1')
            with pytest.raises(AudienceError):
                compose_handle(bad, 'u1')
            with pytest.raises(AudienceError):
                describe(bad, 'u1')
