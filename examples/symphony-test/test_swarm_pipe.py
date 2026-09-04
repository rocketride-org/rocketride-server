"""Run swarm20.pipe: 20 agent nodes inside ONE pipeline, one database each.

Asserts three things, and measures a fourth that turned out to be the point:

1. the engine opens a 64-node graph with 41 control connections on one LLM node;
2. one `db_hotdata` node accepts the answers lane from 20 different agents;
3. every agent produces a correct verdict through that one shared node;
4. how long it takes - which is how the serialization below was found.

MEASURED, and the reason this file exists:

    rooms   1      4      8      20
    time    7s     28s    57s    152s        ~7.6s per agent, near-perfectly linear

The agent nodes in one pipeline run essentially IN SERIES. Twenty agent nodes on
one canvas is not twenty parallel agents. The same twenty agents as twenty
separate pipeline runs finish in ~83s.

Giving each agent its own LLM node instead of sharing one changes nothing (8
rooms: 55s against 57s), so a contended LLM node is not the cause. The mechanism
is not established here - only that it is not that.

NOT tested here: that the 20 private nodes provision 20 genuinely separate
databases. `examples/symphony-test/RESULTS.md` proves separation on data for the
two-node case; this file does not extend that to twenty.

    python3 test_swarm_pipe.py                # 20 agents
    python3 test_swarm_pipe.py --rooms 6      # cheaper
    python3 test_swarm_pipe.py --wiring-only  # opens the graph, runs nothing
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from make_swarm_pipe import build, clues_for_all  # noqa: E402
from test_attach import _load_env  # noqa: E402
from test_option1 import ask, check  # noqa: E402
from test_symphony_waves import LLM_PROFILES, SCORE  # noqa: E402


def verdicts_from(reply: object) -> list[dict]:
    """Every verdict object in the response, whatever nesting it arrived in."""
    found: list[dict] = []
    decoder = json.JSONDecoder()

    def walk(value: object) -> None:
        if isinstance(value, dict):
            if 'beat' in value and 'note' in value:
                found.append(value)
                return
            for item in value.values():
                walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)
        elif isinstance(value, str):
            for index, char in enumerate(value):
                if char in '{[':
                    try:
                        parsed, _end = decoder.raw_decode(value[index:])
                    except ValueError:
                        continue
                    walk(parsed)

    walk(reply)
    return found


async def run(args: argparse.Namespace) -> int:
    from rocketride import RocketRideClient

    rooms = args.rooms
    expected = SCORE[:rooms]
    results: list[bool] = []
    pipe = build(rooms, args.model, args.llm_per_agent)

    node_kinds: dict[str, int] = {}
    for c in pipe['components']:
        node_kinds[c['provider']] = node_kinds.get(c['provider'], 0) + 1
    llm = next(c for c in pipe['components'] if c['id'] == 'llm_1')
    shared = next(c for c in pipe['components'] if c['id'] == 'db_shared_1')

    print(f'ONE pipeline, {len(pipe["components"])} nodes, {rooms} agent nodes')
    print(f'  {len(llm["control"])} control connections on one LLM node')
    print(f'  {len(shared["input"])} agents feeding db_shared_1 through the answers lane')
    print(f'  {rooms} private databases + 1 shared, all inside a single run\n')

    client = RocketRideClient()
    await client.connect()
    token = f'swarm-{uuid.uuid4().hex[:6]}'
    try:
        t_open = time.monotonic()
        try:
            await client.use(pipeline=pipe, token=token, ttl=900)
            opened = True
        except Exception as e:  # noqa: BLE001
            opened = False
            print(f'    open failed: {str(e)[:400]}')
        results.append(
            check(
                f'OPENS: the engine accepts a {len(pipe["components"])}-node graph with {rooms} agents',
                opened,
                f'{time.monotonic() - t_open:.1f}s',
            )
        )
        if not opened:
            return 1
        if args.wiring_only:
            print('\nwiring only, nothing run')
            return 0

        t0 = time.monotonic()
        reply = await ask(client, token, json.dumps(clues_for_all(rooms)))
        elapsed = time.monotonic() - t0

        verdicts = verdicts_from(reply)
        by_beat: dict[int, str] = {}
        for v in verdicts:
            try:
                by_beat.setdefault(int(v['beat']), str(v['note']))
            except (TypeError, ValueError):
                continue

        print(f'\n  {len(by_beat)}/{rooms} rooms answered in {elapsed:.0f}s')
        got = [by_beat.get(b, '?') for b in range(1, rooms + 1)]
        print(f'  melody: {" ".join(got)}')

        results.append(
            check(
                f'FAN-OUT: all {rooms} agent nodes produced a verdict',
                set(by_beat) == set(range(1, rooms + 1)),
                f'missing={sorted(set(range(1, rooms + 1)) - set(by_beat))}',
            )
        )
        results.append(
            check(
                'CORRECT: every verdict beat the decoy',
                got == expected,
                f'expected {" ".join(expected)}',
            )
        )
        # 20 agents run one after another would cost roughly 20x a single agent.
        # A single agent on this puzzle measures ~10-20s, so sequential execution
        # could not finish anywhere near this budget.
        budget = args.sequential_floor
        results.append(
            check(
                f'CONCURRENT: {rooms} agents finished in under {budget:.0f}s, so they did not run in series',
                elapsed < budget,
                f'{elapsed:.0f}s (sequential would be roughly {rooms * 12}s)',
            )
        )
        print()
        print(f'{sum(results)}/{len(results)} checks passed')
        return 0 if all(results) else 1
    finally:
        try:
            await client.terminate(token)
        except Exception:  # noqa: BLE001
            pass
        await client.disconnect()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--rooms', type=int, default=20)
    parser.add_argument('--model', choices=tuple(LLM_PROFILES), default='openai-strong')
    parser.add_argument('--wiring-only', action='store_true')
    parser.add_argument('--llm-per-agent', action='store_true')
    parser.add_argument('--sequential-floor', type=float, default=0.0)
    args = parser.parse_args()
    if not args.sequential_floor:
        # Half of what a strictly sequential run would cost, at ~12s per agent.
        args.sequential_floor = max(60.0, args.rooms * 6.0)
    _load_env()
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
