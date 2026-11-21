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

# Security tests for AccountInfo serialization (A1 userToken leak).
#
# The push path (apaext_account) fans out to every open connection of a user,
# matched by userId alone. It must NOT carry the user's real rr_ session
# credential, or a task-scoped (pk_/tk_) connection matched by userId would
# adopt it client-side and escalate into the full user. to_push_result strips
# it (blanks userToken) while to_connect_result -- the connect/auth response,
# which the SDK is designed to read the token from -- keeps it.

from ai.account.models import AccountInfo


def test_to_connect_result_keeps_usertoken_excludes_auth():
    info = AccountInfo(userId='u1', auth='rr_realkey', userToken='rr_realkey', displayName='U')
    out = info.to_connect_result()
    # The raw credential (auth) is never echoed...
    assert 'auth' not in out
    # ...but the connect/auth response DOES carry the durable rr_ token.
    assert out['userToken'] == 'rr_realkey'
    assert out['userId'] == 'u1'


def test_to_push_result_blanks_usertoken_and_excludes_auth():
    info = AccountInfo(userId='u1', auth='rr_realkey', userToken='rr_realkey', displayName='U')
    out = info.to_push_result()
    assert 'auth' not in out
    # userToken is BLANKED so a pk_/tk_ socket cannot adopt the real key...
    assert out['userToken'] == ''
    # ...but kept as a (string) key so the shell's isConnectResult guard passes.
    assert 'userToken' in out
    assert isinstance(out['userToken'], str)
    # Every other field survives the push.
    assert out['userId'] == 'u1'
    assert out['displayName'] == 'U'


def test_to_push_result_does_not_mutate_the_model():
    info = AccountInfo(userId='u1', auth='rr_k', userToken='rr_k')
    info.to_push_result()
    # to_push_result returns a fresh dict; blanking its userToken must not
    # touch the live AccountInfo (whose auth still drives permission checks).
    assert info.userToken == 'rr_k'
    assert info.auth == 'rr_k'


def test_is_new_user_defaults_to_unknown_and_reaches_connect_result():
    """The isNewUser field defaults to unknown and reaches the connect result unchanged.

    The shell reads isNewUser off the connect result to tell a sign-up from a
    sign-in on the OAuth callback. A provider that does not know must not look
    like "existing user": the default is None (the shell reports null), and a
    provider's True or False survives serialization unchanged.
    """
    info = AccountInfo(userId='u1', auth='rr_k', userToken='rr_k')
    assert info.isNewUser is None
    assert info.to_connect_result()['isNewUser'] is None
    fresh = AccountInfo(userId='u2', auth='rr_k', userToken='rr_k', isNewUser=True)
    assert fresh.to_connect_result()['isNewUser'] is True
    returning = AccountInfo(userId='u3', auth='rr_k', userToken='rr_k', isNewUser=False)
    assert returning.to_connect_result()['isNewUser'] is False
    assert 'auth' not in fresh.to_connect_result()


# =============================================================================
# TEAM ORDER (B39)
# =============================================================================


def _member(order, teams, endpoints=None):
    from ai.account.models import AccountInfo

    return AccountInfo(
        userId='u',
        devTeam=order[0] if order else '',
        teamOrder=list(order),
        organization={
            'id': 'org',
            'name': '',
            'permissions': [],
            'teams': [{'id': t, 'name': t, 'permissions': []} for t in teams],
        },
        endpoints=endpoints,
    )


def test_team_order_is_the_stored_order_then_the_teams_joined_since():
    from ai.account.models import home_team, team_order

    info = _member(['b', 'gone'], ['a', 'b', 'c'])
    assert team_order(info) == ['b', 'a', 'c']
    assert home_team(info) == 'b'


def test_team_order_without_a_stored_order_is_membership_order():
    from ai.account.models import home_team, team_order

    assert team_order(_member([], ['a', 'b'])) == ['a', 'b']
    assert home_team(_member([], [])) == ''


def test_a_scoped_key_resolves_through_its_frozen_team_only():
    from ai.account.models import team_order

    assert team_order(_member(['a'], ['a'], endpoints=['acme.p.*'])) == ['a']
    assert team_order(_member(['a', 'b'], ['a', 'b'], endpoints=['acme.p.*'])) == []


# =============================================================================
# AUDIENCES AND TEAM NAMES (plan 2.5)
# =============================================================================


def _named(*teams):
    """An AccountInfo with the given (id, name) teams."""
    return AccountInfo(
        userId='u',
        auth='rr_k',
        userToken='rr_k',
        organization={
            'id': 'org',
            'name': '',
            'permissions': [],
            'teams': [{'id': tid, 'name': name, 'permissions': []} for tid, name in teams],
        },
    )


def test_each_connect_result_team_carries_its_audience():
    out = _named(('t-1', 'Development'), ('t-2', 'Production')).to_connect_result()
    assert [(t['id'], t['audience']) for t in out['organization']['teams']] == [
        ('t-1', '=team/t-1'),
        ('t-2', '=team/t-2'),
    ]
    # The push result is the same body with the token blanked
    pushed = _named(('t-1', 'Development')).to_push_result()
    assert pushed['organization']['teams'][0]['audience'] == '=team/t-1'


def test_the_connect_result_org_carries_the_org_rungs_audience():
    # C.35: the org rung's audience, composed by the server, passed back unchanged as a target
    assert _named(('t-1', 'Development')).to_connect_result()['organization']['audience'] == '=org/org'


def test_a_connect_result_without_an_org_has_no_teams_to_stamp():
    assert AccountInfo(userId='u', auth='rr_k', userToken='rr_k').to_connect_result()['organization'] is None


def test_a_team_name_resolves_ignoring_case_within_the_membership():
    from ai.account.models import team_id_of_name

    info = _named(('t-1', 'Development'), ('t-2', 'Production'))
    for name in ('Development', 'development', 'DEVELOPMENT', ' Development '):
        assert team_id_of_name(info, name) == 't-1'
    assert team_id_of_name(info, 'Elsewhere') == ''
    # An id is no name
    assert team_id_of_name(info, 't-2') == ''


def test_a_name_two_teams_share_ignoring_case_resolves_to_neither():
    from ai.account.models import team_id_of_name

    assert team_id_of_name(_named(('t-1', 'Ops'), ('t-2', 'OPS')), 'ops') == ''
