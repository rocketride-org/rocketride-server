"""Unit tests for framework.pipes.use_and_open; no engine needed."""

import pytest
from rocketride.core.exceptions import PipeException

from .framework.pipes import OPEN_ATTEMPTS, TARGET_NOT_READY, use_and_open

NOT_READY = PipeException({'message': f'Data operation requires a {TARGET_NOT_READY}, but none is set.'})


class _Pipe:
    def __init__(self, errors):
        self._errors = errors

    async def open(self):
        if self._errors:
            raise self._errors.pop(0)


class _Client:
    def __init__(self, errors):
        self.errors = list(errors)
        self.started = []
        self.terminated = []

    async def use(self, pipeline, **kwargs):
        self.started.append(kwargs)
        return {'token': f't{len(self.started)}'}

    async def pipe(self, token, objinfo, mime_type):
        return _Pipe(self.errors)

    async def terminate(self, token):
        self.terminated.append(token)


async def test_restarts_after_a_not_ready_source():
    client = _Client([NOT_READY])
    token, _ = await use_and_open(client, {}, objinfo={}, mime_type='m', threads=1)
    assert token == 't2'
    assert client.terminated == ['t1']
    assert client.started == [{'threads': 1}, {'threads': 1}]


async def test_gives_up_after_the_bounded_attempts():
    client = _Client([NOT_READY] * OPEN_ATTEMPTS)
    with pytest.raises(PipeException):
        await use_and_open(client, {}, objinfo={}, mime_type='m')
    assert len(client.started) == OPEN_ATTEMPTS
    assert len(client.terminated) == OPEN_ATTEMPTS


async def test_other_errors_are_not_retried():
    client = _Client([PipeException({'message': 'something else'})])
    with pytest.raises(PipeException):
        await use_and_open(client, {}, objinfo={}, mime_type='m')
    assert len(client.started) == 1
