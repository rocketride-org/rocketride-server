# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Fixtures for the Vector Explorer Phase-0 pins (live engine). See README.md."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterator

import pytest

from phase0_lib import (
    ACC,
    API_KEY,
    ENGINE_URL,
    FIXTURE_COLLECTION,
    FIXTURE_RR_TABLE,
    FIXTURE_PROJECT_IDS,
    FIXTURES,
    PROBE_NODE_PATH,
    PROBE_SOURCES,
    client,
    probe_pipeline,
    run,
)


async def _ping() -> list:
    async with client(timeout_ms=30_000) as c:
        return await c.get_tasks()


@pytest.fixture(scope='session')
def engine() -> str:
    """The engine URL, after checking that an engine answers there."""
    try:
        run(_ping())
    except Exception as e:  # noqa: BLE001 - reported as a failure, never skipped
        pytest.fail(
            f'No engine answers at {ENGINE_URL} ({type(e).__name__}: {e}). '
            'Start one and set ENGINE_URL (see phase0/README.md).',
            pytrace=False,
        )
    return ENGINE_URL


async def _start_probe() -> Dict[str, Dict[str, Any]]:
    async with client() as c:
        services = (await c.get_services()).get('services') or {}
        missing = [n for n in ('vx_probe_receiver', 'vx_probe_caller') if n not in services]
        if missing:
            raise RuntimeError(
                f'probe nodes {missing} are not registered on {ENGINE_URL}; start the engine with '
                f'--node_path={PROBE_NODE_PATH}'
            )
        started = {}
        for source_id in PROBE_SOURCES:
            started[source_id] = await c.use(pipeline=probe_pipeline(), source=source_id, ttl=0)
        return started


async def _terminate(tokens: list) -> None:
    async with client() as c:
        for token in tokens:
            try:
                await c.terminate(token)
            except Exception:  # noqa: BLE001 - best effort at teardown
                pass


@pytest.fixture(scope='session')
def probe(engine: str) -> Iterator[Dict[str, Dict[str, Any]]]:
    """The probe pipeline's three source tasks: ``{source_id: use() result}``."""
    try:
        started = run(_start_probe())
    except Exception as e:  # noqa: BLE001 - reported as a failure, never skipped
        pytest.fail(f'Could not start the probe pipeline: {type(e).__name__}: {e}', pytrace=False)
    yield started
    if os.environ.get('VX_PHASE0_KEEP') != '1':
        run(_terminate([s['token'] for s in started.values()]))


def _start_fixtures(*extra: str) -> subprocess.CompletedProcess:
    """Run start_fixtures.py with this run's engine, fixtures and collection."""
    env = {
        **os.environ,
        'ENGINE_URL': ENGINE_URL,
        'RR_TEST_APIKEY': API_KEY,
        'VX_COLLECTION': FIXTURE_COLLECTION,
        'VX_RR_TABLE': FIXTURE_RR_TABLE,
    }
    command = [sys.executable, str(ACC / 'start_fixtures.py'), '--only', ','.join(FIXTURES), *extra]
    # sys.executable is the engine binary under `./engine -m pytest`; it runs from dist/server.
    return subprocess.run(
        command,
        cwd=str(Path(sys.executable).parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=1800,
    )


async def _fixture_tasks() -> Dict[str, Dict[str, Any]]:
    async with client() as c:
        tasks = await c.get_tasks()
    by_project: Dict[str, Dict[str, Any]] = {}
    for task in tasks:
        project_id = (task.get('pipeline') or {}).get('project_id')
        by_project.setdefault(project_id, {})[task.get('source')] = task
    return {key: by_project.get(FIXTURE_PROJECT_IDS[key], {}) for key in FIXTURES}


@pytest.fixture(scope='session')
def vx_fixtures(engine: str) -> Iterator[Dict[str, Any]]:
    """The template fixtures started through start_fixtures.py --llm stub.

    Yields ``{'output': stdout, 'tasks': {fixture key: {source id: task}}}``.
    """
    unknown = [k for k in FIXTURES if k not in FIXTURE_PROJECT_IDS]
    if unknown:
        pytest.fail(f'unknown VX_PHASE0_FIXTURES entries: {unknown}', pytrace=False)
    done = _start_fixtures('--llm', 'stub')
    if done.returncode != 0:
        pytest.fail(f'start_fixtures.py exited {done.returncode}:\n{done.stdout}\n{done.stderr}', pytrace=False)
    yield {'output': done.stdout, 'tasks': run(_fixture_tasks())}
    if os.environ.get('VX_PHASE0_KEEP') != '1':
        _start_fixtures('--stop')
