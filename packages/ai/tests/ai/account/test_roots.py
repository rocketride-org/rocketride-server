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

"""The one root grammar (plan 2.5): ``parse_root``, ``format_root`` and the team-name rule.

Every form of the table parses, every refused form raises, root words and
names ignore case while ids compare exactly, and every spelling of one
location normalizes to one root. ``format_root`` is the inverse.
"""

import pytest

from ai.account.roots import (
    RESERVED_TEAM_NAMES,
    RetiredRootError,
    Root,
    RootError,
    check_id,
    check_team_name,
    format_root,
    parse_root,
    team_name_key,
)

#: A valid control id (32 lowercase hex digits).
CONTROL = '1234abcd' * 4


# ============================================================================
# Every form of the table
# ============================================================================


class TestEveryForm:
    """Each row of the plan 2.5 table parses to its root."""

    @pytest.mark.parametrize(
        ('text', 'expected'),
        [
            ('', Root('none', '', False, '')),
            ('reports/q3.pdf', Root('none', '', False, 'reports/q3.pdf')),
            ('acme.docBrain', Root('none', '', False, 'acme.docBrain')),
            ('@me', Root('me', '', False, '')),
            ('@me/acme.docBrain', Root('me', '', False, 'acme.docBrain')),
            ('@Development', Root('team', 'Development', False, '')),
            ('@Development/reports/q3.pdf', Root('team', 'Development', False, 'reports/q3.pdf')),
            ('@org', Root('org', '', False, '')),
            ('@org/policies', Root('org', '', False, 'policies')),
            ('@spec/acme.docBrain', Root('spec', '', False, 'acme.docBrain')),
            ('@public', Root('public', '', False, '')),
            ('@public/acme.docBrain', Root('public', '', False, 'acme.docBrain')),
            ('=user/u1', Root('user', 'u1', True, '')),
            ('=user/u1/notes', Root('user', 'u1', True, 'notes')),
            ('=team/t1', Root('team', 't1', True, '')),
            ('=team/t1/kb', Root('team', 't1', True, 'kb')),
            ('=org/o1', Root('org', 'o1', True, '')),
            ('=org/o1/policies', Root('org', 'o1', True, 'policies')),
            (f'=control/{CONTROL}', Root('control', CONTROL, True, '')),
        ],
    )
    def test_parses(self, text, expected):
        assert parse_root(text) == expected

    def test_a_team_name_keeps_its_casing(self):
        assert parse_root('@deVelopment/x').ref == 'deVelopment'

    def test_a_team_name_may_hold_spaces_and_dots(self):
        assert parse_root('@Sales EMEA/x') == Root('team', 'Sales EMEA', False, 'x')
        assert parse_root('@v1.2/x') == Root('team', 'v1.2', False, 'x')


# ============================================================================
# Case rules
# ============================================================================


class TestCase:
    """Root words and kinds ignore case; ids compare exactly."""

    @pytest.mark.parametrize('word', ['me', 'org', 'spec', 'public'])
    def test_words_ignore_case(self, word):
        for spelling in (word, word.upper(), word.capitalize()):
            assert parse_root(f'@{spelling}/x') == Root(word, '', False, 'x')

    @pytest.mark.parametrize('kind', ['user', 'team', 'org'])
    def test_id_kinds_ignore_case_and_ids_do_not(self, kind):
        assert parse_root(f'={kind.upper()}/AbC/x') == Root(kind, 'AbC', True, 'x')
        assert parse_root(f'={kind}/abc/x').ref != parse_root(f'={kind}/ABC/x').ref

    def test_control_kind_ignores_case_but_its_id_is_lowercase_hex(self):
        assert parse_root(f'=CONTROL/{CONTROL}').kind == 'control'
        with pytest.raises(RootError, match='32 lowercase hex'):
            parse_root(f'=control/{CONTROL.upper()}')


# ============================================================================
# Normalization
# ============================================================================


class TestNormalization:
    """Every spelling of one location decides as one root."""

    @pytest.mark.parametrize(
        'spelling',
        ['=team/x', '\\=team\\x', '/=team/x', '=team//x', '//=team///x/', './=team/./x', '=team/x/', '\\\\=team\\\\x'],
    )
    def test_id_root_spellings(self, spelling):
        assert parse_root(spelling) == Root('team', 'x', True, '')

    @pytest.mark.parametrize('spelling', ['@me/a/b', '/@me/a/b', '\\@me\\a\\b', '@me//a/./b/', './@me/a//b'])
    def test_word_root_spellings(self, spelling):
        assert parse_root(spelling) == Root('me', '', False, 'a/b')

    def test_plain_path_spellings(self):
        for spelling in ('a/b', '/a/b', '\\a\\b', 'a//b/', './a/./b'):
            assert parse_root(spelling) == Root('none', '', False, 'a/b')

    @pytest.mark.parametrize('spelling', ['../x', '@me/../x', '=team/../x', '=team/t1/..', 'a/../../b', '\\..\\x'])
    def test_traversal_raises(self, spelling):
        with pytest.raises(RootError, match='traversal'):
            parse_root(spelling)


# ============================================================================
# Refused forms
# ============================================================================


class TestRefused:
    """An unknown form raises; there is no default branch."""

    @pytest.mark.parametrize(
        ('text', 'message'),
        [
            ('@', "'@' needs a root"),
            ('@/x', "'@' needs a root"),
            ('@/User', "'@' needs a root"),
            ('@/Team/Development/x', "'@' needs a root"),
            ('@/Team/=t1/x', "'@' needs a root"),
            ('@/Org', "'@' needs a root"),
            ('@/Org/=o1/x', "'@' needs a root"),
            ('@team', "'@team' is not a root"),
            ('@team/Development', "'@team' is not a root"),
            ('@TEAM/t1', "'@team' is not a root"),
            ('@user', "'@user' is not a root"),
            ('@User/x', "'@user' is not a root"),
            ('=', 'Unknown id root'),
            ('=t1/x', 'Unknown id root'),
            ('=public/x', 'Unknown id root'),
            ('=me/x', 'Unknown id root'),
            ('=spec/x', 'Unknown id root'),
            ('=user', 'requires an id'),
            ('=team/', 'requires an id'),
            ('=org', 'requires an id'),
            ('=control', 'requires an id'),
            ('=control/abc', '32 lowercase hex'),
            (f'=control/{CONTROL}/x', 'nothing may follow'),
            ('=team/@t1', 'invalid characters'),
            ('=team/=t1', 'invalid characters'),
            ('=team/.hidden', 'invalid characters'),
            ('@me/=x', 'reserved for id roots'),
            ('@me/@x', 'reserved for roots'),
            ('@Development/=x', 'reserved for id roots'),
            ('=team/t1/@x', 'reserved for roots'),
            ('=org/o1/=x', 'reserved for id roots'),
            ('@org/@x', 'reserved for roots'),
        ],
    )
    def test_raises(self, text, message):
        with pytest.raises(RootError, match=message):
            parse_root(text)

    def test_non_string_raises(self):
        for value in (None, 7, b'@me'):
            with pytest.raises(RootError):
                parse_root(value)

    def test_root_error_is_a_value_error(self):
        assert issubclass(RootError, ValueError)

    @pytest.mark.parametrize(
        ('text', 'word'),
        [('@team', 'team'), ('@TEAM/Development', 'team'), ('@user', 'user'), ('@User/x', 'user')],
    )
    def test_a_retired_word_names_itself_so_each_grammar_names_its_replacement(self, text, word):
        with pytest.raises(RetiredRootError) as excinfo:
            parse_root(text)
        assert excinfo.value.word == word and isinstance(excinfo.value, RootError)

    def test_a_nested_sigil_is_a_plain_name(self):
        assert parse_root('docs/=weird').rest == 'docs/=weird'
        assert parse_root('@me/docs/@x').rest == 'docs/@x'


# ============================================================================
# Writing
# ============================================================================


class TestFormatRoot:
    """format_root writes the one spelling, and inverts parse_root."""

    @pytest.mark.parametrize(
        'text',
        [
            '',
            'a/b',
            '@me',
            '@me/a',
            '@Development',
            '@Development/kb',
            '@org/p',
            '@spec/acme.docBrain',
            '@public',
            '=user/u1/n',
            '=team/t1',
            '=org/o1/p',
            f'=control/{CONTROL}',
        ],
    )
    def test_round_trips(self, text):
        assert format_root(*parse_root(text)) == text

    def test_writes_words_in_lowercase_and_names_as_given(self):
        assert format_root(*parse_root('@ME/x')) == '@me/x'
        assert format_root(*parse_root('=TEAM/T1/x')) == '=team/T1/x'
        assert format_root(*parse_root('@deVelopment')) == '@deVelopment'

    def test_normalizes_rest(self):
        assert format_root('team', 't1', by_id=True, rest='/a//b/./c/') == '=team/t1/a/b/c'
        assert format_root('org', 'o1', by_id=True, rest='') == '=org/o1'

    @pytest.mark.parametrize(
        ('args', 'kwargs', 'message'),
        [
            (('nope',), {}, 'Unknown root kind'),
            (('nope', 'x'), {'by_id': True}, 'Unknown id root kind'),
            (('me', 'x'), {}, 'carries no reference'),
            (('public', 'x'), {}, 'carries no reference'),
            (('none', 'x'), {}, 'carries no reference'),
            (('team', ''), {'by_id': True}, 'required'),
            (('team', 'a/b'), {'by_id': True}, 'invalid characters'),
            (('team', '..'), {'by_id': True}, 'invalid characters'),
            (('team', 'me'), {}, 'reserved'),
            (('team', 'x/y'), {}, 'must not contain'),
            (('control', 'abc'), {'by_id': True}, '32 lowercase hex'),
            (('control', CONTROL), {'by_id': True, 'rest': 'x'}, 'nothing may follow'),
            (('none',), {'rest': '@me/x'}, 'may not start with'),
            (('me',), {'rest': '=x'}, 'reserved for id roots'),
            (('team', 't1'), {'by_id': True, 'rest': '../x'}, 'traversal'),
        ],
    )
    def test_refuses(self, args, kwargs, message):
        with pytest.raises(RootError, match=message):
            format_root(*args, **kwargs)


# ============================================================================
# Team names and ids
# ============================================================================


class TestTeamNames:
    """Reserved words in any case, one key per name, one segment per name."""

    def test_reserved_words(self):
        assert RESERVED_TEAM_NAMES == {'me', 'org', 'spec', 'public', 'team', 'user'}

    @pytest.mark.parametrize('word', sorted(RESERVED_TEAM_NAMES))
    def test_reserved_in_every_case(self, word):
        for spelling in (word, word.upper(), word.capitalize(), word[:-1] + word[-1].upper(), f'  {word} '):
            with pytest.raises(RootError, match='reserved'):
                check_team_name(spelling)

    def test_a_reserved_word_is_never_a_team_root(self):
        for word in ('me', 'org', 'spec', 'public'):
            assert parse_root(f'@{word.upper()}').kind == word
        for word in ('team', 'user'):
            with pytest.raises(RootError, match='is not a root'):
                parse_root(f'@{word.upper()}')

    def test_names_that_contain_a_reserved_word_are_fine(self):
        for name in ('Team A', 'Users', 'Public Relations', 'meetings', 'Organization'):
            assert check_team_name(name) == name

    @pytest.mark.parametrize(
        ('name', 'message'),
        [
            ('', 'empty'),
            ('   ', 'empty'),
            ('.', "'.' or '..'"),
            ('..', "'.' or '..'"),
            ('@Dev', "start with '@'"),
            ('=Dev', "start with '='"),
            ('a/b', 'must not contain'),
            ('a\\b', 'must not contain'),
            ('a\tb', 'must not contain'),
        ],
    )
    def test_refused_names(self, name, message):
        with pytest.raises(RootError, match=message):
            check_team_name(name)

    def test_check_trims(self):
        assert check_team_name('  Development  ') == 'Development'

    def test_key_casefolds_and_trims(self):
        assert team_name_key('  Development ') == team_name_key('DEVELOPMENT') == 'development'
        # casefold, not lower: the German sharp s folds to 'ss'
        assert team_name_key('Straße') == team_name_key('STRASSE')

    def test_check_id(self):
        assert check_id('t-1') == 't-1'
        for bad in ('', '@t', '=t', '.t', 'a/b', 'a\\b', 'a\x00b', None):
            with pytest.raises(RootError):
                check_id(bad)
