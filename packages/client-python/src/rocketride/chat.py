# =============================================================================
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
# =============================================================================

"""Python mirror of the TypeScript ``Chat`` class for persistent chat sessions.

Faithful symmetry with ``packages/client-typescript/src/client/Chat.ts``: same
on-disk layout (``.chats/<chat_id>/chat.jsonl`` + per-user ``.chats/catalog.json``)
and same optimistic-version retry on catalog writes. All persistence is owned
by this client over existing ``fs_*`` primitives on ``RocketRideClient``; the
engine/chat node is unchanged.

See ``claude/research/multimodal-chat-sessions/TDD - chat sessions.md`` for the
end-to-end design rationale.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, List, Optional, Protocol, Sequence

from .schema.question import Question, QuestionType

CHAT_SCHEMA_VERSION = 1
CATALOG_SCHEMA_VERSION = 1
EAGER_HISTORY_TURNS = 3
CATALOG_PREVIEW_LEN = 80
CATALOG_MAX_RETRY = 3
CHATS_ROOT = '.chats'
CATALOG_PATH = '.chats/catalog.json'
_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)


class RocketRideChatClient(Protocol):
    """Structural protocol covering the surface ``Chat`` needs."""

    async def fs_mkdir(self, path: str) -> None: ...
    async def fs_rmdir(self, path: str, *, recursive: bool = ...) -> None: ...
    async def fs_stat(self, path: str) -> dict: ...
    async def fs_read_string(self, path: str, encoding: str = ...) -> str: ...
    async def fs_write_string(self, path: str, text: str, encoding: str = ...) -> None: ...
    async def fs_read_json(self, path: str) -> Any: ...
    async def fs_write_json(self, path: str, obj: Any) -> None: ...

    async def chat(self, *, token: str, question: Question, on_sse: Any = ...) -> Any: ...


@dataclass
class ChatTurn:
    type: str
    schema_version: int
    seq: int
    created: str
    question: dict
    answer: Any


@dataclass
class ChatHeader:
    type: str
    schema_version: int
    guid: str
    created: str
    pipeline_id: str


@dataclass
class ChatCatalogEntry:
    guid: str
    title: str
    created: str
    updated: str
    message_count: int
    preview: str
    pipeline_id: str


@dataclass
class _Catalog:
    schema_version: int = CATALOG_SCHEMA_VERSION
    version: int = 0
    chats: List[ChatCatalogEntry] = field(default_factory=list)


class ChatNotFoundError(Exception):
    """Raised by ``Chat.open`` when the chat file is missing."""


class CatalogContentionError(Exception):
    """Raised when optimistic-lock retry on ``catalog.json`` is exhausted."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_chat_id() -> str:
    return str(uuid.uuid4())


def _extract_question_text(question_dict: dict) -> str:
    qs = question_dict.get('questions') or []
    if not qs:
        return ''
    last = qs[-1] or {}
    return str(last.get('text') or '')


def extract_answer_text(answer: Any) -> str:
    """Best-effort plain-text rendering of a stored PIPELINE_RESULT."""
    if answer is None:
        return ''
    if isinstance(answer, str):
        return answer
    if not isinstance(answer, dict):
        return str(answer)
    body = answer.get('body')
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        for k in ('content', 'text', 'message'):
            v = body.get(k)
            if isinstance(v, str):
                return v
    for k in ('content', 'text'):
        v = answer.get(k)
        if isinstance(v, str):
            return v
    return ''


def parse_chat_file(raw: str) -> tuple[Optional[ChatHeader], List[ChatTurn]]:
    """Parse a chat.jsonl text blob; tolerates partial-write trailing line."""
    header: Optional[ChatHeader] = None
    turns: List[ChatTurn] = []
    for line in raw.split('\n'):
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            # Partial write on the trailing line — tolerate.
            continue
        kind = rec.get('type')
        if kind == 'header':
            if header is None:
                header = ChatHeader(
                    type='header',
                    schema_version=int(rec.get('schema_version', 1)),
                    guid=str(rec.get('guid', '')),
                    created=str(rec.get('created', '')),
                    pipeline_id=str(rec.get('pipeline_id', '')),
                )
            continue
        if kind == 'turn':
            turns.append(
                ChatTurn(
                    type='turn',
                    schema_version=int(rec.get('schema_version', 1)),
                    seq=int(rec.get('seq', 0)),
                    created=str(rec.get('created', '')),
                    question=dict(rec.get('question') or {}),
                    answer=rec.get('answer'),
                )
            )
            continue
        # Unknown record type — forward-compat skip per TDD §5.4.
    return header, turns


class Chat:
    """One persistent chat session, fully client-driven."""

    def __init__(
        self,
        *,
        client: RocketRideChatClient,
        token: str,
        chat_id: str,
        pipeline_id: str,
        created: str,
        history: Sequence[ChatTurn],
    ):
        """Construct a Chat bound to ``client`` for one persistent session.

        Callers should use the ``Chat.create`` / ``Chat.open`` factories rather
        than invoking this constructor directly; the factories handle id
        generation, header writes, and history hydration from disk.
        """
        self._client = client
        self._token = token
        self.id = chat_id
        self.pipeline_id = pipeline_id
        self.created = created
        self.history: List[ChatTurn] = list(history)

    # ------------------------------------------------------------------ factories
    @classmethod
    async def create(
        cls,
        *,
        client: RocketRideChatClient,
        token: str,
        pipeline_id: str,
    ) -> 'Chat':
        if not pipeline_id:
            raise ValueError('pipeline_id is required')
        chat_id = _new_chat_id()
        created = _now()
        dir_path = f'{CHATS_ROOT}/{chat_id}'
        await client.fs_mkdir(dir_path)
        header = {
            'type': 'header',
            'schema_version': CHAT_SCHEMA_VERSION,
            'guid': chat_id,
            'created': created,
            'pipeline_id': pipeline_id,
        }
        await client.fs_write_string(f'{dir_path}/chat.jsonl', json.dumps(header) + '\n')
        return cls(
            client=client,
            token=token,
            chat_id=chat_id,
            pipeline_id=pipeline_id,
            created=created,
            history=[],
        )

    @classmethod
    async def open(
        cls,
        *,
        client: RocketRideChatClient,
        token: str,
        chat_id: str,
    ) -> 'Chat':
        if not _UUID_RE.match(chat_id):
            raise ValueError(f'chat_id must be a UUID; got {chat_id!r}')
        path = f'{CHATS_ROOT}/{chat_id}/chat.jsonl'
        try:
            raw = await client.fs_read_string(path)
        except Exception as e:
            raise ChatNotFoundError(f'chat {chat_id} not found at {path}') from e
        header, turns = parse_chat_file(raw)
        if header is None or header.guid != chat_id:
            raise ValueError(f'chat file at {path} is missing or has mismatched header')
        return cls(
            client=client,
            token=token,
            chat_id=header.guid,
            pipeline_id=header.pipeline_id,
            created=header.created,
            history=turns,
        )

    # -------------------------------------------------------------------- actions
    async def send(
        self,
        text: str,
        *,
        attachments: Optional[Sequence[Any]] = None,  # parked for feature 2
        on_sse: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    ) -> Any:
        question = Question(type=QuestionType.PROMPT, chat_id=self.id)
        question.addQuestion(text)
        for turn in self.history[-EAGER_HISTORY_TURNS:]:
            user_text = _extract_question_text(turn.question)
            assistant_text = extract_answer_text(turn.answer)
            if user_text:
                from .schema.question import QuestionHistory

                question.addHistory(QuestionHistory(role='user', content=user_text))
            if assistant_text:
                from .schema.question import QuestionHistory

                question.addHistory(QuestionHistory(role='assistant', content=assistant_text))

        result = await self._client.chat(token=self._token, question=question, on_sse=on_sse)

        seq = (self.history[-1].seq if self.history else 0) + 1
        turn = ChatTurn(
            type='turn',
            schema_version=CHAT_SCHEMA_VERSION,
            seq=seq,
            created=_now(),
            question=question.model_dump(),
            answer=result,
        )
        await self._append_turn_line(turn)
        self.history.append(turn)
        await self._update_catalog_for_turn(turn)
        return result

    async def rename(self, title: str) -> None:
        new_title = (title or '').strip() or 'Untitled chat'

        def _mutate(catalog: _Catalog) -> None:
            for entry in catalog.chats:
                if entry.guid == self.id:
                    entry.title = new_title
                    entry.updated = _now()
                    break

        await _mutate_catalog(self._client, _mutate)

    async def delete(self) -> None:
        def _mutate(catalog: _Catalog) -> None:
            catalog.chats = [c for c in catalog.chats if c.guid != self.id]

        await _mutate_catalog(self._client, _mutate)
        try:
            await self._client.fs_rmdir(f'{CHATS_ROOT}/{self.id}', recursive=True)
        except Exception:
            # Best-effort. Orphan directory recoverable by §5.5 rebuild.
            pass

    # ------------------------------------------------------------------ internals
    async def _append_turn_line(self, turn: ChatTurn) -> None:
        path = f'{CHATS_ROOT}/{self.id}/chat.jsonl'
        existing = await self._client.fs_read_string(path)
        tail = '' if existing.endswith('\n') else '\n'
        record = {
            'type': turn.type,
            'schema_version': turn.schema_version,
            'seq': turn.seq,
            'created': turn.created,
            'question': turn.question,
            'answer': turn.answer,
        }
        await self._client.fs_write_string(path, existing + tail + json.dumps(record) + '\n')

    async def _update_catalog_for_turn(self, turn: ChatTurn) -> None:
        user_text = _extract_question_text(turn.question)
        preview = user_text[:CATALOG_PREVIEW_LEN]

        def _mutate(catalog: _Catalog) -> None:
            entry = next((c for c in catalog.chats if c.guid == self.id), None)
            if entry is None:
                entry = ChatCatalogEntry(
                    guid=self.id,
                    title='Untitled chat',
                    created=self.created,
                    updated=turn.created,
                    message_count=0,
                    preview='',
                    pipeline_id=self.pipeline_id,
                )
                catalog.chats.append(entry)
            entry.updated = turn.created
            entry.message_count = (entry.message_count or 0) + 1
            entry.preview = preview

        await _mutate_catalog(self._client, _mutate)


async def list_chats(
    client: RocketRideChatClient,
    *,
    pipeline_id: Optional[str] = None,
) -> List[ChatCatalogEntry]:
    """Mirror of ``client.chats.list`` from the TS SDK.

    Returns ``[]`` if the catalog does not exist. Filters by ``pipeline_id`` when
    supplied; callers sort by ``updated`` desc themselves.
    """
    try:
        raw = await client.fs_read_json(CATALOG_PATH)
    except Exception:
        return []
    if not raw or not isinstance(raw, dict):
        return []
    out: List[ChatCatalogEntry] = []
    for c in raw.get('chats') or []:
        if not isinstance(c, dict):
            continue
        entry = ChatCatalogEntry(
            guid=str(c.get('guid', '')),
            title=str(c.get('title', '')),
            created=str(c.get('created', '')),
            updated=str(c.get('updated', '')),
            message_count=int(c.get('message_count', 0) or 0),
            preview=str(c.get('preview', '')),
            pipeline_id=str(c.get('pipeline_id', '')),
        )
        if pipeline_id and entry.pipeline_id != pipeline_id:
            continue
        out.append(entry)
    return out


async def _read_or_init_catalog(client: RocketRideChatClient) -> tuple[_Catalog, int]:
    try:
        raw = await client.fs_read_json(CATALOG_PATH)
    except Exception:
        return _Catalog(), 0
    if not isinstance(raw, dict):
        return _Catalog(), 0
    chats: List[ChatCatalogEntry] = []
    for c in raw.get('chats') or []:
        if not isinstance(c, dict):
            continue
        chats.append(
            ChatCatalogEntry(
                guid=str(c.get('guid', '')),
                title=str(c.get('title', '')),
                created=str(c.get('created', '')),
                updated=str(c.get('updated', '')),
                message_count=int(c.get('message_count', 0) or 0),
                preview=str(c.get('preview', '')),
                pipeline_id=str(c.get('pipeline_id', '')),
            )
        )
    version = int(raw.get('version', 0) or 0)
    return (
        _Catalog(
            schema_version=int(raw.get('schema_version', CATALOG_SCHEMA_VERSION) or CATALOG_SCHEMA_VERSION),
            version=version,
            chats=chats,
        ),
        version,
    )


async def _mutate_catalog(
    client: RocketRideChatClient,
    mutator: Callable[[_Catalog], None],
) -> None:
    for attempt in range(1, CATALOG_MAX_RETRY + 1):
        catalog, observed = await _read_or_init_catalog(client)
        mutator(catalog)
        catalog.version = observed + 1
        try:
            fresh = await client.fs_read_json(CATALOG_PATH)
            fresh_version = int((fresh or {}).get('version', 0) or 0) if isinstance(fresh, dict) else 0
            if fresh_version != observed:
                if attempt == CATALOG_MAX_RETRY:
                    raise CatalogContentionError(
                        f'catalog.json optimistic-lock retry exhausted after {attempt} attempts'
                    )
                await asyncio.sleep(0.02 * attempt)
                continue
        except CatalogContentionError:
            raise
        except Exception:
            # Catalog absent on second read — fine; the write will create it.
            pass
        payload = {
            'schema_version': catalog.schema_version,
            'version': catalog.version,
            'chats': [
                {
                    'guid': c.guid,
                    'title': c.title,
                    'created': c.created,
                    'updated': c.updated,
                    'message_count': c.message_count,
                    'preview': c.preview,
                    'pipeline_id': c.pipeline_id,
                }
                for c in catalog.chats
            ],
        }
        try:
            await client.fs_write_json(CATALOG_PATH, payload)
            return
        except Exception as e:
            # The filestore enforces a per-path write-lock — concurrent writers
            # hit "File already open for writing" before our version check sees
            # the conflict.  Retry the read-modify-write cycle like a normal
            # version-contention case.
            if 'already open for writing' in str(e) and attempt < CATALOG_MAX_RETRY:
                await asyncio.sleep(0.02 * attempt)
                continue
            raise
    raise CatalogContentionError(f'catalog.json optimistic-lock retry exhausted after {CATALOG_MAX_RETRY} attempts')
