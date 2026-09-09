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

Teams-as-environments deployments over two DAP commands (dispatched by
``subcommand``) on the existing WebSocket connection:

  - ``rrext_deploy`` — the GENERIC, kind-agnostic rail door: ``add`` deploys
    any kind (pipe|app|node) as an IMMUTABLE, sha256-locked registry version;
    ``versions``/``artifact``/``history`` read the rail.
  - ``rrext_deploy_pipe`` — PIPE-specific control: ``deploy`` points a TEAM at
    a published version. Teams ARE the environments (Staging, Production, ...):
    promotion and rollback are this same pointer move aimed at a different
    version or team; targets are always explicit (no default-team fallback).
    Plus its lifecycle, scheduling (``set_schedule``/pause/resume), and
    run-now dispatch (``run``).
  - Every deploy and pointer change lands in an immutable audit history.
  - ``list``/``versions``/``history`` return the standard list envelope
    ({rows, total, page, pageSize}) with page/search/filter/sort arguments.

Usage:
    result = await client.deploy.add(my_pipeline, comment='v2 prompt fix')
    await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-staging')
    live = await client.deploy.list()
    await client.deploy.set_schedule('proj-1', 'webhook_1', '*/15 * * * *', team_id='team-staging')
    await client.deploy.pause_schedule('proj-1', 'webhook_1', 'team-staging')
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Any

from .types.deploy import (
    AppVerifyReport,
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

    # =========================================================================
    # ADD — deploy any kind of object into the org registry (the ONE rail door)
    # =========================================================================

    async def add(
        self,
        pipeline: PipelineConfig | None = None,
        *,
        kind: str = 'pipe',
        data: bytes | bytearray | None = None,
        metadata: dict[str, Any] | None = None,
        comment: str | None = None,
        deploy_to: str | None = None,
    ) -> PublishResult:
        """
        Deploy an object to the server as the next immutable registry version.

        The ONE generic rail door for every kind — DEPLOY in the settled
        vocabulary means "copy code to the server"; binding it to an audience
        is the separate publish step (:meth:`deploy` for pipe teams; the app
        publish verbs for apps). The artifact is sha256-locked: what was
        deployed is provably what runs. Mirrors the TypeScript
        ``client.deploy.add``.

        Kind dispatch:
          - ``kind='pipe'`` (default): pass ``pipeline`` — the full definition
            dict; ``name`` is REQUIRED (server-enforced): artifacts are
            immutable and pipelineName renders on every deploy surface, so a
            nameless deploy would show as a project GUID forever.
          - ``kind='app'``: pass ``data`` — ONE zip of the app's SOURCE (the
            server owns the build and never trusts client-produced binaries).
            Two layouts: package.json + src at the zip root (legacy), or
            workspace-relative with ``metadata.appRoot`` naming the app folder
            so ``appManifest.include`` extras ride at their real workspace
            paths. The server retains the zip and unpacks it at receipt; the
            app deployment is born state 'private' (an @me/@team binding may
            serve it; the developer submits it for review to reach the public
            store).

        Args:
            pipeline: Pipeline definition (kind 'pipe').
            kind: 'pipe' (default) or 'app'.
            data: Source zip bytes (kind 'app').
            metadata: Optional metadata blob (e.g. projectId provenance,
                appRoot for workspace-relative app zips).
            comment: Optional "what changed" note kept in the registry.
            deploy_to: Optional team id to deploy the new version to
                immediately (one-step add+deploy; pipes only).

        Returns:
            ``{'artifact': ...}`` plus ``'deployment'`` when ``deploy_to``
            was given.
        """
        kwargs: dict = {'subcommand': 'add', 'kind': kind, 'comment': comment or ''}
        if pipeline is not None:
            kwargs['pipeline'] = pipeline
        if data is not None:
            kwargs['data'] = data
        if metadata is not None:
            kwargs['metadata'] = metadata
        if deploy_to is not None:
            kwargs['deployTo'] = deploy_to
        return await self._client.call('rrext_deploy', **kwargs)

    async def add_app(
        self,
        app_root: str,
        *,
        workspace_root: str | None = None,
        comment: str | None = None,
        metadata: dict[str, Any] | None = None,
        on_progress: Any = None,
    ) -> PublishResult:
        """
        Pack an app folder's source and deploy it as the next immutable
        registry version — the ONE call behind the App Builder's Deploy
        button and CI scripts.

        Packing follows the exact App Builder rules (workspace-rooted zip
        layout, ``appManifest.include`` honored, hierarchical gitignore
        filtering with the hard baseline node_modules/dist/.git, symlink
        containment, 50MB zipped / 512MB uncompressed caps); every step can
        narrate through ``on_progress``. Deploying never activates anything
        — bind an audience with
        :meth:`~rocketride.mixins.apps.AppsMixin.publish_app` afterwards.
        Run :meth:`verify_app` first for a no-side-effect precheck.

        Args:
            app_root: The app folder — absolute, or relative to
                ``workspace_root``.
            workspace_root: The workspace the zip is rooted at and that
                ``appManifest.include`` entries resolve against
                (default: the current working directory).
            comment: Optional "what changed" note kept in the registry.
            metadata: Extra metadata merged over the packed defaults
                (``appRoot`` is always set from the pack).
            on_progress: Optional ``callable(line: str)`` receiving one
                line per pack step.

        Returns:
            The artifact entry for the new version.
        """
        # step: pack with the shared rules (raises ValueError on a missing
        # folder, a bad include entry, or a breached size cap)
        from ._app_pack import pack_app_source

        packed = pack_app_source(workspace_root or os.getcwd(), app_root, on_progress)
        merged: dict[str, Any] = dict(metadata or {})
        if packed.app_root:
            merged['appRoot'] = packed.app_root
        return await self.add(
            kind='app',
            data=packed.data,
            metadata=merged,
            comment=comment,
        )

    async def create_app(
        self,
        slug: str,
        *,
        workspace_root: str | None = None,
        template: str = 'Blank',
        display_name: str | None = None,
        developer_id: str | None = None,
        sidebar: bool = False,
        status_footer: bool = True,
        doc_tabs: bool = False,
        install: bool = True,
        server_base_url: str | None = None,
        on_progress: Any = None,
    ) -> dict:
        """
        Scaffold a new app in the workspace — the programmatic twin of the
        App Builder's New App wizard, rendering the identical templates.
        Writes ``./apps/<slug>``, ensures the pnpm workspace file and ignore
        hygiene, vendors the connected server's shell + client packages, and
        runs the workspace install. Scaffolding only — nothing is deployed;
        the normal lifecycle (edit -> :meth:`verify_app` -> :meth:`add_app`
        -> publish) follows. Mirrors the TypeScript
        ``client.deploy.createApp``.

        Args:
            slug: The app-name slug (lowercase; digits/-/_ after the first
                character). The id becomes ``<developerId>.<slug>``.
            workspace_root: The workspace folder that owns ./apps
                (default: the current working directory).
            template: 'Blank' (default) or 'Dashboard'.
            display_name: Display name (default: the slug, title-cased).
            developer_id: Developer id for the app-id namespace (default
                'local' — publishable beyond the workspace only after a
                real developer id is registered).
            sidebar: Two-column frame with a navigation sidebar.
            status_footer: Status bar across the bottom of the app.
            doc_tabs: Document tab strip across the content area.
            install: Run ``pnpm install`` at the workspace root
                (default True; failure is non-fatal).
            server_base_url: HTTP(S) base for vendoring the server-matched
                shell + client packages; defaults to this client's own
                connection.
            on_progress: Optional ``callable(line: str)`` receiving one
                line per step. Invoked on the worker thread the scaffold
                runs on, not on the caller's event loop.

        Returns:
            The created app's identity and a report of what ran
            (``appId``, ``folder``, ``files``, ``vendored``,
            ``installed``).

        Raises:
            ValueError: On an invalid slug/developer id/template or an
                existing folder.
        """
        # step: scaffold with the shared templates (lazy imports mirror
        # add_app's _app_pack pattern; rocketride_common stays out of the
        # SDK's module-level import graph)
        from rocketride_common.provision import to_http_base

        from ._app_scaffold import create_app_workspace

        # step: vendor from the server THIS client talks to unless
        # overridden — ws(s) URIs map onto the http(s) origin serving
        # /client/*, by the one shared normalization rule
        base = server_base_url
        if not base:
            uri = self._client.get_connection_info().get('uri') or ''
            if uri:
                base = to_http_base(uri)

        # step: the scaffold blocks for minutes (two artifact downloads
        # plus `pnpm install`), so it runs on a worker thread instead of
        # stalling the event loop that services this client's socket
        return await asyncio.to_thread(
            create_app_workspace,
            workspace_root or os.getcwd(),
            slug,
            template=template,
            display_name=display_name,
            developer_id=developer_id,
            sidebar=sidebar,
            status_footer=status_footer,
            doc_tabs=doc_tabs,
            install=install,
            server_base_url=base,
            on_progress=on_progress,
        )

    async def verify_app(self, app_root: str, *, workspace_root: str | None = None) -> AppVerifyReport:
        """
        Pre-check everything :meth:`add_app` needs, WITHOUT deploying —
        purely local, no server call. Verifies the manifest shape and id
        grammar, declared icon/README assets, ``appManifest.include``
        entries, and a pack dry run against the size caps. Server-side
        concerns (the build, store review) are out of scope.

        Args:
            app_root: The app folder — absolute, or relative to
                ``workspace_root``.
            workspace_root: The workspace the pack would be rooted at
                (default: the current working directory).

        Returns:
            :class:`~rocketride.types.AppVerifyReport` — ``ok`` plus every
            check with an actionable note.
        """
        from ._app_pack import verify_app_source

        return verify_app_source(workspace_root or os.getcwd(), app_root)

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
        return await self._client.call(
            'rrext_deploy_pipe', subcommand='deploy', projectId=project_id, version=version, teamId=team_id
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
            team_id: Restrict to one team; omitted = the visibility model:
                the caller's member teams plus their own personal space, and
                the whole org for an org admin.
            page: 1-based page number.
            page_size: Rows per page (server-clamped).
            search: Free-text search over projectId/pipelineName/teamId.
            filters: Column filters (e.g. ``{'state': 'enabled'}``).
            sort: ``[{'field': ..., 'dir': 'asc'|'desc'}]`` sorters.

        Returns:
            ``{'rows', 'total', 'page', 'pageSize'}``.
        """
        kwargs: dict = {'subcommand': 'list'}
        if team_id is not None:
            kwargs['teamId'] = team_id
        return await self._client.call(
            'rrext_deploy_pipe', **_list_args(kwargs, page, page_size, search, filters, sort)
        )

    async def get(self, project_id: str, team_id: str) -> Deployment:
        """
        One team's deployment of a project, registry-joined.

        Args:
            project_id: The project.
            team_id: The team whose deployment to fetch.

        Returns:
            The deployment record (version, state, schedules, actors).
        """
        return await self._client.call('rrext_deploy_pipe', subcommand='get', projectId=project_id, teamId=team_id)

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
        return await self._client.call(
            'rrext_deploy_pipe', subcommand='run', projectId=project_id, sourceId=source_id, teamId=team_id
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
        return await self._client.call('rrext_deploy_pipe', subcommand='disable', projectId=project_id, teamId=team_id)

    async def enable(self, project_id: str, team_id: str) -> Deployment:
        """
        Enable one team's disabled deployment.

        Args:
            project_id: The project.
            team_id: The team whose deployment to enable.

        Returns:
            The updated deployment record.
        """
        return await self._client.call('rrext_deploy_pipe', subcommand='enable', projectId=project_id, teamId=team_id)

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
        return await self._client.call('rrext_deploy_pipe', subcommand='remove', projectId=project_id, teamId=team_id)

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
        return await self._client.call('rrext_deploy_pipe', **kwargs)

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
        kwargs: dict = {
            'subcommand': 'source_config',
            'projectId': project_id,
            'sourceId': source_id,
            'teamId': team_id,
            'debugOut': debug_out,
        }
        if trace_level is not None:
            kwargs['traceLevel'] = trace_level
        return await self._client.call('rrext_deploy_pipe', **kwargs)

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
        return await self._client.call(
            'rrext_deploy_pipe', subcommand='schedule_pause', projectId=project_id, sourceId=source_id, teamId=team_id
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
        return await self._client.call(
            'rrext_deploy_pipe', subcommand='schedule_resume', projectId=project_id, sourceId=source_id, teamId=team_id
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
        kwargs: dict = {'subcommand': 'preview', 'schedule': schedule}
        if count is not None:
            kwargs['count'] = count
        return await self._client.call('rrext_deploy_pipe', **kwargs)
