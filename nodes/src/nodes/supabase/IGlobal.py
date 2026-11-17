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
Shared global lifecycle for the Supabase tool services.

Each service subpackage (auth/, storage/, messaging/, functions/, cron/)
subclasses :class:`SupabaseGlobalBase`, sets ``SERVICE`` (its tool prefix,
equal to ``prefix`` in its services.json), ``PRODUCT`` (a label for messages),
``CONNECTION`` (``API`` or ``POSTGRES``) and ``LIMITS`` (its numeric
settings), and inherits beginGlobal / validateConfig / endGlobal. A service
that derives values from its limits does so in :meth:`_after_begin`.

Database and Vector do NOT use this class: they subclass the db_postgres /
store_postgres globals so their behaviour stays identical to those nodes.
"""

from __future__ import annotations

import contextlib
import os
import threading
from typing import Any, Dict, Iterator, List, Optional, Tuple

from ai.common.config import Config, check_credential_resolved
from ai.common.utils import config_int
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from . import supabase_client as sc

API = 'api'
POSTGRES = 'postgres'

_REQUIREMENTS = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')

# The config fields that hold credentials or where they point, per connection
# kind. A ${ROCKETRIDE_*} placeholder left in one of them means the variable is
# not set; that is reported by name before anything is sent.
_CREDENTIAL_FIELDS = {API: ('url', 'secretKey'), POSTGRES: ('host', 'user', 'password')}


class SupabaseGlobalBase(IGlobalBase):
    """Resolved access level + connection for one Supabase service."""

    SERVICE: str = 'supabase'  # tool prefix, e.g. 'supabase_auth'
    PRODUCT: str = 'Supabase'  # label used in messages, e.g. 'Supabase Auth'
    CONNECTION: str = API  # API (URL + secret key) or POSTGRES (pooler)
    TIMEOUT: int = sc.DEFAULT_TIMEOUT  # seconds per HTTP call (API services)

    # Numeric settings: config key -> (attribute, default, minimum, maximum).
    # The numbers are those of the <prefix>.<key> field in services.<svc>.json
    # (test_limits.py checks that they match); beginGlobal sets each attribute
    # with the same clamp.
    LIMITS: Dict[str, Tuple[str, int, int, int]] = {}

    # The access levels this service offers: the enum of supabase.access in its
    # services.<svc>.json (test_common_fields.py checks they match). A service
    # with no tool at a level leaves that level out (Cron: read and admin).
    ACCESS_LEVELS: Tuple[str, ...] = sc.ACCESS_LEVELS

    access: str = sc.DEFAULT_ACCESS
    connection: Any = None  # sc.ApiConnection | sc.PostgresConnection
    redactor: Optional[sc.Redactor] = None
    no_tools_reported: bool = False  # the instance base says "no tools at this level" once per node

    _client: Any = None
    _api: Any = None
    _lock: Optional[threading.Lock] = None

    # ------------------------------------------------------------------
    # Hooks for services
    # ------------------------------------------------------------------

    def _after_begin(self, cfg: Dict[str, Any]) -> None:
        """Derive service-specific values after LIMITS were read (default: none)."""

    # ------------------------------------------------------------------
    # Engine lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Resolve the access level, the connection and the limits; stop start-up on bad settings.

        Raises:
            SupabaseConfigError: a required field is blank or invalid (the message names it).
            UnresolvedCredentialError: a credential still holds a ${ROCKETRIDE_*} placeholder.
        """
        # The editor opens nodes in CONFIG mode just to validate settings:
        # never install dependencies or open connections there.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._load_requirements()
        cfg = self._node_config()
        try:
            self._configure(cfg)
        except sc.SupabaseConfigError as e:
            # Stop start-up with a message naming the service and the field; no fallbacks.
            raise sc.SupabaseConfigError(f'{self.SERVICE}: {e}') from None
        self._read_limits(cfg)
        self._after_begin(cfg)
        debug(f'{self.SERVICE}: ready (access={self.access}, connection={self.connection!r})')

    def validateConfig(self) -> None:
        """Warn (never raise) about missing or invalid settings."""
        try:
            cfg = self._node_config()
            problems: List[str] = []
            try:
                sc.normalize_access(cfg.get('access'), self.ACCESS_LEVELS)
            except sc.SupabaseConfigError as e:
                problems.append(str(e))
            if self.CONNECTION == API:
                problems.extend(sc.api_config_problems(cfg))
            else:
                problems.extend(sc.postgres_config_problems(cfg))
            for problem in problems:
                warning(f'{self.PRODUCT}: {problem}')
        except Exception as e:
            warning(f'{self.PRODUCT}: {self.redact(str(e))}')

    def endGlobal(self) -> None:
        """Close the HTTP clients and drop the connection settings (and with them the secrets)."""
        api, self._api = self._api, None
        if api is not None:
            api.close()
        client, self._client = self._client, None
        sc.close_client(client)
        self.connection = None
        self.redactor = None

    # ------------------------------------------------------------------
    # Internals (overridable in tests)
    # ------------------------------------------------------------------

    def _load_requirements(self) -> None:
        from depends import depends  # type: ignore

        depends(_REQUIREMENTS)

    def _node_config(self) -> Dict[str, Any]:
        return Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

    def _configure(self, cfg: Dict[str, Any]) -> None:
        """Resolve access + connection; raises SupabaseConfigError (a ValueError) on bad settings."""
        self.access = sc.normalize_access(cfg.get('access'), self.ACCESS_LEVELS)
        for name in _CREDENTIAL_FIELDS.get(self.CONNECTION, ()):
            # Otherwise the placeholder text itself is sent as the URL, key or password.
            check_credential_resolved(self.glb.logicalType, name, cfg.get(name), self.glb.connConfig)
        if self.CONNECTION == API:
            self.connection = sc.resolve_api_connection(cfg)
        elif self.CONNECTION == POSTGRES:
            self.connection = sc.resolve_postgres_connection(cfg)
        else:
            raise ValueError(f'{self.SERVICE}: unknown CONNECTION {self.CONNECTION!r}')
        self.redactor = sc.Redactor(self.connection.secrets())
        self._lock = threading.Lock()
        self.no_tools_reported = False
        self._client = None
        self._api = None

    def _read_limits(self, cfg: Dict[str, Any]) -> None:
        """Set every LIMITS attribute from the config, clamped to its bounds."""
        for key, (attr, default, minimum, maximum) in self.LIMITS.items():
            setattr(self, attr, config_int(cfg, key, default, min_value=minimum, max_value=maximum))

    def _require_open(self, kind: str) -> None:
        if self.connection is None:
            raise RuntimeError(f'{self.SERVICE}: node is not open')
        if self.CONNECTION != kind:
            raise RuntimeError(f'{self.SERVICE}: this service has no {kind} connection')

    # ------------------------------------------------------------------
    # Accessors used by the instance base
    # ------------------------------------------------------------------

    def get_client(self) -> Any:
        """Shared supabase-py client, built on first use (thread-safe)."""
        self._require_open(API)
        client = self._client
        if client is None:
            with self._lock:
                if self._client is None:
                    self._client = sc.build_client(self.connection, timeout=self.TIMEOUT)
                client = self._client
        return client

    def get_api(self) -> sc.SupabaseApi:
        """Shared HTTP helper for REST endpoints supabase-py does not wrap."""
        self._require_open(API)
        api = self._api
        if api is None:
            with self._lock:
                if self._api is None:
                    self._api = sc.SupabaseApi(self.connection, timeout=self.TIMEOUT)
                api = self._api
        return api

    @contextlib.contextmanager
    def postgres(self) -> Iterator[Any]:
        """Open a pooler connection (TLS required) for one call; commit on success, roll back on error."""
        self._require_open(POSTGRES)
        conn = sc.connect_postgres(self.connection)
        try:
            yield conn
            conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def redact(self, text: Any) -> str:
        """Redact secrets from a message. Safe to call before beginGlobal."""
        return (self.redactor or sc.Redactor()).redact(text)
