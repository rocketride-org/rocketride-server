import pytest

from rocketride.deploy import DeployApi


class FakeClient:
    def __init__(self, uri: str):
        self.uri = uri
        self.calls = []

    def get_connection_info(self):
        return {
            'connected': True,
            'transport': 'WebSocket',
            'uri': self.uri,
        }

    async def call(self, command: str, **kwargs):
        self.calls.append((command, kwargs))
        return {}


@pytest.mark.asyncio
async def test_publish_rejected_on_rocketride_cloud():
    fake = FakeClient('wss://api.rocketride.ai/task/service')
    api = DeployApi(fake)

    with pytest.raises(RuntimeError, match='not supported'):
        await api.publish({'project_id': 'test', 'name': 'test'})

    assert fake.calls == []

@pytest.mark.asyncio
async def test_deploy_rejected_on_rocketride_cloud():
    fake = FakeClient('wss://api.rocketride.ai/task/service')
    api = DeployApi(fake)

    with pytest.raises(RuntimeError, match='not supported'):
        await api.deploy('project-1', 1, 'team-1')

    assert fake.calls == []


@pytest.mark.asyncio
async def test_list_rejected_on_rocketride_cloud():
    fake = FakeClient('wss://api.rocketride.ai/task/service')
    api = DeployApi(fake)

    with pytest.raises(RuntimeError, match='not supported'):
        await api.list()

    assert fake.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('method', 'args', 'kwargs'),
    [
        ('publish', ({'project_id': 'p1', 'name': 'test'},), {}),
        ('deploy', ('p1', 1, 'team1'), {}),
        ('list', (), {}),
        ('get', ('p1', 'team1'), {}),
        ('versions', ('p1',), {}),
        ('run', ('p1', 'source1', 'team1'), {}),
        ('artifact', ('p1', 1), {}),
        ('history', ('p1',), {}),
        ('disable', ('p1', 'team1'), {}),
        ('enable', ('p1', 'team1'), {}),
        ('remove', ('p1', 'team1'), {}),
        ('set_schedule', ('p1', 'source1', '* * * * *', 'team1'), {}),
        ('set_source_config', ('p1', 'source1', 'team1'), {}),
        ('pause_schedule', ('p1', 'source1', 'team1'), {}),
        ('resume_schedule', ('p1', 'source1', 'team1'), {}),
        ('preview', ('* * * * *',), {}),
    ],
)
async def test_all_deploy_operations_rejected_on_cloud(method, args, kwargs):
    fake = FakeClient('wss://api.rocketride.ai/task/service')
    api = DeployApi(fake)

    with pytest.raises(RuntimeError, match='not supported'):
        await getattr(api, method)(*args, **kwargs)

    assert fake.calls == []

@pytest.mark.asyncio
async def test_publish_allowed_on_self_hosted():
    fake = FakeClient('ws://localhost:5565/task/service')
    api = DeployApi(fake)

    await api.publish({'project_id': 'p1', 'name': 'test'})

    assert fake.calls == [
        (
            'rrext_deploy',
            {
                'subcommand': 'publish',
                'pipeline': {'project_id': 'p1', 'name': 'test'},
            },
        )
    ]