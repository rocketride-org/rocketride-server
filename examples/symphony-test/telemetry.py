"""The telemetry database: one Hotdata database that outlives every run.

The problem statement is specific about this one. Not a trace viewer, not stdout: a
dedicated Hotdata database, scoped to the whole event rather than a single run, that
every agent and the pipeline itself stream events into, and whose view is queries run
live against it. So the database id is persisted to disk and reused - a second run adds
to the first run's data rather than starting over, which is what makes cross-session
questions answerable at all.

Two writers, deliberately:

* the driver, over REST, for everything it can measure rather than ask for - per-room
  wall clock, wave boundaries, whether the room published, whether it was right;
* every room agent, structurally, through its answers lane into an attached db_hotdata
  node - the same verdict row that goes to shared evidence also lands here, tagged with
  the session.

The driver's rows are measurements. The agents' rows are self-reports. Keeping them in
separate tables keeps that distinction visible instead of blending it away.
"""

from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

HOTDATA_API = 'https://api.hotdata.dev'

#: Where the database id is remembered between runs. Deleting this file starts a new
#: telemetry database and loses the cross-session history.
STATE_FILE = Path(__file__).parent / '.telemetry-db.json'

#: Long enough to span an event, since a Database API Token cannot delete a database
#: anyway (403) and cleanup falls to expiry.
TELEMETRY_TTL = '7d'


class TelemetryError(RuntimeError):
    pass


def _headers(database_id: str = '') -> dict:
    headers = {
        'Authorization': f'Bearer {os.environ["ROCKETRIDE_DB_HOTDATA_KEY"]}',
        'X-Workspace-Id': os.environ['ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID'],
        'Content-Type': 'application/json',
    }
    if database_id:
        headers['X-Database-Id'] = database_id
    return headers


def _call(method: str, path: str, body: dict | None = None, database_id: str = '') -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{HOTDATA_API}{path}', data=data, method=method, headers=_headers(database_id))
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors='replace')
        try:
            return e.code, json.loads(raw or '{}')
        except ValueError:
            return e.code, raw


def _locked(status: int, body: Any) -> bool:
    """The server's own back-pressure: this table is busy, the request did not run."""
    return status == 409 and isinstance(body, dict) and (body.get('error') or {}).get('code') == 'RESOURCE_LOCKED'


class Telemetry:
    """A persistent Hotdata database, and the two things done to it: write and query."""

    def __init__(self, database_id: str = '', enabled: bool = True) -> None:
        self.enabled = enabled
        self.database_id = database_id
        self.created = False
        self.errors: list[str] = []

    # -- lifecycle ------------------------------------------------------

    def open(self) -> str:
        """Return the telemetry database, creating and remembering one the first time.

        Deliberately NOT created by a pipeline: anything a db_hotdata node creates, it
        deletes at teardown. A store that has to outlive runs must be owned by whoever
        owns the demo.
        """
        if not self.enabled:
            return ''
        if self.database_id:
            return self.database_id
        if STATE_FILE.exists():
            try:
                self.database_id = json.loads(STATE_FILE.read_text()).get('database_id', '')
            except (ValueError, OSError):
                self.database_id = ''
        if self.database_id and self._alive():
            return self.database_id

        status, body = _call(
            'POST',
            '/v1/databases',
            {'name': f'symphony-telemetry-{uuid.uuid4().hex[:8]}', 'expires_at': TELEMETRY_TTL},
        )
        if status >= 400:
            raise TelemetryError(f'could not create the telemetry database: {status} {body}')
        self.database_id = body['id']
        self.created = True
        STATE_FILE.write_text(json.dumps({'database_id': self.database_id, 'ttl': TELEMETRY_TTL}, indent=2) + '\n')
        return self.database_id

    def _alive(self) -> bool:
        """Has the remembered database expired? GET by id is 403 for this token, so ask SQL."""
        status, _ = _call('POST', '/v1/query', {'sql': 'SELECT 1'}, database_id=self.database_id)
        return status < 400

    # -- write ----------------------------------------------------------

    def write(self, table: str, rows: list[dict]) -> None:
        """Append rows. Never raises: losing telemetry must not fail the run it measures."""
        if not self.enabled or not rows or not self.database_id:
            return
        try:
            self._write(table, rows)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f'{table}: {str(e)[:200]}')

    def _write(self, table: str, rows: list[dict]) -> None:
        status, body = _call(
            'POST',
            f'/v1/databases/{self.database_id}/schemas/main/tables',
            {'name': table},
            database_id=self.database_id,
        )
        if status >= 400 and status != 409:
            raise TelemetryError(f'create table {table}: {status} {body}')

        payload = ('\n'.join(json.dumps(r, default=str) for r in rows) + '\n').encode()
        upload_id = self._upload(payload)

        # Same contention the node hit: writes to one table are serialized, and a second
        # writer is refused with RESOURCE_LOCKED rather than queued.
        for attempt in range(1, 40):
            status, body = _call(
                'POST',
                f'/v1/databases/{self.database_id}/schemas/main/tables/{table}/loads',
                {'mode': 'append', 'async': True, 'async_after_ms': 5000, 'upload_id': upload_id, 'format': 'json'},
                database_id=self.database_id,
            )
            if not _locked(status, body):
                break
            time.sleep(0.5 * attempt + random.uniform(0, 0.5))
        if status >= 400:
            raise TelemetryError(f'load {table}: {status} {body}')

    def _upload(self, payload: bytes) -> str:
        status, slot = _call(
            'POST',
            '/v1/uploads',
            {
                'filename': f'{uuid.uuid4().hex}.json',
                'content_type': 'application/json',
                'declared_size_bytes': len(payload),
            },
        )
        if status >= 400:
            raise TelemetryError(f'upload slot: {status} {slot}')
        put = urllib.request.Request(slot['url'], data=payload, method='PUT', headers=slot.get('headers') or {})
        with urllib.request.urlopen(put, timeout=120):
            pass
        fin = urllib.request.Request(
            f'{HOTDATA_API}/v1/uploads/{slot["upload_id"]}/finalize',
            data=b'{}',
            method='POST',
            headers={**_headers(), 'X-Upload-Finalize-Token': slot['finalize_token']},
        )
        with urllib.request.urlopen(fin, timeout=120):
            pass
        return slot['upload_id']

    # -- read -----------------------------------------------------------

    def query(self, sql: str) -> tuple[list[str], list[list]]:
        """Run one query and return (columns, rows). Empty on any failure."""
        if not self.enabled or not self.database_id:
            return [], []
        status, body = _call('POST', '/v1/query', {'sql': sql}, database_id=self.database_id)
        if status >= 400 or not isinstance(body, dict):
            return [], []
        return body.get('columns') or [], body.get('rows') or []

    def show(self, title: str, sql: str, note: str = '') -> list[list]:
        """Run a query and print it as a table. This is the telemetry view."""
        columns, rows = self.query(sql)
        print(f'\n  {title}')
        if note:
            print(f'  {note}')
        if not rows:
            print('    (no rows)')
            return []
        widths = [max(len(str(c)), *(len(str(r[i])) for r in rows)) for i, c in enumerate(columns)]
        print('    ' + '  '.join(str(c).ljust(w) for c, w in zip(columns, widths)))
        print('    ' + '  '.join('-' * w for w in widths))
        for row in rows:
            print('    ' + '  '.join(str(v).ljust(w) for v, w in zip(row, widths)))
        return rows
