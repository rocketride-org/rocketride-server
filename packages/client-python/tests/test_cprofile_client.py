# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Contract tests for the client's cprofile_* methods.

These existed since 2026-05 and had never been executed: every one of them
passed its argument dict to ``call()`` positionally, while the Python client's
``call(self, command, *, ...)`` takes keyword arguments only (client.py:282).
The result was a TypeError on the first call of any of them.  Nothing caught
it because nothing exercised them — profiler-ui drives the DAP verbs through
the TypeScript client, whose ``call(command, args)`` IS positional.

So these tests deliberately go through the public client methods rather than
``client.call``: calling the verbs directly would re-test the server and leave
the same gap.  Argument forwarding is asserted on echoed values, not just on
"did not raise" — dropping the arguments silently would otherwise still pass.

All but one case work against a server with no session running, so they have
no effect on anything else using the shared test server.  The one that must
start a session scopes it to its own task, never the server process.
"""

from __future__ import annotations

import os
import uuid

import pytest
from echo_pipeline import get_echo_pipeline
from rocketride import RocketRideClient

TEST_CONFIG = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://localhost:5565'),
    'auth': os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'),
}

NO_DATA = 'No profiling data available. Run a session first.'


@pytest.fixture
async def client():
    """Connected client, disconnected on teardown."""
    rr = RocketRideClient(auth=TEST_CONFIG['auth'], uri=TEST_CONFIG['uri'])
    await rr.connect()
    try:
        yield rr
    finally:
        if rr.is_connected():
            await rr.disconnect()


class TestCProfileClientContract:
    """Every cprofile_* method must reach the server and carry its arguments."""

    @pytest.mark.asyncio
    async def test_status_reaches_the_server(self, client):
        """The cheapest possible proof that the call is well-formed."""
        status = await client.cprofile_status()

        assert 'active' in status, status

    @pytest.mark.asyncio
    async def test_stop_without_a_session_is_reported_not_raised(self, client):
        """No session: the server answers with an error status, not an exception."""
        result = await client.cprofile_stop()

        assert result.get('status') == 'error', result

    @pytest.mark.asyncio
    async def test_report_without_a_session_returns_the_placeholder(self, client):
        result = await client.cprofile_report()

        assert result['report'] == NO_DATA

    @pytest.mark.asyncio
    async def test_report_tree_forwards_its_tuning_arguments(self, client):
        """max_depth/min_pct/include_system are always sent, unlike target."""
        result = await client.cprofile_report_tree(max_depth=7, min_pct=0.5, include_system=False)

        # No session yet, so the server reports that rather than a tree — the
        # point here is that a call carrying four arguments is accepted at all
        assert result.get('error') == NO_DATA, result

    @pytest.mark.asyncio
    async def test_start_and_stop_carry_target_and_session(self, client):
        """Round trip on a task of our own, echoing back what we sent.

        Scoped to a task rather than the server process: an engine-level
        session would profile everything else using this shared test server.
        """
        token = (await client.use(pipeline=get_echo_pipeline(f'cprofile_{uuid.uuid4().hex[:8]}')))['token']
        try:
            started = await client.cprofile_start(target=token, session='contract-session')
            assert started.get('status') == 'started', started
            # Echoed, so a dropped 'session' argument cannot pass as success
            assert started.get('session') == 'contract-session', started

            active = await client.cprofile_status(target=token)
            assert active.get('active') is True, active
            assert active.get('session') == 'contract-session', active

            stopped = await client.cprofile_stop(target=token)
            assert stopped.get('status') == 'completed', stopped
            assert stopped.get('session') == 'contract-session', stopped

            report = await client.cprofile_report(target=token)
            assert report['report'].startswith('Session: contract-session'), report['report'][:200]
        finally:
            try:
                await client.cprofile_stop(target=token)
            except Exception:
                pass
            try:
                await client.terminate(token)
            except Exception:
                pass
