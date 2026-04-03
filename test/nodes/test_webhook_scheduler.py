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

"""Tests for webhook trigger endpoints and pipeline scheduler.

All tests use mocks -- no real server, scheduler, or database is required.
"""

import asyncio
import hashlib
import hmac
import json
import sys
import time
from datetime import datetime, timezone
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Mock heavy third-party / internal dependencies so we can import the modules
# under test without a full runtime environment.
# ---------------------------------------------------------------------------

_INJECTED_MODULES: list[str] = []


def _inject(name: str, module: object) -> None:
    """Insert *module* into sys.modules under *name* if absent."""
    if name not in sys.modules:
        sys.modules[name] = module  # type: ignore[assignment]
        _INJECTED_MODULES.append(name)


# rocketride constants
_mock_rocketride = MagicMock()
_mock_rocketride.CONST_WS_PING_INTERVAL = 20
_mock_rocketride.CONST_WS_PING_TIMEOUT = 20
_inject('rocketride', _mock_rocketride)

# rocketlib
_mock_rocketlib = MagicMock()
_inject('rocketlib', _mock_rocketlib)

# depends -- must be a real module with a callable ``depends`` attribute
_mock_depends_mod = ModuleType('depends')
_mock_depends_mod.depends = lambda *a, **kw: None  # type: ignore[attr-defined]
_inject('depends', _mock_depends_mod)

# ai.account
_mock_ai_account = MagicMock()
_inject('ai.account', _mock_ai_account)
_inject('ai.account.account', _mock_ai_account)

# ai.constants
_mock_constants = MagicMock()
_mock_constants.CONST_DEFAULT_WEB_PORT = 5565
_mock_constants.CONST_DEFAULT_WEB_HOST = '127.0.0.1'
_mock_constants.CONST_WEB_WS_MAX_SIZE = 16 * 1024 * 1024
_inject('ai.constants', _mock_constants)

# ai.modules
_mock_modules = MagicMock()
_mock_modules.ALL = frozenset()
_inject('ai.modules', _mock_modules)

# dotenv
_inject('dotenv', MagicMock())

# uvicorn
_inject('uvicorn', MagicMock())

# ai.web.denied
_mock_denied = MagicMock()
_inject('ai.web.denied', _mock_denied)

# ai.web.middleware
_inject('ai.web.middleware', MagicMock())

# Now import the real modules that we will test.
# These go through ai.web which triggers depends() and pulls in FastAPI etc.
from ai.web.scheduler.models import ScheduleCreate, ScheduleList, ScheduleResponse, WebhookResponse  # noqa: E402
from ai.web.endpoints.webhook import _verify_signature, webhook_trigger, webhook_status, _active_tasks, _cleanup_expired_tasks, _execute_pipeline, _TASK_TTL, register_webhook_routes  # noqa: E402


def teardown_module() -> None:
    """Remove injected mocks from sys.modules."""
    for name in _INJECTED_MODULES:
        sys.modules.pop(name, None)
    _INJECTED_MODULES.clear()


# ===========================================================================
# Helpers
# ===========================================================================

WEBHOOK_SECRET = 'test-secret-key-abc123'


def _make_signature(payload: bytes, secret: str = WEBHOOK_SECRET) -> str:
    """Compute a valid HMAC-SHA256 hex digest."""
    return hmac.new(secret.encode('utf-8'), payload, hashlib.sha256).hexdigest()


def _make_request(
    *,
    headers: dict | None = None,
    body: bytes = b'{}',
    app_state: dict | None = None,
) -> MagicMock:
    """Build a mock FastAPI Request object."""
    req = AsyncMock()
    req.headers = headers or {}
    req.body = AsyncMock(return_value=body)
    state = SimpleNamespace(**(app_state or {}))
    req.app = SimpleNamespace(state=state)
    return req


# ===========================================================================
# HMAC Signature Verification Tests
# ===========================================================================


class TestVerifySignature:
    """Test the _verify_signature helper."""

    def test_valid_signature(self):
        payload = b'{"pipeline_id": "test"}'
        sig = _make_signature(payload)
        assert _verify_signature(payload, sig, WEBHOOK_SECRET) is True

    def test_invalid_signature(self):
        payload = b'{"pipeline_id": "test"}'
        assert _verify_signature(payload, 'deadbeef', WEBHOOK_SECRET) is False

    def test_empty_signature(self):
        payload = b'{"pipeline_id": "test"}'
        assert _verify_signature(payload, '', WEBHOOK_SECRET) is False

    def test_different_payload_fails(self):
        payload = b'{"pipeline_id": "test"}'
        sig = _make_signature(payload)
        tampered = b'{"pipeline_id": "evil"}'
        assert _verify_signature(tampered, sig, WEBHOOK_SECRET) is False

    def test_different_secret_fails(self):
        payload = b'{"pipeline_id": "test"}'
        sig = _make_signature(payload, secret='wrong-secret')
        assert _verify_signature(payload, sig, WEBHOOK_SECRET) is False

    def test_uses_timing_safe_comparison(self):
        """Confirm we use hmac.compare_digest, not ==."""
        payload = b'test'
        sig = _make_signature(payload)
        with patch('ai.web.endpoints.webhook.hmac.compare_digest', return_value=True) as mock_cd:
            result = _verify_signature(payload, sig, WEBHOOK_SECRET)
            assert result is True
            mock_cd.assert_called_once()


# ===========================================================================
# Webhook Trigger Endpoint Tests
# ===========================================================================


class TestWebhookTrigger:
    """Test the POST /webhook/{pipeline_id} endpoint."""

    def setup_method(self):
        """Clear active tasks between tests."""
        _active_tasks.clear()
        # Reset running count and lock
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 0
        wh_mod._running_lock = asyncio.Lock()

    @pytest.mark.asyncio
    async def test_missing_secret_env_var(self):
        req = _make_request()
        with patch.dict('os.environ', {}, clear=True):
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert body['status'] == 'Error'
        assert result.status_code == 500

    @pytest.mark.asyncio
    async def test_missing_signature_header(self):
        req = _make_request()
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}):
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert body['status'] == 'Error'
        assert 'Missing X-Webhook-Signature' in body['error']['error']
        assert result.status_code == 401

    @pytest.mark.asyncio
    async def test_invalid_signature_rejected(self):
        req = _make_request(headers={'x-webhook-signature': 'bad-sig'})
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}):
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert body['status'] == 'Error'
        assert 'Invalid webhook signature' in body['error']['error']
        assert result.status_code == 401

    @pytest.mark.asyncio
    async def test_valid_signature_accepted(self):
        payload = b'{}'
        sig = _make_signature(payload)
        req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
        mock_task = MagicMock()
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task') as mock_ct:
            mock_ct.return_value = mock_task
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert body['status'] == 'OK'
        assert body['data']['pipeline_id'] == 'my-pipeline'
        assert body['data']['status'] == 'accepted'
        assert 'token' in body['data']
        # Background task was dispatched
        mock_ct.assert_called_once()
        # Task reference stored to prevent GC
        token = body['data']['token']
        assert _active_tasks[token]['_task'] is mock_task

    @pytest.mark.asyncio
    async def test_rate_limiting(self):
        """When at max concurrent, new requests should be rejected with 429."""
        import ai.web.endpoints.webhook as wh_mod

        original_max = wh_mod._MAX_CONCURRENT
        wh_mod._MAX_CONCURRENT = 1
        wh_mod._running_count = 1  # simulate one already running

        try:
            payload = b'{}'
            sig = _make_signature(payload)
            req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
            with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task'):
                result = await webhook_trigger(req, 'my-pipeline', {})
            body = json.loads(result.body.decode())
            assert body['status'] == 'Error'
            assert result.status_code == 429
            assert 'Too many concurrent' in body['error']['error']
        finally:
            wh_mod._MAX_CONCURRENT = original_max
            wh_mod._running_count = 0


# ===========================================================================
# Webhook Status Endpoint Tests
# ===========================================================================


class TestWebhookStatus:
    """Test the GET /webhook/{pipeline_id}/status/{token} endpoint."""

    def setup_method(self):
        _active_tasks.clear()

    @pytest.mark.asyncio
    async def test_status_not_found(self):
        req = _make_request()
        result = await webhook_status(req, 'my-pipeline', 'nonexistent-token')
        body = json.loads(result.body.decode())
        assert body['status'] == 'Error'
        assert result.status_code == 404
        assert 'Task not found' in body['error']['error']

    @pytest.mark.asyncio
    async def test_status_pipeline_mismatch(self):
        token = 'abc-123'
        _active_tasks[token] = {
            'pipeline_id': 'real-pipeline',
            'status': 'accepted',
            'created_at': datetime.now(timezone.utc).isoformat(),
        }
        req = _make_request()
        result = await webhook_status(req, 'wrong-pipeline', token)
        body = json.loads(result.body.decode())
        assert body['status'] == 'Error'
        # Mismatch returns the same generic message as missing token
        # to prevent leaking token existence
        assert 'Task not found' in body['error']['error']
        assert result.status_code == 404

    @pytest.mark.asyncio
    async def test_status_found(self):
        token = 'abc-123'
        _active_tasks[token] = {
            'pipeline_id': 'my-pipeline',
            'status': 'accepted',
            'created_at': datetime.now(timezone.utc).isoformat(),
        }
        req = _make_request()
        result = await webhook_status(req, 'my-pipeline', token)
        body = json.loads(result.body.decode())
        assert body['status'] == 'OK'
        assert body['data']['status'] == 'accepted'


# ===========================================================================
# Pydantic Model Validation Tests
# ===========================================================================


class TestScheduleCreateModel:
    """Test ScheduleCreate Pydantic model validation."""

    def test_valid_schedule(self):
        s = ScheduleCreate(
            pipeline_id='my-pipeline',
            cron_expression='0 * * * *',
            name='hourly-run',
        )
        assert s.pipeline_id == 'my-pipeline'
        assert s.cron_expression == '0 * * * *'
        assert s.enabled is True

    def test_invalid_cron_too_few_fields(self):
        with pytest.raises(ValueError, match='5 fields'):
            ScheduleCreate(
                pipeline_id='my-pipeline',
                cron_expression='30 8 * MON',
                name='bad-cron',
            )

    def test_invalid_cron_too_many_fields(self):
        with pytest.raises(ValueError, match='5 fields'):
            ScheduleCreate(
                pipeline_id='my-pipeline',
                cron_expression='* * * * * *',
                name='bad-cron',
            )

    def test_empty_pipeline_id_rejected(self):
        with pytest.raises(ValueError, match='at least 1 character'):
            ScheduleCreate(
                pipeline_id='',
                cron_expression='0 * * * *',
                name='empty-id',
            )

    def test_empty_name_rejected(self):
        with pytest.raises(ValueError, match='at least 1 character'):
            ScheduleCreate(
                pipeline_id='my-pipeline',
                cron_expression='0 * * * *',
                name='',
            )

    def test_input_data_optional(self):
        s = ScheduleCreate(
            pipeline_id='my-pipeline',
            cron_expression='0 * * * *',
            name='no-data',
        )
        assert s.input_data is None

    def test_input_data_accepted(self):
        s = ScheduleCreate(
            pipeline_id='my-pipeline',
            cron_expression='0 * * * *',
            name='with-data',
            input_data={'key': 'value'},
        )
        assert s.input_data == {'key': 'value'}


class TestWebhookResponseModel:
    """Test WebhookResponse Pydantic model."""

    def test_webhook_response_fields(self):
        now = datetime.now(timezone.utc)
        wr = WebhookResponse(
            token='abc-123',
            pipeline_id='my-pipeline',
            status='accepted',
            created_at=now,
        )
        assert wr.token == 'abc-123'
        assert wr.status == 'accepted'
        assert wr.created_at == now


class TestScheduleResponseModel:
    """Test ScheduleResponse Pydantic model."""

    def test_schedule_response_fields(self):
        now = datetime.now(timezone.utc)
        sr = ScheduleResponse(
            id='sched-1',
            pipeline_id='my-pipeline',
            cron_expression='0 * * * *',
            name='hourly',
            enabled=True,
            next_run_time=now,
            created_at=now,
        )
        assert sr.id == 'sched-1'
        assert sr.enabled is True


class TestScheduleListModel:
    """Test ScheduleList Pydantic model."""

    def test_schedule_list_empty(self):
        sl = ScheduleList(schedules=[], total=0)
        assert sl.total == 0
        assert len(sl.schedules) == 0

    def test_schedule_list_with_items(self):
        now = datetime.now(timezone.utc)
        item = ScheduleResponse(
            id='sched-1',
            pipeline_id='p1',
            cron_expression='0 * * * *',
            name='hourly',
            enabled=True,
            next_run_time=None,
            created_at=now,
        )
        sl = ScheduleList(schedules=[item], total=1)
        assert sl.total == 1
        assert sl.schedules[0].id == 'sched-1'


# ===========================================================================
# PipelineScheduler Tests (mocked APScheduler + SQLite)
# ===========================================================================


class TestPipelineScheduler:
    """Test PipelineScheduler CRUD operations with mocked APScheduler."""

    def _make_scheduler(self, *, max_concurrent: int = 10):
        """Build a PipelineScheduler with a fully mocked APScheduler backend."""
        with (
            patch('ai.web.scheduler.scheduler.SQLAlchemyJobStore'),
            patch('ai.web.scheduler.scheduler.AsyncIOScheduler') as MockAsyncScheduler,
        ):
            mock_aps = MagicMock()
            mock_aps.running = False
            mock_aps.get_jobs.return_value = []
            MockAsyncScheduler.return_value = mock_aps

            from ai.web.scheduler.scheduler import PipelineScheduler

            sched = PipelineScheduler(
                pipeline_executor=AsyncMock(return_value='token-123'),
                db_path=':memory:',
                max_concurrent_jobs=max_concurrent,
            )
            sched._scheduler = mock_aps
            return sched

    def test_start_and_shutdown(self):
        sched = self._make_scheduler()
        sched._scheduler.running = False
        sched.start()
        sched._scheduler.start.assert_called_once()

        sched._scheduler.running = True
        sched.shutdown()
        sched._scheduler.shutdown.assert_called_once_with(wait=True)

    def test_add_schedule(self):
        sched = self._make_scheduler()
        with patch.object(sched, '_parse_cron') as mock_parse, patch.object(sched, '_validate_min_interval'):
            mock_parse.return_value = MagicMock()
            schedule_id = sched.add_schedule(
                pipeline_id='my-pipeline',
                cron_expression='0 * * * *',
                name='hourly',
            )
            assert schedule_id is not None
            sched._scheduler.add_job.assert_called_once()
            # Metadata should be stored in the job's kwargs
            call_kwargs = sched._scheduler.add_job.call_args
            job_kwargs = call_kwargs.kwargs.get('kwargs', {})
            assert job_kwargs['pipeline_id'] == 'my-pipeline'
            assert job_kwargs['cron_expression'] == '0 * * * *'
            assert job_kwargs['name'] == 'hourly'

    def test_remove_schedule_success(self):
        sched = self._make_scheduler()
        result = sched.remove_schedule('sched-1')
        assert result is True
        sched._scheduler.remove_job.assert_called_once_with('sched-1')

    def test_remove_schedule_not_found(self):
        from apscheduler.jobstores.base import JobLookupError

        sched = self._make_scheduler()
        sched._scheduler.remove_job.side_effect = JobLookupError('nonexistent')
        result = sched.remove_schedule('nonexistent')
        assert result is False

    def test_remove_schedule_unexpected_error_propagates(self):
        sched = self._make_scheduler()
        sched._scheduler.remove_job.side_effect = RuntimeError('db failure')
        with pytest.raises(RuntimeError, match='db failure'):
            sched.remove_schedule('sched-1')

    def test_list_schedules_empty(self):
        sched = self._make_scheduler()
        sched._scheduler.get_jobs.return_value = []
        result = sched.list_schedules()
        assert result == []

    def test_list_schedules_with_jobs(self):
        sched = self._make_scheduler()
        now = datetime.now(timezone.utc)
        mock_job = MagicMock()
        mock_job.id = 'sched-1'
        mock_job.name = 'hourly'
        mock_job.next_run_time = now
        mock_job.kwargs = {
            'pipeline_id': 'p1',
            'cron_expression': '0 * * * *',
            'name': 'hourly',
            'created_at': now.isoformat(),
        }
        sched._scheduler.get_jobs.return_value = [mock_job]
        result = sched.list_schedules()
        assert len(result) == 1
        assert result[0].id == 'sched-1'
        assert result[0].pipeline_id == 'p1'

    def test_get_schedule_found(self):
        sched = self._make_scheduler()
        now = datetime.now(timezone.utc)
        mock_job = MagicMock()
        mock_job.id = 'sched-1'
        mock_job.name = 'hourly'
        mock_job.next_run_time = now
        mock_job.kwargs = {
            'pipeline_id': 'p1',
            'cron_expression': '0 * * * *',
            'name': 'hourly',
            'created_at': now.isoformat(),
        }
        sched._scheduler.get_job.return_value = mock_job
        result = sched.get_schedule('sched-1')
        assert result is not None
        assert result.pipeline_id == 'p1'

    def test_get_schedule_not_found(self):
        sched = self._make_scheduler()
        sched._scheduler.get_job.return_value = None
        result = sched.get_schedule('nonexistent')
        assert result is None

    def test_pause_schedule_success(self):
        sched = self._make_scheduler()
        result = sched.pause_schedule('sched-1')
        assert result is True
        sched._scheduler.pause_job.assert_called_once_with('sched-1')

    def test_pause_schedule_not_found(self):
        from apscheduler.jobstores.base import JobLookupError

        sched = self._make_scheduler()
        sched._scheduler.pause_job.side_effect = JobLookupError('nonexistent')
        result = sched.pause_schedule('nonexistent')
        assert result is False

    def test_pause_schedule_unexpected_error_propagates(self):
        sched = self._make_scheduler()
        sched._scheduler.pause_job.side_effect = RuntimeError('db failure')
        with pytest.raises(RuntimeError, match='db failure'):
            sched.pause_schedule('sched-1')

    def test_resume_schedule_success(self):
        sched = self._make_scheduler()
        result = sched.resume_schedule('sched-1')
        assert result is True
        sched._scheduler.resume_job.assert_called_once_with('sched-1')

    def test_resume_schedule_not_found(self):
        from apscheduler.jobstores.base import JobLookupError

        sched = self._make_scheduler()
        sched._scheduler.resume_job.side_effect = JobLookupError('nonexistent')
        result = sched.resume_schedule('nonexistent')
        assert result is False

    def test_resume_schedule_unexpected_error_propagates(self):
        sched = self._make_scheduler()
        sched._scheduler.resume_job.side_effect = RuntimeError('db failure')
        with pytest.raises(RuntimeError, match='db failure'):
            sched.resume_schedule('sched-1')


# ===========================================================================
# Cron Expression Validation Tests
# ===========================================================================


class TestCronValidation:
    """Test cron expression parsing and minimum interval enforcement."""

    def test_parse_valid_cron(self):
        from ai.web.scheduler.scheduler import PipelineScheduler

        trigger = PipelineScheduler._parse_cron('0 * * * *')
        assert trigger is not None

    def test_parse_invalid_cron_too_few_fields(self):
        from ai.web.scheduler.scheduler import PipelineScheduler

        with pytest.raises(ValueError, match='5 fields'):
            PipelineScheduler._parse_cron('* *')

    def test_parse_invalid_cron_too_many_fields(self):
        from ai.web.scheduler.scheduler import PipelineScheduler

        with pytest.raises(ValueError, match='5 fields'):
            PipelineScheduler._parse_cron('* * * * * *')

    def test_parse_invalid_cron_bad_value(self):
        from ai.web.scheduler.scheduler import PipelineScheduler

        with pytest.raises(ValueError, match='Invalid cron expression'):
            PipelineScheduler._parse_cron('99 99 99 99 99')

    def test_min_interval_enforcement(self):
        """A '* * * * *' (every minute) schedule should pass the 60s threshold."""
        from ai.web.scheduler.scheduler import PipelineScheduler

        trigger = PipelineScheduler._parse_cron('* * * * *')
        # Should NOT raise because every-minute meets the 60s threshold
        PipelineScheduler._validate_min_interval(trigger)


# ===========================================================================
# Concurrent Job Limit Tests
# ===========================================================================


class TestConcurrentJobLimit:
    """Test that the scheduler respects the max concurrent jobs limit."""

    @pytest.mark.asyncio
    async def test_execute_pipeline_skips_when_at_limit(self):
        """When running_jobs >= max_concurrent, the job should be skipped."""
        with (
            patch('ai.web.scheduler.scheduler.SQLAlchemyJobStore'),
            patch('ai.web.scheduler.scheduler.AsyncIOScheduler'),
        ):
            from ai.web.scheduler.scheduler import PipelineScheduler

            executor = AsyncMock(return_value='token-123')
            sched = PipelineScheduler(
                pipeline_executor=executor,
                db_path=':memory:',
                max_concurrent_jobs=2,
            )
            sched._running_jobs = 2  # At limit

            await sched._execute_pipeline(pipeline_id='my-pipeline', input_data=None)

            # The executor should NOT have been called
            executor.assert_not_called()

    @pytest.mark.asyncio
    async def test_execute_pipeline_runs_when_below_limit(self):
        """When below the limit, the executor should be called."""
        with (
            patch('ai.web.scheduler.scheduler.SQLAlchemyJobStore'),
            patch('ai.web.scheduler.scheduler.AsyncIOScheduler'),
        ):
            from ai.web.scheduler.scheduler import PipelineScheduler

            executor = AsyncMock(return_value='token-123')
            sched = PipelineScheduler(
                pipeline_executor=executor,
                db_path=':memory:',
                max_concurrent_jobs=5,
            )
            sched._running_jobs = 0

            await sched._execute_pipeline(pipeline_id='my-pipeline', input_data={'key': 'value'})

            executor.assert_called_once_with('my-pipeline', {'key': 'value'})
            # running_jobs should be back to 0 after completion
            assert sched._running_jobs == 0

    @pytest.mark.asyncio
    async def test_execute_pipeline_decrements_on_error(self):
        """Even if the executor raises, running_jobs must be decremented."""
        with (
            patch('ai.web.scheduler.scheduler.SQLAlchemyJobStore'),
            patch('ai.web.scheduler.scheduler.AsyncIOScheduler'),
        ):
            from ai.web.scheduler.scheduler import PipelineScheduler

            executor = AsyncMock(side_effect=RuntimeError('boom'))
            sched = PipelineScheduler(
                pipeline_executor=executor,
                db_path=':memory:',
                max_concurrent_jobs=5,
            )
            sched._running_jobs = 0

            # Should not raise -- errors are caught and logged
            await sched._execute_pipeline(pipeline_id='my-pipeline', input_data=None)

            assert sched._running_jobs == 0


# ===========================================================================
# Webhook _running_count decrement verification
# ===========================================================================


class TestRunningCountDecrement:
    """Verify that _running_count is properly decremented after pipeline execution."""

    def setup_method(self):
        _active_tasks.clear()
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 0
        wh_mod._running_lock = asyncio.Lock()

    @pytest.mark.asyncio
    async def test_running_count_incremented_by_trigger(self):
        """After webhook_trigger, _running_count should be 1 (background task owns decrement)."""
        import ai.web.endpoints.webhook as wh_mod

        payload = b'{}'
        sig = _make_signature(payload)
        req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task') as mock_ct:
            mock_ct.return_value = MagicMock()
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert body['status'] == 'OK'
        # The background task is responsible for decrementing; trigger increments.
        assert wh_mod._running_count == 1
        # Reset for teardown
        wh_mod._running_count = 0

    @pytest.mark.asyncio
    async def test_running_count_decremented_by_execute_pipeline(self):
        """_execute_pipeline must decrement _running_count after completion."""
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 1
        token = 'test-token'
        _active_tasks[token] = {
            'pipeline_id': 'my-pipeline',
            'status': 'accepted',
            'created_at': '2026-01-01T00:00:00+00:00',
            '_monotonic_created': time.monotonic(),
        }
        await _execute_pipeline(token, 'my-pipeline', None)
        assert wh_mod._running_count == 0
        assert _active_tasks[token]['status'] == 'completed'

    @pytest.mark.asyncio
    async def test_running_count_decremented_on_execute_error(self):
        """Even if _execute_pipeline raises internally, count must decrement."""
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 1
        # Use a token not in _active_tasks to trigger a KeyError inside _execute_pipeline
        await _execute_pipeline('missing-token', 'my-pipeline', None)
        assert wh_mod._running_count == 0

    @pytest.mark.asyncio
    async def test_no_double_decrement_on_create_task_error(self):
        """If create_task raises, only the except block decrements (not the background task)."""
        import ai.web.endpoints.webhook as wh_mod

        payload = b'{}'
        sig = _make_signature(payload)
        req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task', side_effect=RuntimeError('boom')):
            result = await webhook_trigger(req, 'my-pipeline', {})
        assert result.status_code == 500
        # _running_count must be back to 0 (incremented once, decremented once)
        assert wh_mod._running_count == 0

    @pytest.mark.asyncio
    async def test_no_decrement_when_task_dispatched_and_error_after(self):
        """If the task was dispatched but a later error occurs, the except block must NOT decrement."""
        import ai.web.endpoints.webhook as wh_mod

        payload = b'{}'
        sig = _make_signature(payload)
        req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
        mock_task = MagicMock()
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task') as mock_ct, patch('ai.web.endpoints.webhook.WebhookResponse', side_effect=RuntimeError('model error')):
            mock_ct.return_value = mock_task
            result = await webhook_trigger(req, 'my-pipeline', {})
        assert result.status_code == 500
        # The background task was dispatched, so it owns the decrement.
        # The except block must NOT decrement, leaving count at 1.
        assert wh_mod._running_count == 1
        # Cleanup
        wh_mod._running_count = 0


# ===========================================================================
# Status endpoint token-existence leak prevention tests
# ===========================================================================


class TestStatusTokenLeakPrevention:
    """Verify that the status endpoint does not leak whether a token exists."""

    def setup_method(self):
        _active_tasks.clear()

    @pytest.mark.asyncio
    async def test_missing_token_and_wrong_pipeline_return_same_message(self):
        """Both missing-token and wrong-pipeline cases must return identical error responses."""
        token = 'real-token'
        _active_tasks[token] = {
            'pipeline_id': 'real-pipeline',
            'status': 'accepted',
            'created_at': datetime.now(timezone.utc).isoformat(),
        }
        req = _make_request()

        # Case 1: token does not exist at all
        result_missing = await webhook_status(req, 'any-pipeline', 'nonexistent-token')
        body_missing = json.loads(result_missing.body.decode())

        # Case 2: token exists but pipeline_id does not match
        result_mismatch = await webhook_status(req, 'wrong-pipeline', token)
        body_mismatch = json.loads(result_mismatch.body.decode())

        # Both must return 404 with identical error messages
        assert result_missing.status_code == 404
        assert result_mismatch.status_code == 404
        assert body_missing['error']['error'] == body_mismatch['error']['error']


# ===========================================================================
# Expired task cleanup tests
# ===========================================================================


class TestExpiredTaskCleanup:
    """Verify that expired tasks are cleaned up from _active_tasks."""

    def setup_method(self):
        _active_tasks.clear()
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 0
        wh_mod._running_lock = asyncio.Lock()

    def test_cleanup_removes_old_tasks(self):
        """Tasks older than _TASK_TTL should be removed."""
        # Insert a task with an old monotonic timestamp
        _active_tasks['old-token'] = {
            'pipeline_id': 'p1',
            'status': 'accepted',
            'created_at': '2024-01-01T00:00:00+00:00',
            '_monotonic_created': time.monotonic() - _TASK_TTL - 100,
        }
        _active_tasks['new-token'] = {
            'pipeline_id': 'p2',
            'status': 'accepted',
            'created_at': '2024-01-01T01:00:00+00:00',
            '_monotonic_created': time.monotonic(),
        }
        _cleanup_expired_tasks()
        assert 'old-token' not in _active_tasks
        assert 'new-token' in _active_tasks

    def test_cleanup_preserves_recent_tasks(self):
        """Tasks within the TTL should be preserved."""
        _active_tasks['recent-token'] = {
            'pipeline_id': 'p1',
            'status': 'accepted',
            'created_at': '2024-01-01T00:00:00+00:00',
            '_monotonic_created': time.monotonic(),
        }
        _cleanup_expired_tasks()
        assert 'recent-token' in _active_tasks

    def test_cleanup_handles_empty_dict(self):
        """Cleanup on an empty dict should not raise."""
        _cleanup_expired_tasks()
        assert len(_active_tasks) == 0


# ===========================================================================
# Scheduler metadata persistence in kwargs tests
# ===========================================================================


class TestSchedulerMetadataPersistence:
    """Verify that scheduler metadata is stored in job kwargs and survives recovery."""

    def _make_scheduler(self, *, max_concurrent: int = 10):
        """Build a PipelineScheduler with a fully mocked APScheduler backend."""
        with (
            patch('ai.web.scheduler.scheduler.SQLAlchemyJobStore'),
            patch('ai.web.scheduler.scheduler.AsyncIOScheduler') as MockAsyncScheduler,
        ):
            mock_aps = MagicMock()
            mock_aps.running = False
            mock_aps.get_jobs.return_value = []
            MockAsyncScheduler.return_value = mock_aps

            from ai.web.scheduler.scheduler import PipelineScheduler

            sched = PipelineScheduler(
                pipeline_executor=AsyncMock(return_value='token-123'),
                db_path=':memory:',
                max_concurrent_jobs=max_concurrent,
            )
            sched._scheduler = mock_aps
            return sched

    def test_metadata_recovered_from_job_kwargs(self):
        """list_schedules should read metadata from job.kwargs (simulating restart)."""
        sched = self._make_scheduler()
        now = datetime.now(timezone.utc)
        mock_job = MagicMock()
        mock_job.id = 'recovered-1'
        mock_job.name = 'hourly'
        mock_job.next_run_time = now
        mock_job.kwargs = {
            'pipeline_id': 'p1',
            'cron_expression': '0 * * * *',
            'name': 'hourly',
            'created_at': now.isoformat(),
        }
        sched._scheduler.get_jobs.return_value = [mock_job]

        # No _schedule_metadata dict — this simulates a restart scenario
        result = sched.list_schedules()
        assert len(result) == 1
        assert result[0].pipeline_id == 'p1'
        assert result[0].cron_expression == '0 * * * *'
        assert result[0].name == 'hourly'

    def test_get_schedule_from_kwargs_after_restart(self):
        """get_schedule should work using job.kwargs alone (no in-memory metadata)."""
        sched = self._make_scheduler()
        now = datetime.now(timezone.utc)
        mock_job = MagicMock()
        mock_job.id = 'recovered-2'
        mock_job.name = 'daily'
        mock_job.next_run_time = now
        mock_job.kwargs = {
            'pipeline_id': 'p2',
            'cron_expression': '0 0 * * *',
            'name': 'daily',
            'created_at': now.isoformat(),
        }
        sched._scheduler.get_job.return_value = mock_job

        result = sched.get_schedule('recovered-2')
        assert result is not None
        assert result.pipeline_id == 'p2'
        assert result.cron_expression == '0 0 * * *'


# ===========================================================================
# Route registration tests
# ===========================================================================


class TestRegisterWebhookRoutes:
    """Test that register_webhook_routes wires up the correct paths."""

    def test_routes_registered(self):
        mock_server = MagicMock()
        register_webhook_routes(mock_server)
        assert mock_server.add_route.call_count == 2
        calls = mock_server.add_route.call_args_list
        assert calls[0].args[0] == '/webhook/{pipeline_id}/trigger'
        assert calls[0].args[2] == ['POST']
        assert calls[1].args[0] == '/webhook/{pipeline_id}/status/{token}'
        assert calls[1].args[2] == ['GET']


# ===========================================================================
# webhook_status filters internal fields
# ===========================================================================


class TestWebhookStatusFiltering:
    """Verify that webhook_status does not expose internal bookkeeping fields."""

    def setup_method(self):
        _active_tasks.clear()

    @pytest.mark.asyncio
    async def test_internal_fields_stripped(self):
        token = 'abc-123'
        _active_tasks[token] = {
            'pipeline_id': 'my-pipeline',
            'status': 'accepted',
            'created_at': datetime.now(timezone.utc).isoformat(),
            '_monotonic_created': time.monotonic(),
        }
        req = _make_request()
        result = await webhook_status(req, 'my-pipeline', token)
        body = json.loads(result.body.decode())
        assert body['status'] == 'OK'
        # Internal fields starting with '_' must not be in the response
        assert '_monotonic_created' not in body['data']


# ===========================================================================
# Error response tests (generic 500, no internal details)
# ===========================================================================


class TestGenericErrorResponses:
    """Verify that unexpected errors return generic 500 without internal details."""

    def setup_method(self):
        _active_tasks.clear()
        import ai.web.endpoints.webhook as wh_mod

        wh_mod._running_count = 0
        wh_mod._running_lock = asyncio.Lock()

    @pytest.mark.asyncio
    async def test_webhook_trigger_returns_generic_500(self):
        """Unexpected errors in webhook_trigger must not leak exception details."""
        payload = b'{}'
        sig = _make_signature(payload)
        req = _make_request(headers={'x-webhook-signature': sig}, body=payload)
        with patch.dict('os.environ', {'ROCKETRIDE_WEBHOOK_SECRET': WEBHOOK_SECRET}), patch('ai.web.endpoints.webhook.asyncio.create_task', side_effect=RuntimeError('boom')):
            result = await webhook_trigger(req, 'my-pipeline', {})
        body = json.loads(result.body.decode())
        assert result.status_code == 500
        assert body['status'] == 'Error'
        assert 'Internal server error' in body['error']['error']
        # Must not contain exception details
        assert 'boom' not in json.dumps(body)
