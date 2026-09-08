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

"""File-backed deployment backend — the OSS implementation of the account
module's ``deployments_*`` interface, and the artifact-file layer the SaaS
implementation shares.

Model (teams-as-environments):
  - PUBLISH creates an IMMUTABLE artifact version in the ORG registry:
        orgs/<org_id>/files/.deployments/<project_id>/v000N-<sha8>.json
    The artifact is the pipeline JSON exactly as published; its sha256 is
    recorded and re-verified on every load, so what was tested is provably
    what runs. The hash in the filename keeps racing publishers on
    different files (see artifact_path).
  - DEPLOY points a TEAM at a registry version (a pointer move). Promotion
    and rollback are the same gesture aimed at different versions/teams.
  - Every publish and every pointer change is recorded immutably (who, what,
    when) — the enterprise audit trail. Removal is SOFT: state='removed',
    history and artifacts are never destroyed.

Storage layout, one directory per project under the org's system-owned
``.deployments`` tree (raw file access is internal/sys.admin only — the
store's system-tree rule — while this backend is the domain API):
    <project_id>/v000001-<sha8>.json   immutable artifact (never overwritten)
    <project_id>/meta.json             registry index + per-team deployments +
                                       history + schedules (CAS-guarded)

Uses IStore directly (the trusted, in-server layer): paths are constructed
here from validated ids, never from caller-supplied path strings.
"""

import hashlib
import json
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

from rocketlib import error

from ai.common.list_rows import paginate_rows

from .store import IStore, StorageError, VersionMismatchError

# How many CAS retries a meta.json read-modify-write attempts before failing.
# Mirrors the store's own retry posture for read-modify-write records.
_CAS_ATTEMPTS = 5

# Deployment states a team pointer can be in. 'disabled' is the user's
# whole-deployment kill switch (nothing runs); 'removed' is the soft-delete
# terminal state: invisible in listings, history retained forever.
_STATES = ('enabled', 'disabled', 'errored', 'removed')


def _safe_id(value: str, what: str) -> str:
    """Validate an identifier that becomes a physical path segment.

    org/project/team ids originate from session data and the DB, but they are
    embedded into store paths here — so they must be path-safe: non-empty, no
    separators, no traversal, no reserved sigils.

    Args:
        value: The identifier to validate.
        what:  Human name for error messages ('org_id', 'project_id', ...).

    Returns:
        The validated identifier, unchanged.

    Raises:
        ValueError: The identifier is unusable as a path segment.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f'{what} is required')
    if '/' in value or '\\' in value or value in ('.', '..') or value.startswith(('@', '=', '.')):
        raise ValueError(f'{what} contains invalid characters: {value!r}')
    return value


def _actor_record(actor: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize an actor into the denormalized audit identity we persist.

    The display/email copies deliberately DENORMALIZE the user so the audit
    trail survives account deletion (the enterprise requirement) — a bare
    foreign key would go NULL and lose "who".

    Args:
        actor: Mapping with at least ``userId``; optionally ``display`` and
               ``email``.

    Returns:
        ``{'userId', 'display', 'email'}`` with missing fields as ''.
    """
    if not isinstance(actor, dict) or not actor.get('userId'):
        raise ValueError('actor.userId is required')
    return {
        'userId': str(actor['userId']),
        'display': str(actor.get('display') or ''),
        'email': str(actor.get('email') or ''),
    }


def artifact_path(org_id: str, project_id: str, version: int, sha256: str) -> str:
    """Physical store path of one immutable artifact version.

    The content hash rides in the filename so two publishers racing on the
    same version number write DIFFERENT files: the CAS loser's artifact
    can never overwrite the winner's, and the winner's registry entry
    (which stores this path) always references its own intact bytes. A
    version+hash collision implies identical bytes, where an overwrite is
    a no-op. Readers never derive this path — they use the entry's stored
    ``artifactPath``.
    """
    return f'orgs/{org_id}/files/.deployments/{project_id}/v{version:06d}-{sha256[:8]}.json'


def artifact_sha256(data: str) -> str:
    """The registry hash of an artifact: sha256 over the exact stored bytes."""
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


class FileDeploymentBackend:
    """The ``deployments_*`` operations over IStore-backed JSON files.

    One instance per process (owned by the Account singleton). All methods
    validate ids, then operate on the org's ``.deployments`` tree with CAS
    on ``meta.json`` so concurrent publishers/deployers never lose updates.
    """

    def __init__(self, store: IStore) -> None:
        """Bind the backend to a raw IStore (the account-module trust level)."""
        self._store = store

    # =========================================================================
    # PUBLISH — immutable artifact into the org registry
    # =========================================================================

    async def publish(
        self,
        org_id: str,
        project_id: str,
        pipeline: Dict[str, Any],
        actor: Dict[str, Any],
        comment: str = '',
    ) -> Dict[str, Any]:
        """Snapshot ``pipeline`` as the next immutable registry version.

        Args:
            org_id:     Owning organisation (registry scope).
            project_id: Pipeline project id (registry key inside the org).
            pipeline:   Full pipeline JSON to snapshot.
            actor:      Who is publishing ({'userId', 'display', 'email'}).
            comment:    Optional "what changed" note, kept in the registry.

        Returns:
            The new registry entry (version, sha256, publishedBy, ...).
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        if not isinstance(pipeline, dict) or not pipeline:
            raise ValueError('pipeline must be a non-empty object')
        who = _actor_record(actor)

        # The artifact bytes are canonical: stable key order so the sha256 is
        # reproducible from the semantic pipeline, not dict ordering.
        data = json.dumps(pipeline, sort_keys=True, indent=1)
        sha = artifact_sha256(data)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Allocate the next version and append the registry entry."""
            version = 1 + max((v['version'] for v in meta['versions']), default=0)
            entry = {
                'version': version,
                'sha256': sha,
                'bytes': len(data.encode('utf-8')),
                'pipelineName': str(pipeline.get('name') or ''),
                'publishedBy': who,
                'publishedAt': time.time(),
                'comment': str(comment or ''),
                'artifactPath': artifact_path(org_id, project_id, version, sha),
            }
            # Write the artifact BEFORE committing the meta: an orphaned
            # artifact file is harmless; a registry entry without its
            # artifact would be a broken deploy target. The content hash in
            # the path makes a CAS retry write a NEW file, never overwrite
            # a committed one.
            await self._store.write_file(entry['artifactPath'], data)
            meta['versions'].append(entry)
            meta['history'].append(
                {'at': entry['publishedAt'], 'action': 'publish', 'teamId': '', 'version': version, 'actor': who}
            )
            return entry

        return await self._mutate_meta(org_id, project_id, mutate)

    # =========================================================================
    # DEPLOY — point a team at a version (promotion and rollback alike)
    # =========================================================================

    async def deploy(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        version: int,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Set ``team_id``'s deployment of ``project_id`` to ``version``.

        Creates the team deployment on first use; otherwise moves the
        pointer. Moving to a LOWER version is recorded as 'rollback' in the
        history (same operation, honest audit label).

        Returns:
            The team's deployment record after the move.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        who = _actor_record(actor)
        if not isinstance(version, int) or version < 1:
            raise ValueError('version must be a positive integer')

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Validate the target version and move the team pointer."""
            if not any(v['version'] == version for v in meta['versions']):
                raise ValueError(f'version {version} is not published for {project_id}')
            now = time.time()
            dep = meta['deployments'].get(team_id)
            if dep is None:
                dep = {
                    'teamId': team_id,
                    'version': version,
                    'state': 'enabled',
                    'createdAt': now,
                    'createdBy': who,
                    'schedules': {},
                }
                meta['deployments'][team_id] = dep
                action = 'deploy'
            else:
                action = 'rollback' if version < dep['version'] else 'deploy'
                dep['version'] = version
                # A pointer move revives a removed/errored deployment.
                dep['state'] = 'enabled'
            dep['updatedAt'] = now
            dep['updatedBy'] = who
            # The pointer-move stamp: "deployed on". Only deploy() writes it —
            # disable/enable and schedule edits bump updatedAt, never this.
            dep['deployedAt'] = now
            meta['history'].append({'at': now, 'action': action, 'teamId': team_id, 'version': version, 'actor': who})
            return self._joined(meta, project_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    # =========================================================================
    # STATE + SOFT REMOVE
    # =========================================================================

    async def set_state(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        state: str,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Change a team deployment's state (enable/disable/errored/removed).

        'removed' is the soft delete: listings hide it, history and the
        registry keep everything.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        who = _actor_record(actor)
        if state not in _STATES:
            raise ValueError(f'invalid state {state!r}')

        # History speaks user verbs, not raw states.
        action = {'enabled': 'enable', 'disabled': 'disable', 'errored': 'errored', 'removed': 'remove'}[state]

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Flip the state and record the action."""
            dep = meta['deployments'].get(team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            now = time.time()
            dep['state'] = state
            dep['updatedAt'] = now
            dep['updatedBy'] = who
            meta['history'].append(
                {'at': now, 'action': action, 'teamId': team_id, 'version': dep['version'], 'actor': who}
            )
            return self._joined(meta, project_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    # =========================================================================
    # SCHEDULES — per (team deployment, source)
    # =========================================================================

    async def schedule_set(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        source_id: str,
        cron: Optional[str],
        actor: Dict[str, Any],
        ttl: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Set (or clear, with ``cron=None``) one source's schedule.

        The paused flag is NOT set here — editing cron/ttl preserves it (a
        new schedule starts unpaused); ``schedule_set_paused`` owns the flag.
        Cron validity is the COMMAND layer's job (the single evaluator);
        this layer just persists what it is given.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        _safe_id(source_id, 'source_id')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Upsert or remove the schedule row on the team deployment."""
            dep = meta['deployments'].get(team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            now = time.time()
            existing = dep['schedules'].get(source_id) or {}
            if cron is None:
                # Clearing the SCHEDULE keeps the row when it still carries
                # execution settings (the row doubles as the per-source
                # config record; cron '' renders as 'manual' everywhere).
                if existing.get('traceLevel') or existing.get('debugOut'):
                    dep['schedules'][source_id] = {**existing, 'cron': '', 'ttl': None}
                else:
                    dep['schedules'].pop(source_id, None)
            else:
                dep['schedules'][source_id] = {
                    'cron': cron,
                    # Pause state and execution settings survive cron/ttl
                    # edits; new schedules start unpaused, default trace.
                    'paused': bool(existing.get('paused', False)),
                    'traceLevel': existing.get('traceLevel'),
                    'debugOut': bool(existing.get('debugOut', False)),
                    # Run window: None = until the pipeline finishes; seconds =
                    # fixed window (the dispatch passes it as the task ttl).
                    'ttl': ttl,
                    'lastRunAt': existing.get('lastRunAt'),
                }
            dep['updatedAt'] = now
            dep['updatedBy'] = who
            return self._joined(meta, project_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def source_config_set(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        source_id: str,
        trace_level: 'str | None',
        debug_out: bool,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Set one source's execution settings (trace level + debug output).

        The schedule row doubles as the per-source config record: a source
        with settings but no cron keeps a row with cron '' (the 'manual'
        wire semantic). Validity of trace_level is the COMMAND layer's job.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        _safe_id(source_id, 'source_id')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Upsert the config fields on the (possibly new) row."""
            dep = meta['deployments'].get(team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            existing = dep['schedules'].get(source_id) or {'cron': '', 'paused': False, 'ttl': None, 'lastRunAt': None}
            existing['traceLevel'] = trace_level
            existing['debugOut'] = bool(debug_out)
            dep['schedules'][source_id] = existing
            dep['updatedAt'] = time.time()
            dep['updatedBy'] = who
            return self._joined(meta, project_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def schedule_set_paused(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        source_id: str,
        paused: bool,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Pause or resume ONE source's schedule, preserving cron/ttl.

        Raises:
            StorageError: The deployment is missing/removed, or the source
                has no schedule to pause.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        _safe_id(source_id, 'source_id')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Flip the paused flag on the existing schedule row."""
            dep = meta['deployments'].get(team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            sched = dep['schedules'].get(source_id)
            if sched is None:
                raise StorageError(f'No schedule for source {source_id} on {project_id} for team {team_id}')
            sched['paused'] = bool(paused)
            dep['updatedAt'] = time.time()
            dep['updatedBy'] = who
            return self._joined(meta, project_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def mark_run(self, org_id: str, team_id: str, project_id: str, source_id: str) -> None:
        """Stamp lastRunAt on a schedule after the scheduler fires it.

        Best-effort — a lost stamp only ages the "last fired" display.
        """
        try:

            async def mutate(meta: Dict[str, Any]) -> None:
                """Set the fired timestamp when the schedule still exists."""
                dep = meta['deployments'].get(team_id)
                if dep and source_id in dep.get('schedules', {}):
                    dep['schedules'][source_id]['lastRunAt'] = time.time()

            await self._mutate_meta(org_id, project_id, mutate)
        except Exception as e:
            error(f'deployments.mark_run: {project_id}/{source_id}: {e}')

    # =========================================================================
    # READS
    # =========================================================================

    async def list_team(self, org_id: str, team_id: str) -> List[Dict[str, Any]]:
        """All non-removed deployments of one team, joined with registry info."""
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        out: List[Dict[str, Any]] = []
        for project_id in await self._project_ids(org_id):
            meta = await self._read_meta(org_id, project_id)
            if meta is None:
                continue
            dep = meta['deployments'].get(team_id)
            if not dep or dep.get('state') == 'removed':
                continue
            out.append(self._joined(meta, project_id, dep))
        return out

    async def get(self, org_id: str, team_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """One team deployment (joined with registry info), or None."""
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        if meta is None:
            return None
        dep = meta['deployments'].get(team_id)
        if not dep or dep.get('state') == 'removed':
            return None
        return self._joined(meta, project_id, dep)

    async def versions(self, org_id: str, project_id: str) -> List[Dict[str, Any]]:
        """The registry entries for a project, newest first (version strip)."""
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        if meta is None:
            return []
        return sorted(meta['versions'], key=lambda v: v['version'], reverse=True)

    async def history(
        self,
        org_id: str,
        project_id: str,
        team_id: Optional[str] = None,
        list_args: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """The audit trail as a list-API envelope ({rows,total,page,pageSize}).

        History is the unbounded surface (append-only enterprise audit), so
        paging is the BACKEND's job — this OSS implementation materializes
        the (small) trail and applies the shared list convention; the SaaS
        implementation runs the same contract as real SQL.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        rows: List[Dict[str, Any]] = []
        if meta is not None:
            # 'seq' = append position in the FULL trail: the stable identity
            # and order key of an append-only log. Timestamps can tie inside
            # the clock's resolution; seq cannot — so newest-first is simply
            # seq descending, and pages never shuffle rows across requests.
            # The DB backend exposes its row id under the same key.
            rows = [{'seq': i, **r} for i, r in enumerate(meta['history'])]
            if team_id is not None:
                rows = [r for r in rows if r['teamId'] in ('', team_id)]
        return paginate_rows(
            rows,
            list_args or {},
            searchable_keys=('action', 'teamId'),
            default_sort=('seq', 'desc'),
            tiebreak_key='seq',
        )

    async def artifact(self, org_id: str, project_id: str, version: int) -> Dict[str, Any]:
        """Load one artifact version, sha256-verified against the registry.

        Raises:
            StorageError: Unknown version, missing file, or hash mismatch —
                a mismatch means the artifact bytes are not what was
                published, and it must never run.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        entry = next((v for v in (meta or {}).get('versions', []) if v['version'] == version), None)
        if entry is None:
            raise StorageError(f'{project_id} v{version}: not in the registry')
        data = await self._store.read_file(entry['artifactPath'])
        if artifact_sha256(data) != entry['sha256']:
            raise StorageError(f'{project_id} v{version}: artifact sha256 mismatch — refusing to load')
        return json.loads(data)

    async def iter_enabled(self) -> 'AsyncGenerator[Dict[str, Any], None]':
        """Yield every ENABLED team deployment across all orgs (scheduler feed).

        Each item: {orgId, teamId, projectId, version, state, schedules}.
        """
        # Same guard as _project_ids: a fresh store has no orgs/ tree yet —
        # the scheduler feed yields nothing rather than raising.
        try:
            orgs = await self._store.list_entries('orgs/', recursive=False, include_files=False)
        except StorageError:
            return
        for org_prefix in orgs:
            org_id = org_prefix.rstrip('/').rsplit('/', 1)[-1]
            for project_id in await self._project_ids(org_id):
                meta = await self._read_meta(org_id, project_id)
                if meta is None:
                    continue
                for team_id, dep in meta['deployments'].items():
                    if dep.get('state') != 'enabled':
                        continue
                    yield {
                        'orgId': org_id,
                        'teamId': team_id,
                        'projectId': project_id,
                        'version': dep['version'],
                        'state': dep['state'],
                        'schedules': dep.get('schedules', {}),
                    }

    # =========================================================================
    # INTERNAL
    # =========================================================================

    def _meta_path(self, org_id: str, project_id: str) -> str:
        """Physical path of a project's meta record."""
        return f'orgs/{org_id}/files/.deployments/{project_id}/meta.json'

    def _deployments_prefix(self, org_id: str) -> str:
        """Physical prefix of an org's deployments tree."""
        return f'orgs/{org_id}/files/.deployments/'

    async def _project_ids(self, org_id: str) -> List[str]:
        """Project directories present in an org's deployments tree."""
        try:
            dirs = await self._store.list_entries(
                self._deployments_prefix(org_id), recursive=False, include_files=False
            )
        except StorageError:
            return []
        return [d.rstrip('/').rsplit('/', 1)[-1] for d in dirs]

    async def _read_meta(self, org_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """Load and shape-check a project's meta.json; None when absent."""
        try:
            data = await self._store.read_file(self._meta_path(org_id, project_id))
        except StorageError:
            return None
        try:
            meta = json.loads(data)
            meta.setdefault('versions', [])
            meta.setdefault('deployments', {})
            meta.setdefault('history', [])
            return meta
        except Exception as e:
            error(f'deployments: corrupt meta for {org_id}/{project_id}: {e}')
            return None

    async def _mutate_meta(self, org_id: str, project_id: str, mutate) -> Any:
        """CAS read-modify-write of meta.json with bounded retries.

        ``mutate(meta)`` edits the dict in place and returns the caller's
        result. On version conflict the whole cycle re-runs against fresh
        state, so concurrent publish/deploy/schedule calls serialize
        correctly on any backend that honors expected_version.
        """
        last: Exception | None = None
        for _ in range(_CAS_ATTEMPTS):
            path = self._meta_path(org_id, project_id)
            try:
                data, cas_version = await self._store.read_file_with_metadata(path)
                meta = json.loads(data)
            except StorageError:
                meta, cas_version = None, None
            if meta is None:
                meta = {'projectId': project_id, 'orgId': org_id, 'versions': [], 'deployments': {}, 'history': []}
            else:
                meta.setdefault('versions', [])
                meta.setdefault('deployments', {})
                meta.setdefault('history', [])

            result = await mutate(meta)

            try:
                if cas_version is None:
                    # CREATE path: the store contract has no create-if-absent
                    # precondition, so this write is unguarded — two racing
                    # first creators would last-write-win. Acceptable for the
                    # single-process OSS backend (SaaS overrides with DB CAS);
                    # serializing creates here is a parked follow-up.
                    await self._store.write_file(path, json.dumps(meta, indent=1))
                else:
                    await self._store.write_file_atomic(path, json.dumps(meta, indent=1), expected_version=cas_version)
                return result
            except VersionMismatchError as e:
                last = e
                continue
        raise StorageError(f'deployments: meta update contention for {org_id}/{project_id}: {last}')

    def _joined(self, meta: Dict[str, Any], project_id: str, dep: Dict[str, Any]) -> Dict[str, Any]:
        """A client-facing deployment record: pointer + its registry entry."""
        entry = next((v for v in meta['versions'] if v['version'] == dep['version']), {})
        return {
            'projectId': project_id,
            'teamId': dep['teamId'],
            'version': dep['version'],
            'state': dep['state'],
            'schedules': dep.get('schedules', {}),
            'createdAt': dep.get('createdAt'),
            'createdBy': dep.get('createdBy'),
            'updatedAt': dep.get('updatedAt'),
            'updatedBy': dep.get('updatedBy'),
            # Stamped by deploy() on every pointer move; records from before
            # the field existed fall back to updatedAt.
            'deployedAt': dep.get('deployedAt', dep.get('updatedAt')),
            'pipelineName': entry.get('pipelineName', ''),
            'sha256': entry.get('sha256', ''),
            'publishedAt': entry.get('publishedAt'),
            'publishedBy': entry.get('publishedBy'),
        }


__all__ = ['FileDeploymentBackend', 'artifact_path', 'artifact_sha256']
