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
TaskScheduler — background asyncio loop that fires TEAM deployments on schedule.

Teams-as-environments model: schedule entries are keyed
``(team_id, project_id, source_id)`` — the same project deployed by two teams
(Staging and Production) runs independently, and each SOURCE of a deployment
carries its own cron. On startup the scheduler reads every ENABLED deployment
from the account module (``deployments_iter_enabled`` — OSS files or SaaS DB,
this layer never knows) and builds an in-memory min-heap of next-run entries.

Dispatch is the TRUSTED team path (``start_server_task_as_team``): no stored
credential — the run executes as the team, with the deploying user carried as
attribution only. At fire time the deployment is RE-READ so a disable/remove/
pointer-move or schedule pause between ticks always wins, and the artifact is
sha256-verified before it runs.

Caller responsibilities:
  • Call scheduler.sync(org_id, deployment) after every mutation
    (deploy / enable / disable / remove / schedule_set / schedule_pause /
    schedule_resume).
  • Do NOT call start() more than once.
"""

import asyncio
import heapq
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Tuple

from croniter import croniter
from rocketlib import debug, error, warning

from ai.account import account
from .task_server_facade import start_server_task_as_team

if TYPE_CHECKING:
    from .task_server import TaskServer


# The audit identity used when the SCHEDULER itself mutates a deployment
# (e.g. marking it errored after a failed dispatch).
_SCHEDULER_ACTOR = {'userId': 'system:scheduler', 'display': 'Scheduler', 'email': ''}

# (team_id, project_id, source_id) — the schedule identity.
RunKey = Tuple[str, str, str]


@dataclass(order=True)
class ScheduledRun:
    """One (team, project, source) cron entry in the min-heap."""

    next_run: float
    key: RunKey = field(compare=False)
    org_id: str = field(compare=False)
    cron: str = field(compare=False)
    cancelled: bool = field(default=False, compare=False)


class TaskScheduler:
    """Asyncio-native cron scheduler for team-scoped pipeline deployments."""

    def __init__(self, task_server: 'TaskServer') -> None:
        """Bind to the task server; state is built by start()/sync()."""
        self._server = task_server
        # min-heap ordered by ScheduledRun.next_run
        self._schedule: List[ScheduledRun] = []
        # key -> current valid entry; absence means unscheduled
        self._entries: Dict[RunKey, ScheduledRun] = {}
        # key -> token of the most-recently dispatched run (overlap guard)
        self._active_tokens: Dict[RunKey, str] = {}
        self._scheduling: asyncio.Task | None = None
        self._inflight_starts: set[asyncio.Task] = set()

    # =========================================================================
    # PUBLIC — sync/start/shutdown
    # =========================================================================

    def sync(self, org_id: str, deployment: Dict[str, Any]) -> None:
        """Reconcile the heap with one team deployment's current state.

        Drops every entry for (team, project), then re-adds one entry per
        UNPAUSED schedule when the deployment is enabled — so a single call
        after any mutation (deploy, enable, disable, remove, schedule_set,
        schedule_pause/resume) makes the heap agree with the store.

        Args:
            org_id:     The deployment's organisation.
            deployment: The account-module deployment dict
                        (teamId, projectId, state, schedules{source: {...}}).
        """
        team_id = deployment.get('teamId', '')
        project_id = deployment.get('projectId', '')
        if not team_id or not project_id:
            return

        # Cancel every existing entry for this (team, project).
        for key in [k for k in self._entries if k[0] == team_id and k[1] == project_id]:
            self._entries.pop(key).cancelled = True

        if deployment.get('state') != 'enabled':
            # Disabled/errored/removed deployments also lose their overlap guards.
            for key in [k for k in self._active_tokens if k[0] == team_id and k[1] == project_id]:
                self._active_tokens.pop(key, None)
            return

        for source_id, sched in (deployment.get('schedules') or {}).items():
            cron = (sched or {}).get('cron')
            if not cron or sched.get('paused', False):
                continue
            try:
                next_run = croniter(cron, datetime.now()).get_next(datetime).timestamp()
            except Exception as e:
                error(f'[SCHEDULER] {team_id}/{project_id}/{source_id}: bad cron {cron!r}: {e}')
                continue
            entry = ScheduledRun(next_run=next_run, key=(team_id, project_id, source_id), org_id=org_id, cron=cron)
            self._entries[entry.key] = entry
            heapq.heappush(self._schedule, entry)

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

    # =========================================================================
    # STARTUP LOAD
    # =========================================================================

    async def _load(self) -> None:
        """Populate the schedule from every enabled deployment, all orgs."""
        try:
            count = 0
            async for dep in account.deployments_iter_enabled():
                try:
                    self.sync(dep['orgId'], dep)
                    count += 1
                except Exception as e:
                    error(f'[SCHEDULER] {dep.get("projectId")}: failed to schedule: {e}')
            debug(f'[SCHEDULER] loaded {count} active deployment(s), {len(self._entries)} schedule entrie(s)')
        except Exception as e:
            error(f'[SCHEDULER] startup scan failed: {e}')

        await self._warn_legacy_records()

    async def _warn_legacy_records(self) -> None:
        """One startup warning when pre-teams user-scoped deployments exist.

        The old model stored records at users/<uid>/deployments/ with a
        replayable user token. Those are NOT migrated (the credential model
        changed) — owners re-deploy. Capped scan so a large SaaS user tree
        cannot slow boot.
        """
        try:
            store = self._server.store._store
            users = await store.list_entries('users/', recursive=False, include_files=False)
            for user_prefix in users[:200]:
                legacy = await store.list_entries(
                    f'{user_prefix}deployments/', recursive=False, include_dirs=False, name_pattern='*.json'
                )
                if legacy:
                    warning(
                        '[SCHEDULER] legacy user-scoped deployment records found '
                        f'(e.g. under {user_prefix}deployments/). These are no longer '
                        'scheduled — re-deploy each pipeline to a team.'
                    )
                    return
        except Exception:
            # Purely informational — never let the warning path affect boot.
            pass

    # =========================================================================
    # LOOP
    # =========================================================================

    async def _run(self) -> None:
        """Fire due entries forever; sleep until the soonest one (max 60 s)."""
        while True:
            now = datetime.now().timestamp()

            while self._schedule:
                entry = self._schedule[0]  # peek

                if entry.cancelled:
                    heapq.heappop(self._schedule)
                    continue

                if entry.next_run > now:
                    break  # front entry not due yet

                heapq.heappop(self._schedule)

                try:
                    # Requeue the next occurrence first, so a dispatch failure
                    # can never silently stop the cadence.
                    next_run = croniter(entry.cron, datetime.now()).get_next(datetime).timestamp()
                    new_entry = ScheduledRun(next_run=next_run, key=entry.key, org_id=entry.org_id, cron=entry.cron)
                    self._entries[entry.key] = new_entry
                    heapq.heappush(self._schedule, new_entry)

                    # Skip if the previous run for this (team, project, source)
                    # is still active — schedules never overlap themselves.
                    prev_token = self._active_tokens.get(entry.key)
                    if prev_token:
                        ctrl = self._server._task_control.get(prev_token)
                        if ctrl and not ctrl.task.is_task_complete():
                            debug(f'[SCHEDULER] {entry.key}: previous run still active, skipping')
                            continue

                    task_start = asyncio.create_task(self._start_run(entry))
                    self._inflight_starts.add(task_start)
                    task_start.add_done_callback(self._inflight_starts.discard)

                except Exception as e:
                    error(f'[SCHEDULER] {entry.key}: scheduling tick failed: {e}')

            # Sleep until the next scheduled run (max 60 s).
            if self._schedule:
                delay = max(1.0, self._schedule[0].next_run - datetime.now().timestamp())
                delay = min(delay, 60.0)
            else:
                delay = 60.0

            await asyncio.sleep(delay)

    # =========================================================================
    # DISPATCH
    # =========================================================================

    async def _start_run(self, entry: ScheduledRun) -> None:
        """Fire one (team, project, source) occurrence via trusted dispatch."""
        team_id, project_id, source_id = entry.key
        org_id = entry.org_id

        # Re-read the deployment at fire time: a disable/remove/pointer-move
        # or schedule pause between ticks must always win over the in-memory
        # heap.
        try:
            dep = await account.deployments_get(org_id, team_id, project_id)
        except Exception as e:
            error(f'[SCHEDULER] {entry.key}: failed to load deployment: {e}')
            return
        if dep is None or dep.get('state') != 'enabled':
            self.sync(org_id, dep or {'teamId': team_id, 'projectId': project_id, 'state': 'removed'})
            return
        sched = (dep.get('schedules') or {}).get(source_id)
        if not sched or sched.get('paused', False):
            self.sync(org_id, dep)
            return

        # Load the pointed-at artifact — sha256-verified; a tampered or
        # missing artifact must never run.
        try:
            pipeline = await account.deployments_artifact(org_id, project_id, dep['version'])
        except Exception as e:
            error(f'[SCHEDULER] {entry.key}: artifact v{dep.get("version")} unusable: {e}; marking errored')
            await self._mark_errored(org_id, team_id, project_id)
            return

        # Per-source execution: a task IS project.source — the schedule's
        # source becomes the pipeline entry point for this run.
        pipeline = dict(pipeline)
        pipeline['source'] = source_id

        # The deploying user (from the pointer's audit trail) is the billing
        # attribution identity; the run itself executes as the team.
        actor = dep.get('updatedBy') or dep.get('createdBy') or _SCHEDULER_ACTOR

        try:
            ttl = sched.get('ttl')
            task_token = await start_server_task_as_team(
                self._server,
                pipeline,
                org_id=org_id,
                team_id=team_id,
                actor=actor,
                trigger='schedule',
                ttl=int(ttl) if isinstance(ttl, (int, float)) and ttl else None,
                # Per-source execution settings ride the schedule record.
                trace_level=sched.get('traceLevel') or 'full',
                debug_out=bool(sched.get('debugOut')),
            )
        except PermissionError as e:
            # Permission-shaped failures are permanent until a human acts —
            # mark errored instead of retrying every tick.
            error(f'[SCHEDULER] {entry.key}: dispatch denied: {e}; marking errored')
            await self._mark_errored(org_id, team_id, project_id)
            return
        except Exception as e:
            error(f'[SCHEDULER] {entry.key}: dispatch failed: {e}')
            return

        self._active_tokens[entry.key] = task_token
        await account.deployments_mark_run(org_id, team_id, project_id, source_id)
        debug(f'[SCHEDULER] {entry.key}: dispatched -> task {task_token}')

    async def _mark_errored(self, org_id: str, team_id: str, project_id: str) -> None:
        """Flip a deployment to 'errored' and drop its schedule entries.

        Persisting the state lets the UI surface the failure; the sync stops
        the cron from re-attempting a doomed dispatch every tick until a
        human re-deploys or re-enables.
        """
        try:
            dep = await account.deployments_set_state(org_id, team_id, project_id, 'errored', _SCHEDULER_ACTOR)
            self.sync(org_id, dep)
        except Exception as e:
            error(f'[SCHEDULER] {team_id}/{project_id}: failed to persist errored state: {e}')
