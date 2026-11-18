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
# CMD ACCOUNT — thin DAP router for all rrext_account_* commands
#
# Every on_rrext_account_* method is a one-liner that delegates to
# account.handle_account(conn, request). The SaaS implementation of
# handle_account (in account/saas/account_handler.py) contains the real
# business logic; the OSS base raises NotImplementedError for management
# commands (account management requires SaaS mode).
#
# This includes rrext_account_billing — it is an rrext_account_* command
# and belongs here, not in a separate BillingCommands mixin.
# =============================================================================

"""
AccountCommands: thin DAP router for all ``rrext_account_*`` commands.

Exposes six command groups to the DAP dispatcher; each is a one-liner
delegating to ``account.handle_account(conn, request)``:

  - ``rrext_account_me``      — user profile (get, update, set_dev_team)
  - ``rrext_account_keys``    — API keys (list, create, revoke)
  - ``rrext_account_org``     — organisation (get, update)
  - ``rrext_account_members`` — org members (list, invite, update, remove)
  - ``rrext_account_teams``   — teams (list, create, delete, get, add/update/remove member)
  - ``rrext_account_billing`` — billing (credits_balance, credits_packs, credits_checkout,
                                         prices, get, checkout, portal, cancel)

One command answers here instead of in ``handle_account``:

  - ``rrext_account_status``  — whether the caller's own account can run
                                pipelines now (both editions, waitlisted too)
"""

from typing import TYPE_CHECKING, Dict, Any

from ai.common.dap import DAPConn, TransportBase
from ai.account import account

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# ACCOUNT COMMANDS MIXIN
# =============================================================================


class AccountCommands(DAPConn):
    """
    Thin DAP router that dispatches all ``rrext_account_*`` commands to the
    account singleton's ``handle_account`` method.

    The ``conn`` (``TaskConn`` instance) is passed through so SaaS handlers
    have full access to ``_account_info``, ``build_response()``,
    ``require_zitadel_auth()``, and the rest of the DAP connection API.
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """No-op — all state lives on TaskConn via the other mixins."""
        pass

    # ── rrext_account_me ─────────────────────────────────────────────────────

    async def on_rrext_account_me(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_me`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_account_status ─────────────────────────────────────────────────

    async def on_rrext_account_status(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Report whether the caller's own account can run pipelines right now.

        It takes no arguments and answers for this connection's identity only,
        so nobody can ask about another user, org or team. Unlike the commands
        ``handle_account`` serves, it answers a waitlisted account too: telling
        that account why it can't run is the point. The body holds names,
        flags and a token balance, never a credential, a key value or an id.
        A read that fails comes back as ``None`` rather than failing the
        command.
        """
        info = self._account_info
        if not info:
            raise PermissionError('Not authenticated')

        capabilities = list(getattr(info, 'capabilities', None) or [])
        cloud = 'saas' in capabilities
        waitlisted = bool(getattr(info, 'waitlisted', False))
        org = getattr(info, 'organization', None)
        org = org if isinstance(org, dict) else {}
        org_id = org.get('id') or ''
        user_id = getattr(info, 'userId', '') or ''

        # The development team runs are billed to, and whether this caller may
        # start one there (execute checks task.control on the same team).
        team_id = getattr(info, 'devTeam', '') or ''
        team_name = next((t.get('name') or '' for t in org.get('teams') or [] if t.get('id') == team_id), '')
        can_run = False
        if team_id:
            try:
                self.verify_team_permission(team_id, 'task.control')
                can_run = True
            except PermissionError:
                can_run = False
            # A run is billed to the org that owns the dev team, which execute
            # resolves the same way; for an identity whose dev team sits outside
            # its own org (sys.admin), that is not the identity's org.
            if not waitlisted:
                try:
                    org_id = await self.resolve_org_for_team(team_id) or org_id
                except PermissionError:
                    pass

        # Compute tokens exist only on the hosted backend. A waitlisted account,
        # or one with no org, has no balance to read; ``reason`` says which, so
        # the caller knows whether asking again can help. ``tokens`` is the raw
        # ledger balance. ``canSpend`` is the backend's spend check, which may
        # answer from a cache a few seconds old.
        if not cloud:
            credits: Dict[str, Any] = {'applies': False}
        else:
            credits = {'applies': True, 'canSpend': None, 'tokens': None}
            if waitlisted:
                credits['reason'] = 'waitlisted'
            elif not org_id:
                credits['reason'] = 'noOrganization'
            else:
                try:
                    refusal = await account.check_spend(org_id)
                    balance = await account.get_credit_balance(org_id)
                    tokens = float(((balance or {}).get('balances') or {}).get('tokens', 0.0))
                    credits = {'applies': True, 'canSpend': refusal is None, 'tokens': tokens}
                except Exception as exc:  # noqa: BLE001 - unknown, not "empty"
                    credits['reason'] = 'readFailed'
                    self.debug_message(f'rrext_account_status: credit read failed ({type(exc).__name__})')

        # Variable names the caller's runs would see, never their values.
        env_keys = None
        if not waitlisted:
            try:
                merged = await account.get_merged_env(user_id=user_id, org_id=org_id, team_id=team_id or None)
                env_keys = sorted(merged)
            except Exception as exc:  # noqa: BLE001 - unknown, not "empty"
                self.debug_message(f'rrext_account_status: variable read failed ({type(exc).__name__})')

        body = {
            'edition': 'cloud' if cloud else 'self-hosted',
            'waitlisted': waitlisted,
            'organization': {'name': org.get('name') or ''} if org else None,
            'devTeam': {'selected': bool(team_id), 'name': team_name, 'canRun': can_run},
            'credits': credits,
            'envKeys': env_keys,
            'capabilities': capabilities,
        }
        return self.build_response(request, body=body)

    # ── rrext_account_keys ───────────────────────────────────────────────────

    async def on_rrext_account_keys(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_keys`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_account_org ────────────────────────────────────────────────────

    async def on_rrext_account_org(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_org`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_account_members ────────────────────────────────────────────────

    async def on_rrext_account_members(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_members`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_account_teams ──────────────────────────────────────────────────

    async def on_rrext_account_teams(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_teams`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_account_billing ────────────────────────────────────────────────

    async def on_rrext_account_billing(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_account_billing`` to the account handler."""
        return await account.handle_account(self, request)

    # ── rrext_saas ──────────────────────────────────────────────────────────

    async def on_rrext_saas(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_saas`` to the SaaS admin handler."""
        return await account.handle_saas(self, request)

    # ── rrext_billing_rates ─────────────────────────────────────────────────

    async def on_rrext_billing_rates(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_billing_rates`` to the billing rates handler (deprecated)."""
        return await account.handle_billing_rates(self, request)
