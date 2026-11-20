# Copyright 2026 Aparavi Software AG. MIT License.
"""Server-owned task registry.

The RocketRide SDK has no client-side task registry: ``use()`` returns a
bare task token, and enumerate/terminate/monitor across separate tool calls
need somewhere to keep ``{token -> metadata}``. This is a plain in-memory
dict, scoped to a single asyncio event loop (one process, one persistent
``RocketRideClient``) — it is NOT thread-safe and must not be shared across
event loops or accessed concurrently from multiple threads.

The registry is also where the dropper widget's upload nonces live (plan
3.7): ``run_dropper_pipe`` mints a one-time nonce bound to the task it just
started and to the caller credential the tool call ran under, and the
``/mcp/upload/{nonce}`` route consumes it. A nonce is only ever valid while
its task is tracked here -- ``remove`` (the ``terminate`` tool) and FIFO
eviction drop the task's nonces with the task.
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
    """In-memory ``{token -> metadata}`` registry, FIFO-bounded at ``MAX_TASKS``.

    Single-event-loop use only; not thread-safe.
    """

    def __init__(self) -> None:
        self._tasks: Dict[str, Dict[str, Any]] = {}
        # nonce -> {'token': task address, 'caller_auth': credential or None}
        self._upload_nonces: Dict[str, Dict[str, Any]] = {}

    def add(self, token: str, **metadata: Any) -> None:
        """Register ``token`` with the given metadata, replacing any prior entry.

        At ``MAX_TASKS`` entries the oldest is evicted (dict preserves
        insertion order) so leaked tokens can't grow the process forever. An
        evicted task takes its upload nonces with it; a re-added task keeps
        them (same task, refreshed bookkeeping).
        """
        self._tasks.pop(token, None)  # re-add moves the token to newest
        while len(self._tasks) >= MAX_TASKS:
            evicted = next(iter(self._tasks))
            self._tasks.pop(evicted)
            self._drop_upload_nonces(evicted)
        self._tasks[token] = dict(metadata)

    def remove(self, token: str) -> None:
        """Drop ``token`` and its upload nonces from the registry. A no-op if it is not present."""
        self._tasks.pop(token, None)
        self._drop_upload_nonces(token)

    def get(self, token: str) -> Optional[Dict[str, Any]]:
        """Return ``{'token': token, **metadata}`` for ``token``, or ``None``."""
        metadata = self._tasks.get(token)
        if metadata is None:
            return None
        return {'token': token, **metadata}

    def list(self) -> List[Dict[str, Any]]:
        """Return ``[{'token': token, **metadata}, ...]`` for every registered task."""
        return [{'token': token, **metadata} for token, metadata in self._tasks.items()]

    # ------------------------------------------------------------------
    # Upload nonces (plan 3.7)
    # ------------------------------------------------------------------

    def issue_upload_nonce(self, token: str, caller_auth: Optional[str]) -> str:
        """Mint a one-time upload nonce for the tracked task ``token``.

        The nonce is bound to the task AND to ``caller_auth`` -- the credential
        the minting tool call ran under (``identity.CALLER_AUTH``; ``None`` on
        the shared-client path) -- so the upload route can forward the bytes
        as that caller. Only a tracked task can carry a nonce: the route must
        never accept an upload into a task this registry has already let go.

        Args:
            token: The task address, already registered via ``add``.
            caller_auth: The caller credential to forward the upload with.

        Returns:
            str: The URL-safe nonce.

        Raises:
            KeyError: ``token`` is not tracked.
        """
        if token not in self._tasks:
            raise KeyError(token)
        live = [nonce for nonce, bound in self._upload_nonces.items() if bound['token'] == token]
        while len(live) >= MAX_UPLOAD_NONCES_PER_TASK:
            self._upload_nonces.pop(live.pop(0), None)
        nonce = secrets.token_urlsafe(32)
        self._upload_nonces[nonce] = {'token': token, 'caller_auth': caller_auth}
        return nonce

    def consume_upload_nonce(self, nonce: str) -> Optional[Dict[str, Any]]:
        """Redeem ``nonce`` exactly once.

        Args:
            nonce: The path segment the upload route received.

        Returns:
            Optional[Dict[str, Any]]: ``{'token', 'caller_auth'}`` on the first
                use of a live nonce; ``None`` for an unknown, already used, or
                dead (task removed/evicted) nonce. The three are
                indistinguishable on purpose: the route answers 404 for all.
        """
        return self._upload_nonces.pop(nonce, None)

    def _drop_upload_nonces(self, token: str) -> None:
        """Forget every nonce bound to ``token``."""
        for nonce in [n for n, bound in self._upload_nonces.items() if bound['token'] == token]:
            self._upload_nonces.pop(nonce, None)
