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

- ``@me``: the caller's personal deployment, the ``user~{uid}`` audience;
- ``@team``: the publication of the FIRST team in the caller's TEAM ORDER
  (``models.team_order``) that holds the name. Teams holding nothing are
  skipped; ``team=`` on the call probes that one team instead; a key with an
  ``endpoints`` scope probes its frozen team only. The order is total, so
  there is no tie rule and no ambiguity error;
- ``@public``: the store rung, the publisher's ``~public`` publication.

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
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence, Tuple


from ai.account.deployment_backend import DEFAULT_REVIEW_STATE
from ai.account.models import team_order

if TYPE_CHECKING:
    from ai.account.models import AccountInfo
    from ai.modules.task.address import Address
    from ai.modules.task.task_control import DeploymentRef


# ==== Shapes ===================================================================

#: The published rungs, in resolution order, as ``resolve_pins`` walks them.
PUBLISHED_RUNGS = ('me', 'team', 'public')

#: The audience slot of the store rung (the publish rows' encoding).
PUBLIC_AUDIENCE_KEY = '~public'


@dataclass(frozen=True)
class PublishRow:
    """
    One publish row, whichever table it came from (the row source's shape).

    Attributes:
        kind: The kind of the artifact the row points at (``pipe``, ``app``).
        org_id: The publisher's org.
        project_id: The registry name ``developerId.pipeId`` the row is keyed by.
        slot: The audience slot: ``user~{uid}``, a team id, or ``~public``.
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
        rung: ``'me'``, ``'team'`` or ``'public'``.
        deployment: Where the publication lives: the publisher's org, the
            audience slot (``user~{uid}``, a team id, or ``~public``) and the
            registry name ``developerId.pipeId``. Stamped on the control; disable/remove of this
            publication releases the control's hold. On ``@team`` its
            ``team_id`` is the ANSWERING team.
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
            one ``@team`` pin, then ``@public``); the first one answers.
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
    team only). ``team`` overrides it for one call: it must be one of the
    caller's own teams (for a scoped key, its frozen team).

    Args:
        account_info: The request's account.
        team: The per-call override, or None.

    Returns:
        Team ids in probe order.

    Raises:
        PermissionError: ``team`` is not one of the caller's teams.
    """
    order = team_order(account_info)
    if team is None:
        return order
    if getattr(account_info, 'endpoints', None) is not None:
        allowed = order
    else:
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


def _audience_of(slot: str) -> Dict[str, str]:
    """An audience slot as the publish rows' ``{type, id}`` audience."""
    if slot == PUBLIC_AUDIENCE_KEY:
        return {'type': 'public', 'id': ''}
    if slot.startswith('user~'):
        return {'type': 'user', 'id': slot[len('user~') :]}
    return {'type': 'team', 'id': slot}


def _slot_of(row: Dict[str, Any]) -> str:
    """The audience slot a publish row serves: ``user~{uid}``, the team id, or the public key."""
    audience = row.get('audience') or {}
    kind = audience.get('type')
    if kind == 'user':
        return f'user~{audience.get("id") or ""}'
    if kind == 'team':
        return str(audience.get('id') or '')
    return PUBLIC_AUDIENCE_KEY


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
    team: Optional[str] = None,
) -> Pins:
    """
    The published rungs of ``address`` that serve the caller, in precedence order.

    ``@me`` and ``@team`` are publications in the caller's own org, so they
    are read only when the address is in the caller's namespace; ``@public``
    is the publisher's ``~public`` row, found through the org that owns the
    address namespace. ``@team`` yields at most ONE pin: the first team in
    the probe order (``teams_to_probe``) holding a serving row. A pure read.

    Args:
        kind: The artifact kind to resolve (``'pipe'``).
        account_info: The request's account (required).
        address: ``developerId.pipelineId[.source]``.
        team: Per-call ``@team`` override.

    Returns:
        The pins; ``pins`` is empty when no published rung serves the caller.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT (address grammar).
        PermissionError: Unauthenticated, ``team`` is not the caller's, or
            the key's ``endpoints`` scope excludes the address.
    """
    from ai.account import account
    from ai.modules.task.address import build_address, parse_address

    # Step 1: who asks, for what, and whether the key may ask for it
    if account_info is None:
        raise PermissionError('Not authenticated')
    parsed = parse_address(address)
    _check_scope(getattr(account_info, 'endpoints', None), parsed)
    probe = teams_to_probe(account_info, team)
    org_id, developer_id = _org_of(account_info)
    user_id = getattr(account_info, 'userId', '') or ''
    # The registry name every publish row is keyed by: the pipe id inside
    # the publisher's developer namespace, exactly as the deploy door stored
    # it (plan 2.3). The rows are scoped by it, never by the bare pipe id.
    pipe_name = build_address(parsed.developer_id, parsed.pipe_id)
    own_namespace = bool(developer_id) and parsed.developer_id == developer_id and bool(org_id)
    pins: List[Pin] = []

    # Step 2: @me, then @team in the probe order: the caller's own org
    if own_namespace:
        me_slot = f'user~{user_id}' if user_id else ''
        slots = ([me_slot] if me_slot else []) + probe
        rows = await publish_rows(account, org_id, pipe_name, slots)
        if me_slot:
            pin = _serving_pin(rows, kind, 'me', me_slot)
            if pin is not None:
                pins.append(pin)
        for team_id in probe:
            pin = _serving_pin(rows, kind, 'team', team_id)
            if pin is not None:
                pins.append(pin)
                break

    # Step 3: @public, the publisher's store publication
    publisher_org = org_id if own_namespace else await account.get_org_of_developer_id(parsed.developer_id)
    if publisher_org:
        rows = await publish_rows(account, publisher_org, pipe_name, [PUBLIC_AUDIENCE_KEY])
        pin = _serving_pin(rows, kind, 'public', PUBLIC_AUDIENCE_KEY)
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
    rows = await publish_rows(account, publisher_org, pipe_name, [PUBLIC_AUDIENCE_KEY])
    return _serving_pin(rows, 'pipe', 'public', PUBLIC_AUDIENCE_KEY)


# ==== The catalog row ==========================================================


def pipe_catalog_row(pipe_name: str, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    One pipe version as the store catalog lists it, or None when the version is unlisted.

    A pipe is listed when its ``metadata.manifest`` was shaped from a store
    block (``pipe_bundle.is_listed``): a dict deploy without the block is an
    artifact the registry holds and the catalog never shows. The row carries
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
    # Omitted (not None) when undeclared, as an app row omits them
    for key in ('icon', 'readme'):
        url = artifact_file_url('pipe', pipe_name, version, manifest.get(key))
        if url:
            row[key] = url
    return row
