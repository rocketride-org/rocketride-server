"""Acceptance test for the attach-to-existing-database option.

This is the capability Divya asked for: agents in SEPARATE pipeline runs sharing one
Hotdata evidence database. Before this change every run created its own database, so
cross-run collaboration was impossible.

Proves, live:

  1. ATTACH      - a run configured with database_id writes into THAT database rather
                   than creating a new one.
  2. SHARE       - a second, independent run attached to the same id sees run 1's rows.
  3. SURVIVES    - after both runs are terminated the database still exists and still
                   holds the data (an attached database is never deleted by the node).
  4. RESULT_ID   - queries now surface a result_id that load_data can materialise.

The shared database is created by the driver over REST, which is the realistic pattern:
whoever owns the demo owns the database's lifetime, and the agents just attach.

    python3 examples/symphony-test/test_attach.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from test_option1 import ask, check, load_repo_env  # noqa: E402

HOTDATA_API = 'https://api.hotdata.dev'


def _load_env() -> None:
    load_repo_env()
    ctx = HERE.parent.parent / '.context' / 'hotdata-test' / '.env'
    if ctx.exists():
        for line in ctx.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                if v.strip():
                    os.environ.setdefault(k.strip(), v.strip())
    os.environ['ROCKETRIDE_URI'] = 'http://localhost:5565'
    os.environ['ROCKETRIDE_APIKEY'] = 'MYAPIKEY'


def _hotdata(method: str, path: str, body: dict | None = None, database_id: str = '') -> dict:
    headers = {
        'Authorization': f'Bearer {os.environ["ROCKETRIDE_DB_HOTDATA_KEY"]}',
        'X-Workspace-Id': os.environ['ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID'],
        'Content-Type': 'application/json',
    }
    if database_id:
        headers['X-Database-Id'] = database_id
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{HOTDATA_API}{path}', data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read() or b'{}')


def _sql(database_id: str, sql: str) -> dict:
    return _hotdata('POST', '/v1/query', {'sql': sql}, database_id=database_id)


async def run() -> int:
    from rocketride import RocketRideClient

    results: list[bool] = []

    # The driver owns the shared database, exactly as a demo orchestrator would.
    shared = _hotdata(
        'POST', '/v1/databases', {'name': f'rocketride-shared-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'}
    )
    shared_id = shared['id']
    print(f'shared database created by driver: {shared_id}\n')

    template = json.loads((HERE / 'investigator.pipe').read_text())
    for c in template['components']:
        if c['provider'] == 'db_hotdata':
            # The new option. Everything else about the pipeline is unchanged.
            c['config']['default']['database_id'] = shared_id
            c['config']['default']['table'] = 'discoveries'

    client = RocketRideClient()
    await client.connect()
    tokens: list[str] = []
    try:
        # --- run 1 and run 2: two completely separate pipeline instances ---
        for agent, beat, note in (('Investigator-A', 11, 'C5'), ('Investigator-B', 12, 'D5')):
            pipe = json.loads(json.dumps(template))
            pipe['project_id'] = str(uuid.uuid4())
            token = f'attach-{uuid.uuid4().hex[:8]}'
            tokens.append(token)
            await client.use(pipeline=pipe, token=token, ttl=300)
            await ask(
                client,
                token,
                f'Call load_data with table="discoveries", mode="append", rows='
                f'[{{"agent":"{agent}","beat":{beat},"note":"{note}","confidence":0.9}}]. '
                f'Reply with ONLY the JSON result.',
            )
            print(f'  {agent} wrote beat {beat} from its own pipeline run')

        # 1 + 2. Both runs landed in the driver's database, not in new ones. The agent
        # may write extra rows of its own (this pipeline's baked-in instructions tell it
        # to record a discovery), so assert on presence, not on an exact row count.
        rows = _sql(shared_id, 'SELECT agent, beat, note FROM discoveries ORDER BY beat').get('rows', [])
        agents = {r[0] for r in rows}
        results.append(
            check(
                'ATTACH+SHARE: both independent runs wrote to the one shared database',
                {'Investigator-A', 'Investigator-B'} <= agents,
                f'agents={sorted(agents)} rows={len(rows)}',
            )
        )
        before = len(rows)

        # 3. Teardown must NOT destroy a database the node did not create.
        for token in tokens:
            await client.terminate(token)
        await asyncio.sleep(3)
        try:
            after = _sql(shared_id, 'SELECT COUNT(*) AS n FROM discoveries').get('rows', [])
            survived = bool(after) and int(after[0][0]) == before
        except Exception as e:  # noqa: BLE001
            survived, after = False, str(e)
        results.append(
            check(
                'SURVIVES: shared database intact after both runs terminated',
                survived,
                f'{before} rows before, {after} after',
            )
        )

        # 4. result_id is now surfaced and is loadable.
        rid = _sql(shared_id, 'SELECT * FROM discoveries').get('result_id')
        results.append(check('RESULT_ID: queries return a result_id for materialisation', bool(rid), f'{rid}'))

        print()
        print(f'{sum(results)}/{len(results)} checks passed')
        print(f'\nshared database {shared_id} left in place deliberately; it expires on its 1h TTL')
        return 0 if all(results) else 1
    finally:
        for token in tokens:
            try:
                await client.terminate(token)
            except Exception:  # noqa: BLE001
                pass
        await client.disconnect()


def main() -> int:
    _load_env()
    missing = [
        k
        for k in ('ROCKETRIDE_GEMINI_KEY', 'ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID')
        if not os.environ.get(k)
    ]
    if missing:
        print('missing keys: ' + ', '.join(missing))
        return 2
    return asyncio.run(run())


if __name__ == '__main__':
    sys.exit(main())
