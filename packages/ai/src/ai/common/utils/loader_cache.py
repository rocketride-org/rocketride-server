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


class LoaderCache:
    """Model handles keyed by model id: loaded on the first acquire, dropped on the last release."""

    def __init__(self) -> None:
        """Start empty: nothing loads until a control asks for it."""
        self._lock = threading.Lock()  #: Guards the three maps.
        self._handles: Dict[Hashable, object] = {}  #: Loaded handles by model id.
        self._users: Dict[Hashable, int] = {}  #: Controls holding each handle.
        self._loading: Dict[Hashable, threading.Lock] = {}  #: One lock per model id being loaded.

    def acquire(self, model_id: Hashable, load: Callable[[], T]) -> T:
        """
        Return the handle for ``model_id``, loading it with ``load`` if no control holds it.

        Two controls asking for the same id at once load it once (the second
        waits on that id's lock); different ids load in parallel. Every acquire
        that returns must be paired with one ``release``.

        Args:
            model_id (Hashable): What the weights depend on: the model id, plus any
                load-time option that changes them (a language, a revision).
            load (Callable[[], T]): Builds the handle; called only when no control
                holds one for this id.

        Returns:
            T: The shared handle.
        """
        # Step 1: a held handle is shared without waiting on any load.
        with self._lock:
            if model_id in self._handles:
                self._users[model_id] += 1
                return self._handles[model_id]  # type: ignore[return-value]
            key_lock = self._loading.setdefault(model_id, threading.Lock())

        # Step 2: one loader per id; a second caller finds the handle when it gets the lock.
        with key_lock:
            with self._lock:
                if model_id in self._handles:
                    self._users[model_id] += 1
                    return self._handles[model_id]  # type: ignore[return-value]
            handle = load()
            with self._lock:
                self._handles[model_id] = handle
                self._users[model_id] = 1
                self._loading.pop(model_id, None)
            return handle

    def release(self, model_id: Hashable) -> None:
        """
        Give back one control's hold on ``model_id``; the last one out drops the handle.

        Releasing an id nobody holds (a ``beginGlobal`` that failed before its
        acquire) does nothing.

        Args:
            model_id (Hashable): The id passed to ``acquire``.
        """
        with self._lock:
            users = self._users.get(model_id, 0) - 1
            if users > 0:
                self._users[model_id] = users
                return
            self._users.pop(model_id, None)
            self._handles.pop(model_id, None)
