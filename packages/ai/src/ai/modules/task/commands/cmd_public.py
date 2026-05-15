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
# CMD PUBLIC — DAP router for rrext_public_* commands
#
# These commands bypass the auth gate (task_conn.on_receive allows any
# command whose name starts with 'rrext_public_'). They are available on
# both authenticated and unauthenticated connections.
#
#   - rrext_public_probe   — server metadata (replaces the infoOnly auth hack)
#   - rrext_public_catalog — browse the app catalog with pagination/filtering
# =============================================================================

"""
PublicCommands: DAP router for ``rrext_public_*`` commands.

Available before authentication — the server's prefix-based gate allows
any command starting with ``rrext_public_`` without requiring a prior
``auth`` handshake. This enables unauthenticated app catalog browsing
and server probing.
"""

import sys
from typing import TYPE_CHECKING, Dict, Any

from rocketlib import getVersion
from ai.common.dap import DAPConn, TransportBase
from ai.account import account

if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# PUBLIC COMMANDS MIXIN
# =============================================================================


class PublicCommands(DAPConn):
    """
    DAP router for ``rrext_public_*`` commands.

    These are available on both authenticated and unauthenticated connections.
    The ``conn`` (``TaskConn`` instance) is passed through so handlers can
    check ``_authenticated`` to optionally enrich responses for logged-in users.
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

    # ── rrext_public_probe ──────────────────────────────────────────────────

    async def on_rrext_public_probe(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Return server metadata without requiring authentication.

        Replaces the former ``auth { infoOnly: true }`` hack. Returns
        version, capabilities, platform, and public apps list.

        Args:
            request: Raw DAP request dict.

        Returns:
            DAP response with server info in the body.
        """
        acct = self._server._server.account
        info = {
            'version': getVersion(),
            'capabilities': acct.capabilities,
            'platform': sys.platform,
            'apps': await acct.get_public_apps(),
        }
        return self.build_response(request, body=info)

    # ── rrext_public_catalog ────────────────────────────────────────────────

    async def on_rrext_public_catalog(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Browse the app catalog with pagination and filtering.

        Available to both authenticated and unauthenticated connections.
        When authenticated, the response is enriched with subscription
        status per app.

        Delegates to ``account.handle_public()`` which contains the
        SaaS catalog logic. OSS returns the static apps.json list.

        Args:
            request: Raw DAP request dict with optional arguments:
                action (str): "list" or "get" (default "list")
                offset (int): pagination offset (default 0)
                limit (int): page size (default 20, max 100)
                search (str): name/description substring filter
                category (str): category filter
                shell (str): shell compatibility filter
                appId (str): specific app ID (for "get" action)

        Returns:
            DAP response with ``{ apps, total, offset, limit }`` in the body.
        """
        return await account.handle_public(self, request)
