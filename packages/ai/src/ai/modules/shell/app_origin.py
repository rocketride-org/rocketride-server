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

"""
App-origin isolation: the server's one place for the #1022 decisions.

Third-party app code runs in a sandboxed frame on its own origin
(``RR_APP_ORIGIN_TEMPLATE`` with ``{label}`` = ``label_of(appId)``), never in
the shell realm. This module holds what the server decides about that:

  - the configuration (``RR_APP_ISOLATION`` and friends) and the startup
    checks that refuse a half-built setup;
  - the app label (also the app's namespace key);
  - the data files the guest runtime ships (``runtime.json``) and the
    capability table (``capabilities.json``).

Everything is read from ``os.environ`` at call time. With
``RR_APP_ISOLATION=off`` (the default) nothing else is read, checked or
added anywhere.
"""

import base64
import binascii
import hashlib
import hmac
import importlib
import ipaddress
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from rocketlib import debug
from typing import Any, List, Mapping, NamedTuple, Optional, Tuple

MODES = ('off', 'optin', 'enforce')
HOST_SOURCES = ('host', 'edge-header')

# The app-id segment grammar of the /apps routes (shell._APP_ID_SEG), at most
# 128 characters.
_APP_ID = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}')

# Appendix C: https://{label}.<host>, or plain http only on apps.localhost
# with an explicit port.
_TEMPLATE_HTTPS = re.compile(r'https://\{label\}\.([a-z0-9-]+(?:\.[a-z0-9-]+)*)')
_TEMPLATE_LOCAL = re.compile(r'http://\{label\}\.(apps\.localhost):([0-9]{1,5})')

# A frame-ancestors source: a plain http(s) origin, nothing else.
_ORIGIN = re.compile(r'https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?')

# A key id is a token segment, so it never contains the separator.
_KID = re.compile(r'[A-Za-z0-9_-]{1,32}')
_B64URL = re.compile(r'[A-Za-z0-9_-]+')
_MIN_SECRET_BYTES = 32

# runtime.json's guest bundle name: served at /_rr/<guest>.
_GUEST_NAME = re.compile(r'guest-[A-Za-z0-9_.-]+\.js')
_SHA256_HEX = re.compile(r'[0-9a-f]{64}')

_HEADER_NAME = re.compile(r'[A-Za-z0-9-]{1,64}')

_REMEDY = 'set RR_APP_ISOLATION=off'


@dataclass(frozen=True)
class IsolationConfig:
    """
    The parsed isolation configuration.

    Attributes:
        mode: ``off``, ``optin`` or ``enforce``.
        apps: App ids isolated under ``optin``.
        origin_template: ``RR_APP_ORIGIN_TEMPLATE`` verbatim.
        token_keys: ``(kid, key)`` pairs; the first signs, all verify.
        shell_origins: The shell origins allowed to frame ``frame.html``.
        host_source: ``host`` or ``edge-header``.
        edge_secret: ``RR_EDGE_SECRET`` (``edge-header`` only).
        app_suffix: The host name after ``{label}.``.
        app_port: The template's port, or None (https).
        client_ip_header: ``RR_TRUSTED_CLIENT_IP_HEADER`` lowercased, or ''
            (rate limits then key on the peer address).
        trusted_proxies: ``RR_TRUSTED_PROXY_CIDRS`` as networks; when set, the
            client-IP header counts only from a peer inside one of them.
        same_site_asserted: Shell hosts sharing the app suffix's last two
            labels that ``RR_APP_DOMAIN_SAME_SITE_OK=1`` let through.
    """

    mode: str = 'off'
    apps: frozenset = frozenset()
    origin_template: str = ''
    token_keys: Tuple[Tuple[str, bytes], ...] = field(default=(), repr=False)
    shell_origins: Tuple[str, ...] = ()
    host_source: str = 'host'
    edge_secret: str = field(default='', repr=False)
    app_suffix: str = ''
    app_port: Optional[int] = None
    client_ip_header: str = ''
    trusted_proxies: Tuple[Any, ...] = ()
    same_site_asserted: Tuple[str, ...] = ()

    def origin_of(self, app_id: str) -> str:
        """The app origin of one app id under the template."""
        return self.origin_template.replace('{label}', label_of(app_id))

    def frame_src_wildcard(self) -> str:
        """The template with ``{label}`` as ``*``: every app origin, as one CSP source."""
        return self.origin_template.replace('{label}', '*')


def _refuse(message: str) -> RuntimeError:
    """A startup refusal: one line, naming the check."""
    return RuntimeError(' '.join(message.split()))


def _parse_keys(value: str) -> Tuple[Tuple[str, bytes], ...]:
    """Parse ``kid:b64url,...``; raises a one-line RuntimeError naming the variable."""
    keys = []
    seen = set()
    for item in value.split(','):
        kid, sep, encoded = item.strip().partition(':')
        if not sep or not _KID.fullmatch(kid) or not _B64URL.fullmatch(encoded):
            raise _refuse('RR_APP_FRAME_TOKEN_KEYS: each entry is kid:base64url (kid of [A-Za-z0-9_-], no dots)')
        if kid in seen:
            raise _refuse(f'RR_APP_FRAME_TOKEN_KEYS: duplicate kid {kid!r}')
        try:
            key = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
        except (binascii.Error, ValueError):
            raise _refuse(f'RR_APP_FRAME_TOKEN_KEYS: key {kid!r} is not base64url') from None
        if len(key) < _MIN_SECRET_BYTES:
            raise _refuse(f'RR_APP_FRAME_TOKEN_KEYS: key {kid!r} is shorter than {_MIN_SECRET_BYTES} bytes')
        seen.add(kid)
        keys.append((kid, key))
    return tuple(keys)


def load_isolation_config(env: Mapping[str, str]) -> IsolationConfig:
    """
    Parse the isolation variables of ``env`` (design section 2, Appendix C).

    Args:
        env: The environment (``os.environ`` or a plain dict).

    Returns:
        The configuration. With the mode ``off`` (unset or empty means off)
        no other variable is read.

    Raises:
        RuntimeError: One line naming the invalid variable.
    """
    mode = env.get('RR_APP_ISOLATION') or 'off'
    if mode not in MODES:
        raise _refuse(f'RR_APP_ISOLATION must be one of off, optin, enforce (got {mode!r})')
    if mode == 'off':
        return IsolationConfig()

    apps = set()
    apps_value = (env.get('RR_APP_ISOLATION_APPS') or '').strip()
    for item in apps_value.split(',') if apps_value else ():
        if not _APP_ID.fullmatch(item.strip()):
            raise _refuse(f'RR_APP_ISOLATION_APPS: {item.strip()!r} is not an app id')
        apps.add(item.strip())
    if mode == 'optin' and not apps:
        raise _refuse('RR_APP_ISOLATION_APPS must list at least one app id with RR_APP_ISOLATION=optin')

    template = env.get('RR_APP_ORIGIN_TEMPLATE') or ''
    https = _TEMPLATE_HTTPS.fullmatch(template)
    local = _TEMPLATE_LOCAL.fullmatch(template)
    if https:
        suffix, port = https.group(1), None
    elif local and 1 <= int(local.group(2)) <= 65535:
        suffix, port = local.group(1), int(local.group(2))
    else:
        raise _refuse(
            'RR_APP_ORIGIN_TEMPLATE must be https://{label}.<host> or http://{label}.apps.localhost:<port>'
            f' (got {template!r})'
        )

    keys_value = env.get('RR_APP_FRAME_TOKEN_KEYS') or ''
    if not keys_value.strip():
        raise _refuse('RR_APP_FRAME_TOKEN_KEYS is required (kid:base64url, at least 32 bytes)')
    token_keys = _parse_keys(keys_value)

    origins_value = env.get('RR_SHELL_ORIGINS') or env.get('RR_FRONTEND_ORIGIN') or ''
    shell_origins = []
    for token in re.split(r'[\s,]+', origins_value.strip()):
        if not token:
            continue
        origin = token.lower().rstrip('/')
        if not _ORIGIN.fullmatch(origin):
            raise _refuse(f'RR_SHELL_ORIGINS: {token!r} is not an http(s) origin')
        if origin not in shell_origins:
            shell_origins.append(origin)
    if not shell_origins:
        raise _refuse('RR_SHELL_ORIGINS (or RR_FRONTEND_ORIGIN) must name the shell origin')

    # The app domain must be a separate site from the shell: a suffix equal to,
    # below or above a shell host (or RR_APP_URL's) lets app code toss cookies
    # onto the shell (or the reverse). The local template may sit beside a
    # localhost shell (development only: apps.localhost is plain http).
    same_site_ok = env.get('RR_APP_DOMAIN_SAME_SITE_OK') == '1'
    asserted = []
    for host in _shell_hosts(env, shell_origins):
        if local and host == 'localhost':
            continue
        if _same_site(suffix, host):
            raise _refuse(
                f'RR_APP_ORIGIN_TEMPLATE: the app domain {suffix!r} is same-site with the shell host {host!r};'
                ' use a separate registrable domain'
            )
        # Without the public suffix list, equal last two labels stand for one
        # registrable domain (fail safe: under co.uk every pair matches). The
        # operator may assert otherwise for a multi-part public suffix only.
        if _last_two(suffix) == _last_two(host):
            if not same_site_ok:
                raise _refuse(
                    f'RR_APP_ORIGIN_TEMPLATE: the app domain {suffix!r} and the shell host {host!r} share'
                    f' {_last_two(host)!r} (taken as one registrable domain); use a separate domain, or set'
                    ' RR_APP_DOMAIN_SAME_SITE_OK=1 only if they are different registrable domains under a'
                    ' multi-part public suffix'
                )
            asserted.append(host)

    host_source = env.get('RR_APP_HOST_SOURCE')
    host_source = 'host' if host_source is None else host_source
    if host_source not in HOST_SOURCES:
        raise _refuse(f'RR_APP_HOST_SOURCE must be host or edge-header (got {host_source!r})')
    edge_secret = ''
    if host_source == 'edge-header':
        edge_secret = env.get('RR_EDGE_SECRET') or ''
        if len(edge_secret.encode('utf-8')) < _MIN_SECRET_BYTES:
            raise _refuse(
                f'RR_EDGE_SECRET must be at least {_MIN_SECRET_BYTES} bytes with RR_APP_HOST_SOURCE=edge-header'
            )

    # The header a trusted edge sets to the real client address (rate limits
    # of the unauthenticated routes); unset means the peer address.
    client_ip_header = env.get('RR_TRUSTED_CLIENT_IP_HEADER')
    if client_ip_header is not None and not _HEADER_NAME.fullmatch(client_ip_header):
        raise _refuse(f'RR_TRUSTED_CLIENT_IP_HEADER must be one header name (got {client_ip_header!r})')
    client_ip_header = (client_ip_header or '').lower()
    trusted_proxies = []
    cidrs = env.get('RR_TRUSTED_PROXY_CIDRS')
    if cidrs is not None:
        items = [item for item in re.split(r'[\s,]+', cidrs.strip()) if item]
        try:
            trusted_proxies = [ipaddress.ip_network(item, strict=False) for item in items]
        except ValueError:
            trusted_proxies = []
        if not trusted_proxies:
            raise _refuse(f'RR_TRUSTED_PROXY_CIDRS must be a list of IP networks (got {cidrs!r})')

    return IsolationConfig(
        mode=mode,
        apps=frozenset(apps),
        origin_template=template,
        token_keys=token_keys,
        shell_origins=tuple(shell_origins),
        host_source=host_source,
        edge_secret=edge_secret,
        app_suffix=suffix,
        app_port=port,
        client_ip_header=client_ip_header,
        trusted_proxies=tuple(trusted_proxies),
        same_site_asserted=tuple(asserted),
    )


def _same_site(a: str, b: str) -> bool:
    """Whether two host names are equal or one is below the other (cookies can cross between them)."""
    return a == b or a.endswith('.' + b) or b.endswith('.' + a)


def _last_two(host: str) -> str:
    """The last two DNS labels of a host name (a registrable-domain approximation)."""
    return '.'.join(host.split('.')[-2:])


def _shell_hosts(env: Mapping[str, str], shell_origins: Optional[Tuple[str, ...]] = None) -> List[str]:
    """
    The host names the shell is served from: the shell origins and ``RR_APP_URL``.

    ``shell_origins`` are the validated origins; without them the raw
    ``RR_SHELL_ORIGINS`` (or ``RR_FRONTEND_ORIGIN``) is read leniently, so the
    answer is available in every mode.
    """
    if shell_origins is None:
        raw = env.get('RR_SHELL_ORIGINS') or env.get('RR_FRONTEND_ORIGIN') or ''
        shell_origins = tuple(t for t in re.split(r'[\s,]+', raw.strip()) if t)
    hosts = []
    for value in (*shell_origins, env.get('RR_APP_URL') or ''):
        try:
            host = (urlsplit(value.strip().lower()).hostname or '').rstrip('.')
        except ValueError:
            host = ''
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def current_config() -> IsolationConfig:
    """The configuration of the process environment, read now."""
    return load_isolation_config(os.environ)


# A canonical app id: dot-separated non-empty segments of [A-Za-z0-9_-], each
# starting with a letter, digit or underscore, at most 128 characters. Other
# spellings that pass the route grammar (a trailing dot, an empty segment)
# can name the same store directory on some backends (a Windows file store
# drops a trailing dot), so they are refused while isolation is on.
_CANONICAL_APP_ID = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*')


def is_canonical_app_id(app_id: Any) -> bool:
    """Whether ``app_id`` is in canonical form (see ``_CANONICAL_APP_ID``)."""
    return isinstance(app_id, str) and len(app_id) <= 128 and bool(_CANONICAL_APP_ID.fullmatch(app_id))


def label_of(app_id: str) -> str:
    """
    The app's host label and namespace key.

    ``a`` followed by the first 24 characters of the lowercase, unpadded
    base32 of ``sha256(app_id)``: 25 characters of ``[a-z2-7]``, a valid DNS
    label, and distinct for look-alike ids (``acme.x_foo`` vs ``acme_x.foo``).
    """
    digest = hashlib.sha256(app_id.encode('utf-8')).digest()
    return 'a' + base64.b32encode(digest).decode('ascii').rstrip('=').lower()[:24]


# =============================================================================
# DATA FILES — the guest runtime marker and the capability table
# =============================================================================


def _static_paths() -> Tuple[Path, Path]:
    """``(<static>/shell-guest, <static>/shell/isolation/capabilities.json)`` for the current shell root."""
    from . import shell

    shell_root = Path(shell._shell_root)
    return shell_root.parent / 'shell-guest', shell_root / 'isolation' / 'capabilities.json'


def guest_dir() -> Path:
    """``<static>/shell-guest``: ``runtime.json``, ``frame.html`` and the guest bundle."""
    return _static_paths()[0]


def read_runtime_marker() -> dict:
    """
    The guest runtime marker ``<static>/shell-guest/runtime.json`` (design section 9).

    Raises:
        RuntimeError: One line naming the problem and the remedy.
    """
    path = guest_dir() / 'runtime.json'
    try:
        marker = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise _refuse(f'isolation runtime missing ({path}): {_REMEDY} or ship the guest runtime') from None
    except (OSError, ValueError):
        raise _refuse(f'isolation runtime marker {path} is not valid JSON: {_REMEDY}') from None
    valid = (
        isinstance(marker, dict)
        and marker.get('runtime') == 1
        and isinstance(marker.get('guest'), str)
        and _GUEST_NAME.fullmatch(marker['guest'])
        and all(type(marker.get(k)) is int and marker[k] >= 1 for k in ('protoMin', 'protoMax'))
        and marker['protoMin'] <= marker['protoMax']
        and isinstance(marker.get('capabilitiesSha256'), str)
        and _SHA256_HEX.fullmatch(marker['capabilitiesSha256'])
    )
    if not valid:
        raise _refuse(f'isolation runtime marker {path} is not a runtime 1 marker: {_REMEDY}')
    return marker


def read_capabilities() -> Optional[dict]:
    """The capability table ``<static>/shell/isolation/capabilities.json``, or None when absent or invalid."""
    try:
        data = json.loads(_static_paths()[1].read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('v') != 1 or not isinstance(data.get('rows'), list):
        return None
    return data


def known_capabilities() -> Optional[frozenset]:
    """The capability names of the table, or None when the table is unavailable."""
    data = read_capabilities()
    if data is None:
        return None
    return frozenset(row['cap'] for row in data['rows'] if isinstance(row, dict) and isinstance(row.get('cap'), str))


# =============================================================================
# STARTUP CHECKS
# =============================================================================

# Account methods a SaaS edition must provide itself (check d): the base
# versions are the OSS behaviour.
# What frame tokens import (AES-256-GCM and HKDF), checked at startup.
_TOKEN_CRYPTO_MODULES = ('cryptography.hazmat.primitives.ciphers.aead', 'cryptography.hazmat.primitives.kdf.hkdf')

_SAAS_ACCOUNT_METHODS = ('account_info_for', 'is_first_party', 'set_approved_capabilities', 'approved_capabilities')


def validate_isolation_config(account: Any = None) -> None:
    """
    Refuse to start a half-built isolation setup (design section 2, checks a-d).

    Runs nothing under ``off``. Otherwise: (a) the variables are valid; (b) the
    guest runtime marker and ``frame.html`` are present; (c)
    ``capabilities.json`` hashes to the marker's ``capabilitiesSha256``; (d) a
    SaaS account class overrides the account methods isolation relies on.
    Logs the effective mode once (and an empty ``RR_APP_ISOLATION`` read as off).

    Args:
        account: The account to check (default: the loaded singleton).

    Raises:
        RuntimeError: One line naming the failed check and the remedy.
    """
    config = current_config()  # (a)
    if config.mode == 'off':
        if os.environ.get('RR_APP_ISOLATION') == '':
            debug('[app isolation] RR_APP_ISOLATION is set but empty: read as off')
        return
    for module in _TOKEN_CRYPTO_MODULES:  # (a) frame tokens cannot be sealed without it
        try:
            importlib.import_module(module)
        except ImportError:
            raise _refuse(
                f'isolation needs the cryptography package ({module}) for frame tokens: install it or {_REMEDY}'
            ) from None

    marker = read_runtime_marker()  # (b)
    guest = guest_dir()
    if not (guest / 'frame.html').is_file():
        raise _refuse(f'isolation runtime incomplete: {guest / "frame.html"} is missing: {_REMEDY}')
    if not (guest / marker['guest']).is_file():
        raise _refuse(f'isolation runtime incomplete: guest bundle {guest / marker["guest"]} is missing: {_REMEDY}')

    caps_path = _static_paths()[1]  # (c)
    try:
        digest = hashlib.sha256(caps_path.read_bytes()).hexdigest()
    except OSError:
        raise _refuse(f'isolation capabilities.json missing ({caps_path}): {_REMEDY} or rebuild the shell') from None
    if digest != marker['capabilitiesSha256'] or read_capabilities() is None:
        raise _refuse(
            f'isolation capabilities.json ({caps_path}) does not match runtime.json capabilitiesSha256:'
            ' rebuild the shell and the guest runtime together'
        )

    if account is None:  # (d)
        from ai.account import account
    if 'saas' in tuple(getattr(account, 'capabilities', ()) or ()):
        from ai.account.base import AccountBase

        inherited = [
            name for name in _SAAS_ACCOUNT_METHODS if getattr(type(account), name, None) is getattr(AccountBase, name)
        ]
        if inherited:
            raise _refuse(
                f'isolation needs the SaaS account to implement {", ".join(inherited)}: {_REMEDY} until it does'
            )

    if config.same_site_asserted:
        debug(
            f'[app isolation] WARNING: RR_APP_DOMAIN_SAME_SITE_OK=1: treating {config.app_suffix!r} and'
            f' {", ".join(config.same_site_asserted)} as different registrable domains (operator assertion;'
            ' app code can toss cookies onto the shell if it is wrong)'
        )
    if config.client_ip_header and not config.trusted_proxies:
        debug(
            f'[app isolation] WARNING: RR_TRUSTED_CLIENT_IP_HEADER={config.client_ip_header} is trusted from any peer:'
            ' set RR_TRUSTED_PROXY_CIDRS to the networks that connect to the engine directly, or anyone who can'
            ' reach it can choose their rate-limit bucket'
        )
    isolated = 'every third-party app' if config.mode == 'enforce' else ', '.join(sorted(config.apps))
    debug(f'[app isolation] mode {config.mode}: isolating {isolated} on {config.origin_template}')


# =============================================================================
# FRAME TOKENS — one app version, one user, 15 minutes (design section 7)
# =============================================================================
# Layout: v1.<kid>.<b64url(nonce)>.<b64url(AES-256-GCM(claims))>, additional
# data "v1.<kid>", claims {a: appId, v: version, u: userId, o: orgId, iat,
# exp}. The AES key is HKDF-SHA256 of the configured key (info below), so the
# configured key is never used directly. App code reads its own token from the
# URL: the claims are sealed so it cannot learn the user or org id (G4 M3) nor
# change anything. A token only ever grants GETs of ONE version's dist, on
# that app's own host, until it expires; the entitlement is re-checked on
# every request on top of it.

FRAME_TOKEN_TTL = 900
_CLAIM_KEYS = frozenset({'a', 'v', 'u', 'o', 'iat', 'exp'})
_TOKEN_KEY_INFO = b'rocketride/app-frame-token/aes-256-gcm/v1'
_NONCE_BYTES = 12
_TAG_BYTES = 16


class FrameTokenError(ValueError):
    """A frame token that does not verify. Every cause raises the same error."""


def _b64u(data: bytes) -> str:
    """URL-safe base64 without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _unb64u(text: str) -> bytes:
    """Strict inverse of ``_b64u``; raises FrameTokenError on anything else."""
    if not _B64URL.fullmatch(text) or len(text) % 4 == 1:
        raise FrameTokenError('malformed token')
    try:
        return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise FrameTokenError('malformed token') from None


def _aead(key: bytes):
    """The AES-256-GCM cipher of one configured key (HKDF-SHA256, a label of its own)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_TOKEN_KEY_INFO).derive(key))


def _mint(app_id: str, version: int, user_id: str, org_id: str, config: IsolationConfig) -> Tuple[str, dict]:
    """``(token, claims)`` sealed under the first configured key."""
    if not config.token_keys:
        raise RuntimeError('no frame token key is configured (RR_APP_FRAME_TOKEN_KEYS)')
    kid, key = config.token_keys[0]
    iat = int(time.time())
    claims = {'a': app_id, 'v': version, 'u': user_id, 'o': org_id, 'iat': iat, 'exp': iat + FRAME_TOKEN_TTL}
    nonce = os.urandom(_NONCE_BYTES)
    sealed = _aead(key).encrypt(nonce, json.dumps(claims, separators=(',', ':')).encode('utf-8'), f'v1.{kid}'.encode())
    return f'v1.{kid}.{_b64u(nonce)}.{_b64u(sealed)}', claims


def mint_frame_token(
    app_id: str, version: int, user_id: str, org_id: str, *, config: Optional[IsolationConfig] = None
) -> str:
    """
    Seal a frame token for one app version and one user, valid for 15 minutes.

    Args:
        app_id: The app the token opens.
        version: The registry version it opens.
        user_id: The user the entitlement is re-checked for.
        org_id: The org the entitlement is re-checked in.
        config: The configuration (default: the environment's); the FIRST key seals.

    Returns:
        The token, URL-safe (it is a path segment of ``/_t/<token>/v<N>/``).
    """
    return _mint(app_id, version, user_id, org_id, config or current_config())[0]


def verify_frame_token(token: str, host_label: str, *, config: Optional[IsolationConfig] = None) -> dict:
    """
    Verify a frame token for the app host it arrived on.

    Checks the layout, the key id (any configured key opens), the AEAD seal
    (which authenticates the key id too), the exact claim set and types, the
    expiry and that ``host_label`` is ``label_of(claims.a)``.

    Args:
        token: The token from the ``/_t/<token>/`` path.
        host_label: The label of the app host the request arrived on.
        config: The configuration (default: the environment's).

    Returns:
        The claims.

    Raises:
        FrameTokenError: The token does not open anything on this host.
    """
    config = config or current_config()
    parts = token.split('.') if isinstance(token, str) else []
    if len(parts) != 4 or parts[0] != 'v1':
        raise FrameTokenError('malformed token')
    _, kid, nonce_text, sealed_text = parts
    key = dict(config.token_keys).get(kid)
    if key is None:
        raise FrameTokenError('unknown key')
    nonce, sealed = _unb64u(nonce_text), _unb64u(sealed_text)
    if len(nonce) != _NONCE_BYTES or len(sealed) <= _TAG_BYTES:
        raise FrameTokenError('malformed token')
    from cryptography.exceptions import InvalidTag

    try:
        claims = json.loads(_aead(key).decrypt(nonce, sealed, f'v1.{kid}'.encode()))
    except (InvalidTag, ValueError):
        raise FrameTokenError('bad seal') from None
    if not isinstance(claims, dict) or set(claims) != _CLAIM_KEYS:
        raise FrameTokenError('malformed claims')
    ints = [claims['v'], claims['iat'], claims['exp']]
    if not all(type(value) is int for value in ints) or not all(isinstance(claims[k], str) for k in 'auo'):
        raise FrameTokenError('malformed claims')
    if claims['v'] < 1 or not 0 < claims['exp'] - claims['iat'] <= FRAME_TOKEN_TTL:
        raise FrameTokenError('malformed claims')
    if time.time() >= claims['exp']:
        raise FrameTokenError('expired')
    if not hmac.compare_digest(label_of(claims['a']).encode('utf-8'), str(host_label).encode('utf-8')):
        raise FrameTokenError('wrong host')
    return claims


# =============================================================================
# ENTITLEMENT — re-checked behind every token (design section 7)
# =============================================================================
# Verdicts are cached with a HARD 60 s expiry (never slid by use), so a valid
# token of a user who lost access stops serving within a minute however hot it
# is; ``invalidate_app_serving`` drops an app's entries at once. Every cache of
# this module is a module-level dict whose entries carry ``appId`` and
# ``expiry``.

ENTITLEMENT_TTL = 60.0
_CACHE_MAX = 4096
_entitlement_cache: dict = {}


def _cached(cache: dict, key: Any) -> Optional[dict]:
    """A live cache entry, or None."""
    hit = cache.get(key)
    return hit if hit is not None and hit['expiry'] > time.time() else None


def _remember(cache: dict, key: Any, app_id: str, ttl: float = ENTITLEMENT_TTL, **values: Any) -> dict:
    """Store an entry with a hard expiry; the cache is bounded (expired first, then soonest to expire)."""
    now = time.time()
    entry = {**values, 'expiry': now + ttl, 'appId': app_id}
    cache[key] = entry
    if len(cache) > _CACHE_MAX:
        for k in [k for k, v in cache.items() if v['expiry'] <= now]:
            cache.pop(k, None)
        if len(cache) > _CACHE_MAX:
            for k in sorted(cache, key=lambda k: cache[k]['expiry'])[: len(cache) - _CACHE_MAX]:
                cache.pop(k, None)
    return entry


def drop_app(app_id: str) -> None:
    """Drop every cached isolation verdict of one app (called by ``invalidate_app_serving``)."""
    for name, cache in list(globals().items()):
        if name.endswith('_cache') and isinstance(cache, dict):
            for key in [k for k, entry in cache.items() if isinstance(entry, dict) and entry.get('appId') == app_id]:
                cache.pop(key, None)


def _is_saas() -> bool:
    """True when the loaded account edition gates app serving (SaaS)."""
    from .shell import _is_saas as is_saas

    return is_saas()


async def token_version_dirs(user_id: str, org_id: str, app_id: str) -> dict:
    """
    Registry version -> dist dir that a frame token of ``(user_id, org_id)`` may serve.

    SaaS: the versions ``entitled_version_dirs`` grants the account
    ``account_info_for(user_id, org_id)`` builds; no account means nothing.
    OSS: every built version (open serving, as ``apps_static``).
    """
    from ai.account import account
    from ai.account.app_deploy import entitled_version_dirs, open_version_dirs

    saas = _is_saas()
    key = ('token', app_id, user_id, org_id) if saas else ('open', app_id)
    hit = _cached(_entitlement_cache, key)
    if hit is not None:
        return hit['dirs']
    if saas:
        try:
            info = await account.account_info_for(user_id, org_id)
        except Exception:
            info = None
        dirs = await entitled_version_dirs(info, app_id) if info is not None else {}
    else:
        dirs = await open_version_dirs(app_id)
    return _remember(_entitlement_cache, key, app_id, dirs=dirs)['dirs']


async def public_version_dirs(app_id: str) -> dict:
    """Registry version -> dist dir an anonymous caller may load (SaaS: public ``ready``; OSS: open)."""
    from ai.account.app_deploy import entitled_version_dirs, open_version_dirs

    key = ('public', app_id)
    hit = _cached(_entitlement_cache, key)
    if hit is not None:
        return hit['dirs']
    dirs = await entitled_version_dirs(None, app_id) if _is_saas() else await open_version_dirs(app_id)
    return _remember(_entitlement_cache, key, app_id, dirs=dirs)['dirs']


PUBLIC_LOOKUP_LIMIT = 120  # registry walks per client address per minute
_lookup_rate_cache: dict = {}


def public_lookup_ok(app_id: str, client: str) -> bool:
    """
    Whether an anonymous ``/_p`` request for ``app_id`` may proceed.

    A known answer (cached) always may; a registry walk for an id not cached
    yet counts against the client's budget (120 a minute), so ids nobody
    published cannot drive unbounded lookups.
    """
    if _cached(_entitlement_cache, ('public', app_id)) is not None:
        return True
    return _rate_ok(_lookup_rate_cache, client, PUBLIC_LOOKUP_LIMIT)


async def entitlement_ok(user_id: str, org_id: str, app_id: str, version: int) -> bool:
    """
    Whether a frame token of ``(user_id, org_id)`` may still serve ``app_id`` v``version``.

    On OSS the check is skipped (open serving, as ``apps_static``): no
    account lookup, always True.
    """
    if not _is_saas():
        return True
    return version in await token_version_dirs(user_id, org_id, app_id)


# =============================================================================
# THE ISOLATION DECISION — stamped once, where the binding org is known
# =============================================================================
# resolve_app_pins stamps each entry it builds with ``firstParty`` and
# ``isolated`` from the scope-walk WINNER's binding org; the binding org never
# leaves it, and nothing else writes the two keys. With the mode ``off`` no
# key is added. ``wire_view`` then shapes the list per client at the points it
# is serialised (probe, connect, pushes).

# The shellCaps value a shell sends when it can open isolated apps.
SHELL_CAP = 'appIsolation:1'
_MAX_SHELL_CAPS = 8


class Verdict(NamedTuple):
    """The isolation decision of one app as bound by one org."""

    isolated: bool
    firstParty: bool


def _isolates(config: IsolationConfig, app_id: str, first_party: bool) -> bool:
    """
    ``isolated`` for an app: never under off, never first party, every app or the listed ones.

    The list is compared case-folded, so no spelling of a listed id escapes it.
    """
    if config.mode == 'off' or first_party:
        return False
    return config.mode == 'enforce' or app_id.casefold() in {listed.casefold() for listed in config.apps}


async def resolve_isolation(app_id: str, binding_org_id: str) -> Optional[Verdict]:
    """
    The isolation decision of ``app_id`` bound by ``binding_org_id``.

    ``firstParty`` is the account's ``is_first_party`` (any error answers
    False: fail closed). Under ``off`` nothing is asked and the answer is
    None (no stamp).
    """
    config = current_config()
    if config.mode == 'off':
        return None
    from ai.account import account

    try:
        first_party = (await account.is_first_party(app_id, binding_org_id)) is True
    except Exception:
        first_party = False
    return Verdict(isolated=_isolates(config, app_id, first_party), firstParty=first_party)


def stamp_isolation(entry: dict, verdict: Optional[Verdict]) -> dict:
    """Write the decision onto one manifest entry (the ONLY writer of the keys); None adds nothing."""
    if verdict is not None:
        entry.update({'firstParty': verdict.firstParty, 'isolated': verdict.isolated})
    return entry


def sanitize_shell_caps(value: Any) -> Tuple[str, ...]:
    """A client's ``shellCaps``: a list of strings, at most 8 kept; anything else is no caps."""
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(cap for cap in value if isinstance(cap, str))[:_MAX_SHELL_CAPS]


def wire_view(entries: Optional[List[dict]], shell_caps: Any) -> Optional[List[dict]]:
    """
    The app list as one client may receive it.

    For a client without ``appIsolation:1`` in its ``shellCaps`` (an old shell,
    a VS Code realm), an isolated entry loses ``registryVersion`` and
    ``entry`` so it shows no broken tile; security does not depend on it (the
    main origin refuses the dist anyway). Works on copies, is idempotent, and
    returns its input unchanged under ``off``.
    """
    if not entries or current_config().mode == 'off':
        return entries
    capable = SHELL_CAP in sanitize_shell_caps(shell_caps)
    out = []
    for entry in entries:
        entry = dict(entry) if isinstance(entry, dict) else entry
        if not capable and isinstance(entry, dict) and entry.get('isolated') is True:
            entry.pop('registryVersion', None)
            entry.pop('entry', None)
        out.append(entry)
    return out


def probe_isolation() -> Optional[dict]:
    """The probe's ``appIsolation`` block, or None under ``off`` (or without a runtime marker)."""
    config = current_config()
    if config.mode == 'off':
        return None
    try:
        marker = read_runtime_marker()
    except RuntimeError:
        return None
    return {
        'mode': config.mode,
        'originTemplate': config.origin_template,
        'protoMin': marker['protoMin'],
        'protoMax': marker['protoMax'],
    }


# =============================================================================
# PER-VERSION ANSWERS — POST /apps/frame and the main-origin refusal (E8)
# =============================================================================
# One rule everywhere: the caller's scope-walk winner (resolve_app_pins for the
# caller; anonymous callers see public ready rows only) carries the stamp. The
# verdict is cached per (app, caller) for 60 s and dropped by
# ``invalidate_app_serving``.

_verdict_cache: dict = {}
_frame_rate_cache: dict = {}
_client_rate_cache: dict = {}
FRAME_RATE_LIMIT = 60  # per caller (user, or client address when anonymous)
CLIENT_RATE_LIMIT = 600  # per client address, before any authentication
FRAME_RATE_WINDOW = 60.0

# appManifest.network (Appendix C): strict https origins, at most 8.
_NETWORK = re.compile(
    r'https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:([0-9]{1,5}))?'
)
_NETWORK_MAX = 8
_ORG_OF_DIST = re.compile(r'orgs/([^/]+)/files/')


def validate_network(entries: Any) -> List[str]:
    """
    Validate ``appManifest.network``: at most 8 strict ``https://host[:port]`` origins.

    Refused: anything but a list of strings, a scheme other than https, a
    path, query, user or whitespace, an uppercase host, an IP literal,
    ``localhost``, a port outside 1-65535, the app domain itself and the
    shell's hosts (the shell origins and ``RR_APP_URL``).

    Returns:
        The entries, as a list.

    Raises:
        ValueError: Naming the first offending entry.
    """
    if not isinstance(entries, list):
        raise ValueError('network must be a list of https origins')
    if len(entries) > _NETWORK_MAX:
        raise ValueError(f'network lists {len(entries)} origins (at most {_NETWORK_MAX})')
    suffix = current_config().app_suffix
    for entry in entries:
        match = _NETWORK.fullmatch(entry) if isinstance(entry, str) else None
        if match is None:
            raise ValueError(f'network entry {entry!r} is not an https://host[:port] origin')
        host, port = match.group(1), match.group(6)
        try:
            ipaddress.ip_address(host)
            is_ip = True
        except ValueError:
            is_ip = False
        if is_ip or host == 'localhost' or host.endswith('.localhost'):
            raise ValueError(f'network entry {entry!r} names a local or IP host')
        if port is not None and not 1 <= int(port) <= 65535:
            raise ValueError(f'network entry {entry!r} has a port outside 1-65535')
        if suffix and (host == suffix or host.endswith('.' + suffix)):
            raise ValueError(f'network entry {entry!r} is on the app domain')
        if any(host == shell or host.endswith('.' + shell) for shell in _shell_hosts(os.environ)):
            raise ValueError(f'network entry {entry!r} is on a shell host')
    return list(entries)


def _identity_of(info: Any) -> Tuple[str, str, List[str]]:
    """``(user_id, org_id, team_ids)`` of an AccountInfo-shaped object."""
    user_id = str(getattr(info, 'userId', '') or '')
    org = getattr(info, 'organization', None)
    org_id, team_ids = '', []
    if org is not None:
        org_id = str((org.get('id') if isinstance(org, dict) else getattr(org, 'id', '')) or '')
        for team in (org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)) or []:
            tid = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
            if tid:
                team_ids.append(str(tid))
    return user_id, org_id, team_ids


async def caller_of(token: str) -> Any:
    """The AccountInfo a bearer or cookie token authenticates, or None (anonymous or invalid)."""
    if not token:
        return None
    from ai.account import account

    try:
        info = await account.authenticate(token)
    except Exception:
        return None
    # authenticate() returns an (int, str) error tuple on failure.
    return info if hasattr(info, 'userId') else None


async def _caller_answer(token: str, app_id: str) -> dict:
    """``{verdict, org}``: the caller's winning stamp for ``app_id`` (None: no entry) and the caller's org."""
    key = hashlib.sha256(f'{token}.{app_id}'.encode('utf-8')).hexdigest()
    hit = _cached(_verdict_cache, key)
    if hit is not None:
        return hit
    from ai.account.app_deploy import resolve_app_pins

    local = '' if _is_saas() else 'local'
    info = await caller_of(token)
    org_id = local
    if info is not None:
        user_id, caller_org, team_ids = _identity_of(info)
        org_id = caller_org or local
        entries = await resolve_app_pins(org_id, user_id or None, team_ids)
    else:
        entries = await resolve_app_pins(local, None, [])
    entry = next((e for e in entries if e.get('id') == app_id), None)
    verdict = None
    if entry is not None and 'isolated' in entry:
        verdict = Verdict(isolated=entry['isolated'] is True, firstParty=entry.get('firstParty') is True)
    return _remember(_verdict_cache, key, app_id, verdict=verdict, org=org_id)


async def version_verdict(token: str, app_id: str) -> Optional[Verdict]:
    """The stamp of the caller's scope-walk winner for ``app_id``, or None when the caller has no entry."""
    return (await _caller_answer(token, app_id))['verdict']


async def isolated_for(token: str, app_id: str) -> bool:
    """
    Whether ``app_id`` is isolated for this caller (E8: its dist never serves on the main origin).

    False under ``off`` without asking anything. The caller's own entry for
    this exact id decides when there is one. Without one (an unpublished
    preview on the caller's own rail, or a spelling no entry has), the
    decision is ``resolve_isolation(app_id, caller's org)``: first party for
    that org loads, otherwise ``enforce`` isolates and ``optin`` isolates a
    listed id, compared case-folded so a case variant cannot reopen the main
    origin.
    """
    if current_config().mode == 'off':
        return False
    if not is_canonical_app_id(app_id):
        return True  # an alias spelling is never served from the main origin (R3-L3)
    answer = await _caller_answer(token, app_id)
    if answer['verdict'] is not None:
        return answer['verdict'].isolated
    fallback = await resolve_isolation(app_id, answer['org'])
    return fallback is None or fallback.isolated


def _rate_ok(cache: dict, key: str, limit: int) -> bool:
    """One more request for ``key`` inside its fixed window (``FRAME_RATE_WINDOW``)."""
    hit = _cached(cache, key)
    if hit is None:
        _remember(cache, key, '', ttl=FRAME_RATE_WINDOW, count=1)
        return True
    hit['count'] += 1
    return hit['count'] <= limit


def frame_rate_ok(caller: str) -> bool:
    """One more ``POST /apps/frame`` for this caller (60 per 60 s)."""
    return _rate_ok(_frame_rate_cache, caller, FRAME_RATE_LIMIT)


def client_rate_ok(client: str) -> bool:
    """One more unauthenticated-cost request for this client address (600 per 60 s), checked before any lookup."""
    return _rate_ok(_client_rate_cache, client, CLIENT_RATE_LIMIT)


_CLIENT_IP_MAX = 64
_NAT64 = ipaddress.ip_network('64:ff9b::/96')


def _bucket_of(value: str) -> Optional[str]:
    """
    The rate-limit bucket of one address entry, or None when it is not an address.

    Accepted forms: a bare address, ``v4:port``, ``[v6]`` or ``[v6]:port``,
    and CloudFront's unbracketed ``v6:port`` when the whole value is not
    itself an address. An IPv4 address is its own bucket, also when it
    arrives IPv4-mapped (``::ffff:a.b.c.d``) or through NAT64
    (``64:ff9b::/96``); any other IPv6 address is keyed by its /64 (one
    subscriber's allocation), so neither rotating the low 64 bits nor a
    port read as the last group (``2a01:db8::1:443``
    is also a valid address) gives a client another bucket.
    """
    value = value.strip()
    if not value or len(value) > _CLIENT_IP_MAX:
        return None
    candidates = []
    if value.startswith('['):
        host, _, port = value[1:].partition(']')
        if not port or (port[:1] == ':' and port[1:].isascii() and port[1:].isdecimal()):
            candidates = [host]
    elif value.count(':') == 1:
        host, _, port = value.partition(':')
        if port.isascii() and port.isdecimal() and int(port) <= 65535:
            candidates = [host]
    else:
        candidates = [value]
        if ':' in value:
            host, _, port = value.rpartition(':')
            if port.isascii() and port.isdecimal() and int(port) <= 65535:
                candidates.append(host)  # CloudFront's unbracketed v6:port
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate)
            if address.version == 6:
                # An IPv4 client seen through IPv6 (a dual-stack listener's
                # ::ffff:a.b.c.d, or NAT64 64:ff9b::/96) is that IPv4 client:
                # bucketing it by /64 would put every IPv4 client in ::/64.
                embedded = address.ipv4_mapped
                if embedded is None and address in _NAT64:
                    embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
                if embedded is not None:
                    return str(embedded)
                return str(ipaddress.ip_network(f'{address}/64', strict=False))
            return str(address)
        except ValueError:
            continue  # including scope-id forms some Python releases refuse as a network
    return None


def client_ip(headers: Any, peer: str, config: IsolationConfig) -> str:
    """
    The client bucket the unauthenticated rate limits key on (an IPv4 address or an IPv6 /64).

    The peer address, unless ``RR_TRUSTED_CLIENT_IP_HEADER`` names the header
    a trusted edge sets. Then the LAST entry across all lines of that header
    (the one the edge itself wrote), parsed as above; an invalid or oversized
    value falls back to the peer. With ``RR_TRUSTED_PROXY_CIDRS`` set, the
    header counts only when the engine's DIRECT peer is inside one of those
    networks (otherwise it is silently ignored and the peer is the bucket);
    unset, the header is trusted from any peer, so anyone who can reach the
    engine directly can choose a bucket (startup warns).

    Behind CloudFront: use ``CloudFront-Viewer-Address`` only (add it to the
    origin request policy of every distribution in front of the engine;
    CloudFront writes it itself). Not ``X-Forwarded-For``: behind CloudFront
    and an ALB its last entry is the CloudFront edge, so every viewer of one
    edge would share a bucket. Set ``RR_TRUSTED_PROXY_CIDRS`` to the networks
    of whatever connects to the engine directly (the ALB, or the gateway in
    front of it). Counters are per engine process.
    """
    if config.client_ip_header:
        trusted = True
        if config.trusted_proxies:
            try:
                peer_address = ipaddress.ip_address(peer)
                trusted = any(peer_address in network for network in config.trusted_proxies)
            except ValueError:
                trusted = False
        if trusted:
            getlist = getattr(headers, 'getlist', None)
            lines = getlist(config.client_ip_header) if getlist else [headers.get(config.client_ip_header, '')]
            entries = [item for line in lines for item in str(line).split(',') if item.strip()]
            bucket = _bucket_of(entries[-1]) if entries else None
            if bucket:
                return bucket
    return _bucket_of(peer) or peer


async def _version_facts(app_id: str, version: int, dist_dir: str) -> Optional[Tuple[str, str, dict]]:
    """``(binding org, frame state, metadata)`` of the version behind one entitled dist dir."""
    from ai.account import account
    from ai.account.app_rows import dist_dir_of

    match = _ORG_OF_DIST.match(dist_dir)
    if match is None:
        return None
    org_id = match.group(1)
    try:
        entries = await account.deployments_versions(org_id, app_id)
    except Exception:
        return None
    for entry in entries or []:
        if int(entry.get('version', 0)) != version or dist_dir_of(str(entry.get('artifactPath') or '')) != dist_dir:
            continue
        deploy_state = str(entry.get('state') or '')
        state = deploy_state if deploy_state in ('ready', 'submit') else 'internal'
        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        return org_id, state, metadata
    return None


async def _granted(org_id: str, app_id: str, version: int, state: str) -> List[str]:
    """The effective grant: a ready version's approved capabilities (known names), else ``core``."""
    caps = ['core']
    if state == 'ready':
        from ai.account import account

        try:
            stored = await account.approved_capabilities(org_id, app_id, version)
        except Exception:
            stored = []
        known = known_capabilities() or frozenset({'core'})
        for cap in stored if isinstance(stored, list) else []:
            if isinstance(cap, str) and cap in known and cap not in caps:
                caps.append(cap)
    return caps


def _network_of(metadata: dict) -> List[str]:
    """The version's ``appManifest.network``, revalidated; an invalid list is dropped."""
    manifest = metadata.get('manifest') if isinstance(metadata.get('manifest'), dict) else {}
    if 'network' not in manifest:
        return []
    try:
        return validate_network(manifest['network'])
    except ValueError:
        return []


async def frame_grant(app_id: str, version: int, token: str, info: Any, config: IsolationConfig) -> Optional[dict]:
    """
    The ``POST /apps/frame`` 200 body for one caller, or None (the one 404).

    A signed-in caller gets a frame token for a version it is entitled to;
    an anonymous caller gets the ``/_p/`` prefix of a public ``ready``
    version. Only an app the caller's winner stamps as isolated is framed.
    """
    verdict = await version_verdict(token if info is not None else '', app_id)
    if verdict is None or not verdict.isolated:
        return None
    if info is not None:
        user_id, org_id, _ = _identity_of(info)
        dirs = await token_version_dirs(user_id, org_id, app_id)
    else:
        dirs = await public_version_dirs(app_id)
    dist_dir = dirs.get(version)
    facts = await _version_facts(app_id, version, dist_dir) if dist_dir else None
    if facts is None:
        return None
    org_id_of_version, state, metadata = facts
    if info is None and state != 'ready':
        return None
    if info is not None:
        frame_token, claims = _mint(app_id, version, user_id, org_id, config)
        entry_prefix = f'/_t/{frame_token}/v{version}/'
        expires_at = claims['exp'] * 1000
    else:
        entry_prefix = f'/_p/{app_id}/v{version}/'
        expires_at = (int(time.time()) + FRAME_TOKEN_TTL) * 1000
    return {
        'v': 1,
        'origin': config.origin_of(app_id),
        'entryPrefix': entry_prefix,
        'expiresAt': expires_at,
        'capabilities': await _granted(org_id_of_version, app_id, version, state),
        'network': _network_of(metadata),
        'state': state,
    }
