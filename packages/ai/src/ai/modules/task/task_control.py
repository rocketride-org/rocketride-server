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
TaskControl: the CALLER's view of a run.

A control is what a request resolves to. Its IDENTITY is ``(owner, rung,
project_id, hash(resolved config))`` (plan section 1): a spec that differs in
configuration under the same ``project_id`` is another control on the same
engine. Its HANDLE is the ``control_id``, ``=control/<32 hex>`` minted when the
control is created, returned to the caller in the ``token`` slot and named by
every verb after that; it dies with the control and is never written to disk
(plan 15 item 20). It carries everything that belongs to the caller rather
than to the running process: the address, the owner (a user, a team or the
org, never a service identity), the rung that answered, the resolved
component config, the run's place in the rung table (payer, ledger user and
team, environment, plan 8.3), the ``parameters`` admission map, the trace
level, the idle ttl, and exactly ONE hold on a ``TaskEngine``. The engine is the
process; many controls may hold one engine (plan section 1, 7.1). A hold
entitles the control to its engine but does not keep it running: an engine
that stopped on its own inactivity timer, or crashed after it had confirmed
running, leaves the control DORMANT, and the next request through it starts
the engine again under the same key (plan 7.2).

The registry key is the control id. ``control_key(rung, ownerId, address,
callerId, version)`` is the owner-filtered INDEX a name resolves through
(several controls of one owner may share it on ``@spec``: one ``project_id``,
several configs; on the team and org rungs every caller has a control of
their own, so the caller is part of it). ``control.task``
names the held engine, so the many ``control.task.<...>`` call sites read as
"the engine this control holds".
"""

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Tuple

from rocketride.types.task import TASK_METRICS, TASK_STATUS_FLOW, TASK_TOKENS
from rocketlib.config import ConfigError, _coerce, _type_error

from ai.account.audience import compose_owner, parse_audience
from ai.account.roots import KIND_ORG, KIND_PUBLIC, KIND_TEAM, KIND_USER
from ai.common import node_config
from ai.common.parameters import resolve_call_params
from ai.constants import CONST_SPEND_ALLOW_SECONDS

from .engine_key import IndexMap, index_map_of
from .pipeline import resolve_pipeline_env
from .types import EngineState, LAUNCH_TYPE, TaskError

# A config value that IS one ``${ROCKETRIDE_*}`` placeholder and nothing else:
# the one shape whose expansion takes the leaf's declared type (plan 6.2). A
# placeholder inside a longer string stays text.
WHOLE_PLACEHOLDER = re.compile(r'^\$\{ROCKETRIDE_[A-Za-z0-9_]+\}$')
TYPED_LEAVES = ('integer', 'number', 'boolean')


class CallerConfigError(ConfigError):
    """
    A control's env value does not fit the typed leaf its placeholder sits on.

    The resolver's error class, so the engine and the server door refuse the
    same way; ``path`` names the leaf for the door's ``field``.
    """

    def __init__(self, path: str, message: str) -> None:
        """Keep the leaf path beside the message."""
        super().__init__(message)
        self.path = path


def _child_key(node: Dict[str, Any], remaining: str) -> Optional[str]:
    """
    The stored key the next step of a dotted ``remaining`` path takes, or None.

    A declared child name may itself carry a dot (a branch block such as
    ``gpt-5.2``), so the stored keys are matched against the path, never the
    path split at its dots: the longest key that is the remaining path or
    leads it before a dot.
    """
    keys = [key for key in node if key == remaining or remaining.startswith(key + '.')]
    return max(keys, key=len) if keys else None


def _leaf_at(tree: Any, path: str) -> Any:
    """The value at a dotted schema ``path`` of a stored config tree, or None."""
    remaining, node = path, tree
    while remaining:
        if not isinstance(node, dict):
            return None
        key = _child_key(node, remaining)
        if key is None:
            return None
        node, remaining = node[key], remaining[len(key) + 1 :]
    return node


def _set_leaf(tree: Dict[str, Any], path: str, value: Any) -> None:
    """Set the value at a dotted schema ``path`` an ``_leaf_at`` walk reached."""
    remaining, node = path, tree
    while True:
        key = _child_key(node, remaining)
        if key == remaining:
            node[key] = value
            return
        node, remaining = node[key], remaining[len(key) + 1 :]


def typed_caller_config(stored: Dict[str, Any], expanded: Dict[str, Any], view: Any) -> Dict[str, Any]:
    """
    Give an expanded whole-placeholder leaf the type its schema declares.

    ``resolve_pipeline_env`` expands textually, so ``${ROCKETRIDE_EDGE}`` on
    an integer leaf arrives as the string ``"1024"``, which the node's
    resolver refuses by contract (a string on an integer leaf is a
    ``ConfigError``; coercing engine-side would accept wrong-type literals).
    Here the schema and the pre-expansion value are both in hand: a leaf
    whose STORED value is exactly one placeholder is parsed to its declared
    integer/number/boolean; an unfilled placeholder, an embedded one and
    every other type stay as expanded.

    Args:
        stored: The component's config as the spec stores it (placeholders in place).
        expanded: The same config after ``resolve_pipeline_env`` (modified in place).
        view: The resolved ``ConfigView`` of the component (keys, ``path_of``, ``descriptor_of``).

    Returns:
        ``expanded``.

    Raises:
        CallerConfigError: The env value does not parse as the leaf's type.
    """
    for key in view:
        path = view.path_of(key)
        raw = _leaf_at(stored, path)
        if not isinstance(raw, str) or not WHOLE_PLACEHOLDER.fullmatch(raw):
            continue
        value = _leaf_at(expanded, path)
        if not isinstance(value, str) or value == raw:
            continue
        descriptor = view.descriptor_of(key)
        kind = descriptor.get('type')
        if kind not in TYPED_LEAVES:
            continue
        coerced = _coerce(value, descriptor)
        # The refusal names the leaf, its type and the stored placeholder,
        # never the env value it expanded to: the text goes back to a caller
        # who may run with the team's environment without reading it
        if _type_error(kind, coerced):
            raise CallerConfigError(path, f'"{path}" expects {kind} (from {raw})')
        _set_leaf(expanded, path, coerced)
    return expanded


# ==== Status notes ============================================================


def expand_note(note: Any, address: str, project_id: str) -> Any:
    """
    Expand a status note's identity placeholders for ONE control.

    A node emits its readiness notes once per engine with the placeholders
    ``{token}`` / ``{address}`` (the control's address), ``{project_id}`` and
    ``{source}``; the engine stores them as emitted because it may serve
    several controls. Strings are expanded, dict values are expanded one
    level deep, anything else passes through.

    Args:
        note: One stored note (str, dict or other).
        address: The control's ``developerId.pipelineId.source``.
        project_id: The control's short pipeline id.

    Returns:
        The note with this control's identity in place of the placeholders.
    """
    source = address.rsplit('.', 1)[-1] if address else ''

    def fill(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return (
            value.replace('{token}', address)
            .replace('{address}', address)
            .replace('{project_id}', project_id)
            .replace('{source}', source)
        )

    if isinstance(note, dict):
        return {key: fill(value) for key, value in note.items()}
    return fill(note)


if TYPE_CHECKING:
    from ai.account.file_store import DeclaredRoot

    from .task_conn import TaskConn
    from .task_engine import TaskEngine


# ==== The control id ============================================================

#: What every control id starts with: the ``=`` id root of plan 2.5, naming
#: its kind. An address segment is ``[A-Za-z0-9_-]+``, so no address can
#: start with ``=`` and the token slot tells the two forms apart by
#: construction, not by a convention about dots.
CONTROL_ID_PREFIX = '=control/'

#: The shape of a control id: ``=control/`` and 32 lowercase hex characters.
CONTROL_ID = re.compile(r'^=control/[0-9a-f]{32}$')


def mint_control_id() -> str:
    """A fresh control id: random, transient, never a storage key (plan 15 item 20)."""
    return f'{CONTROL_ID_PREFIX}{uuid.uuid4().hex}'


def is_control_id(value: Any) -> bool:
    """
    Whether ``value`` is a control id.

    A control id is ``=control/`` and 32 lowercase hex characters (plan
    2.5): the prefix is a form no address can take, so the verbs that take
    either (a data ``open``, a standalone ``tool`` borrow, the monitor key
    builders) tell them apart by this test alone.

    Args:
        value: What the client put in the token slot.

    Returns:
        True for ``=control/`` followed by 32 lowercase hex characters.
    """
    return isinstance(value, str) and CONTROL_ID.match(value) is not None


def config_hash(configs: List[Dict[str, Any]]) -> str:
    """
    The configuration half of a control's identity (plan section 1).

    Args:
        configs: The resolved component config by STACK INDEX (defaults
            applied, ``${ROCKETRIDE_*}`` placeholders unexpanded).

    Returns:
        sha256 over the sort-keyed JSON of the list.
    """
    content = json.dumps(list(configs), sort_keys=True, default=str)
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


# ==== Rungs ====================================================================

#: The five rungs, in resolution order (plan section 1, 3.2). ``spec`` is the
#: caller's own runs; the other four serve publications.
RUNGS = ('spec', 'me', 'team', 'org', 'public')

#: The rungs whose controls are owned by the team or the org but run for ONE
#: caller each (plan 8.3): the caller is part of their index key (plan 7.5).
CALLER_RUNGS = ('team', 'org')

#: The caller segment of an index key on a caller rung for a run with no caller (plan 7.5).
NO_CALLER = '-'

#: Who may own a run (plan 2.5, 8.3).
OWNER_KINDS = (KIND_USER, KIND_TEAM, KIND_ORG)

#: ``TaskServer.resolve_target`` acts on the first candidate: a publication starts its control.
RESOLVE_START = 'start'

#: ``TaskServer.resolve_target`` decides without acting: the first candidate, a control or a publication.
RESOLVE_READ = 'read'

#: ``TaskServer.resolve_target`` reads registered controls only and never starts one.
RESOLVE_ATTACH = 'attach'


def control_key(
    rung: str,
    owner_id: str,
    address: str,
    caller_id: str = '',
    version: Optional[int] = None,
) -> str:
    """
    Build the owner-filtered index key a name resolves through (plan 7.5).

    ``<rung>.<ownerId>.<address>`` on ``spec``, ``me`` and ``public``;
    ``<rung>.<ownerId>.<callerId>.<address>`` on the team and org rungs, where
    every caller has a control of their own under the one owner (``-`` for a
    run with no caller); a PINNED version (one other than the rung's
    published version, plan 3.2) appends ``:<version>``, so a pinned run
    never shares an identity with the rung's published-version run. The
    registry's primary key is the control id; this is the index a NAME
    resolves through (several controls of one owner may share it on
    ``spec``: one ``project_id``, several configs). Internal only: clients
    send control ids or addresses, never this.

    Args:
        rung: One of :data:`RUNGS`.
        owner_id: The owning user, team or org id.
        address: ``developerId.pipelineId.source``.
        caller_id: The caller on a team or org rung ('' for none); ignored
            on the other rungs, where the owner is the caller.
        version: The pinned registry version, or None for the rung's
            published version (and on ``spec``, which has none).

    Returns:
        The index key.

    Raises:
        ValueError: ``rung`` is not one of :data:`RUNGS`, or ``spec`` names a version.
    """
    if rung not in RUNGS:
        raise ValueError(f'invalid rung: {rung!r}')
    if rung == 'spec' and version is not None:
        raise ValueError('a spec run has no version')
    key = (
        f'{rung}.{owner_id}.{caller_id or NO_CALLER}.{address}'
        if rung in CALLER_RUNGS
        else f'{rung}.{owner_id}.{address}'
    )
    return key if version is None else f'{key}:{version}'


# ==== Billing attribution ======================================================


@dataclass(frozen=True)
class BillingAttribution:
    """
    Who pays for the work done under one control, and whom the ledger names (plan section 8.3).

    Per control, never per engine: two controls holding one engine are two
    attributions. Metering per binding fills the usage (C.13); this is the
    account side of it.

    Attributes:
        org_id: The paying org.
        team_id: The ledger team: the team whose publication served (the
            home team on ``@spec``, the billing stamp on ``@me``, the serving
            team on a team rung); '' on ``@org`` and ``@public``.
        user_id: The ledger user: the caller, the publisher of an unattended
            ``@me`` run; '' for any other run with no caller.
    """

    org_id: str = ''
    team_id: str = ''
    user_id: str = ''


# ==== DeploymentRef reference ====================================================


@dataclass(frozen=True)
class DeploymentRef:
    """
    The deployment a control resolved through.

    Publisher disable/remove releases every hold whose control resolved
    through the same deployment (plan section 7.2); the reference is how the
    release finds them.

    Attributes:
        org_id: The deployment's org.
        team_id: The deployment's audience (plan 2.5): ``=user/<uid>``,
            ``=team/<tid>``, ``=org/<oid>`` or ``@public``. The field keeps
            the name the wire gives it (``teamId``).
        project_id: The deployed pipeline's short id.
    """

    org_id: str
    team_id: str
    project_id: str

    @property
    def team(self) -> str:
        """The team id of a team audience; ``''`` for every other audience."""
        decoded = parse_audience(self.team_id)
        return decoded.id if decoded.kind == 'team' else ''


# ==== Store listing ============================================================

#: The listing mode of a publication that charges no subscription, and of a
#: publication with no store block at all (plan 8.4, 9).
LISTING_FREE = 'free'


@dataclass(frozen=True)
class Listing:
    """
    The store listing facts of the publication a control serves through (plan 8.4).

    Read once from the version's ``metadata.manifest`` when the control is
    created: a version is immutable, so its listing never changes under a
    control. A dev run, and a publication with no store block, is ``free``.

    Attributes:
        mode: ``'free'``, ``'subscription'`` or ``'paywall'``.
        plan: The nickname of the listing's first plan ('' when it names
            none): what a refused caller is told to subscribe to.
    """

    mode: str = LISTING_FREE
    plan: str = ''

    @property
    def paid(self) -> bool:
        """True when calling the publication needs a subscription (any mode but ``free``)."""
        return self.mode != LISTING_FREE


# ==== The rung table ===========================================================


@dataclass(frozen=True)
class Attribution:
    """
    One run's row of the rung table (plan 8.3): owner, payer, ledger user and team, environment.

    The environment's org is the payer, its user layer the ledger user (the
    two agree on every row of both tables), its team layer ``env_team``.

    Attributes:
        rung: The rung that serves the run (one of :data:`RUNGS`).
        owner_kind: ``'user'``, ``'team'`` or ``'org'``: where the run lives.
        owner_id: The owning user, team or org id.
        org_id: The paying org.
        user_id: The ledger user ('' none); the environment's user layer.
        team_id: The ledger team ('' none).
        env_team: The environment's team layer ('' none).
        caller_id: The caller ('' for a run with no caller: a schedule, a
            run-now, a listener).
    """

    rung: str
    owner_kind: str
    owner_id: str
    org_id: str
    user_id: str
    team_id: str
    env_team: str
    caller_id: str = ''


def caller_attribution(
    rung: str, account_info: Any, *, deployment: Optional[DeploymentRef] = None, billing_stamp: str = ''
) -> Attribution:
    """
    The rung table's row for a run WITH a caller (plan 8.3, the first table).

    | Rung | Owner | Payer | User | Team | Environment |
    |---|---|---|---|---|---|
    | ``@spec`` | the caller | the caller's org | the caller | the home team | org, home team, user |
    | ``@me`` | the caller | the caller's org | the caller | the billing stamp | org, home team, user |
    | ``@<team>`` | the team | the caller's org | the caller | that team | org, home team, user |
    | ``@org`` | the org | the org | the caller | none | org, home team, user |
    | ``@public`` | the caller | the caller's org | the caller | none | org, home team, user |

    The home team is the first of the caller's team order (a scoped key's
    frozen team stands in for it); the environment is always the caller's,
    so a user whose keys are only at user level brings them to any pipe.

    Args:
        rung: The rung that answered.
        account_info: The caller's account.
        deployment: The publication that answered (team and org rungs).
        billing_stamp: The ``@me`` pointer's billing stamp.

    Returns:
        The attribution.

    Raises:
        ValueError: An unknown rung, a team rung without its team, or an
            ``@me`` pointer without its billing stamp.
    """
    from ai.account.models import home_team

    caller = str(getattr(account_info, 'userId', '') or '')
    organization = getattr(account_info, 'organization', None) or {}
    org_id = str(organization.get('id') or '')
    home = home_team(account_info)
    if rung == 'spec':
        return Attribution(rung, KIND_USER, caller, org_id, caller, home, home, caller)
    if rung == 'me':
        if not billing_stamp:
            raise ValueError('This deployment has no billing team; re-publish it')
        return Attribution(rung, KIND_USER, caller, org_id, caller, billing_stamp, home, caller)
    if rung == 'team':
        team = deployment.team if deployment is not None else ''
        if not team:
            raise ValueError('A team rung run needs the team whose publication answered')
        return Attribution(rung, KIND_TEAM, team, org_id, caller, team, home, caller)
    if rung == 'org':
        return Attribution(rung, KIND_ORG, org_id, org_id, caller, '', home, caller)
    if rung == 'public':
        return Attribution(rung, KIND_USER, caller, org_id, caller, '', home, caller)
    raise ValueError(f'invalid rung: {rung!r}')


def unattended_attribution(audience: str, *, org_id: str, billing_stamp: str = '') -> Attribution:
    """
    The rung table's row for a run with NO caller: a schedule, a run-now, a listener (plan 8.3, the second table).

    | Publication | Owner | Payer | User | Team | Environment |
    |---|---|---|---|---|---|
    | ``@me`` | the publisher | the publisher's org | the publisher | the billing stamp | org, the stamp, the publisher |
    | ``@<team>`` | the team | the org | none | that team | org, that team |
    | ``@org`` | the org | the org | none | none | org |
    | ``@public`` | the org | the org | none | none | org |

    A run with no caller never borrows a user layer but the publisher's own
    on ``@me``. The publisher's home team there is the billing stamp: the
    publisher's development team written on the pointer at publish and
    never resolved at fire time (the scheduler holds no session).

    Args:
        audience: The publication's audience (``=user/<uid>``, ``=team/<tid>``,
            ``=org/<oid>`` or ``@public``).
        org_id: The publishing org.
        billing_stamp: The pointer's billing stamp (``@me`` requires one).

    Returns:
        The attribution.

    Raises:
        AudienceError: The text is not an audience.
        ValueError: An ``@me`` pointer without its billing stamp, or an org
            audience naming another org.
    """
    decoded = parse_audience(audience)
    if decoded.kind == KIND_USER:
        if not billing_stamp:
            raise ValueError('This deployment has no billing team; re-publish it after setting your development team')
        return Attribution('me', KIND_USER, decoded.id, org_id, decoded.id, billing_stamp, billing_stamp)
    if decoded.kind == KIND_TEAM:
        return Attribution('team', KIND_TEAM, decoded.id, org_id, '', decoded.id, decoded.id)
    if decoded.kind == KIND_ORG:
        if decoded.id != org_id:
            raise ValueError(f"{audience!r} is another organization's publication")
        return Attribution('org', KIND_ORG, org_id, org_id, '', '', '')
    if decoded.kind == KIND_PUBLIC:
        return Attribution('public', KIND_ORG, org_id, org_id, '', '', '')
    raise ValueError(f'{audience!r} is no publication')


# ==== Per-control counts ===========================================================


@dataclass
class ControlStats:
    """
    What THIS control's own bindings did (plan 7.5): counts and bytes, summable, never rates.

    On a shared engine the engine-wide counters are other holders' work too;
    a holder's status carries these instead. Maintained by the data path as
    pipes open and close through the control.

    Attributes:
        totalCount: Bindings opened.
        completedCount: Bindings closed without failure.
        failedCount: Bindings closed failed.
        completedSize: Bytes written through bindings that completed.
        failedSize: Bytes written through bindings that failed.
    """

    totalCount: int = 0
    completedCount: int = 0
    failedCount: int = 0
    completedSize: int = 0
    failedSize: int = 0


# ==== The open-pipe record =======================================================


@dataclass
class OpenPipe:
    """
    One pipe a control has open on an engine (plan 3.1, P1/P2).

    The record is the OWNERSHIP check and the ENGINE PIN of the data path: a
    ``write``/``close``/``tool`` naming a slot that is not on the caller's
    control is refused before anything is forwarded (on a shared engine the
    slot number alone must never reach the subprocess), and the later frames
    of an open pipe go to the engine the pipe opened on, so an engine started
    again for a dormant control never receives another launch's slot numbers.

    Attributes:
        engine: The engine the pipe was opened on.
        trace_id: The request tree's wire ``traceId`` (``nodeId.engineId.n``).
        correlation_id: The server-minted request id the open carried.
    """

    engine: 'TaskEngine'
    trace_id: str
    correlation_id: str
    bytes: int = 0


# ==== The control ==============================================================


@dataclass
class TaskControl:
    """
    The caller's view of a run, holding exactly one engine.

    Attributes:
        id: Display id: the address.
        control_id: The handle (plan section 1): ``=control/<32 hex>`` minted at
            creation, what the caller gets in the ``token`` slot and names on
            every verb; the registry key. Transient, never persisted.
        key: The registry key: the control id.
        client_id: The launching user's id (equal to ``userId`` on every dev run).
        developer_id: The address namespace.
        address: ``developerId.pipelineId.source``: the public name a NAME
            call resolves through the caller's rungs.
        userId / teamId / orgId: The run's row of the rung table (plan 8.3):
            the ledger user (also the environment's user layer; '' for a run
            with no caller but the publisher of an unattended ``@me`` run),
            the ledger team ('' on ``@org`` and ``@public``) and the paying
            org (also the environment's org). The owner id is one of them:
            ``owner_id``.
        caller_id: The caller this control runs for ('' for a run with no
            caller: a schedule, a run-now, a listener). Every control runs
            for exactly one caller (plan 8.3); on the team and org rungs it
            is part of the index key.
        env_team: The environment's team layer: the caller's home team, the
            publication's team for a run with no caller ('' for none).
        run_kind: ``'dev'`` or ``'deploy'``: the run-log continuum and the
            storage tree.
        owner_kind: ``'user'``, ``'team'`` or ``'org'``: who owns the run,
            where it lives (its log tree, its files) and who watches it.
        rung: ``'spec'``, ``'me'``, ``'team'``, ``'org'`` or ``'public'``:
            stamped from the audience that answered, never derived.
        trigger: What fired a deployment run (``''``, ``'manual'``, ``'schedule'``, or
            ``'submit'`` for a name call started from a published artifact).
        launch_owner / launch_type: The connection that launched it and how.
        project_id / source / provider: The pipeline's short id, entry
            component and that component's provider.
        pipeline: The spec this control submitted (placeholders unexpanded).
        config: The component config AS THE SPEC STORES IT (converted,
            parameter tokens decoded, placeholders unexpanded) by STACK INDEX
            (``engine_key.stack_order``, the order the task file writes): what
            the frame that starts a binding carries to the engine as
            ``_caller.config``, env-expanded (plan 5.3); the engine resolves
            it against the node schemas itself.
        config_hash: sha256 of the sort-keyed JSON of the RESOLVED config by
            stack index (defaults applied): the configuration half of the
            identity, so a spelled-out default is not another control.
        parameters: The pipeline's ``parameters`` admission map (plan 5.2).
        trace_level: The control's trace level (plan 7.4).
        ttl: The control's idle ttl in seconds; 0 means no idle limit.
        last_activity: Monotonic time of the last request through this
            control: the control's OWN idle clock (plan 7.1).
        expiry_gen: The control's entry in the server's idle-expiry heap
            (0 = not scheduled); a heap entry with another value is stale.
        inflight: Requests running through this control right now. While
            one runs the idle clock is held: a call longer than the ttl is
            never expired mid-flight (``begin_request``/``end_request``).
        registered_at: Monotonic time the control was registered, or the
            earlier moment its deployment's state was read when a trusted
            dispatch started it: a deployment revoked after this moment makes
            the control unavailable (plan 7.2, the kill switch).
        deployment: The deployment this control resolved through, if any.
        version: The artifact version a published rung started from (None on @spec).
        pinned: True when ``version`` was named by the call (``:<version>``)
            and is not the rung's published version (plan 3.2): the index
            key, the monitor key and the run-log stream carry it.
        roots: The physical roots the pipeline's declared ``roots`` resolved
            to through the run's OWNER when the control started (plan 2.5,
            ``file_store.declared_roots``): what ``self.files`` admits beyond
            the storage anchor.
        listing: The store listing of that version (``free`` on @spec and
            for a publication with no store block).
        subscription_allowed_at: Monotonic time the caller's subscription to
            a paid listing was last confirmed (0.0 = never).
        task: The ONE engine this control holds. It may be an engine that
            stopped on its inactivity timer or crashed after it confirmed
            running; the next request starts it again under the same key.
        engine_starting: True while a request through this control waits in
            the start gate for its stopped engine to start again.
    """

    # Display id: the address
    id: str = ''

    # The handle and the registry key (one and the same): minted at creation
    control_id: str = ''
    key: str = ''

    # Connection identifier (the launching user's id on every dev run)
    client_id: str = ''

    # The address. It omits the owner on purpose: the same address names
    # different controls for different callers, and the resolver picks the
    # caller's own through the owner-filtered index (``index_key``).
    developer_id: str = ''
    address: str = ''

    # The run's row of the rung table (plan 8.3): the ledger user, the
    # ledger team and the paying org; the caller it runs for and the team
    # layer of its environment
    userId: str = ''
    teamId: str = ''
    orgId: str = ''
    caller_id: str = ''
    env_team: str = ''

    # Run classification ('dev' | 'deploy') and owner scope ('user' | 'team'
    # | 'org'). owner_kind decides the visibility owner independently of
    # run_kind: a deployed run may be user-owned (@me, a caller's @public),
    # team-owned (@team) or org-owned (@org, an unattended @public). Empty
    # falls back to the run_kind default for a control built before it is
    # stamped.
    run_kind: str = 'dev'
    owner_kind: str = ''

    # The rung that answered (stamped from the audience, plan 8.3) and what
    # fired a deployment run
    rung: str = 'spec'
    trigger: str = ''

    # Launch type and owning connection
    launch_owner: Optional['TaskConn'] = None
    launch_type: LAUNCH_TYPE = LAUNCH_TYPE.LAUNCH

    # The pipeline this control submitted
    project_id: Optional[str] = None
    source: Optional[str] = None
    provider: Optional[str] = None
    pipeline: Optional[Dict[str, Any]] = None

    # The stored component config by stack index (delivered to the engine on
    # the open, plan 5.3) and the hash of its resolved view: the configuration
    # half of the identity (plan section 1). Per control, never in the engine key
    config: List[Dict[str, Any]] = field(default_factory=list, repr=False, compare=False)
    config_hash: str = ''

    # Caller-side run settings: never part of the engine key
    parameters: Dict[str, Any] = field(default_factory=dict)
    trace_level: Optional[str] = None
    ttl: int = 0

    # The ROCKETRIDE_* values this control's bindings run with, resolved once
    # from its environment chain (plan 6.2): org, env_team, the ledger user;
    # rides _caller.env
    env: Dict[str, str] = field(default_factory=dict)

    # The RocketRide cloud databases this control's DB nodes may open, as
    # dsn_key -> the owner the account approved FOR THIS CONTROL'S RUN
    # (SDD 4.4); empty without DB nodes. Authorized when the control is
    # created; the engine it holds must have been handed exactly these
    db_approved: Dict[str, str] = field(default_factory=dict, repr=False, compare=False)

    # The pipes this control has open, by slot (plan 3.1 P1/P2), and what its
    # bindings did so far (plan 7.5)
    open_pipes: Dict[int, OpenPipe] = field(default_factory=dict)
    stats: ControlStats = field(default_factory=ControlStats)

    # The resolved config views of the components the parameters map targets,
    # built on first use and dropped when the pipeline changes: the schema is
    # resolved once per component for the control's life, not once per request
    param_views: Dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    # Author id <-> stack index for this control's pipeline (C.23), built on
    # first use and dropped when the pipeline changes (``index_map``)
    index_cache: Optional[IndexMap] = field(default=None, repr=False, compare=False)

    # When the paying unit last answered "allowed" (monotonic); a request within
    # CONST_SPEND_ALLOW_SECONDS of it asks no question (the engine's own gate
    # trusts an allow for the same window). A refusal is never cached.
    credit_allowed_at: float = 0.0

    # The same window for the subscription to a paid listing (plan 8.4): one
    # question per control per window, and a refusal is never cached
    subscription_allowed_at: float = 0.0

    # The control's own idle clock and its idle-expiry heap entry: activity
    # through one control never keeps another alive (plan 7.1)
    last_activity: float = field(default_factory=time.monotonic)
    expiry_gen: int = 0
    inflight: int = 0
    registered_at: float = 0.0

    # The deployment this control resolved through, if any, and its version
    deployment: Optional[DeploymentRef] = None
    version: Optional[int] = None
    pinned: bool = False

    # The declared roots, resolved through the owner when the control started
    # (plan 2.5): ``self.files`` reaches them and nothing else beyond its anchor
    roots: Tuple['DeclaredRoot', ...] = ()

    # The store listing of that version (plan 8.4); free for a dev run
    listing: Listing = field(default_factory=Listing)

    # The ONE engine this control holds
    task: Optional['TaskEngine'] = None

    # A request through this control is starting its stopped engine again
    engine_starting: bool = False

    # A restart is setting up this control's successor: it stays registered
    # (its events still route, its id still answers) but no new request
    # resolves to it, and the restart alone decides when it leaves
    restarting: bool = False

    @property
    def owner_type(self) -> str:
        """``'user'``, ``'team'`` or ``'org'``: who owns this control, the run_kind default when unstamped."""
        return self.owner_kind or ('team' if self.run_kind == 'deploy' else 'user')

    @property
    def owner_id(self) -> str:
        """
        The identity that OWNS this control (plan 8.3): the user of a
        user-owned run, the team of a team-owned run (the ledger team there is
        always that team), the org of an org-owned run (the paying org there
        is always that org); never the attribution teamId of a user-owned
        run. Monitor keys, the registry key and identity lookups scope by it.
        """
        kind = self.owner_type
        if kind == 'team':
            return self.teamId
        if kind == 'org':
            return self.orgId
        return self.userId

    @property
    def pinned_version(self) -> Optional[int]:
        """The version a PINNED run serves (plan 3.2, C.36); None for the rung's published version and on ``@spec``."""
        return self.version if self.pinned else None

    @property
    def index_key(self) -> str:
        """The owner-filtered index key a name resolves through (plan 7.5; see ``control_key``)."""
        return control_key(self.rung, self.owner_id, self.address, self.caller_id, self.pinned_version)

    @property
    def display_name(self) -> str:
        """What this control is called where a shared engine has no name of its own: its pipeline's name, else its address."""
        return str((self.pipeline or {}).get('name') or self.address or self.id)

    @property
    def index_map(self) -> IndexMap:
        """
        Author component id <-> stack index for this control's pipeline (C.23).

        The engine speaks stack indexes (a trace's component, the open's
        config, the status it aggregates); this control's user sees the ids
        THEY wrote, whatever ids the engine's first starter wrote. Built from
        the engine's canonical walk (``engine_key.index_map_of``), the same
        order the task file and ``config`` follow, once per pipeline.
        """
        if self.index_cache is None:
            self.index_cache = index_map_of(self.pipeline or {}, self.source)
        return self.index_cache

    def author_flow(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """
        A flow event body as this control's user wrote the pipeline: stack indexes become author ids (C.23).

        ``component`` names a component on ``enter``/``leave`` and the object
        on ``begin``/``end``; ``pipes`` is the object name followed by the
        component stack. Only components are translated.

        Args:
            body: This control's copy of an ``apaevt_flow`` body, updated in place.

        Returns:
            The same body.
        """
        names = self.index_map
        if body.get('op') in ('enter', 'leave'):
            body['component'] = names.author(body.get('component'))
        pipes = body.get('pipes')
        if isinstance(pipes, list) and pipes:
            body['pipes'] = pipes[:1] + [names.author(name) for name in pipes[1:]]
        return body

    def caller_config(self) -> List[Dict[str, Any]]:
        """
        The config a binding's first frame carries to the engine: ``config`` by stack index, expanded for THIS control (plan 5.3).

        The ``${ROCKETRIDE_*}`` placeholders are filled from the control's own
        env (resolved once from its environment chain, least privilege), and a
        leaf that was one whole placeholder takes its declared scalar type
        (``typed_caller_config``); the engine builds this control's IGlobal
        set from it and keeps nothing it cannot rebuild from the next open.

        Returns:
            A new list, one config per component in stack order.

        Raises:
            CallerConfigError: An env value does not fit its typed leaf.
        """
        expanded = list(resolve_pipeline_env({'config': self.config}, self.env)['config'])
        components = self.index_map.order((self.pipeline or {}).get('components', []) or [])
        for index, (component, stored) in enumerate(zip(components, self.config)):
            if index >= len(expanded) or not isinstance(stored, dict):
                continue
            # The component's resolved view, from the same per-control cache
            # the parameters map reads: the schema is resolved once per
            # component for the control's life
            component_id = str(component.get('id') or '')
            if component_id not in self.param_views:
                self.param_views[component_id] = node_config.resolve_node_config(
                    str(component.get('provider') or ''), stored
                )
            view = self.param_views[component_id]
            if view is not None:
                typed_caller_config(stored, expanded[index], view)
        return expanded

    @property
    def billing(self) -> BillingAttribution:
        """
        The paying unit and the ledger's user and team for this control (plan 8.3).

        Attribution rides the control, never the engine and never the
        request: every control runs for exactly one caller, so two callers of
        one team publication are two controls and two attributions.
        """
        return BillingAttribution(org_id=self.orgId, team_id=self.teamId, user_id=self.userId)

    def publication(self) -> Tuple[str, Optional[int]]:
        """
        The publication this control serves through, for the usage row (plan 8.2).

        A request's usage row is keyed by the publication that answered it,
        so a caller who used Staging and then Production on one day holds two
        rows, not one with a flipping context. A dev run serves through no
        publication and reports neither part.

        Returns:
            ``(audience, version)``: the deployment's audience
            (``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>`` or ``@public``)
            or ``''``, and the artifact version or None.
        """
        return self.audience, self.version

    @property
    def audience(self) -> str:
        """The audience of the publication this control serves through; ``''`` for a dev run."""
        return self.deployment.team_id if self.deployment is not None else ''

    @property
    def owner(self) -> str:
        """The owner string of this control (``=user/<uid>``, ``=team/<tid>`` or ``=org/<oid>``); ``''`` when it has no owner id."""
        owner_id = self.owner_id
        return compose_owner(self.owner_type, owner_id) if owner_id else ''

    # ==== Idle tracking ===========================================================

    def touch(self) -> None:
        """
        Record a request through this control: O(1).

        Only the timestamp moves. The server's idle-expiry heap re-reads it
        when the control's scheduled deadline comes up, so activity never
        touches the heap. The engine notes the time too: it restarts the
        engine's own inactivity timer.
        """
        # Step 1: the control's own idle clock restarts
        now = time.monotonic()
        self.last_activity = now

        # Step 2: the held engine dates its idle time from its latest activity
        if self.task is not None:
            self.task.note_activity(now)

    def check_params(self, params: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
        """
        Admit per-call ``params`` by PUBLIC NAME against this control's ``parameters`` map.

        The map half of plan 5.4 item 5: a name the pipeline does not expose
        is refused here, never silently dropped, before anything reaches the
        engine. The descriptor half (type, bounds, an array's items, which
        branch a selector reaches) is ``resolve_params``.

        Args:
            params: The caller's ``params`` (public name -> value), or None.

        Returns:
            The admitted params, a copy; empty when none were given.

        Raises:
            TaskError: TASK_PARAM_REJECTED with ``errors=[{name, reason}]``
                for every unknown name, and for a value that is neither a
                scalar nor a whole list (an array parameter, plan 5.1).
        """
        if not params:
            return {}
        if not isinstance(params, Mapping):
            raise TaskError(
                TaskError.PARAM_REJECTED,
                'params must be a mapping of public name to value',
                address=self.address,
                errors=[{'name': '', 'reason': 'params is not a mapping'}],
            )
        errors = []
        for name, value in params.items():
            if name not in self.parameters:
                errors.append({'name': str(name), 'reason': 'not a parameter of this pipeline'})
            elif isinstance(value, (dict, tuple, set)):
                errors.append({'name': str(name), 'reason': 'a parameter value is a scalar or a whole list'})
        if errors:
            names = ', '.join(e['name'] for e in errors)
            raise TaskError(
                TaskError.PARAM_REJECTED,
                f'params rejected on {self.address!r}: {names}',
                address=self.address,
                errors=errors,
            )
        return dict(params)

    def resolve_params(self, admitted: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
        """
        The per-node map of admitted params the engine applies (plan 5.4 item 5, the descriptor half).

        Each value is validated against its leaf's descriptor through the
        node's resolver; a target that is not a ``param``-flagged key is
        refused. The result keys each node's values by the leaf's schema path,
        which ``IInstanceBase.settings`` overlays.

        The ``parameters`` map targets the ids THIS control's pipeline was
        written with (published maps stay in author ids); the engine knows
        the component at that STACK INDEX by the id its first starter wrote,
        which is what its node reads as ``config.node.id``. So each target
        goes author id -> stack index (this control's map) -> the engine's id
        at that index (C.23, ``engine_targets``); on one owner's private
        engine the two are the same id.

        Args:
            admitted: Params already admitted by name (``check_params``).

        Returns:
            ``{nodeId: {path: value}}`` keyed by the engine's ids; empty when
            none were given.

        Raises:
            TaskError: TASK_PARAM_REJECTED with ``errors=[{name, reason}]``.
        """
        if not admitted:
            return {}
        per_node, errors = resolve_call_params(self.pipeline or {}, self.parameters, admitted, self.param_views)
        if errors:
            names = ', '.join(e['name'] for e in errors)
            raise TaskError(
                TaskError.PARAM_REJECTED,
                f'params rejected on {self.address!r}: {names}',
                address=self.address,
                errors=errors,
            )
        return self.engine_targets(per_node)

    def engine_targets(self, per_node: Mapping[str, Any]) -> Dict[str, Any]:
        """
        Re-key a per-node map from this control's author ids to the held engine's ids, through the stack index (C.23).

        Args:
            per_node: ``{authorId: values}``.

        Returns:
            ``{engineId: values}``; an id outside the stack, or no engine map
            to read, keeps its author id.
        """
        engine = self.task
        engine_map = getattr(engine, 'index_map', None) if engine is not None else None
        if not isinstance(engine_map, IndexMap):
            return dict(per_node)
        own = self.index_map
        out: Dict[str, Any] = {}
        for node_id, values in per_node.items():
            index = own.to_index(node_id)
            target = engine_map.to_id(index) if index is not None and index < own.stacked else None
            out[target or node_id] = values
        return out

    def project_status(self, status: Dict[str, Any], shared: bool) -> Dict[str, Any]:
        """
        The status body THIS control's holders may see (plan 7.5).

        Every holder gets the engine's availability. On a private engine the
        engine's counters are the owner's own work and pass through. On a
        shared engine they are every holder's work: the counts become this
        control's own, rates and engine-level diagnostics (warnings, errors,
        component stats, slowest documents, metrics, the status message, the
        exit text) are scrubbed, the body names this control, and no holder
        count rides anywhere (``pipeflow`` is empty).

        Args:
            status: The engine's ``TASK_STATUS`` as a dict (not modified).
            shared: Whether the engine is shared (its key names no owner).

        Returns:
            The projected status body.
        """
        body = dict(status)
        # Step 1: the availability projection every holder is entitled to
        body['engine'] = {'availability': self.engine_state}
        # Step 1a: the engine aggregates by STACK INDEX; this control's user
        # reads the component ids they wrote (C.23)
        self._author_status(body)
        # Step 1b: the notes name THIS control's identity. The engine stores
        # them as the node emitted them (placeholders intact) because two
        # controls of one owner may hold one private engine under different
        # addresses; each sees its own door, never the first holder's.
        if isinstance(body.get('notes'), list):
            body['notes'] = [expand_note(note, self.address, self.project_id) for note in body['notes']]
        if not shared:
            return body
        # Step 2: a shared engine's counters are replaced by this control's own
        body.update(
            totalCount=self.stats.totalCount,
            completedCount=self.stats.completedCount,
            failedCount=self.stats.failedCount,
            completedSize=self.stats.completedSize,
            failedSize=self.stats.failedSize,
            totalSize=self.stats.completedSize + self.stats.failedSize,
            rateCount=0,
            rateSize=0,
            wordsCount=0,
            wordsSize=0,
            currentObject='',
            currentSize=0,
        )
        # Step 2a: a shared engine names nobody; the body names this control
        if 'name' in body:
            body['name'] = self.display_name
        if 'project_id' in body:
            body['project_id'] = self.project_id or ''
        if 'source' in body:
            body['source'] = self.source or ''
        # Step 3: engine-level diagnostics, the engine's resource and token
        # totals, the pipes every holder has open (their object names with
        # them) and the engine's exit text belong to the ops stream (a
        # holder's own usage is C.13; its own pipes reach it as flow events)
        for key, empty in (
            ('warnings', []),
            ('errors', []),
            ('notes', []),
            ('componentStats', {}),
            ('slowestDocs', []),
            ('metrics', TASK_METRICS().model_dump()),
            ('tokens', TASK_TOKENS().model_dump()),
            ('pipeflow', TASK_STATUS_FLOW().model_dump()),
            ('exitMessage', ''),
            # The engine's last status message (a node's monitor text, a
            # model download) names whatever work the engine did last, any
            # holder's; the availability says what the holder needs
            ('status', ''),
        ):
            if key in body:
                body[key] = empty
        return body

    def status_view(self) -> Dict[str, Any]:
        """
        This control's view of its engine's current status: ``project_status`` of ``get_status()``.

        What every surface that shows a control's status to its caller reads
        (the status body, the task lists, the dashboard rows), so a holder of
        a shared engine never reads another holder's counts or the engine's
        totals through any of them.

        Returns:
            The projected status body.
        """
        return self.project_status(self.task.get_status().model_dump(), bool(self.task.shared))

    def _author_status(self, body: Dict[str, Any]) -> None:
        """
        Translate the component names of an engine status body to this control's author ids (C.23).

        ``componentStats`` is keyed by component and ``pipeflow.byPipe`` holds
        each pipe's object name followed by its component stack; both come
        from traces that name components by stack index. ``slowestDocs``
        names objects, never components, so it passes through.

        Args:
            body: The projected copy of the status, updated in place.
        """
        names = self.index_map
        if not names.engine_indexes:
            return
        stats = body.get('componentStats')
        if isinstance(stats, dict):
            body['componentStats'] = {names.author(key): value for key, value in stats.items()}
        flow = body.get('pipeflow')
        if isinstance(flow, dict) and isinstance(flow.get('byPipe'), dict):
            body['pipeflow'] = {
                **flow,
                'byPipe': {
                    pipe: (stack[:1] + [names.author(name) for name in stack[1:]]) if isinstance(stack, list) else stack
                    for pipe, stack in flow['byPipe'].items()
                },
            }

    def setup_declared_parameters(self) -> None:
        """
        Set up the per-call parameters the control's current pipeline DECLARES (its ``parameters`` map).

        The map (public name -> ``nodeId.configKey``, plan 5.2) is the admission
        list for per-call ``params``; the resolved node views cached for it are
        dropped at the same time. Called where the control's pipeline is set
        (a start): the cached views describe components of the pipeline they
        were resolved from, so they go with it.
        """
        self.parameters = dict((self.pipeline or {}).get('parameters') or {})
        self.param_views.clear()
        self.index_cache = None

    def credit_allowed(self, now: float) -> bool:
        """
        Whether a recent credit check already allowed this control's paying unit.

        Args:
            now: ``time.monotonic()``.

        Returns:
            True within ``CONST_SPEND_ALLOW_SECONDS`` of the last allow.
        """
        return now - self.credit_allowed_at < CONST_SPEND_ALLOW_SECONDS

    def subscription_allowed(self, now: float) -> bool:
        """
        Whether the caller's subscription to this control's paid listing was confirmed recently.

        Args:
            now: ``time.monotonic()``.

        Returns:
            True within ``CONST_SPEND_ALLOW_SECONDS`` of the last confirmation.
        """
        return now - self.subscription_allowed_at < CONST_SPEND_ALLOW_SECONDS

    def begin_request(self) -> None:
        """
        A request starts running through this control: activity, and the idle clock is held.

        The server's TTL pass never releases a control with a request in
        flight, whatever its idle time says: the request may outlive the ttl
        without touching the control (a long write, a slow pipeline).
        """
        self.inflight += 1
        self.touch()

    def end_request(self) -> None:
        """The request finished (any way): activity again, and the idle clock runs from now."""
        self.inflight = max(0, self.inflight - 1)
        self.touch()

    @property
    def dormant(self) -> bool:
        """
        True when the held engine stopped and its next request restarts it.

        That is an engine stopped on its own inactivity timer
        (``dormant_reason == 'ttl'``) or one that crashed after it had
        confirmed running (``'crash'``). The control is still the caller's:
        the next request through it starts the engine again
        (``TaskServer.ensure_engine``).
        """
        return self.task is not None and self.task.dormant_reason is not None and self.task.state is EngineState.STOPPED

    @property
    def live(self) -> bool:
        """True while the control can serve: its engine runs, or it is dormant."""
        return self.task is not None and (self.task.is_live or self.dormant)

    @property
    def engine_state(self) -> str:
        """
        The availability of the held engine (plan 7.5).

        - ``'starting'``: a request through this control waits in the start
          gate for its stopped engine, or the engine is starting and has not
          yet confirmed running;
        - ``'running'``: the engine confirmed running and has not stopped;
        - ``'stopped'``: no engine, a stopped or stopping one (a dormant
          control reads ``'stopped'`` until its next request).

        Carried in every status body as ``engine.availability``
        (``project_status``) and in task lists as ``engineState``.
        """
        # A restart through this control is in the start gate
        engine = self.task
        if engine is None:
            return 'stopped'
        if self.engine_starting:
            return 'starting'

        # Otherwise the engine's own state, projected (plan 7.5)
        if engine.state is EngineState.RUNNING:
            return 'running'
        if engine.state in (EngineState.NEW, EngineState.STARTING):
            return 'starting'
        return 'stopped'

    def idle_seconds(self, now: Optional[float] = None) -> float:
        """
        Seconds since the last activity through this control.

        A dev run also counts its engine's pipeline events as activity, as a
        dev run always has; a deployment run uses its ttl as a run window.

        Args:
            now: Monotonic time to measure at (default: now).

        Returns:
            The control's idle time in seconds (never negative).
        """
        # Step 1: the control's own last request
        last = self.last_activity

        # Step 2: a dev run's pipeline events count as its activity
        if self.run_kind == 'dev' and self.task is not None:
            last = max(last, self.task.last_pipeline_event)

        now = time.monotonic() if now is None else now
        return max(0.0, now - last)
