# Copyright 2026 Aparavi Software AG. MIT License.
"""The agent bridge preserves caller identity and cannot become an HTTP proxy."""

from types import SimpleNamespace

import httpx
import pytest

from ai.modules.mcp.identity import CALLER_AUTH
from ai.modules.mcp.tools import evaluations


@pytest.fixture
def transport(monkeypatch):
    requests = []
    responder = {'status': 200, 'json': {'run': {'id': 'run-1'}}}

    def handle(request):
        requests.append(request)
        return httpx.Response(responder['status'], json=responder['json'])

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs)
    )
    return requests, responder


@pytest.mark.asyncio
async def test_run_uses_authenticated_caller_and_stable_idempotency_key(transport):
    requests, _ = transport
    token = CALLER_AUTH.set('caller-test-credential')
    try:
        result = await evaluations._evaluations(
            SimpleNamespace(base_url='http://engine.test'),
            None,
            {
                'operation': 'run',
                'evaluationId': 'eval-1',
                'revision': 2,
                'idempotencyKey': 'stable-key',
            },
        )
    finally:
        CALLER_AUTH.reset(token)
    assert result == {'ok': True, 'run': {'id': 'run-1'}}
    assert len(requests) == 1
    assert str(requests[0].url) == 'http://engine.test/evals/v1/evaluations/eval-1/runs'
    assert requests[0].headers['Authorization'] == 'Bearer caller-test-credential'
    import json

    assert json.loads(requests[0].content) == {'revision': 2, 'idempotencyKey': 'stable-key'}


@pytest.mark.asyncio
async def test_no_caller_never_falls_back_to_engine_service_credential(transport):
    requests, _ = transport
    result = await evaluations._evaluations(SimpleNamespace(base_url='http://engine.test'), None, {'operation': 'list'})
    assert result['ok'] is False
    assert result['error_type'] == 'AuthenticationRequired'
    assert not requests


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'args',
    [
        {'operation': 'status', 'runId': '../admin'},
        {'operation': 'status', 'runId': 'https://evil.test'},
        {'operation': 'run', 'evaluationId': 'e', 'revision': True, 'idempotencyKey': 'key'},
        {'operation': 'run', 'evaluationId': 'e', 'revision': 1},
        {'operation': 'create', 'spec': {}, 'url': 'https://evil.test'},
        {'operation': 'baseline', 'evaluationId': 'e'},
        {'operation': 'capabilities', 'spec': {}},
    ],
)
async def test_invalid_or_extraneous_arguments_do_not_issue_requests(transport, args):
    requests, _ = transport
    result = await evaluations._evaluations(SimpleNamespace(base_url='http://engine.test'), None, args)
    assert result['ok'] is False
    assert not requests


@pytest.mark.asyncio
async def test_redirect_is_not_followed_and_credential_not_exposed(transport):
    requests, responder = transport
    responder.update(status=307, json={'error': {'message': 'caller-test-credential'}})
    token = CALLER_AUTH.set('caller-test-credential')
    try:
        result = await evaluations._evaluations(
            SimpleNamespace(base_url='http://engine.test'), None, {'operation': 'capabilities'}
        )
    finally:
        CALLER_AUTH.reset(token)
    assert result['ok'] is False
    assert len(requests) == 1
    assert 'caller-test-credential' not in str(result)


@pytest.mark.asyncio
async def test_version_conflicts_remain_actionable_without_retry(transport):
    requests, responder = transport
    responder.update(status=409, json={'error': {'code': 'revision_conflict', 'message': 'Reload the latest revision'}})
    token = CALLER_AUTH.set('caller-test-credential')
    try:
        result = await evaluations._evaluations(
            SimpleNamespace(base_url='http://engine.test'),
            None,
            {
                'operation': 'revise',
                'evaluationId': 'e',
                'expectedRevision': 1,
                'spec': {},
            },
        )
    finally:
        CALLER_AUTH.reset(token)
    assert result['ok'] is False
    assert result['status'] == 409
    assert len(requests) == 1
