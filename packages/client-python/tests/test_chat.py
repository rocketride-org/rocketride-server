# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Python Chat class mirror.

Faithful subset of the TS suite (``packages/client-typescript/tests/Chat.test.ts``):
round-trip, atomic-per-turn, catalog mutation, optimistic-lock retry, format
guards. All file IO is mocked via an in-memory ``MockFsClient`` so the tests
do not touch the network or a real ``FileStore``.

Run with:
  PYTHONPATH=packages/client-python/src python -m pytest packages/client-python/tests/test_chat.py -v
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest

from rocketride.chat import (
    Chat,
    CHAT_SCHEMA_VERSION,
    CATALOG_SCHEMA_VERSION,
    CatalogContentionError,
    ChatNotFoundError,
    EAGER_HISTORY_TURNS,
    list_chats,
    parse_chat_file,
)
from rocketride.schema import Question


class MockFsClient:
    """In-memory stand-in for RocketRideClient's fs_* + chat methods."""

    def __init__(self):
        """Initialise an empty in-memory store with no recorded chat calls."""
        self.files: Dict[str, str] = {}
        self.dirs: set[str] = set()
        self.chat_calls: List[Dict[str, Any]] = []
        self._answer = {'body': 'mock answer text'}

    def set_answer(self, value):
        self._answer = value

    def set_answer_raises(self, exc):
        self._answer_raises = exc

    async def fs_mkdir(self, path: str) -> None:
        self.dirs.add(path)

    async def fs_rmdir(self, path: str, *, recursive: bool = False) -> None:
        self.dirs.discard(path)
        if recursive:
            for key in list(self.files.keys()):
                if key.startswith(path + '/'):
                    del self.files[key]

    async def fs_stat(self, path: str) -> dict:
        if path in self.files:
            return {'exists': True, 'type': 'file', 'size': len(self.files[path])}
        if path in self.dirs:
            return {'exists': True, 'type': 'dir'}
        return {'exists': False}

    async def fs_read_string(self, path: str, encoding: str = 'utf-8') -> str:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    async def fs_write_string(self, path: str, text: str, encoding: str = 'utf-8') -> None:
        self.files[path] = text

    async def fs_read_json(self, path: str):
        return json.loads(await self.fs_read_string(path))

    async def fs_write_json(self, path: str, obj) -> None:
        await self.fs_write_string(path, json.dumps(obj, indent=2))

    async def chat(self, *, token, question, on_sse=None):
        if hasattr(self, '_answer_raises'):
            raise self._answer_raises
        self.chat_calls.append({'token': token, 'question': question})
        return self._answer


PIPELINE_ID = 'pipe-test'
TOKEN = 'test-token'


@pytest.mark.asyncio
async def test_create_writes_header_and_skips_catalog():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    assert chat.id and chat.pipeline_id == PIPELINE_ID

    text = fs.files[f'.chats/{chat.id}/chat.jsonl']
    lines = [line for line in text.split('\n') if line]
    assert len(lines) == 1
    header = json.loads(lines[0])
    assert header['type'] == 'header'
    assert header['schema_version'] == CHAT_SCHEMA_VERSION
    assert header['guid'] == chat.id
    assert header['pipeline_id'] == PIPELINE_ID
    assert '.chats/catalog.json' not in fs.files


@pytest.mark.asyncio
async def test_round_trip_create_send_open():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('first')
    await chat.send('second')

    reopened = await Chat.open(client=fs, token=TOKEN, chat_id=chat.id)
    assert reopened.id == chat.id
    assert reopened.pipeline_id == PIPELINE_ID
    assert [t.seq for t in reopened.history] == [1, 2]


@pytest.mark.asyncio
async def test_open_missing_raises_chat_not_found():
    fs = MockFsClient()
    with pytest.raises(ChatNotFoundError):
        await Chat.open(client=fs, token=TOKEN, chat_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')


@pytest.mark.asyncio
async def test_send_writes_exactly_one_turn_line():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('hello')

    text = fs.files[f'.chats/{chat.id}/chat.jsonl']
    lines = [line for line in text.split('\n') if line]
    assert len(lines) == 2  # header + 1 turn
    turn = json.loads(lines[1])
    assert turn['type'] == 'turn'
    assert turn['seq'] == 1
    assert turn['schema_version'] == CHAT_SCHEMA_VERSION


@pytest.mark.asyncio
async def test_engine_failure_leaves_no_partial_turn():
    fs = MockFsClient()
    fs.set_answer_raises(RuntimeError('engine boom'))
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    with pytest.raises(RuntimeError, match='engine boom'):
        await chat.send('hi')
    text = fs.files[f'.chats/{chat.id}/chat.jsonl']
    lines = [line for line in text.split('\n') if line]
    assert len(lines) == 1  # header only


@pytest.mark.asyncio
async def test_send_threads_chat_id_and_eager_history_into_question():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('t1')
    await chat.send('t2')
    await chat.send('t3')
    await chat.send('t4')

    last_q: Question = fs.chat_calls[-1]['question']
    assert last_q.chat_id == chat.id
    assert len(last_q.history) <= EAGER_HISTORY_TURNS * 2
    # The oldest entry should be the user message of the oldest of the last-3 turns ("t1" — the very first send).
    assert last_q.history[0].role == 'user'
    assert last_q.history[0].content == 't1'


@pytest.mark.asyncio
async def test_send_populates_catalog_first_turn():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('hello world ' * 20)

    cat = json.loads(fs.files['.chats/catalog.json'])
    assert cat['schema_version'] == CATALOG_SCHEMA_VERSION
    assert len(cat['chats']) == 1
    entry = cat['chats'][0]
    assert entry['guid'] == chat.id
    assert entry['pipeline_id'] == PIPELINE_ID
    assert entry['message_count'] == 1
    assert len(entry['preview']) <= 80
    assert 'hello world' in entry['preview']


@pytest.mark.asyncio
async def test_rename_mutates_catalog_only():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('first')
    before = fs.files[f'.chats/{chat.id}/chat.jsonl']
    await chat.rename('My renamed chat')
    after = fs.files[f'.chats/{chat.id}/chat.jsonl']
    assert before == after
    cat = json.loads(fs.files['.chats/catalog.json'])
    assert cat['chats'][0]['title'] == 'My renamed chat'


@pytest.mark.asyncio
async def test_delete_removes_catalog_entry_and_directory():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('alpha')
    await chat.delete()
    cat = json.loads(fs.files['.chats/catalog.json'])
    assert cat['chats'] == []
    assert f'.chats/{chat.id}/chat.jsonl' not in fs.files


@pytest.mark.asyncio
async def test_list_chats_filters_by_pipeline_and_empty_when_missing():
    fs = MockFsClient()
    assert await list_chats(fs) == []

    a = await Chat.create(client=fs, token=TOKEN, pipeline_id='pipe-A')
    await a.send('hi A')
    b = await Chat.create(client=fs, token=TOKEN, pipeline_id='pipe-B')
    await b.send('hi B')

    all_entries = await list_chats(fs)
    assert len(all_entries) == 2
    just_a = await list_chats(fs, pipeline_id='pipe-A')
    assert len(just_a) == 1 and just_a[0].guid == a.id


def test_parse_chat_file_skips_unknown_record_types():
    lines = [
        json.dumps({'type': 'header', 'schema_version': 1, 'guid': 'x', 'created': 't', 'pipeline_id': 'p'}),
        json.dumps({'type': 'future_record', 'schema_version': 7, 'payload': 'opaque'}),
        json.dumps({'type': 'turn', 'schema_version': 1, 'seq': 1, 'created': 't', 'question': {}, 'answer': {}}),
    ]
    header, turns = parse_chat_file('\n'.join(lines))
    assert header is not None
    assert len(turns) == 1


def test_parse_chat_file_tolerates_partial_trailing_line():
    good = json.dumps({'type': 'header', 'schema_version': 1, 'guid': 'x', 'created': 't', 'pipeline_id': 'p'})
    turn = json.dumps({'type': 'turn', 'schema_version': 1, 'seq': 1, 'created': 't', 'question': {}, 'answer': {}})
    raw = good + '\n' + turn + '\n{"type":"turn","sch'
    header, turns = parse_chat_file(raw)
    assert header is not None
    assert len(turns) == 1


def test_question_rejects_non_uuid_chat_id():
    with pytest.raises(Exception):
        Question(chat_id='not-a-uuid')
    q = Question(chat_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    assert q.chat_id == 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


@pytest.mark.asyncio
async def test_catalog_contention_exhausts_after_max_retries():
    fs = MockFsClient()
    chat = await Chat.create(client=fs, token=TOKEN, pipeline_id=PIPELINE_ID)
    await chat.send('one')

    # Force a contention scenario: every "verify" read (even-numbered reads)
    # pretends someone else just bumped the version since we last looked.
    reads = {'n': 0}
    real_read_json = fs.fs_read_json

    async def patched_read_json(path):
        reads['n'] += 1
        cat = await real_read_json(path)
        if reads['n'] % 2 == 0:
            cat['version'] = (cat.get('version') or 0) + 100
        return cat

    fs.fs_read_json = patched_read_json  # type: ignore[method-assign]

    with pytest.raises(CatalogContentionError):
        await chat.rename('contention test')
