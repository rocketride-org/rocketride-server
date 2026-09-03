"""Isolate what happens when N runs append to ONE attached Hotdata table at once.

The symphony run showed one room in six failing on
``POST /v1/databases/{id}/schemas/main/tables/discoveries/loads``. That is the shape
every shared-evidence and telemetry design depends on, so it needs a status code and a
body rather than a guess. This drives the same three calls the node makes - create
table, upload, load - from N threads, and reports exactly what comes back.

    python3 examples/symphony-test/probe_concurrent_loads.py --writers 8
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from test_attach import _hotdata, _load_env, _sql  # noqa: E402

HOTDATA_API = 'https://api.hotdata.dev'

#: Set by main(): whether to replay a 409 RESOURCE_LOCKED, which is what the node now does.
RETRY = False


def _require_env(*names: str) -> int:
    """Report missing credentials by name instead of dying on a raw KeyError."""
    import os

    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print('missing environment variable(s): ' + ', '.join(missing))
        return 2
    return 0


def _call(method: str, path: str, body: dict | None = None, database_id: str = '') -> tuple[int, dict | str]:
    """Like _hotdata, but returns the status and body instead of raising."""
    headers = {
        'Authorization': f'Bearer {os.environ["ROCKETRIDE_DB_HOTDATA_KEY"]}',
        'X-Workspace-Id': os.environ['ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID'],
        'Content-Type': 'application/json',
    }
    if database_id:
        headers['X-Database-Id'] = database_id
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{HOTDATA_API}{path}', data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors='replace')
        try:
            return e.code, json.loads(raw or '{}')
        except ValueError:
            return e.code, raw


def _upload(payload: bytes) -> str:
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
        raise RuntimeError(f'upload slot {status}: {slot}')
    put = urllib.request.Request(slot['url'], data=payload, method='PUT', headers=slot.get('headers') or {})
    with urllib.request.urlopen(put, timeout=120):
        pass
    # The upload stays in 'awaiting_upload' until finalized, and a load against an
    # unfinalized upload comes back 409 CONFLICT - a different 409 from the one this
    # probe is hunting, so it has to be ruled out.
    fin = urllib.request.Request(
        f'{HOTDATA_API}/v1/uploads/{slot["upload_id"]}/finalize',
        data=b'{}',
        method='POST',
        headers={
            'Authorization': f'Bearer {os.environ["ROCKETRIDE_DB_HOTDATA_KEY"]}',
            'X-Workspace-Id': os.environ['ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID'],
            'Content-Type': 'application/json',
            'X-Upload-Finalize-Token': slot['finalize_token'],
        },
    )
    with urllib.request.urlopen(fin, timeout=120):
        pass
    return slot['upload_id']


def writer(database_id: str, table: str, index: int) -> dict:
    """One room's publish: exactly what db_hotdata's load_data does."""
    out: dict = {'writer': index}
    t0 = time.monotonic()
    # 1. ensure the table (409 = already there, which the node treats as success)
    status, body = _call(
        'POST', f'/v1/databases/{database_id}/schemas/main/tables', {'name': table}, database_id=database_id
    )
    out['create_table'] = status
    if status >= 400 and status != 409:
        out['create_body'] = body
    # 2. upload the row
    row = json.dumps({'room': f'room-{index}', 'beat': index, 'note': 'C4'}).encode() + b'\n'
    try:
        upload_id = _upload(row)
    except Exception as e:  # noqa: BLE001
        out['upload_error'] = str(e)[:300]
        return out
    # 3. load it, optionally retrying the server's own "retry shortly" back-pressure
    attempts = 0
    while True:
        attempts += 1
        status, body = _call(
            'POST',
            f'/v1/databases/{database_id}/schemas/main/tables/{table}/loads',
            {'mode': 'append', 'async': True, 'async_after_ms': 5000, 'upload_id': upload_id, 'format': 'json'},
            database_id=database_id,
        )
        locked = status == 409 and isinstance(body, dict) and (body.get('error') or {}).get('code') == 'RESOURCE_LOCKED'
        if not (locked and RETRY and attempts < 40):
            break
        time.sleep(0.5 * attempts + random.uniform(0, 0.5))
    out['load'] = status
    out['attempts'] = attempts
    out['load_body'] = body if status >= 400 else {'state': (body or {}).get('state')}
    out['secs'] = round(time.monotonic() - t0, 1)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--writers', type=int, default=8)
    parser.add_argument('--rounds', type=int, default=1)
    parser.add_argument('--prewarm', action='store_true', help='create the table before fanning out')
    parser.add_argument('--retry', action='store_true', help="replay the server's RESOURCE_LOCKED back-pressure")
    args = parser.parse_args()
    global RETRY
    RETRY = args.retry
    _load_env()
    missing = _require_env('ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID')
    if missing:
        return missing

    db = _hotdata('POST', '/v1/databases', {'name': f'probe-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'})
    database_id = db['id']
    table = 'discoveries'
    print(f'database {database_id}, {args.writers} concurrent writers x {args.rounds} round(s), table {table}')
    if args.prewarm:
        status, _ = _call(
            'POST', f'/v1/databases/{database_id}/schemas/main/tables', {'name': table}, database_id=database_id
        )
        print(f'  pre-created table: {status}')

    failures = 0
    for round_index in range(args.rounds):
        base = round_index * args.writers
        with ThreadPoolExecutor(max_workers=args.writers) as pool:
            results = list(pool.map(lambda i: writer(database_id, table, i), range(base + 1, base + args.writers + 1)))
        for r in results:
            ok = r.get('load') == 200 or r.get('load') == 202
            if not ok:
                failures += 1
            print(f'  {"ok  " if ok else "FAIL"} {r}')

    time.sleep(5)
    rows = _sql(database_id, f'SELECT COUNT(*) AS n FROM {table}').get('rows', [])
    landed = rows[0][0] if rows else '?'
    expected = args.writers * args.rounds
    print(f'\nrows landed: {landed}/{expected}   load failures: {failures}')
    print(f'database {database_id} left to its 1h TTL')
    return 0 if failures == 0 and str(landed) == str(expected) else 1


if __name__ == '__main__':
    sys.exit(main())
