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
        # nonce -> {'token': task address, 'caller_auth': credential or None,
        #           'generation': the instance generation it was minted for}
        self._upload_nonces: Dict[str, Dict[str, Any]] = {}
        # token -> instance generation: bumped on every fresh add, kept on a
        # same_instance re-add, so a nonce redeemed for one run can never buy
        # a replacement link for the run that took the address over meanwhile
        self._generations: Dict[str, int] = {}

    def add(self, token: str, *, same_instance: bool = False, **metadata: Any) -> None:
        """Register ``token`` with the given metadata, replacing any prior entry.

        At ``MAX_TASKS`` entries the oldest is evicted (dict preserves
        insertion order) so leaked tokens can't grow the process forever. An
        evicted task takes its upload nonces with it.

        A re-add drops the token's nonces unless ``same_instance`` says the
        entry still names the task instance that issued them. The address is
        reused by every later run of the same project/source, and the engine
        never tells this registry when a run expires -- so a nonce minted for
        an earlier run must never redeem into a later run at the same address
        with the earlier caller's identity. The ``use()`` result says which
        case this is: ``reused`` is True only when ``use_existing`` attached to
        the LIVE instance (nonces kept); a fresh launch is a new instance.

        Args:
            token: The task address.
            same_instance: True when the entry refreshes the live instance that
                already holds this token (``use_existing`` on a running task);
                False (the default, the safe direction) for a new launch.
            **metadata: Advisory metadata stored with the token.
        """
        if self._tasks.pop(token, None) is not None and not same_instance:
            self._drop_upload_nonces(token)
        if not same_instance or token not in self._generations:
            self._generations[token] = self._generations.get(token, 0) + 1
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

    def generation_of(self, token: str) -> Optional[int]:
        """The instance generation ``token`` is at, or ``None`` when untracked."""
        return self._generations.get(token) if token in self._tasks else None

    def issue_upload_nonce(self, token: str, caller_auth: Optional[str], *, generation: Optional[int] = None) -> str:
        """Mint a one-time upload nonce for the tracked task ``token``.

        The nonce is bound to the task AND to ``caller_auth`` -- the credential
        the minting tool call ran under (``identity.CALLER_AUTH``; ``None`` on
        the shared-client path) -- so the upload route can forward the bytes
        as that caller. Only a tracked task can carry a nonce: the route must
        never accept an upload into a task this registry has already let go.

        Args:
            token: The task address, already registered via ``add``.
            caller_auth: The caller credential to forward the upload with.
            generation: When given (a replacement link for a redeemed nonce),
                the instance generation that nonce was minted for; the link is
                refused when the address has since been taken over by a fresh
                launch, since it would carry the earlier caller into the new run.

        Returns:
            str: The URL-safe nonce.

        Raises:
            KeyError: ``token`` is not tracked, or ``generation`` is not the
                instance it is at.
        """
        if token not in self._tasks:
            raise KeyError(token)
        if generation is not None and generation != self._generations.get(token):
            raise KeyError(token)
        live = [nonce for nonce, bound in self._upload_nonces.items() if bound['token'] == token]
        while len(live) >= MAX_UPLOAD_NONCES_PER_TASK:
            self._upload_nonces.pop(live.pop(0), None)
        nonce = secrets.token_urlsafe(32)
        self._upload_nonces[nonce] = {
            'token': token,
            'caller_auth': caller_auth,
            'generation': self._generations[token],
        }
        return nonce

    def consume_upload_nonce(self, nonce: str) -> Optional[Dict[str, Any]]:
        """Redeem ``nonce`` exactly once.

        Args:
            nonce: The path segment the upload route received.

        Returns:
            Optional[Dict[str, Any]]: ``{'token', 'caller_auth', 'generation'}`` on the first
                use of a live nonce; ``None`` for an unknown, already used, or
                dead (task removed/evicted) nonce. The three are
                indistinguishable on purpose: the route answers 404 for all.
        """
        return self._upload_nonces.pop(nonce, None)

    def _drop_upload_nonces(self, token: str) -> None:
        """Forget every nonce bound to ``token``."""
        for nonce in [n for n, bound in self._upload_nonces.items() if bound['token'] == token]:
            self._upload_nonces.pop(nonce, None)
