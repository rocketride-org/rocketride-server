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

"""Durable capture of Discord events into a database node (``discord_events``).

The node already broadcasts every event it handles as an ``apaevt_sse`` event.
SSE is live-only: whatever was not subscribed at the time is gone, which makes
it useless for the one thing a support bot's owner actually wants -- reading
back what the bot was asked last night and what it answered. ``captureEvents``
adds a durable copy of the same bodies, written server-side into a database
node wired to this source by a ``tool`` control edge.

Three properties are the whole design, and every one of them is about not
being able to hurt the bot:

* **Off the answering path.** ``submit`` puts a finished row on a bounded
  queue and returns; one daemon thread does the talking. A database that
  hangs costs a queued row, never a Discord reply.
* **Bounded.** The queue holds 1000 rows. When it is full the NEW row is
  dropped and counted -- dropping the oldest would discard the question and
  keep the reply, which is the wrong half.
* **Quiet when broken.** The first failure is reported in full; after that at
  most one warning per 30 seconds, carrying the running count, and one line
  when writes start working again.

The module is pure Python with no engine imports at module scope (the
``IInvokeTool`` import is deferred into ``_invoke_param``), so it loads in a
plain unit-test process the way ``text_utils`` does.
"""

from __future__ import annotations

import json
import queue
import re
import threading
import time

from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

# The discord_events columns an INSERT binds, in positional order. ``seq`` and
# ``captured_at`` are the database's to fill in.
COLUMNS = (
    'event_type',
    'message_id',
    'event_key',
    'thread_id',
    'channel_id',
    'guild_id',
    'author_id',
    'author_is_bot',
    'occurred_at',
    'text',
    'payload',
    'source',
)

DEFAULT_TABLE = 'discord_events'

# The contract clips `text` at 8000 characters. The whole, unclipped text is
# still in `payload`, so nothing is actually lost -- this keeps one pathological
# attachment transcript from dominating the column every query selects.
MAX_TEXT_CHARS = 8000

# Roughly a minute of a very busy channel. Past this the database is not
# keeping up and the right answer is to shed, not to buffer without limit.
QUEUE_MAX_ROWS = 1000

# One warning per node per window while writes are failing.
WARN_INTERVAL_SECONDS = 30.0

# Postgres truncates every identifier at 63 bytes. CREATE_TABLE_SQL derives the
# constraint and index names from the table name, so a name allowed to use the
# whole budget would have those derived names truncated -- and two capture
# tables whose names differ only past the cut would then collide on them. The
# accepted name is therefore shorter by the longest suffix the DDL appends.
POSTGRES_IDENTIFIER_BYTES = 63
TABLE_NAME_SUFFIXES = ('_dedupe', '_thread', '_occurred')
MAX_TABLE_NAME_CHARS = POSTGRES_IDENTIFIER_BYTES - max(len(suffix) for suffix in TABLE_NAME_SUFFIXES)

# The table name is substituted into DDL, so it is matched against this and
# refused rather than quoted.
_TABLE_NAME_RE = re.compile(rf'^[A-Za-z_][A-Za-z0-9_]{{0,{MAX_TABLE_NAME_CHARS - 1}}}$')

# ``event_key`` is part of the dedupe key, and a ``no_reply`` reason can be
# built from an exception message. The node clips the reason at its emit site;
# this is the backstop for whatever else ever reaches the key builder.
MAX_EVENT_KEY_CHARS = 200

# A configured ``captureSource`` label: short, printable, no spaces. It is a
# bind parameter, never SQL text, so this is hygiene for the readers of the
# column rather than a guard against injection.
_SOURCE_LABEL_RE = re.compile(r'^[A-Za-z0-9_.:+@-]{1,128}$')

# Sentinel the worker loop reads as "the queue is drained, you may stop".
_STOP = object()


def is_valid_table_name(table: Any) -> bool:
    """Return True when ``table`` is safe to substitute into the fixed DDL.

    The table name is the one part of these statements that comes from config,
    and it lands in a position no bind parameter can occupy. So it is matched
    against an identifier pattern and refused outright -- quoting it would
    accept names that work but read as an injection attempt in the logs.
    """
    return isinstance(table, str) and bool(_TABLE_NAME_RE.match(table))


def is_valid_source_label(label: Any) -> bool:
    """Return True when ``label`` may be written as a row's ``source``."""
    return isinstance(label, str) and bool(_SOURCE_LABEL_RE.match(label))


def CREATE_TABLE_SQL(table: str) -> str:
    """Return the idempotent ``discord_events`` DDL for ``table``.

    Three statements in one string: the table and its two indexes. Every one
    is ``IF NOT EXISTS``, so this is safe to run on each process start, and
    the index and constraint names are derived from ``table`` so two capture
    tables can live in one database without colliding.

    ``table`` MUST have passed :func:`is_valid_table_name` -- callers go
    through ``CaptureWriter``, which refuses to start otherwise.
    """
    return (
        f'CREATE TABLE IF NOT EXISTS {table} ('
        'seq BIGSERIAL PRIMARY KEY, '
        'event_type TEXT NOT NULL, '
        'message_id TEXT NOT NULL, '
        "event_key TEXT NOT NULL DEFAULT '', "
        'thread_id TEXT, '
        'channel_id TEXT, '
        'guild_id TEXT, '
        'author_id TEXT, '
        'author_is_bot BOOLEAN, '
        'occurred_at TIMESTAMPTZ NOT NULL, '
        'text TEXT, '
        'payload JSONB NOT NULL, '
        "source TEXT NOT NULL DEFAULT '', "
        'captured_at TIMESTAMPTZ NOT NULL DEFAULT now(), '
        f'CONSTRAINT {table}_dedupe UNIQUE (message_id, event_type, event_key)'
        '); '
        f'CREATE INDEX IF NOT EXISTS {table}_thread ON {table} (thread_id); '
        f'CREATE INDEX IF NOT EXISTS {table}_occurred ON {table} (occurred_at)'
    )


def INSERT_SQL(table: str) -> str:
    """Return the fixed, positional INSERT for ``table``.

    ``ON CONFLICT DO NOTHING`` on the contract's dedupe key is what makes a
    redelivered Gateway event harmless: the Discord Gateway can repeat a
    message after a resume, and the capture log is append-only.
    """
    return (
        f'INSERT INTO {table} ({", ".join(COLUMNS)}) '
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CAST($11 AS jsonb),$12) '
        'ON CONFLICT (message_id, event_type, event_key) DO NOTHING'
    )


def _opt_text(value: Any) -> Optional[str]:
    """Coerce an id-ish value to text, mapping absent/empty to NULL.

    Snowflakes arrive as ints from discord.py and as engine string proxies
    from config, and the contract stores them as TEXT: ``'1001'`` and ``1001``
    must not become two different rows.
    """
    if value is None:
        return None
    text = str(value)
    return text or None


def _clip(value: Any) -> Optional[str]:
    """Return ``value`` as text clipped to the column budget, or None."""
    if value is None:
        return None
    return str(value)[:MAX_TEXT_CHARS]


def _event_key(event_type: str, payload: Dict[str, Any], now: datetime) -> str:
    """Return the disambiguator for the ``(message_id, event_type)`` pair.

    The unique key is what makes the log idempotent, so each event type says
    exactly what counts as "the same event twice":

    * ``message``   -- one per message, unless it is a retried text pass; each
      retry is a genuinely separate pipeline run with its own answer.
    * ``outbound``  -- one reply per message. The chunk ids are in the payload.
    * ``no_reply``  -- the reason, because one message can be skipped for
      different reasons across runs (paused, then aimed_elsewhere).
    * ``reaction``  -- user, emoji, direction and time: the same person can
      add, remove and re-add the same emoji, and all three are real events.

    The result is clipped to :data:`MAX_EVENT_KEY_CHARS`.
    """
    key = ''
    if event_type == 'no_reply':
        key = str(payload.get('reason') or '')
    elif event_type == 'reaction':
        direction = 'add' if payload.get('added') else 'remove'
        user_id = payload.get('userId') or ''
        emoji = payload.get('emoji') or ''
        stamped = payload.get('occurredAt')
        when = (
            int(stamped)
            if isinstance(stamped, (int, float)) and not isinstance(stamped, bool)
            else int(now.timestamp() * 1000)
        )
        key = f'{user_id}:{emoji}:{direction}:{when}'
    elif event_type == 'message':
        retry = payload.get('retry')
        if retry:
            key = f'retry:{int(retry)}'
    return key[:MAX_EVENT_KEY_CHARS]


def capture_row(
    event_type: str,
    metadata: Optional[Dict[str, Any]],
    payload: Optional[Dict[str, Any]],
    *,
    source: str,
    now: datetime,
) -> Dict[str, Any]:
    """Map one broadcast event onto the ``discord_events`` columns.

    Pure: the same arguments always produce the same row, which is what lets
    the mapping be tested without a database, a pipe or a thread.

    Args:
        event_type (str): ``message`` / ``outbound`` / ``no_reply`` / ``reaction``.
        metadata (dict): The node's downstream metadata contract for the event.
        payload (dict): The event-specific body, as ``_send_sse`` broadcasts it.
        source (str): The writer's label: ``captureSource``, or
            ``'discord:<node type>'`` when it is not set.
        now (datetime): Node-side event time; tz-aware.

    Returns:
        dict: One row, keyed by :data:`COLUMNS`.
    """
    metadata = metadata or {}
    payload = payload or {}

    # Exactly the body `_send_sse` broadcasts, so a reader of this table and a
    # live SSE subscriber are looking at the same object.
    body = {'schemaVersion': 1, 'eventType': event_type, 'metadata': metadata, **payload}

    message_id = _opt_text(metadata.get('messageId')) or _opt_text(metadata.get('correlationId')) or ''

    # A question asked straight in a channel IS the root of the conversation
    # it starts, so it keys itself — and so do its reply and no_reply, which
    # carry the question's own metadata. Inside a thread the node already knows
    # the root. A reaction with no threadId names some other message, so its
    # thread is genuinely unknown.
    thread_id = _opt_text(metadata.get('threadId'))
    if thread_id is None and event_type in ('message', 'outbound', 'no_reply'):
        thread_id = message_id or None

    author_is_bot = metadata.get('authorIsBot')

    return {
        'event_type': event_type,
        'message_id': message_id,
        'event_key': _event_key(event_type, payload, now),
        'thread_id': thread_id,
        'channel_id': _opt_text(metadata.get('channelId')),
        'guild_id': _opt_text(metadata.get('guildId')),
        'author_id': _opt_text(metadata.get('authorId')),
        'author_is_bot': None if author_is_bot is None else bool(author_is_bot),
        'occurred_at': now.isoformat(),
        'text': _clip(payload.get('text')),
        # `default=str` rather than a raising dump: a payload this node cannot
        # serialise must degrade to a readable repr, never drop the row.
        'payload': json.dumps(body, default=str, ensure_ascii=False),
        'source': source,
    }


def row_params(row: Dict[str, Any]) -> List[Any]:
    """Return the row's values in :data:`COLUMNS` order, for ``$1..$12``."""
    return [row[name] for name in COLUMNS]


def _invoke_param(payload: Dict[str, Any]):
    """Build the engine's ``execute`` tool invocation for ``payload``.

    Imported here rather than at module scope so this module stays loadable
    without the engine runtime, and so tests can replace one small function
    instead of stubbing ``rocketlib.types``.
    """
    from rocketlib.types import IInvokeTool  # type: ignore  # engine-only module

    return IInvokeTool.Invoke(tool_name='execute', input=payload)


def _control_envelope(param: Any):
    """Wrap a tool operation in the control-plane envelope ``control()`` takes.

    Engine-only import, deferred like ``_invoke_param`` so the module still
    loads for the pure tests.
    """
    from rocketlib.types import IInvoke  # type: ignore  # engine-only module

    return IInvoke(param=param, result=None)


def _engine_warning(message: str) -> None:
    """Log through the engine's logger when there is one."""
    try:
        from rocketlib import warning  # type: ignore  # engine-only module
    except ImportError:
        return
    warning(message)


def _short_error(exc: BaseException) -> str:
    """Return the first line of an exception, bounded, for a log line."""
    text = str(exc).strip().splitlines()
    return (text[0] if text else exc.__class__.__name__)[:300]


class CaptureWriter:
    """Writes capture rows to a database node, off the answering path.

    One writer per node process. ``submit`` is called from whichever thread is
    handling a Discord event and never blocks; a single daemon thread borrows
    a pipe, resolves the database node once, creates the table once, and runs
    the INSERTs.

    Args:
        target: The endpoint target to borrow pipes from (``getPipe`` /
            ``putPipe``).
        source (str): The writer's label, written into every row
            (``captureSource``, or ``'discord:<node type>'``).
        table (str): Table to write to; an invalid name disables capture.
        node_id (str): Configured database component id. Empty means "the only
            tool node connected to this source".
        warn (callable): One-argument logger for every message this class
            emits. Injected rather than imported so the module stays pure.
        clock (callable): Monotonic clock, for the warning window.
    """

    def __init__(
        self,
        target: Any,
        *,
        source: str,
        table: str = DEFAULT_TABLE,
        node_id: str = '',
        warn: Optional[Callable[[str], None]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._target = target
        self._source = source
        self._table = table
        self._node_id = str(node_id or '')
        self._warn = warn or _engine_warning
        self._clock = clock

        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX_ROWS)
        self._thread: Optional[threading.Thread] = None
        self._created = False
        self._disabled = False
        self._failures = 0
        self._dropped = 0
        self._last_failure_warn = 0.0
        self._last_drop_warn = 0.0

        # Refused here rather than at the first write: a name that cannot be
        # substituted into the DDL can never work, so there is nothing to
        # start and nothing to retry.
        if not is_valid_table_name(table):
            self._disabled = True
            self._warn(
                f'Discord capture: captureTable {table!r} is not a valid table name '
                f'(letters, digits and underscore, not starting with a digit, '
                f'at most {MAX_TABLE_NAME_CHARS} characters); capture is off for this run.'
            )

    # -----------------------------------------------------------------------
    # State a caller (and the tests) can read
    # -----------------------------------------------------------------------

    @property
    def disabled(self) -> bool:
        """True once capture has given up for this run."""
        return self._disabled

    @property
    def dropped(self) -> int:
        """Rows refused by a full queue and never retried."""
        return self._dropped

    @property
    def failures(self) -> int:
        """Consecutive failed writes; reset by the next success."""
        return self._failures

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    def start(self) -> None:
        """Start the worker thread. A no-op when disabled or already running."""
        if self._disabled or self._thread is not None:
            return
        # Daemon: a capture write stuck on an unresponsive database must never
        # be what keeps the node subprocess alive after the engine stops it.
        self._thread = threading.Thread(target=self._run, name='discord-capture', daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """Drain what is queued, then stop the worker. Safe to call twice."""
        thread = self._thread
        if thread is None:
            return
        # Cleared first so anything still handling a Discord event stops
        # queueing rows the worker is no longer going to read.
        self._thread = None
        try:
            self._queue.put(_STOP, timeout=max(0.0, timeout))
        except queue.Full:
            # A full queue means well over `timeout` of work is outstanding;
            # the thread is a daemon, so leaving it is the bounded choice.
            pass
        thread.join(timeout)

    def submit(self, row: Dict[str, Any]) -> None:
        """Queue one row. Never blocks, never raises."""
        if self._disabled or self._thread is None:
            return
        try:
            self._queue.put_nowait(row)
        except queue.Full:
            # The NEW row is what goes, not the oldest: the queue is ordered,
            # and dropping from the front would keep a reply whose question
            # was discarded.
            self._dropped += 1
            self._warn_throttled(
                '_last_drop_warn',
                f'Discord capture: the queue is full ({QUEUE_MAX_ROWS} rows); '
                f'{self._dropped} event(s) dropped and not retried.',
            )

    # -----------------------------------------------------------------------
    # Worker
    # -----------------------------------------------------------------------

    def _run(self) -> None:
        """Pull rows until the stop sentinel. Never lets an exception escape."""
        while True:
            row = self._queue.get()
            if row is _STOP:
                return
            try:
                self._write_one(row)
            except Exception as e:  # pragma: no cover - _write_one handles its own
                self._warn(f'Discord capture: writer thread error: {_short_error(e)}')

    def _write_one(self, row: Dict[str, Any]) -> None:
        """Write one row through the database node's ``execute`` tool."""
        if self._disabled:
            return
        pipe = None
        try:
            pipe = self._target.getPipe()
            node_id = self._resolve_node_id(pipe)
            if node_id is None:
                return
            if not self._created:
                # Before the first INSERT, and only marked done once it has
                # actually succeeded -- a CREATE that failed because nothing
                # answered must not leave the table assumed to exist.
                self._invoke(pipe, node_id, CREATE_TABLE_SQL(self._table), None)
                self._created = True
            self._invoke(pipe, node_id, INSERT_SQL(self._table), row_params(row))
        except Exception as e:
            self._on_failure(row, e)
        else:
            self._on_success()
        finally:
            if pipe is not None:
                self._target.putPipe(pipe)

    def _invoke(self, pipe: Any, node_id: str, sql: str, params: Optional[List[Any]]) -> Any:
        """Call the ``execute`` tool on ``node_id`` over ``pipe``."""
        payload: Dict[str, Any] = {'sql': sql}
        if params is not None:
            payload['params'] = params
        param = _invoke_param(payload)
        invoke = getattr(pipe, 'invoke', None)
        if callable(invoke):
            invoke(param, component_id=node_id)
        else:
            # The pipe an endpoint borrows from getPipe() is engLib's
            # IServiceFilterPipe, which has no Python `invoke`: rocketlib patches
            # that onto IFilterInstance only (filters.py `_patch_classes`). Do
            # what the patch does — wrap the operation and send it over control.
            pipe.control(getattr(param, 'lane', 'tool'), _control_envelope(param), nodeId=node_id)
        return getattr(param, 'output', None)

    def _resolve_node_id(self, pipe: Any) -> Optional[str]:
        """Return the database component id to write to, resolving it once.

        A configured ``captureNodeId`` wins outright. Otherwise the single
        node on this source's ``tool`` control edge is it; none or several is
        a wiring mistake the node cannot guess its way out of, so capture is
        turned off with one warning rather than writing to the wrong database.
        """
        if self._node_id:
            return self._node_id

        ids = [str(node_id) for node_id in (pipe.getControllerNodeIds('tool') or [])]
        if len(ids) == 1:
            self._node_id = ids[0]
            return self._node_id

        self._disabled = True
        if not ids:
            self._warn(
                'Discord capture: captureEvents is on but no database node is connected to this source '
                'with a tool control edge; capture is off for this run.'
            )
        else:
            self._warn(
                f'Discord capture: {len(ids)} tool nodes are connected to this source '
                f'({", ".join(ids)}); set captureNodeId to the database node to write to. '
                f'Capture is off for this run.'
            )
        return None

    # -----------------------------------------------------------------------
    # Reporting
    # -----------------------------------------------------------------------

    def _warn_throttled(self, slot: str, message: str) -> None:
        """Emit ``message`` at most once per window, per counter ``slot``."""
        now = self._clock()
        last = getattr(self, slot)
        if last and now - last < WARN_INTERVAL_SECONDS:
            return
        setattr(self, slot, now)
        self._warn(message)

    def _on_failure(self, row: Dict[str, Any], exc: BaseException) -> None:
        """Count a failed write and report it, throttled after the first."""
        self._failures += 1
        suffix = f' ({self._failures} failures so far)' if self._failures > 1 else ''
        self._warn_throttled(
            '_last_failure_warn',
            f'Discord capture: writing {row.get("event_type")} for message {row.get("message_id")} '
            f'to {self._node_label()}.{self._table} failed{suffix}: {_short_error(exc)}',
        )

    def _on_success(self) -> None:
        """Clear the failure streak, saying so when there was one."""
        if not self._failures:
            return
        self._warn(f'Discord capture: writes to {self._node_label()} recovered after {self._failures} failures')
        self._failures = 0
        self._last_failure_warn = 0.0

    def _node_label(self) -> str:
        """Name the database node for a log line, resolved or not."""
        return self._node_id or 'the connected database node'
