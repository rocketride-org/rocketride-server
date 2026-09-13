"""Managed HTTP API and CLI contracts; all HTTP is injected, no engine/provider."""

import importlib
import json
import asyncio
import os

import pytest

from rocketride import RocketRideClient


SPEC = {
    'schemaVersion': 1, 'name': 'Policy', 'projectId': 'p1',
    'pipeline': {'project_id': 'p1', 'components': [{'id': 'chat_1'}]},
    'source': 'chat_1', 'inputMode': 'chat', 'environment': 'development',
    'datasetName': 'Reviewed examples', 'repetitions': 2,
    'cases': [{'id': 'c1', 'name': 'Refund', 'input': 'Return?', 'reference': '30 days', 'approved': True}],
    'scorers': [{'id': 's1', 'name': 'Human', 'kind': 'human'}],
    'passCriteria': {'minimumPassRate': 1, 'maxRegressions': 0},
}
RUN = {'id': 'r1', 'status': 'completed', 'summary': {'gate': 'pass'}, 'reportRevision': 3}


class Transport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    async def __call__(self, method, url, headers, body, timeout):
        self.requests.append((method, url, headers, json.loads(body) if body else None, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        status, payload = response if isinstance(response, tuple) else (200, response)
        return status, payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()


def client_with(monkeypatch, transport, uri='https://api.rocketride.ai/task/service'):
    client = RocketRideClient(uri=uri, auth='test-secret', env={})
    assert hasattr(client, 'evals'), 'Public client.evals HTTP namespace is missing'
    module = importlib.import_module('rocketride.evals')
    monkeypatch.setattr(module, '_http_request', transport)
    return client


@pytest.mark.asyncio
async def test_public_namespace_uses_http_without_connect(monkeypatch):
    transport = Transport({'environments': []})
    client = client_with(monkeypatch, transport)
    assert await client.evals.capabilities() == {'environments': []}
    assert transport.requests[0][:4] == (
        'GET', 'https://api.rocketride.ai/evals/v1/capabilities',
        {'Authorization': 'Bearer test-secret', 'Accept': 'application/json'}, None,
    )
    assert not client.is_connected()


@pytest.mark.asyncio
async def test_routes_writes_guards_and_review_contract(monkeypatch):
    transport = Transport(*[{} for _ in range(14)])
    api = client_with(monkeypatch, transport).evals
    await api.list(project_id='p &?')
    await api.get('e/1')
    await api.create(SPEC)
    await api.revise('e1', SPEC, expected_revision=2)
    await api.run('e1', revision=3, idempotency_key='ci-unchanged', baseline_run_id='b1')
    await api.runs(evaluation_id='e1')
    await api.status('r1')
    await api.cancel('r1')
    await api.baseline('e1', 'r1')
    await api.report('r1')
    await api.review('r1', case_id='c1', scorer_id='s1', status='pass', reason='Checked', expected_report_revision=3)
    await api.assist('Improve wording', SPEC)
    calls = transport.requests
    assert calls[0][1].endswith('/evaluations?projectId=p+%26%3F')
    assert calls[1][1].endswith('/evaluations/e%2F1')
    assert calls[2][3] == SPEC
    assert calls[3][3] == {'spec': SPEC, 'expectedRevision': 2}
    assert calls[4][3] == {'revision': 3, 'idempotencyKey': 'ci-unchanged', 'baselineRunId': 'b1'}
    assert calls[5][1].endswith('/runs?evaluationId=e1')
    assert calls[6][1].endswith('/runs/r1')
    assert calls[7][3] == {}
    assert calls[8][3] == {'runId': 'r1'}
    assert calls[9][1].endswith('/runs/r1/report?format=json')
    assert calls[10][3] == {'caseId': 'c1', 'scorerId': 's1', 'status': 'pass', 'reason': 'Checked', 'expectedReportRevision': 3}
    assert calls[11][3] == {'instruction': 'Improve wording', 'spec': SPEC}


@pytest.mark.asyncio
@pytest.mark.parametrize('uri', ['ftp://example.com', 'https://u:secret@example.com:443', 'https://api.rocketride.ai/prefix', 'https://api.rocketride.ai/?token=secret', 'https://api.rocketride.ai/#secret'])
async def test_reject_original_endpoint_before_transport(monkeypatch, uri):
    transport = Transport({})
    client = client_with(monkeypatch, transport, uri)
    with pytest.raises(ValueError):
        await client.evals.capabilities()
    assert not transport.requests


@pytest.mark.asyncio
async def test_failures_never_retry_or_disclose_credentials(monkeypatch):
    for response in [(307, 'test-secret'), (409, {'error': {'code': 'conflict', 'message': 'Stale test-secret'}}), RuntimeError('test-secret')]:
        transport = Transport(response)
        api = client_with(monkeypatch, transport).evals
        with pytest.raises(Exception) as caught:
            await api.run('e1', revision=1, idempotency_key='same-key')
        assert 'test-secret' not in str(caught.value)
        assert len(transport.requests) == 1


async def cli(monkeypatch, transport, argv):
    client_with(monkeypatch, transport)
    main = importlib.import_module('rocketride.cli.main')
    parser = main.setup_parser()
    assert 'evals' in parser._subparsers._group_actions[0].choices, 'Managed evals command is missing'
    args = parser.parse_args(['evals', *argv, '--uri', 'https://api.rocketride.ai', '--apikey', 'test-secret'])
    return await main._dispatch(args)


@pytest.mark.asyncio
@pytest.mark.parametrize('gate,code', [('pass', 0), ('fail', 1), ('incomplete', 2)])
async def test_cli_wait_gate_and_idempotency(monkeypatch, capsys, gate, code):
    transport = Transport({'run': {'id': 'r1', 'status': 'queued'}}, {'run': {**RUN, 'summary': {'gate': gate}}})
    assert await cli(monkeypatch, transport, ['run', 'e1', '--revision', '1', '--idempotency-key', 'ci-42', '--wait', '--json']) == code
    assert json.loads(capsys.readouterr().out)['run']['summary']['gate'] == gate
    assert [call[0] for call in transport.requests] == ['POST', 'GET']
    assert transport.requests[0][3]['idempotencyKey'] == 'ci-42'


@pytest.mark.asyncio
async def test_cli_save_requires_guard_before_http(monkeypatch, tmp_path, capsys):
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps(SPEC))
    transport = Transport({})
    assert await cli(monkeypatch, transport, ['save', str(spec), '--id', 'e1', '--json']) == 2
    assert 'expected-revision' in json.loads(capsys.readouterr().out)['error']['message']
    assert not transport.requests


@pytest.mark.asyncio
async def test_cli_junit_exclusive_output(monkeypatch, tmp_path, capsys):
    report = '<testsuites><testsuite name="Managed"/></testsuites>'
    target = tmp_path / 'report.xml'
    transport = Transport(report, report)
    args = ['report', 'r1', '--format', 'junit', '--output', str(target), '--json']
    assert await cli(monkeypatch, transport, args) == 0
    assert target.read_text() == report
    capsys.readouterr()
    assert await cli(monkeypatch, transport, args) == 2
    assert target.read_text() == report
    assert 'error' in json.loads(capsys.readouterr().out)


@pytest.mark.asyncio
async def test_review_targets_one_repetition(monkeypatch, capsys):
    transport = Transport({'run': RUN}, {'run': RUN})
    api = client_with(monkeypatch, transport).evals
    await api.review('r1', case_id='c1', case_result_id='trial-row-2', scorer_id='s1', status='pass', reason='Inspected', expected_report_revision=3)
    assert transport.requests[0][3]['caseResultId'] == 'trial-row-2'
    assert await cli(monkeypatch, transport, ['review', 'r1', '--case-id', 'c1', '--case-result-id', 'trial-row-2', '--scorer-id', 's1', '--status', 'fail', '--reason', 'Inspected', '--expected-report-revision', '3', '--json']) == 0
    assert transport.requests[1][3] == {'caseId': 'c1', 'caseResultId': 'trial-row-2', 'scorerId': 's1', 'status': 'fail', 'reason': 'Inspected', 'expectedReportRevision': 3}
    assert json.loads(capsys.readouterr().out)['run'] == RUN


@pytest.mark.asyncio
@pytest.mark.parametrize('command,path,body', [
    (['capabilities'], '/capabilities', None),
    (['list', '--project-id', 'p1'], '/evaluations?projectId=p1', None),
    (['show', 'e1'], '/evaluations/e1', None),
    (['runs', '--evaluation-id', 'e1'], '/runs?evaluationId=e1', None),
    (['status', 'r1'], '/runs/r1', None),
    (['cancel', 'r1'], '/runs/r1/cancel', {}),
    (['baseline', 'e1', 'r1'], '/evaluations/e1/baseline', {'runId': 'r1'}),
])
async def test_cli_read_and_lifecycle_routes(monkeypatch, capsys, command, path, body):
    transport = Transport({'run': RUN})
    assert await cli(monkeypatch, transport, [*command, '--json']) == 0
    assert transport.requests[0][1].endswith(path)
    assert transport.requests[0][3] == body
    assert json.loads(capsys.readouterr().out) == {'run': RUN}


@pytest.mark.asyncio
async def test_cli_authoring_exact_spec_and_no_implicit_run(monkeypatch, tmp_path, capsys):
    spec_file = tmp_path / 'spec.json'
    spec_file.write_text(json.dumps(SPEC))
    transport = Transport(*[{} for _ in range(5)])
    for command in [
        ['create', str(spec_file)], ['save', str(spec_file)],
        ['save', str(spec_file), '--id', 'e1', '--expected-revision', '2'],
        ['revision', 'e1', str(spec_file), '--expected-revision', '2'],
        ['assist', str(spec_file), '--instruction', 'Clarify'],
    ]:
        assert await cli(monkeypatch, transport, [*command, '--json']) == 0
        assert json.loads(capsys.readouterr().out) == {}
    assert [call[3] for call in transport.requests] == [SPEC, SPEC, {'spec': SPEC, 'expectedRevision': 2}, {'spec': SPEC, 'expectedRevision': 2}, {'instruction': 'Clarify', 'spec': SPEC}]
    assert not any(call[1].endswith('/runs') for call in transport.requests)


@pytest.mark.asyncio
@pytest.mark.parametrize('compatible,gate,code', [(True, 'pass', 0), (True, 'fail', 1), (False, 'pass', 2)])
async def test_compare_uses_recorded_server_evidence(monkeypatch, capsys, compatible, gate, code):
    run = {**RUN, 'baselineRunId': 'b1', 'summary': {'gate': gate}, 'comparison': {'compatible': compatible, 'regressions': 2}}
    transport = Transport({'run': run})
    assert await cli(monkeypatch, transport, ['compare', 'r1', '--json']) == code
    assert json.loads(capsys.readouterr().out) == {'run': run}
    assert len(transport.requests) == 1
    assert transport.requests[0][0] == 'GET'


@pytest.mark.asyncio
async def test_compare_does_not_invent_missing_evidence(monkeypatch, capsys):
    transport = Transport({'run': RUN})
    assert await cli(monkeypatch, transport, ['compare', 'r1', '--json']) == 2
    assert json.loads(capsys.readouterr().out)['error']['code'] == 'comparison_unavailable'


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['queued', 'running', 'cancelled', 'error'])
async def test_gate_never_passes_noncompleted_run(monkeypatch, capsys, status):
    transport = Transport({'run': {**RUN, 'status': status}})
    assert await cli(monkeypatch, transport, ['status', 'r1', '--gate', '--json']) == 2
    assert json.loads(capsys.readouterr().out)['run']['status'] == status


@pytest.mark.asyncio
async def test_wait_deadline_bounds_pending_request_and_preserves_run_identity(monkeypatch, capsys):
    calls = []

    async def pending(method, url, headers, body, timeout):
        calls.append((method, timeout))
        if method == 'POST':
            return 200, json.dumps({'run': {'id': 'r1', 'status': 'queued'}}).encode()
        await asyncio.sleep(10)

    started = asyncio.get_running_loop().time()
    assert await cli(monkeypatch, pending, ['run', 'e1', '--revision', '1', '--idempotency-key', 'stable', '--wait', '--wait-timeout', '0.02', '--json']) == 2
    assert asyncio.get_running_loop().time() - started < 1
    result = json.loads(capsys.readouterr().out)
    assert result['error']['code'] == 'timeout'
    assert result['run']['id'] == 'r1'
    assert result['idempotencyKey'] == 'stable'
    assert [call[0] for call in calls] == ['POST', 'GET']
    assert 0 < calls[1][1] <= 0.02


@pytest.mark.asyncio
async def test_invalid_wait_and_revision_rejected_before_enqueue(monkeypatch, capsys):
    for option, value in [('--wait-timeout', 'nan'), ('--poll-interval', '0'), ('--revision', '0')]:
        transport = Transport({})
        assert await cli(monkeypatch, transport, ['run', 'e1', '--revision', '1', '--idempotency-key', 'key', option, value, '--json']) == 2
        assert not transport.requests
        assert 'error' in json.loads(capsys.readouterr().out)


@pytest.mark.asyncio
async def test_output_redaction_and_safe_json_file(monkeypatch, tmp_path, capsys):
    target = tmp_path / 'result.json'
    response = {'message': 'test-secret Bearer another-secret', 'password': 'embedded-secret'}
    transport = Transport(response, response)
    assert await cli(monkeypatch, transport, ['capabilities', '--json', str(target)]) == 0
    text = target.read_text() + capsys.readouterr().out
    assert not any(secret in text for secret in ['test-secret', 'another-secret', 'embedded-secret'])
    assert os.stat(target).st_mode & 0o777 == 0o600
    assert await cli(monkeypatch, transport, ['capabilities', '--json', str(target)]) == 2


@pytest.mark.asyncio
async def test_report_refuses_symlink_and_keeps_full_versioned_json(monkeypatch, tmp_path, capsys):
    target = tmp_path / 'report.json'
    report = {'schemaVersion': 1, 'run': {**RUN, 'cases': [{'id': 'trial-row-2', 'output': 'full evidence'}]}}
    transport = Transport(report, report)
    assert await cli(monkeypatch, transport, ['report', 'r1', '--output', str(target), '--json']) == 0
    assert json.loads(target.read_text()) == report
    capsys.readouterr()
    link = tmp_path / 'symlink.json'
    link.symlink_to(target)
    assert await cli(monkeypatch, transport, ['report', 'r1', '--output', str(link), '--json']) == 2
    assert json.loads(target.read_text()) == report


@pytest.mark.asyncio
async def test_sdk_conflict_metadata_and_invalid_response(monkeypatch):
    from rocketride import EvalsError

    api = client_with(monkeypatch, Transport((409, {'error': {'code': 'conflict', 'message': 'Stale'}}), 'not JSON')).evals
    with pytest.raises(EvalsError) as caught:
        await api.revise('e1', SPEC, expected_revision=2)
    assert (caught.value.status, caught.value.code) == (409, 'conflict')
    with pytest.raises(EvalsError, match='response is invalid'):
        await api.status('r1')


@pytest.mark.asyncio
async def test_endpoint_override_keeps_original_validation(monkeypatch):
    from unittest.mock import AsyncMock

    transport = Transport({})
    client = client_with(monkeypatch, transport)
    monkeypatch.setattr(client, '_internal_attach', AsyncMock())
    await client.attach('https://next.rocketride.ai/task/service')
    await client.evals.capabilities()
    assert transport.requests[0][1] == 'https://next.rocketride.ai/evals/v1/capabilities'
    await client.attach('https://next.rocketride.ai/?credential=secret')
    with pytest.raises(ValueError):
        await client.evals.capabilities()
    assert len(transport.requests) == 1


@pytest.mark.asyncio
async def test_json_output_failure_prevents_mutation(monkeypatch, tmp_path, capsys):
    target = tmp_path / 'existing.json'
    target.write_text('preserve')
    transport = Transport({'run': RUN})
    assert await cli(monkeypatch, transport, ['run', 'e1', '--revision', '1', '--idempotency-key', 'stable', '--json', str(target)]) == 2
    assert not transport.requests
    assert target.read_text() == 'preserve'


@pytest.mark.asyncio
async def test_cli_usage_errors_are_code_two_without_transport(monkeypatch):
    transport = Transport({})
    with pytest.raises(SystemExit) as caught:
        await cli(monkeypatch, transport, ['run', 'e1', '--revision', '1', '--json'])
    assert caught.value.code == 2
    assert not transport.requests


@pytest.mark.asyncio
async def test_timed_out_connection_cannot_submit_later(monkeypatch):
    """A cancelled DNS/connect attempt must never send a delayed mutation."""
    import threading
    from unittest.mock import MagicMock
    from rocketride import EvalsApi, EvalsError

    release = threading.Event()
    closed = threading.Event()
    requests = []

    class DelayedConnection:
        sock = None

        def __init__(self, *args, **kwargs):
            pass

        def connect(self):
            release.wait(2)
            self.sock = MagicMock()

        def request(self, *args):
            if self.sock is None:
                self.connect()
            requests.append(args)

        def getresponse(self):
            response = MagicMock(status=200)
            response.read1.side_effect = [b'{"run":{}}', b'']
            return response

        def close(self):
            if threading.current_thread() is not threading.main_thread():
                closed.set()

    monkeypatch.setattr('rocketride.evals.http.client.HTTPConnection', DelayedConnection)
    api = EvalsApi(lambda: ('http://localhost:5565', 'test-secret'), timeout=0.02)
    try:
        with pytest.raises(EvalsError) as caught:
            await api.run('e1', revision=1, idempotency_key='stable')
        assert caught.value.code == 'timeout'
    finally:
        release.set()
    for _ in range(100):
        if closed.is_set():
            break
        await asyncio.sleep(0.005)
    assert closed.is_set()
    assert not requests


@pytest.mark.asyncio
async def test_http_transport_reads_complete_body_and_does_not_follow_redirect(monkeypatch):
    import http.client
    from io import BytesIO
    from unittest.mock import MagicMock
    from rocketride import EvalsApi, EvalsError

    requests = []
    responses = [
        b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
        b'HTTP/1.1 307 Temporary Redirect\r\nLocation: https://other.invalid\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}',
    ]

    class Connection:
        def __init__(self, *args, **kwargs):
            self.sock = MagicMock()

        def connect(self):
            pass

        def request(self, *args):
            requests.append(args)

        def getresponse(self):
            stream = BytesIO(responses.pop(0))
            self.sock.makefile.return_value = stream
            response = http.client.HTTPResponse(self.sock)
            response.begin()
            return response

        def close(self):
            pass

    monkeypatch.setattr('rocketride.evals.http.client.HTTPConnection', Connection)
    api = EvalsApi(lambda: ('http://localhost:5565', 'test-secret'))
    assert await api.capabilities() == {}
    with pytest.raises(EvalsError) as caught:
        await api.capabilities()
    assert caught.value.status == 307
    with pytest.raises(EvalsError) as caught:
        await api.capabilities()
    assert caught.value.code == 'transport_error'
    assert len(requests) == 3
