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
    <project_id>/meta.json             the NAME row (kind, nextVersion) +
                                       registry index + ONE publish map
                                       (team, personal and public rows alike,
                                       schedules inline) + history (CAS-guarded)

Uses IStore directly (the trusted, in-server layer): paths are constructed
here from validated ids, never from caller-supplied path strings.
"""

import asyncio
import hashlib
import json
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

from rocketlib import error

from ai.common.list_rows import paginate_rows

from .store import IStore, StorageError, StorageNotFoundError, VersionMismatchError

# How many CAS retries a meta.json read-modify-write attempts before failing.
# Mirrors the store's own retry posture for read-modify-write records.
_CAS_ATTEMPTS = 5

# The restart-recovery scan's retries of an org whose tree could not be read:
# the seconds to wait before each further pass over the failed orgs. The
# startup sweep is the build worker's only scan, so a transient outage on one
# org is retried here, in the same process, a bounded number of times.
_SCAN_RETRY_DELAYS = (2.0, 10.0)

# Deployment states a team pointer can be in. 'disabled' is the user's
# whole-deployment kill switch (nothing runs); 'removed' is the soft-delete
# terminal state: invisible in listings, history retained forever.
_STATES = ('enabled', 'disabled', 'errored', 'removed')

#: The kinds a name can be (plan 2.3): fixed at the first deploy.
_KINDS = ('pipe', 'app', 'node')

#: The storage key of the public publish (file format; never on the wire).
_PUBLIC_KEY = '~public'


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

    System actors (the platform seeder) have no user row: ``userId`` may be
    None when a non-empty ``display`` carries the identity instead — the FK
    stays NULL while the audit trail still says who.

    Args:
        actor: Mapping with at least ``userId`` (or a ``display`` for
               system actors); optionally ``email``.

    Returns:
        ``{'userId', 'display', 'email'}`` with missing fields as ''
        (``userId`` is None for system actors).
    """
    if not isinstance(actor, dict):
        raise ValueError('actor.userId is required')
    user_id = actor.get('userId')
    display = str(actor.get('display') or '')
    if not user_id and not display:
        raise ValueError('actor.userId is required')
    return {
        'userId': str(user_id) if user_id else None,
        'display': display,
        'email': str(actor.get('email') or ''),
    }


def audience_display(audience: Dict[str, str]) -> Dict[str, str]:
    """The self-describing audience payload for a history row.

    History rows are rendered without a second lookup — every id they carry
    must ride with its dereferenced display form (the same denormalization
    rule as the actor identity above). Command-layer callers resolve the
    real display facts before the write (team names live in their session);
    this fallback composes the handle from the audience type alone so a
    bare ``{'type','id'}`` dict — the seeder, a legacy caller — still
    yields a readable row instead of a raw id.

    Args:
        audience: ``{'type','id'}`` plus optional ``name``/``handle``
                  display keys stamped by the resolver.

    Returns:
        A copy with ``handle`` guaranteed present ('@me' | '@public' |
        '@team/<name-or-id>'); resolver-stamped keys pass through verbatim.
    """
    out = dict(audience)
    if not out.get('handle'):
        kind = out.get('type')
        if kind == 'user':
            out['handle'] = '@me'
        elif kind == 'public':
            out['handle'] = '@public'
        else:
            out['handle'] = f'@team/{out.get("name") or out.get("id", "")}'
    return out


# The app review lifecycle on the DEPLOYMENT (deployment_artifacts.state).
# 'private' is the internal-eligible default; 'submit' enters the public
# review queue; the admin approves ('ready') or rejects ('rejected').
# Resubmitting after a reject is a NEW deploy (a new registry version), so
# 'rejected' is terminal; a developer may also withdraw a submission back to
# 'private'. This is the ONE source of an app's review state — the publish
# binding is a pure pointer.
#
# The default for a missing/empty state is 'private' — the SAFE, internal-
# eligible state — and EVERY reader must apply the same default (import this
# constant). A legacy entry written before the state field existed is then
# consistently: internally bindable, blocked from @public until reviewed, and
# still submittable. Defaulting a missing state to 'ready' anywhere would let
# an unreviewed legacy version reach the public store; defaulting it to '' in
# the transition asserter would trap it (no legal edge out of '').
DEFAULT_REVIEW_STATE = 'private'

_REVIEW_TRANSITIONS = {
    ('private', 'submit'),
    ('submit', 'ready'),
    ('submit', 'rejected'),
    ('submit', 'private'),
    # The ladder-less promotion (OSS, no reviewer exists): a version is born
    # 'private' so a failed content write can still land on 'failed', and
    # the deploy door promotes it once its bytes are stored. On a
    # review-ladder server nothing takes this edge: 'ready' is reached from
    # 'submit' by an admin.
    ('private', 'ready'),
    # Content-write compensation: a version whose bytes never fully landed
    # is dead on arrival — 'failed' is terminal (re-deploying allocates a
    # NEW version), so no exit edges exist.
    ('private', 'failed'),
}

# History action verb recorded for each review target state.
_REVIEW_ACTION = {
    'submit': 'request',
    'ready': 'approved',
    'rejected': 'rejected',
    'private': 'withdrawn',
    'failed': 'failed',
}


def _assert_review_transition(current: str, target: str) -> None:
    """Raise ValueError unless (current -> target) is a legal review move.

    Same-state is an idempotent no-op (re-approving a 'ready' deployment is
    harmless). Everything else must be an explicit edge above.
    """
    if current == target:
        return
    if (current, target) not in _REVIEW_TRANSITIONS:
        raise ValueError(f'Illegal review transition {current!r} -> {target!r}')


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


def _assert_file_id_matches(pipeline: Dict[str, Any], pipe_id: str) -> None:
    """
    Require the artifact's own ``project_id`` to be the registry name's pipe segment.

    The ``.pipe`` file carries the SHORT id and the registry name is that id
    inside the publisher's namespace; a file whose id is dotted, or differs
    from the name it is being registered under, would be addressable under
    one name and run under another.

    Args:
        pipeline: The artifact dict.
        pipe_id: The pipe segment of the registry name.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` when the file's id breaks the grammar.
        ValueError: The file's id is not ``pipe_id``.
    """
    from ai.modules.task.address import validate_segment

    file_id = pipeline.get('project_id')
    if file_id is None:
        return
    if validate_segment(file_id, 'pipeline.project_id') != pipe_id:
        raise ValueError(f'pipeline.project_id {file_id!r} does not match the registry name (expected {pipe_id!r})')


def kind_mismatch_message(project_id: str, existing_kind: str, wanted_kind: str) -> str:
    """The refusal when a name already belongs to another kind in the org (plan 2.3, B37).

    One namespace per developer id across apps, pipes and nodes: the first
    deploy of a name fixes its kind, and the other kinds are refused under
    that name forever after. Both backends raise this exact text.

    Args:
        project_id: The short id being deployed.
        existing_kind: The kind the name already is.
        wanted_kind: The kind the caller tried to deploy.

    Returns:
        The message for the ValueError.
    """
    return (
        f"'{project_id}' is already {_an(existing_kind)} in this organization; "
        f'{_an(wanted_kind)} may not share a short id with it under one developer id — choose another name'
    )


def _an(kind: str) -> str:
    """'an app', 'a pipe', 'a node' — the kind with its article."""
    return f'an {kind}' if kind[:1] in 'aeiou' else f'a {kind}'


def artifact_content_dir(artifact_path: str) -> str:
    """The store home of one registry version's CONTENT, from its artifact path.

    ONE convention for seeded and deployed bytes alike: content lives in the
    SIBLING directory of the registry JSON — the artifact path minus its
    ``.json`` extension (``.deployments/<project>/v<N>-<sha8>/``). Zip
    deploys keep ``bundle/`` (the retained transport zip), ``source/`` (what
    the developer shipped) and ``dist/`` (the server build's servable
    output, entry minting points there) under it; platform seeds write the
    SAME ``dist/`` layout. Derived by convention — never stored in the
    artifact JSON.
    """
    return artifact_path[:-5] if artifact_path.endswith('.json') else artifact_path


def artifact_metadata(artifact: Dict[str, Any], metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The rail entry's metadata blob, shared verbatim by both editions.

    Shape: ``{'manifest': {...}, 'build': {...}}``. The caller-supplied
    ``metadata`` wins field-by-field; a minimal ``manifest.name`` is always
    synthesized from the artifact dict so display names never depend on the
    retired pipeline_name column/key.

    Args:
        artifact: The deployed artifact dict (pipeline JSON or app record).
        metadata: Optional caller-supplied metadata blob.

    Returns:
        The metadata dict to persist alongside the registry entry.
    """
    meta = dict(metadata) if isinstance(metadata, dict) else {}
    manifest = meta.get('manifest')
    manifest = dict(manifest) if isinstance(manifest, dict) else {}
    # Display name is mandatory metadata — sourced from the artifact when the
    # caller sent none (plain pipeline JSON carries its name at 'name').
    manifest.setdefault('name', str(artifact.get('name') or ''))
    meta['manifest'] = manifest
    return meta


# Build statuses under which a version is still the build worker's: its
# content dir is being written, so it cannot be deleted from under the job.
_BUILD_IN_FLIGHT = ('queued', 'building')


def delete_block_of(entry: Dict[str, Any], pins: List[Dict[str, Any]]) -> str:
    """Why one registry version cannot be deleted right now ('' when it can).

    THE refusal rule of ``deploy delete`` (plan 2.3), shared by both
    editions: the file backend and the saas DB backend compute the
    versions row's ``deletable`` flag and refuse a delete through this one
    function, so the card's &#10005; and the verb can never disagree. A
    version is deletable only while nothing points at it:

    - no publish row pins it (``pins`` — the rows bound to this version
      that are not soft-removed; the message names each rung's handle),
    - it is not in the review queue (``state == 'submit'``),
    - its build is not queued or running (``metadata.build.status``).

    Args:
        entry: The registry version row.
        pins: The live publish rows pointing at it (``{'audience': ...}``
              dicts; the audience may carry resolver-stamped display keys).

    Returns:
        The refusal sentence, or '' when the version may be deleted.
    """
    version = int(entry.get('version', 0))
    if pins:
        handles = sorted({audience_display(dict(pin.get('audience') or {}))['handle'] for pin in pins})
        return f'v{version} is published to {", ".join(handles)}; unpublish it first'
    if str(entry.get('state') or DEFAULT_REVIEW_STATE) == 'submit':
        return f'v{version} is in review; withdraw it first'
    metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
    build = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
    if str(build.get('status') or '') in _BUILD_IN_FLIGHT:
        return f'v{version} is still building; wait for the build to finish'
    return ''


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
        metadata: Optional[Dict[str, Any]] = None,
        state: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Snapshot ``pipeline`` as the next immutable registry version.

        DEPLOY in the settled vocabulary: copy code to the server. The
        entry's ``kind`` comes from the artifact dict (app artifacts carry
        kind:'app'; plain pipeline JSON defaults to 'pipe'), ``state`` is
        stamped by kind (app -> 'private' — internal-eligible, the developer
        submits it for review; a pipe the same since C.17, plan S8) unless the caller overrides
        it, and ``metadata`` carries the manifest/build blob (a minimal
        manifest.name is synthesized so display names never depend on the
        legacy pipelineName key).

        Args:
            org_id:     Owning organisation (registry scope).
            project_id: Project id — pipe project id / app id (registry key).
            pipeline:   Full artifact dict to snapshot (pipeline JSON or app record).
            actor:      Who is deploying ({'userId', 'display', 'email'}).
            comment:    Optional "what changed" note, kept in the registry.
            metadata:   Optional metadata blob ({'manifest': ..., 'build': ...}).
            state:      Optional born-state override (an artifact review state:
                        private|submit|ready|rejected|failed) — the seeder
                        registers pre-approved platform artifacts as 'ready'.

        Returns:
            The new registry entry (version, sha256, publishedBy, ...).
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        if not isinstance(pipeline, dict) or not pipeline:
            raise ValueError('pipeline must be a non-empty object')
        if state is not None and state not in ('private', 'submit', 'ready', 'rejected', 'failed'):
            raise ValueError(f'Unknown artifact state: {state!r}')
        # A PIPE artifact must satisfy the address grammar at publish exactly
        # as at execute: the registry name is ``developerId.pipeId`` (the
        # short id the file carries inside the publisher's namespace, composed
        # by the deploy door) and dot-free component ids are what make
        # ``developerId.pipelineId.source`` unambiguous. (Deferred import:
        # ai.modules.task's package init pulls the task server, which imports
        # this account layer.)
        if str(pipeline.get('kind') or 'pipe') == 'pipe':
            from ai.common.parameters import validate_parameters
            from ai.modules.task.address import validate_component_ids, validate_pipe_name
            from ai.modules.task.task_convert import convert_pipeline

            name = validate_pipe_name(project_id, 'project_id')
            _assert_file_id_matches(pipeline, name.pipe_id)
            validate_component_ids(pipeline)
            # Old-format node config is converted before it is frozen into an
            # artifact (plan 5.6.8), so no old-shape artifact is created again
            conversion = convert_pipeline(pipeline)
            if conversion.errors:
                raise ValueError('conversion: ' + '; '.join(e['message'] for e in conversion.errors))
            if conversion.touched:
                pipeline = conversion.pipeline
            # The parameters map is frozen into the artifact: it must be valid
            # against the nodes it names (plan 5.4 item 4)
            parameter_errors = validate_parameters(pipeline)
            if parameter_errors:
                raise ValueError('parameters: ' + '; '.join(e['message'] for e in parameter_errors))
        who = _actor_record(actor)

        # The artifact bytes are canonical: stable key order so the sha256 is
        # reproducible from the semantic pipeline, not dict ordering.
        data = json.dumps(pipeline, sort_keys=True, indent=1)
        sha = artifact_sha256(data)
        # Kind rides the artifact dict itself; every kind is born 'private'
        # (internal-eligible, submitted for review separately, plan S8)
        # unless the caller overrides it.
        kind = str(pipeline.get('kind') or 'pipe')
        if kind not in _KINDS:
            raise ValueError(f'Unknown artifact kind: {kind!r}')

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Fix the name's kind, allocate the next version and append the registry entry."""
            # The NAME row (plan 2.3): the meta IS the project row. Its kind
            # is fixed at the first deploy (B37) and its nextVersion hands
            # out numbers that are never reused (a legacy meta without one
            # starts past its highest version).
            # A pre-C.17 meta carries no kind: its versions say what the name is
            existing_kind = str(meta.get('kind') or '')
            if not existing_kind and meta['versions']:
                existing_kind = str(meta['versions'][-1].get('kind') or 'pipe')
            if existing_kind and existing_kind != kind:
                raise ValueError(kind_mismatch_message(project_id, existing_kind, kind))
            meta['kind'] = kind
            version = int(meta.get('nextVersion') or (1 + max((v['version'] for v in meta['versions']), default=0)))
            meta['nextVersion'] = version + 1
            entry = {
                'version': version,
                'sha256': sha,
                'bytes': len(data.encode('utf-8')),
                'kind': kind,
                'state': state or 'private',
                'metadata': artifact_metadata(pipeline, metadata),
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
            # The DEPLOY row (registry write — no audience). The comment is
            # the developer's "what changed" note; riding it on the history
            # row keeps the event stream self-describing (the viewer never
            # joins back to the registry entry).
            history_row: Dict[str, Any] = {
                'at': entry['publishedAt'],
                'action': 'publish',
                'teamId': '',
                'version': version,
                'actor': who,
            }
            if entry['comment']:
                history_row['data'] = {'comment': entry['comment']}
            meta['history'].append(history_row)
            return entry

        return await self._mutate_meta(org_id, project_id, mutate)

    # =========================================================================
    # DELETE — remove one version's storage while nothing points at it
    # =========================================================================

    async def delete_version(
        self,
        org_id: str,
        project_id: str,
        version: int,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Delete ONE registry version from the server (plan 2.3, ``deploy delete``).

        Refused, with the sentence ``delete_block_of`` composes, while any
        publish row pins the version, while it is in review, or while its
        build is queued or running. Otherwise ALL of the version's storage
        goes and nothing is retained but the history lines: the registry
        JSON (``artifactPath``), its sibling content dir whole (``bundle/``,
        ``source/``, ``dist/``, the build log), and the version's entry in
        the project's meta (the OSS build record rides that entry). The
        history keeps the deploy line and gains a ``delete`` line (who,
        when). ``nextVersion`` is untouched, so the number is never reused.

        Two steps, the same shape as the saas twin. FIRST the meta commits
        inside the project's CAS mutate under the per-project lock: the pin
        check and the entry's removal are one step (a publish racing this
        call either lands before the check and refuses it, or after the
        version is gone and is refused itself), the history gains the delete
        line, and a legacy meta without a top-level ``kind`` has it persisted
        from its versions before the last one can disappear (B37). THEN the
        bytes go: the content tree first, the registry JSON last (the
        marker). A store failure after the commit is logged and re-raised
        naming the leftover path; calling again finishes the job — the
        history's delete line rebuilds the paths — and answers
        ``deleted: True`` without a second history line (idempotent).

        Args:
            org_id:     Owning organisation.
            project_id: The registry name (``developerId.id``).
            version:    The registry version to delete.
            actor:      Who is deleting ({'userId', 'display', 'email'}).

        Returns:
            ``{'projectId', 'version', 'kind', 'sha256', 'deleted': True}``.

        Raises:
            StorageError: The project or version is not in the registry.
            ValueError: The version is pinned, in review, or building.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        if not isinstance(version, int) or version < 1:
            raise ValueError('version must be a positive integer')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Refuse while pinned/in review/building; else forget the version in the meta (bytes go after the commit)."""
            entry = next((v for v in meta['versions'] if int(v.get('version', 0)) == version), None)
            if entry is None:
                # The RETRY path: the registry already forgot the version (an
                # earlier call committed the meta, then a store failure left
                # bytes behind). The history's delete line is all that is
                # left of it, and it carries what the paths need (the sha);
                # no second history line is written.
                deleted = next(
                    (
                        row
                        for row in reversed(meta['history'])
                        if row.get('action') == 'delete' and int(row.get('version') or 0) == version
                    ),
                    None,
                )
                if deleted is None:
                    raise StorageError(f'{project_id} v{version}: not in the registry')
                data = deleted.get('data') if isinstance(deleted.get('data'), dict) else {}
                sha = str(data.get('sha256') or '')
                return {
                    'projectId': project_id,
                    'version': version,
                    'kind': str(data.get('kind') or 'pipe'),
                    'sha256': sha,
                    'deleted': True,
                    'deletedAt': deleted.get('at'),
                    '_artifactPath': artifact_path(org_id, project_id, version, sha) if sha else '',
                }
            block = delete_block_of(entry, self._pins_of(meta, version))
            if block:
                raise ValueError(f'{project_id} {block}')
            # The NAME row keeps its kind (B37): a pre-C.17 meta carries none
            # and publish() infers it from the versions — once the last
            # version is gone there is nothing left to infer from, and
            # another kind could claim the name. Persist the same inference
            # before the entry goes.
            if not meta.get('kind'):
                meta['kind'] = str(meta['versions'][-1].get('kind') or 'pipe')
            # The entry (and with it the OSS build record, metadata.build).
            meta['versions'] = [v for v in meta['versions'] if int(v.get('version', 0)) != version]
            now = time.time()
            meta['history'].append(
                {
                    'at': now,
                    'action': 'delete',
                    'teamId': '',
                    'version': version,
                    'actor': who,
                    # What was deleted rides the row: the history is all that
                    # remains of the version, so it must describe it alone
                    # (the sha also rebuilds the paths on a retry).
                    'data': {'sha256': str(entry.get('sha256') or ''), 'kind': str(entry.get('kind') or 'pipe')},
                }
            )
            return {
                'projectId': project_id,
                'version': version,
                'kind': str(entry.get('kind') or 'pipe'),
                'sha256': str(entry.get('sha256') or ''),
                'deleted': True,
                'deletedAt': now,
                '_artifactPath': str(entry.get('artifactPath') or ''),
            }

        # The META commits first (the registry forgets the version; the
        # history says so), the bytes go AFTER — the same shape as the saas
        # twin, so a crash between the two leaves a registry that is already
        # right and files a retry finishes. Content tree first, the registry
        # JSON last: the JSON is the marker a retry finds or finds gone.
        result = await self._mutate_meta(org_id, project_id, mutate)
        artifact_file = str(result.pop('_artifactPath', '') or '')
        if artifact_file:
            content_dir = artifact_content_dir(artifact_file)
            leftover = content_dir
            try:
                await self._store.delete_tree(content_dir)
                leftover = artifact_file
                try:
                    await self._store.delete_file(artifact_file)
                except StorageNotFoundError:
                    pass
            except StorageError as exc:
                error(
                    f'deployments: {project_id} v{version} left the registry but its storage remains at '
                    f'{leftover}: {exc} — run deploy delete again'
                )
                raise StorageError(
                    f'{project_id} v{version} was removed from the registry but its storage could not be '
                    f'deleted ({leftover}): {exc}; run deploy delete again'
                ) from exc
        return result

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
        billing_team_id: str = '',
    ) -> Dict[str, Any]:
        """Set ``team_id``'s deployment of ``project_id`` to ``version``.

        Creates the team deployment on first use; otherwise moves the
        pointer. Moving to a LOWER version is recorded as 'rollback' in the
        history (same operation, honest audit label). ``billing_team_id`` is
        the ABSOLUTE billing/secrets stamp, decided by the command layer at
        pointer time and re-stamped on every move — this store never
        resolves it.

        Returns:
            The team's deployment record after the move.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        if billing_team_id:
            _safe_id(billing_team_id, 'billing_team_id')
        who = _actor_record(actor)
        if not isinstance(version, int) or version < 1:
            raise ValueError('version must be a positive integer')

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Validate the target version and move the slot's pointer."""
            entry = self._artifact_entry_of(meta, version)
            if not entry:
                raise ValueError(f'version {version} is not published for {project_id}')
            now = time.time()
            publishes = self._publishes_of(meta)
            key = self._slot_key(team_id)
            dep = publishes.get(key)
            if dep is None:
                dep = {
                    'kind': str(entry.get('kind') or 'pipe'),
                    'version': version,
                    'state': 'enabled',
                    'billingTeamId': billing_team_id,
                    'schedules': {},
                    'snapshot': {'name': str(entry.get('pipelineName') or '')},
                    'createdAt': now,
                    'createdBy': who,
                }
                publishes[key] = dep
                action = 'deploy'
            else:
                action = 'rollback' if version < int(dep.get('version') or 0) else 'deploy'
                dep['version'] = version
                # A pointer move revives a removed/errored deployment — and
                # RE-STAMPS the billing team: each pointer move re-decides.
                dep['billingTeamId'] = billing_team_id
                dep['state'] = 'enabled'
            dep['updatedAt'] = now
            dep['updatedBy'] = who
            # The pointer-move stamp: "published on". Only deploy() writes it —
            # disable/enable and schedule edits bump updatedAt, never this.
            dep['publishedAt'] = now
            meta['history'].append({'at': now, 'action': action, 'teamId': team_id, 'version': version, 'actor': who})
            return self._joined(meta, project_id, team_id, dep)

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
            dep = self._pointer_of(meta, team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            now = time.time()
            dep['state'] = state
            dep['updatedAt'] = now
            dep['updatedBy'] = who
            meta['history'].append(
                {'at': now, 'action': action, 'teamId': team_id, 'version': dep['version'], 'actor': who}
            )
            return self._joined(meta, project_id, team_id, dep)

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
            dep = self._pointer_of(meta, team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            now = time.time()
            dep.setdefault('schedules', {})
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
            return self._joined(meta, project_id, team_id, dep)

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
            dep = self._pointer_of(meta, team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            dep.setdefault('schedules', {})
            existing = dep['schedules'].get(source_id) or {'cron': '', 'paused': False, 'ttl': None, 'lastRunAt': None}
            existing['traceLevel'] = trace_level
            existing['debugOut'] = bool(debug_out)
            dep['schedules'][source_id] = existing
            dep['updatedAt'] = time.time()
            dep['updatedBy'] = who
            return self._joined(meta, project_id, team_id, dep)

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
            dep = self._pointer_of(meta, team_id)
            if dep is None or dep.get('state') == 'removed':
                raise StorageError(f'No deployment of {project_id} for team {team_id}')
            sched = (dep.get('schedules') or {}).get(source_id)
            if sched is None:
                raise StorageError(f'No schedule for source {source_id} on {project_id} for team {team_id}')
            sched['paused'] = bool(paused)
            dep['updatedAt'] = time.time()
            dep['updatedBy'] = who
            return self._joined(meta, project_id, team_id, dep)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def mark_run(self, org_id: str, team_id: str, project_id: str, source_id: str) -> None:
        """Stamp lastRunAt on a schedule after the scheduler fires it.

        Best-effort — a lost stamp only ages the "last fired" display.
        """
        try:

            async def mutate(meta: Dict[str, Any]) -> None:
                """Set the fired timestamp when the schedule still exists."""
                dep = self._pointer_of(meta, team_id)
                if dep and source_id in (dep.get('schedules') or {}):
                    dep['schedules'][source_id]['lastRunAt'] = time.time()

            await self._mutate_meta(org_id, project_id, mutate)
        except Exception as e:
            error(f'deployments.mark_run: {project_id}/{source_id}: {e}')

    # =========================================================================
    # READS
    # =========================================================================

    async def list_team(self, org_id: str, team_id: 'Optional[str]' = None) -> List[Dict[str, Any]]:
        """Non-removed deployments joined with registry info.

        ``team_id`` scopes to one team (or ``user~`` personal space); None
        returns the WHOLE org — every team and every personal space. The
        backend is mechanical: who may see which rows is the COMMAND
        layer's visibility model, which slices this list.
        """
        _safe_id(org_id, 'org_id')
        if team_id is not None:
            _safe_id(team_id, 'team_id')
        out: List[Dict[str, Any]] = []
        for project_id in await self._project_ids(org_id):
            meta = await self._read_meta(org_id, project_id)
            if meta is None:
                continue
            # Pipe pointer rows only: a team or personal slot, never the
            # public row and never an app's publish.
            for key, dep in self._publishes_of(meta).items():
                if key == _PUBLIC_KEY or dep.get('state') == 'removed':
                    continue
                if team_id is not None and key != self._slot_key(team_id):
                    continue
                if self._row_kind(meta, dep) != 'pipe':
                    continue
                out.append(self._joined(meta, project_id, self._slot_of_key(key), dep))
        return out

    async def get(self, org_id: str, team_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """One team deployment (joined with registry info), or None."""
        _safe_id(org_id, 'org_id')
        _safe_id(team_id, 'team_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        if meta is None:
            return None
        dep = self._pointer_of(meta, team_id)
        if not dep or dep.get('state') == 'removed':
            return None
        return self._joined(meta, project_id, team_id, dep)

    async def versions(self, org_id: str, project_id: str) -> List[Dict[str, Any]]:
        """The registry entries for a project, newest first (version strip)."""
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        meta = await self._read_meta(org_id, project_id)
        if meta is None:
            return []
        # ``deletable`` is computed here, never stored: it is the delete
        # verb's own refusal check (plan 2.3), evaluated on the same pins
        # and build state the verb would see — the card draws its mark from
        # this flag alone.
        rows = []
        for entry in sorted(meta['versions'], key=lambda v: v['version'], reverse=True):
            row = dict(entry)
            row['deletable'] = not delete_block_of(entry, self._pins_of(meta, int(entry.get('version', 0))))
            rows.append(row)
        return rows

    # =========================================================================
    # PUBLISHES — audience pointers (PUBLISH = bind a deployment to an audience)
    # =========================================================================
    #
    # meta['publishes'] = {audience_key: row}; audience_key is the file-format
    # encoding 'user~<id>' | 'team~<id>' | '~public' (never on the wire — the
    # contract carries {'type','id'} audience dicts). ONE map for every kind
    # (plan 10.1): a pipe's team and personal pointers (schedules and the
    # billing team inline) and an app's audience rows are rows of it alike.

    @staticmethod
    def _audience_key(audience: Dict[str, str]) -> str:
        """The storage key of one audience ({'type','id'} -> file encoding)."""
        kind = audience.get('type')
        if kind == 'user':
            return f'user~{audience.get("id", "")}'
        if kind == 'team':
            return f'team~{audience.get("id", "")}'
        if kind == 'public':
            return '~public'
        raise ValueError(f'Unknown audience type: {kind!r}')

    @staticmethod
    def _publish_row(
        key: str,
        row: Dict[str, Any],
        org_id: str,
        project_id: str,
        artifact_state: str = '',
        artifact_path: str = '',
        artifact_build: str = '',
    ) -> Dict[str, Any]:
        """One stored binding -> the contract shape (audience decoded).

        ``row['state']`` is the BINDING lifecycle (enabled/disabled/removed);
        ``artifactState`` is the bound DEPLOYMENT's review state,
        ``artifactPath`` its registry JSON path (the content home derives
        from it), and ``artifactBuild`` its build status
        (metadata.build.status — '' for pre-worker rows), all joined from
        meta['versions'] so the scope walk can gate serving and mint entry
        URLs without a second registry read.
        """
        if key == _PUBLIC_KEY:
            audience = {'type': 'public', 'id': ''}
        elif key.startswith('user~'):
            audience = {'type': 'user', 'id': key[len('user~') :]}
        else:
            audience = {'type': 'team', 'id': key[len('team~') :]}
        return {
            'orgId': org_id,
            # The id under both spellings: 'appId' is the shipped key every
            # app reader uses; 'projectId' is the kind-neutral one.
            'appId': project_id,
            'projectId': project_id,
            'audience': audience,
            'artifactState': artifact_state,
            'artifactPath': artifact_path,
            'artifactBuild': artifact_build,
            'kind': 'pipe',
            'billingTeamId': '',
            'schedules': {},
            'snapshot': {},
            **row,
        }

    @staticmethod
    def _build_status_of(ver: Dict[str, Any]) -> str:
        """One registry entry's build status ('' when never stamped)."""
        metadata = ver.get('metadata') if isinstance(ver.get('metadata'), dict) else {}
        build = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
        return str(build.get('status') or '')

    @staticmethod
    def _artifact_entry_of(meta: Dict[str, Any], version: int) -> Dict[str, Any]:
        """The registry version row a binding points at (from meta['versions'])."""
        for v in meta.get('versions', []):
            if int(v.get('version', 0)) == int(version):
                return v
        return {}

    @staticmethod
    def _review_state_of(ver: Dict[str, Any]) -> str:
        """One registry row's review state — legacy rows default 'private'.

        A row that predates review states carries none; every reader must
        treat that as DEFAULT_REVIEW_STATE, never expose '' as an
        artifactState. '' remains ONLY for a MISSING row ({} from
        _artifact_entry_of): a binding at a deleted version must not read
        as publishable.
        """
        if not ver:
            return ''
        return str(ver.get('state') or DEFAULT_REVIEW_STATE)

    def _publishes_of(self, meta: Dict[str, Any]) -> Dict[str, Any]:
        """The meta's publish map, created on the meta when absent (so writers may add rows)."""
        publishes = meta.get('publishes')
        if not isinstance(publishes, dict):
            publishes = {}
            meta['publishes'] = publishes
        return publishes

    def _row_kind(self, meta: Dict[str, Any], row: Dict[str, Any]) -> str:
        """A publish row's kind: its own stamp, else the kind of the version it points at."""
        kind = row.get('kind')
        if kind:
            return str(kind)
        return str(self._artifact_entry_of(meta, int(row.get('version') or 0)).get('kind') or 'pipe')

    @staticmethod
    def _slot_key(team_id: str) -> str:
        """The publish-map key of a pointer slot: 'user~{uid}' stays, a team id becomes 'team~{id}'."""
        return team_id if team_id.startswith('user~') else f'team~{team_id}'

    @staticmethod
    def _slot_of_key(key: str) -> str:
        """The pointer slot of a publish-map key (the inverse of _slot_key; the public key is itself)."""
        return key[len('team~') :] if key.startswith('team~') else key

    def _pointer_of(self, meta: Dict[str, Any], team_id: str) -> Optional[Dict[str, Any]]:
        """The pointer row of a team or personal slot, or None."""
        return self._publishes_of(meta).get(self._slot_key(team_id))

    def _pins_of(self, meta: Dict[str, Any], version: int) -> List[Dict[str, Any]]:
        """Every live publish row (any audience, any kind) pointing at ``version``.

        A soft-removed row points at nothing; a disabled row still pins
        (re-enabling must find its version). The rows carry their decoded
        audience so ``delete_block_of`` can name the rung.
        """
        pins: List[Dict[str, Any]] = []
        for key, row in self._publishes_of(meta).items():
            if not isinstance(row, dict) or row.get('state') == 'removed':
                continue
            if int(row.get('version') or 0) != int(version):
                continue
            pins.append(self._publish_row(key, row, str(meta.get('orgId') or ''), str(meta.get('projectId') or '')))
        return pins

    async def publish_set(
        self,
        org_id: str,
        kind: str,
        app_id: str,
        audience: Dict[str, str],
        version: int,
        snapshot: Dict[str, Any],
        actor: Dict[str, Any],
        state: str = 'enabled',
    ) -> Dict[str, Any]:
        """Create or repoint one audience's binding (upsert-in-place).

        The binding is a pure pointer — the REVIEW state lives on the
        deployment, not here (the caller has already gated the audience
        against the deployment's state). Repointing updates the target version
        + manifest snapshot and lands the binding in `state`: 'enabled' by
        default (a repoint re-enables), or 'disabled' when the caller carries a
        prior disabled state through the bump in the same write (the reseed).
        """
        _safe_id(org_id, 'org_id')
        _safe_id(app_id, 'app_id')
        if kind not in _KINDS:
            raise ValueError(f'publish_set: unsupported kind {kind!r}')
        if state not in ('enabled', 'disabled'):
            raise ValueError(f'publish_set: unsupported state {state!r}')
        who = _actor_record(actor)
        key = self._audience_key(audience)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Verify the version exists and is of the kind, then upsert the audience row."""
            entry = self._artifact_entry_of(meta, version)
            if not entry:
                raise StorageError(f'{app_id} v{version}: not in the registry')
            if str(entry.get('kind') or 'pipe') != kind:
                raise ValueError(f'{app_id} v{version} is a {entry.get("kind") or "pipe"}, not a {kind}')
            publishes = self._publishes_of(meta)
            existing = publishes.get(key) or {}
            now = time.time()
            # A pipe pointer repointed here keeps what the pointer verbs
            # stamped: its schedules and its billing team.
            row = {
                'kind': kind,
                'version': version,
                'state': state,
                'snapshot': dict(snapshot or {}),
                'billingTeamId': existing.get('billingTeamId', ''),
                'schedules': existing.get('schedules', {}),
                'createdAt': existing.get('createdAt', now),
                'createdBy': existing.get('createdBy', who),
                'updatedAt': now,
                'updatedBy': who,
                'publishedAt': now,
            }
            publishes[key] = row
            # The PUBLISH row (audience bind). The audience is stored in its
            # self-describing form, and a repoint records the version it
            # moved OFF of — "published to @public (was v2)" reads whole
            # from this one row.
            data: Dict[str, Any] = {'audience': audience_display(audience)}
            prev_version = int(existing.get('version') or 0)
            if prev_version and prev_version != version:
                data['previousVersion'] = prev_version
            meta['history'].append(
                {
                    'at': now,
                    'action': 'publish',
                    'teamId': '',
                    'version': version,
                    'actor': who,
                    'data': data,
                }
            )
            ver = self._artifact_entry_of(meta, version)
            return self._publish_row(
                key,
                row,
                org_id,
                app_id,
                self._review_state_of(ver),
                str(ver.get('artifactPath') or ''),
                self._build_status_of(ver),
            )

        return await self._mutate_meta(org_id, app_id, mutate)

    async def publish_get(
        self, org_id: str, kind: str, app_id: str, audience: Dict[str, str]
    ) -> Optional[Dict[str, Any]]:
        """One audience's publish row of one app, or None (removed = None)."""
        _safe_id(org_id, 'org_id')
        _safe_id(app_id, 'app_id')
        if kind not in _KINDS:
            raise ValueError(f'publish_get: unsupported kind {kind!r}')
        meta = await self._read_meta(org_id, app_id)
        if meta is None:
            return None
        key = self._audience_key(audience)
        row = self._publishes_of(meta).get(key)
        if not row or row.get('state') == 'removed' or self._row_kind(meta, row) != kind:
            return None
        ver = self._artifact_entry_of(meta, row.get('version', 0))
        return self._publish_row(
            key,
            row,
            org_id,
            app_id,
            self._review_state_of(ver),
            str(ver.get('artifactPath') or ''),
            self._build_status_of(ver),
        )

    async def publish_of_app(self, org_id: str, kind: str, app_id: str) -> List[Dict[str, Any]]:
        """Every live publish row of one app (the where/reverse index feed)."""
        _safe_id(org_id, 'org_id')
        _safe_id(app_id, 'app_id')
        if kind not in _KINDS:
            raise ValueError(f'publish_of_app: unsupported kind {kind!r}')
        meta = await self._read_meta(org_id, app_id)
        if meta is None:
            return []
        out: List[Dict[str, Any]] = []
        for key, row in self._publishes_of(meta).items():
            if row.get('state') == 'removed' or self._row_kind(meta, row) != kind:
                continue
            ver = self._artifact_entry_of(meta, row.get('version', 0))
            out.append(
                self._publish_row(
                    key,
                    row,
                    org_id,
                    app_id,
                    self._review_state_of(ver),
                    str(ver.get('artifactPath') or ''),
                    self._build_status_of(ver),
                )
            )
        return out

    async def publish_list(self, org_id: str, kind: str, audiences: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """Every live publish row matching ANY of the audiences, across apps.

        The scope-walk / store-browse feed. Scans the org's project metas
        (same pattern as list_team) — the SaaS DB edition answers this with
        one indexed query instead.
        """
        _safe_id(org_id, 'org_id')
        if kind not in _KINDS:
            raise ValueError(f'publish_list: unsupported kind {kind!r}')
        keys = {self._audience_key(a) for a in audiences}
        out: List[Dict[str, Any]] = []
        for project_id in await self._project_ids(org_id):
            meta = await self._read_meta(org_id, project_id)
            if meta is None:
                continue
            for key, row in self._publishes_of(meta).items():
                if key in keys and row.get('state') != 'removed' and self._row_kind(meta, row) == kind:
                    ver = self._artifact_entry_of(meta, row.get('version', 0))
                    out.append(
                        self._publish_row(
                            key,
                            row,
                            org_id,
                            project_id,
                            self._review_state_of(ver),
                            str(ver.get('artifactPath') or ''),
                            self._build_status_of(ver),
                        )
                    )
        return out

    async def publish_set_state(
        self, org_id: str, kind: str, app_id: str, audience: Dict[str, str], state: str, actor: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Flip one binding's lifecycle state (disable/remove/re-enable)."""
        _safe_id(org_id, 'org_id')
        _safe_id(app_id, 'app_id')
        if kind not in _KINDS:
            raise ValueError(f'publish_set_state: unsupported kind {kind!r}')
        if state not in ('enabled', 'disabled', 'removed'):
            raise ValueError(f'Unknown binding state: {state!r}')
        who = _actor_record(actor)
        key = self._audience_key(audience)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Update the binding's state in place."""
            publishes = self._publishes_of(meta)
            row = publishes.get(key)
            if not row or self._row_kind(meta, row) != kind:
                raise StorageError(f'{app_id}: no publish for that audience')
            now = time.time()
            row['state'] = state
            row['updatedAt'] = now
            row['updatedBy'] = who
            meta['history'].append(
                {
                    'at': now,
                    'action': state,
                    'teamId': '',
                    'version': row.get('version'),
                    'actor': who,
                    'data': {'audience': audience_display(audience)},
                }
            )
            ver = self._artifact_entry_of(meta, row.get('version', 0))
            return self._publish_row(
                key,
                row,
                org_id,
                app_id,
                self._review_state_of(ver),
                str(ver.get('artifactPath') or ''),
                self._build_status_of(ver),
            )

        return await self._mutate_meta(org_id, app_id, mutate)

    async def set_artifact_state(
        self,
        org_id: str,
        project_id: str,
        version: int,
        new_state: str,
        actor: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Transition ONE deployment's review state (submit/approve/reject).

        The deployment's ``state`` is the single source of an app's review
        status. The transition is validated, the version entry's state is
        updated in place, and a history event is appended. Returns the
        refreshed rail entry.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        if new_state not in ('private', 'submit', 'ready', 'rejected', 'failed'):
            raise ValueError(f'Unknown artifact state: {new_state!r}')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Validate the transition and update the version's state."""
            entry = next((v for v in meta['versions'] if int(v.get('version', 0)) == version), None)
            if entry is None:
                raise StorageError(f'{project_id} v{version}: not in the registry')
            old_state = str(entry.get('state') or DEFAULT_REVIEW_STATE)
            _assert_review_transition(old_state, new_state)
            entry['state'] = new_state
            meta['history'].append(
                {
                    'at': time.time(),
                    'action': _REVIEW_ACTION.get(new_state, new_state),
                    'teamId': '',
                    'version': version,
                    'actor': who,
                    # Both endpoints of the transition, so the row reads
                    # whole even out of sequence.
                    'data': {'from': old_state, 'to': new_state},
                }
            )
            return dict(entry)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def set_build(
        self,
        org_id: str,
        project_id: str,
        version: int,
        build: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Replace ONE registry version's ``metadata.build`` blob.

        The build worker's job record: the rail row IS the job, and this is
        its single mutation point (``metadata`` is explicitly mutable — the
        processing lifecycle for app zips). The blob is replaced whole, never
        merged, so a new attempt can never inherit stale fields; the review
        ``state`` is deliberately NOT touched here — it belongs to
        ``set_artifact_state``. No history row is appended: build
        transitions are operational churn (queued/building/ok per deploy),
        not audit events — the deploy event stream carries the signal.

        Returns the refreshed rail entry.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        if not isinstance(build, dict):
            raise ValueError('build must be an object')

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            """Swap the build blob on the version's metadata."""
            entry = next((v for v in meta['versions'] if int(v.get('version', 0)) == version), None)
            if entry is None:
                raise StorageError(f'{project_id} v{version}: not in the registry')
            metadata = entry.get('metadata')
            metadata = metadata if isinstance(metadata, dict) else {}
            metadata['build'] = dict(build)
            entry['metadata'] = metadata
            return dict(entry)

        return await self._mutate_meta(org_id, project_id, mutate)

    async def scan_builds(self, statuses: 'tuple[str, ...]') -> List[Dict[str, Any]]:
        """Every kind:'app' version whose ``metadata.build.status`` matches.

        The restart-recovery feed: after a process restart the build worker
        re-enqueues everything left 'queued'/'building'. A full walk of the
        org trees is acceptable here — this runs once at startup, never on a
        request path.

        One org's unreadable tree never costs the others their recovery: the
        failure is logged by org and cause, the walk goes on, and the failed
        orgs get a bounded number of further passes (``_SCAN_RETRY_DELAYS``)
        in this process, because the startup sweep is the build worker's
        only scan. An org still failing after the last pass is logged as
        not recovered; what the other orgs yielded is returned either way.
        The request-path listings (``publish_list``, ``list_team``) keep
        raising: there a failure must not read as "nothing".

        Returns:
            ``[{'orgId', 'projectId', 'version'}]`` for each match.
        """
        # Step 1: the orgs present (none on a fresh store)
        try:
            orgs = await self._store.list_entries('orgs/', recursive=False, include_files=False)
        except StorageNotFoundError:
            return []
        except StorageError as exc:
            error(f'deployments: build recovery could not list the orgs: {exc}')
            return []
        pending = [org_prefix.rstrip('/').rsplit('/', 1)[-1] for org_prefix in orgs]

        # Step 2: every org once, then the failed ones again, a bounded number of times
        out: List[Dict[str, Any]] = []
        for attempt, delay in enumerate((0.0,) + tuple(_SCAN_RETRY_DELAYS)):
            if not pending:
                break
            if delay:
                await asyncio.sleep(delay)
            failed: List[str] = []
            for org_id in pending:
                try:
                    out.extend(await self._scan_org_builds(org_id, statuses))
                except Exception as exc:
                    error(f'deployments: build recovery could not read org {org_id} (pass {attempt + 1}): {exc}')
                    failed.append(org_id)
            pending = failed
        for org_id in pending:
            error(
                f'deployments: build recovery gave up on org {org_id}; its interrupted builds stay queued until restart'
            )
        return out

    async def _scan_org_builds(self, org_id: str, statuses: 'tuple[str, ...]') -> List[Dict[str, Any]]:
        """One org's app versions whose build status matches (raises on a storage failure)."""
        out: List[Dict[str, Any]] = []
        for project_id in await self._project_ids(org_id):
            meta = await self._read_meta(org_id, project_id)
            if meta is None:
                continue
            for entry in meta['versions']:
                if str(entry.get('kind') or 'pipe') != 'app':
                    continue
                metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
                build = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
                if str(build.get('status') or '') in statuses:
                    out.append({'orgId': org_id, 'projectId': project_id, 'version': int(entry.get('version', 0))})
        return out

    async def history_append(
        self,
        org_id: str,
        project_id: str,
        action: str,
        actor: Dict[str, Any],
        version: Optional[int] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append one bare event to the project's history stream.

        The review/comms thread writer ('request', 'approved', 'rejected',
        'reply') — human rows ride the same append-only stream as the
        machine audit, with the payload in ``data``.
        """
        _safe_id(org_id, 'org_id')
        _safe_id(project_id, 'project_id')
        who = _actor_record(actor)

        async def mutate(meta: Dict[str, Any]) -> None:
            """Append the event row."""
            row: Dict[str, Any] = {
                'at': time.time(),
                'action': str(action),
                'teamId': '',
                'version': version,
                'actor': who,
            }
            if data is not None:
                row['data'] = dict(data)
            meta['history'].append(row)

        await self._mutate_meta(org_id, project_id, mutate)

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
        artifact = json.loads(data)
        # APP artifacts get the registry entry's manifest/build blob attached
        # (consumers like resolve_app_pins' publisher fallback read
        # artifact['metadata']). Pipelines stay byte-faithful: the SDK's
        # deploy.artifact() contract returns exactly what was published.
        if artifact.get('kind') == 'app' and isinstance(entry.get('metadata'), dict) and 'metadata' not in artifact:
            artifact['metadata'] = entry['metadata']
        return artifact

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
                for key, dep in self._publishes_of(meta).items():
                    if key == _PUBLIC_KEY or dep.get('state') != 'enabled' or self._row_kind(meta, dep) != 'pipe':
                        continue
                    yield {
                        'orgId': org_id,
                        'teamId': self._slot_of_key(key),
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
        """Project directories present in an org's deployments tree.

        Only a MISSING deployments tree is 'no projects' (a fresh store, an
        org that never deployed); any other storage failure propagates, so a
        listing is never reported empty because the store was down, the same
        rule ``_read_meta`` keeps for one project.
        """
        try:
            dirs = await self._store.list_entries(
                self._deployments_prefix(org_id), recursive=False, include_files=False
            )
        except StorageNotFoundError:
            return []
        return [d.rstrip('/').rsplit('/', 1)[-1] for d in dirs]

    async def _read_meta(self, org_id: str, project_id: str) -> Optional[Dict[str, Any]]:
        """Load and shape-check a project's meta.json; None when absent."""
        # Only a MISSING file is 'no project'; any other storage failure
        # propagates, so a name is never reported unpublished because the
        # store was down (the resolver's row source reads through here)
        try:
            data = await self._store.read_file(self._meta_path(org_id, project_id))
        except StorageNotFoundError:
            return None
        try:
            return self._normalize_meta(json.loads(data), org_id, project_id)
        except Exception as e:
            error(f'deployments: corrupt meta for {org_id}/{project_id}: {e}')
            return None

    def _normalize_meta(self, meta: Dict[str, Any], org_id: str, project_id: str) -> Dict[str, Any]:
        """Shape a meta for this backend, folding a pre-C.17 file's team pointers into the publish map.

        Before C.17 the file kept team pointers in ``deployments`` (keyed by
        slot) beside the app publishes in ``publishes``; now there is ONE
        map (plan 10.1). A legacy ``deployments`` entry becomes the publish
        row under its slot key, carrying what the pointer carried (version,
        state, billing team, schedules); the fold is written back on the
        next mutate. ``kind`` and ``nextVersion`` (the name row) are stamped
        on the first publish after the upgrade.
        """
        meta.setdefault('projectId', project_id)
        meta.setdefault('orgId', org_id)
        meta.setdefault('versions', [])
        meta.setdefault('history', [])
        publishes = self._publishes_of(meta)
        # A pre-C.17 publish row carries no kind: stamp the kind of the version
        # it points at, so every reader and every row returned agree
        for row in publishes.values():
            if isinstance(row, dict) and not row.get('kind'):
                row['kind'] = str(self._artifact_entry_of(meta, int(row.get('version') or 0)).get('kind') or 'pipe')
        legacy = meta.pop('deployments', None)
        if isinstance(legacy, dict):
            for team_id, dep in legacy.items():
                key = self._slot_key(str(team_id))
                if key in publishes or not isinstance(dep, dict):
                    continue
                publishes[key] = {
                    'kind': str(self._artifact_entry_of(meta, int(dep.get('version') or 0)).get('kind') or 'pipe'),
                    'version': dep.get('version'),
                    'state': dep.get('state', 'enabled'),
                    'billingTeamId': dep.get('billingTeamId', ''),
                    'schedules': dep.get('schedules', {}),
                    'snapshot': {},
                    'createdAt': dep.get('createdAt'),
                    'createdBy': dep.get('createdBy'),
                    'updatedAt': dep.get('updatedAt'),
                    'updatedBy': dep.get('updatedBy'),
                    'publishedAt': dep.get('deployedAt', dep.get('updatedAt')),
                }
        return meta

    async def _mutate_meta(self, org_id: str, project_id: str, mutate) -> Any:
        """Read-modify-write of meta.json, one mutate at a time per project.

        ``mutate(meta)`` edits the dict in place and returns the caller's
        result. Mutates of one project are serialized in this process by a
        per-project lock: the CREATE path has no store precondition (the
        store contract has no create-if-absent), so two first publishes of
        one name could otherwise both accept their kind and both take
        version 1 (plan 2.3). The CAS cycle inside still guards the update
        path against writers outside this process.
        """
        locks = self.__dict__.setdefault('_meta_locks', {})
        key = f'{org_id}/{project_id}'
        lock = locks.get(key)
        if lock is None:
            lock = locks[key] = asyncio.Lock()
        async with lock:
            return await self._mutate_meta_unlocked(org_id, project_id, mutate)

    async def _mutate_meta_unlocked(self, org_id: str, project_id: str, mutate) -> Any:
        """The CAS read-modify-write cycle of meta.json with bounded retries.

        On version conflict the whole cycle re-runs against fresh state, so
        concurrent publish/deploy/schedule calls serialize correctly on any
        backend that honors expected_version. Only a MISSING meta is a new
        project; any other storage failure propagates.
        """
        last: Exception | None = None
        for _ in range(_CAS_ATTEMPTS):
            path = self._meta_path(org_id, project_id)
            try:
                data, cas_version = await self._store.read_file_with_metadata(path)
                meta = json.loads(data)
            except StorageNotFoundError:
                meta, cas_version = None, None
            if meta is None:
                meta = {'projectId': project_id, 'orgId': org_id, 'versions': [], 'publishes': {}, 'history': []}
            else:
                meta = self._normalize_meta(meta, org_id, project_id)

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

    def _joined(self, meta: Dict[str, Any], project_id: str, team_id: str, dep: Dict[str, Any]) -> Dict[str, Any]:
        """A client-facing deployment record: a slot's publish row + its registry entry."""
        entry = next((v for v in meta['versions'] if v['version'] == dep['version']), {})
        return {
            'projectId': project_id,
            # teamId carries the OWNER-KEY slot on the wire ('user~{uid}' for
            # a personal publish, the plain team id otherwise).
            'teamId': team_id,
            'version': dep['version'],
            'state': dep['state'],
            # The absolute billing/secrets stamp — runs read this, never
            # resolve ('' on records from before the field existed).
            'billingTeamId': dep.get('billingTeamId', ''),
            'schedules': dep.get('schedules', {}),
            'createdAt': dep.get('createdAt'),
            'createdBy': dep.get('createdBy'),
            'updatedAt': dep.get('updatedAt'),
            'updatedBy': dep.get('updatedBy'),
            # Stamped by deploy() on every pointer move (the wire keeps the
            # shipped 'deployedAt' spelling); records from before the field
            # existed fall back to updatedAt.
            'deployedAt': dep.get('publishedAt', dep.get('updatedAt')),
            'pipelineName': entry.get('pipelineName', ''),
            'sha256': entry.get('sha256', ''),
            'publishedAt': entry.get('publishedAt'),
            'publishedBy': entry.get('publishedBy'),
        }


__all__ = ['FileDeploymentBackend', 'artifact_path', 'artifact_sha256', 'delete_block_of']
