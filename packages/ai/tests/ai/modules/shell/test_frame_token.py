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

"""Per-app frame tokens (#1022 PR1, design sections 7 and Appendix C, as changed by G4 M3).

Layout: ``v1.<kid>.<b64url(nonce)>.<b64url(AES-256-GCM ciphertext and tag)>``.
The plaintext is the claims ``{a: appId, v: version, u: userId, o: orgId,
iat, exp}`` with ``exp = iat + 900``; the additional data is ``v1.<kid>``; the
AES key is HKDF-SHA256 (no salt, info ``rocketride/app-frame-token/aes-256-gcm/v1``)
of the configured key. App code reads its own token from the URL, so the claims
are CONFIDENTIAL (it never learns the user or org id) and authenticated (it
cannot change them). A token only ever grants GETs of ONE version's dist for at
most 15 minutes, on that app's own host.

Pinned API (``ai.modules.shell.app_origin``):

* ``mint_frame_token(app_id, version, user_id, org_id, *, config=None) -> str``
* ``verify_frame_token(token, host_label, *, config=None) -> dict`` (the claims);
  any failure raises ``FrameTokenError`` (a ``ValueError``).

Tests T20 to T25 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import json
import os

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

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


_INFO = b'rocketride/app-frame-token/aes-256-gcm/v1'


def _aead_key(key: bytes) -> bytes:
    """The documented derivation, independent of the product code."""
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(key)


def _forge(claims, key: bytes, kid: str = 'k1', nonce: bytes = None) -> str:
    """A token with the documented layout, built independently of the product code."""
    nonce = nonce or os.urandom(12)
    plain = claims if isinstance(claims, bytes) else json.dumps(claims, separators=(',', ':')).encode()
    sealed = AESGCM(_aead_key(key)).encrypt(nonce, plain, f'v1.{kid}'.encode())
    return f'v1.{kid}.{b64u(nonce)}.{b64u(sealed)}'


def _open(token: str, key: bytes) -> dict:
    """Decrypt a token independently of the product code."""
    head, kid, nonce, sealed = token.split('.')
    return json.loads(AESGCM(_aead_key(key)).decrypt(unb64u(nonce), unb64u(sealed), f'{head}.{kid}'.encode()))


# ---------------------------------------------------------------------------
# T20 layout and tampering
# ---------------------------------------------------------------------------


def test_frame_token_layout(clock):
    """T20: the documented AEAD layout; the claims decrypt with the derived key and say what was minted."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    token = _mint(cfg)
    head, kid, nonce, sealed = token.split('.')
    assert (head, kid) == ('v1', 'k1')
    assert len(unb64u(nonce)) == 12
    claims = _open(token, key)
    assert set(claims) == {'a', 'v', 'u', 'o', 'iat', 'exp'}
    assert (claims['a'], claims['v'], claims['u'], claims['o']) == (APP, 1, 'u1', 'org-1')
    assert claims['exp'] - claims['iat'] == 900
    assert abs(claims['iat'] - int(clock.now)) <= 1
    assert _verify(token, label_for(APP), cfg) == claims
    assert '=' not in token and '+' not in token and '/' not in token  # url-safe, no padding
    assert _mint(cfg) != token  # a fresh nonce per token


def test_frame_token_claims_are_confidential(clock):
    """T20 (G4 M3): app code reads its own token; it must not learn the user or org id (nor the app id)."""
    cfg = _cfg(key_entry('k1', new_key()))
    token = _mint(cfg, user='user-7f3a9c', org='org-5b1e2d')
    visible = token.encode() + b''.join(unb64u(part) for part in token.split('.')[2:])
    for secret in (b'user-7f3a9c', b'org-5b1e2d', APP.encode(), b'"u"', b'"o"'):
        assert secret not in visible, secret


@pytest.mark.parametrize(
    'claims',
    [
        {'a': APP, 'v': 1, 'u': 'u1', 'o': 'org-1', 'iat': 0, 'exp': 900, 'x': 1},  # extra claim
        {'a': APP, 'v': '1', 'u': 'u1', 'o': 'org-1', 'iat': 0, 'exp': 900},  # version not an int
        {'a': APP, 'v': True, 'u': 'u1', 'o': 'org-1', 'iat': 0, 'exp': 900},
        {'a': APP, 'v': 1, 'u': 5, 'o': 'org-1', 'iat': 0, 'exp': 900},
        {'a': APP, 'v': 1, 'u': 'u1', 'o': 'org-1', 'iat': 0, 'exp': 100000},  # longer than 15 minutes
        b'not json',
        b'[1, 2]',
    ],
    ids=repr,
)
def test_frame_token_strict_claims(claims, clock):
    """T20: even under the right key, only the exact claim set and types verify."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    if isinstance(claims, dict) and claims['exp'] == 900:
        now = int(clock.now)
        claims = {**claims, 'iat': now, 'exp': now + 900}
    elif isinstance(claims, dict):
        now = int(clock.now)
        claims = {**claims, 'iat': now, 'exp': now + 100000}
    with pytest.raises(_error()):
        _verify(_forge(claims, key), label_for(APP), cfg)


@pytest.mark.parametrize(
    'mutation',
    [
        'ciphertext',
        'tag',
        'nonce',
        'short_nonce',
        'truncated',
        'kid_swap',
        'drop_part',
        'extra_part',
        'empty',
        'garbage',
        'prefix',
        'not_b64',
        'other_key',
    ],
)
def test_frame_token_tamper(mutation, clock):
    """T20: any change to the token, or a token sealed under another key, is refused with the one error."""
    key, other = new_key(), new_key()
    cfg = _cfg(key_entry('k1', key), key_entry('k2', other))
    token = _mint(cfg)
    head, kid, nonce, sealed = token.split('.')
    flip = lambda text, i: text[:i] + ('A' if text[i] != 'A' else 'B') + text[i + 1 :]  # noqa: E731

    forged = {
        'ciphertext': f'{head}.{kid}.{nonce}.{flip(sealed, 0)}',
        'tag': f'{head}.{kid}.{nonce}.{flip(sealed, len(sealed) - 2)}',
        'nonce': f'{head}.{kid}.{flip(nonce, 0)}.{sealed}',
        'short_nonce': f'{head}.{kid}.{nonce[:-2]}.{sealed}',
        'truncated': f'{head}.{kid}.{nonce}.{sealed[:20]}',
        'kid_swap': f'{head}.k2.{nonce}.{sealed}',  # the kid is authenticated data
        'drop_part': f'{head}.{kid}.{nonce}',
        'extra_part': f'{token}.extra',
        'empty': '',
        'garbage': 'not-a-token',
        'prefix': f'v2.{kid}.{nonce}.{sealed}',
        'not_b64': f'{head}.{kid}.{nonce}.{sealed[:-1]}!',
        'other_key': _forge(_open(token, key), new_key()),  # an attacker seals the same claims with its own key
    }[mutation]
    with pytest.raises(_error()):
        _verify(forged, label_for(APP), cfg)


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
