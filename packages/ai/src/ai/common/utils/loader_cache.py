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
The module-scope loader cache: model handles shared by every control, keyed by model id.

Plan 4.1 rule 1: module scope holds constants, fixed tables and singletons
shared by every control, among them the loader cache of model weights keyed by
model id. Weights depend on the model id alone, never on who asked, so two
controls that name one model share one copy; everything a control chose beyond
the id (a voice, a threshold, a client) stays on its IGlobal.

A node declares one at module scope and asks it for a handle in ``beginGlobal``::

    _MODELS = LoaderCache()


    class IGlobal(IGlobalBase):
        def beginGlobal(self):
            self.embedding = _MODELS.get(self.config.model, lambda: Embedding(self.config.model))

        def endGlobal(self):
            self.embedding = None

The IGlobal drops its reference in ``endGlobal``; the cache keeps the handle for
the next control, which is the point. A load that raises caches nothing, so the
next control tries again.
"""

from __future__ import annotations

import threading
from typing import Callable, Dict, Hashable, TypeVar

T = TypeVar('T')


class LoaderCache:
    """Model handles keyed by model id, each loaded once per process."""

    def __init__(self) -> None:
        """Start empty: nothing loads until a control asks for it."""
        self._lock = threading.Lock()  #: Guards the two maps.
        self._handles: Dict[Hashable, object] = {}  #: Loaded handles by model id.
        self._loading: Dict[Hashable, threading.Lock] = {}  #: One lock per model id being loaded.

    def get(self, model_id: Hashable, load: Callable[[], T]) -> T:
        """
        Return the handle for ``model_id``, loading it with ``load`` the first time.

        Two controls asking for the same id at once load it once (the second
        waits on that id's lock); different ids load in parallel.

        Args:
            model_id (Hashable): What the weights depend on: the model id, plus any
                load-time option that changes them (a language, a revision).
            load (Callable[[], T]): Builds the handle; called at most once per id
                unless it raises.

        Returns:
            T: The shared handle.
        """
        # Step 1: a loaded handle is returned without waiting on any load.
        with self._lock:
            if model_id in self._handles:
                return self._handles[model_id]  # type: ignore[return-value]
            key_lock = self._loading.setdefault(model_id, threading.Lock())

        # Step 2: one loader per id; a second caller finds the handle when it gets the lock.
        with key_lock:
            with self._lock:
                if model_id in self._handles:
                    return self._handles[model_id]  # type: ignore[return-value]
            handle = load()
            with self._lock:
                self._handles[model_id] = handle
                self._loading.pop(model_id, None)
            return handle
