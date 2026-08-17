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
Deploy API namespace for the RocketRide Python SDK.

Teams-as-environments deployments via the ``rrext_deploy`` DAP command
(dispatched by ``subcommand``) over the existing WebSocket connection:

  - ``publish`` snapshots a pipeline as an IMMUTABLE, sha256-locked artifact
    version in the org registry.
  - ``deploy`` points a TEAM at a published version. Teams ARE the
    environments (Staging, Production, ...): promotion and rollback are this
    same pointer move aimed at a different version or team. Deploy targets
    are always explicit — there is deliberately no default-team fallback.
  - Every publish and pointer change lands in an immutable audit history.
  - ``list``/``versions``/``history`` return the standard list envelope
    ({rows, total, page, pageSize}) with page/search/filter/sort arguments.

Usage:
    result = await client.deploy.publish(my_pipeline, comment='v2 prompt fix')
    await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-staging')
    live = await client.deploy.list()
    await client.deploy.set_schedule('proj-1', 'webhook_1', '*/15 * * * *', team_id='team-staging')
    await client.deploy.pause('proj-1', 'team-staging')
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from .core import CONST_DEFAULT_WEB_CLOUD
from .types.deploy import (
    Deployment,
    DeployHistoryResult,
    DeployListResult,
    DeployVersionsResult,
    PublishResult,
    SchedulePreview,
)
from .types.pipeline import PipelineConfig

if TYPE_CHECKING:
    from .client import RocketRideClient

def _list_args(
    kwargs: dict,
    page: int | None,
    page_size: int | None,
    search: str | None,
    filters: dict[str, Any] | None,
    sort: list[dict[str, str]] | None,
) -> dict:
    """Fold the standard list-API arguments into a call kwargs dict.

    Only supplied values are sent — the server applies its own defaults
    (page 1, clamped page size) to whatever is absent.
    """
    for key, value in (
        ('page', page),
        ('page_size', page_size),
        ('search', search),
        ('filters', filters),
        ('sort', sort),
    ):
        if value is not None:
            kwargs[key] = value
    return kwargs


class DeployApi:
    """
    Deployment management namespace on RocketRideClient.

    Accessed via ``client.deploy`` — not instantiated directly. All methods
    delegate to the parent client's ``call()`` method which handles envelope
    construction, sending, error detection, and tracing.
    """

    def __init__(self, client: RocketRideClient) -> None:
        """
        Bind this namespace to its parent client.

        Args:
            client: The RocketRideClient instance that owns this namespace.
        """
        self._client = client

    def _ensure_supported(self) -> None:
        uri = self._client.get_connection_info().get('uri', '')

        cloud_host = urlparse(CONST_DEFAULT_WEB_CLOUD).hostname
        current_host = urlparse(uri).hostname

        if current_host == cloud_host:
            raise RuntimeError(
                'Deploy operations are not supported on RocketRide Cloud.'
            )    

    # =========================================================================
    # PUBLISH — immutable artifact into the org registry
    # =========================================================================

    async def publish(
        self,
        pipeline: PipelineConfig,
        *,
        comment: str | None = None,
        deploy_to: str | None = None,
    ) -> PublishResult:
        """
        Publish a pipeline as the next immutable registry version.

        The artifact is sha256-locked: what was published is provably what
        runs. Publishing alone puts nothing live — point a team at the
        version with :meth:`deploy` (or pass ``deploy_to`` to do both in one
        step, the small-team convenience).

        Args:
            pipeline: The full pipeline definition dict to snapshot. Its
                ``name`` is REQUIRED (server-enforced): artifacts are
                immutable and pipelineName renders on every deploy surface
                — a nameless publish would show as a project GUID forever.
            comment: Optional "what changed" note kept in the registry.
            deploy_to: Optional team id to deploy the new version to
                immediately (one-step publish+deploy).

        Returns:
            ``{'artifact': ...}`` plus ``'deployment'`` when ``deploy_to``
            was given.
        """
        self._ensure_supported()

        kwargs: dict = {'subcommand': 'publish', 'pipeline': pipeline}
        if comment is not None:
            kwargs['comment'] = comment
        if deploy_to is not None:
            kwargs['deployTo'] = deploy_to
        return await self._client.call('rrext_deploy', **kwargs)

    # =========================================================================
    # DEPLOY — point a team at a version (promotion and rollback alike)
    # =========================================================================

    async def deploy(self, project_id: str, version: int, team_id: str) -> Deployment:
        """
        Point a team at a published version.

        Promotion (Staging -> Production) and rollback (v3 -> v2) are both
        this call — the team's pointer moves, nothing else changes. The team
        is always explicit; requires ``task.control`` on it.

        Args:
            project_id: The project whose artifact to deploy.
            version: The registry version to point the team at.
            team_id: The target team (the environment).

        Returns:
            The updated deployment record, registry-joined.
        """
        self._ensure_supported()

        return await self._client.call(
            'rrext_deploy', subcommand='deploy', projectId=project_id, version=version, teamId=team_id
        )

    # =========================================================================
    # READS — standard list envelopes
    # =========================================================================

    async def list(
        self,
        *,
        team_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        search: str | None = None,
        filters: dict[str, Any] | None = None,
        sort: list[dict[str, str]] | None = None,
    ) -> DeployListResult:
        """
        Deployments visible to the caller, as the standard list envelope.

        Args:
            team_id: Restrict to one team; omitted = every team the caller
                can monitor.
            page: 1-based page number.
            page_size: Rows per page (server-clamped).
            search: Free-text search over projectId/pipelineName/teamId.
            filters: Column filters (e.g. ``{'state': 'enabled'}``).
            sort: ``[{'field': ..., 'dir': 'asc'|'desc'}]`` sorters.

        Returns:
            ``{'rows', 'total', 'page', 'pageSize'}``.
        """
        self._ensure_supported()
        kwargs: dict = {'subcommand': 'list'}
        if team_id is not None:
            kwargs['teamId'] = team_id
        return await self._client.call('rrext_deploy', **_list_args(kwargs, page, page_size, search, filters, sort))

    async def get(self, project_id: str, team_id: str) -> Deployment:
        """
        One team's deployment of a project, registry-joined.

        Args:
            project_id: The project.
            team_id: The team whose deployment to fetch.

        Returns:
            The deployment record (version, state, schedules, actors).
        """
        self._ensure_supported()
        return await self._client.call('rrext_deploy', subcommand='get', projectId=project_id, teamId=team_id)

    async def versions(
        self,
        project_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
        search: str | None = None,
        filters: dict[str, Any] | None = None,
        sort: list[dict[str, str]] | None = None,
    ) -> DeployVersionsResult:
        """
        The org-registry versions of a project (the version strip), newest
        first, as the standard list envelope.

        Args:
            project_id: The project whose registry to read.
            page: 1-based page number.
            page_size: Rows per page (server-clamped).
            search: Free-text search over pipelineName/comment.
            filters: Column filters.
            sort: ``[{'field': ..., 'dir': 'asc'|'desc'}]`` sorters.

        Returns:
            ``{'rows', 'total', 'page', 'pageSize'}``.
        """
        self._ensure_supported()
        kwargs: dict = {'subcommand': 'versions', 'projectId': project_id}
        return await self._client.call('rrext_deploy', **_list_args(kwargs, page, page_size, search, filters, sort))

    async def run(self, project_id: str, source_id: str, team_id: str) -> dict:
        """
        Start one deployed source NOW (manual trigger).

        The same trusted team dispatch the scheduler uses — the run
        executes as the team and carries NO human identity; billing
        attributes to the org and team, and who fired it is recorded only
        in the deployment's audit history. The deployment must be enabled.

        Args:
            project_id: The deployed project.
            source_id: The pipeline source to fire.
            team_id: The team whose deployment to run.

        Returns:
            ``{'token', 'version'}`` of the started run.
        """
        self._ensure_supported()
        return await self._client.call(
            'rrext_deploy', subcommand='run', projectId=project_id, sourceId=source_id, teamId=team_id
        )

    async def artifact(self, project_id: str, version: int) -> PipelineConfig:
        """
        Fetch one immutable artifact's pipeline JSON from the registry.

        sha256-verified server-side on load: what you get is provably what
        was published. This is the source of truth for read-only rendering
        of a deployed version — never a local file, never a running task.

        Args:
            project_id: The project.
            version: The registry version to fetch.

        Returns:
            The pipeline definition exactly as published.
        """
        self._ensure_supported()
        return await self._client.call('rrext_deploy', subcommand='artifact', projectId=project_id, version=version)

    async def history(
        self,
        project_id: str,
        *,
        team_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
        search: str | None = None,
        filters: dict[str, Any] | None = None,
        sort: list[dict[str, str]] | None = None,
    ) -> DeployHistoryResult:
        """
        The immutable audit trail of a project, newest first, as the
        standard list envelope.

        The trail is unbounded by design (who published what when, who put
        which version live where) — the server pages it; rows carry ``seq``,
        the stable append-order key, as their identity.

        Args:
            project_id: The project whose trail to read.
            team_id: Restrict to one team's pointer changes (org-wide
                publish rows always ride along).
            page: 1-based page number.
            page_size: Rows per page (server-clamped).
            search: Free-text search over action/teamId.
            filters: Column filters; ``at__gte``/``at__lte`` take epoch
                seconds.
            sort: ``[{'field': ..., 'dir': 'asc'|'desc'}]`` sorters.

        Returns:
            ``{'rows', 'total', 'page', 'pageSize'}``.
        """
        self._ensure_supported()
        kwargs: dict = {'subcommand': 'history', 'projectId': project_id}
        if team_id is not None:
            kwargs['teamId'] = team_id
        return await self._client.call('rrext_deploy', **_list_args(kwargs, page, page_size, search, filters, sort))

    # =========================================================================
    # STATE — enable / disable / soft remove
    # =========================================================================

    async def disable(self, project_id: str, team_id: str) -> Deployment:
        """
        Disable one team's deployment — the kill switch: NOTHING runs
        (schedules stop firing and manual runs are refused) until it is
        enabled again.

        Args:
            project_id: The project.
            team_id: The team whose deployment to disable.

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        return await self._client.call('rrext_deploy', subcommand='disable', projectId=project_id, teamId=team_id)

    async def enable(self, project_id: str, team_id: str) -> Deployment:
        """
        Enable one team's disabled deployment.

        Args:
            project_id: The project.
            team_id: The team whose deployment to enable.

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        return await self._client.call('rrext_deploy', subcommand='enable', projectId=project_id, teamId=team_id)

    async def remove(self, project_id: str, team_id: str) -> Deployment:
        """
        Soft-remove one team's deployment.

        Listings hide it; the audit history and every registry artifact
        survive forever (the enterprise requirement). Re-deploying any
        version revives it.

        Args:
            project_id: The project.
            team_id: The team whose deployment to remove.

        Returns:
            The final deployment record (state ``removed``).
        """
        self._ensure_supported()
        return await self._client.call('rrext_deploy', subcommand='remove', projectId=project_id, teamId=team_id)

    # =========================================================================
    # SCHEDULES
    # =========================================================================

    async def set_schedule(
        self,
        project_id: str,
        source_id: str,
        schedule: str | None,
        team_id: str,
        *,
        ttl: int | None = None,
    ) -> Deployment:
        """
        Set (or clear) one source's schedule on a team deployment.

        The paused flag is untouched — editing cron/ttl preserves it (a new
        schedule starts unpaused); :meth:`pause_schedule` /
        :meth:`resume_schedule` own it.

        Args:
            project_id: The project.
            source_id: The pipeline source the schedule fires.
            schedule: 5-field cron expression; ``None`` or ``'manual'``
                clears the schedule.
            team_id: The team whose deployment to schedule.
            ttl: Run window in seconds ('fixed window'); ``None`` runs each
                task until the pipeline finishes.

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        kwargs: dict = {
            'subcommand': 'schedule_set',
            'projectId': project_id,
            'sourceId': source_id,
            'teamId': team_id,
        }
        if schedule is not None:
            kwargs['schedule'] = schedule
        if ttl is not None:
            kwargs['ttl'] = ttl
        return await self._client.call('rrext_deploy', **kwargs)

    async def set_source_config(
        self,
        project_id: str,
        source_id: str,
        team_id: str,
        *,
        trace_level: 'str | None' = None,
        debug_out: bool = False,
    ) -> Deployment:
        """
        Set one source's execution settings (trace level + debug output).

        These ride every deploy run of the source — scheduled and manual —
        exactly like the dev-run settings. Editing the schedule never
        touches them; a source keeps its settings even with no schedule.

        Args:
            project_id: The project.
            source_id: The source whose settings to store.
            team_id: The team whose deployment carries them.
            trace_level: Trace verbosity ('none'|'metadata'|'summary'|
                'full'); ``None`` = the deploy default (full).
            debug_out: Full task debug output (--trace=debugOut).

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        kwargs: dict = {
            'subcommand': 'source_config',
            'projectId': project_id,
            'sourceId': source_id,
            'teamId': team_id,
            'debugOut': debug_out,
        }
        if trace_level is not None:
            kwargs['traceLevel'] = trace_level
        return await self._client.call('rrext_deploy', **kwargs)

    async def pause_schedule(self, project_id: str, source_id: str, team_id: str) -> Deployment:
        """
        Pause ONE source's schedule — the cron/ttl stay configured, it just
        stops firing until resumed.

        Args:
            project_id: The project.
            source_id: The source whose schedule to pause.
            team_id: The team whose deployment carries the schedule.

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        return await self._client.call(
            'rrext_deploy', subcommand='schedule_pause', projectId=project_id, sourceId=source_id, teamId=team_id
        )

    async def resume_schedule(self, project_id: str, source_id: str, team_id: str) -> Deployment:
        """
        Resume a paused source schedule.

        Args:
            project_id: The project.
            source_id: The source whose schedule to resume.
            team_id: The team whose deployment carries the schedule.

        Returns:
            The updated deployment record.
        """
        self._ensure_supported()
        return await self._client.call(
            'rrext_deploy', subcommand='schedule_resume', projectId=project_id, sourceId=source_id, teamId=team_id
        )

    async def preview(self, schedule: str, count: int | None = None) -> SchedulePreview:
        """
        Validate a schedule and return its next occurrences.

        THE single cron evaluator: panel validation, "next:" lines, and DVR
        ghost tracks all render from this — nothing client-side parses cron,
        so a preview can never disagree with what the scheduler fires.

        Args:
            schedule: 5-field cron expression (or ``'manual'``).
            count: How many upcoming occurrences to return (server-capped).

        Returns:
            ``{'valid', 'next'}`` plus ``'error'`` when invalid.
        """
        self._ensure_supported()
        kwargs: dict = {'subcommand': 'preview', 'schedule': schedule}
        if count is not None:
            kwargs['count'] = count
        return await self._client.call('rrext_deploy', **kwargs)
