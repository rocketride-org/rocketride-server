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

# =============================================================================
# ACCOUNT MODELS
# Shared internal types used by both the account layer and the task layer.
# Placed here to avoid circular imports between account/auth and modules/task.
# =============================================================================

from dataclasses import dataclass
from typing import Any, NotRequired, Optional, TypedDict

from pydantic import BaseModel

from rocketride.types.client import AppManifestEntry


# =============================================================================
# NESTED SHAPES
# Lightweight TypedDicts documenting the shape of AccountInfo's
# ``organization`` and ``apps`` fields. Mirrors the public
# ``OrgInfo`` / ``TeamInfo`` defined in ``rocketride.types.client`` but kept
# local to avoid a server→client cross-package import.
# =============================================================================


class TeamInfo(TypedDict):
    """Shape of an entry inside ``OrgInfo['teams']``."""

    id: str
    name: str
    permissions: list[str]


class OrgInfo(TypedDict):
    """Shape of the ``AccountInfo.organization`` field (single org per user)."""

    id: str
    name: str
    permissions: list[str]
    teams: list[TeamInfo]
    # Public developer slug — the app publisher identity. Absent/None on OSS
    # and task-scoped synthetic orgs, and on orgs not registered as developers.
    developerId: NotRequired[Optional[str]]


# =============================================================================
# ACCOUNT INFO
# =============================================================================


class AccountInfo(BaseModel):
    """Internal representation of an authenticated session."""

    # Raw credential that was used to authenticate (pk_/tk_ for task-scoped)
    auth: str = ''

    # Persistent per-user credential (rr_<user_token>)
    userToken: str = ''

    # Stable user identifier
    userId: str = ''

    # Human-readable identity
    displayName: str = ''
    givenName: str = ''
    familyName: str = ''
    preferredUsername: str = ''
    email: str = ''
    emailVerified: bool = False
    phoneNumber: str = ''
    phoneNumberVerified: bool = False
    locale: str = ''

    # The session's DEVELOPMENT team (pre-resolved server-side): the team a
    # dev-mode run is billed to and whose environment layer applies. Carries
    # NO authorization meaning — permission checks resolve the union of
    # memberships (has_permission) or the addressed team
    # (verify_team_permission), never this field.
    devTeam: str = ''

    # Single org/team/permissions structure — all permission checks resolve through this.
    # None when the user has no org membership (e.g. freshly invited, not yet provisioned).
    organization: Optional[OrgInfo] = None

    # Apps on the user's desktop — full manifest entries with appStatus + onDesktop.
    # OSS: all apps with appStatus="free", onDesktop=True.
    # SaaS: populated from app_users table, enriched with full manifest + billing info.
    apps: list[AppManifestEntry] = []

    # Server capability tags — 'oss' or 'saas' depending on the account provider
    capabilities: list[str] = []

    # Platform-level permission strings (e.g. ['sys.admin', 'sys.view']).
    # Set manually in the database, never via API.
    sysPermissions: list[str] = []

    # Credit wallet balance snapshot — dict of resource→balance pairs.
    # Populated from the credit_wallets table for the user's primary org.
    credits: dict = {}

    # True when the user is authenticated but not yet granted app access
    # (email did not match any allowed pattern in the user_grants table)
    waitlisted: bool = False

    def to_connect_result(self) -> dict:
        """
        Serialize to ConnectResult dict sent to the client (excludes auth).

        The ``auth`` field is intentionally excluded so that the raw credential
        is never echoed back over the wire to a connecting client.

        Returns:
            dict: All AccountInfo fields except ``auth``, suitable for sending
                  as the body of a DAP connect response.
        """
        # Use pydantic's model_dump with an explicit exclusion set so that the
        # raw authentication credential is never returned to the client.
        return self.model_dump(exclude={'auth'})

    def to_push_result(self) -> dict:
        """
        Serialize for a PUSHED ``apaext_account`` update — excludes ``auth`` AND
        blanks ``userToken``.

        A pushed account update fans out to every open connection of a user,
        matched by userId only. Unlike the connect/auth response, it must NOT
        carry the user's real ``rr_`` session credential: a task-scoped
        (``pk_``/``tk_``) connection matched by userId would otherwise ADOPT it
        client-side, escalating a deliberately minimal task identity into the
        full user. ``userToken`` is kept as an EMPTY STRING rather than removed
        so the shell's ``isConnectResult`` guard (which requires ``userToken``
        to be a string) still accepts the body and re-emits the update.

        Returns:
            dict: ``to_connect_result()`` with ``userToken`` blanked.
        """
        data = self.to_connect_result()
        data['userToken'] = ''
        return data


# =============================================================================
# REQUEST CONTEXT
# Per-request identity passed through the handler chain.  In OSS standalone
# mode ctx is built from the connection's _account_info.  In pod mode ctx
# is deserialized from the _ctx field injected by the Orchestrator into the
# forwarded request arguments.
#
# MERGE NOTE (feat/alb): the class below — fields, defaults, and docstring —
# is copied VERBATIM from the feat/alb branch, which introduces it and passes
# a ctx into every on_* handler. When feat/alb merges/rebases with this
# branch:
#   * Keep ONE RequestContext: alb's core is identical; PRESERVE this
#     branch's additions below it — the 'engine' source value and the
#     internal()/engine() factories (the storage layer binds FileStore
#     instances to a ctx and depends on them).
#   * The 'internal'/'sys.admin' short-circuits in resolve_task_permissions
#     and resolve_team_permissions exist identically on both branches —
#     dedupe to one copy.
#   * TaskConn.request_context() on this branch is the pre-alb local
#     builder; once handlers receive ctx from alb's _build_request_context,
#     replace request_context() call sites with the handler's ctx parameter
#     and delete the helper.
# =============================================================================


@dataclass
class RequestContext:
    """
    Per-request caller identity for DAP command handlers.

    Every ``on_*`` handler receives a ``ctx`` parameter built by ``on_receive``
    before dispatch.  Handlers use ``ctx.account_info`` for user identity and
    ``ctx.conn_id`` for resource-scoping (file handles, profiler sessions).

    Attributes:
        account_info: The authenticated user's AccountInfo.  None only for
                      pre-auth commands (``on_auth``) and for engine-subprocess
                      contexts (``RequestContext.engine()`` — no account exists
                      in that process; the storage layer sandboxes it instead).
        conn_id:      Stable identifier for the originating client connection,
                      e.g. ``"orch-1:4527"`` (pod mode) or ``"conn-5"`` (OSS).
                      Used to scope and clean up per-connection resources.
        source:       ``'local'`` for OSS standalone connections or
                      ``'orchestrator'`` for commands forwarded by the
                      Orchestrator via an internal pod connection.
    """

    account_info: Optional[AccountInfo] = None
    conn_id: str = ''
    source: str = 'local'

    # ── Additions on this branch (see MERGE NOTE above) ──────────────────────
    # source == 'engine' marks an ENGINE-SUBPROCESS context (tool nodes): no
    # account exists in that process and its paths originate from LLM tool
    # calls, so the storage layer sandboxes it to plain user-scope paths.

    @classmethod
    def internal(cls, subsystem: str) -> 'RequestContext':
        """Identity for a trusted server-internal subsystem.

        Follows the pod-service convention: an AccountInfo carrying the
        ``internal`` sysPermission, which the permission resolvers expand to
        the full team set and the storage policy accepts for internal-only
        rules (e.g. writing run-log content). Greppable: every trusted caller
        is a ``RequestContext.internal(...)`` call site.

        Args:
            subsystem: Short name of the calling subsystem (e.g. 'run-log',
                       'scheduler', 'fetch') — lands in conn_id for tracing.
        """
        return cls(
            account_info=AccountInfo(
                userId=f'internal:{subsystem}',
                displayName=f'internal:{subsystem}',
                sysPermissions=['internal'],
            ),
            conn_id=f'internal:{subsystem}',
            source='local',
        )

    @classmethod
    def engine(cls, client_id: str) -> 'RequestContext':
        """Identity for engine-subprocess tool nodes (most restricted).

        No account exists in the subprocess and paths come from LLM tool
        calls: the storage layer allows plain user-scope paths only — every
        ``@`` scope and reserved subtree is rejected.

        Args:
            client_id: The task owner's client id (path scoping only).
        """
        return cls(account_info=None, conn_id=f'engine:{client_id}', source='engine')


# =============================================================================
# PERMISSION HELPERS
# =============================================================================

# The complete set of permissions that an org admin implicitly possesses for
# every team within their organisation.  Used to expand the 'org.admin' role
# without storing redundant data in the database.
_FULL_TEAM_PERMISSIONS = [
    'team.admin',
    'task.control',
    'task.data',
    'task.monitor',
    'task.debug',
    'task.store',
]


def resolve_task_permissions(account_info: AccountInfo, task_team_id: str) -> list[str]:
    """
    Return the caller's effective permissions for a task owned by the given team.

    CONTRACT — RETURNS ``[]`` on no membership (never raises). Its sibling
    ``resolve_team_permissions`` RAISES for the same condition; the two sit one
    line apart with opposite failure modes, so read the name at each call site.
    A rename to carry the difference (e.g. ``get_*`` vs ``require_*``) is
    deferred to the feat/alb dedupe, where both branches touch these functions.

    Unlike ``resolve_team_permissions`` this does **not** raise when the caller
    has no relationship to the team — it returns an empty list instead,
    signalling "no access".

    Resolution order:
      1. Check ``account_info.organization``.
      2. Walk its teams looking for *task_team_id*.
      3. If found and org has ``org.admin`` → full permissions.
      4. If found → that team's stored permissions.
      5. Not found → ``[]`` (no access).

    Args:
        account_info: The authenticated caller's session.
        task_team_id: The ``teamId`` from the task's TASK_CONTROL.

    Returns:
        Effective permission list, or empty list if the caller has no
        membership in the task's team.
    """
    # sys.admin and internal (pod service) credentials have full access to
    # all tasks — identical lines exist on feat/alb; dedupe on merge.
    sys_perms = getattr(account_info, 'sysPermissions', []) or []
    if 'sys.admin' in sys_perms or 'internal' in sys_perms:
        return list(_FULL_TEAM_PERMISSIONS)

    org = account_info.organization
    if not org:
        return []
    for team in org.get('teams', []):
        if team['id'] == task_team_id:
            if 'org.admin' in org.get('permissions', []):
                return list(_FULL_TEAM_PERMISSIONS)
            return list(team.get('permissions', []))
    return []


def resolve_run_permissions(account_info: AccountInfo, control: Any) -> list[str]:
    """
    Return the caller's effective permissions for one RUN (a TASK_CONTROL).

    CONTRACT — RETURNS ``[]`` on no access (never raises), like
    ``resolve_task_permissions``.

    USER-owned runs (interactive dev runs and personal @me deploys) are
    PRIVATE: the owner holds full permissions, everyone else none — the
    run's billing ``teamId`` NEVER grants visibility into a personal run.
    TEAM-owned runs resolve through team membership exactly as before.
    sys.admin and internal (pod service) credentials keep full access to
    both (resolved here for user-owned runs, inside
    ``resolve_task_permissions`` for team-owned ones).

    Anonymous/legacy controls with no owner id (OSS single-user runs)
    fall through to the team resolution so the synthetic local grants
    keep working.

    Args:
        account_info: The authenticated caller's session.
        control: The run's TASK_CONTROL (or any object carrying
            ``owner_kind``/``owner_id``/``run_kind``/``teamId``).

    Returns:
        Effective permission list, or empty list if the caller may not
        reach the run.
    """
    # Task-scoped credentials (pk_/tk_) NEVER inherit owner identity: their
    # synthetic AccountInfo copies the owner's userId for attribution, so the
    # owner-private branch below would hand a pk_ public key the full owner
    # permission set on a user-owned run. The key's grant is its capability
    # set on exactly the run it was minted for — any other run resolves
    # nothing, including other runs billed to the same team.
    auth = getattr(account_info, 'auth', '') or ''
    if auth.startswith(('pk_', 'tk_')):
        if auth in (
            getattr(control, 'public_auth', '') or None,
            getattr(control, 'token', '') or None,
        ):
            return resolve_task_permissions(account_info, getattr(control, 'teamId', ''))
        return []

    # Owner scope: explicit stamp wins; fall back to the run_kind default
    # for controls built before owner_kind existed.
    owner_kind = getattr(control, 'owner_kind', '') or (
        'team' if getattr(control, 'run_kind', '') == 'deploy' else 'user'
    )
    owner_id = getattr(control, 'owner_id', '') or ''
    if owner_kind == 'user' and owner_id:
        sys_perms = getattr(account_info, 'sysPermissions', []) or []
        if 'sys.admin' in sys_perms or 'internal' in sys_perms:
            return list(_FULL_TEAM_PERMISSIONS)
        if owner_id == getattr(account_info, 'userId', None):
            return list(_FULL_TEAM_PERMISSIONS)
        return []
    return resolve_task_permissions(account_info, getattr(control, 'teamId', ''))


def resolve_team_permissions(account_info: AccountInfo, team_id: str) -> list[str]:
    """
    Return caller's permissions for a specific team.
    Expands org.admin to the full permission set.

    CONTRACT — RAISES ``PermissionError`` on no membership. Its sibling
    ``resolve_task_permissions`` RETURNS ``[]`` for the same condition; the two
    sit one line apart with opposite failure modes, so read the name at each
    call site. A rename to carry the difference (e.g. ``get_*`` vs
    ``require_*``) is deferred to the feat/alb dedupe.

    Raises PermissionError if the user has no membership in the given team.

    Args:
        account_info (AccountInfo): The authenticated session whose
            ``organization`` field is inspected.
        team_id (str): The team whose permission list should be resolved.

    Returns:
        list[str]: The effective permission strings for the caller within
            the given team.  If the caller has ``org.admin`` on the
            containing organisation, all permissions in
            ``_FULL_TEAM_PERMISSIONS`` are returned regardless of the
            per-team record.

    Raises:
        PermissionError: If ``team_id`` is not found in the user's org.
    """
    # sys.admin and internal (pod service) credentials get full access
    # regardless of team membership — mirrors resolve_task_permissions so the
    # team-scoped and task-scoped permission surfaces agree for these callers.
    # Identical lines exist on feat/alb; dedupe on merge.
    sys_perms = getattr(account_info, 'sysPermissions', []) or []
    if 'sys.admin' in sys_perms or 'internal' in sys_perms:
        return list(_FULL_TEAM_PERMISSIONS)

    org = account_info.organization
    if org:
        for team in org.get('teams', []):
            if team['id'] == team_id:
                # Org admins get the full permission set regardless of what is
                # stored against the individual team record.
                if 'org.admin' in org.get('permissions', []):
                    return list(_FULL_TEAM_PERMISSIONS)
                # Otherwise return the permissions explicitly stored on the team.
                return list(team.get('permissions', []))
    raise PermissionError(f'No membership in team {team_id!r}')
