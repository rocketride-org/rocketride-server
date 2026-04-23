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
# CMD APP — thin DAP router for all rrext_app_* commands
#
# Every on_rrext_app_* method is a one-liner that delegates to
# account.handle_app(conn, request). The SaaS implementation of handle_app
# (in account/saas/app_handler.py) contains the real marketplace logic;
# the OSS base raises NotImplementedError since the marketplace requires SaaS.
# =============================================================================

"""
AppCommands: thin DAP router for all ``rrext_app_*`` commands.

Exposes five command groups to the DAP dispatcher; each is a one-liner
delegating to ``account.handle_app(conn, request)``:

  - ``rrext_app_developer``  — developer registration + Stripe Connect
  - ``rrext_app_submission`` — app draft + bundle publish
  - ``rrext_app_catalog``    — marketplace listing + search
  - ``rrext_app_admin``      — platform admin approve/reject
  - ``rrext_app_pricing``    — pricing tier management
"""

from typing import TYPE_CHECKING, Dict, Any

from ai.common.dap import DAPConn, TransportBase
from ai.account import account

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# APP COMMANDS MIXIN
# =============================================================================


class AppCommands(DAPConn):
    """
    Thin DAP router that dispatches all ``rrext_app_*`` commands to the
    account singleton's ``handle_app`` method.

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

    # ── rrext_app_developer ──────────────────────────────────────────────────

    async def on_rrext_app_developer(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_app_developer`` to the app handler."""
        return await account.handle_app(self, request)

    # ── rrext_app_submission ─────────────────────────────────────────────────

    async def on_rrext_app_submission(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_app_submission`` to the app handler."""
        return await account.handle_app(self, request)

    # ── rrext_app_catalog ────────────────────────────────────────────────────

    async def on_rrext_app_catalog(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_app_catalog`` to the app handler."""
        return await account.handle_app(self, request)

    # ── rrext_app_admin ──────────────────────────────────────────────────────

    async def on_rrext_app_admin(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_app_admin`` to the app handler."""
        return await account.handle_app(self, request)

    # ── rrext_app_pricing ────────────────────────────────────────────────────

    async def on_rrext_app_pricing(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_app_pricing`` to the app handler."""
        return await account.handle_app(self, request)
