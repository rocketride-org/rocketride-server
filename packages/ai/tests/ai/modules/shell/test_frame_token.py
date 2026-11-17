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

"""Per-app frame tokens (#1022 PR1, design sections 7 and Appendix C).

Layout: ``v1.<kid>.<b64url(json claims)>.<b64url(HMAC-SHA256(key, "v1.<kid>.<claims>"))>``
with claims ``{a: appId, v: version, u: userId, o: orgId, iat, exp}`` and
``exp = iat + 900``. App code can read its own token, so it only ever grants
GETs of ONE version's dist for at most 15 minutes, on that app's own host.

Pinned API (``ai.modules.shell.app_origin``):

* ``mint_frame_token(app_id, version, user_id, org_id, *, config=None) -> str``
* ``verify_frame_token(token, host_label, *, config=None) -> dict`` (the claims);
  any failure raises ``FrameTokenError`` (a ``ValueError``).

Tests T20 to T25 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from . import isolation_support as sup
from .isolation_support import b64u, key_entry, label_for, new_key, unb64u, valid_env

APP = 'acme.thirdparty'
DENIED = (401, 403, 404)


def _ao():
    return sup.load_module('ai.modules.shell.app_origin')


def _cfg(*entries: str):
    return sup.need(_ao(), 'load_isolation_config')(valid_env(RR_APP_FRAME_TOKEN_KEYS=','.join(entries)))


def _mint(cfg, app=APP, version=1, user='u1', org='org-1'):
    return sup.need(_ao(), 'mint_frame_token')(app, version, user, org, config=cfg)


def _verify(token, label, cfg):
    return sup.need(_ao(), 'verify_frame_token')(token, label, config=cfg)


def _error():
    return sup.need(_ao(), 'FrameTokenError')


def _forge(claims: dict, key: bytes, kid: str = 'k1') -> str:
    """A token with the right layout, built independently of the product code."""
    body = b64u(json.dumps(claims, separators=(',', ':')).encode())
    sig = hmac.new(key, f'v1.{kid}.{body}'.encode(), hashlib.sha256).digest()
    return f'v1.{kid}.{body}.{b64u(sig)}'


# ---------------------------------------------------------------------------
# T20 layout and tampering
# ---------------------------------------------------------------------------


def test_frame_token_layout(clock):
    """T20: the documented layout, signed with HMAC-SHA256 over ``v1.<kid>.<claims>``, 15 minutes."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    token = _mint(cfg)
    version, kid, body, sig = token.split('.')
    assert (version, kid) == ('v1', 'k1')
    claims = json.loads(unb64u(body))
    assert set(claims) == {'a', 'v', 'u', 'o', 'iat', 'exp'}
    assert (claims['a'], claims['v'], claims['u'], claims['o']) == (APP, 1, 'u1', 'org-1')
    assert claims['exp'] - claims['iat'] == 900
    assert abs(claims['iat'] - int(clock.now)) <= 1
    assert sig == b64u(hmac.new(key, f'v1.k1.{body}'.encode(), hashlib.sha256).digest())
    assert _verify(token, label_for(APP), cfg) == claims
    assert '=' not in token and '+' not in token and '/' not in token  # url-safe, no padding


@pytest.mark.parametrize(
    'mutation',
    [
        'version',
        'user',
        'org',
        'app',
        'signature',
        'drop_signature',
        'extra_part',
        'empty',
        'garbage',
        'prefix',
        'other_key',
    ],
)
def test_frame_token_tamper(mutation, clock):
    """T20: any change to the claims or the signature, or a signature under another key, is refused."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    token = _mint(cfg)
    head, kid, body, sig = token.split('.')
    claims = json.loads(unb64u(body))
    label = label_for(APP)

    if mutation in ('version', 'user', 'org', 'app'):
        field = {'version': 'v', 'user': 'u', 'org': 'o', 'app': 'a'}[mutation]
        claims[field] = {'v': 2, 'u': 'u2', 'o': 'org-2', 'a': 'acme.other'}[field]
        forged = f'{head}.{kid}.{b64u(json.dumps(claims, separators=(",", ":")).encode())}.{sig}'  # old signature kept
        if mutation == 'app':
            label = label_for('acme.other')
    elif mutation == 'signature':
        flipped = 'A' if sig[0] != 'A' else 'B'  # the FIRST char carries 6 full bits
        forged = f'{head}.{kid}.{body}.{flipped}{sig[1:]}'
    elif mutation == 'drop_signature':
        forged = f'{head}.{kid}.{body}'
    elif mutation == 'extra_part':
        forged = f'{token}.extra'
    elif mutation == 'empty':
        forged = ''
    elif mutation == 'garbage':
        forged = 'not-a-token'
    elif mutation == 'prefix':
        forged = f'v2.{kid}.{body}.{sig}'
    else:  # other_key: an attacker signs well-formed claims with a key of their own
        forged = _forge(claims, new_key())
    with pytest.raises(_error()):
        _verify(forged, label, cfg)


# ---------------------------------------------------------------------------
# T21 wrong app, version or host label
# ---------------------------------------------------------------------------


def test_frame_token_is_bound_to_its_apps_host_label(clock):
    """T21: a token only verifies on the host whose label is ``label_of(claims.a)``."""
    cfg = _cfg(key_entry('k1', new_key()))
    token = _mint(cfg)
    assert _verify(token, label_for(APP), cfg)['a'] == APP
    for wrong in (label_for('acme.other'), label_for(APP.upper()), label_for(APP)[:-1], '', 'a' * 25):
        with pytest.raises(_error()):
            _verify(token, wrong, cfg)


def test_label_of_is_the_documented_hash():
    """T21: ``label_of`` = ``a`` + the first 24 characters of unpadded lowercase base32 of sha256."""
    label_of = sup.need(_ao(), 'label_of')
    for app in (APP, 'rocketride.home', 'a', 'x' * 128):
        assert label_of(app) == label_for(app)
        assert len(label_of(app)) == 25
        assert set(label_of(app)) <= set('abcdefghijklmnopqrstuvwxyz234567')
    assert label_of('acme.x_foo') != label_of('acme_x.foo')  # no collision between look-alike ids


def test_token_for_another_app_or_version_is_denied_on_the_route(served_app):
    """T21: on the route a token opens ITS app on ITS host at ITS version, nothing else."""
    served_app.registry.add(served_app.APP, 2)
    served_app.registry.add('acme.other', 1)
    other_host = sup.app_host_of(label_for('acme.other'))

    assert served_app.get_bundle(served_app.token(version=1), version=1).status_code == 200
    assert served_app.get_bundle(served_app.token(version=2), version=2).status_code == 200
    # right app, wrong version in the URL
    assert served_app.get_bundle(served_app.token(version=1), version=2).status_code in DENIED
    assert served_app.get_bundle(served_app.token(version=2), version=1).status_code in DENIED
    # right token, another app's host
    assert served_app.get_bundle(served_app.token(), host=other_host).status_code in DENIED
    # another app's token on this app's host
    assert served_app.get_bundle(served_app.token(app='acme.other')).status_code in DENIED
    # the shell host never serves it
    assert served_app.get_bundle(served_app.token(), host='app.example').status_code == 404


# ---------------------------------------------------------------------------
# T22 expiry
# ---------------------------------------------------------------------------


def test_frame_token_expires_after_fifteen_minutes(clock):
    """T22: valid for 900 s, refused after."""
    cfg = _cfg(key_entry('k1', new_key()))
    token = _mint(cfg)
    clock.advance(899)
    assert _verify(token, label_for(APP), cfg)['a'] == APP
    clock.advance(2)
    with pytest.raises(_error()):
        _verify(token, label_for(APP), cfg)


def test_expired_token_is_denied_on_the_route(served_app, clock):
    """T22: the route re-verifies on every request."""
    token = served_app.token()
    clock.advance(600)
    assert served_app.get_bundle(token).status_code == 200
    clock.advance(400)  # 1000 s after minting
    assert served_app.get_bundle(token).status_code in DENIED


# ---------------------------------------------------------------------------
# T23 kid rotation
# ---------------------------------------------------------------------------


def test_kid_rotation_old_verifies_new_signs(clock):
    """T23: the FIRST listed key signs; the rest only verify; dropping a key retires its tokens."""
    old, new = new_key(), new_key()
    cfg_old = _cfg(key_entry('k1', old))
    old_token = _mint(cfg_old)

    cfg_rotating = _cfg(key_entry('k2', new), key_entry('k1', old))
    assert _verify(old_token, label_for(APP), cfg_rotating)['a'] == APP  # the old key still verifies
    new_token = _mint(cfg_rotating)
    assert new_token.split('.')[1] == 'k2'  # the new key signs
    assert _verify(new_token, label_for(APP), cfg_rotating)['a'] == APP

    cfg_new_only = _cfg(key_entry('k2', new))
    assert _verify(new_token, label_for(APP), cfg_new_only)['a'] == APP
    with pytest.raises(_error()):
        _verify(old_token, label_for(APP), cfg_new_only)  # k1 was removed: its tokens die


# ---------------------------------------------------------------------------
# T24 unknown kid
# ---------------------------------------------------------------------------


def test_unknown_kid_is_refused(clock):
    """T24: a kid that is not configured never verifies, even when the signature is a real key's."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    now = int(clock.now)
    claims = {'a': APP, 'v': 1, 'u': 'u1', 'o': 'org-1', 'iat': now, 'exp': now + 900}
    assert _verify(_forge(claims, key, kid='k1'), label_for(APP), cfg)  # the independent forger is right
    for kid in ('zz', 'K1', 'k1 ', '', 'k2'):
        with pytest.raises(_error()):
            _verify(_forge(claims, key, kid=kid), label_for(APP), cfg)


# ---------------------------------------------------------------------------
# T25 the token never leaks; /_t is private and not stored
# ---------------------------------------------------------------------------


def test_token_responses_are_private_no_store_and_send_no_referrer(served_app):
    """T25: ``Cache-Control: private, no-store`` and ``Referrer-Policy: no-referrer`` on every /_t answer."""
    token = served_app.token()
    resp = served_app.get_bundle(token)
    assert resp.status_code == 200
    assert resp.headers['cache-control'] == 'private, no-store'
    assert resp.headers['referrer-policy'] == 'no-referrer'
    # the bytes come from this version's dist, nowhere else
    assert served_app.reads == [f'{served_app.registry.dist_dir(served_app.APP, 1)}/remoteEntry.js']
    # nothing in the answer carries the token back (no redirect, no Link, no echo)
    for name, value in resp.headers.items():
        assert token not in value, name
    assert token not in resp.text


def test_the_frame_document_has_no_token_and_needs_none(served_app):
    """T25: the frame URL is ``<origin>/_rr/frame.html`` with no query or fragment; the page body never holds a token."""
    token = served_app.token()
    resp = served_app.get('/_rr/frame.html')
    assert resp.status_code == 200
    assert token not in resp.text and 'v1.k1.' not in resp.text
    assert resp.headers['referrer-policy'] == 'no-referrer'
