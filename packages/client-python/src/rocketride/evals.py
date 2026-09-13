"""Managed evaluations over bearer HTTP, independent of the offline runner.

Methods return the v1 response envelopes unchanged. Requests are never retried
or redirected; callers retain the idempotency key when resuming a run request.
"""

import asyncio
import http.client
import json
import math
import re
import socket
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import quote, urlencode, urlsplit, urlunsplit


class EvalsError(Exception):
    """A managed API failure with a safe message, HTTP status and server code."""

    def __init__(self, message: str, *, status: Optional[int] = None, code: str = 'evals_error'):
        super().__init__(message)
        self.status = status
        self.code = code


def _redact(text: str, credential: str) -> str:
    if credential:
        text = text.replace(credential, '[REDACTED]')
    return re.sub(r'(?i)Bearer\s+[^\s"<>]+', 'Bearer [REDACTED]', text)


def _base_url(uri: str) -> str:
    """Validate the original endpoint before discarding its WebSocket path."""
    try:
        if not uri or any(c.isspace() or ord(c) < 32 for c in uri) or '\\' in uri:
            raise ValueError
        parsed = urlsplit(uri if '://' in uri else 'http://' + uri)
        if (
            parsed.scheme not in ('http', 'https', 'ws', 'wss')
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or '?' in uri
            or '#' in uri
            or parsed.port == 0
            or parsed.path.rstrip('/') not in ('', '/task/service', '/evals/v1')
        ):
            raise ValueError
        scheme = {'ws': 'http', 'wss': 'https'}.get(parsed.scheme, parsed.scheme)
        return urlunsplit((scheme, parsed.netloc, '/evals/v1', '', ''))
    except ValueError:
        raise ValueError(
            'Managed evaluations require an HTTP(S) server origin without credentials, query, or fragment'
        ) from None


def _positive(value: float, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be a positive finite number')


def _revision(value: int, name: str = 'revision') -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f'{name} must be a positive integer')


def _id(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or value in ('.', '..'):
        raise ValueError('A non-empty object ID is required')
    return quote(value, safe='')


async def _http_request(
    method: str, url: str, headers: dict, body: Optional[bytes], timeout: float
) -> Tuple[int, bytes]:
    # http.client does not follow redirects, use environment proxies, or retry.
    # A daemon owns blocking DNS/socket work: a cancelled call must not hold
    # asyncio.run() open through its default executor's shutdown, or submit
    # a delayed POST when DNS eventually returns.
    parsed = urlsplit(url)
    connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=timeout)
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    cancelled = threading.Event()
    active_socket = None
    deadline = time.monotonic() + timeout

    def finish(value, error):
        if not future.done():
            if error is not None:
                future.set_exception(error)
            else:
                future.set_result(value)

    def send() -> None:
        nonlocal active_socket
        value, error = None, None
        try:
            connection.connect()
            active_socket = connection.sock
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise TimeoutError
            # Explicitly disable implicit reconnection after this one connect.
            connection.auto_open = 0
            active_socket.settimeout(max(0.001, deadline - time.monotonic()))
            connection.request(method, urlunsplit(('', '', parsed.path, parsed.query, '')), body, headers)
            response = connection.getresponse()
            chunks = []
            while not response.isclosed():
                remaining = deadline - time.monotonic()
                if cancelled.is_set() or remaining <= 0:
                    raise TimeoutError
                # read1 bounds each read, so a slowly streaming body cannot
                # keep the socket alive beyond the request's total deadline.
                active_socket.settimeout(remaining)
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            if response.length not in (None, 0):
                raise http.client.IncompleteRead(b'')
            value = response.status, b''.join(chunks)
        except Exception as caught:
            error = caught
        finally:
            connection.close()
            try:
                loop.call_soon_threadsafe(finish, value, error)
            except RuntimeError:
                pass  # The caller already cancelled and closed its loop.

    threading.Thread(target=send, name='rocketride-evals-http', daemon=True).start()
    try:
        return await future
    finally:
        cancelled.set()
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()


class EvalsApi:
    """The ``client.evals`` namespace; no WebSocket connection is necessary.

    ``timeout`` is the per-request budget in seconds (default 30). ``wait``
    additionally bounds the complete polling period, including HTTP requests.
    """

    def __init__(self, connection: Callable[[], Tuple[str, str]], *, timeout: float = 30):
        _positive(timeout, 'timeout')
        self._connection = connection
        self.timeout = timeout

    async def _request(
        self, method: str, path: str, body: Any = None, *, raw: bool = False, timeout: Optional[float] = None
    ) -> Any:
        uri, credential = self._connection()
        url = _base_url(uri) + path
        if not credential or any(c.isspace() or ord(c) < 32 for c in credential):
            raise ValueError('A bearer credential is required for managed evaluations')
        budget = self.timeout if timeout is None else min(timeout, self.timeout)
        _positive(budget, 'timeout')
        headers = {'Authorization': f'Bearer {credential}', 'Accept': 'application/xml' if raw else 'application/json'}
        payload = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            try:
                payload = json.dumps(body, allow_nan=False).encode('utf-8')
            except (TypeError, ValueError):
                raise ValueError('Request body must be strict JSON') from None
        try:
            status, data = await asyncio.wait_for(_http_request(method, url, headers, payload, budget), budget)
        except asyncio.TimeoutError:
            raise EvalsError('Managed evaluation request timed out; no request was retried', code='timeout') from None
        except Exception:
            raise EvalsError(
                'Managed evaluation request failed; no request was retried', code='transport_error'
            ) from None
        if not 200 <= status < 300:
            message, code = f'Managed evaluation request failed (HTTP {status})', 'http_error'
            try:
                error = json.loads(data)['error']
                if isinstance(error.get('message'), str):
                    message = error['message']
                if isinstance(error.get('code'), str):
                    code = error['code']
            except (ValueError, TypeError, KeyError, AttributeError):
                pass
            raise EvalsError(_redact(message, credential), status=status, code=_redact(code, credential))
        try:
            if raw:
                return data.decode('utf-8')
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError
            return result
        except (ValueError, UnicodeError):
            raise EvalsError('Managed evaluation response is invalid', code='invalid_response') from None

    async def capabilities(self) -> Dict[str, Any]:
        return await self._request('GET', '/capabilities')

    async def list(self, *, project_id: Optional[str] = None) -> Dict[str, Any]:
        query = '?' + urlencode({'projectId': project_id}) if project_id is not None else ''
        return await self._request('GET', '/evaluations' + query)

    async def get(self, evaluation_id: str) -> Dict[str, Any]:
        return await self._request('GET', '/evaluations/' + _id(evaluation_id))

    async def create(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request('POST', '/evaluations', spec)

    async def revise(self, evaluation_id: str, spec: Dict[str, Any], *, expected_revision: int) -> Dict[str, Any]:
        _revision(expected_revision, 'expected-revision')
        return await self._request(
            'POST',
            f'/evaluations/{_id(evaluation_id)}/revisions',
            {'spec': spec, 'expectedRevision': expected_revision},
        )

    async def run(
        self, evaluation_id: str, *, revision: int, idempotency_key: str, baseline_run_id: Optional[str] = None
    ) -> Dict[str, Any]:
        _revision(revision)
        _id(idempotency_key)
        body = {'revision': revision, 'idempotencyKey': idempotency_key}
        if baseline_run_id is not None:
            _id(baseline_run_id)
            body['baselineRunId'] = baseline_run_id
        return await self._request('POST', f'/evaluations/{_id(evaluation_id)}/runs', body)

    async def runs(self, *, evaluation_id: Optional[str] = None) -> Dict[str, Any]:
        query = '?' + urlencode({'evaluationId': evaluation_id}) if evaluation_id is not None else ''
        return await self._request('GET', '/runs' + query)

    async def status(self, run_id: str) -> Dict[str, Any]:
        return await self._request('GET', '/runs/' + _id(run_id))

    async def cancel(self, run_id: str) -> Dict[str, Any]:
        return await self._request('POST', f'/runs/{_id(run_id)}/cancel', {})

    async def baseline(self, evaluation_id: str, run_id: str) -> Dict[str, Any]:
        _id(run_id)
        return await self._request('POST', f'/evaluations/{_id(evaluation_id)}/baseline', {'runId': run_id})

    async def report(self, run_id: str, *, format: str = 'json') -> Any:
        if format not in ('json', 'junit'):
            raise ValueError('Report format must be json or junit')
        return await self._request('GET', f'/runs/{_id(run_id)}/report?format={format}', raw=format == 'junit')

    async def compare(self, run_id: str) -> Dict[str, Any]:
        """Read the server's comparison against the run's recorded baseline."""
        result = await self.status(run_id)
        if not isinstance(result.get('run'), dict) or not isinstance(result['run'].get('comparison'), dict):
            raise EvalsError(
                'Run has no server comparison; create a run with baselineRunId', code='comparison_unavailable'
            )
        return result

    async def review(
        self,
        run_id: str,
        *,
        case_id: str,
        scorer_id: str,
        status: str,
        reason: str,
        expected_report_revision: int,
        case_result_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        _revision(expected_report_revision, 'expected-report-revision')
        _id(case_id)
        _id(scorer_id)
        if status not in ('pass', 'fail', 'abstain') or not isinstance(reason, str) or not reason.strip():
            raise ValueError('Review needs a pass, fail, or abstain status and a reason')
        body = {
            'caseId': case_id,
            'scorerId': scorer_id,
            'status': status,
            'reason': reason,
            'expectedReportRevision': expected_report_revision,
        }
        if case_result_id is not None:
            _id(case_result_id)
            body['caseResultId'] = case_result_id
        return await self._request('POST', f'/runs/{_id(run_id)}/review', body)

    async def assist(self, instruction: str, spec: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request('POST', '/assistant', {'instruction': instruction, 'spec': spec})

    async def wait(self, run_id: str, *, timeout: float = 300, poll_interval: float = 1) -> Dict[str, Any]:
        """Poll once immediately, then until terminal or deadline; never cancel."""
        _positive(timeout, 'wait-timeout')
        _positive(poll_interval, 'poll-interval')
        path = '/runs/' + _id(run_id)
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EvalsError('Wait timed out; the durable run can be resumed with status', code='timeout')
            result = await self._request('GET', path, timeout=remaining)
            run = result.get('run', {})
            if run.get('status') in ('completed', 'cancelled', 'error'):
                return result
            if run.get('status') not in ('queued', 'running'):
                raise EvalsError('Managed run response is invalid', code='invalid_response')
            await asyncio.sleep(min(poll_interval, max(0, deadline - time.monotonic())))


def gate_exit_code(run: Dict[str, Any]) -> int:
    """CI gate: 0 pass, 1 fail, 2 incomplete, active, cancelled or error."""
    if run.get('status') != 'completed':
        return 2
    return {'pass': 0, 'fail': 1}.get(run.get('summary', {}).get('gate'), 2)
