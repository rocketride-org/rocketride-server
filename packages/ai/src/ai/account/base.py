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
