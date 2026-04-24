"""
BillingCommands: DAP Command Handler for Account Billing Operations.

This module implements the `rrext_account_billing` DAP command as a
first-class member of the `TaskConn` inheritance chain, rather than
monkey-patching handlers on at runtime. The OSS build ships a stub that
reports `not_configured` for every subcommand; SaaS builds override this
file via the `ai/account` overlay to plug in the real wallet /
subscription / checkout flows.

Why a stub in OSS:
------------------
The RocketRide frontend (cloud-ui) issues `rrext_account_billing`
requests whenever a user opens the billing page, picks a credit pack,
cancels a subscription, etc. Without a class-level handler the DAP
dispatcher would silently succeed with an empty body, leaving the UI
in a half-rendered state. A stub that explicitly returns
`{"success": False, "message": "billing not configured"}` gives the
frontend something unambiguous to branch on and keeps OSS deployments
functional when no billing backend is wired up.

Subcommands:
------------
- `credits_balance`  — per-org compute-credit wallet balance
- `credits_packs`    — purchasable credit packs (from Stripe catalog)
- `credits_checkout` — one-off Stripe Checkout session for a credit pack
- `prices`           — plans available for a Stripe product
- `get`              — per-org app subscription rows
- `checkout`         — create a Stripe subscription for an app
- `portal`           — Stripe Billing Portal session URL
- `cancel`           — schedule subscription cancellation at period end

The SaaS overlay replaces this file with one that delegates to the
`Account` / `Billing` facades in `ai.account.auth`.
"""

from typing import TYPE_CHECKING, Any, Dict

from ai.common.dap import DAPConn, TransportBase

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


# Subcommands recognised by the handler contract. The stub accepts every
# name here so `success=False` is distinguishable from `unknown subcommand`,
# but each returns `not_configured` when no real backend is present.
_KNOWN_SUBCOMMANDS = frozenset({
    # Compute credits wallet
    'credits_balance',
    'credits_packs',
    'credits_checkout',
    # Per-app subscription lifecycle
    'prices',
    'get',
    'checkout',
    'portal',
    'cancel',
})


class BillingCommands(DAPConn):
    """
    DAP command handler for account-billing operations.

    The OSS class is a no-op stub: every call returns
    `{"success": False, "message": "billing not configured", "code":
    "not_configured"}`. SaaS deployments supply a replacement via the
    existing `packages/ai/src/ai/account/` overlay that overrides this
    file at build time with one that delegates to the Billing facade.

    Attributes:
        _server: Reference to the TaskServer for context
        connection_id: Unique identifier for this DAP connection
        transport: Underlying transport mechanism for DAP communication
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialise a new BillingCommands mixin.

        Args match every other DAP command mixin in the TaskConn chain.
        Note that TaskConn initializes each mixin explicitly (see
        task_conn.py) rather than relying on cooperative MRO; this
        constructor deliberately does not call ``super().__init__`` to
        avoid double-initialising DAPConn. Args are accepted for
        signature parity but dropped on the OSS stub — the SaaS overlay
        subclass is where real per-connection state lives.

        Args:
            connection_id: Unique identifier for this DAP connection.
            server: TaskServer instance for context + utilities.
            transport: Transport layer for DAP messaging.
            **kwargs: Accepted for signature parity with sibling mixins.
        """
        # All state sits on TaskConn via the other mixins; nothing specific
        # to billing needs to exist on the OSS stub.
        del connection_id, server, transport, kwargs  # unused on OSS stub

    async def on_rrext_account_billing(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_account_billing' — stub implementation.

        The OSS build has no billing backend. Every subcommand returns a
        structured "not configured" response so the frontend can branch
        on `code='not_configured'` and render a graceful empty state
        rather than hanging or throwing.

        Args:
            request: DAP request with `arguments.subcommand` selecting
                     the operation plus subcommand-specific arguments.

        Returns:
            DAP response. Always `success=False` on OSS.

        Usage Example:
            { "command": "rrext_account_billing",
              "arguments": { "subcommand": "credits_balance",
                             "orgId": "..." } }
        """
        # Harden against malformed requests — a non-dict `arguments`
        # (bug in a client, someone poking the wire by hand) or a
        # non-hashable `subcommand` would otherwise crash the handler
        # with AttributeError / TypeError before reaching the structured
        # error response. Normalise both and fall through to the
        # `unknown_subcommand` branch with a repr() for diagnosis.
        args = request.get('arguments') or {}
        if not isinstance(args, dict):
            args = {}

        subcommand = args.get('subcommand', '')
        if not isinstance(subcommand, str):
            subcommand = repr(subcommand)

        if subcommand not in _KNOWN_SUBCOMMANDS:
            # Unknown subcommand — use build_error so the DAP envelope-
            # level `success` field is False. build_response would emit
            # `success: true` at the envelope, making generic clients
            # that only check the top-level field miss the failure.
            # A structured body is attached for clients that *do* want
            # to distinguish "typo" from "backend not wired up".
            message = f'unknown rrext_account_billing subcommand: {subcommand!r}'
            response = self.build_error(request, message)
            response['body'] = {
                'code':       'unknown_subcommand',
                'subcommand': subcommand,
                'message':    message,
            }
            return response

        # Known subcommand, no backend to dispatch it to — signal
        # "not_configured" with DAP-level failure. The SaaS overlay
        # replaces this class entirely and never hits this path.
        message = 'billing not configured on this deployment'
        response = self.build_error(request, message)
        response['body'] = {
            'code':       'not_configured',
            'subcommand': subcommand,
            'message':    message,
        }
        return response
