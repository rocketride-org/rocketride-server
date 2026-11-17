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
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Tuple

MODES = ('off', 'optin', 'enforce')
HOST_SOURCES = ('host', 'edge-header')

# The app-id segment grammar of the /apps routes (shell._APP_ID_SEG), at most
# 128 characters.
_APP_ID = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}')

# Appendix C: https://{label}.<host>, or plain http only on apps.localhost
# with an explicit port.
_TEMPLATE_HTTPS = re.compile(r'https://\{label\}\.([a-z0-9-]+(?:\.[a-z0-9-]+)*)')
_TEMPLATE_LOCAL = re.compile(r'http://\{label\}\.(apps\.localhost):(\d{1,5})')

# A frame-ancestors source: a plain http(s) origin, nothing else.
_ORIGIN = re.compile(r'https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?')

# A key id is a token segment, so it never contains the separator.
_KID = re.compile(r'[A-Za-z0-9_-]{1,32}')
_B64URL = re.compile(r'[A-Za-z0-9_-]+')
_MIN_SECRET_BYTES = 32

# runtime.json's guest bundle name: served at /_rr/<guest>.
_GUEST_NAME = re.compile(r'guest-[A-Za-z0-9_.-]+\.js')
_SHA256_HEX = re.compile(r'[0-9a-f]{64}')

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
    """

    mode: str = 'off'
    apps: frozenset = frozenset()
    origin_template: str = ''
    token_keys: Tuple[Tuple[str, bytes], ...] = ()
    shell_origins: Tuple[str, ...] = ()
    host_source: str = 'host'
    edge_secret: str = field(default='', repr=False)
    app_suffix: str = ''
    app_port: Optional[int] = None

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
    )


def current_config() -> IsolationConfig:
    """The configuration of the process environment, read now."""
    return load_isolation_config(os.environ)


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
_SAAS_ACCOUNT_METHODS = ('account_info_for', 'is_first_party', 'set_approved_capabilities')


def validate_isolation_config(account: Any = None) -> None:
    """
    Refuse to start a half-built isolation setup (design section 2, checks a-d).

    Runs nothing under ``off``. Otherwise: (a) the variables are valid; (b) the
    guest runtime marker and ``frame.html`` are present; (c)
    ``capabilities.json`` hashes to the marker's ``capabilitiesSha256``; (d) a
    SaaS account class overrides the account methods isolation relies on.

    Args:
        account: The account to check (default: the loaded singleton).

    Raises:
        RuntimeError: One line naming the failed check and the remedy.
    """
    config = current_config()  # (a)
    if config.mode == 'off':
        return

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
