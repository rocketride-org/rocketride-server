# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
End-to-end integration tests for database transaction sessions.

Verifies ``client.database.begin_transaction()``, ``query(..., session_id=)``,
``commit()``, and ``rollback()`` against a live db_postgres node that has
``allow_execute=true``.

Two scenarios are covered:

1. **Commit** — INSERT inside a transaction is invisible to a separate stateless
   query before commit, then visible after.
2. **Rollback** — INSERT inside a transaction leaves the table empty after rollback.

The tests skip automatically when the engine is unreachable or the required
pipe file is absent, so CI only runs them where Postgres infrastructure exists.

Run with::

    ./builder test --pytest='tests/db-execute/python/test_execute_session.py -v'
    # or directly:
    pytest tests/db-execute/python/test_execute_session.py -v -m integration

Setup: see tests/db-execute/README.md (same engine + pipe as test_execute.py).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from rocketride import RocketRideClient

# Pipe file used to load the Postgres pipeline.  Resolved relative to this
# file so the path survives working-directory changes.
PIPES_DIR = Path(__file__).resolve().parent.parent / 'pipes'
PG_PIPE = PIPES_DIR / 'postgres-execute.pipe'

# Isolation table – separate from the widgets fixture used by test_execute.py
# so the two suites can run concurrently without interfering.
_TX_TABLE = 'tx_session_test'


# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------


@pytest.fixture
async def pg_client_and_token():
    """Connect to the engine, load the Postgres pipe, and yield (client, token).

    Skips the test automatically when:
    - the pipe file is absent (local setup not done), or
    - the engine is not reachable (no live server in this environment).
    """
    if not PG_PIPE.exists():
        pytest.skip(f'Postgres pipe not found at {PG_PIPE} – run tests/db-execute/README.md setup first')

    client = RocketRideClient()
    try:
        await client.connect()
    except Exception as exc:
        pytest.skip(f'Engine not reachable: {exc}')

    token = None
    try:
        # use_existing=True: attach to an already-running instance of this
        # pipeline instead of failing with "Pipeline is already running"
        # (covers a leaked run from a prior test and between-test reuse).
        pipe = await client.use(filepath=str(PG_PIPE), use_existing=True)
        token = pipe['token']
        # Ensure the isolation table exists and is empty before each test.
        await client.database.query(
            token=token,
            sql=f'CREATE TABLE IF NOT EXISTS {_TX_TABLE} (id SERIAL PRIMARY KEY, label TEXT)',
        )
        await client.database.query(token=token, sql=f'TRUNCATE {_TX_TABLE}')
        yield client, token
    finally:
        # Terminate the server-side pipeline so the next test's use() does not
        # collide with "Pipeline is already running" — disconnect() alone leaves
        # the pipeline live on the engine.
        if token is not None:
            try:
                await client.terminate(token)
            except Exception:
                pass
        await client.disconnect()


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _row_count(result: dict[str, Any]) -> int:
    """Return the integer value of ``count(*)`` from a COUNT query result.

    ``client.database.query()`` delegates to ``client.tool()`` which returns
    ``result.get('result')`` directly (packages/client-python/src/rocketride/client.py:356),
    so the payload is already unwrapped to ``{'rows': [...], 'affected_rows': N}``
    at the top level.  No ``answers`` envelope extraction is needed here.
    The older ``test_execute.py`` harness uses a ``parse_payload`` helper because
    it was written against the pre-``ac74740c`` ``client.chat()`` path.
    """
    rows = result.get('rows') or []
    if not rows:
        return 0
    return int(rows[0].get('n', 0))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
async def test_commit_makes_row_visible(pg_client_and_token):
    """INSERT inside a transaction is invisible before commit, visible after."""
    client, token = pg_client_and_token

    # Begin a new transaction – server returns a session_id.
    begin_res = await client.database.begin_transaction(token=token)
    sid = begin_res.get('session_id', '') if isinstance(begin_res, dict) else ''
    assert sid, f'begin_transaction returned no session_id: {begin_res!r}'

    # INSERT inside the open transaction.
    await client.database.query(
        token=token,
        sql=f"INSERT INTO {_TX_TABLE} (label) VALUES ('committed')",
        session_id=sid,
    )

    # A *separate*, stateless query must NOT see the uncommitted row.
    pre_commit = await client.database.query(
        token=token,
        sql=f'SELECT count(*) AS n FROM {_TX_TABLE}',
    )
    count_before = _row_count(pre_commit)
    assert count_before == 0, f'Stateless read saw {count_before} row(s) before commit – transaction isolation broken'

    # Commit the transaction.
    commit_res = await client.database.commit(token=token, session_id=sid)
    assert commit_res.get('ok') is True, f'commit did not return ok=True: {commit_res!r}'

    # Stateless query MUST now see the committed row.
    post_commit = await client.database.query(
        token=token,
        sql=f'SELECT count(*) AS n FROM {_TX_TABLE}',
    )
    count_after = _row_count(post_commit)
    assert count_after == 1, f'Expected 1 row after commit, got {count_after} – commit may not have persisted'


@pytest.mark.integration
async def test_rollback_discards_row(pg_client_and_token):
    """INSERT inside a transaction leaves the table empty after rollback."""
    client, token = pg_client_and_token

    # Begin a new transaction.
    begin_res = await client.database.begin_transaction(token=token)
    sid = begin_res.get('session_id', '') if isinstance(begin_res, dict) else ''
    assert sid, f'begin_transaction returned no session_id: {begin_res!r}'

    # INSERT inside the open transaction.
    await client.database.query(
        token=token,
        sql=f"INSERT INTO {_TX_TABLE} (label) VALUES ('rolled-back')",
        session_id=sid,
    )

    # Roll back – the INSERT must be discarded.
    rb_res = await client.database.rollback(token=token, session_id=sid)
    assert rb_res.get('ok') is True, f'rollback did not return ok=True: {rb_res!r}'

    # Table must still be empty.
    post_rollback = await client.database.query(
        token=token,
        sql=f'SELECT count(*) AS n FROM {_TX_TABLE}',
    )
    count = _row_count(post_rollback)
    assert count == 0, (
        f'Expected 0 rows after rollback, got {count} – rolled-back INSERT leaked into the committed state'
    )
