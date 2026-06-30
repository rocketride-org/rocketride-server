# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for attachment-drop / provider-error notices surfaced by ``ChatBase``.

The seam is ``ChatBase.chat(..., on_notice=...)``: a spy callback records the
structured notice dicts the base emits so the node layer can route them to the
``attachment_notice`` SSE stream. Three behaviours are pinned here:

* an attachment over the 100 MB LLM cap yields a ``too_large`` notice and is
  never translated or read;
* a translator ``unsupported`` drop yields an ``unsupported`` notice carrying
  the attachment filename;
* a provider call that raises yields a ``provider_error`` notice while ``chat``
  still answers via the text-only fallback.
"""

from __future__ import annotations

import inspect

from ai.common.chat import ChatBase
from ai.common.schema import Attachment


def _att(mime: str, name: str = 'x', size: int = 10) -> Attachment:
    return Attachment(
        attachment_id='11111111-1111-1111-1111-111111111111',
        mime=mime,
        filename=name,
        size_bytes=size,
        path=f'.chats/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/{name}',
    )


class _RecordingFileStore:
    """File store spy: records every ``read_bytes`` path it is asked for."""

    def __init__(self):
        self.reads: list = []

    def read_bytes(self, path):
        self.reads.append(path)
        return b'data'


class _Q:
    """Duck-typed Question carrying attachments and a fixed prompt."""

    def __init__(self, attachments, prompt='hello', expectJson=False):
        self.attachments = attachments
        self.expectJson = expectJson
        self._prompt = prompt

    def getPrompt(self, has_previous_json_failed=False):  # noqa: ARG002
        return self._prompt


class _Chat(ChatBase):
    """Concrete ChatBase with injected file store and controllable provider call."""

    provider_shape = 'openai'

    def __init__(self, file_store, blocks_raises=None, fallback='fallback-text'):
        # Skip ChatBase.__init__ — it needs provider config irrelevant here.
        self._provider = 'openai'
        self._file_store = file_store
        self._blocks_raises = blocks_raises
        self._fallback = fallback
        self.blocks_seen = None

    def _chat_blocks(self, blocks):
        if self._blocks_raises is not None:
            raise self._blocks_raises
        self.blocks_seen = blocks
        return 'blocks-answer'

    def chat_string(self, prompt, on_chunk=None, on_finish=None, on_reasoning_chunk=None):
        return self._fallback


def test_too_large_attachment_emits_notice_and_is_not_read():
    fs = _RecordingFileStore()
    chat = _Chat(fs)
    notices: list = []
    att = _att('audio/mpeg', 'big.mp3', size=200 * 1024 * 1024)

    chat.chat(_Q([att]), on_notice=notices.append)

    assert [n['reason'] for n in notices] == ['too_large']
    assert notices[0]['filename'] == 'big.mp3'
    assert notices[0]['mime'] == 'audio/mpeg'
    assert notices[0]['provider'] == 'openai'
    assert 'message' in notices[0]
    # Over-cap attachment must never be translated/read.
    assert fs.reads == []


def test_unsupported_drop_emits_notice_with_filename():
    fs = _RecordingFileStore()
    chat = _Chat(fs)
    notices: list = []
    # OpenAI shape has no video carriage → drop-and-warn.
    att = _att('video/mp4', 'clip.mp4', size=10)

    chat.chat(_Q([att]), on_notice=notices.append)

    assert [n['reason'] for n in notices] == ['unsupported']
    assert notices[0]['filename'] == 'clip.mp4'
    assert notices[0]['mime'] == 'video/mp4'
    assert notices[0]['provider'] == 'openai'


def test_provider_error_emits_notice_and_falls_back_to_text():
    fs = _RecordingFileStore()
    chat = _Chat(fs, blocks_raises=RuntimeError('boom'))
    notices: list = []
    att = _att('image/png', 'shot.png', size=10)

    answer = chat.chat(_Q([att]), on_notice=notices.append)

    # The turn still answers via the text-only fallback.
    assert answer.getText() == 'fallback-text'
    pe = next(n for n in notices if n['reason'] == 'provider_error')
    assert 'boom' in pe['message']


# ---------------------------------------------------------------------------
# Regression: narrow-signature drivers (perplexity/mistral) must not receive
# on_notice — the llm_base dispatch must guard with accepts_notice before
# passing the kwarg. Reproduces the TypeError fixed in llm_base._question.
# ---------------------------------------------------------------------------


class _NarrowChat:
    """Stub chat driver with the narrow ``chat(self, question)`` signature.

    Mirrors perplexity.py:Chat and mistral.py:Chat — no streaming callbacks,
    no on_notice parameter.  Calling it with on_notice=... must raise TypeError.
    """

    def __init__(self):
        self.calls: list = []

    def chat(self, question):
        self.calls.append(question)
        return 'narrow-answer'


def _dispatch(chat, question, on_notice_fn):
    """Replicate the accepts_stream / accepts_notice guard from llm_base._question."""
    try:
        accepts_stream = 'on_chunk' in inspect.signature(chat.chat).parameters
    except (TypeError, ValueError):
        accepts_stream = True
    try:
        accepts_notice = 'on_notice' in inspect.signature(chat.chat).parameters
    except (TypeError, ValueError):
        accepts_notice = False
    if not accepts_stream:
        return chat.chat(question, **({'on_notice': on_notice_fn} if accepts_notice else {}))
    return chat.chat(question, on_notice=on_notice_fn)


def test_narrow_chat_driver_not_passed_on_notice():
    """Guard: dispatch must NOT pass on_notice to a narrow-signature chat driver."""
    chat = _NarrowChat()
    notices: list = []
    question = object()

    # Must not raise TypeError.
    result = _dispatch(chat, question, notices.append)

    assert result == 'narrow-answer'
    assert chat.calls == [question]
    # on_notice must never have been invoked (driver wouldn't have called it).
    assert notices == []


def test_narrow_chat_direct_call_raises_typeerror():
    """Sanity: confirm the narrow driver WOULD raise if called with on_notice directly."""
    chat = _NarrowChat()
    try:
        chat.chat(object(), on_notice=lambda n: None)
        raise AssertionError('expected TypeError was not raised')
    except TypeError:
        pass  # expected


# ---------------------------------------------------------------------------
# I1 regression: if translate/read_bytes raises (e.g. FileStore 100 MB cap
# hit when size_bytes was 0/missing), the turn must still answer and the
# failure must surface as a too_large notice — not propagate uncaught.
# ---------------------------------------------------------------------------


class _ErrorFileStore:
    """File store stub whose read_bytes always raises (simulates store-cap breach)."""

    def read_bytes(self, path):
        raise OSError('simulated store cap exceeded')


def test_translate_read_error_emits_too_large_notice_and_falls_back():
    """translate() raising (e.g. read_bytes StorageError) must emit too_large notice
    and return the text-only fallback — never propagate to the caller.
    """
    chat = _Chat(_ErrorFileStore())
    notices: list = []
    # size is under the 100 MB pre-check cap so the attachment reaches translate()
    att = _att('image/png', 'photo.png', size=10)

    answer = chat.chat(_Q([att]), on_notice=notices.append)

    # Turn still answers via text-only fallback.
    assert answer.getText() == 'fallback-text'
    # Exactly one notice, with the right reason.
    assert len(notices) == 1
    assert notices[0]['reason'] == 'too_large'
    assert 'message' in notices[0]
    assert notices[0]['provider'] == 'openai'
