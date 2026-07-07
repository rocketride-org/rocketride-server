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

    # =========================================================================
    # DAP COMMAND DISPATCH — SaaS overrides all three
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

    async def handle_app(self, conn, request):
        """
        Dispatch an ``rrext_app_*`` DAP command to the app/marketplace handler.

        OSS raises NotImplementedError — the app marketplace requires SaaS.
        The SaaS implementation delegates to ``app_handler.handle()``.

        Args:
            conn:    ``TaskConn`` instance.
            request: Raw DAP request dict.
        """
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
