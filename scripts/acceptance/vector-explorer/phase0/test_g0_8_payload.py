# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""G0-8: 1 MB and 4 MB tool answers round-trip through the Python and TypeScript clients.

The receiver probe's ``payload`` tool answers with about the requested number
of bytes of JSON (4-decimal floats, like a ``sample`` answer). Each client must
get the whole answer back. Latencies, and what the DAP tool path spends
trimming the answer for its trace event (``_trim_tool_data`` serializes the
whole answer to keep 2 KB), are recorded in out/phase0/g0_8_payload.json.

The TypeScript run needs node and the CommonJS build of
packages/client-typescript (``./builder client-typescript:build``).

Needs the probe nodes: start the engine with --node_path=<repo>/nodes/test/vx_context_probe.
"""

from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

from phase0_lib import API_KEY, ENGINE_URL, REPO, client, record, run

pytestmark = pytest.mark.timeout(900)

SIZES = (1 * 1024 * 1024, 4 * 1024 * 1024)
ROUNDS = 3
HERE = Path(__file__).resolve().parent
TS_CLIENT = REPO / 'packages' / 'client-typescript' / 'dist' / 'cjs' / 'client' / 'index.js'

RESULTS: Dict[str, Any] = {}


async def _python_round_trips(token: str, size: int) -> List[Dict[str, Any]]:
    rows = []
    async with client(timeout_ms=120_000) as c:
        for _ in range(ROUNDS):
            started = time.perf_counter()
            out = await c.tool(token=token, tool='payload', node_id='receiver_1', input={'bytes': size})
            rows.append(
                {
                    'ms': round((time.perf_counter() - started) * 1000, 1),
                    'count': out['count'],
                    'values': len(out['values']),
                    'json': len(json.dumps(out)),
                    'sum': sum(out['values']),
                }
            )
    return rows


def _expected_sum(size: int) -> float:
    """The sum of the values the payload tool returns for ``size`` (a content checksum)."""
    return sum(round((i % 10000) / 10000 + 0.0001, 4) for i in range(size // 8))


def _check_values(size: int, row: Dict[str, Any]) -> None:
    """Every value arrived, and their sum matches what the tool sent."""
    assert row['values'] == row['count'] == size // 8, row
    assert abs(row['sum'] - _expected_sum(size)) < 1e-3, row


@pytest.mark.parametrize('size', SIZES, ids=['1MB', '4MB'])
def test_python_client_round_trip(probe, size):
    """The Python client gets the whole 1 MB / 4 MB answer back."""
    rows = run(_python_round_trips(probe['tools_1']['token'], size))
    for row in rows:
        _check_values(size, row)
        # Python writes '0.1234, ' per value, so the answer is the requested size.
        assert abs(row['json'] - size) / size < 0.05, row
    RESULTS[f'python_{size}'] = {'rounds': rows, 'median_ms': statistics.median(r['ms'] for r in rows)}
    record('g0_8_payload', RESULTS)


def test_typescript_client_round_trip(probe):
    """The TypeScript client gets the whole 1 MB and 4 MB answers back."""
    node = shutil.which('node')
    assert node, 'node is not installed'
    assert TS_CLIENT.exists(), f'{TS_CLIENT} is missing: build the TypeScript client first'
    rows: List[Dict[str, Any]] = []
    for _ in range(ROUNDS):
        done = subprocess.run(
            [node, str(HERE / 'ts_payload.cjs')],
            capture_output=True,
            text=True,
            timeout=600,
            env={
                **os.environ,
                'ENGINE_URL': ENGINE_URL,
                'RR_TEST_APIKEY': API_KEY,
                'VX_TOKEN': probe['tools_1']['token'],
                'VX_SIZES': ','.join(str(s) for s in SIZES),
            },
        )
        assert done.returncode == 0, done.stderr
        rows.extend(json.loads(line) for line in done.stdout.splitlines() if line.startswith('{'))
    for size in SIZES:
        sized = [r for r in rows if r['bytes'] == size]
        assert len(sized) == ROUNDS
        for row in sized:
            _check_values(size, row)
        RESULTS[f'typescript_{size}'] = {'rounds': sized, 'median_ms': statistics.median(r['ms'] for r in sized)}
    record('g0_8_payload', RESULTS)


def test_trace_trim_cost_on_the_largest_answer():
    """The DAP tool path's trace trim keeps 2 KB of a 4 MB answer; its cost is recorded."""
    from ai.modules.data.data_conn import TOOL_TRACE_DATA_CAP, _trim_tool_data

    size = max(SIZES)
    count = size // 8
    answer = {
        'success': True,
        'bytes_requested': size,
        'count': count,
        'values': [round((i % 10000) / 10000 + 0.0001, 4) for i in range(count)],
    }
    timings = []
    for _ in range(5):
        started = time.perf_counter()
        trimmed = _trim_tool_data(answer)
        timings.append(round((time.perf_counter() - started) * 1000, 2))
    assert isinstance(trimmed, str) and len(trimmed) == TOOL_TRACE_DATA_CAP + 3
    RESULTS['trace_trim_4MB_ms'] = {'rounds': timings, 'median_ms': statistics.median(timings)}
    record('g0_8_payload', RESULTS)
