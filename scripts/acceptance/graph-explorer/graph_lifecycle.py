# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Lifecycle acceptance: what a tool caller sees for unwired, stopped and restarting tasks.

Real engine + Python SDK + FalkorDB (fast; no emulation). Reports the server's
codes exactly as the SDK exposes them (CommandException.code), which is what
the shared library's states and its one-retry rule key on.

Usage (from dist/server): ./engine <this folder>/graph_lifecycle.py [ENGINE_URL]
Settings come from the environment; see local_env.py.
"""

import asyncio
import json
import sys
import time
import uuid

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_env as E  # noqa: E402 - after the sys.path line above
from rocketride import CommandException, RocketRideClient  # noqa: E402

URI = sys.argv[1] if len(sys.argv) > 1 else E.ENGINE_URL
CFG = {'host': E.FALKORDB_HOST, 'port': E.FALKORDB_PORT, 'graph': E.ACCEPT_GRAPH, 'allow_execute': False}
TOOLS = E.TOOLS_SOURCE
rows = []


def check(name, ok, detail=None):
    rows.append({'check': name, 'status': 'PASS' if ok else 'FAIL', 'detail': detail})
    print(f'  [{"PASS" if ok else "FAIL"}] {name}' + (f' -- {detail}' if detail is not None else ''), flush=True)


def pipe(wired: bool, project_id: str):
    node = {
        'id': 'graph_falkordb_1',
        'provider': 'graph_falkordb',
        'name': 'Graph',
        'config': {'profile': 'default', 'default': CFG, 'name': 'Graph'},
    }
    if wired:
        node['control'] = [{'classType': 'tool', 'from': 'tools_1'}]
    return {'project_id': project_id, 'components': [TOOLS, node]}


async def find_task(client, project_id, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for t in await client.get_tasks():
            if (t.get('pipeline') or {}).get('project_id') == project_id and t.get('source') == 'tools_1':
                return t
        await asyncio.sleep(0.5)
    return None


async def tool(client, token, name='dialect'):
    try:
        return ('ok', await client.tool(token=token, tool=name, node_id='graph_falkordb_1', input={}, timeout=40_000))
    except CommandException as e:
        return ('err', {'code': e.code, 'message': str(e).split('\n')[0][:160]})


async def main():
    async with RocketRideClient(uri=URI, auth=E.API_KEY) as client:
        # 1. A graph node that is not wired to the tools source.
        pid = str(uuid.uuid4())
        await client.use(pipeline=pipe(False, pid), source='tools_1')
        t = await find_task(client, pid)
        check('unwired: task is listed by getTasks', t is not None)
        if t:
            kind, res = await tool(client, t['token'])
            check('unwired: dialect probe fails as a call error (app shows Unreachable)', kind == 'err', res)
            await client.terminate(t['token'])

        # 2. A stopped task: the old token after terminate.
        pid = str(uuid.uuid4())
        await client.use(pipeline=pipe(True, pid), source='tools_1')
        t = await find_task(client, pid)
        kind, res = await tool(client, t['token'])
        check('wired: dialect answers', kind == 'ok' and res.get('dialect') == 'falkordb', res)
        old = t['token']
        await client.terminate(old)
        await asyncio.sleep(1)
        kind, res = await tool(client, old)
        check('stopped: call fails with a machine-readable code', kind == 'err' and bool(res.get('code')), res)
        listed = await find_task(client, pid, timeout=2)
        check('stopped: getTasks no longer lists it (app shows Stopped from its own memory)', listed is None)

        # 3. Restart: token identity and what a call sees during the restart window.
        pid = str(uuid.uuid4())
        p = pipe(True, pid)
        await client.use(pipeline=p, source='tools_1')
        t = await find_task(client, pid)
        t1 = t['token']
        seen = []
        errors = []

        async def hammer():
            end = time.monotonic() + 20
            while time.monotonic() < end:
                kind, res = await tool(client, t1)
                seen.append(res['code'] if kind == 'err' else 'ok')
                if kind == 'err':
                    errors.append(res)
                if len(seen) > 3 and seen[-1] == 'ok' and 'TASK_STOPPED' in seen:
                    break
                await asyncio.sleep(0.05)

        hammering = asyncio.create_task(hammer())
        await asyncio.sleep(0.3)
        await client.restart(project_id=pid, source='tools_1', pipeline=p, token=t1)
        await hammering
        t_after = await find_task(client, pid)
        codes = sorted({str(c) for c in seen if c != 'ok'})
        uniq = {}
        for e in errors:
            uniq.setdefault((e['code'], e['message']), 0)
            uniq[(e['code'], e['message'])] += 1
        print(
            '  restart-window errors:',
            json.dumps([{'code': k[0], 'message': k[1], 'count': v} for k, v in uniq.items()]),
        )
        check(
            'restart: task tokens are deterministic (same token after restart)',
            t_after is not None and t_after['token'] == t1,
        )
        # Without an observed TASK_STOPPED the next check would pass vacuously: the
        # calls missed the restart window, so nothing was tested. Rerun when this fails.
        check(
            'restart: a call during the window saw TASK_STOPPED (the window was observed)',
            'TASK_STOPPED' in codes,
            {'codes': codes, 'calls': len(seen)},
        )
        check(
            'restart: calls during the window fail only with TASK_STOPPED (never another code)',
            set(codes) <= {'TASK_STOPPED'},
            {'codes': codes, 'calls': len(seen)},
        )
        check('restart: calls succeed again on the same token afterwards', seen and seen[-1] == 'ok', seen[-5:])
        await client.terminate(t1)

    failed = [r for r in rows if r['status'] != 'PASS']
    print(json.dumps({'passed': len(rows) - len(failed), 'failed': len(failed)}))
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
