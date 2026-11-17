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
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Mapping, NamedTuple, Optional, Tuple

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


# =============================================================================
# FRAME TOKENS — one app version, one user, 15 minutes (design section 7)
# =============================================================================
# Layout (Appendix C): v1.<kid>.<b64url(json claims)>.<b64url(HMAC-SHA256(key,
# "v1.<kid>.<claims>"))>, claims {a: appId, v: version, u: userId, o: orgId,
# iat, exp}. App code can read its own token, so a token only ever grants GETs
# of ONE version's dist, on that app's own host, until it expires; the
# entitlement is re-checked on every request on top of it.

FRAME_TOKEN_TTL = 900
_CLAIM_KEYS = frozenset({'a', 'v', 'u', 'o', 'iat', 'exp'})


class FrameTokenError(ValueError):
    """A frame token that does not verify. Every cause raises the same error."""


def _b64u(data: bytes) -> str:
    """URL-safe base64 without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _unb64u(text: str) -> bytes:
    """Strict inverse of ``_b64u``; raises FrameTokenError on anything else."""
    if not _B64URL.fullmatch(text):
        raise FrameTokenError('malformed token')
    try:
        return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise FrameTokenError('malformed token') from None


def _signature(key: bytes, signed: str) -> str:
    """The token signature over ``v1.<kid>.<claims>``."""
    return _b64u(hmac.new(key, signed.encode('ascii'), hashlib.sha256).digest())


def mint_frame_token(
    app_id: str, version: int, user_id: str, org_id: str, *, config: Optional[IsolationConfig] = None
) -> str:
    """
    Sign a frame token for one app version and one user, valid for 15 minutes.

    Args:
        app_id: The app the token opens.
        version: The registry version it opens.
        user_id: The user the entitlement is re-checked for.
        org_id: The org the entitlement is re-checked in.
        config: The configuration (default: the environment's); the FIRST key signs.

    Returns:
        The token, URL-safe (it is a path segment of ``/_t/<token>/v<N>/``).
    """
    config = config or current_config()
    if not config.token_keys:
        raise RuntimeError('no frame token key is configured (RR_APP_FRAME_TOKEN_KEYS)')
    kid, key = config.token_keys[0]
    iat = int(time.time())
    claims = {'a': app_id, 'v': version, 'u': user_id, 'o': org_id, 'iat': iat, 'exp': iat + FRAME_TOKEN_TTL}
    signed = f'v1.{kid}.{_b64u(json.dumps(claims, separators=(",", ":")).encode("utf-8"))}'
    return f'{signed}.{_signature(key, signed)}'


def verify_frame_token(token: str, host_label: str, *, config: Optional[IsolationConfig] = None) -> dict:
    """
    Verify a frame token for the app host it arrived on.

    Checks the layout, the key id (any configured key verifies), the
    signature, the claim types, the expiry and that ``host_label`` is
    ``label_of(claims.a)``.

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
    _, kid, body, sig = parts
    key = dict(config.token_keys).get(kid)
    if key is None or not _B64URL.fullmatch(sig):
        raise FrameTokenError('unknown key')
    if not hmac.compare_digest(sig, _signature(key, f'v1.{kid}.{body}')):
        raise FrameTokenError('bad signature')
    try:
        claims = json.loads(_unb64u(body))
    except ValueError:
        raise FrameTokenError('malformed claims') from None
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
    """``isolated`` for an app: never under off, never first party, every app or the listed ones."""
    if config.mode == 'off' or first_party:
        return False
    return config.mode == 'enforce' or app_id in config.apps


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
