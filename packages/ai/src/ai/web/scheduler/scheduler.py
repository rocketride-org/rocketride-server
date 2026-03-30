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

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .models import ScheduleResponse

logger = logging.getLogger(__name__)

# Minimum interval between runs — prevent cron expressions that fire every second.
# Default: 60 seconds (once per minute is the fastest allowed).
CONST_MIN_INTERVAL_SECONDS = 60

# Default maximum number of concurrently running scheduled jobs.
CONST_DEFAULT_MAX_CONCURRENT_JOBS = 10


class PipelineScheduler:
    """Manages scheduled pipeline executions using APScheduler with SQLite persistence."""

    def __init__(
        self,
        pipeline_executor: Callable[[str, Optional[Dict[str, Any]]], Coroutine[Any, Any, str]],
        *,
        db_path: Optional[str] = None,
        max_concurrent_jobs: Optional[int] = None,
    ) -> None:
        """
        Initialize the pipeline scheduler.

        Args:
            pipeline_executor: Async callable that executes a pipeline.
                               Signature: (pipeline_id, input_data) -> task_token
            db_path: Path to the SQLite database file for job persistence.
                     Defaults to ROCKETRIDE_SCHEDULER_DB env var or './scheduler_jobs.db'.
            max_concurrent_jobs: Maximum concurrent scheduled jobs allowed.
                                 Defaults to ROCKETRIDE_MAX_SCHEDULED_JOBS env var or 10.
        """
        self._pipeline_executor = pipeline_executor
        self._schedule_metadata: Dict[str, Dict[str, Any]] = {}

        # Resolve configuration from explicit args > env vars > defaults
        if db_path is None:
            db_path = os.environ.get('ROCKETRIDE_SCHEDULER_DB', './scheduler_jobs.db')
        self._db_path = db_path

        if max_concurrent_jobs is None:
            max_concurrent_jobs = int(os.environ.get('ROCKETRIDE_MAX_SCHEDULED_JOBS', str(CONST_DEFAULT_MAX_CONCURRENT_JOBS)))
        self._max_concurrent_jobs = max_concurrent_jobs

        # Track running job count
        self._running_jobs = 0

        # Build the APScheduler
        jobstores = {'default': SQLAlchemyJobStore(url=f'sqlite:///{self._db_path}')}
        self._scheduler = AsyncIOScheduler(jobstores=jobstores)

        # Listen for job lifecycle events
        self._scheduler.add_listener(self._on_job_executed, EVENT_JOB_EXECUTED)
        self._scheduler.add_listener(self._on_job_error, EVENT_JOB_ERROR)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the scheduler. Safe to call multiple times."""
        if not self._scheduler.running:
            self._scheduler.start()
            logger.info('Pipeline scheduler started (db=%s, max_concurrent=%d)', self._db_path, self._max_concurrent_jobs)

    def shutdown(self, wait: bool = True) -> None:
        """Shut down the scheduler gracefully."""
        if self._scheduler.running:
            self._scheduler.shutdown(wait=wait)
            logger.info('Pipeline scheduler shut down')

    @property
    def running(self) -> bool:
        return self._scheduler.running

    # ------------------------------------------------------------------
    # Schedule CRUD
    # ------------------------------------------------------------------

    def add_schedule(
        self,
        pipeline_id: str,
        cron_expression: str,
        input_data: Optional[Dict[str, Any]] = None,
        name: str = '',
    ) -> str:
        """
        Add a new scheduled pipeline execution.

        Args:
            pipeline_id: Identifier of the pipeline to run.
            cron_expression: Five-field cron expression (minute hour day month weekday).
            input_data: Optional data forwarded to the pipeline.
            name: Human-readable name for this schedule.

        Returns:
            Unique schedule ID.

        Raises:
            ValueError: If the cron expression is invalid or fires too frequently.
        """
        schedule_id = str(uuid.uuid4())

        # Parse and validate the cron expression
        trigger = self._parse_cron(cron_expression)

        # Guard against overly aggressive schedules
        self._validate_min_interval(trigger)

        # Register the job with APScheduler
        self._scheduler.add_job(
            self._execute_pipeline,
            trigger=trigger,
            id=schedule_id,
            name=name or f'pipeline-{pipeline_id}',
            args=[pipeline_id, input_data],
            replace_existing=False,
        )

        # Store metadata that APScheduler does not track natively
        self._schedule_metadata[schedule_id] = {
            'pipeline_id': pipeline_id,
            'cron_expression': cron_expression,
            'name': name,
            'created_at': datetime.now(timezone.utc),
        }

        logger.info('Schedule added: id=%s pipeline=%s cron=%s', schedule_id, pipeline_id, cron_expression)
        return schedule_id

    def remove_schedule(self, schedule_id: str) -> bool:
        """Remove a schedule by ID. Returns True if removed, False if not found."""
        try:
            self._scheduler.remove_job(schedule_id)
            self._schedule_metadata.pop(schedule_id, None)
            logger.info('Schedule removed: id=%s', schedule_id)
            return True
        except Exception:
            logger.warning('Schedule not found for removal: id=%s', schedule_id)
            return False

    def list_schedules(self) -> List[ScheduleResponse]:
        """Return all registered schedules."""
        results: List[ScheduleResponse] = []
        for job in self._scheduler.get_jobs():
            meta = self._schedule_metadata.get(job.id, {})
            results.append(
                ScheduleResponse(
                    id=job.id,
                    pipeline_id=meta.get('pipeline_id', ''),
                    cron_expression=meta.get('cron_expression', ''),
                    name=meta.get('name', job.name),
                    enabled=job.next_run_time is not None,
                    next_run_time=job.next_run_time,
                    created_at=meta.get('created_at', datetime.now(timezone.utc)),
                )
            )
        return results

    def get_schedule(self, schedule_id: str) -> Optional[ScheduleResponse]:
        """Get details for a specific schedule. Returns None if not found."""
        job = self._scheduler.get_job(schedule_id)
        if job is None:
            return None
        meta = self._schedule_metadata.get(schedule_id, {})
        return ScheduleResponse(
            id=job.id,
            pipeline_id=meta.get('pipeline_id', ''),
            cron_expression=meta.get('cron_expression', ''),
            name=meta.get('name', job.name),
            enabled=job.next_run_time is not None,
            next_run_time=job.next_run_time,
            created_at=meta.get('created_at', datetime.now(timezone.utc)),
        )

    def pause_schedule(self, schedule_id: str) -> bool:
        """Pause a schedule. Returns True on success, False if not found."""
        try:
            self._scheduler.pause_job(schedule_id)
            logger.info('Schedule paused: id=%s', schedule_id)
            return True
        except Exception:
            logger.warning('Schedule not found for pause: id=%s', schedule_id)
            return False

    def resume_schedule(self, schedule_id: str) -> bool:
        """Resume a paused schedule. Returns True on success, False if not found."""
        try:
            self._scheduler.resume_job(schedule_id)
            logger.info('Schedule resumed: id=%s', schedule_id)
            return True
        except Exception:
            logger.warning('Schedule not found for resume: id=%s', schedule_id)
            return False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_cron(cron_expression: str) -> CronTrigger:
        """Parse a five-field cron expression into an APScheduler CronTrigger."""
        parts = cron_expression.strip().split()
        if len(parts) != 5:
            raise ValueError('Cron expression must have exactly 5 fields (minute hour day month weekday)')
        try:
            return CronTrigger(
                minute=parts[0],
                hour=parts[1],
                day=parts[2],
                month=parts[3],
                day_of_week=parts[4],
            )
        except Exception as exc:
            raise ValueError(f'Invalid cron expression: {cron_expression!r} — {exc}') from exc

    @staticmethod
    def _validate_min_interval(trigger: CronTrigger) -> None:
        """Reject cron triggers that could fire more often than once per minute."""
        now = datetime.now(timezone.utc)
        first = trigger.get_next_fire_time(None, now)
        if first is None:
            raise ValueError('Cron expression will never fire')
        second = trigger.get_next_fire_time(first, first)
        if second is not None:
            interval = (second - first).total_seconds()
            if interval < CONST_MIN_INTERVAL_SECONDS:
                raise ValueError(f'Cron expression fires too frequently (every {interval}s). Minimum interval is {CONST_MIN_INTERVAL_SECONDS}s.')

    async def _execute_pipeline(self, pipeline_id: str, input_data: Optional[Dict[str, Any]]) -> None:
        """Execute a pipeline when a scheduled job fires."""
        if self._running_jobs >= self._max_concurrent_jobs:
            logger.warning('Skipping scheduled run for pipeline %s — at max concurrent limit (%d)', pipeline_id, self._max_concurrent_jobs)
            return

        self._running_jobs += 1
        try:
            token = await self._pipeline_executor(pipeline_id, input_data)
            logger.info('Scheduled pipeline %s started — token=%s', pipeline_id, token)
        except Exception:
            logger.exception('Scheduled pipeline %s failed', pipeline_id)
        finally:
            self._running_jobs -= 1

    def _on_job_executed(self, event) -> None:  # noqa: ANN001
        """Handle successful job completion."""
        logger.debug('Job %s executed successfully', event.job_id)

    def _on_job_error(self, event) -> None:  # noqa: ANN001
        """Log error when a job raises an exception."""
        logger.error('Job %s raised an error: %s', event.job_id, event.exception)
