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
* **Bounded.** The queue holds 1000 rows, and every string in a row's
  payload is clipped at 65536 characters, so no row holds a multi-megabyte
  attachment text. When the queue is full the NEW row is dropped and
  counted -- dropping the oldest would discard the question and keep the
  reply, which is the wrong half.
* **Quiet when broken.** A failure no retry can fix (a refused grant, a table
  of the wrong shape, no database behind the edge) turns capture off for the
  run with one warning. Any other failure drops rows for a minute before the
  next try: the database node logs each failed statement with its values, so
  writing on into an outage would log every user's message. Warnings come at
  most once per 30 seconds with the running counts, and one line says when
  writes start working again.

The module is pure Python with no engine imports at module scope (the
``IInvokeTool`` import is deferred into ``_invoke_param``), so it loads in a
plain unit-test process as part of the node package (it imports
``text_utils``).
"""

from __future__ import annotations

import json
import queue
import re
import threading
import time

from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from .text_utils import _engine_warning, _shown_entry

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

# The UNIQUE key that makes the log idempotent. ``source`` is part of it so two
# Discord sources sharing one table each keep their own row for a message the
# both of them saw, instead of the second being taken for a redelivery.
DEDUPE_COLUMNS = ('source', 'message_id', 'event_type', 'event_key')

# The contract clips the `text` column at 8000 characters; `payload` keeps the
# text the node handed over, unclipped. A Discord message is at most 4000
# characters, so this only ever bites on a text attachment asked about on its
# own or a long answer: it keeps one of those from dominating the column every
# query selects.
MAX_TEXT_CHARS = 8000

# Every string in the stored `payload` is clipped to this (with a trailing
# `…`), so a queued row stays small: a text attachment decoded with
# textAttachmentMaxChars 0 has no limit of its own, and up to QUEUE_MAX_ROWS
# rows can wait at once. Far above anything a Discord message (4000
# characters) or a reply needs.
PAYLOAD_TEXT_MAX_CHARS = 65536

# Roughly a minute of a very busy channel. Past this the database is not
# keeping up and the right answer is to shed, not to buffer without limit.
QUEUE_MAX_ROWS = 1000

# One warning per node per window while writes are failing.
WARN_INTERVAL_SECONDS = 30.0

# After a failed write that may fix itself (the database is down or slow), how
# long rows are dropped and counted before the next one is tried. The database
# node logs every failed statement at error level together with its bound
# values, so writing every row into an outage would put every user's message
# in the server log, once per row.
BACKOFF_SECONDS = 60.0

# Postgres truncates every identifier at 63 bytes. CREATE_TABLE_SQL derives the
# constraint and index names from the table name, so a name allowed to use the
# whole budget would have those derived names truncated -- and two capture
# tables whose names differ only past the cut would then collide on them. The
# accepted name is therefore shorter by the longest suffix the DDL appends.
#
# Each suffix starts with ``$``, which a table name may not contain: index,
# constraint and table names share one namespace, so a ``_thread`` suffix
# would make the index for table ``events`` collide with a table named
# ``events_thread``.
POSTGRES_IDENTIFIER_BYTES = 63
TABLE_NAME_SUFFIXES = ('$dedupe', '$thread', '$occurred')
MAX_TABLE_NAME_CHARS = POSTGRES_IDENTIFIER_BYTES - max(len(suffix) for suffix in TABLE_NAME_SUFFIXES)

# The table name is substituted into SQL, so it must match this in full
# (``fullmatch``: ``$`` would also match before a trailing newline) and is then
# lower-cased and double-quoted, so a reserved word such as ``user`` works.
_TABLE_NAME_RE = re.compile(rf'[A-Za-z_][A-Za-z0-9_]{{0,{MAX_TABLE_NAME_CHARS - 1}}}')

# ``event_key`` is part of the dedupe key. A ``no_reply`` reason built from an
# exception message is keyed ``error``, never by its text; this clip is the
# backstop for whatever else ever reaches the key builder.
MAX_EVENT_KEY_CHARS = 200

# A configured ``captureSource`` label: short, printable, no spaces. It is a
# bind parameter, never SQL text, so this is hygiene for the readers of the
# column rather than a guard against injection.
_SOURCE_LABEL_RE = re.compile(r'[A-Za-z0-9_.:+@-]{1,128}')

# The capture SQL (identity column, JSONB, ON CONFLICT, CAST(... AS jsonb)) is
# PostgreSQL's, 10 or later for the identity column. What a database node's
# ``dialect`` tool answers for it.
POSTGRES_DIALECTS = ('postgres', 'postgresql')

# How PostgreSQL words an INSERT into a table that does not exist. Anchored to
# the start of the driver's message (or of the part after a ``prefix: ``),
# because a missing column (42703) reads ``column "x" of relation "<table>"
# does not exist`` and must not be taken for a missing table.
_MISSING_TABLE_RE = re.compile(r'(?:^|: )relation "[^"]*" does not exist')
_MISSING_TABLE_CODE_RE = re.compile(r'(?:^|: )Error 42P01: ')

# Failures no retry can fix, as the database node passes them on (the driver's
# primary message, sometimes with the exception class or SQLSTATE), each with
# the cause a warning names. Checked in order; the first match wins. A SQLSTATE
# counts only where the database node writes it (``Error <sqlstate>: ``), never
# as free text, so a file path or pid in a server message cannot match.
_LASTING_FAILURES = (
    (
        re.compile(r'\bnot owned\b'),
        'it is not a database node (it does not offer the tools capture calls)',
    ),
    (
        re.compile(r'execute tool is disabled'),
        'its execute tool is disabled; turn on Allow direct query execution (allow_execute) on that node',
    ),
    (
        re.compile(r'permission denied for |InsufficientPrivilege|(?:^|: )Error 42501: '),
        'the database user was refused (permission denied); grant it INSERT on the table',
    ),
    (
        re.compile(r'no unique or exclusion constraint matching|InvalidColumnReference|(?:^|: )Error 42P10: '),
        'the table has no unique constraint capture can use; create it as the node README shows',
    ),
    (
        re.compile(r'column "[^"]*"(?: of relation "[^"]*")? does not exist|UndefinedColumn|(?:^|: )Error 42703: '),
        'a column capture writes does not exist in the table; create it as the node README shows',
    ),
)

# A failure caused by one row's values: a PostgreSQL data exception (SQLSTATE
# class 22), or a NOT NULL, foreign key or CHECK constraint of the operator's
# table (23502, 23503, 23514), which can refuse some rows (reactions) and
# accept others; matched only where the database node writes the code
# (``SQL execution failed: Error <sqlstate>: <message>``), never as free text,
# so a path, pid or port in a server message cannot read as one. That row is
# dropped, but the database is fine, so the rows after it are written without
# a backoff.
_ROW_FAILURE_RE = re.compile(r'(?:^|: )Error (?:22[0-9A-Z]{3}|2350[23]|23514): ')

# This many rows refused in a row, with no write in between, is a table that
# cannot hold what capture writes (a column of another type, a constraint
# every row breaks), not bad rows: the next one is handled like any other
# failure, with the backoff.
MAX_ROWS_REJECTED_IN_A_ROW = 5

# The shortest row value or node id an error message is searched for (to hide
# it, or to keep it from reading as a lasting failure).
MIN_HIDDEN_CHARS = 8

# Sentinel the worker loop reads as "the queue is drained, you may stop".
_STOP = object()


def is_valid_table_name(table: Any) -> bool:
    """Return True when ``table`` is safe to substitute into the fixed DDL.

    The table name is the one part of these statements that comes from config,
    and it lands in a position no bind parameter can occupy. So it must match
    an identifier pattern in full and is refused outright otherwise -- quoting
    alone would accept names that work but read as an injection attempt in the
    logs. A name that passes is still lower-cased and quoted by
    :func:`_quoted_table`, so a reserved word is a usable table name too.
    """
    return isinstance(table, str) and bool(_TABLE_NAME_RE.fullmatch(table))


def is_valid_source_label(label: Any) -> bool:
    """Return True when ``label`` may be written as a row's ``source``."""
    return isinstance(label, str) and bool(_SOURCE_LABEL_RE.fullmatch(label))


def _quoted_table(table: str, suffix: str = '') -> str:
    """Return ``table`` (plus ``suffix``) lower-cased and double-quoted for SQL.

    Unquoted, PostgreSQL folds a name to lower case and refuses a reserved
    word (``INSERT INTO user`` is a syntax error). Quoted, any name works but
    case is significant, so the name is lower-cased first: ``Discord_Events``
    still means the table ``discord_events`` an unquoted query finds.
    """
    return f'"{(table + suffix).lower()}"'


def CREATE_TABLE_SQL(table: str) -> str:
    """Return the idempotent ``discord_events`` DDL for ``table``.

    Three statements in one string: the table and its two indexes. Every one
    is ``IF NOT EXISTS``, so this is safe to run on each process start, and
    the index and constraint names are ``table`` plus a ``$`` suffix. A table
    name may not contain ``$``, so a derived name can never be another capture
    table's name, and two capture tables can live in one database without
    colliding.

    ``table`` MUST have passed :func:`is_valid_table_name` -- callers go
    through ``CaptureWriter``, which refuses to start otherwise.

    ``seq`` is an identity column rather than ``BIGSERIAL``: a serial default
    calls ``nextval()``, which needs ``USAGE`` on the sequence, while an
    identity column needs only ``INSERT`` on the table. A user that may only
    insert into a table created beforehand then needs no other grant.
    """
    name = _quoted_table(table)
    return (
        f'CREATE TABLE IF NOT EXISTS {name} ('
        'seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, '
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
        f'CONSTRAINT {_quoted_table(table, "$dedupe")} UNIQUE ({", ".join(DEDUPE_COLUMNS)})'
        '); '
        f'CREATE INDEX IF NOT EXISTS {_quoted_table(table, "$thread")} ON {name} (thread_id); '
        f'CREATE INDEX IF NOT EXISTS {_quoted_table(table, "$occurred")} ON {name} (occurred_at)'
    )


def INSERT_SQL(table: str) -> str:
    """Return the fixed, positional INSERT for ``table``.

    ``ON CONFLICT DO NOTHING`` is what makes a redelivered Gateway event
    harmless: the Discord Gateway can repeat a message after a resume, and the
    capture log is append-only. The table's UNIQUE constraint on the dedupe
    key is what turns the repeat into a conflict.

    The clause names no conflict target on purpose. PostgreSQL requires
    ``SELECT`` on the columns of a conflict target, even for ``DO NOTHING``,
    so ``ON CONFLICT (message_id, ...)`` fails every row for a database user
    that may only ``INSERT``. Without a target any unique violation counts,
    and the only unique keys on the table are the dedupe key and ``seq``,
    which the database fills in itself.
    """
    return (
        f'INSERT INTO {_quoted_table(table)} ({", ".join(COLUMNS)}) '
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CAST($11 AS jsonb),$12) '
        'ON CONFLICT DO NOTHING'
    )


# Asks whether the capture table exists. ``to_regclass`` takes a name as SQL
# would write it (so the quoted, lower-cased one), returns NULL instead of
# raising for a missing relation, and needs no privilege on the table.
TABLE_EXISTS_SQL = 'SELECT to_regclass($1)'


def _table_exists_answer(output: Any) -> Optional[bool]:
    """Read the ``execute`` tool's answer to :data:`TABLE_EXISTS_SQL`.

    The tool returns ``{'rows': [...], 'affected_rows': N}``, one row with one
    value: the table's name when it exists, NULL when it does not. Rows are
    lists with ``row_mode: 'array'`` and dicts otherwise; both are read.

    Returns:
        Optional[bool]: True / False for a readable answer, None for anything
            else, which leaves the writer to its INSERT-first fallback.
    """
    rows = output.get('rows') if isinstance(output, dict) else getattr(output, 'rows', None)
    if not isinstance(rows, (list, tuple)) or len(rows) != 1:
        return None
    row = rows[0]
    if isinstance(row, dict):
        values = list(row.values())
    elif isinstance(row, (list, tuple)):
        values = list(row)
    else:
        return None
    if len(values) != 1:
        return None
    value = values[0]
    if value is None:
        return False
    if isinstance(value, str) and value:
        return True
    return None


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


def _scrub_nul(value: Any) -> Any:
    """Return ``value`` with every NUL character removed from every string in it.

    PostgreSQL ``text`` rejects NUL outright and ``jsonb`` rejects the
    ``\\u0000`` that ``json.dumps`` writes for it, so a single NUL fails the row
    for good. A UTF-16 ``.txt`` decoded with ``errors='ignore'`` is full of
    them. Containers are copied, never changed in place: the caller's dicts
    are the ones the SSE broadcast uses.
    """
    if isinstance(value, str):
        return value.replace('\x00', '')
    if isinstance(value, dict):
        return {_scrub_nul(key): _scrub_nul(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub_nul(item) for item in value]
    return value


def _clip_strings(value: Any) -> Any:
    """Return ``value`` with every string in it clipped to :data:`PAYLOAD_TEXT_MAX_CHARS`.

    A clipped string ends in ``…`` and is exactly the cap long. Containers are
    copied, never changed in place, as in :func:`_scrub_nul`.
    """
    if isinstance(value, str):
        if len(value) <= PAYLOAD_TEXT_MAX_CHARS:
            return value
        return value[: PAYLOAD_TEXT_MAX_CHARS - 1] + '…'
    if isinstance(value, dict):
        return {_clip_strings(key): _clip_strings(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clip_strings(item) for item in value]
    return value


def _occurred_at(event_type: str, metadata: Dict[str, Any], now: datetime) -> str:
    """Return the row's ``occurred_at``: when the event happened.

    A ``message`` happened when Discord says it was sent, its ``createdAt``,
    so a message replayed by backfill at startup keeps its real time. Every
    other event carries the question's metadata, whose ``createdAt`` is not
    its own time, so it happened when the node saw it. A ``createdAt`` that
    does not parse, or that has no time zone (a ``TIMESTAMPTZ`` would read it
    as the server's local time), falls back to ``now`` too.
    """
    if event_type == 'message':
        created = metadata.get('createdAt')
        if isinstance(created, str) and created:
            try:
                parsed = datetime.fromisoformat(created)
            except ValueError:
                parsed = None
            if parsed is not None and parsed.tzinfo is not None:
                return parsed.isoformat()
    return now.isoformat()


def _message_part(metadata: Dict[str, Any], payload: Dict[str, Any]) -> str:
    """Name which part of one Discord message a ``message`` event is.

    A message with attachments opens one object per part, all with the same
    message id: the text pass at ``groupIndex`` 0 and each attachment at its
    own index. Both come from the broadcast body, so a key rebuilt later from
    the task's run log comes out the same.
    """
    lane = str(payload.get('lane') or 'text')
    try:
        index = int(metadata.get('groupIndex') or 0)
    except (TypeError, ValueError):
        index = 0
    if lane == 'text' and index == 0:
        return 'text'
    return f'{lane}:{index}'


# The no_reply reasons the node emits as fixed codes (see IEndpoint).
NO_REPLY_REASON_CODES = frozenset(
    {'no_answer', 'non_answer', 'model_error', 'send_failed', 'shutdown', 'paused', 'aimed_elsewhere', 'timeout'}
)


def _event_key(event_type: str, metadata: Dict[str, Any], payload: Dict[str, Any], now: datetime) -> str:
    """Return the disambiguator for the ``(message_id, event_type)`` pair.

    The unique key is what makes the log idempotent, so each event type says
    exactly what counts as "the same event twice":

    * ``message``   -- one per part of the message: ``text`` for the text
      pass, ``<lane>:<groupIndex>`` for each attachment (``binary:1``,
      ``text:2`` for a text file asked about on its own), with ``:retry:<n>``
      appended for a retried pass, which is a genuinely separate pipeline run
      with its own answer.
    * ``outbound``  -- one reply per message. The chunk ids are in the payload.
    * ``no_reply``  -- the reason code, because one message can be skipped for
      different reasons across runs (paused, then aimed_elsewhere); a reason
      that is exception text becomes ``error``, since that text can differ
      between deliveries of the same message (and the row never stores it).
    * ``reaction``  -- user, emoji, direction and time: the same person can
      add, remove and re-add the same emoji, and all three are real events.

    The result is clipped to :data:`MAX_EVENT_KEY_CHARS`.
    """
    key = ''
    if event_type == 'no_reply':
        # A known reason is its own key. Anything else is exception text that
        # can differ between deliveries of one message, so it shares one stable
        # key (and capture_row stores ``error`` in its place).
        reason = str(payload.get('reason') or '')
        key = reason if reason in NO_REPLY_REASON_CODES else 'error'
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
        key = _message_part(metadata, payload)
        retry = payload.get('retry')
        if retry:
            key = f'{key}:retry:{int(retry)}'
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
        payload (dict): The event-specific body, as ``_send_sse`` broadcasts it
            (for a ``message``, with the unclipped text the row should store).
        source (str): The writer's label: ``captureSource``, or
            ``'discord:<node type>'`` when it is not set.
        now (datetime): Node-side event time; tz-aware. A ``message`` row's
            ``occurred_at`` uses the metadata's ``createdAt`` instead.

    Returns:
        dict: One row, keyed by :data:`COLUMNS`.
    """
    metadata = _scrub_nul(metadata or {})
    payload = _scrub_nul(payload or {})

    # A no_reply reason that is not one of the fixed codes is exception text,
    # which can carry account details, key fragments or internal URLs. The
    # live broadcast keeps it; the durable row stores only ``error``.
    if event_type == 'no_reply' and str(payload.get('reason') or '') not in NO_REPLY_REASON_CODES:
        payload = dict(payload, reason='error')

    # The body `_send_sse` broadcasts, so a reader of this table and a live SSE
    # subscriber are looking at the same object -- except that a `message`
    # row's text is the user's whole message, where the broadcast clips it at
    # 2000 characters (the node passes the text it wants stored). Every string
    # in it is clipped at PAYLOAD_TEXT_MAX_CHARS, so a queued row stays small.
    body = _clip_strings({'schemaVersion': 1, 'eventType': event_type, 'metadata': metadata, **payload})

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
        'event_key': _event_key(event_type, metadata, payload, now),
        'thread_id': thread_id,
        'channel_id': _opt_text(metadata.get('channelId')),
        'guild_id': _opt_text(metadata.get('guildId')),
        'author_id': _opt_text(metadata.get('authorId')),
        'author_is_bot': None if author_is_bot is None else bool(author_is_bot),
        'occurred_at': _occurred_at(event_type, metadata, now),
        'text': _clip(payload.get('text')),
        # `default=str` rather than a raising dump: a payload this node cannot
        # serialise must degrade to a readable repr, never drop the row; that
        # repr is scrubbed of NUL like everything else.
        'payload': json.dumps(body, default=lambda item: _clip_strings(_scrub_nul(str(item))), ensure_ascii=False),
        'source': source,
    }


def row_params(row: Dict[str, Any]) -> List[Any]:
    """Return the row's values in :data:`COLUMNS` order, for ``$1..$12``."""
    return [row[name] for name in COLUMNS]


def _invoke_param(payload: Dict[str, Any], tool_name: str = 'execute'):
    """Build the engine's tool invocation of ``tool_name`` for ``payload``.

    Imported here rather than at module scope so this module stays loadable
    without the engine runtime, and so tests can replace one small function
    instead of stubbing ``rocketlib.types``.
    """
    from rocketlib.types import IInvokeTool  # type: ignore  # engine-only module

    return IInvokeTool.Invoke(tool_name=tool_name, input=payload)


def _control_envelope(param: Any):
    """Wrap a tool operation in the control-plane envelope ``control()`` takes.

    Engine-only import, deferred like ``_invoke_param`` so the module still
    loads for the pure tests.
    """
    from rocketlib.types import IInvoke  # type: ignore  # engine-only module

    return IInvoke(param=param, result=None)


def _is_missing_table(exc: BaseException, hide: tuple = ()) -> bool:
    """Return True when a failed INSERT failed because the table does not exist.

    PostgreSQL reports it as SQLSTATE 42P01, ``relation "<name>" does not
    exist``; the database node passes the driver's message through, so the
    text is what reaches this side of the pipe.

    Args:
        exc (BaseException): What the INSERT raised.
        hide (tuple): Row values taken out of the message first, so text the
            user wrote cannot make a data error read as a missing table.

    Returns:
        bool: True for a missing table.
    """
    text = str(exc)
    for value in hide:
        if _is_hideable(value):
            text = text.replace(value, '')
    return bool(_MISSING_TABLE_RE.search(text)) or 'UndefinedTable' in text or bool(_MISSING_TABLE_CODE_RE.search(text))


def _is_hideable(value: Any) -> bool:
    """True when ``value`` is long enough to be replaced inside an error message.

    A shorter value is left alone: replacing a one-letter message everywhere
    it occurs would garble the error (every ``e`` in ``permission denied``),
    and a value that short gives nothing away.
    """
    return isinstance(value, str) and len(value.strip()) >= MIN_HIDDEN_CHARS


class _LastingFailure(Exception):
    """A failed write that no later row can get past; carries the cause to report."""


def _lasting_cause(exc: BaseException, hide: tuple = ()) -> Optional[str]:
    """Name the cause when ``exc`` is a failure no retry can fix, else None.

    Args:
        exc (BaseException): The failed call's exception.
        hide (tuple): The row's values, removed before matching: a driver
            error that quotes the user's words ("permission denied when I
            log in") must not read as a refused grant.

    Returns:
        Optional[str]: A fixed description of the cause (never text from the
            row), or None for a failure that may fix itself.
    """
    if isinstance(exc, _LastingFailure):
        return str(exc)
    text = str(exc)
    for value in hide:
        if _is_hideable(value):
            text = text.replace(value, '')
    for pattern, cause in _LASTING_FAILURES:
        if pattern.search(text):
            return cause
    return None


def _is_row_failure(exc: BaseException, hide: tuple = ()) -> bool:
    """Whether a failed write was refused for that row's own values.

    Args:
        exc (BaseException): What the write raised.
        hide (tuple): Row values taken out of the message first, so text the
            user wrote cannot make the failure read as a row failure.

    Returns:
        bool: True for a data exception or a row-level integrity check.
    """
    text = str(exc)
    for value in hide:
        if _is_hideable(value):
            text = text.replace(value, '')
    return _ROW_FAILURE_RE.search(text) is not None


def _short_error(exc: BaseException, hide: tuple = ()) -> str:
    """Return the first line of an exception, bounded, for a log line.

    Args:
        exc (BaseException): The exception.
        hide (tuple): Values replaced before the line is cut, so one the
            driver quoted never reaches the log: a string becomes
            ``<row text>``, a ``(value, placeholder)`` pair its placeholder.
            Only values of at least :data:`MIN_HIDDEN_CHARS` characters.

    Returns:
        str: The first line, at most 300 characters.
    """
    text = str(exc).strip().splitlines()
    line = text[0] if text else exc.__class__.__name__
    for item in hide:
        value, placeholder = item if isinstance(item, tuple) else (item, '<row text>')
        if _is_hideable(value):
            line = line.replace(value, placeholder)
    return line[:300]


class CaptureWriter:
    """Writes capture rows to a database node, off the answering path.

    One writer per node process. ``submit`` is called from whichever thread is
    handling a Discord event and never blocks; a single daemon thread borrows
    a pipe, resolves the database node and checks it is PostgreSQL once, asks
    once whether the table exists (creating it when it does not), and runs the
    INSERTs, creating the table again should an INSERT still find it missing.

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
        # Whether the node id is known to be on this source's tool edge.
        self._node_checked = False
        self._warn = warn or _engine_warning
        self._clock = clock

        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX_ROWS)
        self._thread: Optional[threading.Thread] = None
        # Set by stop() once the writer has had its chance to drain: the worker
        # then borrows no more pipes, and drops and counts what is left.
        self._stopping = threading.Event()
        # Set when stop() ran out of time with a write still in flight: the
        # node is being torn down, so the pipe that write holds is not handed
        # back to it. Nothing in the engine waits for a borrowed pipe.
        self._abandoned = threading.Event()
        self._dialect_checked = False
        self._table_checked = False
        self._disabled = False
        self._failures = 0
        # While a failure that may fix itself backs off: the clock reading
        # before which rows are dropped, and how many were.
        self._retry_at = 0.0
        self._skipped = 0
        # Rows the database refused for their own values (no backoff).
        self._rows_rejected = 0
        self._rejected_in_a_row = 0
        self._dropped = 0
        self._unwritten = 0
        self._dropped_lock = threading.Lock()
        # Held across submit()'s running check and its put, and while stop()
        # closes the writer: no row can then land in the queue behind the stop
        # marker, where the worker would never read it.
        self._submit_lock = threading.Lock()
        self._closed = False
        self._last_failure_warn = 0.0
        self._last_drop_warn = 0.0
        self._last_late_warn = 0.0
        self._last_row_warn = 0.0

        # Refused here rather than at the first write: a name that cannot be
        # substituted into the DDL can never work, so there is nothing to
        # start and nothing to retry.
        if not is_valid_table_name(table):
            self._disabled = True
            self._warn(
                f'Discord capture: captureTable {_shown_entry(table)} is not a valid table name '
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
    def unwritten(self) -> int:
        """Rows submitted after stop(), or still queued when a busy writer was stopped."""
        return self._unwritten

    @property
    def rows_rejected(self) -> int:
        """Rows the database refused for their own values this run (not retried)."""
        return self._rows_rejected

    @property
    def failures(self) -> int:
        """Consecutive failed writes; reset by the next success."""
        return self._failures

    @property
    def skipped(self) -> int:
        """Rows dropped while backing off after a failed write; reset by the next success."""
        return self._skipped

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    def start(self) -> None:
        """Start the worker thread. A no-op when disabled or already running."""
        if self._disabled or self._thread is not None:
            return
        # Daemon: a capture write stuck on an unresponsive database must never
        # be what keeps the node subprocess alive after the engine stops it.
        thread = threading.Thread(target=self._run, name='discord-capture', daemon=True)
        with self._submit_lock:
            self._closed = False
            self._thread = thread
        thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """Drain what is queued, then stop the worker. Safe to call twice.

        ``timeout`` is the whole budget: queueing the stop marker behind the
        rows already waiting and the worker writing them share it. If the
        worker is still busy after that (a write stuck on the database), it is
        told to stop: once the stuck call returns it borrows no more pipes,
        does not hand back the one it held (the node may already be torn
        down), drops the rows still queued and reports exactly how many. The
        thread is a daemon, so a call that never returns cannot keep the
        process alive either.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        with self._submit_lock:
            thread = self._thread
            if thread is None:
                return
            # Closed before the stop marker is queued, under the lock submit()
            # holds while it queues: every row is then either ahead of the
            # marker, so drained, or refused and counted by submit().
            self._thread = None
            self._closed = True
        try:
            self._queue.put(_STOP, timeout=max(0.0, timeout))
        except queue.Full:
            # A full queue means well over `timeout` of work is outstanding:
            # stop now rather than wait for room the worker may never make.
            self._stopping.set()
        thread.join(max(0.0, deadline - time.monotonic()))
        if self._rows_rejected:
            self._warn(
                f'Discord capture: the database refused {self._rows_rejected} row(s) this run for their own values; '
                f'they were not written'
            )
        if thread.is_alive():
            # Set before _stopping, which is what the worker checks first.
            self._abandoned.set()
            self._stopping.set()
            # Said now, because the stuck call may never return to report the
            # exact count; the worker adds that if it does.
            self._warn(
                f'Discord capture: still writing at stop; about {self._queue.qsize()} queued row(s) will be dropped'
            )

    def submit(self, row: Dict[str, Any]) -> None:
        """Queue one row. Never blocks, never raises.

        A row submitted after :meth:`stop` -- by a handler that took the
        writer just before Stop -- is not written; it is counted in
        :attr:`unwritten` and reported, never lost silently.
        """
        if self._disabled:
            return
        with self._submit_lock:
            if self._thread is None:
                if not self._closed:
                    return  # never started
                late = True
            else:
                try:
                    self._queue.put_nowait(row)
                    return
                except queue.Full:
                    late = False
        if late:
            with self._dropped_lock:
                self._unwritten += 1
                unwritten = self._unwritten
            self._warn_throttled(
                '_last_late_warn',
                f'Discord capture: {unwritten} event(s) arrived after capture stopped and were not written.',
            )
        else:
            # The NEW row is what goes, not the oldest: the queue is ordered,
            # and dropping from the front would keep a reply whose question
            # was discarded.
            # Events are submitted from several worker threads at once.
            with self._dropped_lock:
                self._dropped += 1
                dropped = self._dropped
            self._warn_throttled(
                '_last_drop_warn',
                f'Discord capture: the queue is full ({QUEUE_MAX_ROWS} rows); '
                f'{dropped} event(s) dropped and not retried.',
            )

    # -----------------------------------------------------------------------
    # Worker
    # -----------------------------------------------------------------------

    def _run(self) -> None:
        """Pull rows until the stop sentinel or ``stop()``. Never lets an exception escape."""
        while True:
            row = self._queue.get()
            if row is _STOP:
                return
            # Checked before every write, so nothing borrows a pipe once the
            # node has stopped.
            if self._stopping.is_set():
                self._drop_remaining(row)
                return
            try:
                self._write_one(row)
            except Exception as e:  # pragma: no cover - _write_one handles its own
                self._warn(f'Discord capture: writer thread error: {_short_error(e)}')

    def _drop_remaining(self, row: Any) -> None:
        """Drop ``row`` and everything still queued, and say exactly how many."""
        unwritten = 1
        while True:
            try:
                row = self._queue.get_nowait()
            except queue.Empty:
                break
            if row is not _STOP:
                unwritten += 1
        with self._dropped_lock:
            self._unwritten += unwritten
        self._warn(f'Discord capture: stopped with {unwritten} row(s) unwritten (the writer was still busy)')

    def _write_one(self, row: Dict[str, Any]) -> None:
        """Write one row through the database node's ``execute`` tool.

        A failure no retry can fix turns capture off for the run; any other
        failure starts a :data:`BACKOFF_SECONDS` window in which rows are
        dropped and counted without borrowing a pipe.
        """
        if self._disabled:
            return
        if self._retry_at and self._clock() < self._retry_at:
            self._skipped += 1
            return
        pipe = None
        try:
            pipe = self._target.getPipe()
            node_id = self._resolve_node_id(pipe)
            if node_id is None:
                return
            if not self._dialect_checked and not self._check_dialect(pipe, node_id):
                return
            if not self._table_checked:
                self._ensure_table(pipe, node_id)
            try:
                self._invoke(pipe, node_id, INSERT_SQL(self._table), row_params(row))
            except Exception as e:
                # DDL only for a table that is really missing: a database user
                # allowed only to INSERT into an existing table must never
                # need CREATE rights. This covers a table dropped after the
                # check, or a check whose answer could not be read.
                if not _is_missing_table(e, hide=(row.get('payload'), row.get('text'))):
                    raise
                self._create_table(pipe, node_id)
                self._invoke(pipe, node_id, INSERT_SQL(self._table), row_params(row))
        except Exception as e:
            cause = _lasting_cause(e, hide=(row.get('payload'), row.get('text')))
            if cause is not None:
                self._give_up(cause)
            elif _is_row_failure(e, hide=(row.get('payload'), row.get('text'))):
                self._on_row_failure(row, e)
            else:
                self._on_failure(row, e)
        else:
            self._rejected_in_a_row = 0
            self._on_success()
        finally:
            if pipe is not None and not self._abandoned.is_set():
                self._target.putPipe(pipe)

    def _ensure_table(self, pipe: Any, node_id: str) -> None:
        """Before the first INSERT of a run, create the table if it does not exist.

        Without this, the first row into a new table is an INSERT that fails,
        and the database node logs every failed statement at error level with
        its bound parameters -- the user's question among them. The check
        never fails that way. It runs once per run: a check that raises is a
        failed write, and a later row asks again; a CREATE that fails ends
        capture (see :meth:`_create_table`); an answer that cannot be read
        leaves the INSERT-first fallback to do the work.
        """
        output = self._call_tool(
            pipe,
            node_id,
            'execute',
            {'sql': TABLE_EXISTS_SQL, 'params': [_quoted_table(self._table)], 'row_mode': 'array'},
        )
        if _table_exists_answer(output) is False:
            self._create_table(pipe, node_id)
        self._table_checked = True

    def _create_table(self, pipe: Any, node_id: str) -> None:
        """Create the missing capture table, or raise :class:`_LastingFailure`.

        The table was just found missing, so the database answered a moment
        ago: a CREATE that fails now is a missing right or a clash with an
        object of that name, which the next row would only repeat. The
        statement binds no values, so its error carries no row text.
        """
        try:
            self._invoke(pipe, node_id, CREATE_TABLE_SQL(self._table), None)
        except Exception as e:
            raise _LastingFailure(f'the table does not exist and could not be created ({_short_error(e)})') from e

    def _invoke(self, pipe: Any, node_id: str, sql: str, params: Optional[List[Any]]) -> Any:
        """Call the ``execute`` tool on ``node_id`` over ``pipe``."""
        payload: Dict[str, Any] = {'sql': sql}
        if params is not None:
            payload['params'] = params
        return self._call_tool(pipe, node_id, 'execute', payload)

    def _call_tool(self, pipe: Any, node_id: str, tool_name: str, payload: Dict[str, Any]) -> Any:
        """Call ``tool_name`` on ``node_id`` over ``pipe`` and return its output."""
        param = _invoke_param(payload, tool_name)
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

    def _check_dialect(self, pipe: Any, node_id: str) -> bool:
        """Ask the database node its dialect once; True when it is PostgreSQL.

        The capture SQL is PostgreSQL's, so any other database would fail
        every row. Capture is turned off with one warning instead. A failed
        call raises and counts as a failed write, and the next row asks again.
        """
        output = self._call_tool(pipe, node_id, 'dialect', {})
        dialect = output.get('dialect') if isinstance(output, dict) else getattr(output, 'dialect', None)
        dialect = str(dialect or '')
        self._dialect_checked = True
        if dialect.lower() in POSTGRES_DIALECTS:
            return True
        if not dialect:
            # A node that does not own the tool lets the call through
            # unanswered rather than raising.
            self._give_up('it is not a database node (it gave no answer to the dialect tool)')
            return False
        self._disabled = True
        self._warn(
            f'Discord capture: {self._node_label()} is a {dialect!r} database, and capture writes to '
            f'PostgreSQL only; capture is off for this run.'
        )
        return False

    def _resolve_node_id(self, pipe: Any) -> Optional[str]:
        """Return the database component id to write to, resolving it once.

        A configured ``captureNodeId`` wins, once it is found among the nodes
        on this source's ``tool`` control edge: one that is not there (a typo,
        or a node wired to something else) would fail every row, so capture
        is turned off with one warning instead. Otherwise the single node on
        that edge is it; none or several is a wiring mistake the node cannot
        guess its way out of, so capture is turned off with one warning rather
        than writing to the wrong database.
        """
        if self._node_id and self._node_checked:
            return self._node_id

        ids = [str(node_id) for node_id in (pipe.getControllerNodeIds('tool') or [])]
        if self._node_id:
            self._node_checked = True
            if self._node_id in ids:
                return self._node_id
            self._disabled = True
            self._warn(
                f'Discord capture: captureNodeId {_shown_entry(self._node_id)} is not connected to this source '
                f'with a tool control edge; capture is off for this run.'
            )
            return None

        if len(ids) == 1:
            self._node_id = ids[0]
            self._node_checked = True
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

    def _give_up(self, cause: str) -> None:
        """Turn capture off for the run, with one warning naming ``cause``.

        For a failure no retry can fix: writing on would fail every row, and
        the database node would log each one with its values.
        """
        self._disabled = True
        self._warn(
            f'Discord capture: writing to {self._node_label()} table {self._table_label()} cannot work: '
            f'{cause}; capture is off for this run.'
        )

    def _on_row_failure(self, row: Dict[str, Any], exc: BaseException) -> None:
        """Count a row the database rejected for its own values, without a backoff.

        The database answered, so the next row is written as usual; only this
        one is lost. Reported like any failure, throttled after the first.

        Args:
            row (Dict[str, Any]): The row that was refused.
            exc (BaseException): What the write raised.

        Returns:
            None
        """
        self._rows_rejected += 1
        self._rejected_in_a_row += 1
        if self._rejected_in_a_row >= MAX_ROWS_REJECTED_IN_A_ROW:
            # Every row refused: a column that cannot hold what capture writes,
            # not bad rows. Wait like after any other failure, then count anew.
            self._rejected_in_a_row = 0
            self._on_failure(row, exc, streak=MAX_ROWS_REJECTED_IN_A_ROW)
            return
        count = f' ({self._rows_rejected} rows rejected so far)' if self._rows_rejected > 1 else ''
        error = _short_error(exc, hide=(row.get('payload'), row.get('text'), (self._node_id, '<captureNodeId>')))
        # Its own throttle slot: a rejected row must not hide the warning for
        # an outage that starts right after it.
        self._warn_throttled(
            '_last_row_warn',
            f'Discord capture: {self._node_label()} table {self._table_label()} refused the {row.get("event_type")} '
            f'row for message {row.get("message_id")}{count}: {error}; this row is dropped.',
        )

    def _on_failure(self, row: Dict[str, Any], exc: BaseException, streak: int = 0) -> None:
        """Count a failed write, start the backoff and report it, throttled after the first.

        Args:
            row (Dict[str, Any]): The row that failed.
            exc (BaseException): What the write raised.
            streak (int): When set, this many rows in a row were refused for
                their values, which the warning names as the cause.

        Returns:
            None
        """
        self._failures += 1
        self._retry_at = self._clock() + BACKOFF_SECONDS
        if not streak:
            # A failure of the database itself ends any run of refused rows.
            self._rejected_in_a_row = 0
        counts = []
        if self._failures > 1:
            counts.append(f'{self._failures} failures so far')
        if self._skipped:
            counts.append(f'{self._skipped} row(s) dropped while waiting to retry')
        if streak:
            counts.insert(
                0,
                f'{streak} rows in a row refused, so the table likely has a column of another type or a constraint every row breaks',
            )
        suffix = f' ({", ".join(counts)})' if counts else ''
        # The driver's message can quote a bound value: never the user's text.
        # Nor the node id, which may be a secret pasted into captureNodeId.
        error = _short_error(exc, hide=(row.get('payload'), row.get('text'), (self._node_id, '<captureNodeId>')))
        self._warn_throttled(
            '_last_failure_warn',
            f'Discord capture: writing {row.get("event_type")} for message {row.get("message_id")} '
            f'to {self._node_label()} table {self._table_label()} failed{suffix}: {error}. '
            f'Rows are dropped until writing is tried again in {int(BACKOFF_SECONDS)} seconds.',
        )

    def _on_success(self) -> None:
        """Clear the failure streak and the backoff, saying so when there was one."""
        self._retry_at = 0.0
        if not self._failures:
            return
        skipped = f'; {self._skipped} row(s) were dropped while waiting to retry' if self._skipped else ''
        self._warn(
            f'Discord capture: writes to {self._node_label()} recovered after {self._failures} failures{skipped}'
        )
        self._failures = 0
        self._skipped = 0
        self._last_failure_warn = 0.0

    def _node_label(self) -> str:
        """Name the database node for a log line, resolved or not.

        An id found on this source's tool edge is a component id, shown
        whole; one not checked yet is still a raw configured value, and is
        clipped like any other.
        """
        if not self._node_id:
            return 'the connected database node'
        return repr(self._node_id) if self._node_checked else _shown_entry(self._node_id)

    def _table_label(self) -> str:
        """Name the table for a log line. The writer only runs with a name that passed its check."""
        return repr(self._table)
