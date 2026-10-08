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

import asyncio
import importlib.util
import json
import os
import queue
import re
import sys
import threading
import types
from datetime import datetime, timezone
from unittest import mock

import pytest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../src/nodes/discord'))
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')


def _load_capture():
    """Load the node's capture module from its file path, inside a synthetic package.

    The package is what lets ``capture`` import ``text_utils`` relatively, as
    it does in the engine; neither module touches the engine or discord.py.
    """
    pkg = types.ModuleType('_discord_capture_pure')
    pkg.__path__ = [_NODE_DIR]
    sys.modules['_discord_capture_pure'] = pkg
    path = os.path.join(_NODE_DIR, 'capture.py')
    spec = importlib.util.spec_from_file_location('_discord_capture_pure.capture', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['_discord_capture_pure.capture'] = module
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
        assert row['event_key'] == 'text'
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
        row = capture_row('no_reply', meta, {'reason': 'no_answer'}, source='s', now=NOW)
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

    @pytest.mark.parametrize(
        'reason',
        ['no_answer', 'non_answer', 'model_error', 'send_failed', 'shutdown', 'paused', 'aimed_elsewhere', 'timeout'],
    )
    def test_a_known_no_reply_reason_is_its_own_key(self, reason):
        row = capture_row('no_reply', _metadata(), {'reason': reason}, source='s', now=NOW)

        assert row['event_key'] == reason

    def test_an_exception_reason_gets_one_stable_key(self):
        # The reason can be exception text that differs between deliveries of
        # the same message; keyed by that text, a redelivery inserted again.
        first = capture_row('no_reply', _metadata(), {'reason': 'Timeout after 30.01s'}, source='s', now=NOW)
        again = capture_row('no_reply', _metadata(), {'reason': 'Timeout after 31.77s'}, source='s', now=NOW)

        assert first['event_key'] == again['event_key'] == 'error'
        assert json.loads(first['payload'])['reason'] == 'Timeout after 30.01s'  # the text is kept

    def test_the_text_pass_is_keyed_text(self):
        row = capture_row('message', _metadata(), {'lane': 'text', 'text': 'x'}, source='s', now=NOW)
        assert row['event_key'] == 'text'

    def test_a_retried_text_pass_is_keyed_by_its_attempt(self):
        """Each retry is a separate pipeline run and must not collapse into one row."""
        row = capture_row('message', _metadata(), {'lane': 'text', 'text': 'x', 'retry': 2}, source='s', now=NOW)
        assert row['event_key'] == 'text:retry:2'

    def test_an_attachment_is_keyed_by_its_lane_and_group_index(self):
        row = capture_row(
            'message',
            _metadata(groupIndex=1, groupSize=2),
            {'lane': 'binary', 'mimeType': 'image/png', 'size': 3},
            source='s',
            now=NOW,
        )
        assert row['event_key'] == 'binary:1'

    def test_a_text_attachment_is_not_keyed_like_the_text_pass(self):
        """With mergeAttachments off a text file is its own text-lane object."""
        row = capture_row(
            'message',
            _metadata(groupIndex=1, groupSize=2),
            {'lane': 'text', 'text': '[attachment notes.txt]\nhi'},
            source='s',
            now=NOW,
        )
        assert row['event_key'] == 'text:1'

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

    def test_a_runaway_reason_never_reaches_the_key(self):
        """A reason built from an exception must not become the dedupe key."""
        row = capture_row('no_reply', _metadata(), {'reason': 'x' * 5000}, source='s', now=NOW)

        assert row['event_key'] == 'error'

    def test_a_reply_or_no_reply_to_a_channel_question_carries_the_question_as_thread(self):
        """outbound/no_reply carry the QUESTION's metadata, so they belong to the thread it roots."""
        for event_type, payload in (
            ('outbound', {'text': 'hi', 'messageIds': [], 'destination': 'thread'}),
            ('no_reply', {'reason': 'no_answer'}),
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

    def test_nul_characters_are_stripped_from_text_and_payload(self):
        """PostgreSQL text and jsonb reject NUL; a UTF-16 .txt decoded with errors='ignore' is full of them."""
        metadata = _metadata(displayName='A\x00da')
        payload = {
            'lane': 'text',
            'text': 'h\x00e\x00l\x00l\x00o\x00',
            'files': [{'name': 'notes\x00.txt', 'extra': {'note': 'x\x00y'}}],
        }
        row = capture_row('message', metadata, payload, source='discord:discord_1', now=NOW)

        assert row['text'] == 'hello'
        assert '\x00' not in row['payload']
        assert '\\u0000' not in row['payload']
        body = json.loads(row['payload'])
        assert body['text'] == 'hello'
        assert body['files'] == [{'name': 'notes.txt', 'extra': {'note': 'xy'}}]
        assert body['metadata']['displayName'] == 'Ada'

    def test_scrubbing_leaves_the_callers_dicts_alone(self):
        payload = {'text': 'a\x00b', 'nested': {'v': 'c\x00'}}
        capture_row('message', _metadata(), payload, source='discord:discord_1', now=NOW)
        assert payload == {'text': 'a\x00b', 'nested': {'v': 'c\x00'}}

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
            'INSERT INTO "discord_events" (event_type, message_id, event_key, thread_id, channel_id, guild_id, '
            'author_id, author_is_bot, occurred_at, text, payload, source) '
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CAST($11 AS jsonb),$12) '
            'ON CONFLICT (message_id, event_type, event_key) DO NOTHING'
        )

    def test_the_insert_is_idempotent_on_the_contract_key(self):
        """A redelivered Gateway event must not double-count."""
        assert 'ON CONFLICT (message_id, event_type, event_key) DO NOTHING' in INSERT_SQL('discord_events')

    def test_the_create_table_is_idempotent_and_brings_both_indexes(self):
        sql = CREATE_TABLE_SQL('discord_events')
        assert 'CREATE TABLE IF NOT EXISTS "discord_events"' in sql
        assert 'CREATE INDEX IF NOT EXISTS "discord_events$thread" ON "discord_events" (thread_id)' in sql
        assert 'CREATE INDEX IF NOT EXISTS "discord_events$occurred" ON "discord_events" (occurred_at)' in sql

    def test_the_create_table_declares_every_contract_column(self):
        sql = CREATE_TABLE_SQL('discord_events')
        for column in ('seq', 'captured_at', *COLUMNS):
            assert column in sql, column
        assert 'UNIQUE (message_id, event_type, event_key)' in sql

    def test_seq_is_an_identity_column_so_insert_alone_is_enough(self):
        """A BIGSERIAL default calls nextval(), which needs USAGE on its sequence; an identity column does not."""
        sql = CREATE_TABLE_SQL('discord_events')
        assert 'seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' in sql
        assert 'SERIAL' not in sql.upper()

    def test_a_custom_table_renames_its_indexes_and_constraint_too(self):
        """Two capture tables in one database must not collide on index names."""
        sql = CREATE_TABLE_SQL('bot_events')
        assert 'CREATE TABLE IF NOT EXISTS "bot_events"' in sql
        assert '"bot_events$thread"' in sql
        assert '"bot_events$occurred"' in sql
        assert '"bot_events$dedupe"' in sql
        assert 'discord_events' not in sql
        assert INSERT_SQL('bot_events').startswith('INSERT INTO "bot_events" (')

    def test_no_derived_name_can_be_another_capture_table(self):
        """Tables ``events`` and ``events_thread`` must not collide on an index named ``events_thread``."""
        sql = CREATE_TABLE_SQL('events')
        derived = re.findall(r'"(events[^"]+)"', sql)
        assert sorted(derived) == ['events$dedupe', 'events$occurred', 'events$thread']
        for name in derived:
            assert capture.is_valid_table_name(name) is False, name

    def test_a_reserved_word_is_quoted_in_all_sql(self):
        """``user`` is reserved: ``INSERT INTO user (...)`` fails every row unless the name is quoted."""
        assert capture.is_valid_table_name('user') is True
        assert INSERT_SQL('user').startswith('INSERT INTO "user" (')
        create = CREATE_TABLE_SQL('user')
        assert 'CREATE TABLE IF NOT EXISTS "user" (' in create
        assert 'ON "user" (thread_id)' in create
        assert all(found.startswith('"') for found in re.findall(r'"?\buser\S*', create))

    def test_a_mixed_case_name_means_the_lower_case_table(self):
        """Quoting makes case significant, so the name is lower-cased first: Discord_Events is discord_events."""
        assert capture.is_valid_table_name('Discord_Events') is True
        assert INSERT_SQL('Discord_Events') == INSERT_SQL('discord_events')
        assert CREATE_TABLE_SQL('Discord_Events') == CREATE_TABLE_SQL('discord_events')

    def test_the_writer_writes_a_mixed_case_name_lower_cased(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [], table='Discord_Events')

        writer._write_one(_row())

        assert pipe.calls[0][2]['sql'].startswith('INSERT INTO "discord_events" (')

    @pytest.mark.parametrize(
        'name', ['discord_events', 'T', '_x', 'a1_2', 'user', 'Discord_Events', 'A' * capture.MAX_TABLE_NAME_CHARS]
    )
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
            'dd"events',
            'discord_events;DROP TABLE x',
            'discord_events\n',
            '\ndiscord_events',
            'A' * (capture.MAX_TABLE_NAME_CHARS + 1),
            None,
            7,
        ],
    )
    def test_invalid_table_names(self, name):
        assert capture.is_valid_table_name(name) is False

    def test_the_accepted_length_leaves_room_for_every_derived_name(self):
        """Postgres truncates at 63 bytes, which would collide the suffixes."""
        assert capture.MAX_TABLE_NAME_CHARS == capture.POSTGRES_IDENTIFIER_BYTES - len('$occurred')

    def test_no_identifier_from_a_max_length_table_exceeds_63_bytes(self):
        name = 'a' * capture.MAX_TABLE_NAME_CHARS
        identifiers = re.findall(r'"([^"]+)"', CREATE_TABLE_SQL(name))

        assert sorted(set(identifiers)) == sorted({name, f'{name}$dedupe', f'{name}$thread', f'{name}$occurred'})
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
    """A pipe that records invokes and reports one connected tool node.

    It stands in for a PostgreSQL database node: ``dialect`` answers
    ``dialect`` (recorded in ``dialect_calls``, not ``calls``), the
    ``to_regclass`` existence check answers from ``table_exists`` (recorded in
    ``check_calls``, not ``calls``; ``check_output`` replaces the answer), and
    while the table does not exist an INSERT fails the way PostgreSQL reports it.
    """

    _ANSWER = object()

    def __init__(
        self,
        node_ids=('db_1',),
        fail=None,
        dialect='postgres',
        table_exists=True,
        create_fails=None,
        check_output=_ANSWER,
        check_fails=None,
    ):
        self.node_ids = list(node_ids)
        self.calls = []
        self.dialect_calls = []
        self.check_calls = []
        self.check_output = check_output
        self.check_fails = check_fails
        self.controller_queries = 0
        self.fail = fail
        self.dialect = dialect
        self.table_exists = table_exists
        self.create_fails = create_fails

    def getControllerNodeIds(self, classType):
        self.controller_queries += 1
        assert classType == 'tool'
        return list(self.node_ids)

    def _answer(self, param, component_id):
        if param.tool_name == 'dialect':
            self.dialect_calls.append(component_id)
            param.output = {'dialect': self.dialect}
            return
        if param.input['sql'].startswith('SELECT to_regclass'):
            self.check_calls.append((component_id, dict(param.input)))
            if self.check_fails is not None:
                raise self.check_fails
            if self.check_output is not self._ANSWER:
                param.output = self.check_output
            else:
                param.output = {'rows': [['discord_events' if self.table_exists else None]], 'affected_rows': 0}
            return
        if self.fail is not None:
            raise self.fail
        sql = param.input['sql']
        if 'CREATE TABLE' in sql:
            if self.create_fails is not None:
                raise self.create_fails
            self.table_exists = True
        elif not self.table_exists:
            raise RuntimeError(
                'SQL execution failed: (psycopg.errors.UndefinedTable) relation "discord_events" does not exist'
            )

    def invoke(self, param, component_id=''):
        if param.tool_name != 'dialect' and not param.input['sql'].startswith('SELECT to_regclass'):
            self.calls.append((component_id, param.tool_name, dict(param.input)))
        self._answer(param, component_id)
        return param.output


class _StuckPipe(_FakePipe):
    """A database whose INSERT hangs until ``release`` is set."""

    def __init__(self, release, **kwargs):
        super().__init__(**kwargs)
        self.release = release
        self.entered = threading.Event()

    def invoke(self, param, component_id=''):
        if param.tool_name == 'execute':
            self.entered.set()
            self.release.wait(5)
        return super().invoke(param, component_id)


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

    def fake(payload, tool_name='execute'):
        return _FakeParam(tool_name, payload)

    monkeypatch.setattr(capture, '_invoke_param', fake)
    monkeypatch.setattr(endpoint_capture, '_invoke_param', fake)


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

        (insert,) = pipe.calls
        assert insert[0] == 'db_1'
        assert insert[1] == 'execute'
        assert insert[2]['sql'] == INSERT_SQL('discord_events')
        assert warnings == []

    def test_the_insert_binds_the_twelve_columns_in_order(self):
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [])
        row = _row()

        writer._write_one(row)

        params = pipe.calls[0][2]['params']
        assert params == [
            'message',
            '1001',
            'text',
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

    def test_an_existing_table_gets_inserts_and_no_ddl(self):
        """A database user that may only INSERT must never be asked to CREATE."""
        pipe = _FakePipe(table_exists=True)
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        for _ in range(3):
            writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')] * 3
        assert warnings == []

    def test_the_table_is_checked_once_before_the_first_insert(self):
        """``to_regclass`` needs no privilege and never fails the way a doomed INSERT does."""
        pipe = _FakePipe(table_exists=True)
        writer = _writer(_FakeTarget(pipe), [], table='Bot_Events')

        writer._write_one(_row())
        writer._write_one(_row())

        assert pipe.check_calls == [
            ('db_1', {'sql': 'SELECT to_regclass($1)', 'params': ['"bot_events"'], 'row_mode': 'array'})
        ]

    def test_an_existing_table_gets_no_ddl_and_no_failed_insert(self):
        """The database node logs a failed INSERT at error level with its parameters: never send one."""
        pipe = _FakePipe(table_exists=True)
        inserts = []
        original = pipe._answer

        def answer(param, component_id):
            original(param, component_id)
            if param.tool_name == 'execute' and param.input['sql'].startswith('INSERT'):
                inserts.append(pipe.table_exists)

        pipe._answer = answer
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')]
        assert inserts == [True]
        assert writer.failures == 0

    def test_a_missing_table_is_created_before_the_first_insert(self):
        pipe = _FakePipe(table_exists=False)
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [
            CREATE_TABLE_SQL('discord_events'),
            INSERT_SQL('discord_events'),
            INSERT_SQL('discord_events'),
        ]
        assert len(pipe.check_calls) == 1
        assert warnings == []
        assert writer.failures == 0

    @pytest.mark.parametrize(
        'output',
        [None, {}, {'rows': []}, {'rows': [[1]]}, {'rows': [['a', 'b']]}, {'rows': 'discord_events'}, 'text'],
    )
    def test_an_unreadable_check_falls_back_to_insert_first(self, output):
        pipe = _FakePipe(table_exists=False, check_output=output)
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [
            INSERT_SQL('discord_events'),
            CREATE_TABLE_SQL('discord_events'),
            INSERT_SQL('discord_events'),
            INSERT_SQL('discord_events'),
        ]
        assert len(pipe.check_calls) == 1
        assert warnings == []

    def test_an_object_row_answer_is_read_too(self):
        pipe = _FakePipe(table_exists=False, check_output={'rows': [{'to_regclass': None}]})
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [
            CREATE_TABLE_SQL('discord_events'),
            INSERT_SQL('discord_events'),
        ]

    def test_a_failed_check_is_a_failed_write_and_is_asked_again(self):
        pipe = _FakePipe(check_fails=RuntimeError('connection refused'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        pipe.check_fails = None
        writer._write_one(_row())

        assert len(pipe.check_calls) == 2
        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')]
        assert 'connection refused' in warnings[0]
        assert writer.failures == 0

    def test_a_table_dropped_after_the_check_is_created_again(self):
        """The INSERT-error fallback stays for a table that disappears mid-run."""
        pipe = _FakePipe(table_exists=True)
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())
        pipe.table_exists = False
        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [
            INSERT_SQL('discord_events'),
            INSERT_SQL('discord_events'),
            CREATE_TABLE_SQL('discord_events'),
            INSERT_SQL('discord_events'),
        ]
        assert writer.failures == 0

    def test_a_failed_create_is_a_failed_write_and_is_tried_again_next_row(self):
        """A table that could not be created must not be assumed to exist."""
        pipe = _FakePipe(table_exists=False, create_fails=RuntimeError('permission denied for schema public'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        pipe.create_fails = None
        writer._write_one(_row())

        assert sum(1 for call in pipe.calls if 'CREATE TABLE' in call[2]['sql']) == 2
        assert 'permission denied' in warnings[0]
        assert pipe.table_exists is True

    def test_an_insert_failing_for_another_reason_runs_no_ddl(self):
        pipe = _FakePipe(fail=RuntimeError('connection refused'))
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')]
        assert writer.failures == 1

    def test_a_missing_column_is_not_taken_for_a_missing_table(self):
        """42703 quotes ``relation "..." does not exist`` too; a table of another shape must not get DDL."""
        error = RuntimeError('column "event_key" of relation "discord_events" does not exist')
        pipe = _FakePipe(fail=error)
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())

        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')]
        assert writer.failures == 1
        assert 'column "event_key"' in warnings[0]

    @pytest.mark.parametrize(
        'message, missing',
        [
            ('relation "discord_events" does not exist', True),
            ('SQL execution failed: relation "discord_events" does not exist', True),
            ('psycopg2.errors.UndefinedTable: relation "discord_events" does not exist', True),
            ('ERROR 42P01: undefined table', True),
            ('column "event_key" of relation "discord_events" does not exist', False),
            ('SQL execution failed: column "source" of relation "discord_events" does not exist', False),
            ('42703: column "event_key" of relation "discord_events" does not exist', False),
        ],
    )
    def test_only_a_missing_relation_counts_as_a_missing_table(self, message, missing):
        assert capture._is_missing_table(RuntimeError(message)) is missing

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

        assert 'bot_events' in pipe.calls[0][2]['sql']


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

    def test_the_dialect_is_asked_once_of_the_resolved_node(self):
        pipe = _FakePipe(node_ids=('db_7',))
        writer = _writer(_FakeTarget(pipe), [])

        writer._write_one(_row())
        writer._write_one(_row())

        assert pipe.dialect_calls == ['db_7']

    @pytest.mark.parametrize('dialect', ['mysql', 'clickhouse', 'neo4j'])
    def test_a_non_postgres_dialect_disables_capture_with_one_warning(self, dialect):
        """The capture SQL is PostgreSQL's; on anything else it would fail every row."""
        pipe = _FakePipe(dialect=dialect)
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row())
        writer._write_one(_row())

        assert pipe.calls == []
        assert writer.disabled is True
        assert len(warnings) == 1
        assert dialect in warnings[0]
        assert 'PostgreSQL' in warnings[0]

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
        assert "'db_1'" in warnings[0]
        # Configured values are quoted the way the node quotes any config entry.
        assert "'discord_even\u2026'" in warnings[0]
        assert 'message' in warnings[0]
        assert '1001' in warnings[0]
        assert 'could not connect to server' in warnings[0]

    def test_a_configured_secret_is_never_echoed_in_full(self):
        # A ${ROCKETRIDE_*} secret pasted into captureNodeId or captureTable
        # would otherwise reach the task's warnings whole.
        secret = 'abcdefghijklmnopqrstuvwxyz0123456789'
        pipe = _FakePipe(fail=RuntimeError('could not connect to server'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings, node_id=secret, table=secret)

        writer._write_one(_row())
        _writer(_FakeTarget(pipe), warnings, table=secret + '-not-an-identifier')
        _writer(_FakeTarget(_FakePipe(dialect='mysql')), warnings, node_id=secret)._write_one(_row())

        assert len(warnings) == 3
        for warning in warnings:
            assert secret not in warning
            assert "'abcdefghijkl\u2026'" in warning

    def test_row_text_quoted_by_the_driver_never_reaches_the_warning(self):
        text = 'my account number is 12345678'
        pipe = _FakePipe(fail=RuntimeError(f'invalid input syntax: "{text}"\nDETAIL: more'))
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)

        writer._write_one(_row(text=text))

        assert len(warnings) == 1
        assert text not in warnings[0]
        assert 'invalid input syntax: "<row text>"' in warnings[0]

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
        assert recovered == ["Discord capture: writes to 'db_1' recovered after 2 failures"]

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

    def test_concurrent_drops_are_all_counted(self):
        # Events are submitted from several worker threads at once.
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer._thread = object()
        for _ in range(QUEUE_MAX_ROWS):
            writer.submit(_row())

        threads = [threading.Thread(target=lambda: [writer.submit(_row()) for _ in range(500)]) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert writer.dropped == 8 * 500

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

        assert [call[2]['sql'] for call in pipe.calls] == [INSERT_SQL('discord_events')]
        assert target.borrowed == target.returned == 1

    def test_the_worker_thread_is_a_daemon(self):
        """A stuck capture write must never hold the subprocess open."""
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer.start()
        try:
            assert writer._thread.daemon is True
        finally:
            writer.stop(timeout=5.0)

    def test_stopping_during_a_stuck_write_ends_the_worker_once_the_write_returns(self):
        """No pipe is borrowed after stop(), and the rows left behind are counted exactly."""
        release = threading.Event()
        pipe = _StuckPipe(release)
        target = _FakeTarget(pipe)
        warnings = []
        writer = _writer(target, warnings)
        writer.start()
        thread = writer._thread
        try:
            for _ in range(3):
                writer.submit(_row())
            assert pipe.entered.wait(2)  # the worker has taken the first row and is stuck on it
            writer.stop(timeout=0.2)
            assert thread.is_alive()
        finally:
            release.set()
        thread.join(5)

        assert not thread.is_alive()
        assert target.borrowed == target.returned == 1
        assert [warning for warning in warnings if 'unwritten' in warning] == [
            'Discord capture: stopped with 2 row(s) unwritten (the writer was still busy)'
        ]

    def test_a_full_queue_still_lets_the_worker_end(self):
        release = threading.Event()
        pipe = _StuckPipe(release)
        target = _FakeTarget(pipe)
        warnings = []
        writer = _writer(target, warnings)
        writer.start()
        thread = writer._thread
        try:
            writer.submit(_row())
            assert pipe.entered.wait(2)
            for _ in range(QUEUE_MAX_ROWS):
                writer.submit(_row())
            assert writer._queue.full()
            writer.stop(timeout=0.1)
        finally:
            release.set()
        thread.join(5)

        assert not thread.is_alive()
        assert target.borrowed == 1
        assert f'Discord capture: stopped with {QUEUE_MAX_ROWS} row(s) unwritten (the writer was still busy)' in (
            warnings
        )

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

    def test_a_row_submitted_after_stop_is_counted_not_lost(self):
        """A handler that took the writer just before Stop can still submit to it."""
        pipe = _FakePipe()
        warnings = []
        writer = _writer(_FakeTarget(pipe), warnings)
        writer.start()
        writer.stop(timeout=5.0)

        writer.submit(_row())
        writer.submit(_row())

        assert pipe.calls == []
        assert writer.unwritten == 2
        assert warnings == ['Discord capture: 1 event(s) arrived after capture stopped and were not written.']

    def test_submit_before_start_is_not_counted(self):
        writer = _writer(_FakeTarget(_FakePipe()), [])
        writer.submit(_row())
        assert writer.unwritten == 0

    def test_every_row_submitted_around_stop_is_written_or_counted(self):
        """Rows racing the stop marker are never left silently behind it in the queue."""
        pipe = _FakePipe()
        writer = _writer(_FakeTarget(pipe), [])
        writer.start()
        threads_count, per_thread = 8, 100
        barrier = threading.Barrier(threads_count + 1)

        def submit_many():
            barrier.wait()
            for _ in range(per_thread):
                writer.submit(_row())

        threads = [threading.Thread(target=submit_many) for _ in range(threads_count)]
        for thread in threads:
            thread.start()
        barrier.wait()
        writer.stop(timeout=5.0)
        for thread in threads:
            thread.join(5)

        inserted = sum(1 for call in pipe.calls if 'INSERT INTO' in call[2]['sql'])
        assert inserted + writer.dropped + writer.unwritten == threads_count * per_thread
        assert writer._queue.empty()

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
    rocketlib.isCancelled = mock.Mock(name='isCancelled', return_value=False)
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


class TestRunStopsAndDrains:
    """``_run`` reaches its teardown, and so the capture drain, on a normal stop too."""

    @staticmethod
    def _run_in_thread(endpoint, is_cancelled):
        """Run ``_run`` against a stub shared server and a real loop; return (thread, error box)."""
        loop = asyncio.new_event_loop()
        loop_thread = threading.Thread(target=loop.run_forever, daemon=True)
        loop_thread.start()

        node = types.ModuleType('ai.node')
        node.require_shared_web_server = mock.Mock(
            return_value=types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
        )
        node.server_loop = loop
        ai = types.ModuleType('ai')
        ai.__path__ = []
        ai.node = node

        errors = []

        def target():
            try:
                endpoint._run()
            except BaseException as e:  # noqa: BLE001 - surfaced to the test
                errors.append(e)

        module = sys.modules['_discord_capture_node.IEndpoint']
        with (
            mock.patch.dict(sys.modules, {'ai': ai, 'ai.node': node}),
            mock.patch.object(module, 'isCancelled', is_cancelled),
        ):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            thread.join(5)
        loop.call_soon_threadsafe(loop.stop)
        loop_thread.join(5)
        return thread, errors

    @staticmethod
    def _endpoint(writer):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint.endpoint = types.SimpleNamespace(
            serviceConfig={'parameters': {}}, key='discord_1', logicalType='discord'
        )
        endpoint.target = None
        endpoint._capture = None
        endpoint._fatal_error = None

        def start_capture():
            endpoint._capture = writer

        async def noop():
            return None

        endpoint._start_capture = start_capture
        endpoint._startup = noop
        endpoint._shutdown = noop
        return endpoint

    def test_a_cancelled_task_tears_down_and_drains_capture(self):
        """Stop sends SIGTERM, which sets the engine's cancel flag; the drain must run before the kill."""
        writer = mock.Mock()
        endpoint = self._endpoint(writer)

        thread, errors = self._run_in_thread(endpoint, mock.Mock(side_effect=[False, False, True]))

        assert not thread.is_alive()
        assert errors == []
        writer.stop.assert_called_once_with(timeout=2.0)

    def test_a_terminal_failure_still_drains_and_fails_the_source(self):
        writer = mock.Mock()
        endpoint = self._endpoint(writer)

        async def startup():
            endpoint._fail('Discord: gateway closed')

        endpoint._startup = startup

        with mock.patch.object(sys.modules['_discord_capture_node.IEndpoint'], 'monitorStatus'):
            thread, errors = self._run_in_thread(endpoint, mock.Mock(return_value=False))

        assert not thread.is_alive()
        assert [str(e) for e in errors] == ['Discord: gateway closed']
        writer.stop.assert_called_once_with(timeout=2.0)


def _kept_rows(pipe):
    """The INSERTs a real table keeps: ``ON CONFLICT DO NOTHING`` on the dedupe key."""
    kept = {}
    for call in pipe.calls:
        if 'INSERT INTO' not in call[2]['sql']:
            continue
        params = call[2]['params']
        kept.setdefault((params[1], params[0], params[2]), params)
    return list(kept.values())


class TestEveryMessagePartIsKept:
    """A message's text pass and each attachment are separate rows under the dedupe key."""

    @staticmethod
    def _text(endpoint, group_index, group_size):
        endpoint._run_text_pipeline('hello', 2002, 1001, _metadata(groupIndex=group_index, groupSize=group_size))

    @staticmethod
    def _attachment(endpoint, group_index, group_size):
        endpoint._run_binary_pipeline(
            b'%PDF-1.4', 'application/pdf', 6006, 2002, 1001, 0, _metadata(groupIndex=group_index, groupSize=group_size)
        )

    def test_text_then_attachment_gives_two_rows(self):
        """With mergeAttachments off the text pass runs first, the attachment after it."""
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True)
        try:
            self._text(endpoint, 0, 2)
            self._attachment(endpoint, 1, 2)
        finally:
            endpoint._stop_capture()

        kept = _kept_rows(pipe)
        assert [(row[0], row[2]) for row in kept] == [('message', 'text'), ('message', 'binary:1')]
        assert kept[0][9] == 'hello'

    def test_attachment_then_merged_text_gives_two_rows(self):
        """With mergeAttachments on the attachment runs first, the merged question after it."""
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True)
        try:
            self._attachment(endpoint, 1, 2)
            self._text(endpoint, 0, 2)
        finally:
            endpoint._stop_capture()

        kept = _kept_rows(pipe)
        assert [(row[0], row[2]) for row in kept] == [('message', 'binary:1'), ('message', 'text')]
        assert kept[1][9] == 'hello'

    def test_the_same_message_emitted_twice_still_dedupes(self):
        """A redelivered Gateway event produces the same keys, so nothing is added."""
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True)
        try:
            for _ in range(2):
                self._text(endpoint, 0, 2)
                self._attachment(endpoint, 1, 2)
        finally:
            endpoint._stop_capture()

        assert len(_kept_rows(pipe)) == 2

    def test_a_retried_text_pass_gets_its_own_row(self):
        pipe = _PipelinePipe()
        endpoint = _endpoint(pipe, capture_events=True)
        try:
            endpoint._capture_event('message', _metadata(), {'lane': 'text', 'text': 'hello'})
            endpoint._capture_event('message', _metadata(), {'lane': 'text', 'text': 'hello', 'retry': 1})
        finally:
            endpoint._stop_capture()

        assert [row[2] for row in _kept_rows(pipe)] == ['text', 'text:retry:1']


class TestProcessedMessagesAreCaptured:
    """Whole messages through ``_process_message``, as the base node now handles them."""

    @staticmethod
    def _endpoint(pipe, *, merge=True):
        endpoint = _endpoint(pipe, capture_events=True)
        endpoint._merge_attachments = merge
        endpoint._max_attachment_bytes = 1024
        endpoint._text_attachment_extensions = ['.txt']
        endpoint._text_attachment_max_chars = 12000
        endpoint._show_typing = False
        endpoint._send_responses = False
        endpoint._emit_outbound = False
        endpoint._emit_no_reply = True
        endpoint._include_member_metadata = False
        endpoint._closing = False
        endpoint._bot = mock.Mock()
        endpoint._bot.user.id = 9009
        return endpoint

    @staticmethod
    def _attachment(filename, data, content_type, attachment_id):
        attachment = mock.Mock()
        attachment.filename = filename
        attachment.content_type = content_type
        attachment.size = len(data)
        attachment.id = attachment_id
        attachment.read = mock.AsyncMock(return_value=data)
        return attachment

    @staticmethod
    def _message(content, *attachments):
        message = mock.Mock()
        message.content = content
        message.attachments = list(attachments)
        message.channel = mock.Mock()
        message.channel.id = 2002
        message.id = 1001
        message.author.id = 4004
        message.author.bot = False
        message.guild = None
        message.mentions = []
        message.role_mentions = []
        message.reference = None
        message.created_at = None
        return message

    def test_a_binary_file_in_merge_mode_keeps_its_own_row(self):
        # A text-like file holding binary content is now its own binary lane
        # object in merge mode too: every part still has a distinct key.
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe)
        notes = self._attachment('notes.txt', b'ok\x00binary', 'text/plain', 6006)
        report = self._attachment('report.pdf', b'%PDF-1.4', 'application/pdf', 6007)
        try:
            asyncio.run(endpoint._process_message(self._message('have a look', notes, report)))
        finally:
            endpoint._stop_capture()

        kept = _kept_rows(pipe)
        assert sorted(row[2] for row in kept if row[0] == 'message') == ['binary:1', 'binary:2', 'text']
        assert len(kept) == 3

    @pytest.mark.parametrize('merge', [False, True])
    def test_text_plus_an_attachment_gives_two_rows_and_a_redelivery_adds_none(self, merge):
        """Merge off: text pass then the file. Merge on: the binary file is its own lane object, then the question."""
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe, merge=merge)
        report = self._attachment('report.pdf', b'%PDF-1.4', 'application/pdf', 6007)
        message = self._message('have a look', report)
        try:
            asyncio.run(endpoint._process_message(message))
            # The Gateway can deliver the same message again after a resume.
            asyncio.run(endpoint._process_message(message))
        finally:
            endpoint._stop_capture()

        inserted = sorted(call[2]['params'][2] for call in pipe.calls if 'INSERT INTO' in call[2]['sql'])
        assert inserted == ['binary:1', 'binary:1', 'text', 'text']
        kept = _kept_rows(pipe)
        assert sorted(row[2] for row in kept if row[0] == 'message') == ['binary:1', 'text']
        assert all(row[1] == '1001' for row in kept)

    def test_a_message_skipped_at_shutdown_leaves_only_its_no_reply(self):
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe)
        endpoint._closing = True
        try:
            asyncio.run(endpoint._process_message(self._message('hello')))
        finally:
            endpoint._stop_capture()

        assert [(row[0], row[2]) for row in _kept_rows(pipe)] == [('no_reply', 'shutdown')]

    def test_a_retried_text_pass_is_captured_through_process_message(self):
        """A scratchpad first answer, then a real one: the retry keeps its own `text:retry:1` row."""
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe)
        endpoint._sanitize_replies = True
        endpoint._non_answer_retries = 1
        answers = iter(['Thought: I should look this up', 'The real answer'])

        def new_entry(*args, **kwargs):
            entry = mock.Mock()
            entry.response.toDict.return_value = {'answers': [next(answers)]}
            return entry

        endpoint._new_entry = mock.Mock(side_effect=new_entry)
        message = self._message('how do I deploy?')
        try:
            asyncio.run(endpoint._process_message(message))
            # The Gateway can deliver the same message again after a resume.
            answers = iter(['Thought: I should look this up', 'The real answer'])
            asyncio.run(endpoint._process_message(message))
        finally:
            endpoint._stop_capture()

        kept = _kept_rows(pipe)
        assert sorted((row[0], row[2]) for row in kept) == [('message', 'text'), ('message', 'text:retry:1')]
        inserted = [call[2]['params'] for call in pipe.calls if 'INSERT INTO' in call[2]['sql']]
        assert len(inserted) == 4

    @staticmethod
    def _record_sse(endpoint):
        """Replace the SSE broadcast with a recorder of its ``message`` payloads."""
        sent = []
        endpoint._send_sse = lambda pipe, event_type, metadata, payload: sent.append((event_type, dict(payload)))
        return sent

    @pytest.mark.parametrize('merge', [False, True])
    def test_a_long_message_is_stored_whole_and_broadcast_clipped(self, merge):
        """Discord allows 4000 characters; the 2000 clip is the broadcast's, not the capture's."""
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe, merge=merge)
        sent = self._record_sse(endpoint)
        question = 'q' * 3999 + 'Z'
        try:
            asyncio.run(endpoint._process_message(self._message(question)))
        finally:
            endpoint._stop_capture()

        (row,) = [row for row in _kept_rows(pipe) if row[0] == 'message']
        assert row[9] == question
        assert json.loads(row[10])['text'] == question
        (broadcast,) = [payload for event_type, payload in sent if event_type == 'message']
        assert broadcast['text'] == question[:2000]

    def test_merge_mode_stores_only_the_users_own_text(self):
        """The folded file contents are pipeline input, not what the user wrote."""
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe, merge=True)
        sent = self._record_sse(endpoint)
        notes = self._attachment('notes.txt', b'secret file body', 'text/plain', 6006)
        try:
            asyncio.run(endpoint._process_message(self._message('what is this?', notes)))
        finally:
            endpoint._stop_capture()

        (row,) = [row for row in _kept_rows(pipe) if row[0] == 'message']
        assert row[9] == 'what is this?'
        assert 'secret file body' not in row[10]
        (broadcast,) = [payload for event_type, payload in sent if event_type == 'message']
        assert broadcast['text'] == 'what is this?'

    def test_merge_mode_with_no_text_of_its_own_stores_no_text(self):
        pipe = _PipelinePipe()
        endpoint = self._endpoint(pipe, merge=True)
        sent = self._record_sse(endpoint)
        notes = self._attachment('notes.txt', b'secret file body', 'text/plain', 6006)
        try:
            asyncio.run(endpoint._process_message(self._message('', notes)))
        finally:
            endpoint._stop_capture()

        (row,) = [row for row in _kept_rows(pipe) if row[0] == 'message']
        assert not row[9]
        assert 'secret file body' not in row[10]
        # The broadcast still carries the merged question, as before.
        (broadcast,) = [payload for event_type, payload in sent if event_type == 'message']
        assert 'secret file body' in broadcast['text']


# ===========================================================================
# README
# ===========================================================================


def _normalized_sql(sql):
    """Collapse whitespace so the README's laid-out DDL compares to the one-line string."""
    sql = re.sub(r'\s+', ' ', sql).strip()
    sql = re.sub(r'\( ', '(', sql)
    sql = re.sub(r' \)', ')', sql)
    return sql.rstrip(';')


def test_the_readme_ddl_is_exactly_what_capture_runs():
    """Operators create the table in advance from this block, so it must not drift."""
    with open(os.path.join(_NODE_DIR, 'README.md'), encoding='utf-8') as handle:
        readme = handle.read()
    (block,) = re.findall(r'```sql\n(CREATE TABLE IF NOT EXISTS "discord_events".*?)```', readme, re.S)
    assert _normalized_sql(block) == _normalized_sql(CREATE_TABLE_SQL('discord_events'))


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

    def test_the_capture_edge_can_be_drawn_in_the_editor(self, schema):
        """The canvas draws a tool handle only for the keys of ``invoke``; ``min: 0`` keeps it optional."""
        assert schema['invoke']['tool']['min'] == 0

    def test_the_source_is_not_an_invoke_target(self, schema):
        """The ``invoke`` capability draws a top handle for being invoked, which nothing can connect to."""
        assert 'invoke' not in schema['capabilities']

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

    def test_the_capture_events_description_says_postgres_only_and_the_rights(self, schema):
        description = schema['fields']['discord.captureEvents']['description']
        assert 'PostgreSQL only' in description
        assert 'INSERT' in description
        assert 'CREATE' in description
        assert 'no grant on a sequence' in description

    @pytest.mark.parametrize('field', ['discord.captureEvents', 'discord.captureNodeId'])
    def test_the_capture_descriptions_warn_about_allow_execute(self, schema, field):
        """The editor description is all a pipeline builder sees; it must say not to reuse an agent's node."""
        description = schema['fields'][field]['description']
        assert 'Allow direct query execution' in description
        assert 'raw SQL to every caller of that node' in description
        assert 'never one an agent can reach' in description

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
        ('discord:discord_1\n', False),
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
        if param.tool_name != 'dialect' and not param.input['sql'].startswith('SELECT to_regclass'):
            self.calls.append((nodeId, param.tool_name, dict(param.input), lane))
        self._answer(param, nodeId)


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

    (insert,) = pipe.calls
    assert insert[0] == 'db_1' and insert[1] == 'execute' and insert[3] == 'tool'
    assert pipe.dialect_calls == ['db_1']
    assert [call[0] for call in pipe.check_calls] == ['db_1']
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


def _emitted_fixed_no_reply_reasons():
    """The string literals IEndpoint passes as the reason to ``_emit_no_reply_event``."""
    import ast

    with open(os.path.join(_NODE_DIR, 'IEndpoint.py'), encoding='utf-8') as handle:
        tree = ast.parse(handle.read())

    def literals(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return {node.value}
        if isinstance(node, ast.IfExp):
            return literals(node.body) | literals(node.orelse)
        return set()

    found = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == '_emit_no_reply_event'
            and len(node.args) >= 2
        ):
            found |= literals(node.args[1])
        # ``_skip_reason`` returns the reason that the caller passes on by name.
        if isinstance(node, ast.AsyncFunctionDef) and node.name == '_skip_reason':
            for child in ast.walk(node):
                if isinstance(child, ast.Return) and child.value is not None:
                    found |= literals(child.value)
    return found


class TestEveryFixedNoReplyReasonHasAKey:
    """A reason the node emits as a fixed code must not be keyed as `error`."""

    def test_the_key_list_matches_the_reasons_the_node_emits(self):
        assert _emitted_fixed_no_reply_reasons() == set(capture.NO_REPLY_REASON_CODES)
