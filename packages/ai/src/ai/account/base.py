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

import os
from abc import ABC, abstractmethod


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

    def generate_token(self, content: dict, prefix: str = '') -> str:
        """
        Generate a deterministic SHA-256 token from a content dict.

        Args:
            content: JSON-serialisable dict; keys are sorted for determinism.
            prefix:  Optional string prepended to the 32-char hex digest
                     (e.g. ``'pk_'``, ``'tk_'``).

        Returns:
            ``f'{prefix}{sha256_hex[:32]}'``
        """
        import hashlib
        import json

        raw = json.dumps(content, sort_keys=True).encode('utf-8')
        return f'{prefix}{hashlib.sha256(raw).hexdigest()[:32]}'

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
        user_id: str,
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
            user_id:         User whose task triggered the burn (required for attribution).
            team_id:         Team the task belongs to (None when task has no team scope).
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

    # NOTE: fire-time billing resolution (resolve_billing_team) is GONE by
    # doctrine — billing is ABSOLUTE, stamped onto every publish at pointer
    # time (deployments_deploy billing_team_id) and only ever read by runs.

    # =========================================================================
    # CLOUD DATABASE — env-gated broker call; raises when unconfigured
    # =========================================================================

    async def resolve_db_dsn(self, client_id: str) -> str:
        """
        Resolve the per-tenant database DSN for the RocketRide cloud DB nodes.

        The ``rocketride_sql`` / ``rocketride_vector`` / ``rocketride_graph``
        nodes take no connection configuration.  Instead of reading
        host/user/password, they resolve a ready connection string for the
        caller's own provisioned cloud database, keyed by the authenticated
        ``client_id`` (``userId``).  One database per tenant backs all three.

        Default implementation (both editions): call the data-core provisioner
        configured via server-side environment —

            ROCKETRIDE_DB_BROKER_URL    the /provision endpoint URL
            ROCKETRIDE_DB_BROKER_TOKEN  its Bearer token (from ASM/k8s; never
                                        hardcoded)

        ``POST {url} {"tenant_id": client_id}`` -> ``{"database", "role",
        "dsn", "created"}`` (only ``dsn`` is read here).
        The endpoint is idempotent (same tenant -> same DSN; the per-tenant
        password is derived, not stored), so this method is safe to call on
        every task start with no caching or persistence on this side.

        When the environment is not configured (the open-source default), this
        raises: the cloud databases require a RocketRide cloud deployment.
        A SaaS overlay may still override this method entirely.

        Args:
            client_id: The authenticated connection identity (``userId``).
                Passed verbatim as the broker's ``tenant_id`` (the provisioner
                owns slugging/hashing it into a database name).

        Returns:
            A libpq/SQLAlchemy-compatible PostgreSQL DSN for the tenant DB
            (e.g. ``postgresql://role:pass@pooler:5432/t_<slug>?sslmode=require``).

        Raises:
            NotImplementedError: broker environment not configured.
            RuntimeError: the broker rejected the request or returned no DSN.
        """
        broker_url = os.environ.get('ROCKETRIDE_DB_BROKER_URL', '').strip()
        broker_token = os.environ.get('ROCKETRIDE_DB_BROKER_TOKEN', '').strip()
        if not broker_url or not broker_token:
            raise NotImplementedError('RocketRide cloud DB nodes require signing into RocketRide cloud')
        if not client_id or not client_id.strip():
            raise ValueError('resolve_db_dsn requires a non-empty client_id')
        self._check_broker_url(broker_url)

        import asyncio

        return await asyncio.to_thread(self._call_db_broker, broker_url, broker_token, client_id.strip())

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
    def _call_db_broker(url: str, token: str, tenant_id: str) -> str:
        """Blocking POST to the provisioner; runs in a worker thread.

        Stdlib-only on purpose: the account layer has no async-HTTP dependency,
        and one small request per task start does not justify adding one.
        """
        import json
        import urllib.error
        import urllib.request

        request = urllib.request.Request(
            url,
            data=json.dumps({'tenant_id': tenant_id}).encode('utf-8'),
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
            raise RuntimeError(f'DB broker rejected provision for this account (HTTP {e.code})') from e
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
    ) -> dict:
        """Create or repoint one audience's binding (pure pointer, born enabled)."""
        return await self._deployment_backend().publish_set(org_id, kind, app_id, audience, version, snapshot, actor)

    async def set_artifact_state(self, org_id: str, project_id: str, version: int, new_state: str, actor: dict) -> dict:
        """Transition one deployment's review state (submit/approve/reject)."""
        return await self._deployment_backend().set_artifact_state(org_id, project_id, version, new_state, actor)

    async def deployments_set_build(self, org_id: str, project_id: str, version: int, build: dict) -> dict:
        """Replace one registry version's metadata.build blob (build worker)."""
        return await self._deployment_backend().set_build(org_id, project_id, version, build)

    async def deployments_scan_builds(self, statuses: tuple) -> list:
        """Every kind:'app' version whose build status matches (restart requeue)."""
        return await self._deployment_backend().scan_builds(statuses)

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
        Dispatch an app-family DAP command to the app/marketplace handler.

        The ``rrext_app`` marketplace surface (browse/install/admin/pricing)
        requires SaaS — OSS raises NotImplementedError. ``rrext_deploy_app`` is
        app deploy control on the shared deployments registry and works on both
        editions, with three subcommands special on OSS: ``register_dev`` (the
        per-user dev overlay — platform infrastructure so local app development
        works without SaaS), ``developer_status`` (answered from the session's
        org — OSS carries the fixed ``rocketride`` namespace), and the
        remaining ``developer_*`` verbs (developer-account / Stripe
        registration — SaaS only). The SaaS implementation overrides this
        method entirely and delegates to ``app_handler.handle()``.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        command = request.get('command')
        sub = (request.get('arguments', {}) or {}).get('subcommand') or ''
        if command == 'rrext_deploy_app':
            # Dev overlay: shared platform capability (not marketplace).
            if sub == 'register_dev':
                from ai.account.dev_overlay import handle_register_dev

                return await handle_register_dev(conn, request)
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
        raise NotImplementedError('App marketplace requires SaaS mode')

    async def handle_public(self, conn, request):
        """
        Dispatch an ``rrext_public_*`` DAP command.

        Available on both authenticated and unauthenticated connections.
        The ``rrext_public_probe`` command is handled directly by
        ``PublicCommands``; this method handles ``rrext_public_catalog``
        and any future public commands that need account-layer logic.

        OSS returns the static apps.json catalog.
        SaaS queries the marketplace DB with pagination and optional
        subscription overlay for authenticated callers.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
        # Default OSS implementation: return public apps from static manifest
        args = request.get('arguments') or {}
        offset = args.get('offset', 0)
        limit = min(args.get('limit', 20), 100)
        apps = await self.get_public_apps()

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
