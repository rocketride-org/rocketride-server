# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the Discord node's opt-in event capture (``capture.py``).

The node already broadcasts every event it handles over SSE, which is live-only:
nothing that was not subscribed at the time can ever read it. ``captureEvents``
adds a durable copy, written server-side into a database node wired to this
source by a ``tool`` control edge, against the ``discord_events`` contract.

Three things are pinned here, in order of how badly they break if they drift:

1. ``capture_row`` — the column mapping and the ``event_key`` rules. The
   dedupe key is ``(message_id, event_type, event_key)``, so an event_key that
   drifts either loses rows to ON CONFLICT or stops de-duplicating a redelivery.
2. ``CaptureWriter`` — that it is genuinely off the answering path: ``submit``
   never blocks, a full queue drops rather than waits, and nothing a failing
   database does can escape the writer thread.
3. ``IEndpoint`` — off means off (no thread, no ``getControllerNodeIds``), and
   on means the bot still answers when every single write raises.

``capture.py`` is a pure module with no engine imports, so it is loaded
straight from its file path the way ``text_utils`` is in ``test_discord.py``.
The IEndpoint tests reuse the synthetic-package bootstrap from
``test_process_message.py``.
"""

import importlib.util
import json
import os
import queue
import re
import sys
import threading
import time
import types
from datetime import datetime, timezone
from unittest import mock

import pytest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../src/nodes/discord'))
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')


def _load_capture():
    """Load the node's capture module directly from its file path."""
    path = os.path.join(_NODE_DIR, 'capture.py')
    spec = importlib.util.spec_from_file_location('discord_capture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = _load_capture()
capture_row = capture.capture_row
row_params = capture.row_params
CaptureWriter = capture.CaptureWriter
CREATE_TABLE_SQL = capture.CREATE_TABLE_SQL
INSERT_SQL = capture.INSERT_SQL
COLUMNS = capture.COLUMNS
MAX_TEXT_CHARS = capture.MAX_TEXT_CHARS
QUEUE_MAX_ROWS = capture.QUEUE_MAX_ROWS


NOW = datetime(2026, 3, 4, 5, 6, 7, 890000, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)


def _metadata(**overrides):
    """The node's downstream metadata contract for a channel message."""
    meta = {
        'messageId': '1001',
        'channelId': '2002',
        'threadId': None,
        'parentChannelId': None,
        'guildId': '3003',
        'createdAt': '2026-03-04T05:06:00+00:00',
        'authorId': '4004',
        'authorIsBot': False,
        'botUserId': '9009',
        'correlationId': '1001',
        'groupIndex': 0,
        'groupSize': 1,
    }
    meta.update(overrides)
    return meta


# ===========================================================================
# capture_row — the discord_events column mapping
# ===========================================================================


class TestCaptureRowColumns:
    """Every discord_events column, for every event type the node emits."""

    def test_a_channel_question_threads_on_its_own_message_id(self):
        """A question asked in a channel IS the thread root, so it keys itself."""
        row = capture_row(
            'message',
            _metadata(),
            {'lane': 'text', 'text': 'how do I deploy?', 'contextChars': 0},
            source='discord:discord_1',
            now=NOW,
        )
        assert row['event_type'] == 'message'
        assert row['message_id'] == '1001'
        assert row['event_key'] == ''
        assert row['thread_id'] == '1001'
        assert row['channel_id'] == '2002'
        assert row['guild_id'] == '3003'
        assert row['author_id'] == '4004'
        assert row['author_is_bot'] is False
        assert row['occurred_at'] == NOW.isoformat()
        assert row['text'] == 'how do I deploy?'
        assert row['source'] == 'discord:discord_1'

    def test_a_thread_follow_up_threads_on_the_thread_id(self):
        """In a thread the node already knows the root; the message id is not it."""
        row = capture_row(
            'message',
            _metadata(messageId='1002', threadId='1001', parentChannelId='2002', channelId='1001'),
            {'lane': 'text', 'text': 'still stuck', 'contextChars': 412},
            source='discord:discord_1',
            now=NOW,
        )
        assert row['message_id'] == '1002'
        assert row['thread_id'] == '1001'

    def test_every_column_in_the_contract_is_produced(self):
        """A missing key would bind the wrong value into the next column."""
        row = capture_row('message', _metadata(), {'text': 'x'}, source='discord:d1', now=NOW)
        assert set(row) == set(COLUMNS)

    def test_row_params_are_the_twelve_columns_in_insert_order(self):
        """The INSERT is positional: order IS the mapping."""
        row = capture_row('message', _metadata(), {'text': 'x'}, source='discord:d1', now=NOW)
        params = row_params(row)
        assert len(params) == 12
        assert params == [row[name] for name in COLUMNS]

    def test_a_bot_author_is_recorded_as_such(self):
        row = capture_row('message', _metadata(authorIsBot=True), {'text': 'x'}, source='s', now=NOW)
        assert row['author_is_bot'] is True

    def test_absent_optional_ids_become_null_not_empty_strings(self):
        """A DM has no guild; '' and NULL are different answers to "which guild"."""
        row = capture_row(
            'message',
            _metadata(guildId=None, authorId=None, authorIsBot=None),
            {'text': 'x'},
            source='s',
            now=NOW,
        )
        assert row['guild_id'] is None
        assert row['author_id'] is None
        assert row['author_is_bot'] is None

    def test_the_message_id_falls_back_to_the_correlation_id(self):
        """``message_id`` is NOT NULL, and every event carries a correlation id."""
        meta = _metadata()
        meta.pop('messageId')
        row = capture_row('no_reply', meta, {'reason': 'paused'}, source='s', now=NOW)
        assert row['message_id'] == '1001'

    def test_a_skipped_message_records_its_own_text(self):
        """A paused thread emits no `message` event, so the no_reply row IS the record."""
        row = capture_row(
            'no_reply',
            _metadata(messageId='1002', threadId='1001'),
            {'reason': 'paused', 'text': 'I will take this one'},
            source='s',
            now=NOW,
        )
        assert row['text'] == 'I will take this one'
        assert row['event_key'] == 'paused'
        assert row['thread_id'] == '1001'

    def test_ids_arriving_as_numbers_are_stored_as_text(self):
        """Discord snowflakes are TEXT in the contract; an int would not match."""
        row = capture_row(
            'message',
            _metadata(messageId=1001, channelId=2002),
            {'text': 'x'},
            source='s',
            now=NOW,
        )
        assert row['message_id'] == '1001'
        assert row['channel_id'] == '2002'


class TestCaptureRowEventKeys:
    """The ``event_key`` rules, which are what the unique key dedupes on."""

    def test_a_plain_message_has_an_empty_key(self):
        row = capture_row('message', _metadata(), {'text': 'x'}, source='s', now=NOW)
        assert row['event_key'] == ''

    def test_a_retried_text_pass_is_keyed_by_its_attempt(self):
        """Each retry is a separate pipeline run and must not collapse into one row."""
        row = capture_row('message', _metadata(), {'text': 'x', 'retry': 2}, source='s', now=NOW)
        assert row['event_key'] == 'retry:2'

    def test_an_outbound_event_has_an_empty_key(self):
        """One reply per message; the chunk ids live in the payload."""
        row = capture_row(
            'outbound',
            _metadata(),
            {'text': 'here you go', 'messageIds': ['5005', '5006'], 'destination': 'reply'},
            source='s',
            now=NOW,
        )
        assert row['event_key'] == ''
        assert row['text'] == 'here you go'

    def test_a_no_reply_event_is_keyed_by_its_reason(self):
        """One message can be skipped for different reasons across runs."""
        row = capture_row('no_reply', _metadata(), {'reason': 'aimed_elsewhere'}, source='s', now=NOW)
        assert row['event_key'] == 'aimed_elsewhere'
        assert row['text'] is None

    def test_a_reaction_is_keyed_by_user_emoji_direction_and_time(self):
        """The same user can add, remove and re-add the same emoji."""
        row = capture_row(
            'reaction',
            _metadata(authorId='7007'),
            {'emoji': '✅', 'added': True, 'userId': '7007'},
            source='s',
            now=NOW,
        )
        assert row['event_key'] == f'7007:✅:add:{NOW_MS}'

    def test_a_removed_reaction_keys_the_other_direction(self):
        row = capture_row(
            'reaction',
            _metadata(),
            {'emoji': '❌', 'added': False, 'userId': '7007'},
            source='s',
            now=NOW,
        )
        assert row['event_key'] == f'7007:❌:remove:{NOW_MS}'

    def test_a_runaway_reason_is_clipped_to_the_key_budget(self):
        """A reason built from an exception must not blow up the dedupe key."""
        row = capture_row('no_reply', _metadata(), {'reason': 'x' * 5000}, source='s', now=NOW)

        assert row['event_key'] == 'x' * capture.MAX_EVENT_KEY_CHARS

    def test_a_reply_or_no_reply_to_a_channel_question_carries_the_question_as_thread(self):
        """outbound/no_reply carry the QUESTION's metadata, so they belong to the thread it roots."""
        for event_type, payload in (
            ('outbound', {'text': 'hi', 'messageIds': [], 'destination': 'thread'}),
            ('no_reply', {'reason': 'paused'}),
        ):
            row = capture_row(event_type, _metadata(), payload, source='s', now=NOW)
            assert row['thread_id'] == row['message_id'], event_type

    def test_a_reaction_in_a_channel_has_no_thread(self):
        """A reaction names the reacted message, not a question, so its thread is unknown."""
        row = capture_row('reaction', _metadata(), {'emoji': '✅', 'added': True, 'userId': '1'}, source='s', now=NOW)
        assert row['thread_id'] is None

    def test_an_event_inside_a_thread_still_carries_the_thread(self):
        row = capture_row(
            'outbound',
            _metadata(threadId='1001'),
            {'text': 'hi', 'messageIds': [], 'destination': 'thread'},
            source='s',
            now=NOW,
        )
        assert row['thread_id'] == '1001'


class TestCaptureRowPayload:
    """``payload`` is the SSE body verbatim, and ``text`` is clipped."""

    def test_the_payload_is_the_broadcast_body(self):
        """A subscriber reading discord_events must see what SSE carried."""
        metadata = _metadata()
        payload = {'lane': 'text', 'text': 'hello', 'contextChars': 12}
        row = capture_row('message', metadata, payload, source='s', now=NOW)
        assert json.loads(row['payload']) == {
            'schemaVersion': 1,
            'eventType': 'message',
            'metadata': metadata,
            'lane': 'text',
            'text': 'hello',
            'contextChars': 12,
        }

    def test_the_payload_is_json_text_for_the_jsonb_cast(self):
        row = capture_row('message', _metadata(), {'text': 'x'}, source='s', now=NOW)
        assert isinstance(row['payload'], str)

    def test_non_ascii_survives_the_payload_round_trip(self):
        row = capture_row('reaction', _metadata(), {'emoji': '🚀', 'added': True, 'userId': '1'}, source='s', now=NOW)
        assert json.loads(row['payload'])['emoji'] == '🚀'

    def test_long_text_is_clipped_to_the_contract_limit(self):
        row = capture_row('message', _metadata(), {'text': 'a' * 20000}, source='s', now=NOW)
        assert len(row['text']) == MAX_TEXT_CHARS == 8000

    def test_the_payload_keeps_the_unclipped_text(self):
        """Clipping is a column budget, not a data policy; the body is whole."""
        row = capture_row('message', _metadata(), {'text': 'a' * 20000}, source='s', now=NOW)
        assert len(json.loads(row['payload'])['text']) == 20000

    def test_a_binary_lane_message_has_no_text(self):
        row = capture_row(
            'message',
            _metadata(),
            {'lane': 'binary', 'mimeType': 'image/png', 'size': 42},
            source='s',
            now=NOW,
        )
        assert row['text'] is None
        assert json.loads(row['payload'])['mimeType'] == 'image/png'

    def test_an_unserialisable_payload_value_does_not_raise(self):
        """A capture write must never be the thing that fails a message."""
        row = capture_row('message', _metadata(), {'text': 'x', 'odd': object()}, source='s', now=NOW)
        assert isinstance(row['payload'], str)


# ===========================================================================
# The SQL strings
# ===========================================================================


class TestSql:
    """``CREATE TABLE`` and ``INSERT`` are fixed strings, not built per row."""

    def test_the_insert_names_the_twelve_columns_and_binds_twelve_params(self):
        sql = INSERT_SQL('discord_events')
        assert sql == (
            'INSERT INTO discord_events (event_type, message_id, event_key, thread_id, channel_id, guild_id, '
            'author_id, author_is_bot, occurred_at, text, payload, source) '
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CAST($11 AS jsonb),$12) '
            'ON CONFLICT (message_id, event_type, event_key) DO NOTHING'
        )

    def test_the_insert_is_idempotent_on_the_contract_key(self):
        """A redelivered Gateway event must not double-count."""
        assert 'ON CONFLICT (message_id, event_type, event_key) DO NOTHING' in INSERT_SQL('discord_events')

    def test_the_create_table_is_idempotent_and_brings_both_indexes(self):
        sql = CREATE_TABLE_SQL('discord_events')
        assert 'CREATE TABLE IF NOT EXISTS discord_events' in sql
        assert 'CREATE INDEX IF NOT EXISTS discord_events_thread ON discord_events (thread_id)' in sql
        assert 'CREATE INDEX IF NOT EXISTS discord_events_occurred ON discord_events (occurred_at)' in sql

    def test_the_create_table_declares_every_contract_column(self):
        sql = CREATE_TABLE_SQL('discord_events')
        for column in ('seq', 'captured_at', *COLUMNS):
            assert column in sql, column
        assert 'UNIQUE (message_id, event_type, event_key)' in sql

    def test_a_custom_table_renames_its_indexes_and_constraint_too(self):
        """Two capture tables in one database must not collide on index names."""
        sql = CREATE_TABLE_SQL('bot_events')
        assert 'CREATE TABLE IF NOT EXISTS bot_events' in sql
        assert 'bot_events_thread' in sql
        assert 'bot_events_occurred' in sql
        assert 'bot_events_dedupe' in sql
        assert 'discord_events' not in sql
        assert INSERT_SQL('bot_events').startswith('INSERT INTO bot_events (')

    @pytest.mark.parametrize('name', ['discord_events', 'T', '_x', 'a1_2', 'A' * capture.MAX_TABLE_NAME_CHARS])
    def test_valid_table_names(self, name):
        assert capture.is_valid_table_name(name) is True

    @pytest.mark.parametrize(
        'name',
        [
            '',
            '1events',
            'dd events',
            'dd-events',
            'dd.events',
            'discord_events;DROP TABLE x',
            'A' * (capture.MAX_TABLE_NAME_CHARS + 1),
            None,
            7,
        ],
    )
    def test_invalid_table_names(self, name):
        assert capture.is_valid_table_name(name) is False

    def test_the_accepted_length_leaves_room_for_every_derived_name(self):
        """Postgres truncates at 63 bytes, which would collide the suffixes."""
        assert capture.MAX_TABLE_NAME_CHARS == capture.POSTGRES_IDENTIFIER_BYTES - len('_occurred')

    def test_no_identifier_from_a_max_length_table_exceeds_63_bytes(self):
        name = 'a' * capture.MAX_TABLE_NAME_CHARS
        identifiers = re.findall(rf'\b{name}\w*', CREATE_TABLE_SQL(name))

        assert sorted(set(identifiers)) == sorted({name, f'{name}_dedupe', f'{name}_thread', f'{name}_occurred'})
        for identifier in identifiers:
            assert len(identifier.encode('utf-8')) <= capture.POSTGRES_IDENTIFIER_BYTES, identifier


# ===========================================================================
# CaptureWriter
# ===========================================================================


class _FakeParam:
    """Stand-in for ``IInvokeTool.Invoke`` — records what the writer sent."""

    def __init__(self, tool_name, input):
        self.tool_name = tool_name
        self.input = input
        self.output = {'rows': [], 'affected_rows': 1}


class _FakePipe:
    """A pipe that records invokes and reports one connected tool node."""

    def __init__(self, node_ids=('db_1',), fail=None):
        self.node_ids = list(node_ids)
        self.calls = []
        self.controller_queries = 0
        self.fail = fail

    def getControllerNodeIds(self, classType):
        self.controller_queries += 1
        assert classType == 'tool'
        return list(self.node_ids)

    def invoke(self, param, component_id=''):
        self.calls.append((component_id, param.tool_name, dict(param.input)))
        if self.fail is not None:
            raise self.fail
        return param.output


class _FakeTarget:
    """The endpoint target the writer borrows its pipe from."""

    def __init__(self, pipe):
        self.pipe = pipe
        self.borrowed = 0
        self.returned = 0

    def getPipe(self):
        self.borrowed += 1
        return self.pipe

    def putPipe(self, pipe):
        assert pipe is self.pipe
        self.returned += 1


@pytest.fixture(autouse=True)
def invoke_param(monkeypatch):
    """Replace the engine's ``IInvokeTool.Invoke`` with a recordable stand-in.

    Both copies of the module: the one loaded bare for the pure tests, and
    the one IEndpoint imported inside its synthetic package.
    """
    monkeypatch.setattr(capture, '_invoke_param', lambda payload: _FakeParam('execute', payload))
    monkeypatch.setattr(endpoint_capture, '_invoke_param', lambda payload: _FakeParam('execute', payload))


def _writer(target, warnings, **kwargs):
    """A writer wired to a collecting logger, with the defaults the node uses."""
    options = dict(source='discord:discord_1', table='discord_events', node_id='', warn=warnings.append)
    options.update(kwargs)
    return CaptureWriter(target, **options)


def _row(event_type='message', **payload):
    body = {'text': 'hello'}
    body.update(payload)
    return capture_row(event_type, _metadata(), body, source='discord:discord_1', now=NOW)


class TestWriterWrites:
    """What actually reaches the database node."""

    def test_a_row_reaches_the_pipe_as_an_execute_invoke(self):
        pipe = _FakePipe()
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())

        create, insert = pipe.calls
        assert create[0] == 'db_1'
        assert create[1] == 'execute'
        assert create[2]['sql'] == CREATE_TABLE_SQL('discord_events')
        assert insert[0] == 'db_1'
        assert insert[2]['sql'] == INSERT_SQL('discord_events')
        assert warnings == []

    def test_the_insert_binds_the_twelve_columns_in_order(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [])
        row = _row()

        writer._write_one(row)

        params = pipe.calls[1][2]['params']
        assert params == [
            'message',
            '1001',
            '',
            '1001',
            '2002',
            '3003',
            '4004',
            False,
            NOW.isoformat(),
            'hello',
            row['payload'],
            'discord:discord_1',
        ]

    def test_create_table_runs_once_however_many_rows_follow(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [])

        for _ in range(3):
            writer._write_one(_row())

        creates = [call for call in pipe.calls if 'CREATE TABLE' in call[2]['sql']]
        assert len(creates) == 1
        assert len(pipe.calls) == 4

    def test_create_table_is_retried_until_it_succeeds(self):
        """A table that was never created must not be assumed to exist."""
        pipe = _FakePipe(fail=RuntimeError('connection refused'))
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())
        pipe.fail = None
        writer._write_one(_row())

        assert sum(1 for call in pipe.calls if 'CREATE TABLE' in call[2]['sql']) == 2

    def test_the_pipe_is_returned_even_when_the_write_raises(self):
        """A leaked pipe starves the answering path, which is the whole point."""
        target = _FakeTarget(_FakePipe(fail=RuntimeError('boom')))
        writer = _writer(target, [])

        writer._write_one(_row())

        assert target.borrowed == target.returned == 1

    def test_a_custom_table_is_what_gets_written(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [], table='bot_events')

        writer._write_one(_row())

        assert 'bot_events' in pipe.calls[1][2]['sql']


class TestWriterNodeResolution:
    """Finding the database node to write to, once."""

    def test_the_only_connected_tool_node_is_used(self):
        pipe = _FakePipe(node_ids=('db_7',))
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())

        assert pipe.calls[0][0] == 'db_7'

    def test_the_lookup_happens_once(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())
        writer._write_one(_row())

        assert pipe.controller_queries == 1

    def test_a_configured_node_id_wins_and_skips_the_lookup(self):
        pipe = _FakePipe(node_ids=('db_1', 'db_2'))
        writer = _writer(_FakeTarget(pipe), [], node_id='db_2')

        writer._write_one(_row())

        assert pipe.controller_queries == 0
        assert pipe.calls[0][0] == 'db_2'

    def test_no_connected_node_disables_capture_with_one_warning(self):
        pipe = _FakePipe(node_ids=())
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        writer._write_one(_row())

        assert pipe.calls == []
        assert len(warnings) == 1
        assert 'no database node' in warnings[0].lower()
        assert writer.disabled is True

    def test_several_connected_nodes_disable_capture_with_one_warning(self):
        """Guessing which database to write to is worse than not writing."""
        pipe = _FakePipe(node_ids=('db_1', 'db_2'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())

        assert pipe.calls == []
        assert len(warnings) == 1
        assert 'captureNodeId' in warnings[0]
        assert writer.disabled is True


class TestWriterFailures:
    """A database that is down must cost one warning, not one per event."""

    def test_a_failing_write_warns_and_names_what_was_lost(self):
        pipe = _FakePipe(fail=RuntimeError('could not connect to server'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())

        assert len(warnings) == 1
        assert 'db_1' in warnings[0]
        assert 'discord_events' in warnings[0]
        assert 'message' in warnings[0]
        assert '1001' in warnings[0]
        assert 'could not connect to server' in warnings[0]

    def test_the_next_row_is_still_attempted_after_a_failure(self):
        pipe = _FakePipe(fail=RuntimeError('boom'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        pipe.fail = None
        writer._write_one(_row())

        assert any('INSERT INTO' in call[2]['sql'] for call in pipe.calls)

    def test_a_storm_of_failures_warns_at_most_once_per_window(self):
        clock = [1000.0]
        pipe = _FakePipe(fail=RuntimeError('boom'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings, clock=lambda: clock[0])

        for _ in range(50):
            writer._write_one(_row())

        assert len(warnings) == 1

    def test_the_window_reopens_and_reports_the_running_count(self):
        clock = [1000.0]
        pipe = _FakePipe(fail=RuntimeError('boom'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings, clock=lambda: clock[0])

        for _ in range(5):
            writer._write_one(_row())
        clock[0] += capture.WARN_INTERVAL_SECONDS
        writer._write_one(_row())

        assert len(warnings) == 2
        assert '6' in warnings[1]

    def test_recovery_is_reported_once(self):
        pipe = _FakePipe(fail=RuntimeError('boom'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        writer._write_one(_row())
        pipe.fail = None
        writer._write_one(_row())
        writer._write_one(_row())

        recovered = [message for message in warnings if 'recovered' in message]
        assert recovered == ['Discord capture: writes to db_1 recovered after 2 failures']

    def test_a_clean_run_never_warns(self):
        warnings = []
        writer = _writer(_FakeTarget(_FakePipe()), warnings)

        for _ in range(5):
            writer._write_one(_row())

        assert warnings == []


class TestWriterQueue:
    """The queue is the thing that keeps capture off the answering path."""

    def test_submit_never_blocks_and_the_queue_is_bounded(self):
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer._thread = object()  # accept rows without running the worker

        for _ in range(QUEUE_MAX_ROWS + 50):
            writer.submit(_row())

        assert QUEUE_MAX_ROWS == 1000
        assert writer.dropped == 50

    def test_a_full_queue_drops_the_new_row_not_the_queued_ones(self):
        """Dropping the oldest would lose the question and keep the reply."""
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer._thread = object()

        for index in range(QUEUE_MAX_ROWS):
            writer.submit(_row(text=f'row-{index}'))
        writer.submit(_row(text='overflow'))

        first = writer._queue.get_nowait()
        assert first['text'] == 'row-0'
        assert writer.dropped == 1

    def test_dropping_warns_once_per_window(self):
        clock = [1000.0]
        warnings = []
        writer = _writer(_FakeTarget(_FakePipe()), warnings, clock=lambda: clock[0])
        writer._thread = object()

        for _ in range(QUEUE_MAX_ROWS + 10):
            writer.submit(_row())

        assert len(warnings) == 1
        assert 'dropped' in warnings[0].lower()

    def test_submit_before_start_is_a_no_op(self):
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer.submit(_row())
        assert writer._queue.qsize() == 0

    def test_submit_after_capture_was_disabled_is_a_no_op(self):
        writer = _writer(_FakeTarget(_FakePipe(node_ids=())), [])
        writer.start()
        writer._write_one(_row())  # disables it

        writer.submit(_row())

        assert writer._queue.qsize() == 0
        writer.stop(timeout=1.0)


class TestWriterThread:
    """End to end over the real daemon thread."""

    def test_a_submitted_row_is_written_and_stop_drains(self):
        pipe = _FakePipe()
        target = _FakeTarget(pipe)
        writer = _writer(target, [])
        writer.start()

        writer.submit(_row())
        writer.stop(timeout=5.0)

        assert [call[2]['sql'] for call in pipe.calls] == [
            CREATE_TABLE_SQL('discord_events'),
            INSERT_SQL('discord_events'),
        ]
        assert target.borrowed == target.returned == 1

    def test_the_worker_thread_is_a_daemon(self):
        """A stuck capture write must never hold the subprocess open."""
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer.start()
        try:
            assert writer._thread.daemon is True
        finally:
            writer.stop(timeout=5.0)

    def test_stop_reports_rows_it_could_not_write(self):
        # A write stuck on the database outlives stop(); the worker is a daemon,
        # so its queued rows are lost on exit. stop() says how many.
        warnings = []
        writer = _writer(_FakeTarget(_FakePipe()), warnings)
        release = threading.Event()
        writer._write_one = lambda row: release.wait(5)
        writer.start()
        try:
            for _ in range(3):
                writer.submit(_row())
            deadline = time.time() + 2
            while writer._queue.qsize() != 2 and time.time() < deadline:
                time.sleep(0.01)  # the worker has taken the first row and is stuck on it
            writer.stop(timeout=0.2)
        finally:
            release.set()

        assert any('about 2 row(s) unwritten' in warning for warning in warnings), warnings

    def test_a_clean_stop_reports_nothing_unwritten(self):
        warnings = []
        writer = _writer(_FakeTarget(_FakePipe()), warnings)
        writer.start()
        writer.submit(_row())
        writer.stop(timeout=5.0)

        assert not any('unwritten' in warning for warning in warnings)

    def test_stop_is_idempotent_and_safe_before_start(self):
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer.stop(timeout=0.1)
        writer.start()
        writer.stop(timeout=5.0)
        writer.stop(timeout=0.1)

    def test_a_raising_write_does_not_kill_the_worker(self):
        pipe = _FakePipe(fail=RuntimeError('boom'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)
        writer.start()

        writer.submit(_row())
        writer.submit(_row())
        writer.stop(timeout=5.0)

        assert writer.failures >= 1
        assert warnings

    def test_an_invalid_table_name_disables_capture_before_anything_starts(self):
        target = _FakeTarget(_FakePipe())
        warnings = []
        writer = _writer(target, warnings, table='dd events; DROP TABLE users')

        writer.start()
        writer.submit(_row())
        writer.stop(timeout=1.0)

        assert writer.disabled is True
        assert writer._thread is None
        assert target.borrowed == 0
        assert len(warnings) == 1
        assert 'captureTable' in warnings[0]


# ===========================================================================
# IEndpoint wiring
# ===========================================================================


def _make_discord_stub():
    """A minimal ``discord`` stand-in covering what IEndpoint touches."""
    discord = types.ModuleType('discord')

    class _DiscordException(Exception):
        pass

    discord.DiscordException = _DiscordException
    discord.LoginFailure = type('LoginFailure', (_DiscordException,), {})
    discord.PrivilegedIntentsRequired = type('PrivilegedIntentsRequired', (_DiscordException,), {})
    discord.HTTPException = type('HTTPException', (_DiscordException,), {})
    discord.Forbidden = type('Forbidden', (discord.HTTPException,), {})
    discord.RateLimited = type('RateLimited', (Exception,), {})
    discord.Message = type('Message', (), {})
    discord.Attachment = type('Attachment', (), {})
    discord.Thread = type('Thread', (), {})
    discord.TextChannel = type('TextChannel', (), {})
    discord.Object = type('Object', (), {'__init__': lambda self, *, id: setattr(self, 'id', id)})

    class _Intents:
        def __init__(self):
            self.message_content = False
            self.guilds = False
            self.members = False
            self.reactions = False

        @staticmethod
        def default():
            return _Intents()

    discord.Intents = _Intents

    class _AllowedMentions:
        def __init__(self, *, everyone=False, users=None, roles=None):
            self.everyone = everyone
            self.users = users or []
            self.roles = roles or []

        @classmethod
        def none(cls):
            return cls()

    discord.AllowedMentions = _AllowedMentions

    ext = types.ModuleType('discord.ext')
    ext.__path__ = []
    commands = types.ModuleType('discord.ext.commands')
    commands.Bot = type('Bot', (), {})
    ext.commands = commands
    discord.ext = ext
    return discord, ext, commands


def _load_endpoint_class():
    """Load the real ``IEndpoint`` with the engine and discord.py stubbed."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IEndpointBase = type('IEndpointBase', (), {})
    for name in ('monitorOther', 'monitorStatus', 'monitorCompleted', 'monitorFailed', 'debug'):
        setattr(rocketlib, name, mock.Mock(name=name))
    rocketlib.getObject = mock.Mock(name='getObject')
    rocketlib.AVI_ACTION = type('AVI_ACTION', (), {'BEGIN': 'BEGIN', 'WRITE': 'WRITE', 'END': 'END'})

    depends = types.ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None

    discord, ext, commands = _make_discord_stub()
    stubs = {
        'rocketlib': rocketlib,
        'depends': depends,
        'discord': discord,
        'discord.ext': ext,
        'discord.ext.commands': commands,
    }
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        pkg = types.ModuleType('_discord_capture_node')
        pkg.__path__ = [_NODE_DIR]
        sys.modules['_discord_capture_node'] = pkg
        for name in ('text_utils', 'capture', 'IEndpoint'):
            spec = importlib.util.spec_from_file_location(
                f'_discord_capture_node.{name}', os.path.join(_NODE_DIR, f'{name}.py')
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'_discord_capture_node.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['_discord_capture_node.IEndpoint'].IEndpoint,
            sys.modules['_discord_capture_node.capture'],
        )
    finally:
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


IEndpoint, endpoint_capture = _load_endpoint_class()


def _endpoint(pipe, *, capture_events, node_id='', table='discord_events', source=''):
    """An endpoint with just enough state for ``_run_text_pipeline``."""
    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint.endpoint = types.SimpleNamespace(key='discord_1', logicalType='discord')
    endpoint.target = _FakeTarget(pipe)
    endpoint._capture_events = capture_events
    endpoint._capture_node_id = node_id
    endpoint._capture_table = table
    endpoint._capture_source_setting = source
    endpoint._capture = None
    if capture_events:
        endpoint._start_capture()
    entry = mock.Mock()
    entry.response.toDict.return_value = {'answers': ['the answer']}
    endpoint._new_entry = mock.Mock(return_value=entry)
    return endpoint


class _PipelinePipe(_FakePipe):
    """A pipe that is both the ingest pipe and the capture pipe."""

    pipeId = None  # no SSE in tests

    def open(self, entry):
        pass

    def sendTagMetadata(self, metadata):
        pass

    def writeText(self, text):
        pass

    def writeTagBeginObject(self):
        pass

    def writeTagBeginStream(self):
        pass

    def writeTagData(self, data):
        pass

    def writeTagEndStream(self):
        pass

    def writeTagEndObject(self):
        pass

    def close(self):
        pass


class TestEndpointCaptureWiring:
    """Off must be free; on must never be able to break the bot."""

    def test_capture_off_builds_no_writer_and_asks_for_no_node(self):
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=False)

        answer = endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())

        assert answer == 'the answer'
        assert endpoint._capture is None
        assert pipe.controller_queries == 0
        assert pipe.calls == []

    def test_capture_on_records_the_question_and_the_reply(self):
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True)
        try:
            endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())
            endpoint._emit_event_pipeline(_metadata(), 'outbound', {'text': 'the answer', 'messageIds': ['5']})
        finally:
            endpoint._stop_capture()

        inserts = [call[2]['params'] for call in pipe.calls if 'INSERT INTO' in call[2]['sql']]
        assert [params[0] for params in inserts] == ['message', 'outbound']
        assert inserts[0][1] == '1001'
        assert inserts[0][9] == 'hello'
        assert inserts[0][11] == 'discord:discord_1'

    def test_a_configured_capture_source_is_recorded_verbatim(self):
        """A reader of the table tells rows apart by the pipe that wrote them (``captureSource``)."""
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True, source='discord:discord_1+tool_slack')
        try:
            endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())
        finally:
            endpoint._stop_capture()

        inserts = [call[2]['params'] for call in pipe.calls if 'INSERT INTO' in call[2]['sql']]
        assert inserts[0][11] == 'discord:discord_1+tool_slack'

    @pytest.mark.parametrize('bad', ['has space', 'semi;colon', 'x' * 129, '\u00e9t\u00e9'])
    def test_an_invalid_capture_source_falls_back_to_the_default_label(self, bad):
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True, source=bad)
        try:
            answer = endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())
        finally:
            endpoint._stop_capture()

        assert answer == 'the answer'
        inserts = [call[2]['params'] for call in pipe.calls if 'INSERT INTO' in call[2]['sql']]
        assert inserts[0][11] == 'discord:discord_1'

    def test_the_bot_still_answers_when_every_capture_write_raises(self):
        """Capture is a side channel; a dead database is not a dead bot."""
        pipe = _PipelinePipe(fail=RuntimeError('capture database is down'))
        endpoint = _endpoint(pipe, capture_events=True)
        writer = endpoint._capture
        try:
            answer = endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())
        finally:
            endpoint._stop_capture()

        assert answer == 'the answer'
        assert writer.failures >= 1

    def test_an_invalid_capture_table_disables_capture_and_keeps_answering(self):
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True, table='nope; DROP TABLE users')
        writer = endpoint._capture
        try:
            answer = endpoint._run_text_pipeline('hello', 2002, 1001, _metadata())
        finally:
            endpoint._stop_capture()

        assert answer == 'the answer'
        assert writer.disabled is True
        assert pipe.calls == []

    def test_stopping_capture_twice_is_safe(self):
        endpoint = _endpoint(_PipelinePipe(), capture_events=True)
        endpoint._stop_capture()
        endpoint._stop_capture()
        assert endpoint._capture is None


# ===========================================================================
# services.json
# ===========================================================================


class TestServicesJson:
    """The three new fields have to be reachable in the UI and off by default."""

    @pytest.fixture(scope='class')
    def schema(self):
        # services.json is JSONC: its whole-line ``//`` comments are dropped first.
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as f:
            lines = f.read().split('\n')
        return json.loads('\n'.join(line for line in lines if not line.lstrip().startswith('//')))

    def test_the_capture_fields_exist_with_the_documented_defaults(self, schema):
        defaults = {
            'discord.captureEvents': False,
            'discord.captureNodeId': '',
            'discord.captureTable': 'discord_events',
            'discord.captureSource': '',
        }
        for field, default in defaults.items():
            assert field in schema['fields'], field
            assert schema['fields'][field]['default'] == default, field

    def test_the_capture_fields_are_registered_in_the_ui(self, schema):
        properties = schema['fields']['Pipe.source.parameters']['properties']
        for field in (
            'discord.captureEvents',
            'discord.captureNodeId',
            'discord.captureTable',
            'discord.captureSource',
        ):
            assert field in properties, field

    def test_the_default_table_matches_the_contract(self, schema):
        assert schema['fields']['discord.captureTable']['default'] == capture.DEFAULT_TABLE == 'discord_events'

    def test_the_table_description_states_the_real_length_limit(self, schema):
        description = schema['fields']['discord.captureTable']['description']
        assert f'at most {capture.MAX_TABLE_NAME_CHARS} characters' in description

    def test_the_capture_events_description_names_the_options_each_row_needs(self, schema):
        """A reader must not expect outbound/no_reply/reaction rows for free."""
        description = schema['fields']['discord.captureEvents']['description']
        for option in ('emitOutbound', 'emitNoReply', 'emitReactions'):
            assert option in description, option

    def test_the_capture_source_description_gives_the_real_default(self, schema):
        """``endpoint.key`` is the node's logical type, so the default is discord:discord."""
        description = schema['fields']['discord.captureSource']['description']
        assert 'discord:<node type>' in description
        assert 'component id' not in description


@pytest.mark.parametrize(
    'label, ok',
    [
        ('discord:discord_1', True),
        ('discord:discord_1+tool_slack', True),
        ('a.b-c@d', True),
        ('', False),
        ('two words', False),
        ('x' * 128, True),
        ('x' * 129, False),
        (None, False),
    ],
)
def test_source_label_validation(label, ok):
    assert capture.is_valid_source_label(label) is ok


def test_the_queue_and_warning_budget_match_the_contract():
    """Pinned so a tuning change is a deliberate edit, not a drift."""
    assert QUEUE_MAX_ROWS == 1000
    assert capture.WARN_INTERVAL_SECONDS == 30.0
    assert MAX_TEXT_CHARS == 8000


def test_the_queue_is_a_bounded_stdlib_queue():
    writer = CaptureWriter(_FakeTarget(_FakePipe()), source='s', warn=lambda m: None)
    assert isinstance(writer._queue, queue.Queue)
    assert writer._queue.maxsize == QUEUE_MAX_ROWS
    assert isinstance(threading.Thread, type)


def test_insert_sql_never_casts_a_placeholder_with_double_colon():
    """`$n::type` breaks the database node's `$n` -> `:bn` rewrite; casts must use CAST(... AS ...)."""
    import re as _re

    assert not _re.search(r'\$\d+::', capture.INSERT_SQL('discord_events'))


class _ControlOnlyPipe(_FakePipe):
    """Like the engine's ``IServiceFilterPipe``: ``control`` but no Python ``invoke``.

    rocketlib patches ``invoke`` onto ``IFilterInstance`` only, so the pipe an
    endpoint borrows from ``getPipe()`` has to be driven through ``control``.
    """

    invoke = None  # the attribute the engine pipe does not have

    def control(self, lane, envelope, nodeId=''):
        param = envelope.param
        self.calls.append((nodeId, param.tool_name, dict(param.input), lane))
        if self.fail is not None:
            raise self.fail


class _FakeEnvelope:
    """Stand-in for ``rocketlib.types.IInvoke`` (the control-plane wrapper)."""

    def __init__(self, param, result=None):
        self.param = param
        self.result = result


def test_a_pipe_without_invoke_is_driven_through_control(monkeypatch):
    monkeypatch.setattr(capture, '_control_envelope', lambda param: _FakeEnvelope(param))
    pipe = _ControlOnlyPipe()
    warnings = []
    writer = _writer(_FakeTarget(pipe), warnings)

    writer._write_one(_row())

    create, insert = pipe.calls
    assert create[0] == 'db_1' and create[1] == 'execute' and create[3] == 'tool'
    assert insert[2]['sql'] == INSERT_SQL('discord_events')
    assert len(insert[2]['params']) == 12
    assert warnings == []


def test_a_reaction_key_uses_the_broadcast_occurred_at_over_the_clock():
    """The live writer and the log import see the same payload, so the key must come from it."""
    row = capture_row(
        'reaction',
        _metadata(),
        {'emoji': '✅', 'added': True, 'userId': '7', 'occurredAt': 1790000000123},
        source='s',
        now=NOW,
    )
    assert row['event_key'] == '7:✅:add:1790000000123'
