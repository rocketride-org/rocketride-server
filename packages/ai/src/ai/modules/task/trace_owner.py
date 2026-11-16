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

"""
TraceOwners: which control a request tree belongs to (plan 7.5, S14).

Every pipe-tagged event an engine emits (a flow trace, an ``>SSE``, a node's
own message) carries the wire ``traceId`` of the request tree it happened in.
On a shared engine those events must reach the control that OWNS the tree and
nobody else, so EaaS records, for every binding it opens, which control (by
its registry KEY string, never the object: the registry resolves it) and which
connection (the opener, delivered first) the tree belongs to.

An entry is claimed when the open answers with its ``traceId`` and released at
the close. It then lingers for ``CONST_BINDING_GRACE_SECONDS``: an event that
left the engine just before the close still routes to the owner, stamped
``late``; after the grace an event for that id has no owner and goes to the
ops stream, never to the next holder of the reused slot.
"""

import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from ai.constants import CONST_BINDING_GRACE_SECONDS

# ==== The record ===================================================================


@dataclass(frozen=True)
class TraceOwner:
    """
    Who a request tree belongs to.

    Attributes:
        control_key: The owning control's registry key.
        conn_id: The connection that opened the binding (delivered first).
        late: True when the tree was released and the grace has not lapsed.
        billing: Who pays for the tree's work (plan 8.3): the CALLER of the
            request and their home team, which on a team-owned control differ
            from one request to the next. None for a tree nobody metered.
        address: The control's address, for the usage row's pipe segment.
        rung: The rung the control resolved on, for the row's key and context.
        team: The audience slot of the publication that answered (a team id,
            ``user~{uid}`` or ``~public``); ``''`` for a dev run. Part of the
            usage row's key, so two publications never share a row (plan 8.2).
        version: The artifact version that answered; None for a dev run.
    """

    control_key: str
    conn_id: int
    late: bool = False
    billing: Any = None
    address: str = ''
    rung: str = ''
    team: str = ''
    version: Optional[int] = None


# ==== The registry ===============================================================


class TraceOwners:
    """
    The live and recently released request trees, by wire ``traceId``.

    One per server. Dict backed: the live set is exactly the open bindings, the
    released set is bounded by the grace window and swept on every release.
    """

    def __init__(self) -> None:
        """Start empty."""
        # traceId -> owner, for every binding currently open
        self._live: Dict[str, TraceOwner] = {}
        # traceId -> (owner, released_at) for bindings closed within the grace
        self._released: Dict[str, tuple] = {}

    def claim(
        self,
        trace_id: str,
        control_key: str,
        conn_id: int,
        *,
        billing: Any = None,
        address: str = '',
        rung: str = '',
        team: str = '',
        version: Optional[int] = None,
    ) -> None:
        """
        Record that ``trace_id`` belongs to ``control_key``, opened by ``conn_id``, paid by ``billing``.

        Args:
            trace_id: The wire traceId the open answered with.
            control_key: The owning control's registry key.
            conn_id: The opener's connection id.
            billing: The caller's paying unit for this tree (plan 8.3).
            address: The control's address.
            rung: The control's rung.
            team: The answering publication's audience slot (``''`` on a dev run).
            version: The answering artifact version (None on a dev run).
        """
        if not trace_id:
            return
        # A re-claim (the idempotent open served the same binding twice) keeps
        # the first owner: a tree never changes hands
        self._live.setdefault(
            trace_id,
            TraceOwner(control_key, conn_id, billing=billing, address=address, rung=rung, team=team, version=version),
        )

    def release(self, trace_id: str, now: Optional[float] = None) -> None:
        """
        The binding closed: the tree stays routable to its owner for the grace, then is forgotten.

        Args:
            trace_id: The wire traceId.
            now: ``time.monotonic()`` (injectable for tests).
        """
        now = time.monotonic() if now is None else now
        owner = self._live.pop(trace_id, None)
        if owner is not None:
            self._released[trace_id] = (owner, now)
        # Every release sweeps what the grace has already retired, so the
        # released set never outgrows one grace window of closes
        self.sweep(now)

    def owner(self, trace_id: str, now: Optional[float] = None) -> Optional[TraceOwner]:
        """
        The owner of ``trace_id``: live, or released within the grace (``late``), else None.

        Args:
            trace_id: The wire traceId an event carries.
            now: ``time.monotonic()``.

        Returns:
            The owner, or None when the tree is unknown or its grace lapsed.
        """
        live = self._live.get(trace_id)
        if live is not None:
            return live
        released = self._released.get(trace_id)
        if released is None:
            return None
        owner, released_at = released
        now = time.monotonic() if now is None else now
        if now - released_at >= CONST_BINDING_GRACE_SECONDS:
            return None
        return TraceOwner(
            owner.control_key,
            owner.conn_id,
            late=True,
            billing=owner.billing,
            address=owner.address,
            rung=owner.rung,
            team=owner.team,
            version=owner.version,
        )

    def sweep(self, now: Optional[float] = None) -> None:
        """
        Forget every released tree whose grace lapsed.

        Args:
            now: ``time.monotonic()``.
        """
        now = time.monotonic() if now is None else now
        for trace_id in [t for t, (_owner, at) in self._released.items() if now - at >= CONST_BINDING_GRACE_SECONDS]:
            self._released.pop(trace_id, None)

    def forget_control(self, control_key: str) -> None:
        """
        Drop every tree of a control that is gone (its records went with it).

        Args:
            control_key: The removed control's registry key.
        """
        for trace_id in [t for t, o in self._live.items() if o.control_key == control_key]:
            self._live.pop(trace_id, None)
        for trace_id in [t for t, (o, _at) in self._released.items() if o.control_key == control_key]:
            self._released.pop(trace_id, None)

    def __len__(self) -> int:
        """The number of live trees."""
        return len(self._live)
