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

"""Startup configuration of app isolation (#1022 PR1, design sections 2 and Appendix C).

``RR_APP_ISOLATION`` is ``off`` by default and then NOTHING else is read.
When it is not ``off``, ``validate_isolation_config()`` runs from ``initModule``
and refuses to start (``RuntimeError``, ONE line naming the check and the
remedy) unless: (a) the flags are valid, (b) the guest runtime marker exists,
(c) ``capabilities.json`` matches the marker's sha256, (d) on SaaS the account
class overrides the account methods required by isolation and live app eligibility.

Tests T1 to T8 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import re

import pytest

import ai.modules.shell as shell_pkg

from . import isolation_support as sup
from .isolation_support import b64u, key_entry, need, new_key


def _ao():
    return sup.load_module('ai.modules.shell.app_origin')


def _validate(**kwargs):
    return need(_ao(), 'validate_isolation_config')(**kwargs)


def _refuses(match: str, **kwargs) -> str:
    """``validate`` must raise a ONE-line RuntimeError that names ``match``; returns the message."""
    with pytest.raises(RuntimeError) as exc:
        _validate(**kwargs)
    message = str(exc.value)
    assert '\n' not in message.strip(), message
    assert match.lower() in message.lower(), message
    return message


# ---------------------------------------------------------------------------
# T1 off is the default and reads nothing
# ---------------------------------------------------------------------------


def test_config_off_by_default(isolation_env, monkeypatch, tmp_path):
    """T1: no variable means ``off``; under ``off`` no other variable, file or account class is checked."""
    ao = _ao()
    load = need(ao, 'load_isolation_config')
    assert load({}).mode == 'off'
    assert load({'RR_APP_ISOLATION': 'off'}).mode == 'off'

    sup.apply_env(monkeypatch, {})  # nothing set at all
    monkeypatch.setenv('RR_APP_ORIGIN_TEMPLATE', 'garbage')  # ignored: mode is off
    monkeypatch.setenv('RR_APP_FRAME_TOKEN_KEYS', 'not:a:key')
    monkeypatch.setenv('RR_APP_HOST_SOURCE', 'bogus')
    monkeypatch.setenv('RR_EDGE_SECRET', 'x')
    monkeypatch.setenv('RR_SHELL_ORIGINS', '*')
    monkeypatch.setattr(_shell_mod(), '_shell_root', str(tmp_path / 'missing'))
    _validate()  # no raise: no runtime marker, no capabilities file needed either
    monkeypatch.setenv('RR_APP_ISOLATION', 'off')
    _validate()


def _shell_mod():
    import ai.modules.shell.shell as shell_mod

    return shell_mod


def test_valid_configuration_is_accepted(isolation_env):
    """T1 control: the fixture's configuration starts, so every refusal below is about its one change."""
    _validate()
    cfg = isolation_env.config()
    assert cfg.mode == 'enforce'
    assert cfg.origin_template == sup.TEMPLATE
    assert list(cfg.shell_origins) == [sup.SHELL_ORIGIN]
    assert cfg.host_source == 'host'
    assert [kid for kid, _ in cfg.token_keys] == ['k1']


def test_shell_origins_default_to_the_frontend_origin(isolation_env):
    """RR_SHELL_ORIGINS defaults to RR_FRONTEND_ORIGIN (design section 2)."""
    isolation_env.set(RR_SHELL_ORIGINS=None, RR_FRONTEND_ORIGIN='https://front.example')
    assert list(isolation_env.config().shell_origins) == ['https://front.example']
    _validate()


def test_optin_lists_the_isolated_apps(isolation_env):
    """``optin`` carries RR_APP_ISOLATION_APPS as a set of app ids."""
    isolation_env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS='acme.one, acme.two')
    cfg = isolation_env.config()
    assert cfg.mode == 'optin'
    assert set(cfg.apps) == {'acme.one', 'acme.two'}
    _validate()


# ---------------------------------------------------------------------------
# T2 a bad mode, or a non-off mode with nothing configured, stops the engine
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('mode', ['enforce', 'optin'])
def test_invalid_mode_refuses_start_when_nothing_else_is_configured(mode, tmp_path, monkeypatch, clean_caches):
    """T2 (behavioural): ``enforce``/``optin`` with no template, key or runtime must stop module init.

    Today ``initModule`` ignores the variable, so the engine starts happily with
    isolation "on" and nothing behind it.
    """
    sup.apply_env(monkeypatch, {'RR_APP_ISOLATION': mode})
    monkeypatch.setattr(_shell_mod(), '_shell_root', str(tmp_path / 'no-static' / 'shell'))
    with pytest.raises(RuntimeError):
        shell_pkg.initModule(sup.FakeServer(), {})


@pytest.mark.parametrize('mode', ['on', 'true', '1', 'Enforce', 'ENFORCE', 'strict', 'enabled'])
def test_unknown_mode_refuses_start(mode, isolation_env):
    """T2 (behavioural): the mode is exactly ``off``, ``optin`` or ``enforce``; anything else stops startup."""
    isolation_env.set(RR_APP_ISOLATION=mode)
    with pytest.raises(RuntimeError) as exc:
        shell_pkg.initModule(sup.FakeServer(), {})
    assert 'RR_APP_ISOLATION' in str(exc.value)


# ---------------------------------------------------------------------------
# T3 template and keys
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'name,value',
    [
        ('RR_APP_ORIGIN_TEMPLATE', None),
        ('RR_APP_FRAME_TOKEN_KEYS', None),
        ('RR_APP_FRAME_TOKEN_KEYS', ''),
        ('RR_APP_FRAME_TOKEN_KEYS', f'k1:{b64u(b"x" * 31)}'),  # 31 bytes: too short
        ('RR_APP_FRAME_TOKEN_KEYS', f'{b64u(new_key())}'),  # no kid
        ('RR_APP_FRAME_TOKEN_KEYS', 'k1:***not base64***'),
        ('RR_APP_FRAME_TOKEN_KEYS', f'k1:{b64u(new_key())},k1:{b64u(new_key())}'),  # duplicate kid
        ('RR_APP_FRAME_TOKEN_KEYS', f'bad.kid:{b64u(new_key())}'),  # the kid is a token segment: no dots
    ],
)
def test_missing_template_or_key_refuses_start(name, value, isolation_env):
    """T3: an absent or malformed template or signing key stops startup and names the variable."""
    isolation_env.set(**{name: value})
    _refuses(name)


def test_every_listed_key_must_be_long_enough(isolation_env):
    """T3: rotation keys count too: the first signs, the rest verify, each at least 32 bytes."""
    isolation_env.set(RR_APP_FRAME_TOKEN_KEYS=f'k2:{b64u(new_key())},k1:{b64u(b"y" * 16)}')
    _refuses('RR_APP_FRAME_TOKEN_KEYS')


def test_several_keys_are_accepted_first_signs(isolation_env):
    """T3 control: ``kid:key,kid:key`` is valid and keeps the order (the first signs)."""
    isolation_env.set(RR_APP_FRAME_TOKEN_KEYS=f'k2:{b64u(new_key())},k1:{b64u(new_key())}')
    _validate()
    assert [kid for kid, _ in isolation_env.config().token_keys] == ['k2', 'k1']


# ---------------------------------------------------------------------------
# T4 runtime marker
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'runtime',
    [
        False,  # file absent
        'not json',
        '{"runtime": 2, "guest": "guest-test.js", "protoMin": 1, "protoMax": 1, "capabilitiesSha256": "x"}',
        '{"runtime": 1, "protoMin": 1, "protoMax": 1, "capabilitiesSha256": "x"}',  # no guest
        '[]',
    ],
)
def test_missing_runtime_marker_refuses_start(runtime, isolation_env):
    """T4: the guest runtime marker (PR2) must exist and be valid; the line gives the remedy."""
    isolation_env.rebuild_static(runtime=runtime)
    message = _refuses('runtime')
    assert 'RR_APP_ISOLATION=off' in message


def test_missing_guest_frame_refuses_start(isolation_env):
    """T4: the marker is present but ``frame.html`` is not: the frame cannot be served, so do not start."""
    isolation_env.rebuild_static(frame=False)
    _refuses('frame')


# ---------------------------------------------------------------------------
# T5 capabilities.json vs the marker
# ---------------------------------------------------------------------------


def test_capabilities_sha_mismatch_refuses_start(isolation_env):
    """T5: ``capabilities.json`` must hash to the marker's ``capabilitiesSha256``."""
    path = isolation_env.static / 'shell' / 'isolation' / 'capabilities.json'
    path.write_text(path.read_text() + '\n')  # one extra byte: another hash
    _refuses('capabilities')


def test_capabilities_file_missing_refuses_start(isolation_env):
    """T5: no data file, no start."""
    (isolation_env.static / 'shell' / 'isolation' / 'capabilities.json').unlink()
    _refuses('capabilities')


# ---------------------------------------------------------------------------
# T6 SaaS needs the account methods
# ---------------------------------------------------------------------------

_OVERRIDES = (
    'account_info_for',
    'is_first_party',
    'set_approved_capabilities',
    'approved_capabilities',
    'authorize_app_use',
)


def _stub_account(*, saas: bool, overrides=()):
    """An account class that inherits the base implementations except the named overrides."""
    from ai.account.base import AccountBase

    async def _impl(self, *args, **kwargs):
        return None

    namespace = {'capabilities': ('saas',) if saas else ('oss',)}
    namespace.update({name: _impl for name in overrides})
    cls = type(AccountBase)('StubAccount', (AccountBase,), namespace)
    cls.__abstractmethods__ = frozenset()
    return cls()


def test_the_base_account_has_the_required_isolation_methods():
    """T6 premise: the base class defines the OSS behavior of every isolation/eligibility method."""
    from ai.account.base import AccountBase

    for name in _OVERRIDES:
        need(AccountBase, name)


def test_saas_without_account_overrides_refuses_start(isolation_env):
    """T6: a SaaS account that still inherits the base methods stops startup, naming them."""
    message = _refuses('account_info_for', account=_stub_account(saas=True))
    assert 'is_first_party' in message and 'set_approved_capabilities' in message
    assert re.search(r'(?<!set_)approved_capabilities', message), message


@pytest.mark.parametrize('missing', _OVERRIDES)
def test_saas_missing_one_override_refuses_start(missing, isolation_env):
    """T6: each method is checked on its own."""
    others = tuple(n for n in _OVERRIDES if n != missing)
    _refuses(missing, account=_stub_account(saas=True, overrides=others))


def test_saas_with_all_overrides_starts(isolation_env):
    """T6 control."""
    _validate(account=_stub_account(saas=True, overrides=_OVERRIDES))


def test_oss_inheriting_the_base_starts(isolation_env):
    """T6 control: the base behaviour IS the OSS behaviour."""
    _validate(account=_stub_account(saas=False))


# ---------------------------------------------------------------------------
# T7 edge-header
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('secret', [None, '', 'x' * 31])
def test_edge_header_without_secret_refuses_start(secret, isolation_env):
    """T7: ``RR_APP_HOST_SOURCE=edge-header`` needs ``RR_EDGE_SECRET`` of at least 32 bytes."""
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET=secret)
    _refuses('RR_EDGE_SECRET')


def test_edge_header_with_a_long_secret_starts(isolation_env):
    """T7 control."""
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET='s' * 32)
    _validate()
    assert isolation_env.config().host_source == 'edge-header'


@pytest.mark.parametrize('source', ['forwarded', 'EDGE-HEADER', 'x-forwarded-host', ''])
def test_unknown_host_source_refuses_start(source, isolation_env):
    """T7: the host source is ``host`` or ``edge-header``."""
    isolation_env.set(RR_APP_HOST_SOURCE=source, RR_EDGE_SECRET='s' * 32)
    _refuses('RR_APP_HOST_SOURCE')


# ---------------------------------------------------------------------------
# T8 template and origin grammars (Appendix C)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'template',
    [
        'http://{label}.apps.example',  # plain http only on apps.localhost
        'https://apps.example',  # no label
        'https://{label}.apps.example/path',
        'https://{label}.apps.example:8443',  # https carries no port
        'https://{label}.Apps.Example',  # lowercase only
        'https://{label}',  # no domain
        'https://{label}.apps.example ',  # trailing space
        'https://{label}.apps.example\n',
        'ftp://{label}.apps.example',
        'http://{label}.apps.localhost',  # localhost needs a port
        'http://{label}.apps.localhost:99999x',
        'http://{label}.localhost:8080',  # exactly apps.localhost
        'https://x{label}.apps.example',  # the label is the whole first label
        'https://{label}.{label}.apps.example',
    ],
)
def test_invalid_template_refuses_start(template, isolation_env):
    """T8: the template grammar is ``https://{label}.<host>`` or ``http://{label}.apps.localhost:<port>``."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=template)
    _refuses('RR_APP_ORIGIN_TEMPLATE')


@pytest.mark.parametrize('template', ['https://{label}.apps.example', 'http://{label}.apps.localhost:8765'])
def test_valid_templates_start(template, isolation_env):
    """T8 control: both grammar shapes."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=template)
    _validate()


@pytest.mark.parametrize(
    'origins',
    [
        'https://app.example/path',
        '*',
        'app.example',  # no scheme
        'https://app.example;',
        "https://app.example 'unsafe-inline'",
        'javascript:',
        'https://',
        'https://app.example:65536',
        'https://app.example:99999',
        'https://app.example:0',
        'https://app.example:00000',
    ],
)
def test_invalid_shell_origins_refuse_start(origins, isolation_env):
    """T8: RR_SHELL_ORIGINS become ``frame-ancestors``; only plain origins are accepted."""
    isolation_env.set(RR_SHELL_ORIGINS=origins)
    _refuses('RR_SHELL_ORIGINS')


@pytest.mark.parametrize('origin', ['https://app.example:1', 'https://app.example:65535', 'http://localhost:5173'])
def test_shell_origin_ports_in_range_start(origin, isolation_env):
    isolation_env.set(RR_SHELL_ORIGINS=origin)
    _validate()


def test_no_shell_origin_at_all_refuses_start(isolation_env):
    """T8: neither RR_SHELL_ORIGINS nor RR_FRONTEND_ORIGIN: ``frame.html`` could be framed by nobody."""
    isolation_env.set(RR_SHELL_ORIGINS=None, RR_FRONTEND_ORIGIN=None)
    _refuses('RR_SHELL_ORIGINS')


@pytest.mark.parametrize('apps', ['bad id', 'a;b', 'acme.one,,acme.two;', '../x', 'a' * 129])
def test_invalid_optin_app_ids_refuse_start(apps, isolation_env):
    """T8: RR_APP_ISOLATION_APPS entries follow the app-id segment grammar."""
    isolation_env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS=apps)
    _refuses('RR_APP_ISOLATION_APPS')


# ---------------------------------------------------------------------------
# T8b the app domain is never same-site with the shell (G4 M2)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'template,origins',
    [
        ('https://{label}.app.example', 'https://app.example'),  # suffix == shell host
        ('https://{label}.apps.app.example', 'https://app.example'),  # suffix below the shell host
        ('https://{label}.example', 'https://app.example'),  # suffix above the shell host
        ('https://{label}.apps.example', 'https://other.example https://x.apps.example'),  # a shell inside the suffix
    ],
)
def test_template_same_site_with_a_shell_origin_refuses_start(template, origins, isolation_env):
    """T8b: app code on the app domain must not toss cookies onto a shell host (or the reverse)."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=template, RR_SHELL_ORIGINS=origins)
    _refuses('RR_APP_ORIGIN_TEMPLATE')


@pytest.mark.parametrize('app_url', ['https://apps.example', 'https://www.apps.example/', 'https://example'])
def test_template_same_site_with_rr_app_url_refuses_start(app_url, isolation_env):
    """T8b: the same for the public SaaS URL (RR_APP_URL)."""
    isolation_env.set(RR_APP_URL=app_url)
    _refuses('RR_APP_ORIGIN_TEMPLATE')


def test_separate_app_domain_starts(isolation_env):
    """T8b control: a separate domain is fine, and the local template may sit beside a localhost shell."""
    isolation_env.set(RR_APP_URL='https://app.example')
    _validate()
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=sup.LOCAL_TEMPLATE, RR_SHELL_ORIGINS='http://localhost:5565')
    _validate()


@pytest.mark.parametrize('header', ['', 'x real ip', 'x-real-ip:', 'a' * 65, 'X_Real_IP'])
def test_invalid_trusted_client_ip_header_refuses_start(header, isolation_env):
    """T8 (G4 S7): RR_TRUSTED_CLIENT_IP_HEADER, when set, is one header name."""
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER=header)
    _refuses('RR_TRUSTED_CLIENT_IP_HEADER')


def test_trusted_client_ip_header_is_optional(isolation_env):
    """T8 control: unset means the peer address; a header name is lowercased."""
    assert isolation_env.config().client_ip_header == ''
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='X-Real-IP')
    assert isolation_env.config().client_ip_header == 'x-real-ip'


# ---------------------------------------------------------------------------
# G4 L4 / L7: no secret in a repr, no silent fail-open
# ---------------------------------------------------------------------------


def test_config_repr_never_shows_a_key(isolation_env):
    """G4 L4: a logged or asserted config never prints the token keys or the edge secret."""
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET='edge-secret-' + 's' * 32)
    cfg = isolation_env.config()
    text = repr(cfg) + str(cfg)
    key_b64 = isolation_env.values['RR_APP_FRAME_TOKEN_KEYS'].split(':', 1)[1]
    assert key_b64 not in text and 'edge-secret-' not in text
    assert repr(cfg.token_keys[0][1])[2:20] not in text


def test_optin_with_no_listed_app_refuses_start(isolation_env):
    """G4 L7: ``optin`` that isolates nothing is a misconfiguration, not a quiet off."""
    isolation_env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS=None)
    _refuses('RR_APP_ISOLATION_APPS')
    isolation_env.set(RR_APP_ISOLATION_APPS='  ')
    _refuses('RR_APP_ISOLATION_APPS')


def test_empty_mode_is_off_and_says_so(isolation_env, monkeypatch):
    """G4 L7: a present-but-empty RR_APP_ISOLATION is off, and startup logs that it read it as off."""
    lines = []
    monkeypatch.setattr(_ao(), 'debug', lambda message: lines.append(str(message)), raising=False)
    isolation_env.set(RR_APP_ISOLATION='')
    _validate()
    assert any('RR_APP_ISOLATION' in line and 'off' in line for line in lines), lines


def test_startup_logs_the_effective_mode(isolation_env, monkeypatch):
    """G4 L7: a non-off start states the mode and the isolated set in one line."""
    lines = []
    monkeypatch.setattr(_ao(), 'debug', lambda message: lines.append(str(message)), raising=False)
    isolation_env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS='acme.one')
    _validate()
    assert any('optin' in line and 'acme.one' in line for line in lines), lines


# ---------------------------------------------------------------------------
# T8c registrable-domain approximation (G4 round 2, R2-M1)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'template,origins,app_url',
    [
        ('https://{label}.apps.rocketride.ai', 'https://app.rocketride.ai', None),  # siblings under rocketride.ai
        ('https://{label}.usercontent.example.co.uk', 'https://app.example.co.uk', None),  # co.uk: fail safe
        ('https://{label}.apps.rocketride.ai', 'https://app.other', 'https://saas.rocketride.ai'),  # RR_APP_URL sibling
    ],
)
def test_sibling_under_one_registrable_domain_refuses_start(template, origins, app_url, isolation_env):
    """T8c: equal last two DNS labels approximate one registrable domain: refused (fail safe for co.uk)."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=template, RR_SHELL_ORIGINS=origins, RR_APP_URL=app_url)
    message = _refuses('RR_APP_ORIGIN_TEMPLATE')
    assert 'RR_APP_DOMAIN_SAME_SITE_OK' in message


@pytest.mark.parametrize(
    'template,origins',
    [
        ('https://{label}.rocketride-apps.ai', 'https://app.rocketride.ai'),
        ('https://{label}.apps.example', 'https://app.other'),
    ],
)
def test_different_registrable_domains_start(template, origins, isolation_env):
    """T8c control."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=template, RR_SHELL_ORIGINS=origins)
    _validate()


def test_operator_override_for_a_multi_part_public_suffix(isolation_env, monkeypatch):
    """T8c: RR_APP_DOMAIN_SAME_SITE_OK=1 lets example-apps.co.uk sit beside example.co.uk, with a warning."""
    lines = []
    monkeypatch.setattr(_ao(), 'debug', lambda message: lines.append(str(message)), raising=False)
    isolation_env.set(
        RR_APP_ORIGIN_TEMPLATE='https://{label}.example-apps.co.uk',
        RR_SHELL_ORIGINS='https://app.example.co.uk',
        RR_APP_DOMAIN_SAME_SITE_OK='1',
    )
    _validate()
    assert any('RR_APP_DOMAIN_SAME_SITE_OK' in line and 'WARNING' in line for line in lines), lines
    for value in ('true', 'yes', '0', ''):
        isolation_env.set(RR_APP_DOMAIN_SAME_SITE_OK=value)
        _refuses('RR_APP_ORIGIN_TEMPLATE')


def test_override_never_allows_a_shell_inside_the_app_domain(isolation_env):
    """T8c: the override covers sibling domains only; equal, below or above stays refused."""
    isolation_env.set(
        RR_APP_ORIGIN_TEMPLATE='https://{label}.app.example.co.uk',
        RR_SHELL_ORIGINS='https://app.example.co.uk',
        RR_APP_DOMAIN_SAME_SITE_OK='1',
    )
    _refuses('RR_APP_ORIGIN_TEMPLATE')


# ---------------------------------------------------------------------------
# T8d the client address of the unauthenticated rate limits (G4 round 2 SHOULD-4 / R2-L1)
# ---------------------------------------------------------------------------


def _headers(*pairs):
    from starlette.datastructures import Headers

    return Headers(raw=[(k.lower().encode('latin-1'), v.encode('latin-1')) for k, v in pairs])


def _client_ip(cfg, peer, *pairs):
    return need(_ao(), 'client_ip')(_headers(*pairs), peer, cfg)


@pytest.mark.parametrize(
    'value,expected',
    [
        ('198.51.100.10:46532', '198.51.100.10'),  # CloudFront-Viewer-Address, IPv4
        ('2001:db8:3333:4444:5555:6666:7777:8888:46532', '2001:db8:3333:4444::/64'),  # IPv6 keys by /64
        ('[2001:db8::1]:443', '2001:db8::/64'),
        ('2001:db8::1', '2001:db8::/64'),
        ('2a01:db8::1:443', '2a01:db8::/64'),  # ambiguous unbracketed v6:port: the /64 makes the port moot
        ('203.0.113.7', '203.0.113.7'),
        ('1.1.1.1, 2.2.2.2', '2.2.2.2'),  # the last hop
        ('evil', 'peer-fallback'),
        ('999.1.1.1', 'peer-fallback'),
        ('1.1.1.1:99999', 'peer-fallback'),
        ('x' * 200, 'peer-fallback'),
        ('', 'peer-fallback'),
    ],
)
def test_client_ip_parses_the_trusted_header(value, expected, isolation_env):
    """T8d: ip, ip:port, [v6]:port and CloudFront's v6:port; anything invalid falls back to the peer."""
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='CloudFront-Viewer-Address')
    peer = '10.9.9.9'
    got = _client_ip(isolation_env.config(), peer, ('cloudfront-viewer-address', value))
    assert got == (peer if expected == 'peer-fallback' else expected)


def test_client_ip_reads_the_last_value_across_header_lines(isolation_env):
    """T8d: a client can prepend lines or entries; the edge's own entry is the last one of all lines."""
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='X-Forwarded-For')
    cfg = isolation_env.config()
    pairs = (('x-forwarded-for', '6.6.6.6, 7.7.7.7'), ('x-forwarded-for', '3.3.3.3'))
    assert _client_ip(cfg, '10.0.0.1', *pairs) == '3.3.3.3'


def test_client_ip_ignores_the_header_when_not_configured(isolation_env):
    """T8d: without RR_TRUSTED_CLIENT_IP_HEADER a client cannot choose its bucket."""
    assert _client_ip(isolation_env.config(), '10.0.0.1', ('x-forwarded-for', '3.3.3.3')) == '10.0.0.1'


def test_client_ip_honours_the_header_only_from_trusted_proxies(isolation_env):
    """T8d: with RR_TRUSTED_PROXY_CIDRS the header counts only when the peer is one of those proxies."""
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='X-Forwarded-For', RR_TRUSTED_PROXY_CIDRS='10.0.0.0/8, fd00::/8')
    cfg = isolation_env.config()
    assert _client_ip(cfg, '10.1.2.3', ('x-forwarded-for', '3.3.3.3')) == '3.3.3.3'
    assert _client_ip(cfg, 'fd00::5', ('x-forwarded-for', '3.3.3.3')) == '3.3.3.3'
    assert _client_ip(cfg, '192.168.1.1', ('x-forwarded-for', '3.3.3.3')) == '192.168.1.1'
    assert _client_ip(cfg, 'testclient', ('x-forwarded-for', '3.3.3.3')) == 'testclient'


@pytest.mark.parametrize('cidrs', ['10.0.0.0/33', 'not-a-net', '10.0.0.0/8;', ' , '])
def test_invalid_trusted_proxy_cidrs_refuse_start(cidrs, isolation_env):
    """T8d: RR_TRUSTED_PROXY_CIDRS is a list of networks."""
    isolation_env.set(RR_TRUSTED_PROXY_CIDRS=cidrs)
    _refuses('RR_TRUSTED_PROXY_CIDRS')


@pytest.mark.parametrize(
    'module', ['cryptography.hazmat.primitives.ciphers.aead', 'cryptography.hazmat.primitives.kdf.hkdf']
)
def test_missing_cryptography_refuses_start(module, isolation_env, monkeypatch):
    """T3 (G4 round 2 R2-L3): frame tokens need ``cryptography``; without it startup refuses, it does not fail per request."""
    import sys

    monkeypatch.setitem(sys.modules, module, None)  # import now raises ImportError
    _refuses('cryptography')


def test_cryptography_is_a_declared_engine_requirement():
    """T3 (R2-L3): the engine's own requirement file declares it, pinned like the nodes pin."""
    from pathlib import Path

    import ai

    requirements = (Path(ai.__file__).parent / 'requirements.txt').read_text(encoding='utf-8').splitlines()
    assert any(line.strip().startswith('cryptography>=') for line in requirements)


def test_ipv6_clients_share_a_bucket_per_64_whatever_the_port_or_address(isolation_env):
    """T8d (G4 round 3 R3-L1): rotating the low 64 bits or the source port never yields a new bucket."""
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='CloudFront-Viewer-Address')
    cfg = isolation_env.config()
    keys = {
        _client_ip(cfg, '10.0.0.1', ('cloudfront-viewer-address', value))
        for value in (
            '2a01:db8:1:2::1:443',
            '2a01:db8:1:2::1:8080',
            '2a01:db8:1:2::ffff:1234',
            '[2a01:db8:1:2:aaaa:bbbb:cccc:dddd]:1',
            '2a01:db8:1:2:aaaa:bbbb:cccc:dddd:46532',
        )
    }
    assert keys == {'2a01:db8:1:2::/64'}
    # IPv4 keeps one address per bucket, and an IPv6 peer is bucketed the same way
    assert _client_ip(cfg, '10.0.0.1', ('cloudfront-viewer-address', '198.51.100.10:1')) == '198.51.100.10'
    assert _client_ip(isolation_env.config(), '2a01:db8:9::5', ('x-other', '1.1.1.1')) == '2a01:db8:9::/64'


def test_trusted_header_without_proxy_cidrs_warns_at_startup(isolation_env, monkeypatch):
    """T8d (R3-L2): a header trusted from any peer is spoofable by whoever reaches the engine directly: say so."""
    lines = []
    monkeypatch.setattr(_ao(), 'debug', lambda message: lines.append(str(message)), raising=False)
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='CloudFront-Viewer-Address')
    _validate()
    assert any('WARNING' in line and 'RR_TRUSTED_PROXY_CIDRS' in line for line in lines), lines
    lines.clear()
    isolation_env.set(RR_TRUSTED_PROXY_CIDRS='10.0.0.0/8')
    _validate()
    assert not any('RR_TRUSTED_PROXY_CIDRS' in line and 'WARNING' in line for line in lines), lines


def test_ipv4_mapped_and_nat64_addresses_bucket_as_their_ipv4(isolation_env):
    """T8d (G4 round 4 R4-L1): a dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d; those (and NAT64
    64:ff9b::/96) must bucket per IPv4 address, not all together in ::/64.
    """
    cfg = isolation_env.config()
    first = _client_ip(cfg, '::ffff:203.0.113.7')
    second = _client_ip(cfg, '::ffff:198.51.100.9')
    assert first == '203.0.113.7' and second == '198.51.100.9'
    assert first == _client_ip(cfg, '203.0.113.7') and second == _client_ip(cfg, '198.51.100.9')
    assert _client_ip(cfg, '64:ff9b::cb00:7107') == '203.0.113.7'
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='CloudFront-Viewer-Address')
    cfg = isolation_env.config()
    assert _client_ip(cfg, '10.0.0.1', ('cloudfront-viewer-address', '[::ffff:203.0.113.7]:443')) == '203.0.113.7'


@pytest.mark.parametrize('value', ['fe80::1%eth0', 'fe80::1%25eth0', '[fe80::1%eth0]:443'])
def test_scope_id_values_never_raise(value, isolation_env):
    """T8d (R4-L1): a scope-id form is a bucket or the peer fallback, never an exception (a 500 on an open route)."""
    cfg = isolation_env.config()
    assert isinstance(_client_ip(cfg, value), str)
    isolation_env.set(RR_TRUSTED_CLIENT_IP_HEADER='CloudFront-Viewer-Address')
    assert _client_ip(isolation_env.config(), '10.0.0.1', ('cloudfront-viewer-address', value)) in (
        '10.0.0.1',
        'fe80::/64',
    )


# ===========================================================================
# PR2b: T106 RR_APP_ALIAS_KEY, T104 startup (chunks), the runtime marker's chunk list
# ===========================================================================

import json  # noqa: E402


@pytest.mark.parametrize(
    'value',
    [
        None,
        '',
        '   ',
        b64u(b'x' * 31),  # 31 bytes: too short
        b64u(b'x' * 16),
        '***not base64***',
        'k1:' + b64u(new_key()),  # a kid:key pair is the frame-token format, not this one
    ],
    ids=['missing', 'empty', 'blank', '31-bytes', '16-bytes', 'not-base64', 'kid-form'],
)
def test_t106_a_missing_empty_or_short_alias_key_refuses_start(value, isolation_env):
    """T106: ``RR_APP_ALIAS_KEY`` is required when not ``off``: base64url, at least 32 bytes, named in the one-line refusal."""
    isolation_env.set(RR_APP_ALIAS_KEY=value)
    _refuses('RR_APP_ALIAS_KEY')


def test_t106_a_valid_alias_key_starts_and_is_never_printed(isolation_env):
    """T106: 32 bytes is enough; it reaches the config (``alias_key``) and not its repr."""
    key = new_key()
    isolation_env.set(RR_APP_ALIAS_KEY=b64u(key))
    _validate()
    cfg = isolation_env.config()
    assert cfg.alias_key == key
    assert b64u(key) not in repr(cfg) + str(cfg)
    assert repr(key)[2:20] not in repr(cfg)


@pytest.mark.parametrize('position', ['first', 'second'])
def test_g4_an_alias_key_equal_to_a_frame_token_key_refuses_start(position, isolation_env):
    """G4 (security LOW): the alias key must not be any of the frame-token keys (one secret, two purposes)."""
    shared, other = new_key(), new_key()
    keys = (
        [key_entry('k1', shared), key_entry('k2', other)]
        if position == 'first'
        else [key_entry('k1', other), key_entry('k2', shared)]
    )
    isolation_env.set(RR_APP_FRAME_TOKEN_KEYS=','.join(keys), RR_APP_ALIAS_KEY=b64u(shared))
    _refuses('RR_APP_ALIAS_KEY')


@pytest.mark.parametrize('value', [None, '', 'short', '***'], ids=['missing', 'empty', 'short', 'garbage'])
def test_t106_under_off_the_alias_key_is_ignored(value, monkeypatch, tmp_path, clean_caches):
    """T106: under ``off`` nothing else is read, so a bad or absent alias key never stops startup (the golden stays)."""
    sup.apply_env(monkeypatch, {})
    if value is not None:
        monkeypatch.setenv('RR_APP_ALIAS_KEY', value)
    cfg = need(_ao(), 'load_isolation_config')(
        {'RR_APP_ISOLATION': 'off', **({'RR_APP_ALIAS_KEY': value} if value is not None else {})}
    )
    assert cfg.mode == 'off'
    assert not getattr(cfg, 'alias_key', b'')
    _validate()  # a no-op under off


# ---- the marker's chunk list ------------------------------------------------


def _marker(isolation_env, **changes):
    """Rewrite ``runtime.json`` with ``changes`` applied over the valid fixture (a ``None`` value removes the key)."""
    path = isolation_env.static / 'shell-guest' / 'runtime.json'
    marker = json.loads(path.read_text())
    for key, value in changes.items():
        if value is None:
            marker.pop(key, None)
        else:
            marker[key] = value
    path.write_text(json.dumps(marker))
    return marker


def test_t104_a_complete_marker_starts(isolation_env):
    """T104 control: the fixture's marker (6 chunks, publicPath ``/_rr/``) validates and is what ``read_runtime_marker`` returns."""
    _validate()
    marker = need(_ao(), 'read_runtime_marker')()
    assert marker['publicPath'] == '/_rr/'
    assert marker['chunks'] == sorted(sup.GUEST_CHUNK_BODIES)


@pytest.mark.parametrize(
    'changes',
    [
        {'chunks': None},  # the key is required
        {'chunks': 'guest-a.js'},
        {'chunks': {'a': 'guest-a.js'}},
        {'chunks': [5]},
        {'chunks': ['evil.js']},
        {'chunks': ['guest-a.exe']},
        {'chunks': ['Guest-a.js']},
        {'chunks': ['guest-a/b.js']},
        {'chunks': ['guest-../x.js']},
        {'chunks': ['guest-a b.js']},
        {'chunks': ['guest-.js']},
        {'chunks': ['guest-a.js', 'guest-a.js']},  # duplicates
        {'chunks': ['guest-test.js']},  # equal to ``guest``
        {'chunks': [f'guest-c{i}.js' for i in range(513)]},  # more than 512
        {'publicPath': None},
        {'publicPath': '/_rr'},
        {'publicPath': '/other/'},
        {'publicPath': 'https://cdn.example/_rr/'},
        {'publicPath': 7},
    ],
    ids=lambda c: (
        next(iter(c)) + '=' + (str(next(iter(c.values())))[:24] if next(iter(c.values())) is not None else 'absent')
    ),
)
def test_t104_an_invalid_chunk_list_or_public_path_refuses_start(changes, isolation_env):
    """T104: ``chunks`` is a list of at most 512 unique ``_GUEST_ASSET`` names, none equal to ``guest``; ``publicPath`` is ``/_rr/``."""
    _marker(isolation_env, **changes)
    message = _refuses('runtime')
    assert 'RR_APP_ISOLATION=off' in message


def test_t104_exactly_512_chunks_and_an_empty_list_are_valid(isolation_env):
    """T104: the bounds are inclusive; the chunk files must exist, so write them."""
    guest = isolation_env.static / 'shell-guest'
    names = [f'guest-c{i}.js' for i in range(512)]
    for name in names:
        (guest / name).write_text('x')
    _marker(isolation_env, chunks=names)
    _validate()
    _marker(isolation_env, chunks=[])
    _validate()


def test_t104_startup_check_b_fails_when_a_listed_chunk_is_missing(isolation_env):
    """T104: check (b) covers every chunk file, and names the first missing one."""
    missing = sorted(sup.GUEST_CHUNK_BODIES)[2]
    (isolation_env.static / 'shell-guest' / missing).unlink()
    message = _refuses(missing)
    assert 'RR_APP_ISOLATION=off' in message


def test_t104_guest_assets_is_the_guest_plus_the_chunks(isolation_env):
    """T104: the allowlist the route serves from (cached per marker mtime)."""
    assets = need(_ao(), 'guest_assets')()
    assert set(assets) == {'guest-test.js', *sup.GUEST_CHUNK_BODIES}
