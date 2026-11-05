# =============================================================================
# RocketRide Engine
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

"""The ``embed`` tool of the embedding nodes (vector tool contract, section 4.3).

Vector Explorer places a text query on its map and searches the store by vector,
so it needs the query's vector made by the pipeline's own embedding node, with
that node's model and prefixes. :class:`EmbedToolMixin` gives an embedding node's
``IInstance`` one tool for that, ``embed``::

    {"texts": ["kestrel nesting"], "kind": "query"}
    -> {"success": true, "model": "sentence-transformers/all-MiniLM-L6-v2", "dimension": 384,
        "vectors": [[...]], "prefix_applied": null, "ms": 12}

* ``texts``: 1 to ``embed_texts_max`` (8) strings, each at most
  ``embed_text_chars_max`` (8,000) characters and not blank.
* ``kind``: ``'query'`` (default) encodes the texts the way the node encodes the
  ``questions`` lane (``encodeQuestion``, with the query prefix); ``'document'``
  the way it encodes the ``documents`` lane (``encodeChunks``, with the document
  prefix). The vectors therefore equal what the pipeline itself produces, rounded
  to six decimals. ``prefix_applied`` names the prefix the model applied, or null.
* Refusals are envelopes, never exceptions: ``READS_PUBLIC`` (the call came
  from a connection signed in with a task's public key; see
  ``ai.common.store.vx_write_gate.check_read``), ``INVALID_INPUT``, ``NO_EMBEDDER``
  (no model loaded), ``RATE_LIMITED`` with ``retry_after_s``, ``BUSY`` (the model
  stayed busy for ``EMBED_LOCK_WAIT_S``) and ``STORE_ERROR`` (the model failed or
  returned unusable vectors; for a failure the message names only the exception
  type, never the backend's own text, which may carry a host or part of a key;
  the full text goes to the server log). ``KeyboardInterrupt`` and ``SystemExit``
  still propagate.

The tool is DAP-only (``audience=('dap',)``): agents never see it.

Two pieces of per-task state live on the node's ``IGlobal`` (one per task and
node, shared by all of the task's instances):

* ``IGlobal.embed_bucket``, a :class:`TokenBucket`: ``embed_per_minute`` (30)
  calls a minute with bursts of ``embed_burst`` (5). A call refused before it
  reaches the model (invalid input, no model, ``BUSY``) does not spend a token.
* ``IGlobal.embed_lock``, an :class:`EmbedLock` over the model. The node's own
  batches (a document flush, a question) hold it shared, so they keep running
  concurrently with each other as they always did; an ``embed`` call holds it
  exclusively, so it starts only after every batch already on the model has
  finished, and a batch that arrives while a call waits queues behind the call.
  The lock covers the model call only, not the downstream write that follows a
  flush.

The limits come from ``ai.common.store.vx_defaults.EMBED_TOOL_LIMITS``, the
single source the app's fixtures are generated from.
"""

from __future__ import annotations

import json
import math
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from rocketlib import tool_function, warning

from .schema import Doc, Question
from .store import vx_write_gate
from .store.errors import StoreError, ToolRefusal
from .store.vx_defaults import EMBED_TOOL_LIMITS

#: Most texts in one call.
EMBED_TEXTS_MAX: int = EMBED_TOOL_LIMITS['embed_texts_max']

#: Longest text, in characters.
EMBED_TEXT_CHARS_MAX: int = EMBED_TOOL_LIMITS['embed_text_chars_max']

#: Sustained calls a minute per task.
EMBED_PER_MINUTE: int = EMBED_TOOL_LIMITS['embed_per_minute']

#: Calls a task may make at once before the per-minute rate applies.
EMBED_BURST: int = EMBED_TOOL_LIMITS['embed_burst']

#: Seconds an ``embed`` call waits for the batches on the model before it answers ``BUSY``.
EMBED_LOCK_WAIT_S: float = 60.0

#: Decimals kept in each returned vector value.
EMBED_VECTOR_DECIMALS: int = 6

#: ``kind`` values: the lane whose encoding the call reproduces.
EMBED_KINDS: Tuple[str, ...] = ('query', 'document')

EMBED_TOOL_DESCRIPTION = (
    f"Embed 1 to {EMBED_TEXTS_MAX} texts with this node's model and return the vectors, exactly as the "
    "pipeline would produce them ('query': as questions, with the query prefix; 'document': as document "
    'chunks, with the document prefix). For external tool calls (Vector Explorer); rate limited per task.'
)

EMBED_TOOL_INPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['texts'],
    'properties': {
        'texts': {
            'type': 'array',
            'description': f'The texts to embed: 1 to {EMBED_TEXTS_MAX}, each at most {EMBED_TEXT_CHARS_MAX} characters.',
            'minItems': 1,
            'maxItems': EMBED_TEXTS_MAX,
            'items': {'type': 'string', 'minLength': 1, 'maxLength': EMBED_TEXT_CHARS_MAX},
        },
        'kind': {
            'type': 'string',
            'enum': list(EMBED_KINDS),
            'default': 'query',
            'description': "'query' encodes the texts as questions, 'document' as document chunks.",
        },
    },
}

EMBED_TOOL_OUTPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['success'],
    'properties': {
        'success': {'type': 'boolean'},
        'model': {'type': 'string', 'description': 'The embedding model, as stamped on documents and questions.'},
        'dimension': {'type': 'integer'},
        'vectors': {'type': 'array', 'items': {'type': 'array', 'items': {'type': 'number'}}},
        'prefix_applied': {'type': ['string', 'null']},
        'ms': {'type': 'integer', 'description': 'Milliseconds the call took, waiting for the model included.'},
        'code': {
            'type': 'string',
            'description': 'On failure: INVALID_INPUT, NO_EMBEDDER, RATE_LIMITED, BUSY or STORE_ERROR.',
        },
        'error': {'type': 'string'},
        'retry_after_s': {'type': 'integer', 'description': 'With RATE_LIMITED: seconds until a call is accepted.'},
    },
}


# ---------------------------------------------------------------------------
# Per-task state on the IGlobal
# ---------------------------------------------------------------------------


class TokenBucket:
    """A thread-safe token bucket: ``burst`` tokens, refilled at ``per_minute`` a minute.

    :param per_minute: Sustained rate, in tokens a minute (> 0).
    :param burst: Capacity, the most tokens available at once (>= 1).
    :param clock: Monotonic clock in seconds (tests pass a fake one).
    """

    def __init__(self, per_minute: float, burst: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        """Start full."""
        if per_minute <= 0 or burst < 1:
            raise ValueError('a token bucket needs a positive rate and a burst of at least 1')
        self.rate: float = per_minute / 60.0
        self.capacity: float = float(burst)
        self._clock = clock
        self._tokens: float = float(burst)
        self._updated: float = clock()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = max(0.0, now - self._updated)
        self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
        self._updated = now

    def take(self) -> Optional[float]:
        """Spend one token. Return None when one was available, else the seconds until one is."""
        with self._lock:
            self._refill()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return None
            return (1.0 - self._tokens) / self.rate

    def refund(self) -> None:
        """Give back the token of a call that was accepted but could not run."""
        with self._lock:
            self._refill()
            self._tokens = min(self.capacity, self._tokens + 1.0)


class EmbedLock:
    """Shared/exclusive lock over one task's embedding model, preferring the exclusive side.

    The node's batches take it shared (:meth:`shared`), so any number of them run
    at once, as before the lock existed. An ``embed`` call takes it exclusively
    (:meth:`acquire_exclusive`): it waits for the batches already holding it, and
    while it waits no new batch starts, so a stream of batches cannot starve it.
    Not re-entrant.
    """

    def __init__(self) -> None:
        """Start free."""
        self._cond = threading.Condition(threading.Lock())
        self._shared = 0
        self._exclusive = False
        self._exclusive_waiting = 0

    @contextmanager
    def shared(self) -> Iterator[None]:
        """Hold the lock shared for the body (a batch on the model)."""
        with self._cond:
            while self._exclusive or self._exclusive_waiting:
                self._cond.wait()
            self._shared += 1
        try:
            yield
        finally:
            with self._cond:
                self._shared -= 1
                if not self._shared:
                    self._cond.notify_all()

    def acquire_exclusive(self, timeout: Optional[float] = None) -> bool:
        """Take the lock exclusively; False when ``timeout`` seconds passed first (None waits forever)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            self._exclusive_waiting += 1
            try:
                while self._exclusive or self._shared:
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        return False
                    self._cond.wait(remaining)
                self._exclusive = True
                return True
            finally:
                self._exclusive_waiting -= 1
                if not self._exclusive:
                    # Gave up: wake the batches this wait was holding back.
                    self._cond.notify_all()

    def release_exclusive(self) -> None:
        """Release an exclusive hold."""
        with self._cond:
            self._exclusive = False
            self._cond.notify_all()

    @property
    def exclusive_waiters(self) -> int:
        """Return how many exclusive acquisitions (embed calls) are waiting right now."""
        with self._cond:
            return self._exclusive_waiting


_STATE_GUARD = threading.Lock()


def _state_of(glb: Any, name: str, make: Callable[[], Any]) -> Any:
    value = getattr(glb, name, None)
    if value is not None:
        return value
    with _STATE_GUARD:
        value = getattr(glb, name, None)
        if value is None:
            value = make()
            setattr(glb, name, value)
        return value


def embed_lock_of(glb: Any) -> EmbedLock:
    """Return ``glb.embed_lock``, creating it the first time (one per IGlobal, so per task and node)."""
    return _state_of(glb, 'embed_lock', EmbedLock)


def embed_bucket_of(glb: Any) -> TokenBucket:
    """Return ``glb.embed_bucket``, creating it the first time (one per IGlobal, so per task and node)."""
    return _state_of(glb, 'embed_bucket', lambda: TokenBucket(EMBED_PER_MINUTE, EMBED_BURST))


# ---------------------------------------------------------------------------
# Input and output
# ---------------------------------------------------------------------------


def _normalize_input(input_obj: Any, depth: int = 0) -> Optional[Dict[str, Any]]:
    """Return the tool input as a dict, or None when it is not an object.

    Accepts a dict, a JSON object string, a pydantic-style model, and the nested
    ``{'input': ...}`` wrappers some hosts produce; ``None`` is an empty input.
    """
    if input_obj is None:
        return {}
    if callable(getattr(input_obj, 'model_dump', None)):
        input_obj = input_obj.model_dump()
    if isinstance(input_obj, (str, bytes, bytearray)):
        try:
            input_obj = json.loads(input_obj)
        except ValueError:
            return None
    if not isinstance(input_obj, dict):
        return None
    if 'input' in input_obj and 'texts' not in input_obj and depth < 3:
        inner = _normalize_input(input_obj['input'], depth + 1)
        if inner is None:
            return None
        input_obj = {**inner, **{k: v for k, v in input_obj.items() if k != 'input'}}
    return input_obj


def _parse(args: Dict[str, Any]) -> Tuple[List[str], str]:
    texts = args.get('texts')
    if not isinstance(texts, list) or not 1 <= len(texts) <= EMBED_TEXTS_MAX:
        raise ToolRefusal('INVALID_INPUT', f'texts must be a list of 1 to {EMBED_TEXTS_MAX} strings.')
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            raise ToolRefusal('INVALID_INPUT', 'Every text must be a string with at least one non-blank character.')
        if len(text) > EMBED_TEXT_CHARS_MAX:
            raise ToolRefusal('INVALID_INPUT', f'Every text must be at most {EMBED_TEXT_CHARS_MAX:,} characters.')

    kind = args.get('kind')
    if kind is None:
        kind = 'query'
    if kind not in EMBED_KINDS:
        raise ToolRefusal('INVALID_INPUT', "kind must be 'query' or 'document'.")
    return texts, kind


def _vector(value: Any) -> List[float]:
    if hasattr(value, 'tolist'):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or not value:
        raise StoreError('The embedding model returned no vector for a text.')
    out: List[float] = []
    for item in value:
        number = float(item)
        if not math.isfinite(number):
            raise StoreError('The embedding model returned a value that is not a finite number.')
        out.append(round(number, EMBED_VECTOR_DECIMALS))
    return out


def _encode(embedding: Any, texts: List[str], kind: str) -> Tuple[List[List[float]], str]:
    """Encode through the same wrapper call the node's lane uses; return the vectors and the model name."""
    if kind == 'query':
        question = Question()
        for text in texts:
            question.addQuestion(text)
        embedding.encodeQuestion(question)
        items: List[Any] = list(question.questions)
    else:
        items = [Doc(page_content=text) for text in texts]
        embedding.encodeChunks(items)

    if len(items) != len(texts):
        raise StoreError('The embedding model did not return one vector per text.')
    vectors = [_vector(item.embedding) for item in items]
    if len({len(vector) for vector in vectors}) != 1:
        raise StoreError('The embedding model returned vectors of different lengths.')
    model = next((item.embedding_model for item in items if isinstance(item.embedding_model, str)), '')
    return vectors, model


def _prefix(embedding: Any, kind: str) -> Optional[str]:
    prefix = getattr(embedding, f'{kind}_prefix', None)
    return prefix if isinstance(prefix, str) and prefix else None


# ---------------------------------------------------------------------------
# The mixin
# ---------------------------------------------------------------------------


class EmbedToolMixin:
    """Give an embedding node's ``IInstance`` the ``embed`` tool and the batch guard.

    Mix it in ahead of ``IInstanceBase`` (``class IInstance(EmbedToolMixin,
    IInstanceBase)``); ``IInstanceBase._dispatch_tool`` finds ``embed`` through
    its ``@tool_function`` mark. The node must keep its model in
    ``self.IGlobal.embedding`` (an ``EmbeddingBase``: ``encodeQuestion`` and
    ``encodeChunks`` stamp ``embedding`` and ``embedding_model``), may expose
    ``query_prefix`` / ``document_prefix`` on it, and must run every model call of
    its own lanes inside :meth:`_embed_batch`.
    """

    def _embed_batch(self) -> Any:
        """Context manager for one of the node's own model calls (``IGlobal.embed_lock``, shared)."""
        return embed_lock_of(self.IGlobal).shared()

    @tool_function(
        input_schema=EMBED_TOOL_INPUT_SCHEMA,
        description=EMBED_TOOL_DESCRIPTION,
        output_schema=EMBED_TOOL_OUTPUT_SCHEMA,
        audience=('dap',),
    )
    def embed(self, args: Any) -> Dict[str, Any]:
        """Embed 1 to 8 texts with this node's model; always answers an envelope."""
        try:
            return self._embed(args)
        except ToolRefusal as e:
            return e.envelope()
        except StoreError as e:
            return {'success': False, 'code': 'STORE_ERROR', 'error': str(e)}
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as e:  # the tool boundary: nothing else escapes
            warning(f'embed tool: the model failed: {type(e).__name__}: {e}')
            return {
                'success': False,
                'code': 'STORE_ERROR',
                'error': f'The embedding model failed ({type(e).__name__}); see the server log.',
            }

    def _embed(self, args: Any) -> Dict[str, Any]:
        started = time.perf_counter()

        # Like the stores' DAP-only read tools: a connection signed in with a task's public key is refused.
        vx_write_gate.check_read()

        payload = _normalize_input(args)
        if payload is None:
            raise ToolRefusal('INVALID_INPUT', 'The input must be an object such as {"texts": ["..."]}.')
        texts, kind = _parse(payload)

        glb = getattr(self, 'IGlobal', None)
        embedding = getattr(glb, 'embedding', None) if glb is not None else None
        if embedding is None:
            raise ToolRefusal('NO_EMBEDDER', 'This embedding node has no model loaded.')

        bucket = embed_bucket_of(glb)
        wait = bucket.take()
        if wait is not None:
            retry = max(1, math.ceil(wait - 1e-9))
            raise ToolRefusal(
                'RATE_LIMITED',
                f'Too many embed calls on this task; try again in {retry} s.',
                {'retry_after_s': retry},
            )

        lock = embed_lock_of(glb)
        if not lock.acquire_exclusive(timeout=EMBED_LOCK_WAIT_S):
            bucket.refund()
            raise ToolRefusal(
                'BUSY',
                f'The embedding model stayed busy with other batches for {EMBED_LOCK_WAIT_S:g} s; try again.',
            )
        try:
            vectors, model = _encode(embedding, texts, kind)
        finally:
            lock.release_exclusive()

        return {
            'success': True,
            'model': model,
            'dimension': len(vectors[0]),
            'vectors': vectors,
            'prefix_applied': _prefix(embedding, kind),
            'ms': int(round((time.perf_counter() - started) * 1000)),
        }


__all__ = [
    'EMBED_BURST',
    'EMBED_KINDS',
    'EMBED_LOCK_WAIT_S',
    'EMBED_PER_MINUTE',
    'EMBED_TEXTS_MAX',
    'EMBED_TEXT_CHARS_MAX',
    'EMBED_TOOL_DESCRIPTION',
    'EMBED_TOOL_INPUT_SCHEMA',
    'EMBED_TOOL_OUTPUT_SCHEMA',
    'EMBED_VECTOR_DECIMALS',
    'EmbedLock',
    'EmbedToolMixin',
    'TokenBucket',
    'embed_bucket_of',
    'embed_lock_of',
]
