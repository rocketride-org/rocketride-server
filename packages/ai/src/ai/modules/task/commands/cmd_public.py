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

import os
import sys
from typing import TYPE_CHECKING, Dict, Any

from rocketlib import debug, getVersion
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

        Also carries the Stripe publishable key (``pk_*`` — public by
        design) when the server has one configured, so browser and
        extension clients receive the key matching THIS server's Stripe
        account instead of a value baked into their bundles at build time.

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
            # The server's public addresses. ALWAYS present, both keys, so no
            # client ever branches on absence: each value is an absolute URL
            # or the literal 'origin' = "the address you probed me at" (the
            # SDK substitutes it client-side; a server behind a proxy cannot
            # know its public name). Managed deployments declare both
            # explicitly; RR_BACKEND_ORIGIN only carries a real URL when the
            # API is reachable somewhere OTHER than where the UI is served
            # (CDN split) — clients then bypass the edge after this probe.
            'endpoints': {
                'api': os.environ.get('RR_BACKEND_ORIGIN', '').strip() or 'origin',
                'ui': os.environ.get('RR_FRONTEND_ORIGIN', '').strip() or 'origin',
            },
        }
        # Publishable key only — the secret key (sk_*) must never leave the
        # server. Omitted entirely when unset (OSS / no billing). Enforce the
        # pk_ prefix before returning: if a secret key (sk_*) or a restricted
        # key (rk_*) is misconfigured into this env var, publishing it to every
        # client would leak a server credential — refuse to emit it and warn.
        stripe_pk = os.environ.get('RR_STRIPE_PUBLISHABLE_KEY', '').strip()
        if stripe_pk.startswith('pk_'):
            info['stripePublishableKey'] = stripe_pk
        elif stripe_pk:
            debug('[public] RR_STRIPE_PUBLISHABLE_KEY is not a pk_ publishable key — omitting it from the public probe')
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
