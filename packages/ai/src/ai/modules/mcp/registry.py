# Copyright 2026 Aparavi Software AG. MIT License.
"""Server-owned task registry.

The RocketRide SDK has no client-side task registry: ``use()`` returns a
control id in its token slot and the task address beside it, and
enumerate/terminate/monitor across separate tool calls need somewhere to
keep ``{address -> instance + metadata}``. This is a plain in-memory dict,
scoped to a single asyncio event loop (one process, one persistent
``RocketRideClient``) — it is NOT thread-safe and must not be shared across
event loops or accessed concurrently from multiple threads.

Entries are keyed by the task ADDRESS (``developerId.pipelineId.source``,
stable across runs) and carry the INSTANCE: the control id ``use()`` minted
for this run (plan section 1, C.22). Every MCP verb names the control id in
its ``address`` argument, so ``get``/``remove`` find an entry by either
handle.

The registry is also where the dropper widget's upload nonces live (plan
3.7): ``run_dropper_pipe`` mints a one-time nonce bound to the task instance
it just started and to the caller credential the tool call ran under, and
the ``/mcp/upload/{nonce}`` route consumes it. A nonce is valid only while
its INSTANCE is the one tracked at that address -- a fresh launch at the
same address (a new control id) drops the earlier run's nonces, ``remove``
(the ``terminate`` tool) and FIFO eviction drop them with the task, and a
replacement link is refused once the instance it was minted for is gone.
A run restarted or terminated OUTSIDE MCP never reaches this registry; the
route asks the engine whether the control id is still live at upload time
and drops that run's nonces when it is not (``drop_run_upload_nonces``).
"""

import secrets
from typing import Any, Dict, List, Optional

# Bound on registry size: entries leak when cleanup paths are skipped (a
# failed terminate, a client that stops mid-run and never polls monitor to
# a terminal state). The registry is advisory metadata — evicting the oldest
# entry never invalidates the engine-side task, it only drops bookkeeping —
# so a simple FIFO cap keeps a long-lived process bounded.
MAX_TASKS = 512

# Bound on live (unconsumed) nonces per task: every ``run_dropper_pipe`` call
# and every accepted upload mints one, so a caller re-running the tool with
# ``use_existing`` against the same task would otherwise grow the map
# unboundedly. The oldest nonce for that task is dropped first.
MAX_UPLOAD_NONCES_PER_TASK = 8


class TaskRegistry:
    """In-memory ``{address -> {'instance': control id, **metadata}}`` registry, FIFO-bounded at ``MAX_TASKS``.

    Single-event-loop use only; not thread-safe.
    """

    def __init__(self) -> None:
        self._tasks: Dict[str, Dict[str, Any]] = {}
        # nonce -> {'token': task address, 'instance': the control id it was
        #           minted for, 'caller_auth': credential or None}
        self._upload_nonces: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    def _address_of(self, handle: str) -> Optional[str]:
        """The address of the entry ``handle`` names: the address itself, or the instance (control id)."""
        if handle in self._tasks:
            return handle
        return next((address for address, entry in self._tasks.items() if entry.get('instance') == handle), None)

    def add(self, address: str, *, instance: str, **metadata: Any) -> None:
        """Register the run ``instance`` at ``address``, replacing any prior entry.

        At ``MAX_TASKS`` entries the oldest is evicted (dict preserves
        insertion order) so leaked tokens can't grow the process forever. An
        evicted task takes its upload nonces with it.

        The address is reused by every later run of the same project/source
        and the engine never tells this registry when a run expires, so the
        INSTANCE decides what a re-add means: the same control id (``use()``
        with ``use_existing`` attached to the live run) refreshes the entry
        and keeps its nonces; a different one is a new run, and the earlier
        run's nonces die with it -- they must never redeem into a run that
        is not the one they were minted for, carrying the earlier caller.

        Args:
            address: The task address (``use()``'s ``address``).
            instance: The control id of this run (``use()``'s token slot).
            **metadata: Advisory metadata stored with the entry.
        """
        previous = self._tasks.pop(address, None)  # re-add moves the entry to newest
        if previous is not None and previous.get('instance') != instance:
            self._drop_upload_nonces(address)
        while len(self._tasks) >= MAX_TASKS:
            evicted = next(iter(self._tasks))
            self._tasks.pop(evicted)
            self._drop_upload_nonces(evicted)
        self._tasks[address] = {'instance': instance, **metadata}

    def remove(self, handle: str) -> None:
        """Drop the entry ``handle`` names (address or control id) and its upload nonces. A no-op if absent."""
        address = self._address_of(handle)
        if address is None:
            return
        self._tasks.pop(address, None)
        self._drop_upload_nonces(address)

    def get(self, handle: str) -> Optional[Dict[str, Any]]:
        """Return ``{'token': address, 'instance': control id, **metadata}`` for ``handle``, or ``None``."""
        address = self._address_of(handle)
        if address is None:
            return None
        return {'token': address, **self._tasks[address]}

    def list(self) -> List[Dict[str, Any]]:
        """Return ``[{'token': address, 'instance': control id, **metadata}, ...]`` for every registered task."""
        return [{'token': address, **entry} for address, entry in self._tasks.items()]

    def instance_of(self, handle: str) -> Optional[str]:
        """The control id tracked for ``handle`` (address or control id), or ``None`` when untracked."""
        address = self._address_of(handle)
        return None if address is None else self._tasks[address]['instance']

    # ------------------------------------------------------------------
    # Upload nonces (plan 3.7)
    # ------------------------------------------------------------------

    def issue_upload_nonce(self, handle: str, caller_auth: Optional[str], *, instance: Optional[str] = None) -> str:
        """Mint a one-time upload nonce for the tracked task ``handle`` names.

        The nonce is bound to the task INSTANCE (the control id tracked at
        that address when it is minted) AND to ``caller_auth`` -- the
        credential the minting tool call ran under (``identity.CALLER_AUTH``;
        ``None`` on the shared-client path) -- so the upload route can
        forward the bytes into that run as that caller. Only a tracked task
        can carry a nonce: the route must never accept an upload into a task
        this registry has already let go.

        Args:
            handle: The task address or its control id, already registered via ``add``.
            caller_auth: The caller credential to forward the upload with.
            instance: When given (a replacement link for a redeemed nonce),
                the control id that nonce was minted for; the link is refused
                when a fresh launch has since taken the address over, since
                it would carry the earlier caller into the new run.

        Returns:
            str: The URL-safe nonce.

        Raises:
            KeyError: nothing is tracked for ``handle``, or ``instance`` is
                not the control id tracked there.
        """
        address = self._address_of(handle)
        if address is None:
            raise KeyError(handle)
        current = self._tasks[address]['instance']
        if instance is not None and instance != current:
            raise KeyError(handle)
        self._make_nonce_room(address)
        nonce = secrets.token_urlsafe(32)
        self._upload_nonces[nonce] = {'token': address, 'instance': current, 'caller_auth': caller_auth}
        return nonce

    def restore_upload_nonce(self, nonce: str, bound: Dict[str, Any]) -> bool:
        """Put a redeemed nonce back, unspent, while the run it names is still the one tracked.

        For a request that redeemed ``nonce`` and then could not learn whether
        its run is still live (the engine did not answer the status call): no
        link is spent on a transport failure, so the same URL retries. Refused
        when the entry has left the tracker or a fresh launch took the address
        over meanwhile -- the nonce died with that run, as it would have unredeemed.

        Args:
            nonce: The nonce ``consume_upload_nonce`` just redeemed.
            bound: What that redemption returned (``token``, ``instance``, ``caller_auth``).

        Returns:
            bool: True when the nonce is live again.
        """
        address = bound['token']
        entry = self._tasks.get(address)
        if entry is None or entry['instance'] != bound['instance']:
            return False
        self._make_nonce_room(address)
        self._upload_nonces[nonce] = dict(bound)
        return True

    def drop_run_upload_nonces(self, address: str, instance: str) -> None:
        """Forget every nonce of the run ``instance`` at ``address``: the engine no longer serves that control.

        The upload route calls this when the status lookup of a redeemed
        nonce's control id is refused (a run restarted or terminated outside
        MCP). Only that run's nonces go: a no-op when a fresh launch took the
        address over meanwhile (its nonces are the new run's) or the entry is
        gone (its nonces went with it). The entry itself stays; it is advisory.

        Args:
            address: The task address the nonce was bound to.
            instance: The control id the engine refused.
        """
        entry = self._tasks.get(address)
        if entry is not None and entry['instance'] == instance:
            self._drop_upload_nonces(address)

    def has_upload_nonce(self, nonce: str) -> bool:
        """Report whether ``nonce`` is live, WITHOUT redeeming it.

        For checks the route must answer before it is willing to spend the
        nonce (a declared body size over the cap): a dead nonce is refused as
        unknown there, never echoed back as a link to retry with.
        """
        return nonce in self._upload_nonces

    def consume_upload_nonce(self, nonce: str) -> Optional[Dict[str, Any]]:
        """Redeem ``nonce`` exactly once.

        Args:
            nonce: The path segment the upload route received.

        Returns:
            Optional[Dict[str, Any]]: ``{'token', 'instance', 'caller_auth'}`` on
                the first use of a live nonce; ``None`` for an unknown, already
                used, or dead (task removed/evicted/relaunched) nonce. The
                cases are indistinguishable on purpose: the route answers 404
                for all.
        """
        return self._upload_nonces.pop(nonce, None)

    def _make_nonce_room(self, address: str) -> None:
        """Drop the oldest nonces of ``address`` until one more fits under ``MAX_UPLOAD_NONCES_PER_TASK``."""
        live = [nonce for nonce, bound in self._upload_nonces.items() if bound['token'] == address]
        while len(live) >= MAX_UPLOAD_NONCES_PER_TASK:
            self._upload_nonces.pop(live.pop(0), None)

    def _drop_upload_nonces(self, address: str) -> None:
        """Forget every nonce bound to ``address``."""
        for nonce in [n for n, bound in self._upload_nonces.items() if bound['token'] == address]:
            self._upload_nonces.pop(nonce, None)
