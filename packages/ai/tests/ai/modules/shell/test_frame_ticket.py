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

"""Frame tickets and per-app aliases (#1022 PR2b, plan sections 3.5, 4.5, 4.9, Appendix L).

A frame ticket is the sealed answer to "which network origins may THIS app
version's frame reach": ``/_rr/frame.html?c=<ticket>``. It is not a credential
(it only widens one label's ``img-src`` / ``connect-src``) but it is sealed with
PR1's primitive so a page cannot forge one.

Pinned API (``ai.modules.shell.app_origin``), chosen by these tests where the
plan names the function but not its signature:

* ``mint_frame_ticket(app_id, version, network, *, config=None) -> str``
* ``verify_frame_ticket(ticket, host_label, *, config=None) -> dict``
  (the claims ``{a, v, n, iat, exp}``); any failure raises ``FrameTokenError``;
* the same keys, the same layout ``v1.<kid>.<nonce>.<ct>``; additional data
  ``v1.<kid>`` for a frame token and ``v1.<kid>.csp`` for a ticket, so neither
  opens as the other;
* ``user_alias(app_id, user_id, *, config=None)`` and
  ``org_alias(app_id, org_id, *, config=None)``.

Tests T79 and T84 of ``.rr-sec/PR2_PLAN.md``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import isolation_support as sup
from .isolation_support import b64u, key_entry, label_for, new_key, open_raw, seal_raw, valid_env

APP = 'acme.thirdparty'
OTHER = 'acme.other'
NETWORK = ['https://api.example.com', 'https://cdn.example.org:8443']


def _ao():
    return sup.load_module('ai.modules.shell.app_origin')


def _cfg(*entries: str, **overrides):
    env = valid_env(RR_APP_FRAME_TOKEN_KEYS=','.join(entries), **overrides)
    return sup.need(_ao(), 'load_isolation_config')(env)


def _mint(cfg, app=APP, version=1, network=None):
    return sup.need(_ao(), 'mint_frame_ticket')(app, version, NETWORK if network is None else network, config=cfg)


def _verify(ticket, label, cfg):
    return sup.need(_ao(), 'verify_frame_ticket')(ticket, label, config=cfg)


def _error():
    return sup.need(_ao(), 'FrameTokenError')


# ---------------------------------------------------------------------------
# T79 ticket seal
# ---------------------------------------------------------------------------


def test_ticket_layout_keys_and_claims(clock):
    """T79: the same format as a frame token, the first key signs, claims are exactly {a, v, n, iat, exp}."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    ticket = _mint(cfg)
    head, kid, nonce, sealed = ticket.split('.')
    assert (head, kid) == ('v1', 'k1')
    assert len(sup.unb64u(nonce)) == 12
    claims = open_raw(ticket, key, '.csp')  # AAD v1.<kid>.csp, independent of the product code
    assert set(claims) == {'a', 'v', 'n', 'iat', 'exp'}
    assert (claims['a'], claims['v'], claims['n']) == (APP, 1, NETWORK)
    assert 0 < claims['exp'] - claims['iat'] <= 900
    assert _verify(ticket, label_for(APP), cfg) == claims
    assert '=' not in ticket and '+' not in ticket and '/' not in ticket


def test_ticket_is_minted_for_anonymous_callers_too(clock):
    """T79: no user and no org in the signature or the claims."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    claims = open_raw(_mint(cfg), key, '.csp')
    assert not ({'u', 'o'} & set(claims))
    assert 'u1' not in json.dumps(claims)


def test_ticket_follows_key_rotation(clock):
    """T79: a ticket sealed under the first key still verifies after a rotation (old key kept second), and under neither otherwise."""
    old, new = new_key(), new_key()
    ticket = _mint(_cfg(key_entry('k1', old)))
    assert _verify(ticket, label_for(APP), _cfg(key_entry('k2', new), key_entry('k1', old)))['a'] == APP
    with pytest.raises(_error()):
        _verify(ticket, label_for(APP), _cfg(key_entry('k2', new)))


def test_ticket_and_frame_token_do_not_open_as_each_other(clock):
    """T79: AAD separation both ways. Same keys, same layout, different additional data."""
    ao = _ao()
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    ticket = _mint(cfg)
    token = sup.need(ao, 'mint_frame_token')(APP, 1, 'u1', 'org-1', config=cfg)
    with pytest.raises(_error()):
        sup.need(ao, 'verify_frame_token')(ticket, label_for(APP), config=cfg)
    with pytest.raises(_error()):
        _verify(token, label_for(APP), cfg)
    # and an attacker who seals ticket claims with the FRAME TOKEN's additional data is refused too
    now = int(clock.now)
    claims = {'a': APP, 'v': 1, 'n': NETWORK, 'iat': now, 'exp': now + 900}
    with pytest.raises(_error()):
        _verify(seal_raw(key, 'k1', claims, ''), label_for(APP), cfg)
    # the frame token format is byte-identical to PR1: AAD v1.<kid> only
    assert set(open_raw(token, key, '')) == {'a', 'v', 'u', 'o', 'iat', 'exp'}


def test_ticket_is_bound_to_its_label(clock):
    """T79: it opens only on the host of its own app."""
    cfg = _cfg(key_entry('k1', new_key()))
    ticket = _mint(cfg)
    assert _verify(ticket, label_for(APP), cfg)['a'] == APP
    for label in (label_for(OTHER), 'a' + 'q' * 24, '', label_for(APP).upper()):
        with pytest.raises(_error()):
            _verify(ticket, label, cfg)


def test_ticket_expires_within_the_frame_token_lifetime(clock):
    """T79: at most 15 minutes, so the key rotation window of PR1 still holds."""
    cfg = _cfg(key_entry('k1', new_key()))
    ticket = _mint(cfg)
    clock.advance(890)
    assert _verify(ticket, label_for(APP), cfg)['a'] == APP
    clock.advance(20)
    with pytest.raises(_error()):
        _verify(ticket, label_for(APP), cfg)


@pytest.mark.parametrize(
    'mutate',
    [
        lambda c, now: {**c, 'x': 1},  # extra claim
        lambda c, now: {k: v for k, v in c.items() if k != 'n'},  # no network
        lambda c, now: {**c, 'u': 'u1'},  # a user claim is not a ticket claim
        lambda c, now: {**c, 'n': 'https://api.example.com'},  # network not a list
        lambda c, now: {**c, 'n': [5]},
        lambda c, now: {**c, 'v': '1'},
        lambda c, now: {**c, 'v': True},
        lambda c, now: {**c, 'v': 0},
        lambda c, now: {**c, 'exp': now + 901},  # longer than 900 s
        lambda c, now: {**c, 'exp': now},  # zero lifetime
        lambda c, now: {**c, 'iat': now + 10, 'exp': now + 5},  # negative lifetime
        lambda c, now: {**c, 'a': 5},
    ],
    ids=range(12),
)
def test_ticket_strict_claims(mutate, clock):
    """T79: even under the right key and AAD only the exact claim set, types and lifetime verify."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    now = int(clock.now)
    claims = mutate({'a': APP, 'v': 1, 'n': NETWORK, 'iat': now, 'exp': now + 900}, now)
    with pytest.raises(_error()):
        _verify(seal_raw(key, 'k1', claims, '.csp'), label_for(APP), cfg)


def test_ticket_tamper_and_garbage(clock):
    """T79: one error for every cause."""
    key = new_key()
    cfg = _cfg(key_entry('k1', key))
    ticket = _mint(cfg)
    head, kid, nonce, sealed = ticket.split('.')
    flip = lambda text, i: text[:i] + ('A' if text[i] != 'A' else 'B') + text[i + 1 :]  # noqa: E731
    for bad in (
        f'{head}.{kid}.{nonce}.{flip(sealed, 0)}',
        f'{head}.k9.{nonce}.{sealed}',
        f'{head}.{kid}.{nonce}',
        f'{ticket}.extra',
        '',
        'garbage',
        None,
        5,
    ):
        with pytest.raises(_error()):
            _verify(bad, label_for(APP), cfg)


# ---------------------------------------------------------------------------
# T84 aliases
# ---------------------------------------------------------------------------

_USER_INFO = b'rocketride/app-user-alias/v1'
_ORG_INFO = b'rocketride/app-org-alias/v1'


def _reference_alias(prefix: str, info: bytes, alias_key: bytes, app_id: str, subject: str) -> str:
    """Appendix L, re-derived independently: HKDF-SHA256(alias_key, info) keys an HMAC over appId || 0x00 || subject."""
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(alias_key)
    mac = hmac.new(derived, app_id.encode() + b'\x00' + subject.encode(), hashlib.sha256).digest()
    return prefix + base64.urlsafe_b64encode(mac).rstrip(b'=').decode()[:22]


def _alias_cfg(alias_key: bytes, frame_key: bytes = None):
    return _cfg(key_entry('k1', frame_key or new_key()), RR_APP_ALIAS_KEY=b64u(alias_key))


def _user(cfg, app, user):
    return sup.need(_ao(), 'user_alias')(app, user, config=cfg)


def _org(cfg, app, org):
    return sup.need(_ao(), 'org_alias')(app, org, config=cfg)


def test_user_and_org_alias_match_the_documented_construction():
    """T84 / Appendix L: ``ru_`` / ``ro_`` plus 22 base64url characters of the keyed HMAC, per (app, subject)."""
    alias_key = new_key()
    cfg = _alias_cfg(alias_key)
    user, org = _user(cfg, APP, 'user-123'), _org(cfg, APP, 'org-9')
    assert user == _reference_alias('ru_', _USER_INFO, alias_key, APP, 'user-123')
    assert org == _reference_alias('ro_', _ORG_INFO, alias_key, APP, 'org-9')
    import re

    assert re.fullmatch(r'ru_[A-Za-z0-9_-]{22}', user)
    assert re.fullmatch(r'ro_[A-Za-z0-9_-]{22}', org)


def test_alias_is_stable_per_user_and_app_and_differs_across_apps_and_users():
    """T84: per-user app state keys on it, so it is stable; and it is not a cross-app identifier."""
    cfg = _alias_cfg(new_key())
    assert _user(cfg, APP, 'u1') == _user(cfg, APP, 'u1')
    assert _user(cfg, APP, 'u1') != _user(cfg, OTHER, 'u1')
    assert _user(cfg, APP, 'u1') != _user(cfg, APP, 'u2')
    assert _org(cfg, APP, 'o1') == _org(cfg, APP, 'o1')
    assert _org(cfg, APP, 'o1') != _org(cfg, OTHER, 'o1')
    assert _user(cfg, APP, 'x') != _org(cfg, APP, 'x'), 'user and org aliases of the same string never collide'


def test_alias_never_contains_the_real_id():
    """T84: not the user id, not the org id, in whole or as an obvious encoding."""
    cfg = _alias_cfg(new_key())
    for real in ('u1', 'user-7f3a9c11', 'local'):
        alias = _user(cfg, APP, real)
        assert real not in alias
        assert b64u(real.encode()) not in alias
    assert 'org-5b1e2d' not in _org(cfg, APP, 'org-5b1e2d')


def test_alias_survives_frame_token_key_rotation():
    """T84: rotating RR_APP_FRAME_TOKEN_KEYS (a new first key) leaves every alias alone."""
    alias_key = new_key()
    first = _alias_cfg(alias_key)
    rotated = _cfg(key_entry('k2', new_key()), key_entry('k1', first.token_keys[0][1]), RR_APP_ALIAS_KEY=b64u(alias_key))
    assert _user(rotated, APP, 'u1') == _user(first, APP, 'u1')
    assert _org(rotated, APP, 'o1') == _org(first, APP, 'o1')


def test_alias_changes_only_with_the_alias_key():
    """T84: RR_APP_ALIAS_KEY is the one input that moves an alias (documented as not for rotation)."""
    frame_key = new_key()
    a = _alias_cfg(new_key(), frame_key)
    b = _alias_cfg(new_key(), frame_key)
    assert _user(a, APP, 'u1') != _user(b, APP, 'u1')
    assert _org(a, APP, 'o1') != _org(b, APP, 'o1')


def test_alias_is_not_derived_from_the_frame_token_key():
    """T84 / P12: a deployment that only knows RR_APP_FRAME_TOKEN_KEYS cannot compute an alias."""
    frame_key = new_key()
    cfg = _alias_cfg(new_key(), frame_key)
    assert _user(cfg, APP, 'u1') != _reference_alias('ru_', _USER_INFO, frame_key, APP, 'u1')
