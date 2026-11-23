# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Shared Supabase connection machinery (no engine imports).

Everything here is plain Python so it can be unit tested without the engine:

* access levels (``read`` < ``write`` < ``admin``) and the check a tool runs;
* the two connection kinds, resolved from the node config:
  - **API**: Project URL + secret key (Auth, Storage, Messaging, Edge Functions);
  - **Postgres**: pooler host, user, password, database (Vector, Cron);
* ``build_client`` (supabase-py, imported lazily) and ``SupabaseApi`` (a thin
  HTTP helper for REST calls supabase-py does not wrap, e.g. Realtime
  broadcast);
* ``connect_postgres`` (psycopg2, imported lazily, always ``sslmode=require``
  and SCRAM password authentication);
* secret hygiene: ``Redactor`` and ``drop_secret_fields``.

Config keys are the last segment of the field id (``supabase.secretKey`` ->
``secretKey``, ``supabase.pooler.host`` -> ``host``): the engine strips the
namespace before the node sees its config.

Error types: ``SupabaseConfigError`` (ValueError) for bad settings,
``SupabaseAccessError`` (PermissionError) for a call above the node's access
level, ``SupabaseError`` (RuntimeError) for backend failures. Messages never
carry secret values.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence
from urllib.parse import urlsplit

# =============================================================================
# Errors
# =============================================================================


class SupabaseError(RuntimeError):
    """A Supabase backend call failed. ``status`` is the HTTP status when known."""

    def __init__(self, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


class SupabaseAccessError(PermissionError):
    """A tool was called above the node's configured access level."""


class SupabaseConfigError(ValueError):
    """The node settings are missing or invalid."""


# =============================================================================
# Access levels
# =============================================================================

READ = 'read'
WRITE = 'write'
ADMIN = 'admin'
ACCESS_LEVELS = (READ, WRITE, ADMIN)
_ACCESS_RANK = {level: rank for rank, level in enumerate(ACCESS_LEVELS)}
DEFAULT_ACCESS = READ


def normalize_access(value: Any, allowed: Sequence[str] = ACCESS_LEVELS) -> str:
    """Return a valid access level; missing/blank means ``read``.

    ``allowed`` is the service's own list (Cron offers only read and admin).
    An unknown or unoffered value raises instead of falling back: silently
    treating a typo as ``read`` would hide a misconfiguration, and treating
    it as anything higher would be unsafe.
    """
    if value is None:
        return DEFAULT_ACCESS
    if not isinstance(value, str):
        raise SupabaseConfigError(f'Access level must be one of {list(allowed)}')
    level = value.strip().lower()
    if not level:
        return DEFAULT_ACCESS
    if level not in allowed:
        raise SupabaseConfigError(f'Access level must be one of {list(allowed)}, got {value!r}')
    return level


def access_allows(node_level: str, needed: str) -> bool:
    """True when a node set to ``node_level`` may run a tool needing ``needed``."""
    return _ACCESS_RANK[node_level] >= _ACCESS_RANK[needed]


def require_access(node_level: str, needed: str, tool: str) -> None:
    """Raise SupabaseAccessError unless ``node_level`` covers ``needed``."""
    if needed not in _ACCESS_RANK:
        raise ValueError(f'{tool}: unknown access level {needed!r} declared by the tool')
    if not access_allows(node_level, needed):
        raise SupabaseAccessError(
            f'{tool} needs the "{needed}" access level, but this node is set to "{node_level}". '
            f'Set "Access level" on the node to "{needed}" or higher to allow it.'
        )


# =============================================================================
# Connection settings
# =============================================================================

AUTH_KEY = 'key'
# Reserved for the later "Connect Supabase" run. Not accepted yet.
AUTH_OAUTH = 'oauth'
AUTH_TYPES = (AUTH_KEY,)

DEFAULT_POOLER_PORT = 5432
DEFAULT_DATABASE = 'postgres'

_PROJECT_REF = re.compile(r'^[a-z0-9]{20}$')
_HOSTED_SUFFIX = '.supabase.co'
# Paths people paste by mistake after the project URL.
_URL_SUFFIXES = ('/rest/v1', '/auth/v1', '/storage/v1', '/functions/v1', '/realtime/v1')


def _mask(value: str) -> str:
    return '***' if value else ''


@dataclass(frozen=True)
class ApiConnection:
    """Project URL + secret key. ``repr`` never shows the key."""

    url: str
    secret_key: str = field(repr=False)
    auth_type: str = AUTH_KEY
    project_ref: str = ''

    def __repr__(self) -> str:  # explicit: dataclass repr=False hides it, keep it obvious
        return (
            f'ApiConnection(url={self.url!r}, secret_key={_mask(self.secret_key)!r}, project_ref={self.project_ref!r})'
        )

    def secrets(self) -> List[str]:
        return [self.secret_key]


@dataclass(frozen=True)
class PostgresConnection:
    """Pooler connection details. ``repr`` never shows the password."""

    host: str
    port: int
    user: str
    password: str = field(repr=False)
    database: str = DEFAULT_DATABASE

    def __repr__(self) -> str:
        return (
            f'PostgresConnection(host={self.host!r}, port={self.port!r}, user={self.user!r}, '
            f'password={_mask(self.password)!r}, database={self.database!r})'
        )

    def secrets(self) -> List[str]:
        return [self.password]


def _cfg_str(cfg: Mapping[str, Any], key: str) -> str:
    value = cfg.get(key)
    return value.strip() if isinstance(value, str) else ''


def resolve_auth_type(cfg: Mapping[str, Any]) -> str:
    """Return the API connection mode. Missing or blank means ``key``.

    Forward compatibility: a pipeline saved before OAuth exists has either
    ``authType: "key"`` or no ``authType`` at all; both stay key mode forever.
    """
    value = _cfg_str(cfg, 'authType').lower()
    if not value:
        return AUTH_KEY
    if value == AUTH_OAUTH:
        raise SupabaseConfigError('Connect Supabase (OAuth) is not available yet. Use a Project URL and secret key.')
    if value not in AUTH_TYPES:
        raise SupabaseConfigError(f'Unknown connection type {value!r}; use "key"')
    return value


# Name suffixes that only resolve inside a private network: Docker's
# host.docker.internal, cloud-internal DNS (*.internal), mDNS (*.local).
_LOCAL_SUFFIXES = ('.localhost', '.internal', '.local')


def _is_local_host(host: str) -> bool:
    """True for localhost, loopback and private-network addresses (self-hosted development).

    Private-network names count too: a single-label name such as ``kong``
    (how a docker-compose Supabase is reached from a container next to it)
    and the private-only suffixes in ``_LOCAL_SUFFIXES``. Public DNS never
    hands out single-label names, so none of these leave the private network.
    """
    host = (host or '').lower().rstrip('.')
    if not host:
        return False
    if host == 'localhost' or host.endswith(_LOCAL_SUFFIXES):
        return True
    if '.' not in host and ':' not in host:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def normalize_project_url(raw: Any) -> str:
    """Normalize the Project URL a user pasted.

    Accepts ``https://<ref>.supabase.co``, the same with a trailing slash or an
    API path (``/rest/v1``), a bare host, or a bare 20-character project ref.
    Self-hosted https URLs are accepted unchanged. Plain ``http://`` is
    accepted only for localhost and private-network addresses: every call
    sends the secret key in its headers, so over plain HTTP anyone on the path
    could read it, and a redirect to https comes too late. Returns '' for
    empty input; raises SupabaseConfigError for something that is not a URL.
    """
    text = raw.strip() if isinstance(raw, str) else ''
    if not text:
        return ''
    if _PROJECT_REF.fullmatch(text):
        return f'https://{text}{_HOSTED_SUFFIX}'
    if '://' not in text:
        text = 'https://' + text
    parts = urlsplit(text)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise SupabaseConfigError('Project URL must look like https://<project-ref>.supabase.co')
    if parts.query or parts.fragment or '@' in parts.netloc:
        raise SupabaseConfigError('Project URL must not contain credentials, a query or a fragment')
    if parts.scheme == 'http' and not _is_local_host(parts.hostname or ''):
        raise SupabaseConfigError(
            'Project URL must use https: the secret key is sent with every call '
            '(plain http is allowed only for localhost and private-network addresses)'
        )
    path = parts.path.rstrip('/')
    for suffix in _URL_SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    return f'{parts.scheme}://{parts.netloc}{path.rstrip("/")}'


def project_ref_from_url(url: str) -> str:
    """Return the project ref of a hosted project URL, '' for self-hosted."""
    host = (urlsplit(url).hostname or '').lower()
    if host.endswith(_HOSTED_SUFFIX):
        ref = host[: -len(_HOSTED_SUFFIX)]
        if _PROJECT_REF.fullmatch(ref):
            return ref
    return ''


def classify_key(key: str) -> str:
    """Classify an API key without validating it.

    Returns ``secret`` (sb_secret_), ``publishable`` (sb_publishable_),
    ``service_role`` / ``anon`` (legacy JWT keys, from the unverified ``role``
    claim), or ``unknown``.
    """
    key = (key or '').strip()
    if key.startswith('sb_secret_'):
        return 'secret'
    if key.startswith('sb_publishable_'):
        return 'publishable'
    parts = key.split('.')
    if len(parts) == 3 and parts[0].startswith('eyJ'):
        try:
            payload = parts[1] + '=' * (-len(parts[1]) % 4)
            role = json.loads(base64.urlsafe_b64decode(payload)).get('role')
        except Exception:
            return 'unknown'
        if role in ('service_role', 'anon'):
            return role
    return 'unknown'


def api_config_problems(cfg: Mapping[str, Any]) -> List[str]:
    """Human-readable problems with the API connection settings (for validateConfig)."""
    problems: List[str] = []
    try:
        resolve_auth_type(cfg)
    except SupabaseConfigError as e:
        return [str(e)]
    try:
        url = normalize_project_url(cfg.get('url'))
    except SupabaseConfigError as e:
        problems.append(str(e))
    else:
        if not url:
            problems.append('Project URL is required (https://<project-ref>.supabase.co)')
    key_kind = classify_key(_cfg_str(cfg, 'secretKey'))
    if not _cfg_str(cfg, 'secretKey'):
        problems.append('Secret key is required (Project Settings -> API Keys, starts with sb_secret_)')
    elif key_kind in ('publishable', 'anon'):
        problems.append(
            'This is a public (publishable/anon) key. Use a secret key (sb_secret_...); '
            'the public key cannot manage users, buckets or queues.'
        )
    return problems


def resolve_api_connection(cfg: Mapping[str, Any]) -> ApiConnection:
    """Build the API connection from config, or raise SupabaseConfigError."""
    auth_type = resolve_auth_type(cfg)
    url = normalize_project_url(cfg.get('url'))
    if not url:
        raise SupabaseConfigError('Project URL is required (https://<project-ref>.supabase.co)')
    key = _cfg_str(cfg, 'secretKey')
    if not key:
        raise SupabaseConfigError('Secret key is required (starts with sb_secret_)')
    if classify_key(key) in ('publishable', 'anon'):
        raise SupabaseConfigError('A public (publishable/anon) key was given; a secret key (sb_secret_...) is required')
    return ApiConnection(url=url, secret_key=key, auth_type=auth_type, project_ref=project_ref_from_url(url))


# Characters a host name never has, but a pasted connection string does
# (postgresql://user:PASSWORD@host:5432/db).
_NOT_A_HOST = re.compile(r'[@/\s]')
HOST_NOT_A_URI = (
    'Pooler host must be just the host name and an optional :port (for example '
    'aws-0-eu-west-1.pooler.supabase.com:5432), not a connection string; put the user and password in their own fields'
)


def split_host_port(raw: str, default_port: int = DEFAULT_POOLER_PORT) -> tuple:
    """Split ``host[:port]`` (also ``[ipv6]:port``). Raises SupabaseConfigError on a bad value.

    The messages never echo the value: a connection string pasted into the
    host field (the dashboard's "Connect" URI) carries the password.
    """
    text = (raw or '').strip()
    if _NOT_A_HOST.search(text):
        raise SupabaseConfigError(HOST_NOT_A_URI)
    if text.startswith('['):
        host, _, rest = text[1:].partition(']')
        port_text = rest[1:] if rest.startswith(':') else ''
    elif text.count(':') == 1:
        host, _, port_text = text.partition(':')
    else:
        host, port_text = text, ''
    if not port_text:
        return host, default_port
    if not port_text.isdigit() or not 0 < int(port_text) < 65536:
        raise SupabaseConfigError('Pooler host has an invalid port: the port must be a number from 1 to 65535')
    return host, int(port_text)


def _password_given(password: Any) -> bool:
    """A password that is blank after strip counts as missing.

    The stored value itself is never stripped: whitespace inside or around a
    real password is valid (same rule as db_postgres). Only a password that is
    nothing but whitespace is refused, so start-up names the field instead of
    the first call failing with an authentication error.
    """
    return isinstance(password, str) and bool(password.strip())


def postgres_config_problems(cfg: Mapping[str, Any]) -> List[str]:
    """Human-readable problems with the Postgres (pooler) settings."""
    problems: List[str] = []
    host_raw = _cfg_str(cfg, 'host')
    user = _cfg_str(cfg, 'user')
    if not host_raw:
        problems.append('Pooler host is required (Supabase dashboard -> Connect -> Session pooler)')
    else:
        try:
            host, _ = split_host_port(host_raw)
        except SupabaseConfigError as e:
            problems.append(str(e))
        else:
            if host.endswith('pooler.supabase.com') and user and '.' not in user:
                problems.append('For the Supabase pooler the user must include the project ref: postgres.<project-ref>')
            if host.startswith('db.') and host.endswith(_HOSTED_SUFFIX):
                problems.append(
                    'db.<ref>.supabase.co is the direct connection and is IPv6-only; use the pooler host instead'
                )
    if not user:
        problems.append('Database user is required (postgres.<project-ref> for the pooler)')
    if not _password_given(cfg.get('password')):
        problems.append('Database password is required (Project Settings -> Database)')
    return problems


def resolve_postgres_connection(cfg: Mapping[str, Any]) -> PostgresConnection:
    """Build the pooler connection from config, or raise SupabaseConfigError."""
    host_raw = _cfg_str(cfg, 'host')
    if not host_raw:
        raise SupabaseConfigError('Pooler host is required')
    host, port = split_host_port(host_raw)
    user = _cfg_str(cfg, 'user')
    if not user:
        raise SupabaseConfigError('Database user is required')
    password = cfg.get('password')
    if not _password_given(password):
        raise SupabaseConfigError('Database password is required')
    database = _cfg_str(cfg, 'database') or DEFAULT_DATABASE
    return PostgresConnection(host=host, port=port, user=user, password=password, database=database)


# =============================================================================
# Postgres
# =============================================================================

APPLICATION_NAME = 'rocketride-supabase'


def postgres_connect_kwargs(conn: PostgresConnection, *, connect_timeout: int = 10) -> Dict[str, Any]:
    """psycopg2.connect keyword arguments: TLS required, password sent only through SCRAM.

    ``sslmode=require`` encrypts the connection but does not check the
    server's certificate, so on its own it stops only passive sniffing. An
    active man in the middle could still ask libpq for the password in clear
    text; ``require_auth=scram-sha-256`` (libpq 16+; psycopg2-binary 2.9.12
    ships libpq 17) refuses every other method, and SCRAM never sends the
    password itself. Certificate checking (``verify-full``) would also need
    Supabase's CA bundled with the node; it is not done here.
    """
    return {
        'host': conn.host,
        'port': conn.port,
        'user': conn.user,
        'password': conn.password,
        'dbname': conn.database,
        'sslmode': 'require',
        'require_auth': 'scram-sha-256',
        'connect_timeout': connect_timeout,
        'application_name': APPLICATION_NAME,
    }


def connect_postgres(conn: PostgresConnection, *, connect_timeout: int = 10) -> Any:
    """Open a psycopg2 connection (imported lazily). Raises SupabaseError, never with the password."""
    import psycopg2  # type: ignore

    try:
        return psycopg2.connect(**postgres_connect_kwargs(conn, connect_timeout=connect_timeout))
    except Exception as e:
        message = Redactor(conn.secrets()).redact(first_line(str(e)))
        raise SupabaseError(
            f'Could not connect to the Supabase database at {conn.host}:{conn.port}: {message}'
        ) from None


# =============================================================================
# supabase-py client
# =============================================================================

DEFAULT_TIMEOUT = 30


def build_client(conn: ApiConnection, *, timeout: int = DEFAULT_TIMEOUT) -> Any:
    """Build a sync supabase-py client from Project URL + secret key.

    supabase-py is imported here, after depends() installed it. Session
    persistence and token auto-refresh are off: the client acts with the
    secret key only. Never call ``client.auth.sign_in*`` / ``set_session`` on
    this shared client: supabase-py would switch the Authorization header of
    every later call to that user's token.
    """
    from supabase import create_client  # type: ignore
    from supabase.lib.client_options import SyncClientOptions  # type: ignore

    options = SyncClientOptions(
        auto_refresh_token=False,
        persist_session=False,
        postgrest_client_timeout=timeout,
        storage_client_timeout=timeout,
        function_client_timeout=timeout,
    )
    try:
        return create_client(conn.url, conn.secret_key, options=options)
    except Exception as e:
        raise SupabaseError(
            f'Could not create the Supabase client: {Redactor(conn.secrets()).redact(str(e))}'
        ) from None


def close_client(client: Any) -> None:
    """Close the HTTP sessions a supabase-py client opened.

    supabase-py has no close() of its own. Auth (and Auth admin, which shares
    its session) is built with the client; PostgREST, Storage and Functions
    are built on first use, so only the ones that exist (instance attributes
    ``_postgrest``, ``_storage``, ``_functions``) are closed. Each close is
    separate and its error ignored: teardown must release the others and
    never fail a pipeline stop.
    """
    if client is None:
        return
    attrs = vars(client) if hasattr(client, '__dict__') else {}
    closers = []
    auth = attrs.get('auth')
    if auth is not None:
        closers.append(getattr(auth, 'close', None))
    postgrest = attrs.get('_postgrest')
    if postgrest is not None:
        # SyncPostgrestClient names its sync close aclose().
        closers.append(getattr(postgrest, 'aclose', None))
    storage = attrs.get('_storage')
    if storage is not None:
        closers.append(getattr(getattr(storage, 'session', None), 'close', None))
    functions = attrs.get('_functions')
    if functions is not None:
        closers.append(getattr(getattr(functions, '_client', None), 'close', None))
    for close in closers:
        if callable(close):
            try:
                close()
            except Exception:
                pass


# =============================================================================
# HTTP helper
# =============================================================================


@dataclass
class HttpResult:
    """A finished HTTP call.

    ``body`` is the parsed body (JSON or text); ``content`` the raw bytes
    received; ``size`` their length as sent by the server. With
    ``max_bytes`` set, ``truncated`` is true when the body was longer: then
    ``content`` holds only the first ``max_bytes`` bytes, ``body`` is their
    text (never parsed as JSON), and ``size`` is the server's Content-Length
    when it sent one for an uncompressed body, else None (unknown). A cut
    ``body`` never ends in the first part of the node's secret key (see
    ``Redactor.scrub_cut``); ``content`` stays the raw bytes.
    """

    status: int
    headers: Dict[str, str]
    body: Any
    content: bytes = b''
    size: Optional[int] = None
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


def error_message_from_body(body: Any) -> str:
    """Pull the human message out of a Supabase error body (any of its shapes)."""
    if isinstance(body, dict):
        for key in ('message', 'msg', 'error_description', 'error', 'hint', 'details'):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                nested = error_message_from_body(value)
                if nested:
                    return nested
        return ''
    if isinstance(body, str):
        return first_line(body)[:300]
    return ''


class SupabaseApi:
    """Minimal HTTP client for the project's REST endpoints.

    ``request('POST', '/realtime/v1/api/broadcast', json=...)`` sends the
    secret key as ``apikey`` and ``Authorization: Bearer`` (as supabase-py
    does), parses JSON bodies, and raises SupabaseError for 4xx/5xx unless
    ``raise_for_status=False``. ``http_client`` is any object with httpx's
    ``request(method, url, **kw)``, ``stream(method, url, **kw)`` (a context
    manager whose response has ``iter_bytes()``; used when ``max_bytes`` is
    set) and ``close()``; tests pass a fake, runtime builds an
    ``httpx.Client`` lazily.
    """

    def __init__(self, conn: ApiConnection, *, timeout: float = DEFAULT_TIMEOUT, http_client: Any = None) -> None:
        self._conn = conn
        self._timeout = timeout
        self._http = http_client
        self._lock = threading.Lock()
        self._redactor = Redactor(conn.secrets())

    def _client(self) -> Any:
        if self._http is None:
            with self._lock:
                if self._http is None:
                    import httpx  # type: ignore

                    self._http = httpx.Client(timeout=self._timeout, follow_redirects=False)
        return self._http

    def headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        out = {
            'apikey': self._conn.secret_key,
            'Authorization': f'Bearer {self._conn.secret_key}',
            'Accept': 'application/json',
        }
        if extra:
            out.update(extra)
        return out

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        content: Optional[bytes] = None,
        timeout: Optional[float] = None,
        raise_for_status: bool = True,
        what: str = 'Supabase request',
        max_bytes: Optional[int] = None,
    ) -> HttpResult:
        """Call ``<project url><path>``. ``path`` must start with '/'; absolute URLs are refused.

        ``max_bytes`` bounds memory, not just the answer: the body is streamed
        and reading stops after ``max_bytes`` + 1 bytes (see HttpResult).
        Without it the whole body is read, which is fine for the small JSON
        answers of the REST APIs.
        """
        if not isinstance(path, str) or not path.startswith('/') or '://' in path:
            raise ValueError('SupabaseApi.request: path must be a project-relative path starting with "/"')
        kwargs: Dict[str, Any] = {'headers': self.headers(headers), 'timeout': timeout or self._timeout}
        if json is not None:
            kwargs['json'] = json
        if params:
            kwargs['params'] = dict(params)
        if content is not None:
            kwargs['content'] = content
        url = self._conn.url + path
        try:
            if max_bytes is None:
                response = self._client().request(method.upper(), url, **kwargs)
                result = _result(response, getattr(response, 'content', b'') or b'', truncated=False)
            else:
                with self._client().stream(method.upper(), url, **kwargs) as response:
                    raw, truncated = _read_capped(response, max_bytes)
                    result = _result(response, raw, truncated=truncated)
        except Exception as e:
            raise SupabaseError(
                f'{what} failed: {self._redactor.redact(first_line(str(e)) or type(e).__name__)}'
            ) from None
        if result.truncated and isinstance(result.body, str):
            # This request carried the secret key (apikey, Authorization), and
            # an endpoint that echoes its headers can be cut in the middle of it.
            result.body = self._redactor.scrub_cut(result.body)
        if raise_for_status and not result.ok:
            detail = self._redactor.redact(error_message_from_body(result.body)) or 'no details'
            raise SupabaseError(f'{what} failed (HTTP {result.status}): {detail}', status=result.status)
        return result

    def close(self) -> None:
        http, self._http = self._http, None
        if http is not None:
            try:
                http.close()
            except Exception:
                pass


def _read_capped(response: Any, max_bytes: int) -> tuple:
    """Read at most ``max_bytes`` + 1 bytes of a streamed response: (first max_bytes bytes, truncated)."""
    limit = max(0, int(max_bytes))
    buffer = bytearray()
    for chunk in response.iter_bytes():
        buffer.extend(chunk)
        if len(buffer) > limit:
            # Stop here: the rest of the body is never read into memory.
            return bytes(buffer[:limit]), True
    return bytes(buffer), False


def _result(response: Any, raw: Any, *, truncated: bool) -> HttpResult:
    """Build the HttpResult of a response whose body (or its first part) is ``raw``."""
    headers = {str(k).lower(): str(v) for k, v in dict(response.headers or {}).items()}
    raw = bytes(raw) if isinstance(raw, (bytes, bytearray)) else str(raw).encode('utf-8')
    if truncated:
        # httpx yields DECODED bytes, but for a gzip/deflate/br body
        # Content-Length is the compressed size on the wire: it says nothing
        # about the real size, so the size is then unknown.
        declared = headers.get('content-length', '')
        encoding = headers.get('content-encoding', '').strip().lower()
        uncompressed = encoding in ('', 'identity')
        size: Optional[int] = int(declared) if declared.isdigit() and uncompressed else None
        body: Any = raw.decode('utf-8', errors='ignore')
    else:
        size = len(raw)
        body = _parse_body(raw, headers.get('content-type', ''))
    return HttpResult(
        status=int(response.status_code), headers=headers, body=body, content=raw, size=size, truncated=truncated
    )


def _parse_body(raw: bytes, content_type: str) -> Any:
    if not raw:
        return None
    text = raw.decode('utf-8', errors='replace')
    if 'json' in content_type or text[:1] in ('{', '['):
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


# =============================================================================
# Secret hygiene
# =============================================================================

REDACTED = '***'

# The shortest start of a secret that Redactor.scrub_cut masks at the end of a cut text.
_MIN_PARTIAL_SECRET = 4

# Words that mark a header, field or query parameter as holding a credential.
_SECRET_NAME_WORDS = 'authorization|apikey|api-key|api_key|secret|token|signature|password|passwd'

# (pattern, replacement): secret-shaped text, masked wherever it appears.
_SECRET_PATTERNS = (
    (re.compile(r'sb_secret_[A-Za-z0-9_\-]+'), REDACTED),
    # JWTs (legacy service_role / anon keys, user access tokens).
    (re.compile(r'eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}'), REDACTED),
    # Passwords inside a connection URL: scheme://user:PASSWORD@host
    (re.compile(r'(?<=://)([^/\s:@]+):[^@\s/]+(?=@)'), rf'\1:{REDACTED}'),
    # A bearer token of any shape: "Authorization: Bearer <token>". At least 8
    # characters, so prose such as "Bearer token missing" stays readable.
    (re.compile(r'(?i)(\bbearer\s+)[A-Za-z0-9._~+/=\-]{8,}'), rf'\1{REDACTED}'),
    # A token joined to "Bearer " in SQL (before the header rule below,
    # which would mask only the 'Bearer ' part): 'Bearer ' || '<token>', concat('Bearer ', '<token>').
    (re.compile(r"(?i)('bearer\s*'\s*(?:\|\||,)\s*')[^']*(')"), rf'\1{REDACTED}\2'),
    # Header or field values written in SQL or JSON, the way pg_cron jobs call
    # net.http_post: '{"apikey": "<key>"}', '{"X-Webhook-Secret": "<s>"}' and
    # jsonb_build_object('Authorization', '<key>'). Any name that contains one
    # of these words counts, so custom secret headers are masked too.
    (
        re.compile(rf'(?i)("[^"]*(?:{_SECRET_NAME_WORDS})[^"]*"\s*:\s*")[^"]*(")'),
        rf'\1{REDACTED}\2',
    ),
    (
        re.compile(rf"(?i)('[^']*(?:{_SECRET_NAME_WORDS})[^']*'\s*,\s*')[^']*(')"),
        rf'\1{REDACTED}\2',
    ),
    # A libpq conninfo password (dblink('host=... password=<pw>')).
    (re.compile(r"(?i)(\bpassword\s*=\s*)[^\s'\"]+"), rf'\1{REDACTED}'),
    # A credential in a URL query: ?token=..., &api_key=..., &signature=...
    (
        re.compile(rf'(?i)([?&][A-Za-z0-9_.\-]*(?:{_SECRET_NAME_WORDS}|sig)=)[^&#\s\'"]+'),
        rf'\1{REDACTED}',
    ),
)

# Keys whose values must never reach tool output (Auth user objects, tokens).
SECRET_FIELD_NAMES = frozenset(
    {
        'password',
        'encrypted_password',
        'access_token',
        'refresh_token',
        'provider_token',
        'provider_refresh_token',
        'id_token',
        'secret',
        'secret_key',
        'secretkey',
        'apikey',
        'api_key',
        'service_role_key',
        'confirmation_token',
        'recovery_token',
        'email_change_token',
        'email_change_token_new',
        'email_change_token_current',
        'phone_change_token',
        'reauthentication_token',
        'hashed_token',
        'email_otp',
        'otp',
    }
)


class Redactor:
    """Replaces known secret values (and anything secret-shaped) in text."""

    def __init__(self, secrets: Iterable[Optional[str]] = ()) -> None:
        # Longest first so a secret that contains another is replaced whole.
        self._secrets = sorted({s for s in secrets if isinstance(s, str) and len(s) >= 4}, key=len, reverse=True)

    def redact(self, text: Any) -> str:
        """Redact a message (errors, logs): known secrets plus secret-shaped tokens.

        Also used on text a tool returns that is known to embed credentials
        (pg_cron job commands), where a key the node was not configured with
        must still never reach the agent.
        """
        out = text if isinstance(text, str) else str(text)
        for secret in self._secrets:
            out = out.replace(secret, REDACTED)
        for pattern, replacement in _SECRET_PATTERNS:
            out = pattern.sub(replacement, out)
        return out

    def scrub(self, value: Any) -> Any:
        """Replace known secret values anywhere in a tool result (dicts, lists, strings).

        Only exact configured secrets are replaced here: tool results can carry
        user content (file text) that legitimately looks like a token.
        """
        if not self._secrets:
            return value
        if isinstance(value, str):
            for secret in self._secrets:
                if secret in value:
                    value = value.replace(secret, REDACTED)
            return value
        if isinstance(value, dict):
            return {k: self.scrub(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.scrub(v) for v in value]
        return value

    def scrub_cut(self, text: str) -> str:
        """``scrub`` for text cut off at its end (a body capped at Max response size).

        The cut can fall inside a secret, leaving its first characters, which
        ``scrub`` does not recognise. A text that ends in the first
        ``_MIN_PARTIAL_SECRET`` or more characters of a known secret has that
        end replaced too. Shorter ends are left: they hold no more than the
        public ``sb_secret_`` / ``eyJ`` prefix.
        """
        out = self.scrub(text)
        for secret in self._secrets:
            for size in range(len(secret) - 1, _MIN_PARTIAL_SECRET - 1, -1):
                if out.endswith(secret[:size]):
                    return out[:-size] + REDACTED
        return out


def drop_secret_fields(value: Any, *, extra: Iterable[str] = (), keep: Iterable[str] = ()) -> Any:
    """Return a copy of ``value`` without keys named in SECRET_FIELD_NAMES (+ ``extra``, - ``keep``)."""
    names = (SECRET_FIELD_NAMES | {e.lower() for e in extra}) - {k.lower() for k in keep}
    if isinstance(value, dict):
        return {
            k: drop_secret_fields(v, extra=extra, keep=keep)
            for k, v in value.items()
            if not (isinstance(k, str) and k.lower() in names)
        }
    if isinstance(value, (list, tuple)):
        return [drop_secret_fields(v, extra=extra, keep=keep) for v in value]
    return value


def to_plain(value: Any) -> Any:
    """Convert supabase-py results (pydantic models, dataclasses, datetimes) to JSON-safe values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_plain(v) for v in value]
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode('ascii')
    model_dump = getattr(value, 'model_dump', None)
    if callable(model_dump):
        try:
            return to_plain(model_dump(mode='json'))
        except TypeError:
            return to_plain(model_dump())
    isoformat = getattr(value, 'isoformat', None)
    if callable(isoformat):
        return isoformat()
    if hasattr(value, '__dataclass_fields__'):
        return {k: to_plain(getattr(value, k)) for k in value.__dataclass_fields__}
    if hasattr(value, '__dict__'):
        return {k: to_plain(v) for k, v in vars(value).items() if not k.startswith('_')}
    return str(value)


def first_line(text: str) -> str:
    """First non-empty line of a message (psycopg2/httpx put noisy context below)."""
    for line in (text or '').splitlines():
        if line.strip():
            return line.strip()
    return ''


def describe_exception(exc: BaseException) -> str:
    """One-line description of a library exception: HTTP status/code + message when present."""
    status = getattr(exc, 'status', None) or getattr(exc, 'status_code', None)
    code = getattr(exc, 'code', None)
    message = getattr(exc, 'message', None)
    if not isinstance(message, str) or not message.strip():
        if exc.args and isinstance(exc.args[0], dict):
            message = error_message_from_body(exc.args[0])
            status = status or exc.args[0].get('statusCode') or exc.args[0].get('status')
        else:
            message = first_line(str(exc)) or type(exc).__name__
    parts = []
    if status:
        parts.append(f'HTTP {status}')
    if code and str(code) != str(status):
        parts.append(str(code))
    prefix = f'({", ".join(parts)}) ' if parts else ''
    return f'{prefix}{message.strip()}'
