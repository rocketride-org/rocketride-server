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
TaskServer.start_task() — the same path as an on-demand API call.

Caller responsibilities:
  • Call scheduler.schedule(client_id, record) after every rrext_deploy_add / _update.
  • Call scheduler.unschedule(project_id) after every rrext_deploy_remove.
  • Do NOT call start() more than once.
"""

import asyncio
import heapq
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Dict, List

from croniter import croniter
from rocketlib import debug

from ai.account.models import DeploymentRecord

if TYPE_CHECKING:
    from .task_server import TaskServer


@dataclass(order=True)
class Task:
    next_run: float
    client_id: str = field(compare=False)
    project_id: str = field(compare=False)
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
        self._loop_task: asyncio.Task | None = None

    def schedule(self, client_id: str, record: DeploymentRecord) -> None:
        """Insert or update a deployment. Removes it when manual or not active."""
        project_id = record.pipeline['project_id']
        old = self._tasks.pop(project_id, None)
        if old:
            old.cancelled = True
        if record.schedule == 'manual' or record.state != 'active':
            return
        run_time = croniter(record.schedule, datetime.now()).get_next(datetime).timestamp()
        task = Task(next_run=run_time, client_id=client_id, project_id=project_id)
        self._tasks[project_id] = task
        heapq.heappush(self._schedule, task)

    def unschedule(self, project_id: str) -> None:
        """Remove a deployment from the schedule."""
        old = self._tasks.pop(project_id, None)
        if old:
            old.cancelled = True
        self._active_tokens.pop(project_id, None)

    async def start(self) -> None:
        """Load all persisted deployments then start the scheduler loop."""
        await self._load_all()
        self._loop_task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """Cancel the scheduler loop and wait for it to finish."""
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        self._loop_task = None

    async def _load_all(self) -> None:
        """Populate the schedule from all persisted deployments across all users."""
        try:
            async for client_id, record in self._server.deployments.iter_all():
                self.schedule(client_id, record)
            debug(f'[SCHEDULER] loaded {len(self._tasks)} scheduled deployment(s)')
        except Exception as e:
            debug(f'[SCHEDULER] startup scan failed: {e}')

    async def _loop(self) -> None:
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

                # Skip if the previous run for this deployment is still active.
                prev_token = self._active_tokens.get(task.project_id)
                if prev_token:
                    ctrl = self._server._task_control.get(prev_token)
                    if ctrl and not ctrl.task.is_task_complete():
                        debug(f'[SCHEDULER] {task.project_id}: previous run still active, skipping')
                        record = await self._server.deployments.get(task.client_id, task.project_id)
                        next_run = croniter(record.schedule, datetime.now()).get_next(datetime).timestamp()
                        new_task = Task(next_run=next_run, client_id=task.client_id, project_id=task.project_id)
                        self._tasks[task.project_id] = new_task
                        heapq.heappush(self._schedule, new_task)
                        continue

                asyncio.create_task(self._dispatch(task.client_id, task.project_id))

                record = await self._server.deployments.get(task.client_id, task.project_id)
                next_run = croniter(record.schedule, datetime.now()).get_next(datetime).timestamp()
                new_task = Task(next_run=next_run, client_id=task.client_id, project_id=task.project_id)
                self._tasks[task.project_id] = new_task
                heapq.heappush(self._schedule, new_task)

            # Sleep until the next scheduled run (max 60 s).
            if self._schedule:
                delay = max(1.0, self._schedule[0].next_run - datetime.now().timestamp())
                delay = min(delay, 60.0)
            else:
                delay = 60.0

            await asyncio.sleep(delay)

    async def _dispatch(self, client_id: str, project_id: str) -> None:
        try:
            record = await self._server.deployments.get(client_id, project_id)
        except Exception as e:
            debug(f'[SCHEDULER] {project_id}: failed to load record: {e}')
            return

        try:
            request = {
                'command': 'execute',
                'arguments': {'pipeline': record.pipeline},
            }
            # todo: feat/deploy2 - build conn and verify permissions
            result = await self._server.start_task(
                request,
                conn=None,
                client_id=record.created_by,
                user_id=record.created_by,
            )
            token = result['token']
            self._active_tokens[project_id] = token
            debug(f'[SCHEDULER] {project_id}: dispatched -> task {token}')

        except Exception as e:
            debug(f'[SCHEDULER] {project_id}: dispatch failed: {e}')
