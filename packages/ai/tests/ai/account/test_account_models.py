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
