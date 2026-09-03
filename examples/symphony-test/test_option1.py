"""Feasibility test for Symphony Escape option 1: the shared-database hub.

Proves, against a real engine and the real Hotdata API:

  1. WIRING     - the engine accepts two agent nodes sharing one db_hotdata tool
                  node (plus a private db node each) in a single pipeline.
  2. SHARED     - both agents report the SAME database_id from the shared node.
  3. PRIVATE    - each agent's private node is a DIFFERENT database.
  4. COORDINATE - a row loaded by agent A through the shared node is read back
                  by agent B with SQL. No message passing between agents.
  5. PUBLISH    - a separate investigator run (its own pipeline, its own private
                  database) produces a discovery; the driver relays it into the
                  hub; agent B reads it from the shared database.

Run modes:
  python test_option1.py --wiring-only   # no Hotdata/Anthropic keys needed:
                                         # proves the engine accepts the graph
  python test_option1.py                 # full run, needs real keys in .env

Needs ROCKETRIDE_URI / ROCKETRIDE_APIKEY (local engine defaults are fine), and
for the full run ROCKETRIDE_ANTHROPIC_KEY, ROCKETRIDE_DB_HOTDATA_KEY,
ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).parent


def _iter_strings(blob: Any) -> Iterable[str]:
    if isinstance(blob, str):
        yield blob
    elif isinstance(blob, dict):
        for v in blob.values():
            yield from _iter_strings(v)
    elif isinstance(blob, (list, tuple)):
        for v in blob:
            yield from _iter_strings(v)


_FENCE = re.compile(r'```(?:json)?\s*(.*?)\s*```', re.DOTALL)


def extract_json(response: Any, required: str) -> dict | None:
    """Find the JSON object containing `required` anywhere in a response."""
    for text in _iter_strings(response):
        candidates = [text, *_FENCE.findall(text)]
        start, end = text.find('{'), text.rfind('}')
        if start != -1 and end > start:
            candidates.append(text[start : end + 1])
        for c in candidates:
            try:
                parsed = json.loads(c)
            except (ValueError, TypeError):
                continue
            if isinstance(parsed, dict) and required in parsed:
                return parsed
    return None


def check(name: str, ok: bool, detail: str = '') -> bool:
    mark = 'PASS' if ok else 'FAIL'
    print(f'  [{mark}] {name}' + (f'  ({detail})' if detail else ''))
    return ok


async def ask(client, token: str, text: str) -> Any:
    from rocketride.schema import Question

    q = Question()
    q.addQuestion(text)
    return await client.chat(token=token, question=q)


def reply_for(response: Any, agent: str) -> Any:
    """Both hub agents answer every message; the off-target one says SKIP.

    Collect every string and drop the SKIPs so assertions look at the real reply.
    """
    texts = [t for t in _iter_strings(response) if t.strip() and t.strip() != 'SKIP']
    return texts


async def run(args: argparse.Namespace) -> int:
    from rocketride import RocketRideClient

    fake = args.wiring_only
    if fake:
        # beginGlobal only requires the values to be non-empty; the database is
        # created lazily on first tool call, which a wiring test never makes.
        os.environ.setdefault('ROCKETRIDE_DB_HOTDATA_KEY', 'wiring-test-fake-key')
        os.environ.setdefault('ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID', 'wiring-test-fake-ws')
        os.environ.setdefault('ROCKETRIDE_GEMINI_KEY', 'wiring-test-fake-key')

    client = RocketRideClient()
    await client.connect()
    results: list[bool] = []
    hub_token = f'symtest-hub-{uuid.uuid4().hex[:8]}'
    try:
        # ------------------------------------------------------------------
        # 1. WIRING: does the engine accept the shared-tool graph at all?
        # ------------------------------------------------------------------
        hub = json.loads((HERE / 'hub.pipe').read_text())
        try:
            await client.use(pipeline=hub, token=hub_token, ttl=300)
            results.append(check('wiring: hub pipeline opened (2 agents share 1 db node)', True))
        except Exception as e:
            results.append(check('wiring: hub pipeline opened', False, str(e)[:200]))
            return 1

        if fake:
            print(
                '\nWiring-only mode: graph accepted by the engine. '
                'Run without --wiring-only (with real keys) for the data-path proof.'
            )
            return 0

        # ------------------------------------------------------------------
        # 2 + 3. SHARED and PRIVATE database identity
        # ------------------------------------------------------------------
        ra = await ask(
            client,
            hub_token,
            'CriticA: call db_shared_1.get_schema and db_priv_a_1.get_schema. '
            'Reply with ONLY this JSON: {"shared": <database_id from db_shared_1>, '
            '"private": <database_id from db_priv_a_1>}',
        )
        a = extract_json(ra, 'shared')
        rb = await ask(
            client,
            hub_token,
            'ConductorB: call db_shared_1.get_schema and db_priv_b_1.get_schema. '
            'Reply with ONLY this JSON: {"shared": <database_id from db_shared_1>, '
            '"private": <database_id from db_priv_b_1>}',
        )
        b = extract_json(rb, 'shared')

        ok_ids = a is not None and b is not None
        results.append(check('agents returned database ids', ok_ids, f'A={a} B={b}' if not ok_ids else ''))
        if ok_ids:
            results.append(
                check(
                    'SHARED: same database via shared node',
                    a['shared'] == b['shared'],
                    f'{a["shared"]} == {b["shared"]}',
                )
            )
            # Reported ids are informational only. Small models sometimes echo one
            # id into both fields (same class of error as the get_schema column
            # miscount in .context/hotdata-test/FINDINGS.md), so isolation is
            # asserted on data below, never on what the agent says its id is.
            if a['private'] == b['private']:
                print(
                    f'       note: agent reported identical private ids '
                    f'({a["private"]}) - verifying against data instead'
                )

        # PRIVATE, proven with data: A writes a marker into its own private
        # database; B counts rows in its own. Same database would show A's row.
        await ask(
            client,
            hub_token,
            'CriticA: call db_priv_a_1.load_data with table="scratch", mode="append", '
            'rows=[{"marker":"A-ONLY"}]. Reply with ONLY the JSON result.',
        )
        rb2 = await ask(
            client,
            hub_token,
            'ConductorB: using db_priv_b_1.execute, run: SELECT COUNT(*) AS n FROM scratch. '
            'If the table does not exist that means zero rows. '
            'Reply with ONLY this JSON: {"n": <the count, or 0 if the table is missing>}',
        )
        ra2 = await ask(
            client,
            hub_token,
            'CriticA: using db_priv_a_1.execute, run: SELECT COUNT(*) AS n FROM scratch. '
            'Reply with ONLY this JSON: {"n": <the count>}',
        )
        nb, na = extract_json(rb2, 'n'), extract_json(ra2, 'n')
        results.append(
            check(
                "PRIVATE: B cannot see A's marker (separate databases)",
                bool(na and nb is not None and int(na['n']) >= 1 and int(nb['n']) == 0),
                f'A={na} B={nb}',
            )
        )

        # ------------------------------------------------------------------
        # 4. COORDINATE through the shared database, no message passing
        # ------------------------------------------------------------------
        await ask(
            client,
            hub_token,
            'CriticA: call db_shared_1.load_data with table="discoveries", mode="append", rows='
            '[{"agent":"CriticA","beat":3,"note":"G4","confidence":0.95}]. '
            'Reply with ONLY the JSON result.',
        )
        rq = await ask(
            client,
            hub_token,
            'ConductorB: using db_shared_1.execute, run: '
            'SELECT note FROM discoveries WHERE beat = 3. '
            'Reply with ONLY this JSON: {"beat3_note": <the note value>}',
        )
        q = extract_json(rq, 'beat3_note')
        results.append(
            check(
                'COORDINATE: B read the row A published (via shared DB only)',
                bool(q and q.get('beat3_note') == 'G4'),
                f'got {q}',
            )
        )

        # ------------------------------------------------------------------
        # 5. PUBLISH from an isolated investigator run into the hub
        # ------------------------------------------------------------------
        inv = json.loads((HERE / 'investigator.pipe').read_text())
        inv['project_id'] = str(uuid.uuid4())
        inv_token = f'symtest-inv-{uuid.uuid4().hex[:8]}'
        await client.use(pipeline=inv, token=inv_token, ttl=300)
        payload = {
            'agent': 'Investigator-07',
            'beat': 7,
            'clues': [
                {'beat': 7, 'note': 'A4', 'source': 'cipher'},
                {'beat': 7, 'note': 'A4', 'source': 'echo'},
                {'beat': 7, 'note': 'B4', 'source': 'decoy'},
            ],
        }
        try:
            # A chat source returns the agent's answer directly; a webhook source
            # returns only object metadata (its results need SSE or a response poll).
            inv_resp = await ask(client, inv_token, json.dumps(payload))
        finally:
            try:
                await client.terminate(inv_token)
            except Exception:
                pass
        d = extract_json(inv_resp, 'discovery')
        results.append(
            check('investigator solved in its own database', bool(d and d['discovery'].get('note') == 'A4'), f'got {d}')
        )
        if d:
            results.append(
                check(
                    'ISOLATION: investigator database differs from hub shared',
                    bool(a) and d.get('database_id') not in (a.get('shared'), a.get('private')),
                    f'inv={d.get("database_id")}',
                )
            )
            relay = json.dumps([d['discovery']], separators=(',', ':'))
            await ask(
                client,
                hub_token,
                f'CriticA: call db_shared_1.load_data with table="discoveries", mode="append", rows={relay}. '
                'Reply with ONLY the JSON result.',
            )
            rf = await ask(
                client,
                hub_token,
                'ConductorB: using db_shared_1.execute, run: '
                'SELECT COUNT(*) AS n FROM discoveries. '
                'Reply with ONLY this JSON: {"n": <the count>}',
            )
            f = extract_json(rf, 'n')
            results.append(
                check('PUBLISH: relayed discovery visible in shared DB', bool(f and int(f['n']) >= 2), f'got {f}')
            )

        print()
        passed = sum(results)
        print(f'{passed}/{len(results)} checks passed')
        return 0 if all(results) else 1
    finally:
        try:
            await client.terminate(hub_token)
        except Exception:
            pass
        await client.disconnect()


REPO_ROOT = HERE.parent.parent


def load_repo_env() -> int:
    """Inject ROCKETRIDE_* values from the repo-root .env into os.environ.

    The SDK reads .env only from the current working directory and lets
    os.environ win over it, so doing this ourselves makes the test work from
    any directory and keeps the engine URI under our control rather than the
    shared one the repo .env points at.
    """
    found = 0
    # .context/hotdata-test/.env holds the live Hotdata workspace credentials
    # used by the earlier vendor harness; the repo-root .env is the fallback.
    for env_path in (REPO_ROOT / '.context' / 'hotdata-test' / '.env', REPO_ROOT / '.env'):
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key.startswith('ROCKETRIDE_') and value:
                os.environ.setdefault(key, value)
                found += 1
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--wiring-only', action='store_true', help='no real keys: only prove the engine accepts the shared-node graph'
    )
    parser.add_argument(
        '--uri', default='http://localhost:5565', help='engine to test against (default: the local build)'
    )
    parser.add_argument('--apikey', default=None, help='engine API key (defaults to the dev key for a local engine)')
    args = parser.parse_args()

    load_repo_env()
    # Pin the engine explicitly: os.environ wins inside the SDK, and the repo
    # .env points at a shared server rather than this local build.
    os.environ['ROCKETRIDE_URI'] = args.uri
    if args.apikey:
        os.environ['ROCKETRIDE_APIKEY'] = args.apikey
    elif 'localhost' in args.uri or '127.0.0.1' in args.uri:
        os.environ['ROCKETRIDE_APIKEY'] = 'MYAPIKEY'

    missing = [
        k
        for k in ('ROCKETRIDE_GEMINI_KEY', 'ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID')
        if not os.environ.get(k)
    ]
    print(f'engine:  {args.uri}')
    print(f'keys:    {"all present" if not missing else "missing " + ", ".join(missing)}')
    if missing and not args.wiring_only:
        print('\nAdd the missing keys to the repo-root .env, or run with --wiring-only.')
        return 2
    print()
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
