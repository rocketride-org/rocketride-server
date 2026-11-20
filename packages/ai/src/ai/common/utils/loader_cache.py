# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
The module-scope loader cache: model handles shared by the controls using them, keyed by model id.

Plan 4.1 rule 1: module scope holds constants, fixed tables and singletons
shared by every control, among them the loader cache of model weights keyed by
model id. Weights depend on the model id alone, never on who asked, so two
controls that name one model share one copy; everything a control chose beyond
the id (a voice, a threshold, a client) stays on its IGlobal.

A handle is counted, not kept: each control ``acquire``s it in ``beginGlobal``
and ``release``s it in ``endGlobal``, and the cache drops the handle when the
last control lets go. So a model nobody uses frees its memory (a GPU model its
device memory) at the idle sweep, exactly as it did when every IGlobal owned
its own, while concurrent controls naming one model share one load::

    _MODELS = LoaderCache()


    class IGlobal(IGlobalBase):
        def beginGlobal(self):
            self._model_id = self.config.model
            self.embedding = _MODELS.acquire(self._model_id, lambda: Embedding(self._model_id))

        def endGlobal(self):
            self.embedding = None
            _MODELS.release(self._model_id)

A load that raises counts and caches nothing, so the next control tries again.
"""

from __future__ import annotations

import threading
from typing import Callable, Dict, Hashable, TypeVar

T = TypeVar('T')


class _Slot:
    """One model id's state: its load lock, its handle and who is using the slot."""

    __slots__ = ('lock', 'handle', 'loaded', 'users', 'pending')

    def __init__(self) -> None:
        """An empty slot: nothing loaded, nobody holding or waiting."""
        self.lock = threading.Lock()  #: Serializes the load (and the loaded check) for this id.
        self.handle: object = None  #: The loaded handle, while ``loaded``.
        self.loaded = False  #: Whether ``handle`` is live.
        self.users = 0  #: Controls holding the handle (acquired, not yet released).
        self.pending = 0  #: Acquires in flight that captured this slot.


class LoaderCache:
    """Model handles keyed by model id: loaded on the first acquire, dropped on the last release."""

    def __init__(self) -> None:
        """Start empty: nothing loads until a control asks for it."""
        self._lock = threading.Lock()  #: Guards the slot map and every slot's counters.
        self._slots: Dict[Hashable, _Slot] = {}  #: One slot per id in use or in flight.

    def acquire(self, model_id: Hashable, load: Callable[[], T]) -> T:
        """
        Return the handle for ``model_id``, loading it with ``load`` if no control holds it.

        Every caller for one id goes through the same slot and its lock, and the
        slot outlives the last release while any acquire that captured it is
        still in flight, so an id is never loaded twice at once and its holder
        count is never reset under a live holder. Different ids load in
        parallel. Every acquire that returns must be paired with one ``release``.

        Args:
            model_id (Hashable): What the weights depend on: the model id, plus any
                load-time option that changes them (a language, a revision).
            load (Callable[[], T]): Builds the handle; called only when no control
                holds one for this id.

        Returns:
            T: The shared handle.
        """
        # Step 1: capture the id's slot; it cannot be dropped while we are pending.
        with self._lock:
            slot = self._slots.get(model_id)
            if slot is None:
                slot = self._slots[model_id] = _Slot()
            slot.pending += 1
        try:
            # Step 2: under the slot's lock, share a live handle or load one.
            with slot.lock:
                with self._lock:
                    if slot.loaded:
                        slot.users += 1
                        return slot.handle  # type: ignore[return-value]
                handle = load()
                with self._lock:
                    slot.handle, slot.loaded, slot.users = handle, True, slot.users + 1
                return handle
        finally:
            # Step 3: no longer in flight; an unused slot goes.
            with self._lock:
                slot.pending -= 1
                self._drop_if_unused(model_id, slot)

    def release(self, model_id: Hashable) -> None:
        """
        Give back one control's hold on ``model_id``; the last one out drops the handle.

        Releasing an id nobody holds (a ``beginGlobal`` that failed before its
        acquire) does nothing.

        Args:
            model_id (Hashable): The id passed to ``acquire``.
        """
        with self._lock:
            slot = self._slots.get(model_id)
            if slot is None or slot.users == 0:
                return
            slot.users -= 1
            if slot.users == 0:
                slot.handle, slot.loaded = None, False
                self._drop_if_unused(model_id, slot)

    def _drop_if_unused(self, model_id: Hashable, slot: _Slot) -> None:
        """Forget a slot no control holds and no acquire is waiting on (caller holds ``_lock``)."""
        if slot.users == 0 and slot.pending == 0 and self._slots.get(model_id) is slot:
            del self._slots[model_id]
