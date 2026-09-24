# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Unit tests for the listener's LaserData adapter (fake SDK, no network)."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from . import _stubs

adapters, laserdata = _stubs.load('listener.adapters', 'listener.adapters.laserdata')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
import laserdata_tasking as tasking  # noqa: E402


class FakeCtx:
    def __init__(self):
        self.replies = []

    async def reply_on(self, topic, payload):
        self.replies.append((topic, json.loads(payload)))


class FakeHandle:
    def __init__(self):
        self.stopped = False

    async def ready(self):
        return None

    async def shutdown(self):
        self.stopped = True


class FakeLaser:
    def __init__(self):
        self.ensured, self.events, self.spawn = [], [], None

    def topic(self, name):
        laser = self

        class _T:
            async def ensure(self, partitions):
                laser.ensured.append((name, partitions))

            def publish(self, body):
                class _R:
                    async def send(self):
                        laser.events.append(body)

                return _R()

        return _T()

    def spawn_agent(self, agent_id, listen_on, handler, **kw):
        self.spawn = (agent_id, listen_on, handler, kw)
        return FakeHandle()

    async def __aexit__(self, *a):
        self.closed = True


@pytest.fixture
def sdk(monkeypatch):
    laser = FakeLaser()
    mod = types.ModuleType('laser_sdk')

    class Laser:
        @staticmethod
        async def connect(cs, stream=None):
            laser.connected = (cs, stream)
            return laser

    mod.Laser = Laser
    monkeypatch.setitem(sys.modules, 'laser_sdk', mod)
    return laser


def _adapter(**cfg):
    base = {'connection_string': 'u:p@x.laserdata.cloud', 'agent_id': 'risk'}
    base.update(cfg)
    return laserdata.LaserDataAdapter(base)


def _msg(env):
    return SimpleNamespace(json=lambda: json.loads(tasking.encode(env)))


async def _answer(text, name):
    return 'approved'


def test_get_adapter_default_and_unknown():
    assert (
        type(adapters.get_adapter({'connection_string': 'u:p@h:1', 'agent_id': 'risk'})).__name__ == 'LaserDataAdapter'
    )
    with pytest.raises(ValueError, match='unknown source'):
        adapters.get_adapter({'source': 'kafka'})


def test_config_normalizes_and_validates(monkeypatch):
    a = _adapter()
    assert (
        a.connection_string == 'u:p@x.laserdata.cloud:8090' and a.stream == 'rocketride-memory' and a.max_attempts == 3
    )
    with pytest.raises(ValueError, match='agent_id'):
        _adapter(agent_id='Risk Desk')
    monkeypatch.setenv('LASER_CONNECTION_STRING', 'u:p@y.laserdata.cloud')
    assert _adapter(connection_string='').connection_string == 'u:p@y.laserdata.cloud:8090'
    monkeypatch.delenv('LASER_CONNECTION_STRING')
    with pytest.raises(ValueError, match='connection string'):
        _adapter(connection_string='')


def test_start_connects_ensures_and_spawns(sdk):
    a = _adapter(stream='agents', max_attempts=5)
    asyncio.run(a.start(_answer))
    assert sdk.connected == ('u:p@x.laserdata.cloud:8090', 'agents')
    assert ('agent.risk.inbox', 1) in sdk.ensured and ('agent.events', 1) in sdk.ensured
    agent_id, listen_on, _, kw = sdk.spawn
    assert (agent_id, listen_on, kw['consumer_group'], kw['ack_on_pickup'], kw['retry_max_attempts']) == (
        'risk',
        'agent.risk.inbox',
        'risk',
        False,
        5,
    )
    asyncio.run(a.stop())


def test_handler_task_replies_and_records_events(sdk):
    a = _adapter()
    asyncio.run(a.start(_answer))
    task = tasking.make_task(sender='intake', to='risk', body='refund 42', inline=False)
    ctx = FakeCtx()
    seen = {}

    async def handle(text, name):
        seen['text'], seen['name'] = text, name
        return 'approved'

    a._handle = handle
    asyncio.run(a._on_message(ctx, _msg(task)))
    assert (
        seen['text'] == tasking.label(task) and seen['name'] == f'listener://risk/{task.task_id}'
    )  # engine only accepts registered protocols
    topic, reply = ctx.replies[0]
    assert topic == 'agent.intake.inbox' and (reply['kind'], reply['task_id'], reply['body'], reply['sender']) == (
        'reply',
        task.task_id,
        'approved',
        'risk',
    )
    assert [e['event'] for e in sdk.events] == ['picked_up', 'replied']


def test_handler_failure_records_and_reraises(sdk):
    a = _adapter()
    asyncio.run(a.start(_answer))

    async def boom(text, name):
        raise RuntimeError('llm down')

    a._handle = boom
    ctx = FakeCtx()
    task = tasking.make_task(sender='intake', to='risk', body='x', inline=False)
    with pytest.raises(RuntimeError, match='llm down'):
        asyncio.run(a._on_message(ctx, _msg(task)))
    assert ctx.replies == [] and [e['event'] for e in sdk.events] == ['picked_up', 'failed']
    assert 'llm down' in sdk.events[-1]['detail']


def test_handler_reply_kind_runs_pipeline_without_events_or_reply(sdk):
    a = _adapter(agent_id='intake')
    asyncio.run(a.start(_answer))
    task = tasking.make_task(sender='intake', to='risk', body='x', inline=False)
    reply = tasking.make_reply(task, sender='risk', body='approved')
    ctx = FakeCtx()
    asyncio.run(a._on_message(ctx, _msg(reply)))
    assert ctx.replies == [] and sdk.events == []


def test_handler_rejects_foreign_record(sdk):
    a = _adapter()
    asyncio.run(a.start(_answer))
    ctx = FakeCtx()
    with pytest.raises(ValueError, match='not a tasking envelope'):
        asyncio.run(a._on_message(ctx, SimpleNamespace(json=lambda: 'hello')))
    assert ctx.replies == [] and sdk.events == []
