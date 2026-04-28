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

  - ``rrext_account_me``      — user profile (get, update, set_default_team)
  - ``rrext_account_keys``    — API keys (list, create, revoke)
  - ``rrext_account_org``     — organisation (get, update)
  - ``rrext_account_members`` — org members (list, invite, update, remove)
  - ``rrext_account_teams``   — teams (list, create, delete, get, add/update/remove member)
  - ``rrext_account_billing`` — billing (credits_balance, credits_packs, credits_checkout,
                                         prices, get, checkout, portal, cancel)
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
