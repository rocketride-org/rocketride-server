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
# ACCOUNT BASE
# Abstract base class defining the full Account interface.
#
# Both the OSS implementation (account/oss/) and the SaaS implementation
# (account/saas/) inherit from this class. The contract is enforced at
# class-definition time via ABC so a missing authenticate() is a loud
# import-time error rather than a silent runtime AttributeError.
# =============================================================================

import asyncio
import os
import re
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Callable, NamedTuple, Optional

# What clients see in place of a stored environment value. A secret is
# written once and never read back; sending the mask back keeps the value.
# The SDKs export the same string as CONST_ENV_MASK.
ENV_MASK = '••••••••'

# The environment names accepted: a .env key ends at whitespace, '=' or '#',
# a quote is stripped from it, and the process environment ends at a NUL
ENV_NAME = re.compile(r'ROCKETRIDE_[^\s=#\'"\0]+')


class DbDecision(NamedTuple):
    """Answer of ``AccountBase.authorize_db_target``.

    Same shape as the SaaS ``extension.saas.datacore_access.DbDecision``:
    callers read ``.allowed``, ``.reason`` and ``.owner_id`` and never import
    either class.

    ``owner_id`` names the database an allow approved: the team or user id
    for the team and user scopes, '' for the org database and on every
    denial. Provision exactly that id; never re-derive the target.

    Truthiness follows ``allowed``. A plain NamedTuple is always truthy, so
    ``if decision:`` would issue a DSN on every denial; here it cannot.
    """

    allowed: bool
    reason: str
    audit: bool = False
    owner_id: str = ''

    def __bool__(self) -> bool:
        return self.allowed


class OutOfCreditsError(RuntimeError):
    """The org is out of credit; ``code`` is what clients receive."""

    code = 'OUT_OF_CREDITS'


class InventoryUnavailableError(RuntimeError):
    """
    The caller's app inventory could not be assembled (the publish registry
    did not answer). Distinct from a genuinely EMPTY inventory on purpose:
    a desktop is seeded from the inventory on a user's first read, and an
    outage must never be written down as "this user chose no apps". Callers
    that decorate catch it and decorate WITHOUT seeding; sign-in catches it
    and proceeds with no apps.
    """


class AccountBase(ABC):
    """
    Abstract interface for the RocketRide Account facade.

    Two concrete implementations exist:
      - ``account/oss/``  — API-key auth against ROCKETRIDE_APIKEY; all
                            account-management methods raise NotImplementedError.
      - ``extension/saas/`` — Zitadel + DB auth; full account management,
                            billing, and marketplace support.

    The OSS ``account/__init__.py`` selects the implementation at import
    time via try/except on the ``saas`` subpackage; callers never branch
    on which edition is active.
    """

    # Server capability tags — subclasses override to declare their mode.
    # OSS sets ['oss']; SaaS sets ['saas']. Used by the infoOnly auth probe
    # and copied into every AccountInfo returned by authenticate().
    capabilities: tuple[str, ...] = ()

    # Whether the @public rung is gated behind the review ladder (submit ->
    # admin approve -> 'ready'). SaaS keeps the ladder; OSS overrides to
    # False so a single-operator server can publish to its own store
    # directly. Consulted by the app_deploy publish gate — the DEFAULT is
    # the safe, gated behavior.
    review_ladder: bool = True

    # =========================================================================
    # ABSTRACT — must be implemented by both OSS and SaaS
    # =========================================================================

    @abstractmethod
    async def authenticate(self, credential: str):
        """
        Authenticate a raw credential string and return an AccountInfo or error tuple.

        Args:
            credential: Raw credential supplied by the connecting client
                        (API key, PKCE code exchange payload, or access token).

        Returns:
            AccountInfo on success, or ``(int, str)`` error tuple on failure.
        """
        ...

    # =========================================================================
    # CONCRETE SHARED — both editions use these; override if needed
    # =========================================================================

    async def get_developer_id(self, org_id: str) -> Optional[str]:
        """
        The developer id (address namespace) of an organization.

        Every task address starts with the owning org's developer id, so the
        trusted deploy-run dispatch — which carries no session — resolves it
        here. SaaS reads the org row; OSS answers its fixed namespace.

        Args:
            org_id: The organization id.

        Returns:
            The developer id, or ``None`` when the org has not claimed one.
        """
        org = await self.get_organization(org_id)
        return (org or {}).get('developerId') or None

    async def get_org_of_developer_id(self, developer_id: str) -> Optional[str]:
        """
        The organization that owns a developer id (the reverse of ``get_developer_id``).

        The pipe resolver (``pipe_deploy.resolve_pins``) needs it for the
        @public rung, where the address names a namespace in ANOTHER org: the
        publication and its artifact live under the publisher's org. A
        caller's own namespace never comes here (its org is on the session).
        OSS has one org, so every address it can resolve is its own; the
        default answers that no other org is known. SaaS overrides it with
        the ``Organization.developer_id`` UNIQUE lookup.

        Args:
            developer_id: The address namespace.

        Returns:
            The owning org id, or ``None`` when no other org claims it.
        """
        return None

    # =========================================================================
    # CONCRETE DEFAULTS — no-op in OSS; SaaS overrides all three
    # =========================================================================

    def get_billing_rates(self) -> dict[str, float]:
        """
        Return billing rates (metric_key -> tokens_per_unit).

        OSS default: empty dict (no billing).
        SaaS override: returns the cached rates loaded from the
        metrics_conversions DB table.
        """
        return {}

    async def reload_billing_rates(self) -> dict[str, float]:
        """
        Reload billing rates from the DB.

        OSS default: no-op, returns empty dict.
        SaaS override: reloads from the metrics_conversions table.
        """
        return {}

    async def get_merged_env(self, user_id: str, org_id: str, team_id: str | None) -> dict[str, str]:
        """
        Build the merged ROCKETRIDE_* environment for a user.

        Merge order: os.environ → org → team → user.  Each layer overrides
        the previous.

        OSS default: returns ROCKETRIDE_* entries from os.environ only.
        SaaS override: also decrypts org/team/user secrets from the database.

        Args:
            user_id: The user's internal ID.
            org_id:  The user's organization ID.
            team_id: The user's active team ID, or None.

        Returns:
            Merged key-value dict ready for pipeline variable resolution.
        """
        return {k: v for k, v in os.environ.items() if k.startswith('ROCKETRIDE_')}

    async def init_account(self, server) -> None:
        """
        Register HTTP routes onto the WebServer instance and run async startup work.

        OSS default is a no-op. The SaaS implementation calls
        ``register_routes(server)`` to wire Zitadel, Stripe, and
        Marketplace endpoints, then creates the database schema.

        Args:
            server: ``WebServer`` instance (from ``ai.web``).
        """
        pass

    async def get_public_apps(self) -> list:
        """
        Return apps visible to unauthenticated users.

        OSS reads ``dist/server/static/apps.json`` and filters by
        ``public !== false``.  SaaS queries the DB for ``owner_type='public'``.

        Returns:
            List of app manifest dicts (same shape as apps.json entries).
        """
        return []

    async def get_apps_for_user(self, user_id: str, organizations: list) -> list:
        """
        Return all apps the authenticated user is entitled to see.

        OSS returns all apps (APIKEY grants full access).
        SaaS queries the DB filtered by ``can_access_app()`` using the
        user's org/team memberships.

        Args:
            user_id:       Internal user ID from the ConnectResult.
            organizations: List containing the user's single org dict with nested teams.

        Returns:
            List of app manifest dicts.
        """
        return []

    async def audit(
        self,
        user_id: str | None,
        source: str,
        reason: str,
        request_data: dict | None = None,
        response_data: dict | None = None,
        org_id: str | None = None,
    ) -> None:
        """
        Write an audit log entry.

        OSS default is a no-op.  The SaaS implementation persists the
        entry to the ``audit_logs`` table.

        Args:
            user_id:       UUID of the acting user, or None for system/webhook events.
            source:        Origin system (e.g. "stripe", "account", "billing").
            reason:        Machine-readable action code (e.g. "create_team", "webhook_invoice_paid").
            request_data:  Optional JSON-serialisable dict of the triggering input.
            response_data: Optional JSON-serialisable dict of the resulting state.
            org_id:        UUID of the organisation this event pertains to, or None.
        """
        pass

    # =========================================================================
    # BILLING — no-op in OSS; SaaS overrides with real ledger writes
    # =========================================================================

    async def apply_credit(
        self,
        org_id: str,
        type: str,
        resource: str,
        amount: float,
        idempotency_key: str,
        user_id: str | None = None,
        team_id: str | None = None,
        context: dict | None = None,
    ) -> bool:
        """
        Add credits to an org's ledger.

        OSS default is a no-op returning False.  The SaaS implementation
        INSERTs a positive-amount row into ``credit_ledger``.

        Args:
            org_id:          Organisation to credit.
            type:            Transaction type (``purchase``, ``credit``, ``refund``, etc.).
            resource:        Resource being credited (``tokens``, ``video``, etc.).
            amount:          Positive amount to credit.
            idempotency_key: Namespaced dedup key (e.g. ``stripe:cs_xxx:tokens``).
            user_id:         Optional actor who initiated the credit.
            team_id:         Optional team context.
            context:         Optional audit metadata.

        Returns:
            True on first apply, False on duplicate or no-op.
        """
        return False

    async def apply_debit(
        self,
        org_id: str,
        user_id: str | None,
        team_id: str | None,
        resource: str,
        amount: float,
        idempotency_key: str,
        context: dict,
        description: str | None = None,
    ) -> bool:
        """
        Debit an org's ledger (UPSERT for task usage).

        OSS default is a no-op returning False.  The SaaS implementation
        UPSERTs a negative-amount row into ``credit_ledger``.

        The caller passes a **positive** amount; the implementation negates
        it internally.

        Args:
            org_id:          Organisation to debit.
            user_id:         User the burn is attributed to, or None for a run with no user (a team- or org-owned run).
            team_id:         Team the burn is attributed to, or None for a run with no team scope.
            resource:        Billing bucket (e.g. tokens, video, audio).
            amount:          Positive amount to debit (negated internally).
            idempotency_key: Namespaced dedup key (e.g. ``task:abc123:gpu_memory``).
            context:         Human-readable audit context — pipeline name, source, etc.
            description:     Line-item detail (e.g. gpu_memory, cpu_utilization).

        Returns:
            True on success, False on duplicate or no-op.
        """
        return False

    async def get_credit_balance(self, org_id: str) -> dict:
        """
        Get the net credit balance for an org, grouped by resource.

        OSS default returns empty balances.  The SaaS implementation
        queries ``SELECT resource, SUM(amount) GROUP BY resource``.

        Args:
            org_id: Organisation to query.

        Returns:
            ``{'balances': {resource: float, ...}}``
        """
        return {'balances': {}}

    async def apply_usage(
        self,
        org_id: str,
        user_id: str | None,
        team_id: str | None,
        resource: str,
        amount: float,
        idempotency_key: str,
        request_count: int,
        context: dict,
        description: str | None = None,
        increment_id: str = '',
    ) -> bool:
        """
        Add one increment of named-pipe usage to its ledger row (plan 8.2, S11).

        Unlike ``apply_debit`` (a REPLACING upsert for an owned run's
        cumulative per-task rows), this is ADDITIVE: the row under
        ``idempotency_key`` gains ``amount`` and ``request_count``, atomically
        in the database, so any number of engines and servers may add into one
        row. The key (``task_metrics.usage_key``) is a hash of the paying
        unit, the publication that answered and the resource, with no day in
        it: one row holds all the usage of that unit through that publication,
        and the ledger's ``modified_at`` says when it was last charged. OSS
        keeps no ledger and returns False.

        Args:
            org_id:          The paying org (the caller's).
            user_id:         The caller, or None for a run with no caller (a schedule, a run-now, a listener).
            team_id:         The team the usage is attributed to, or None.
            resource:        Billing bucket (``tokens``, or a custom resource).
            amount:          Positive tokens to add (negated internally, like a debit).
            idempotency_key: The row's key (``task_metrics.usage_key``).
            request_count:   Requests this increment covers.
            context:         Audit context (the publication served, source, rung).
            description:     Line-item detail (the metric name).
            increment_id:    This increment's own id: the ledger records it with
                             the addition in one transaction and refuses a
                             second write of it, so the sender may retry an
                             unanswered write without adding twice.

        Returns:
            True when a row was added to, False on a no-op (a repeated increment included).
        """
        return False

    async def check_spend(self, org_id: str) -> 'str | None':
        """Why the org may not open a pipe, or None if it may. OSS has no balance, so it always may."""
        return None

    async def get_transactions(
        self,
        org_id: str,
        scope: str = 'org',
        scope_id: str | None = None,
        page: int = 1,
        page_size: int = 50,
        since: str | None = None,
    ) -> dict:
        """
        Paginated transaction detail for an org, optionally scoped to a team or user.

        OSS default returns empty results.  The SaaS implementation queries
        the ``credit_ledger`` table with pagination and scope filtering.

        Args:
            org_id:    Organisation to query.
            scope:     ``org``, ``team``, or ``user``.
            scope_id:  Team or user ID when scope is not ``org``.
            page:      1-based page number.
            page_size: Rows per page (max 100).
            since:     ISO datetime string — only return rows at or after this time.

        Returns:
            ``{'transactions': [...], 'total': int, 'page': int, 'pageSize': int}``
        """
        return {'transactions': [], 'total': 0, 'page': page, 'pageSize': page_size}

    async def get_usage_by_publication(
        self,
        org_id: str,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list:
        """
        The org's own named-pipe usage grouped by the publication that served it (plan 8.3, B39).

        OSS keeps no ledger (``apply_usage`` is a no-op), so there is no row
        to group and the answer is an empty list. The SaaS implementation
        reads only ``org_id``'s usage rows (one per paying unit per
        publication, the publication readable in the row's context) and groups
        them by pipe, rung, answering team and version, so a publisher never
        sees other orgs' calls.

        Args:
            org_id: Organisation to query (the viewer's org).
            since:  First UTC day to count, or None.
            until:  First UTC day not counted, or None.

        Returns:
            ``[{pipe, rung, team, teamName, version, requestCount,
            credits: {resource: amount}}, ...]`` ordered by total desc.
        """
        return []

    # NOTE: fire-time billing resolution (resolve_billing_team) is GONE by
    # doctrine — billing is ABSOLUTE, stamped onto every publish at pointer
    # time (deployments_deploy billing_team_id) and only ever read by runs.

    # =========================================================================
    # CLOUD DATABASE — env-gated broker call; raises when unconfigured
    # =========================================================================

    async def authorize_db_target(self, identity: dict, target: dict | None = None) -> DbDecision:
        """
        Decide whether a run (or caller) may receive a cloud database DSN.

        Called before every ``resolve_db_dsn``: by the task engine at task
        start, once per distinct ``(scope, target)`` its DB nodes ask for.
        The SaaS edition overrides this with the live org/team/user check
        and its audit log (``extension/saas``, SDD 4.4). This default is for
        editions with no orgs or teams: one tenant, so only the org scope
        exists and anything else is refused.

        Args:
            identity: ``{org_id, user_id, team_id, run_kind, owner_kind,
                public_endpoint, path, task_id}``. Unused here.
            target: ``{scope, team_id, user_id}``, or None for the org
                database.

        Returns:
            DbDecision(allowed, reason, audit, owner_id). A denial is falsy;
            an allow's owner_id is the id to provision ('' for the org
            database, the only one this default allows).
        """
        scope = (target or {}).get('scope', 'org')
        if scope == 'org':
            return DbDecision(True, 'single_tenant')
        return DbDecision(False, 'scope_needs_rocketride_cloud')

    async def resolve_db_dsn(self, client_id: str, scope: str = 'org', owner_id: str = '') -> str:
        """
        Resolve the DSN of one RocketRide cloud database.

        The ``rocketride_sql`` / ``rocketride_vector`` / ``rocketride_graph``
        nodes take no connection configuration. The task engine calls this at
        task start, after ``authorize_db_target`` allowed the target, and hands
        the DSNs to the nodes (``ROCKETRIDE_DB_DSNS``). One database per
        tenant backs all three node types. A tenant is an org, a team or a
        user inside an org (datacore isolation SDD 4.1).

        Default implementation (both editions): call the data-core provisioner
        configured via server-side environment —

            ROCKETRIDE_DB_BROKER_URL    the /provision endpoint URL
            ROCKETRIDE_DB_BROKER_TOKEN  its Bearer token (from ASM/k8s; never
                                        hardcoded)

        Org scope sends ``{"tenant_id": client_id}`` (unchanged, so existing
        org databases keep their name and password). Team and user scope send
        ``{"scope", "org_id": client_id, "owner_id"}``, and the provisioner
        builds the key. The response is ``{"database", "role", "dsn",
        "created"}`` (only ``dsn`` is read). The endpoint is idempotent (same
        tenant -> same DSN; the password is derived, not stored), so this is
        safe to call on every task start with no caching on this side.

        When the environment is not configured (the open-source default), this
        raises: the cloud databases require a RocketRide cloud deployment.

        Args:
            client_id: The tenant's org id. On an edition with no orgs, the
                user id (the task engine passes ``org_id or client_id``).
            scope: ``'org'``, ``'team'`` or ``'user'``.
            owner_id: The team id or user id for team and user scope. Must be
                empty for org scope.

        Returns:
            A libpq/SQLAlchemy-compatible PostgreSQL DSN for the tenant DB
            (e.g. ``postgresql://role:pass@pooler:5432/t_<slug>?sslmode=require``).

        Raises:
            NotImplementedError: broker environment not configured.
            ValueError: empty id, unknown scope, or a scope/owner mismatch.
            RuntimeError: the broker rejected the request (HTTP 409: the
                database is retired or being deleted) or returned no DSN.
        """
        broker_url = os.environ.get('ROCKETRIDE_DB_BROKER_URL', '').strip()
        broker_token = os.environ.get('ROCKETRIDE_DB_BROKER_TOKEN', '').strip()
        if not broker_url or not broker_token:
            missing = [
                name
                for name, value in (
                    ('ROCKETRIDE_DB_BROKER_URL', broker_url),
                    ('ROCKETRIDE_DB_BROKER_TOKEN', broker_token),
                )
                if not value
            ]
            raise NotImplementedError(
                f'no RocketRide cloud database is configured on this server (missing: {", ".join(missing)})'
            )
        if not client_id or not client_id.strip():
            raise ValueError('resolve_db_dsn requires a non-empty client_id')
        owner_id = (owner_id or '').strip()
        if scope == 'org':
            if owner_id:
                raise ValueError('the org database takes no owner_id')
            body = {'tenant_id': client_id.strip()}
        elif scope in ('team', 'user'):
            if not owner_id:
                raise ValueError(f'a {scope} database needs an owner_id')
            body = {'scope': scope, 'org_id': client_id.strip(), 'owner_id': owner_id}
        else:
            raise ValueError(f'unknown database scope: {scope!r}')
        self._check_broker_url(broker_url)

        import asyncio

        return await asyncio.to_thread(self._call_db_broker, broker_url, broker_token, body)

    @staticmethod
    def _check_broker_url(url: str) -> None:
        """Refuse to send the broker token over anything but HTTPS.

        The token can resolve ANY tenant's DSN, so a deployment typo like an
        ``http://`` broker URL must fail loudly, not silently ship the token
        (and every returned DSN) in cleartext. Plain http is allowed only for
        localhost — the local dev/test rig runs the provisioner there.
        """
        from urllib.parse import urlparse

        try:
            parsed = urlparse(url)
            scheme, host = parsed.scheme.lower(), parsed.hostname
        except ValueError:
            scheme, host = '', None
        if scheme == 'https':
            return
        if scheme == 'http' and host in ('localhost', '127.0.0.1', '::1'):
            return
        raise RuntimeError(
            f'ROCKETRIDE_DB_BROKER_URL must use https (got {scheme or "no"} scheme): '
            'the broker token must never travel unencrypted; plain http is allowed only for localhost'
        )

    @staticmethod
    def _call_db_broker(url: str, token: str, body: dict) -> str:
        """Blocking POST of ``body`` to the provisioner; runs in a worker thread.

        Stdlib-only on purpose: the account layer has no async-HTTP dependency,
        and one small request per task start does not justify adding one.
        """
        import json
        import urllib.error
        import urllib.request

        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            # 4xx = unknown/invalid tenant per the broker contract; 5xx = broker fault.
            code, reason = e.code, e.reason
            e.close()
            if code == 409:
                # The provisioner refuses a retained or dropping tenant: its
                # team was deleted or its user left the org. Only an operator
                # /restore brings it back, so retrying will not help.
                raise RuntimeError(
                    f'this RocketRide cloud database has been retired and cannot be used (HTTP 409: {reason})'
                ) from e
            raise RuntimeError(f'DB broker rejected provision for this account (HTTP {code})') from e
        except Exception as e:
            raise RuntimeError(f'DB broker unreachable: {e}') from e

        dsn = body.get('dsn') if isinstance(body, dict) else None
        if not dsn or not isinstance(dsn, str):
            raise RuntimeError('DB broker response did not include a DSN')
        return AccountBase._pin_dsn_tls(dsn)

    @staticmethod
    def _pin_dsn_tls(dsn: str) -> str:
        """Validate the broker's DSN and guarantee it carries an sslmode.

        The broker contract sends ``sslmode=require``; this pins that
        guarantee client-side so a broker regression cannot silently
        downgrade every tenant connection to cleartext.
        """
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(dsn)
        if parsed.scheme.lower() not in ('postgres', 'postgresql'):
            raise RuntimeError(f'DB broker returned a non-PostgreSQL DSN (scheme {parsed.scheme!r})')
        if 'sslmode' in parse_qs(parsed.query):
            return dsn
        separator = '&' if parsed.query else '?'
        return f'{dsn}{separator}sslmode=require'

    # =========================================================================
    # DEPLOYMENTS — the teams-as-environments interface.
    #
    # PUBLISH creates an immutable artifact version in the ORG registry;
    # DEPLOY points a TEAM at a version (promotion and rollback are the same
    # pointer move); every action is audited (who/what/when, denormalized so
    # it survives user deletion); removal is soft.
    #
    # The OSS defaults below delegate to the file-backed backend
    # (deployment_backend.py). The SaaS implementation overrides them with
    # DB-backed tables while REUSING the same artifact files — callers
    # (cmd_deploy, the scheduler, UIs) never branch on edition.
    #
    # Permission checks do NOT live here: the command layer verifies team
    # permissions before calling (the same division of labor as the run-log
    # domain API over its system tree).
    # =========================================================================

    # Cache slot for the lazily-created OSS file backend — declared here so
    # the attribute is part of the documented class state.
    _deployments_backend = None

    def _deployment_backend(self):
        """The lazily-created file backend used by the OSS defaults."""
        if self._deployments_backend is None:
            from .deployment_backend import FileDeploymentBackend
            from .store import Store

            self._deployments_backend = FileDeploymentBackend(Store.instance().raw_store())
        return self._deployments_backend

    async def deployments_publish(
        self,
        org_id: str,
        project_id: str,
        pipeline: dict,
        actor: dict,
        comment: str = '',
        metadata: dict = None,
        state: str = None,
    ) -> dict:
        """Snapshot the artifact dict as the next immutable registry version.

        DEPLOY = copy code to the server. Kind rides the artifact dict
        (app records carry kind:'app'; plain pipeline JSON is 'pipe');
        ``metadata`` optionally carries the manifest/build blob. ``state``
        overrides the by-kind born state — the seeder registers
        pre-approved platform artifacts directly as 'ready'.

        Returns the new registry entry (version, sha256, publishedBy, ...).
        """
        return await self._deployment_backend().publish(
            org_id, project_id, pipeline, actor, comment, metadata=metadata, state=state
        )

    # =========================================================================
    # DESKTOP — the per-user desktop list (OSS default; SaaS overrides via
    # ``app_handler`` over its ``app_desktop`` table)
    # =========================================================================

    # Cache slot for the lazily-created OSS desktop backend — declared here so
    # the attribute is part of the documented class state.
    _desktop_backend_instance = None

    def _desktop_backend(self):
        """The lazily-created file backend holding the OSS desktop lists."""
        if self._desktop_backend_instance is None:
            from .desktop import FileDesktopBackend
            from .store import Store

            self._desktop_backend_instance = FileDesktopBackend(Store.instance().raw_store())
        return self._desktop_backend_instance

    def _desktop_lock(self, org_id: str, user_id: str) -> asyncio.Lock:
        """
        The per-(org, user) lock every desktop read-modify-write holds.

        The list is one document rewritten whole, with awaits between its
        read and its write (the seed, the reachability walk, the change), so
        two concurrent requests for one user would lose an update without it.
        Same shape as the deployment backend's per-project ``_meta_locks``.

        Args:
            org_id:  The organization.
            user_id: The user.

        Returns:
            The lock for that desktop (created on first use).
        """
        locks = self.__dict__.setdefault('_desktop_locks', {})
        key = f'{org_id}/{user_id}'
        lock = locks.get(key)
        if lock is None:
            lock = locks[key] = asyncio.Lock()
        return lock

    async def _desktop_ids_unlocked(self, user_id: str, org_id: str, inventory: list) -> list:
        """``desktop_app_ids`` for a caller already holding ``_desktop_lock``."""
        backend = self._desktop_backend()
        ids = await backend.read(org_id, user_id)
        if ids is None:
            ids = [app_id for app_id in inventory if app_id]
            await backend.write(org_id, user_id, ids)
        return ids

    async def desktop_app_ids(self, user_id: str, org_id: str, inventory: list) -> list:
        """
        The user's desktop app ids, seeding the list on the first read.

        A user with no stored desktop gets ``inventory`` — every app the
        caller can reach today — written as their first desktop, so an
        existing user's first sign-in after the upgrade shows the same tiles
        as before (plan 9.1, B41). Later reads return the stored list as is,
        whether or not an id is still reachable; an existing list, an empty
        one included, is never re-seeded.

        Args:
            user_id:   The user.
            org_id:    The organization.
            inventory: The reachable app ids, used only as the first desktop.

        Returns:
            The desktop app ids in stored order.
        """
        async with self._desktop_lock(org_id, user_id):
            return await self._desktop_ids_unlocked(user_id, org_id, inventory)

    async def desktop_mutate(self, user_id: str, org_id: str, inventory: list, mutate: Callable[[list], list]) -> list:
        """
        Change the user's desktop list atomically.

        Under the desktop lock: read (seeding from ``inventory`` when the
        user has no list yet), apply ``mutate`` to a copy, and write the
        result back when it differs. Callers push the refreshed identity
        AFTER this returns — the push reads the stored list, so it must see
        the write.

        Args:
            user_id:   The user.
            org_id:    The organization.
            inventory: The reachable app ids (the seed for a first write).
            mutate:    The change: takes the current list, returns the new one.

        Returns:
            The desktop after the change.
        """
        async with self._desktop_lock(org_id, user_id):
            current = await self._desktop_ids_unlocked(user_id, org_id, inventory)
            changed = list(dict.fromkeys(mutate(list(current))))
            if changed != current:
                await self._desktop_backend().write(org_id, user_id, changed)
            return changed

    async def desktop_app_ids_stored(self, user_id: str, org_id: str) -> list:
        """
        The user's stored desktop app ids WITHOUT seeding: ``[]`` when none.

        For callers whose inventory assembly failed (``InventoryUnavailableError``):
        they still answer from whatever is stored, but must not write a first
        desktop from an outage.

        Args:
            user_id: The user.
            org_id:  The organization.

        Returns:
            The stored list, or an empty list when the user has none yet.
        """
        async with self._desktop_lock(org_id, user_id):
            return await self._desktop_backend().read(org_id, user_id) or []

    async def decorate_desktop(
        self, user_id: str, org_id: str, apps: list, inventory: Optional[list] = None, seed: bool = True
    ) -> list:
        """
        Stamp ``appStatus`` and the real ``onDesktop`` on manifest entries.

        The ONE decoration every OSS surface uses — the login assembly,
        ``rrext_app`` list/get, ``rrext_public_catalog`` and the account push
        — so the handshake and the catalog can never disagree. There is no
        billing on a standalone server, so everything reachable is ``free``.

        Args:
            user_id:   The user.
            org_id:    The organization.
            apps:      Manifest entries (mutated in place and returned).
            inventory: The ids the FIRST desktop is seeded from when the user
                       has none yet — the caller's whole reachable set. Omitted,
                       ``apps`` is that set; a caller decorating a SUBSET (the
                       public catalog) must pass the full inventory, or the
                       apps outside the subset never reach the seeded desktop.
            seed:      False when the caller's inventory could not be assembled:
                       the stored desktop (or nothing) decides membership and
                       nothing is written.

        Returns:
            ``apps``, decorated.
        """
        if seed:
            ids = await self.desktop_app_ids(
                user_id, org_id, inventory if inventory is not None else [a.get('id') for a in apps]
            )
        else:
            ids = await self.desktop_app_ids_stored(user_id, org_id)
        desktop = set(ids)
        for entry in apps:
            entry['appStatus'] = 'free'
            entry['onDesktop'] = entry.get('id') in desktop
        return apps

    async def deployments_deploy(
        self, org_id: str, team_id: str, project_id: str, version: int, actor: dict, billing_team_id: str = ''
    ) -> dict:
        """Point ``team_id`` at registry ``version`` (promotion/rollback).

        ``billing_team_id`` is the ABSOLUTE billing/secrets stamp the command
        layer decided at pointer time — stored verbatim, never resolved here.
        """
        return await self._deployment_backend().deploy(org_id, team_id, project_id, version, actor, billing_team_id)

    # ── Publishes — audience pointers (PUBLISH = bind a deployment) ──────────

    async def publish_set(
        self,
        org_id: str,
        kind: str,
        app_id: str,
        audience: dict,
        version: int,
        snapshot: dict,
        actor: dict,
        state: str = 'enabled',
    ) -> dict:
        """Create or repoint one audience's binding (pure pointer).

        `state` is the binding state the write lands with: 'enabled' (the
        default; a repoint re-enables) or 'disabled', for a caller that must
        carry a prior disabled state through a version bump in ONE write.
        """
        return await self._deployment_backend().publish_set(
            org_id, kind, app_id, audience, version, snapshot, actor, state=state
        )

    async def set_artifact_state(self, org_id: str, project_id: str, version: int, new_state: str, actor: dict) -> dict:
        """Transition one deployment's review state (submit/approve/reject)."""
        return await self._deployment_backend().set_artifact_state(org_id, project_id, version, new_state, actor)

    async def deployments_set_build(self, org_id: str, project_id: str, version: int, build: dict) -> dict:
        """Replace one registry version's metadata.build blob (build worker)."""
        return await self._deployment_backend().set_build(org_id, project_id, version, build)

    async def deployments_scan_builds(self, statuses: tuple) -> list:
        """Every kind:'app' version whose build status matches (restart requeue)."""
        return await self._deployment_backend().scan_builds(statuses)

    async def deployments_delete_version(self, org_id: str, project_id: str, version: int, actor: dict) -> dict:
        """Delete ONE registry version's storage (``deploy delete``, plan 2.3).

        Refused (ValueError) while any publish row pins the version, while
        it is in review, or while its build is queued/running — the one
        rule ``deployment_backend.delete_block_of`` states for both
        editions. Otherwise the registry JSON, the whole sibling content
        dir and the version's registry entry go; the history keeps the
        deploy line and gains the delete line; the number is never reused.
        The SaaS override deletes the same files plus the
        ``deployment_artifacts`` row.

        Returns ``{'projectId', 'version', 'kind', 'sha256', 'deleted'}``.
        """
        return await self._deployment_backend().delete_version(org_id, project_id, version, actor)

    async def publish_get(self, org_id: str, kind: str, app_id: str, audience: dict) -> dict | None:
        """One audience's publish row of one app, or None."""
        return await self._deployment_backend().publish_get(org_id, kind, app_id, audience)

    async def publish_of_app(self, org_id: str, kind: str, app_id: str) -> list:
        """Every live publish row of one app (the where/reverse index feed)."""
        return await self._deployment_backend().publish_of_app(org_id, kind, app_id)

    async def publish_list(self, org_id: str, kind: str, audiences: list) -> list:
        """Every live publish row matching ANY audience, across apps."""
        return await self._deployment_backend().publish_list(org_id, kind, audiences)

    async def publish_set_state(
        self, org_id: str, kind: str, app_id: str, audience: dict, state: str, actor: dict
    ) -> dict:
        """Flip one publish row's serving state (approve/disable/remove)."""
        return await self._deployment_backend().publish_set_state(org_id, kind, app_id, audience, state, actor)

    # ── Seeding — platform built-ins from apps.json (both editions) ──────────

    async def seed_app(self, org_id: str, entry: dict, actor: dict) -> dict:
        """Mint one apps.json entry as a pre-approved rail version + bundle copy.

        The edition-neutral primitive: registers the seed artifact (born
        'ready') and copies the built bundle into the store beside it.
        Binding the version to an audience is the caller's job — each
        edition records visibility its own way (SaaS: DB rows via the pod
        deploy tool; OSS: the meta file via its init sequence).
        """
        from .seed_apps import seed_app

        return await seed_app(self, org_id, entry, actor)

    async def seed_apps_from_manifest(self, org_id: str, actor: dict, *, force: bool = False, seed_entry=None) -> dict:
        """Walk apps.json and register every absent platform app (idempotent).

        ``seed_entry`` lets an edition wrap the per-entry step (SaaS adds
        billing/fleet-repoint); defaults to the shared seed_manifest_app.
        Returns ``{total, seeded, skipped, failed}`` counts.
        """
        from .seed_apps import seed_apps_from_manifest

        return await seed_apps_from_manifest(self, org_id, actor, force=force, seed_entry=seed_entry)

    async def deployments_history_append(
        self, org_id: str, project_id: str, action: str, actor: dict, version: int = None, data: dict = None
    ) -> None:
        """Append one bare event to a project's history stream.

        The review/comms thread writer: 'request', 'approved', 'rejected',
        'reply' rows ride the same stream as the machine audit — ``data``
        carries the human payload (message, side, notes).
        """
        await self._deployment_backend().history_append(org_id, project_id, action, actor, version=version, data=data)

    async def deployments_set_state(self, org_id: str, team_id: str, project_id: str, state: str, actor: dict) -> dict:
        """Enable/disable/error/soft-remove a team deployment."""
        return await self._deployment_backend().set_state(org_id, team_id, project_id, state, actor)

    async def deployments_schedule_set(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        source_id: str,
        cron: 'str | None',
        actor: dict,
        ttl: 'int | None' = None,
    ) -> dict:
        """Set (or clear with cron=None) one source's schedule.

        The paused flag is untouched (preserved on edit, False on create) —
        ``deployments_schedule_set_paused`` owns it.
        """
        return await self._deployment_backend().schedule_set(org_id, team_id, project_id, source_id, cron, actor, ttl)

    async def deployments_source_config_set(
        self,
        org_id: str,
        team_id: str,
        project_id: str,
        source_id: str,
        trace_level: 'str | None',
        debug_out: bool,
        actor: dict,
    ) -> dict:
        """Set one source's execution settings (trace level + debug output)."""
        return await self._deployment_backend().source_config_set(
            org_id, team_id, project_id, source_id, trace_level, debug_out, actor
        )

    async def deployments_schedule_set_paused(
        self, org_id: str, team_id: str, project_id: str, source_id: str, paused: bool, actor: dict
    ) -> dict:
        """Pause or resume one source's schedule, preserving cron/ttl."""
        return await self._deployment_backend().schedule_set_paused(
            org_id, team_id, project_id, source_id, paused, actor
        )

    async def deployments_mark_run(self, org_id: str, team_id: str, project_id: str, source_id: str) -> None:
        """Stamp lastRunAt after the scheduler fires a source (best-effort)."""
        await self._deployment_backend().mark_run(org_id, team_id, project_id, source_id)

    async def deployments_list(self, org_id: str, team_id: 'str | None' = None) -> list:
        """Non-removed deployments joined with registry info.

        ``team_id`` scopes to one team (or a ``user~`` personal space);
        None returns the WHOLE org — every team and every personal space.
        Mechanical by design: visibility slicing is the command layer's.
        """
        return await self._deployment_backend().list_team(org_id, team_id)

    async def deployments_get(self, org_id: str, team_id: str, project_id: str) -> 'dict | None':
        """One team deployment (joined with registry info), or None."""
        return await self._deployment_backend().get(org_id, team_id, project_id)

    async def deployments_versions(self, org_id: str, project_id: str) -> list:
        """The registry entries for a project, newest first (version strip)."""
        return await self._deployment_backend().versions(org_id, project_id)

    async def deployments_history(
        self, org_id: str, project_id: str, team_id: 'str | None' = None, list_args: 'dict | None' = None
    ) -> dict:
        """The audit trail as a list-API envelope, newest (seq) first.

        ``list_args`` is the standard list-API argument set (page/page_size/
        search/filters/sort). Paging lives in the BACKEND because history is
        unbounded by design (append-only enterprise audit): the SaaS backend
        pages in SQL rather than materializing the whole trail.
        """
        return await self._deployment_backend().history(org_id, project_id, team_id, list_args)

    async def deployments_artifact(self, org_id: str, project_id: str, version: int) -> dict:
        """Load one artifact version, sha256-verified against the registry."""
        return await self._deployment_backend().artifact(org_id, project_id, version)

    def deployments_iter_enabled(self):
        """Async-generate every ENABLED team deployment (the scheduler feed)."""
        return self._deployment_backend().iter_enabled()

    # =========================================================================
    # DAP COMMAND DISPATCH — SaaS overrides all of these
    # =========================================================================

    async def handle_account(self, conn, request):
        """
        Dispatch an ``rrext_account_*`` DAP command to the account handler.

        OSS raises NotImplementedError — account management requires SaaS.
        The SaaS implementation delegates to ``account_handler.handle()``.

        Args:
            conn:    ``TaskConn`` instance — provides ``_account_info``,
                     ``build_response()``, ``require_zitadel_auth()``, etc.
            request: Raw DAP request dict.
        """
        raise NotImplementedError('Account management requires SaaS mode')

    async def handle_saas(self, conn, request):
        """
        Dispatch an ``rrext_saas`` platform-admin DAP command.

        OSS raises NotImplementedError — the uniform edition signal, not the
        bare AttributeError a missing method would leak. The SaaS
        implementation delegates to ``saas_handler.handle()``.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        raise NotImplementedError('SaaS administration requires SaaS mode')

    async def handle_billing_rates(self, conn, request):
        """
        Dispatch an ``rrext_billing_rates`` DAP command (deprecated surface).

        OSS raises NotImplementedError — there is no billing backend
        standalone. The SaaS implementation overrides this method.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        raise NotImplementedError('Billing rates require SaaS mode')

    async def handle_app(self, conn, request):
        """
        Dispatch an app-family DAP command to the app/catalog handler.

        The catalog READ surface (``rrext_app`` list/get) is served on BOTH
        editions with one shape, so clients never branch per edition: this
        base implementation answers from the same scope walk the login
        assembly uses, decorated by ``decorate_desktop`` exactly as OSS login
        decorates (``appStatus: 'free'``, ``onDesktop`` from the user's
        stored desktop — the catalog and the handshake can never disagree).
        The desktop WRITES (``desktop_add`` / ``desktop_remove``) change the
        per-user desktop list and push the refreshed identity to the user's
        connections, as SaaS does (plan 9.1, B41). The rest of the catalog
        (``list_mine``/``admin_*``/``pricing_*`` — developer rails, the
        review ladder, Stripe) is genuinely SaaS-only and raises
        NotImplementedError. ``rrext_deploy_app`` is
        app deploy control on the shared deployments registry and works on both
        editions, with two subcommands special on OSS: ``developer_status``
        (answered from the session's org — OSS carries the fixed
        ``rocketride`` namespace) and the remaining ``developer_*`` verbs
        (developer-account / Stripe registration — SaaS only). Dev previews
        are LOCAL-FIRST: the dev server proxies the engine and preview pages
        register the app client-side, so the server holds no dev state.
        The SaaS implementation overrides this method entirely and delegates
        to ``app_handler.handle()``.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        command = request.get('command')
        sub = (request.get('arguments', {}) or {}).get('subcommand') or ''
        if command == 'rrext_deploy_app':
            # Namespace status is readable on both editions — the session
            # already carries the org's developerId ('rocketride' on OSS), so
            # the App Builder's DEPLOY page can render without a SaaS lookup.
            # Same body shape as the SaaS handler; OSS has no Stripe Connect.
            if sub == 'developer_status':
                org = getattr(conn._account_info, 'organization', None)
                dev = org.get('developerId') if isinstance(org, dict) else getattr(org, 'developerId', None)
                return conn.build_response(
                    request,
                    body={
                        'developerId': dev,
                        'stripeAccountId': None,
                        'stripeAccountStatus': 'none',
                    },
                )
            # Developer-account / Stripe registration is SaaS-only.
            if sub.startswith('developer_'):
                raise NotImplementedError('Developer registration requires SaaS mode')
            # App publish control rides the shared deployments registry.
            from ai.account.app_deploy import handle_deploy_app

            return await handle_deploy_app(conn, request)

        # ── rrext_app: the catalog surface, OSS ──────────────────────────────
        args = request.get('arguments', {}) or {}
        info = getattr(conn, '_account_info', None)
        user_id = getattr(info, 'userId', None) if info else None
        org_id = self._org_id_of(info)

        if sub in ('list', 'get'):
            # The caller's reachable set — the SAME walk the login assembly
            # uses (public + the local team/user rails when authenticated;
            # public only when anonymous), so the picker sees @me/@team rows.
            if user_id:
                # AccountInfo carries ONE org (models.py); the walk wants a
                # list. The OSS override ignores it (registry-only), so this
                # exists for signature fidelity, not behaviour.
                org = getattr(info, 'organization', None)
                orgs = [org if isinstance(org, dict) else {'id': getattr(org, 'id', 'local')}] if org else []
                try:
                    apps = await self.get_apps_for_user(user_id, orgs)
                except InventoryUnavailableError:
                    # The registry did not answer: an empty answer for now,
                    # and NO first desktop written from the outage.
                    apps = []
                # OSS decoration — the login assembly's, so the catalog and
                # the handshake agree by construction.
                await self.decorate_desktop(user_id, org_id, apps, seed=bool(apps))
            else:
                # Anonymous: nothing is on a desktop and every action needs a
                # sign-in first (the SaaS catalog's anonymous shape).
                apps = await self.get_public_apps()
                for entry in apps:
                    entry['appStatus'] = 'auth'
                    entry['onDesktop'] = False
            # Shell-compatibility narrowing, shape parity with SaaS.
            shell = args.get('shell')
            if shell:
                apps = [a for a in apps if a.get('shells') is None or shell in (a.get('shells') or [])]
            if sub == 'get':
                app_id = args.get('appId', '')
                if not app_id:
                    return conn.build_error(request, 'appId is required')
                entry = next((a for a in apps if a.get('id') == app_id), None)
                if entry is None:
                    return conn.build_error(request, 'App not found')
                # No pricing backend on OSS — an empty price list, not an error.
                return conn.build_response(request, body={'app': entry, 'prices': []})
            return conn.build_response(request, body={'apps': apps})

        if sub in ('desktop_add', 'desktop_remove'):
            # The desktop writes: change the user's stored list, then push the
            # refreshed identity to every connection of the user (the SaaS
            # handler's shape — ``push_account_update`` after the row change).
            from .manifest_push import push_account

            app_id = args.get('appId', '')
            if not app_id:
                return conn.build_error(request, 'appId is required')
            if not user_id:
                return conn.build_error(request, 'Authentication required')
            # The gate: anything the caller's reachable catalog returns is
            # installable (publish visibility IS the access rule). The walk
            # runs OUTSIDE the desktop lock — on OSS it decorates through
            # ``desktop_app_ids``, which takes this same non-reentrant lock.
            # The read, the seed, the change and the write sit under the
            # lock, so two requests for one user cannot lose an update; the
            # identity push follows the write.
            org = getattr(info, 'organization', None)
            orgs = [org if isinstance(org, dict) else {'id': getattr(org, 'id', 'local')}] if org else []
            try:
                reachable = [a.get('id') for a in await self.get_apps_for_user(user_id, orgs)]
            except InventoryUnavailableError:
                # No gate without the registry — and no first desktop written
                # from an outage either.
                return conn.build_error(request, 'The app catalog is unavailable; try again.')
            if sub == 'desktop_add' and app_id not in reachable:
                return conn.build_error(request, 'App not found')
            async with self._desktop_lock(org_id, user_id):
                desktop = await self._desktop_ids_unlocked(user_id, org_id, reachable)
                changed = [*desktop, app_id] if sub == 'desktop_add' else [a for a in desktop if a != app_id]
                changed = list(dict.fromkeys(changed))
                if changed != desktop:
                    await self._desktop_backend().write(org_id, user_id, changed)
            await push_account(conn._server, user_id)
            if sub == 'desktop_add':
                return conn.build_response(request, body={'added': True, 'appId': app_id})
            return conn.build_response(request, body={'removed': True, 'appId': app_id})

        raise NotImplementedError('App catalog administration requires SaaS mode')

    @staticmethod
    def _org_id_of(info) -> str:
        """
        The organization id a session's desktop belongs to.

        Args:
            info: The connection's ``AccountInfo`` (or None when anonymous).

        Returns:
            The org id; ``'local'`` when the session carries none (OSS).
        """
        org = getattr(info, 'organization', None) if info else None
        org_id = org.get('id') if isinstance(org, dict) else getattr(org, 'id', None)
        return str(org_id or 'local')

    async def handle_public(self, conn, request):
        """
        Dispatch an ``rrext_public_*`` DAP command.

        Available on both authenticated and unauthenticated connections.
        The ``rrext_public_probe`` command is handled directly by
        ``PublicCommands``; this method handles ``rrext_public_catalog``
        and any future public commands that need account-layer logic.

        OSS answers from the public publish rung, decorated for an
        authenticated caller with ``appStatus`` and the real ``onDesktop``
        (``decorate_desktop``) so the catalog picker needs no reconciliation;
        anonymous callers see ``appStatus: 'auth'`` and nothing on a desktop.
        SaaS queries the catalog DB with pagination and optional
        subscription overlay for authenticated callers.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        args = request.get('arguments') or {}
        offset = args.get('offset', 0)
        limit = min(args.get('limit', 20), 100)
        apps = await self.get_public_apps()
        info = getattr(conn, '_account_info', None)
        user_id = getattr(info, 'userId', None) if info else None
        if user_id:
            # The public rung is a SUBSET of what the caller can reach: a
            # first desktop seeded from it would leave the team-only apps
            # off, so the seed is the caller's whole reachable inventory.
            org = getattr(info, 'organization', None)
            orgs = [org if isinstance(org, dict) else {'id': getattr(org, 'id', 'local')}] if org else []
            try:
                inventory = [a.get('id') for a in await self.get_apps_for_user(user_id, orgs)]
                await self.decorate_desktop(user_id, self._org_id_of(info), apps, inventory)
            except InventoryUnavailableError:
                # The registry did not answer: membership from the stored
                # desktop (or none), and no first desktop written.
                await self.decorate_desktop(user_id, self._org_id_of(info), apps, seed=False)
        else:
            for entry in apps:
                entry['appStatus'] = 'auth'
                entry['onDesktop'] = False
        # Shell-compatibility narrowing, shape parity with SaaS.
        shell = args.get('shell')
        if shell:
            apps = [a for a in apps if a.get('shells') is None or shell in (a.get('shells') or [])]

        # Basic client-side pagination for OSS
        total = len(apps)
        page = apps[offset : offset + limit]

        return conn.build_response(
            request,
            body={
                'apps': page,
                'total': total,
                'offset': offset,
                'limit': limit,
            },
        )
