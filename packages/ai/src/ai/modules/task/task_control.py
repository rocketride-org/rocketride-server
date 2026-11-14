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

A control is what a request resolves to: one per ``(owner, address, rung)``.
It carries everything that belongs to the caller rather than to the running
process: the address, the owner (a user or a team, never a service identity),
the rung that answered, billing attribution, the ``parameters`` admission map,
the trace level, the idle ttl, the ``origin`` hint, and exactly ONE hold on a
``TaskEngine``. The engine is the process; many controls may hold one engine
(plan section 1, 7.1). A hold entitles the control to its engine but does not
keep it running: an engine that stopped on its own inactivity timer, or crashed
after it had confirmed running, leaves the control DORMANT, and the next request
through it starts the engine again under the same key (plan 7.2).

The registry key is ``<rung>.<ownerId>.<address>``. ``control.task`` names the
held engine, so the many ``control.task.<...>`` call sites read as "the engine
this control holds".
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, Mapping, Optional


from .types import EngineState, LAUNCH_TYPE, TaskError

if TYPE_CHECKING:
    from .task_conn import TaskConn
    from .task_engine import TaskEngine


# ==== Rungs ====================================================================

#: The four rungs, in resolution order (plan section 1). ``public`` is
#: produced only by the published-rung resolver.
RUNGS = ('dev', 'me', 'team', 'public')


def rung_of(run_kind: str, owner_kind: str) -> str:
    """
    Map a run classification to its rung.

    A dev run is ``dev``. A deployment run owned by a user (a ``user~`` team
    slot) is that user's personal deployment, ``me``; owned by a team it is
    ``team``. Deploy-rail runs (scheduled or manual) are ``team`` runs that
    keep their trigger.

    Args:
        run_kind: ``'dev'`` or ``'deploy'``.
        owner_kind: ``'user'`` or ``'team'`` (empty takes the run_kind default).

    Returns:
        The rung: ``'dev'``, ``'me'`` or ``'team'``.

    Raises:
        ValueError: The run classification is outside the closed vocabulary.
    """
    if run_kind == 'dev':
        return 'dev'
    if run_kind != 'deploy':
        raise ValueError(f'invalid run_kind: {run_kind!r}')
    kind = owner_kind or 'team'
    if kind == 'user':
        return 'me'
    if kind == 'team':
        return 'team'
    raise ValueError(f'invalid owner_kind: {owner_kind!r}')


def control_key(rung: str, owner_id: str, address: str) -> str:
    """
    Build a control's registry key ``<rung>.<ownerId>.<address>``.

    Internal only: clients send addresses, which the resolver turns into the
    caller's own control.

    Args:
        rung: One of :data:`RUNGS`.
        owner_id: The owning user or team id.
        address: ``developerId.pipelineId.source``.

    Returns:
        The registry key.

    Raises:
        ValueError: ``rung`` is not one of :data:`RUNGS`.
    """
    if rung not in RUNGS:
        raise ValueError(f'invalid rung: {rung!r}')
    return f'{rung}.{owner_id}.{address}'


# ==== Billing attribution ======================================================


@dataclass(frozen=True)
class BillingAttribution:
    """
    Who pays for the work done under one control (plan section 8.3).

    Per control, never per engine: two controls holding one engine are two
    attributions. Metering per binding fills the usage (C.13); this is the
    account side of it.

    Attributes:
        org_id: The paying org.
        team_id: The billing team (the dev team of a dev run, the billing
            stamp of a deployment run).
        user_id: The paying user; empty for a team-owned run.
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
        team_id: The deployment's team slot (``user~{uid}`` for a personal one).
        project_id: The deployed pipeline's short id.
    """

    org_id: str
    team_id: str
    project_id: str


# ==== Team context =============================================================

#: Why a team is a control's team context (plan 6.2).
TEAM_CONTEXT_KINDS = ('answering', 'key', 'deploying', 'home')


@dataclass(frozen=True)
class TeamContext:
    """
    The team whose environment a control runs with (plan 6.2, decided 2026-11-12).

    Environment follows the ANSWERING team; attribution follows the caller
    (plan 8.3) and is not this. Resolved once, when the control is created:

    - ``answering``: the team whose publication answered a ``@team`` call;
    - ``key``: the frozen team of a key with an ``endpoints`` scope;
    - ``deploying``: the deploying team of a deploy-rail run;
    - ``home``: the caller's home team (first in their team order) for
      ``@dev``, ``@me`` and a ``@public`` call.

    C.10 reads the merged env from it; billing (C.13) does not.

    Attributes:
        team_id: The team ('' when the caller has none).
        kind: One of :data:`TEAM_CONTEXT_KINDS`.
    """

    team_id: str = ''
    kind: str = 'home'


# ==== The control ==============================================================


@dataclass
class TaskControl:
    """
    The caller's view of a run, holding exactly one engine.

    Attributes:
        id: Display id: the address.
        client_id: The launching user's id (equal to ``userId`` on every dev run).
        developer_id: The address namespace.
        address: ``developerId.pipelineId.source``: the public name, what
            clients send in the token slot.
        key: The registry key ``<rung>.<ownerId>.<address>``; internal.
        userId / teamId / orgId: Identity derived from the account; teamId is
            billing and permission attribution, not the owner of a dev run.
        run_kind: ``'dev'`` or ``'deploy'``: the run-log continuum and the
            storage tree.
        owner_kind: ``'user'`` or ``'team'``: who owns the run.
        rung: ``'dev'``, ``'me'``, ``'team'`` or ``'public'``.
        trigger: What fired a deployment run (``''``, ``'manual'``, ``'schedule'``, or
            ``'submit'`` for a name call started from a published artifact).
        launch_owner / launch_type: The connection that launched it and how.
        project_id / source / provider: The pipeline's short id, entry
            component and that component's provider.
        pipeline: The spec this control submitted (placeholders unexpanded).
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
        origin: The ``origin`` hint the caller sent, recorded as given.
        deployment: The deployment this control resolved through, if any.
        version: The artifact version a published rung started from (None on @dev).
        team_context: The team whose environment this control runs with.
        task: The ONE engine this control holds. It may be an engine that
            stopped on its inactivity timer or crashed after it confirmed
            running; the next request repoints it.
        engine_starting: True while a request through this control waits in
            the start gate for its stopped engine to start again.
    """

    # Display id: the address
    id: str = ''

    # Connection identifier (the launching user's id on every dev run)
    client_id: str = ''

    # The address and the registry key. The address omits the owner on
    # purpose: the same address names different controls for different
    # callers, and the resolver picks the caller's own.
    developer_id: str = ''
    address: str = ''
    key: str = ''

    # User, team, and org identity (derived from AccountInfo after auth)
    userId: str = ''
    teamId: str = ''
    orgId: str = ''

    # Run classification ('dev' | 'deploy') and owner scope ('user' | 'team').
    # owner_kind decides the visibility owner independently of run_kind: a
    # deployed run may be team-owned (@team) or user-owned (@me). Empty falls
    # back to the run_kind default for a control built before it is stamped.
    run_kind: str = 'dev'
    owner_kind: str = ''

    # The rung that answered and what fired a deployment run
    rung: str = 'dev'
    trigger: str = ''

    # Launch type and owning connection
    launch_owner: Optional['TaskConn'] = None
    launch_type: LAUNCH_TYPE = LAUNCH_TYPE.LAUNCH

    # The pipeline this control submitted
    project_id: Optional[str] = None
    source: Optional[str] = None
    provider: Optional[str] = None
    pipeline: Optional[Dict[str, Any]] = None

    # Caller-side run settings: never part of the engine key
    parameters: Dict[str, Any] = field(default_factory=dict)
    trace_level: Optional[str] = None
    ttl: int = 0
    origin: Optional[str] = None

    # The control's own idle clock and its idle-expiry heap entry: activity
    # through one control never keeps another alive (plan 7.1)
    last_activity: float = field(default_factory=time.monotonic)
    expiry_gen: int = 0
    inflight: int = 0
    registered_at: float = 0.0

    # One engine transition (repoint) at a time per control, readiness and
    # rollback included, so a later restart can never be undone by an earlier
    # one's failure handler (the engine-key start locks do not cover two
    # replacements with different keys)
    transition_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False, compare=False)

    # The deployment this control resolved through, if any, and its version
    deployment: Optional[DeploymentRef] = None
    version: Optional[int] = None

    # The team whose environment applies (plan 6.2); never billing
    team_context: TeamContext = field(default_factory=TeamContext)

    # The ONE engine this control holds
    task: Optional['TaskEngine'] = None

    # A request through this control is starting its stopped engine again
    engine_starting: bool = False

    @property
    def owner_id(self) -> str:
        """
        The identity that OWNS this control: the user of a user-owned run, the
        team of a team-owned run (never the attribution teamId of a user-owned
        run). Monitor keys, the registry key and identity lookups scope by it.
        """
        kind = self.owner_kind or ('team' if self.run_kind == 'deploy' else 'user')
        return self.teamId if kind == 'team' else self.userId

    @property
    def billing(self) -> BillingAttribution:
        """The paying unit of this control: per control, never per engine."""
        return BillingAttribution(org_id=self.orgId, team_id=self.teamId, user_id=self.userId)

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
        engine. The descriptor half (type, bounds, never a selector or a
        secret) is the data path's allow-list (C.8).

        Args:
            params: The caller's ``params`` (public name -> value), or None.

        Returns:
            The admitted params, a copy; empty when none were given.

        Raises:
            TaskError: TASK_PARAM_REJECTED with ``errors=[{name, reason}]``
                for every unknown name, and for a value that is not scalar.
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
            elif isinstance(value, (dict, list, tuple, set)):
                errors.append({'name': str(name), 'reason': 'a parameter value is a scalar'})
        if errors:
            names = ', '.join(e['name'] for e in errors)
            raise TaskError(
                TaskError.PARAM_REJECTED,
                f'params rejected on {self.address!r}: {names}',
                address=self.address,
                errors=errors,
            )
        return dict(params)

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

        TODO(plan 7.5, C.9): carried in ``apaevt_status`` as
        ``body.engine.availability``.
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
