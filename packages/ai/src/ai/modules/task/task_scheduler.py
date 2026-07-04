# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
TaskScheduler — background asyncio loop that fires deployed pipelines on schedule.

On startup it scans the store for all active deployments and builds an in-memory
registry of (next_run, record) entries.  A single asyncio task wakes up when the
soonest job is due (capped at 60 s) and dispatches overdue runs via
start_server_task() — the same authenticated path as an on-demand API call.

Caller responsibilities:
  • Call scheduler.schedule(record) after every rrext_deploy_add / _update.
  • Call scheduler.unschedule(project_id) after every rrext_deploy_remove.
  • Do NOT call start() more than once.
"""

import asyncio
import heapq
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Dict, List

from croniter import croniter
from rocketlib import debug, error

from ai.account.models import DeploymentRecord
from .task_server_facade import ServerTaskAuthError, start_server_task

if TYPE_CHECKING:
    from .task_server import TaskServer


@dataclass(order=True)
class Task:
    next_run: float
    client_id: str = field(compare=False)
    project_id: str = field(compare=False)
    schedule: str = field(compare=False)
    cancelled: bool = field(default=False, compare=False)


class TaskScheduler:
    """Asyncio-native cron scheduler for server-managed pipeline deployments."""

    def __init__(self, task_server: 'TaskServer') -> None:
        self._server = task_server
        # min-heap ordered by Task.next_run
        self._schedule: List[Task] = []
        # project_id -> current valid Task; absence means unscheduled
        self._tasks: Dict[str, Task] = {}
        # project_id -> token of the most-recently dispatched task (overlap guard)
        self._active_tokens: Dict[str, str] = {}
        self._scheduling: asyncio.Task | None = None
        self._inflight_starts: set[asyncio.Task] = set()

    def schedule(self, record: DeploymentRecord) -> None:
        """Insert or update a deployment. Removes it when manual or not active."""
        project_id = record.pipeline['project_id']
        old = self._tasks.pop(project_id, None)
        if old:
            old.cancelled = True
        if record.schedule == 'manual' or record.state != 'active':
            return
        run_time = croniter(record.schedule, datetime.now()).get_next(datetime).timestamp()
        task = Task(next_run=run_time, client_id=record.userId, project_id=project_id, schedule=record.schedule)
        self._tasks[project_id] = task
        heapq.heappush(self._schedule, task)

    def unschedule(self, project_id: str) -> None:
        """Remove a deployment from the schedule."""
        old = self._tasks.pop(project_id, None)
        if old:
            old.cancelled = True
        self._active_tokens.pop(project_id, None)

    def start(self) -> None:
        """Start the scheduler in the background: load deployments, then run the loop."""
        self._scheduling = asyncio.create_task(self._main())

    async def _main(self) -> None:
        """Load all persisted deployments, then run the scheduling loop."""
        await self._load()
        await self._run()

    async def shutdown(self) -> None:
        """Cancel the scheduler loop (including any in-flight load), then drain in-flight dispatches."""
        if self._scheduling and not self._scheduling.done():
            self._scheduling.cancel()
            try:
                await self._scheduling
            except asyncio.CancelledError:
                pass
        self._scheduling = None

        if self._inflight_starts:
            await asyncio.gather(*self._inflight_starts, return_exceptions=True)

    async def _load(self) -> None:
        """Populate the schedule from all persisted deployments across all users."""
        try:
            async for record in self._server.deployments.iter_all():
                try:
                    self.schedule(record)
                except Exception as e:
                    error(f'[SCHEDULER] {record.pipeline.get("project_id")}: failed to schedule: {e}')
            debug(f'[SCHEDULER] loaded {len(self._tasks)} scheduled deployment(s)')
        except Exception as e:
            error(f'[SCHEDULER] startup scan failed: {e}')

    async def _run(self) -> None:
        while True:
            now = datetime.now().timestamp()

            while self._schedule:
                task = self._schedule[0]  # peek

                if task.cancelled:
                    heapq.heappop(self._schedule)
                    continue

                if task.next_run > now:
                    break  # front task not due yet

                heapq.heappop(self._schedule)

                try:
                    next_run = croniter(task.schedule, datetime.now()).get_next(datetime).timestamp()
                    new_task = Task(
                        next_run=next_run,
                        client_id=task.client_id,
                        project_id=task.project_id,
                        schedule=task.schedule,
                    )
                    self._tasks[task.project_id] = new_task
                    heapq.heappush(self._schedule, new_task)

                    # Skip if the previous run for this deployment is still active.
                    prev_token = self._active_tokens.get(task.project_id)
                    if prev_token:
                        ctrl = self._server._task_control.get(prev_token)
                        if ctrl and not ctrl.task.is_task_complete():
                            debug(f'[SCHEDULER] {task.project_id}: previous run still active, skipping')
                            continue

                    task_start = asyncio.create_task(self._start_task(task.client_id, task.project_id))
                    self._inflight_starts.add(task_start)
                    task_start.add_done_callback(self._inflight_starts.discard)

                except Exception as e:
                    error(f'[SCHEDULER] {task.project_id}: scheduling tick failed: {e}')

            # Sleep until the next scheduled run (max 60 s).
            if self._schedule:
                delay = max(1.0, self._schedule[0].next_run - datetime.now().timestamp())
                delay = min(delay, 60.0)
            else:
                delay = 60.0

            await asyncio.sleep(delay)

    async def _start_task(self, client_id: str, project_id: str) -> None:
        try:
            record = await self._server.deployments.get(client_id, project_id)
        except Exception as e:
            error(f'[SCHEDULER] {project_id}: failed to load record: {e}')
            return

        if not record.userToken:
            # Without a replayable credential the run can never authenticate.
            error(f'[SCHEDULER] {project_id}: no user token; cannot dispatch')
            return

        try:
            task_token = await start_server_task(self._server, record.userToken, record.pipeline)
        except ServerTaskAuthError as e:
            error(f'[SCHEDULER] {project_id}: authentication failed: {e}; marking errored')
            await self._mark_errored(client_id, record)
            return
        except Exception as e:
            error(f'[SCHEDULER] {project_id}: dispatch failed: {e}')
            return

        self._active_tokens[project_id] = task_token
        debug(f'[SCHEDULER] {project_id}: dispatched -> task {task_token}')

    async def _mark_errored(self, client_id: str, record: DeploymentRecord) -> None:
        """Flip a deployment to 'errored' (e.g. its user token expired) and stop scheduling it.

        Persisting the state lets the UI prompt for a re-deploy; unscheduling stops
        the cron from re-attempting a doomed authentication every tick until then.
        """
        project_id = record.pipeline['project_id']
        try:
            record.state = 'errored'
            record.updatedAt = datetime.now().timestamp()
            await self._server.deployments.save(client_id, record)
        except Exception as e:
            error(f'[SCHEDULER] {project_id}: failed to persist errored state: {e}')
        self.unschedule(project_id)
