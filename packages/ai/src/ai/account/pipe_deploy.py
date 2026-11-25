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
Published rungs: the publications of one address that serve one caller.

``resolve_pins(kind, ...)`` is THE published-rung resolver (plan 3.2, 10.1).
Given the request's account and an address ``developerId.pipelineId[.source]``
it finds the publish rows the caller may resolve, in the fixed precedence
after ``@spec`` (which is a live-control lookup, not a publication):

- ``@me``: the caller's personal deployment, the ``=user/<uid>`` audience;
- ``@team``: the publication of the FIRST team in the caller's TEAM ORDER
  (``models.team_order``) that holds the name. Teams holding nothing are
  skipped; a rooted address (``@<team>/...``, ``=team/<tid>/...``) probes
  that one team instead; a key with an ``endpoints`` scope probes its frozen
  team only. The order is total, so there is no tie rule and no ambiguity
  error;
- ``@public``: the store rung, the publisher's ``@public`` publication.

Every row comes through ONE row source, ``publish_rows``: one read of the
one publish table (``published_artifacts``, C.17) for the project, filtered
to the slots asked for. A pipe's team and personal pointers and its public
row are rows of that table alike; each row's kind is the registry entry's.

Each pin carries the ``DeploymentRef`` the control will be stamped with (the
publisher's disable/remove releases it), the artifact version to start, the
billing stamp and the states the caller may see. The PIPE serving gate is
the app gate without the build requirement (pipes never build): the
binding is enabled, the deployment did not fail, and a public binding
serves only a ``ready`` deployment, unconditionally (plan 10.1). A key with
an ``endpoints`` scope is refused outside it (plan 2.4).

A pure read: nothing is started, written or cached here; the task server
attaches to a live control or starts one from the pinned artifact.

The same resolver serves the Catalog and the desktop (plan 9.1, Step 6b.4):
every listed pipe the caller reaches is a catalog entry and, once added, an
agent tile that opens the one host app (``CONST_PIPE_HOST_APP_ID``) bound to
the pipe's address.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple

from rocketlib import debug

from ai.account.audience import (
    PUBLIC_AUDIENCE,
    audience_fields,
    audience_of_fields,
    org_audience,
    team_audience,
    user_audience,
)
from ai.account.deployment_backend import DEFAULT_REVIEW_STATE
from ai.account.models import team_order
from ai.constants import CONST_PIPE_HOST_APP_ID

if TYPE_CHECKING:
    from ai.account.models import AccountInfo
    from ai.modules.task.address import Address
    from ai.modules.task.task_control import DeploymentRef, Listing


# ==== Shapes ===================================================================

#: The published rungs, in resolution order, as ``resolve_pins`` walks them.
PUBLISHED_RUNGS = ('me', 'team', 'org', 'public')


@dataclass(frozen=True)
class PublishRow:
    """
    One publish row, whichever table it came from (the row source's shape).

    Attributes:
        kind: The kind of the artifact the row points at (``pipe``, ``app``).
        org_id: The publisher's org.
        project_id: The registry name ``developerId.pipeId`` the row is keyed by.
        slot: The row's audience (plan 2.5): ``=user/<uid>``, ``=team/<tid>``,
            ``=org/<oid>`` or ``@public``.
        version: The registry version the row points at.
        state: The binding lifecycle state (``enabled``/``disabled``/...).
        artifact_state: The pointed-at deployment's review state.
        billing_team_id: The row's billing stamp ('' when it carries none).
    """

    kind: str
    org_id: str
    project_id: str
    slot: str
    version: int
    state: str
    artifact_state: str
    billing_team_id: str = ''


@dataclass(frozen=True)
class Pin:
    """
    One rung's serving publication of an address, as the caller may see it.

    Attributes:
        rung: ``'me'``, ``'team'``, ``'org'`` or ``'public'``.
        deployment: Where the publication lives: the publisher's org, the
            audience (``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` or
            ``@public``) and the registry name ``developerId.pipeId``.
            Stamped on the control; disable/remove of this
            publication releases the control's hold. On ``@team`` its
            audience names the ANSWERING team (``DeploymentRef.team``).
        version: The registry version the publication points at.
        billing_team_id: The row's billing stamp ('' on a public publication).
        state: The binding state the caller may see (``'enabled'`` for a pin).
        artifact_state: The deployment's review state (``ready`` for public).
    """

    rung: str
    deployment: 'DeploymentRef'
    version: int
    billing_team_id: str = ''
    state: str = 'enabled'
    artifact_state: str = ''


@dataclass(frozen=True)
class Pins:
    """
    The published rungs of one address for one caller.

    Attributes:
        address: The parsed address.
        pins: The serving pins, in precedence order (``@me``, then at most
            one ``@team`` pin, then ``@org``, then ``@public``); the first one
            answers.
    """

    address: 'Address'
    pins: Tuple[Pin, ...] = ()

    @property
    def first(self) -> Optional[Pin]:
        """The pin that answers, or ``None`` when no published rung serves."""
        return self.pins[0] if self.pins else None


# ==== The serving gate =========================================================


def pipe_serving_block_of(state: str, artifact_state: str, public: bool) -> str:
    """
    Why one pipe publication does not serve, or '' when it does.

    The app gate (``app_deploy._serving_block_of``) without the build step:
    a pipe never builds. Public-needs-``ready`` holds unconditionally for
    pipes, not only on a review-ladder server (plan 10.1).

    Args:
        state: The binding lifecycle state.
        artifact_state: The deployment's review state.
        public: True for the ``@public`` rung.

    Returns:
        ``'disabled'``, ``'failed'``, ``'in-review'``, ``'rejected'``,
        ``'not-approved'``, or ``''`` when it serves.
    """
    if state != 'enabled':
        return 'disabled'
    if artifact_state == 'failed':
        return 'failed'
    if public and artifact_state != 'ready':
        return {'submit': 'in-review', 'rejected': 'rejected'}.get(artifact_state, 'not-approved')
    return ''


# ==== Caller facts =============================================================


def _org_of(account_info: 'AccountInfo') -> Tuple[str, str]:
    """The caller's ``(org id, developer id)`` ('' when absent)."""
    org = getattr(account_info, 'organization', None) or {}
    return str(org.get('id') or ''), str(org.get('developerId') or '')


def teams_to_probe(account_info: 'AccountInfo', team: Optional[str] = None) -> List[str]:
    """
    The teams ``@team`` probes for this call, in order (plan 3.2).

    Without ``team`` that is the caller's team order (a scoped key's frozen
    team only). ``team`` is the one team a rooted address names
    (``@<team>/...``, ``=team/<tid>/...``): it must be one of the caller's
    own teams, and a scoped key's frozen team refuses any other.

    Args:
        account_info: The request's account.
        team: The team id a rooted address names, or None for the ladder.

    Returns:
        Team ids in probe order.

    Raises:
        PermissionError: ``team`` is not one of the caller's teams, or not
            a scoped key's frozen team.
    """
    order = team_order(account_info)
    if team is None:
        return order
    if getattr(account_info, 'endpoints', None) is not None:
        if team not in order:
            raise PermissionError(f'This API key is frozen to its own team; =team/{team} names another')
        return [team]
    org = getattr(account_info, 'organization', None) or {}
    allowed = [str(t.get('id')) for t in org.get('teams') or [] if t.get('id')]
    if team not in allowed:
        raise PermissionError(f'You are not a member of team {team!r}')
    return [team]


def _check_scope(endpoints: Optional[List[str]], address: 'Address') -> None:
    """
    Refuse an address outside the key's ``endpoints`` scope.

    A three-segment address goes through ``check_endpoint_scope``. A
    two-segment one has no source yet: the scope must admit SOME source of
    the pipe here, and the source the server picks is checked again once it
    is known.

    Raises:
        PermissionError: The scope excludes the address.
    """
    from ai.modules.task.address import build_address, check_endpoint_scope

    # ONE matcher: the address module's, which takes the two-segment form too
    check_endpoint_scope(endpoints, build_address(*address))


# ==== The row source ===========================================================


def _slot_of(row: Dict[str, Any]) -> str:
    """The audience a publish row serves, from its ``{type, id}`` pair."""
    return audience_of_fields(row.get('audience') or {})


async def publish_rows(account: Any, org_id: str, project_id: str, slots: Sequence[str]) -> List[PublishRow]:
    """
    THE row source: every live publish row of ``project_id`` for ``slots``.

    ONE read of the one publish table (``publish_of_app`` for kind 'pipe'),
    then the slots asked for, in order. A row's kind and review state are
    the registry entry's (``artifactState`` rides the row). A failing store
    raises: a name is never reported 'not found' because the database was
    down (audit 2026-11-12).

    Args:
        account: The account singleton.
        org_id: The publisher's org.
        project_id: The registry name ``developerId.pipeId`` (the deploy door stores it).
        slots: The audience slots to read, in order.

    Returns:
        The rows found, in ``slots`` order.
    """
    # Step 1: every live publish row of the project, read once
    by_slot: Dict[str, Dict[str, Any]] = {}
    for pub in await account.publish_of_app(org_id, 'pipe', project_id):
        by_slot[_slot_of(pub)] = pub

    # Step 2: the slots asked for, in the caller's order
    rows: List[PublishRow] = []
    for slot in slots:
        pub = by_slot.get(slot)
        if not pub or not isinstance(pub.get('version'), int):
            continue
        rows.append(
            PublishRow(
                kind=str(pub.get('kind') or 'pipe'),
                org_id=org_id,
                project_id=project_id,
                slot=slot,
                version=int(pub['version']),
                state=str(pub.get('state') or ''),
                artifact_state=str(pub.get('artifactState') or DEFAULT_REVIEW_STATE),
                billing_team_id=str(pub.get('billingTeamId') or ''),
            )
        )
    return rows


# ==== The resolver =============================================================


def _serving_pin(rows: Sequence[PublishRow], kind: str, rung: str, slot: str) -> Optional[Pin]:
    """The first serving row of ``kind`` in ``slot`` as a pin, or None."""
    from ai.modules.task.task_control import DeploymentRef

    for row in rows:
        if row.slot != slot or row.kind != kind:
            continue
        if pipe_serving_block_of(row.state, row.artifact_state, public=rung == 'public'):
            continue
        return Pin(
            rung=rung,
            deployment=DeploymentRef(org_id=row.org_id, team_id=row.slot, project_id=row.project_id),
            version=row.version,
            billing_team_id=row.billing_team_id,
            state=row.state,
            artifact_state=row.artifact_state,
        )
    return None


async def resolve_pins(
    kind: str,
    account_info: 'AccountInfo',
    address: str,
    *,
    rungs: Sequence[str] = PUBLISHED_RUNGS,
    teams: Optional[Sequence[str]] = None,
) -> Pins:
    """
    The published rungs of ``address`` that serve the caller, in precedence order.

    ``@me``, ``@team`` and ``@org`` are publications in the caller's own
    org, so they are read only when the address is in the caller's
    namespace; ``@public`` is the publisher's ``@public`` row, found through
    the org that owns the address namespace (the one rung that crosses
    orgs). ``@team`` yields at most ONE pin: the first team in the probe
    order holding a serving row. ``@org`` is the active org's own
    publication, served to every active member with no review step. A
    rooted address reads only its root's rung (``rungs``) and, on ``@team``,
    only its one team (``teams``). A pure read.

    Args:
        kind: The artifact kind to resolve (``'pipe'``).
        account_info: The request's account (required).
        address: ``developerId.pipelineId[.source]``.
        rungs: The published rungs to read (``me``, ``team``, ``org``,
            ``public``), every one by default.
        teams: The team ids ``@team`` probes, in order, already checked
            against the caller (``teams_to_probe``); None for the caller's
            team order.

    Returns:
        The pins; ``pins`` is empty when no published rung serves the caller.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT (address grammar).
        PermissionError: Unauthenticated, or the key's ``endpoints`` scope
            excludes the address.
    """
    from ai.account import account
    from ai.modules.task.address import build_address, parse_address

    # Step 1: who asks, for what, and whether the key may ask for it
    if account_info is None:
        raise PermissionError('Not authenticated')
    parsed = parse_address(address)
    _check_scope(getattr(account_info, 'endpoints', None), parsed)
    probe = list(teams) if teams is not None else teams_to_probe(account_info)
    if 'team' not in rungs:
        probe = []
    org_id, developer_id = _org_of(account_info)
    user_id = getattr(account_info, 'userId', '') or ''
    # The registry name every publish row is keyed by: the pipe id inside
    # the publisher's developer namespace, exactly as the deploy door stored
    # it (plan 2.3). The rows are scoped by it, never by the bare pipe id.
    pipe_name = build_address(parsed.developer_id, parsed.pipe_id)
    own_namespace = bool(developer_id) and parsed.developer_id == developer_id and bool(org_id)
    pins: List[Pin] = []

    # Step 2: @me, then @team in the probe order, then @org: the caller's own org
    org_slot = org_audience(org_id) if org_id and 'org' in rungs else ''
    if own_namespace and ('me' in rungs or probe or org_slot):
        me_slot = user_audience(user_id) if user_id and 'me' in rungs else ''
        slots = ([me_slot] if me_slot else []) + [team_audience(team_id) for team_id in probe]
        slots += [org_slot] if org_slot else []
        rows = await publish_rows(account, org_id, pipe_name, slots)
        if me_slot:
            pin = _serving_pin(rows, kind, 'me', me_slot)
            if pin is not None:
                pins.append(pin)
        for team_id in probe:
            pin = _serving_pin(rows, kind, 'team', team_audience(team_id))
            if pin is not None:
                pins.append(pin)
                break
        if org_slot:
            pin = _serving_pin(rows, kind, 'org', org_slot)
            if pin is not None:
                pins.append(pin)

    # Step 3: @public, the publisher's store publication
    if 'public' not in rungs:
        return Pins(address=parsed, pins=tuple(pins))
    publisher_org = org_id if own_namespace else await account.get_org_of_developer_id(parsed.developer_id)
    if publisher_org:
        rows = await publish_rows(account, publisher_org, pipe_name, [PUBLIC_AUDIENCE])
        pin = _serving_pin(rows, kind, 'public', PUBLIC_AUDIENCE)
        if pin is not None:
            pins.append(pin)

    return Pins(address=parsed, pins=tuple(pins))


async def resolve_pipe_version(account_info: Optional['AccountInfo'], pipe_name: str) -> Optional[Pin]:
    """
    The publication a store-file fetch of ``pipe_name`` serves the caller, or None.

    The serving route's resolver (``/pipelines/<id>`` and the unversioned
    redirect): an authenticated caller gets the first pin of
    :func:`resolve_pins`; an anonymous caller the publisher's ``@public``
    row alone. Never raises for a malformed or unknown name: the route
    answers 404, not an error, so it is no existence oracle.

    Args:
        account_info: The caller, or None for anonymous.
        pipe_name: The registry name ``developerId.pipeId``.

    Returns:
        The serving pin, or None when nothing serves the caller.

    Raises:
        Exception: A failing store, propagated: a name is never reported
            'not found' because the database was down (``publish_rows``).
    """
    from ai.account import account
    from ai.modules.task.address import build_address, parse_address
    from ai.modules.task.types import TaskError

    try:
        parsed = parse_address(pipe_name)
    except Exception:
        return None
    if parsed.source is not None:
        return None
    if account_info is not None:
        # Only the caller's own faults are a miss (the grammar, the key's
        # scope, a team that is not theirs); a storage failure reaches the
        # route's error handler as the error it is
        try:
            return (await resolve_pins('pipe', account_info, pipe_name)).first
        except (TaskError, PermissionError):
            return None
    publisher_org = await account.get_org_of_developer_id(parsed.developer_id)
    if not publisher_org:
        return None
    pipe_name = build_address(parsed.developer_id, parsed.pipe_id)
    rows = await publish_rows(account, publisher_org, pipe_name, [PUBLIC_AUDIENCE])
    return _serving_pin(rows, 'pipe', 'public', PUBLIC_AUDIENCE)


# ==== The listing of a version =================================================


async def listing_of(account: Any, org_id: str, pipe_name: str, version: int) -> 'Listing':
    """
    The store listing of one published version: its mode and the plan a caller subscribes to.

    The mode is the version's ``metadata.manifest.mode``, written by the pipe
    door from the ``.pipe`` ``store`` block (plan 9). A version with no
    manifest shaped from a store block, or one the registry does not hold, is
    ``free``. A failing store raises: a paid pipe is never served as free
    because the registry was down.

    Args:
        account: The account singleton.
        org_id: The publisher's org.
        pipe_name: The registry name ``developerId.pipeId``.
        version: The registry version the publication points at.

    Returns:
        The listing.
    """
    from ai.account.pipe_bundle import is_listed
    from ai.modules.task.task_control import Listing

    for entry in await account.deployments_versions(org_id, pipe_name):
        if not isinstance(entry, dict) or entry.get('version') != version:
            continue
        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        manifest = metadata.get('manifest')
        if not is_listed(manifest):
            break
        billing = manifest.get('billing') if isinstance(manifest.get('billing'), dict) else {}
        plans = [plan for plan in billing.get('plans') or [] if isinstance(plan, dict)]
        plan = str(plans[0].get('nickname') or '') if plans else ''
        return Listing(mode=str(manifest.get('mode') or 'free'), plan=plan)
    return Listing()


# ==== The catalog row ==========================================================


def pipe_catalog_row(pipe_name: str, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    One pipe version as the store catalog lists it, or None when the version is unlisted.

    A pipe is listed when its ``metadata.manifest`` was shaped from a store
    block (``pipe_bundle.is_listed``). The deploy door gives every pipe a
    block; a version deployed without one before the door did is an artifact
    the registry holds and the catalog never shows. The row carries
    the same field names an app's catalog row exposes (``resolve_app_pins``):
    pricing surfaces as ``mode`` alone, as it does for an app (the plans
    stay on ``metadata.manifest.billing`` for the approve path); ``icon``
    and ``readme`` are the version's immutable URLs built by the one builder
    every kind uses (``app_deploy.artifact_file_url``), absent when
    undeclared.

    Args:
        pipe_name: The registry name ``developerId.pipeId``.
        entry: The registry entry (``version``, ``metadata``).

    Returns:
        The row, or None for an unlisted version.
    """
    from ai.account.app_deploy import artifact_file_url, namespace_of
    from ai.account.pipe_bundle import is_listed

    metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
    manifest = metadata.get('manifest')
    version = entry.get('version')
    if not is_listed(manifest) or not isinstance(version, int):
        return None
    row: Dict[str, Any] = {
        'id': pipe_name,
        'name': str(manifest.get('name') or pipe_name),
        'publisher': namespace_of(pipe_name),
        'description': str(manifest.get('description') or ''),
        'defaultSource': str(manifest.get('defaultSource') or ''),
        'tagline': str(manifest.get('tagline') or ''),
        'categories': list(manifest.get('categories') or []),
        'tags': list(manifest.get('tags') or []),
        'links': dict(manifest.get('links') or {}),
        'mode': str(manifest.get('mode') or 'free'),
        'version': version,
    }
    # The author's own version (the store block's semver), when the block declares one
    if manifest.get('version'):
        row['appVersion'] = str(manifest['version'])
    # Omitted (not None) when undeclared, as an app row omits them
    for key in ('icon', 'readme'):
        url = artifact_file_url('pipe', pipe_name, version, manifest.get(key))
        if url:
            row[key] = url
    return row


# ==== The picker's walk (plan 3.6, C.16c) ======================================

#: The snapshot fields a store search matches, beside the registry name.
_SEARCHED_SNAPSHOT_KEYS = ('name', 'description', 'tagline')


def _name_of(row: Dict[str, Any]) -> str:
    """A publish row's registry name ``developerId.pipeId`` (both spellings ride the row)."""
    return str(row.get('projectId') or row.get('appId') or '')


def _picker_entry(row: Dict[str, Any], rung: str, team_name: str = '') -> Dict[str, Any]:
    """
    One publish row as the pipe picker lists it.

    The catalog's entry shape (``id``, ``name``, ``publisher``,
    ``description``) with ``kind: 'pipe'``, the address in ``pipe`` and the
    rung that answers the caller for it; ``teamId``/``teamName`` on a
    ``@team`` entry. The display facts come from the row's snapshot; a row
    without a name shows its registry name.

    Args:
        row: The publish row (``publish_list`` shape).
        rung: ``'me'``, ``'team'``, ``'org'`` or ``'public'``.
        team_name: The answering team's display name (``@team`` only).

    Returns:
        The entry.
    """
    from ai.account.app_deploy import namespace_of

    pipe_name = _name_of(row)
    snapshot = row.get('snapshot') if isinstance(row.get('snapshot'), dict) else {}
    entry: Dict[str, Any] = {
        'kind': 'pipe',
        'id': pipe_name,
        'pipe': pipe_name,
        'name': str(snapshot.get('name') or pipe_name),
        'publisher': namespace_of(pipe_name),
        'description': str(snapshot.get('description') or snapshot.get('tagline') or ''),
        'rung': rung,
        'version': row.get('version'),
    }
    if rung == 'team':
        team_id = str((row.get('audience') or {}).get('id') or '')
        entry['teamId'] = team_id
        entry['teamName'] = team_name or team_id
    return entry


def _in_scope(endpoints: Optional[List[str]], pipe_name: str) -> bool:
    """Whether a key's ``endpoints`` scope admits SOME source of ``pipe_name`` (unscoped: always)."""
    from ai.modules.task.address import check_endpoint_scope
    from ai.modules.task.types import TaskError

    try:
        check_endpoint_scope(endpoints, pipe_name)
    except (PermissionError, TaskError):
        # Out of scope, or a registry name the address grammar refuses:
        # neither is the caller's to list
        return False
    return True


def _serves(row: Dict[str, Any], public: bool) -> bool:
    """Whether one publish row serves: an int version past the pipe serving gate."""
    state = str(row.get('state') or '')
    artifact_state = str(row.get('artifactState') or DEFAULT_REVIEW_STATE)
    return isinstance(row.get('version'), int) and not pipe_serving_block_of(state, artifact_state, public)


async def own_pipe_publications(account: Any, account_info: 'AccountInfo') -> List[Dict[str, Any]]:
    """
    The pipe publications the caller reaches in their OWN org, as the picker lists them.

    The ``@me`` rows first, then the ``@team`` rows in the caller's team
    order (``teams_to_probe``: a scoped key probes its frozen team only),
    then the org's own ``@org`` rows.
    Each pipe appears ONCE, at the rung that answers the caller for it (the
    ladder's order, plan 3.2), so the list never shows a publication the
    resolver would pass over. Only serving rows are listed; rows of another
    org never are (user and team keys are global ids on the DB edition); a
    key's ``endpoints`` scope drops the pipes it may not call. ``@public`` is
    NOT walked here: the store is a search (:func:`search_public_pipes`),
    never a listing (plan 3.6). One read of the publish table.

    Args:
        account: The account singleton.
        account_info: The request's account.

    Returns:
        Picker entries: ``@me`` first, then team by team in team order, then
        ``@org``, each group by display name.

    Raises:
        PermissionError: Unauthenticated.
        Exception: A failing store, propagated (never read as "no pipes").
    """
    if account_info is None:
        raise PermissionError('Not authenticated')
    org_id, _ = _org_of(account_info)
    if not org_id:
        return []
    user_id = str(getattr(account_info, 'userId', '') or '')
    probe = teams_to_probe(account_info)
    endpoints = getattr(account_info, 'endpoints', None)
    org = getattr(account_info, 'organization', None) or {}
    team_names = {str(t.get('id')): str(t.get('name') or '') for t in org.get('teams') or [] if t.get('id')}

    # Step 1: the caller's own slots, in the ladder's order, read once
    slots: List[Tuple[str, str, str]] = ([('me', user_audience(user_id), '')] if user_id else []) + [
        ('team', team_audience(t), t) for t in probe
    ]
    slots.append(('org', org_audience(org_id), ''))
    if not slots:
        return []
    rows = await account.publish_list(org_id, 'pipe', [audience_fields(slot) for _, slot, _ in slots])

    # Step 2: the serving rows of this org, by slot
    by_slot: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        if str(row.get('orgId') or org_id) != org_id or not _serves(row, public=False):
            continue
        by_slot.setdefault(_slot_of(row), []).append(row)

    # Step 3: each pipe at the first rung that holds it
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for rung, slot, team_id in slots:
        group: List[Dict[str, Any]] = []
        for row in by_slot.get(slot, []):
            pipe_name = _name_of(row)
            if not pipe_name or pipe_name in seen or not _in_scope(endpoints, pipe_name):
                continue
            seen.add(pipe_name)
            group.append(_picker_entry(row, rung, team_names.get(team_id, '')))
        out.extend(sorted(group, key=lambda e: (e['name'].lower(), e['id'])))
    return out


async def search_public_pipes(account: Any, account_info: 'AccountInfo', search: str) -> List[Dict[str, Any]]:
    """
    The store's pipes whose registry name, name, description or tagline contains ``search``.

    A SEARCH, never a listing (plan 3.6): a blank term is refused, so no
    request answers the whole public rung. Only serving public rows match
    (enabled, deployment ``ready``); a key's ``endpoints`` scope drops the
    pipes it may not call; the match is a case-insensitive substring. The
    publish table answers every org's public rows on the DB edition (the
    store is global) and the local org's on the file edition.

    Args:
        account: The account singleton.
        account_info: The request's account.
        search: The search term.

    Returns:
        Picker entries on the ``public`` rung, by display name.

    Raises:
        PermissionError: Unauthenticated.
        ValueError: A blank search term.
        Exception: A failing store, propagated.
    """
    if account_info is None:
        raise PermissionError('Not authenticated')
    needle = (search or '').strip().lower()
    if not needle:
        raise ValueError('The store is searched, never listed: give a search term')
    org_id, _ = _org_of(account_info)
    endpoints = getattr(account_info, 'endpoints', None)

    # Step 1: the store's public pipe rows
    rows = await account.publish_list(org_id, 'pipe', [audience_fields(PUBLIC_AUDIENCE)])

    # Step 2: the serving rows that match, once per pipe
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for row in rows:
        pipe_name = _name_of(row)
        if not pipe_name or pipe_name in seen or not _serves(row, public=True):
            continue
        snapshot = row.get('snapshot') if isinstance(row.get('snapshot'), dict) else {}
        haystack = [pipe_name] + [str(snapshot.get(key) or '') for key in _SEARCHED_SNAPSHOT_KEYS]
        if not any(needle in text.lower() for text in haystack) or not _in_scope(endpoints, pipe_name):
            continue
        seen.add(pipe_name)
        out.append(_picker_entry(row, 'public'))
    return sorted(out, key=lambda e: (e['name'].lower(), e['id']))


# ==== The Catalog and the desktop (plan 9.1, Step 6b.4) ========================


def desktop_kind(kinds: Dict[str, str], name: str) -> str:
    """
    What one desktop entry is: ``'pipe'`` when its name row says so, else ``'app'``.

    A desktop holds fully qualified names (``rocketride.playground``,
    ``acme.supportBot``); B37 keeps an app and a pipe from sharing one. The
    kind is the name row's, looked up and never stored beside the entry
    (G2, 2026-11-21): a name with no row is an app.

    Args:
        kinds: ``AccountBase.deployments_kinds`` for the desktop's names.
        name: One desktop entry.

    Returns:
        ``'pipe'`` or ``'app'``.
    """
    return 'pipe' if kinds.get(name) == 'pipe' else 'app'


def pipe_catalog_entry(pipe_name: str, entry: Optional[Dict[str, Any]], rung: str) -> Optional[Dict[str, Any]]:
    """
    One listed pipe version as the Catalog and the desktop show it, or None when it is unlisted.

    The catalog row (:func:`pipe_catalog_row`) in an app entry's shape, plus
    what launches it: ``kind: 'pipe'``, the address in ``pipe``, and the one
    host app in ``hostAppId`` (``CONST_PIPE_HOST_APP_ID``), whose module the
    entry names as its ``moduleId``. ``version`` is the author's own version
    (the store block's semver), absent when the block declares none, exactly
    as an app entry's is its package version. The row's registry version
    number is dropped: an app entry's ``version`` is a semver, and a
    ``registryVersion`` would make a client register the entry as a Module
    Federation remote of its own; an agent tile is a launcher of its host,
    never a remote. ``appStatus`` and ``onDesktop`` are the undecorated
    defaults each edition overlays.

    Args:
        pipe_name: The registry name ``developerId.pipeId``.
        entry: The registry entry of the version that answers the caller
            (None reads as unlisted).
        rung: The rung that answers: ``'me'``, ``'team'`` or ``'public'``.

    Returns:
        The entry, or None for an unlisted (or missing) version.
    """
    row = pipe_catalog_row(pipe_name, entry) if isinstance(entry, dict) else None
    if row is None:
        return None
    row.pop('version', None)
    # What a tile shows as the version is the author's semver, as an app's is
    app_version = row.pop('appVersion', '')
    if app_version:
        row['version'] = app_version
    row.update(
        {
            'kind': 'pipe',
            'pipe': pipe_name,
            'hostAppId': CONST_PIPE_HOST_APP_ID,
            'moduleId': CONST_PIPE_HOST_APP_ID.replace('.', '_'),
            # The rung spelling app entries carry (resolve_app_pins)
            'rung': 'personal' if rung == 'me' else rung,
            'public': rung == 'public',
            'appStatus': 'free',
            'onDesktop': False,
        }
    )
    return row


async def _version_entry(account: Any, org_id: str, pipe_name: str, version: int) -> Optional[Dict[str, Any]]:
    """The registry entry of one version, or None when the registry holds no such version (a failure raises)."""
    for entry in await account.deployments_versions(org_id, pipe_name):
        if isinstance(entry, dict) and entry.get('version') == version:
            return entry
    return None


async def reachable_pipe_entry(account: Any, account_info: 'AccountInfo', address: str) -> Optional[Dict[str, Any]]:
    """
    The Catalog entry of ``address`` as it serves this caller now, or None when nothing serves it to them.

    The desktop's gate and its tiles (plan 9.1): ``address`` must be a
    registry name ``developerId.pipeId`` (a source address names no tile);
    the ONE resolver (:func:`resolve_pins`) picks the rung and the version
    that answer the caller, and that version must be listed. The caller's
    own faults (the grammar, the key's scope, no session) are a None; a
    storage failure raises, so a pipe is never refused as unknown because
    the database was down.

    Args:
        account: The account singleton.
        account_info: The caller.
        address: The registry name.

    Returns:
        The entry (:func:`pipe_catalog_entry`), or None.
    """
    from ai.modules.task.address import validate_pipe_name
    from ai.modules.task.types import TaskError

    # Step 1: a registry name, resolved by the one resolver
    try:
        validate_pipe_name(address, 'appId')
        pin = (await resolve_pins('pipe', account_info, address)).first
    except (TaskError, PermissionError):
        return None
    if pin is None:
        return None

    # Step 2: the listing of the version that answers
    entry = await _version_entry(account, pin.deployment.org_id, address, pin.version)
    return pipe_catalog_entry(address, entry, pin.rung)


async def catalog_pipe_entries(account: Any, account_info: 'AccountInfo') -> List[Dict[str, Any]]:
    """
    Every listed pipe the caller can reach, as the Catalog lists it (plan 9.1, G2).

    The caller's OWN publications first, ``@me`` then ``@team`` in team order
    (:func:`own_pipe_publications`), then the store's ``@public`` rows of
    every org, each pipe ONCE at the rung that answers the caller for it (the
    resolver's order, plan 3.2), so a tile never opens a version the
    resolver would pass over. Only serving rows count; a key's ``endpoints``
    scope drops the pipes it may not call; a version stored without a store
    block is unlisted and never shown. There is no entry-point filter: every
    listed pipe opens in the one host app. A version whose registry entry
    cannot be read is left off (logged), as an app whose artifact cannot be
    read is.

    Args:
        account: The account singleton.
        account_info: The request's account.

    Returns:
        Catalog entries (:func:`pipe_catalog_entry`), own rungs first.

    Raises:
        PermissionError: Unauthenticated.
        Exception: A failing publish table, propagated (never read as "no pipes").
    """
    # Step 1: the caller's own rungs, then the store's rows
    own = await own_pipe_publications(account, account_info)
    org_id, _ = _org_of(account_info)
    endpoints = getattr(account_info, 'endpoints', None)
    public = await account.publish_list(org_id, 'pipe', [audience_fields(PUBLIC_AUDIENCE)])

    # Step 2: each pipe once, at the rung that answers it. A stray duplicate
    # public row goes to the lowest publisher org, the app walk's tie rule
    picks: List[Tuple[str, str, int, str]] = [(e['pipe'], org_id, int(e['version']), e['rung']) for e in own]
    seen = {pick[0] for pick in picks}
    for row in sorted(public, key=lambda r: str(r.get('orgId') or '')):
        pipe_name = _name_of(row)
        if not pipe_name or pipe_name in seen or not _serves(row, public=True):
            continue
        if not _in_scope(endpoints, pipe_name):
            continue
        seen.add(pipe_name)
        picks.append((pipe_name, str(row.get('orgId') or org_id), int(row['version']), 'public'))

    # Step 3: the listed versions, as entries
    out: List[Dict[str, Any]] = []
    for pipe_name, publisher_org, version, rung in picks:
        try:
            entry = await _version_entry(account, publisher_org, pipe_name, version)
        except Exception as exc:
            debug(f'[pipe_deploy] catalog: {pipe_name} v{version} could not be read: {exc}')
            continue
        listed = pipe_catalog_entry(pipe_name, entry, rung)
        if listed is not None:
            out.append(listed)
    return out


async def desktop_pipe_tiles(
    account: Any, account_info: 'AccountInfo', desktop_ids: Sequence[str]
) -> List[Dict[str, Any]]:
    """
    The agent tiles of a desktop: its pipe entries, each as the caller reaches it now.

    The desktop holds names; which of them are pipes is the name rows'
    answer (``deployments_kinds`` read through :func:`desktop_kind`), never a
    stored kind. Each pipe resolves through :func:`reachable_pipe_entry`,
    so a pipe the caller no longer reaches (unpublished, its version
    unlisted, outside the key's scope) has no tile, as an unreachable app
    has none; the entry stays on the stored desktop and returns with the
    publication. Every tile is ``onDesktop``; ``appStatus`` is the free
    default an edition overlays. One pipe that cannot be read is left off
    (logged): a desktop never fails for one pipe.

    Args:
        account: The account singleton.
        account_info: The caller.
        desktop_ids: The desktop's names, in stored order.

    Returns:
        The tiles, in desktop order.

    Raises:
        Exception: The name-row lookup failed (the sign-in callers catch it).
    """
    # Step 1: the desktop's names and their kinds, one lookup
    names = [name for name in dict.fromkeys(desktop_ids) if name]
    org_id, _ = _org_of(account_info)
    if not names or not org_id:
        return []
    kinds = await account.deployments_kinds(org_id, names)

    # Step 2: each pipe as the caller reaches it now
    tiles: List[Dict[str, Any]] = []
    for name in names:
        if desktop_kind(kinds, name) != 'pipe':
            continue
        try:
            tile = await reachable_pipe_entry(account, account_info, name)
        except Exception as exc:
            debug(f'[pipe_deploy] desktop: {name} could not be resolved: {exc}')
            continue
        if tile is not None:
            tile['onDesktop'] = True
            tiles.append(tile)
    return tiles
