"""
client.log.streams() against a live server.

A dev run and a team deploy run of the same source log into two different
places; one streams() call must name both, and chapters() alone must not.
Needs a running server (ROCKETRIDE_URI, default localhost:5565) like test_deploy.
"""

import asyncio

import pytest

from rocketride import RocketRideClient
from test_deploy import SERVER_URI, TEAM, fresh_project, make_pipeline

SOURCE = 'webhook_1'


async def _streams_of(client, project, *, want):
    """Poll until ``want`` streams are listed: a terminated run closes its chapter asynchronously."""
    for _ in range(50):
        streams = (await client.log.streams(project, SOURCE))['streams']
        if len(streams) >= want:
            return streams
        await asyncio.sleep(0.2)
    return streams


class TestLogStreams:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.client = RocketRideClient(SERVER_URI, 'MYAPIKEY')
        await self.client.connect()
        yield
        await self.client.disconnect()

    @pytest.mark.asyncio
    async def test_a_dev_run_and_a_team_run_are_listed_by_one_call(self):
        project = fresh_project()
        pipeline = make_pipeline(project)
        try:
            dev = await self.client.use(pipeline=pipeline)
            await self.client.terminate(dev['token'])
            await self.client.deploy.add(pipeline, deploy_to=TEAM)
            team = await self.client.deploy.run(project, SOURCE, TEAM)
            await self.client.terminate(team['token'])

            streams = await _streams_of(self.client, project, want=2)

            assert [(s['teamId'], s['runKind'], s['ownerKind']) for s in streams] == [
                ('', 'dev', 'user'),
                (TEAM, 'deploy', 'team'),
            ]
            assert all(len(s['chapters']) == 1 for s in streams)
            # The single-stream read sees only its own continuum: that is the gap streams() closes.
            assert len((await self.client.log.chapters(project, SOURCE))['chapters']) == 1
        finally:
            try:
                await self.client.deploy.remove(project, TEAM)
            except RuntimeError:
                pass
