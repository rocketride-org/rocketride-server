# MIT License
# Copyright (c) 2026 Aparavi Software AG

# =============================================================================
# ACCOUNT BASE
# Abstract base class defining the full Account interface.
# =============================================================================

from abc import ABC, abstractmethod


class AccountBase(ABC):
    """
    Abstract interface for the RocketRide Account facade.

    Two concrete implementations exist:
      - ``account/oss/``  — API-key auth against ROCKETRIDE_APIKEY
      - ``extension/saas/`` — Zitadel + DB auth; full account management
    """

    capabilities: tuple[str, ...] = ()

    @abstractmethod
    async def authenticate(self, credential: str):
        """Authenticate a raw credential string and return an AccountInfo or error tuple."""
        ...

    def generate_token(self, content: dict, prefix: str = '') -> str:
        """
        Generate a non-deterministic token from a content dict.

        Fix F-10: a cryptographically random 16-byte salt is mixed into the
        hash input so that two calls with identical content dicts produce
        different tokens, preventing pre-computation attacks.

        Args:
            content: JSON-serialisable dict; keys are sorted for stability.
            prefix:  Optional string prepended to the hex digest
                     (e.g. ``'pk_'``, ``'tk_'``).

        Returns:
            ``f'{prefix}{sha256_hex}'`` (64 hex chars, 256 bits of entropy).
        """
        import hashlib
        import json
        import os

        # Random salt makes the token non-deterministic and non-guessable.
        salt = os.urandom(16).hex()
        raw = (salt + json.dumps(content, sort_keys=True)).encode('utf-8')
        return f'{prefix}{hashlib.sha256(raw).hexdigest()}'

    async def init_account(self, server) -> None:
        """Register HTTP routes and run async startup work. OSS no-op."""
        pass

    async def handle_account(self, conn, request):
        """Dispatch an rrext_account_* DAP command. OSS raises NotImplementedError."""
        raise NotImplementedError('Account management requires SaaS mode')

    async def handle_app(self, conn, request):
        """Dispatch an rrext_app_* DAP command. OSS raises NotImplementedError."""
        raise NotImplementedError('App marketplace requires SaaS mode')
