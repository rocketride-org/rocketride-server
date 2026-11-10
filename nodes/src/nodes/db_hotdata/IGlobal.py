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

"""Hotdata node - global (shared) state.

Reads config and builds a REST client. The database itself is created lazily on
the first tool call (creating one costs money and a pipeline may never invoke
the node) and deleted in ``endGlobal``.

Every database carries a TTL. ``endGlobal`` is the real teardown; the TTL is the
crash net for when it never runs. Hotdata documents expiry as best-effort - the
database will not be deleted *before* ``expires_at``, but cleanup may lag - so
the TTL is a backstop, not a substitute for deleting explicitly.
"""

from __future__ import annotations

import threading
import uuid
from typing import Any, Dict, Optional

from rocketlib import IGlobalBase, debug, warning

from .hotdata_client import HotdataClient


class IGlobal(IGlobalBase):
    """Global state for db_hotdata."""

    client: Optional[HotdataClient] = None
    database: Optional[Dict[str, Any]] = None  # created lazily, deleted in endGlobal
    # Guards lazy database creation: agents issue parallel tool calls, and an
    # unsynchronized check-then-act would create two billed databases and orphan
    # one (the failure tool_daytona hit in production with sandboxes).
    _db_lock: Optional[threading.Lock] = None
    # Fingerprints of append payloads already loaded this run. Hotdata has no
    # idempotency key on loads and append duplicates rows, so a retrying agent
    # would silently double the data without this.
    #: fingerprint -> outcome: "pending" while in flight, then "complete"
    #: or "partial". A partial append must keep reporting itself as
    #: partial, or a repeat call is told the table has all the rows.
    _loaded: Optional[dict] = None

    apikey: str = ''
    workspace_id: str = ''
    database_id: str = ''
    attached: bool = False
    ttl: str = '24h'
    table: str = 'pipeline_data'
    db_description: str = ''
    max_attempts: int = 3
    max_execute_rows: int = 25000
    allow_execute: bool = False
    allow_destructive_load: bool = False
    job_timeout_secs: int = 300
    async_after_ms: int = 5000

    def beginGlobal(self) -> None:
        """Read the resolved config and build the REST client; the database itself is created lazily.

        The schema marks the API key and workspace required and bounds every
        numeric setting (async_after_ms at the API's floor of 1000), so the
        resolver has refused anything this method could not run with.
        """
        self._db_lock = threading.Lock()
        self._loaded = {}
        # A reopened global must not inherit the previous run's database handle.
        self.database = None

        cfg = self.config

        self.apikey = cfg.apikey.strip()
        self.workspace_id = cfg.workspace_id.strip()
        self.database_id = cfg.database_id.strip()
        self.attached = False

        self.ttl = cfg.ttl
        self.table = cfg.table.strip()
        self.db_description = cfg.db_description.strip()
        self.max_attempts = cfg.max_attempts
        self.max_execute_rows = cfg.max_execute_rows
        self.allow_execute = cfg.allow_execute
        self.allow_destructive_load = cfg.allow_destructive_load
        self.job_timeout_secs = cfg.job_timeout_secs
        self.async_after_ms = cfg.async_after_ms

        self.client = HotdataClient(
            apikey=self.apikey,
            workspace_id=self.workspace_id,
            base_url=cfg.api_url.strip(),
            retry_budget_s=float(self.job_timeout_secs),
        )

    def get_database(self) -> Dict[str, Any]:
        """Return this run's database, creating it on first use.

        Always carries a TTL so an engine crash cannot leave a billed database
        running forever.
        """
        database = self.database
        if database is None:
            with self._db_lock:
                if self.database is None:
                    if self.database_id:
                        self.database = {
                            'id': self.database_id,
                            'default_schema': 'main',
                            'attached': True,
                        }
                        self.attached = True
                        debug(f'db_hotdata: attached to database {self.database_id}')
                    else:
                        name = f'rocketride-{uuid.uuid4().hex[:12]}'
                        self.database = self.client.create_database(name=name, expires_at=self.ttl)
                        debug(f'db_hotdata: created database {self.database.get("id", "?")} (ttl {self.ttl})')
                database = self.database
        return database

    def seen_load(self, fingerprint: str) -> Optional[str]:
        """Reserve an append payload; return the prior outcome if there was one.

        Append is not idempotent on Hotdata's side, so a repeated identical load
        would duplicate rows. Checked and recorded atomically because agents fire
        tool calls in parallel.

        Returns None when this payload is new (and reserves it), otherwise the
        stored outcome: ``pending``, ``complete`` or ``partial``. The caller must
        call ``release_load`` if the load then fails, or ``record_load`` with the
        final outcome once it settles.
        """
        if self._loaded is None:
            self._loaded = {}
        with self._db_lock:
            existing = self._loaded.get(fingerprint)
            if existing is not None:
                return existing
            self._loaded[fingerprint] = 'pending'
            return None

    def record_load(self, fingerprint: str, outcome: str) -> None:
        """Record how a reserved load finished: 'complete' or 'partial'."""
        if self._loaded is None:
            self._loaded = {}
        with self._db_lock:
            self._loaded[fingerprint] = outcome

    def release_load(self, fingerprint: str) -> None:
        """Undo a reservation whose load did not complete, so a retry can run."""
        if not self._loaded:
            return
        with self._db_lock:
            self._loaded.pop(fingerprint, None)

    def drop_database(self, database: Dict[str, Any]) -> None:
        """Forget a database the server reports gone.

        Expiry is best-effort but it does fire; dropping the stale handle lets
        the next get_database() create a fresh one instead of failing forever.
        """
        if self.attached:
            return
        with self._db_lock:
            if self.database is database:
                self.database = None
                # The append fingerprints describe the contents of that specific
                # database. Keeping them would make an identical append to the
                # replacement database report deduplicated without loading.
                if self._loaded:
                    self._loaded.clear()

    def endGlobal(self) -> None:
        if self.database is not None and self.client is not None:
            database_id = self.database.get('id')
            if self.attached:
                debug(f'db_hotdata: attached database {database_id or "?"} left in place')
            else:
                try:
                    if database_id:
                        self.client.delete_database(database_id)
                        debug(f'db_hotdata: deleted database {database_id}')
                except Exception as e:
                    # Teardown must never fail a pipeline. The TTL still bounds the
                    # cost, it just takes longer than an explicit delete.
                    warning(f'db_hotdata: database delete failed: {e}')
        # Cleared on BOTH paths. Only the remote delete is conditional: keeping an
        # attached handle past teardown would let a second beginGlobal on the same
        # object - which resets `attached` to False - inherit a database it does
        # not own and delete it at the next teardown.
        self.database = None
        self.attached = False
        self.client = None
        self.apikey = ''
        self.workspace_id = ''
