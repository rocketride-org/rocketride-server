# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Behavioural tests for the Discord ``IEndpoint`` (lifecycle, routing, replies).

Unlike ``test_discord.py`` (which tests the pure ``text_utils`` helpers), these
tests exercise the real ``IEndpoint`` coroutine surface to lock in:

- the source-node contract: every attachment on a message is ingested (a Discord
  message may carry up to 10) while only the first non-empty answer is replied;
- terminal-failure propagation: a missing/invalid token, a missing privileged
  intent, or an unexpected Gateway close fails the source promptly instead of
  idling forever with a dead bot;
- outbound safety: replies suppress all mentions so model output cannot ping.

``IEndpoint`` imports engine-only modules (``rocketlib``, ``depends``) and
``discord``. Rather than requiring those to be installed, this module stubs them
in ``sys.modules`` and loads the node as a synthetic package, so the suite runs
deterministically in a clean CI environment (it never skips wholesale).
"""

import asyncio
import importlib.util
import json
import os
import sys
import threading
import time
import types
from unittest import mock

import pytest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../src/nodes/discord'))
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')


def _make_discord_stub():
    """Build a minimal ``discord`` stand-in covering what IEndpoint touches."""
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

    class _Object:
        def __init__(self, *, id):
            self.id = id

    discord.Object = _Object

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
        _singleton = None

        def __init__(self, *, everyone=False, users=None, roles=None):
            self.everyone = everyone
            self.users = users or []
            self.roles = roles or []

        @classmethod
        def none(cls):
            # Return a stable instance so tests can assert identity.
            if cls._singleton is None:
                cls._singleton = cls()
            return cls._singleton

    discord.AllowedMentions = _AllowedMentions

    ext = types.ModuleType('discord.ext')
    ext.__path__ = []
    commands = types.ModuleType('discord.ext.commands')
    commands.Bot = type('Bot', (), {})
    ext.commands = commands
    discord.ext = ext
    return discord, ext, commands


def _load_endpoint_class():
    """Load the real ``IEndpoint`` class with engine + discord modules stubbed.

    Returns:
        tuple: (IEndpoint class, discord stub module).
    """
    rocketlib = types.ModuleType('rocketlib')

    class _IEndpointBase:
        pass

    rocketlib.IEndpointBase = _IEndpointBase
    for _name in ('monitorOther', 'monitorStatus', 'monitorCompleted', 'monitorFailed', 'debug'):
        setattr(rocketlib, _name, mock.Mock(name=_name))
    rocketlib.getObject = mock.Mock(name='getObject')

    class _AVI_ACTION:
        BEGIN = 'BEGIN'
        WRITE = 'WRITE'
        END = 'END'

    rocketlib.AVI_ACTION = _AVI_ACTION

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
        pkg = types.ModuleType('_discord_node')
        pkg.__path__ = [_NODE_DIR]
        sys.modules['_discord_node'] = pkg
        for name in ('text_utils', 'IEndpoint'):
            spec = importlib.util.spec_from_file_location(
                f'_discord_node.{name}', os.path.join(_NODE_DIR, f'{name}.py')
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'_discord_node.{name}'] = module
            spec.loader.exec_module(module)
        return sys.modules['_discord_node.IEndpoint'].IEndpoint, discord
    finally:
        # IEndpoint's module globals already hold the stub references, so we can
        # restore the real module table without breaking it — and avoid leaking
        # the discord stub into other test modules.
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


IEndpoint, discord = _load_endpoint_class()
_ENDPOINT_MODULE = sys.modules['_discord_node.IEndpoint']


# ---------------------------------------------------------------------------
# _process_message: attachment ingest-all + first-answer
# ---------------------------------------------------------------------------


def _make_endpoint(*, send_responses=True, merge_attachments=True):
    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint._send_responses = send_responses
    endpoint._merge_attachments = merge_attachments
    endpoint._text_attachment_extensions = ['.pipe', '.txt']
    endpoint._text_attachment_max_chars = 12000
    endpoint._show_typing = False
    endpoint._run_with_optional_typing = mock.AsyncMock(return_value='')
    endpoint._process_attachment = mock.AsyncMock()
    # A real _send_response result: _process_message reads ``messageIds`` to
    # tell a posted reply from one that could not be sent.
    endpoint._send_response = mock.AsyncMock(
        return_value={'messageIds': ['900'], 'destination': 'reply', 'threadId': None, 'messages': []}
    )
    endpoint._emit_no_reply = False
    endpoint._emit_outbound = False
    endpoint._include_member_metadata = False
    endpoint._bot = mock.Mock()
    endpoint._bot.user.id = 999
    # Parity behaviors (all opt-in); tests turn on what they exercise.
    endpoint._thread_history_limit = 0
    endpoint._thread_history_max_chars = 6000
    endpoint._escalation_pause = False
    endpoint._escalation_markers = []
    endpoint._ignore_aimed_at_others = False
    endpoint._ack_emoji = ''
    endpoint._feedback_reactions = False
    endpoint._feedback_emojis = []
    endpoint._sanitize_replies = False
    # Off here so each existing hygiene test keeps asking exactly once; the
    # retry tests below opt in (production defaults to 1).
    endpoint._non_answer_retries = 0
    endpoint._team_mention_alias = ''
    endpoint._number_chunks = False
    endpoint._allowed_mention_role_ids = []
    endpoint._paused_threads = set()
    endpoint._resolved_threads = set()
    return endpoint


def _attachment(filename, data=b'', *, content_type='application/octet-stream', size=None, attachment_id=77):
    """A discord.py ``Attachment`` as the node reads it (name, type, bytes)."""
    attachment = mock.Mock()
    attachment.filename = filename
    attachment.content_type = content_type
    attachment.size = len(data) if size is None else size
    attachment.id = attachment_id
    attachment.read = mock.AsyncMock(return_value=data)
    return attachment


def _make_message(*, content='', attachment_count=0):
    message = mock.Mock()
    message.content = content
    message.attachments = [_attachment(f'file{i}.bin', b'x', attachment_id=70 + i) for i in range(attachment_count)]
    message.channel = mock.Mock()
    message.channel.id = 1
    message.id = 2
    message.author.id = 3
    message.author.bot = False
    message.guild = None
    message.mentions = []
    message.role_mentions = []
    message.reference = None
    message.created_at = None
    return message


def _sent_reply(endpoint):
    if endpoint._send_response.await_count == 0:
        return None
    return endpoint._send_response.await_args.args[1]


class TestProcessMessageAttachments:
    """Every attachment is ingested; only the first non-empty answer is replied."""

    def test_all_attachments_ingested_even_after_answer_found(self):
        endpoint = _make_endpoint()
        endpoint._process_attachment.side_effect = ['', 'answer-2', '']
        message = _make_message(attachment_count=3)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 3  # all ingested
        assert _sent_reply(endpoint) == 'answer-2'  # first non-empty kept

    def test_first_answering_attachment_wins_but_rest_still_ingested(self):
        endpoint = _make_endpoint()
        endpoint._process_attachment.side_effect = ['answer-1', 'answer-2', 'answer-3']
        message = _make_message(attachment_count=3)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 3
        assert _sent_reply(endpoint) == 'answer-1'

    def test_text_answer_kept_but_attachments_still_ingested(self):
        endpoint = _make_endpoint()
        endpoint._run_with_optional_typing.return_value = 'text-answer'
        endpoint._process_attachment.side_effect = ['att-answer-1', 'att-answer-2']
        message = _make_message(content='caption', attachment_count=2)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 2
        assert _sent_reply(endpoint) == 'text-answer'

    def test_oversized_attachment_never_calls_pipeline(self):
        # _process_attachment (the real one) must skip oversized files without
        # a pipeline run; here we assert the size gate at the source.
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._max_attachment_bytes = 1024
        endpoint._show_typing = False
        endpoint._run_binary_pipeline = mock.Mock(name='_run_binary_pipeline')
        attachment = mock.Mock()
        attachment.size = 2048  # over the cap
        attachment.filename = 'big.pdf'
        attachment.read = mock.AsyncMock()
        message = _make_message()

        result = asyncio.run(endpoint._process_attachment(message, attachment))

        assert result == ''
        attachment.read.assert_not_awaited()  # never downloaded
        endpoint._run_binary_pipeline.assert_not_called()  # never routed

    def test_no_answers_ingests_all_and_sends_nothing(self):
        endpoint = _make_endpoint()
        endpoint._process_attachment.side_effect = ['', '', '']
        message = _make_message(attachment_count=3)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 3
        assert endpoint._send_response.await_count == 0

    def test_send_responses_disabled_still_ingests_all(self):
        endpoint = _make_endpoint(send_responses=False)
        endpoint._process_attachment.side_effect = ['answer-1', 'answer-2']
        message = _make_message(attachment_count=2)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 2
        assert endpoint._send_response.await_count == 0

    def test_text_only_message_sends_text_answer(self):
        endpoint = _make_endpoint()
        endpoint._run_with_optional_typing.return_value = 'hello-back'
        message = _make_message(content='hello', attachment_count=0)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 0
        assert _sent_reply(endpoint) == 'hello-back'

    def test_text_like_attachment_uses_text_pipeline(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._max_attachment_bytes = 1024
        endpoint._show_typing = False
        endpoint._text_attachment_extensions = ['.txt']
        endpoint._text_attachment_max_chars = 5
        endpoint._run_text_pipeline = mock.Mock(return_value='text-answer')
        endpoint._run_binary_pipeline = mock.Mock()
        attachment = mock.Mock()
        attachment.size = 20
        attachment.filename = 'NOTES.TXT'
        attachment.content_type = 'application/octet-stream'
        attachment.id = 88
        attachment.read = mock.AsyncMock(return_value=b'abcdefgh')
        message = _make_message()

        result = asyncio.run(endpoint._process_attachment(message, attachment, {'correlationId': '2'}, 3))

        assert result == 'text-answer'
        args = endpoint._run_text_pipeline.call_args.args
        assert args[0] == '[attachment NOTES.TXT]\nabcde'
        assert args[4:] == ('2:3', 88)
        endpoint._run_binary_pipeline.assert_not_called()


class TestAttachmentMerge:
    """mergeAttachments folds files into one question so one answer sees everything."""

    @staticmethod
    def _endpoint(*, merge=True, text_answer='text-answer', binary_answer='image-answer'):
        endpoint = _make_endpoint(merge_attachments=merge)
        endpoint._max_attachment_bytes = 1024
        # The real download + routing path, with only the pipeline calls faked.
        endpoint._process_attachment = IEndpoint._process_attachment.__get__(endpoint)
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)
        endpoint._run_text_pipeline = mock.Mock(return_value=text_answer)
        endpoint._run_binary_pipeline = mock.Mock(return_value=binary_answer)
        return endpoint

    @staticmethod
    def _message(content, *attachments):
        message = _make_message(content=content)
        message.attachments = list(attachments)
        return message

    @staticmethod
    def _text_call(endpoint, index=0):
        """The (text, meta) of one ``_run_text_pipeline`` call."""
        call = endpoint._run_text_pipeline.call_args_list[index]
        return call.args[0], call.args[3]

    def test_text_file_is_folded_into_the_one_question(self):
        endpoint = self._endpoint()
        message = self._message('what does this pipe do?', _attachment('flow.pipe', b'source: discord'))

        asyncio.run(endpoint._process_message(message))

        endpoint._run_binary_pipeline.assert_not_called()  # never its own object
        assert endpoint._run_text_pipeline.call_count == 1
        text, meta = self._text_call(endpoint)
        assert text == ('what does this pipe do?\n\nContents of attached file "flow.pipe":\n```\nsource: discord\n```')
        assert (meta['groupIndex'], meta['groupSize']) == (0, 1)
        assert _sent_reply(endpoint) == 'text-answer'

    def test_truncated_text_file_is_marked(self):
        endpoint = self._endpoint()
        endpoint._text_attachment_max_chars = 4
        message = self._message('look', _attachment('notes.txt', b'abcdefgh', content_type='text/plain'))

        asyncio.run(endpoint._process_message(message))

        text, _meta = self._text_call(endpoint)
        assert '```\nabcd\n… (truncated)\n```' in text

    def test_image_runs_first_then_one_text_pass_carrying_its_answer(self):
        endpoint = self._endpoint()
        message = self._message('why does this fail?', _attachment('shot.png', b'\x89PNG', content_type='image/png'))

        asyncio.run(endpoint._process_message(message))

        binary_call = endpoint._run_binary_pipeline.call_args
        assert binary_call.args[1] == 'image/png'  # still its own image-lane object
        binary_meta = binary_call.args[6]
        assert (binary_meta['groupIndex'], binary_meta['groupSize']) == (1, 2)
        text, text_meta = self._text_call(endpoint)
        assert text == (
            'why does this fail?\n\nWhat the pipeline found in the attached image "shot.png":\nimage-answer'
        )
        assert (text_meta['groupIndex'], text_meta['groupSize']) == (0, 2)
        assert _sent_reply(endpoint) == 'text-answer'  # the text pass answers, not the image

    def test_image_only_is_framed_as_a_request(self):
        endpoint = self._endpoint()
        message = self._message('', _attachment('shot.png', b'\x89PNG', content_type='image/png'))

        asyncio.run(endpoint._process_message(message))

        text, _meta = self._text_call(endpoint)
        assert text.startswith(
            'The user shared the following file(s) with no message. '
            'Explain what each file is and what it does, and help them with it.'
        )
        assert 'What the pipeline found in the attached image "shot.png":' in text
        # Nothing the user typed: the SSE payload falls back to the folded text.
        kwargs = endpoint._run_text_pipeline.call_args.kwargs
        assert kwargs['sse_text'] == text
        assert kwargs['context_chars'] == len(text)
        assert _sent_reply(endpoint) == 'text-answer'

    def test_reply_falls_back_to_the_attachment_answer(self):
        endpoint = self._endpoint(text_answer='')
        message = self._message('what is this?', _attachment('shot.png', b'\x89PNG', content_type='image/png'))

        asyncio.run(endpoint._process_message(message))

        assert endpoint._run_text_pipeline.call_count == 1
        assert _sent_reply(endpoint) == 'image-answer'

    def test_unanswered_image_without_text_behaves_as_before(self):
        endpoint = self._endpoint(binary_answer='')
        message = self._message('', _attachment('shot.png', b'\x89PNG', content_type='image/png'))

        asyncio.run(endpoint._process_message(message))

        endpoint._run_text_pipeline.assert_not_called()  # nothing to ask about
        assert endpoint._send_response.await_count == 0

    def test_binary_content_in_a_text_file_is_skipped(self):
        endpoint = self._endpoint()
        message = self._message('have a look', _attachment('notes.txt', b'ok\x00binary', content_type='text/plain'))

        asyncio.run(endpoint._process_message(message))

        assert endpoint._run_text_pipeline.call_count == 1
        text, meta = self._text_call(endpoint)
        assert text == 'have a look'  # the file contributed nothing
        assert meta['groupSize'] == 1

    def test_oversized_attachment_is_skipped_and_not_counted(self):
        endpoint = self._endpoint()
        message = self._message('check this', _attachment('huge.pipe', b'x' * 10, size=99999))

        asyncio.run(endpoint._process_message(message))

        endpoint._run_binary_pipeline.assert_not_called()
        text, meta = self._text_call(endpoint)
        assert text == 'check this'
        assert meta['groupSize'] == 1

    def test_thread_context_still_wraps_the_merged_question(self):
        endpoint = self._endpoint()
        endpoint._thread_history_limit = 25
        endpoint._bot.user.display_name = 'Rocket Ralph'
        thread = _FakeThread(321, [_FakeHistoryMessage(1, 'the first question', 7, author_name='ada')])
        message = self._message('and this file?', _attachment('flow.pipe', b'source: discord'))
        message.channel = thread
        message.id = 555

        asyncio.run(endpoint._process_message(message))

        text, _meta = self._text_call(endpoint)
        assert text == (
            "User's latest message: and this file?\n\n"
            'Earlier in this thread (oldest first, for context):\n'
            'ada: the first question\n\n'
            'Contents of attached file "flow.pipe":\n```\nsource: discord\n```'
        )
        kwargs = endpoint._run_text_pipeline.call_args.kwargs
        assert kwargs['sse_text'] == 'and this file?'  # SSE keeps the user's own words
        assert kwargs['context_chars'] == len(text) - len('and this file?')

    def test_merge_off_keeps_one_object_per_attachment(self):
        endpoint = self._endpoint(merge=False)
        endpoint._run_text_pipeline = mock.Mock(side_effect=['first', 'second'])
        message = self._message('what does this pipe do?', _attachment('flow.pipe', b'source: discord'))

        asyncio.run(endpoint._process_message(message))

        assert endpoint._run_text_pipeline.call_count == 2  # the message, then the file
        assert self._text_call(endpoint, 0)[0] == 'what does this pipe do?'
        assert self._text_call(endpoint, 1)[0] == '[attachment flow.pipe]\nsource: discord'
        assert _sent_reply(endpoint) == 'first'  # first non-empty answer wins

    def test_merging_is_off_by_default(self):
        assert IEndpoint._merge_attachments is False

    def test_without_extensions_a_text_file_is_routed_as_binary(self):
        """The shipped default: nothing is decoded as text until extensions are listed."""
        endpoint = _make_endpoint()
        endpoint._text_attachment_extensions = []

        assert endpoint._is_text_attachment(_attachment('notes.txt', b'hello', content_type='text/plain')) is False

    def test_listing_an_extension_also_decodes_text_mime_types(self):
        endpoint = _make_endpoint()
        endpoint._text_attachment_extensions = ['.pipe']

        assert endpoint._is_text_attachment(_attachment('notes.txt', b'hello', content_type='text/plain')) is True
        assert endpoint._is_text_attachment(_attachment('flow.pipe', b'{}', content_type='')) is True
        assert endpoint._is_text_attachment(_attachment('shot.png', b'\x89PNG', content_type='image/png')) is False


class TestMetadataAndEvents:
    """Object identity, metadata, and optional event capture stay consistent."""

    @staticmethod
    def _pipeline_endpoint():
        endpoint = IEndpoint.__new__(IEndpoint)
        pipe = mock.Mock()
        target = mock.Mock()
        target.getPipe.return_value = pipe
        endpoint.target = target
        return endpoint, pipe

    def test_text_and_attachment_names_urls_and_metadata(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint, _pipe = self._pipeline_endpoint()
        meta = {'correlationId': '55', 'groupIndex': 0, 'groupSize': 2}
        text_entry = mock.Mock()
        text_entry.response.toDict.return_value = {'answers': []}
        binary_entry = mock.Mock()
        binary_entry.response.toDict.return_value = {'answers': []}

        with mock.patch.object(module, 'getObject', side_effect=[text_entry, binary_entry]) as get_object:
            endpoint._run_text_pipeline('hello', 44, 55, meta)
            endpoint._run_binary_pipeline(b'pdf', 'application/pdf', 66, 44, 55, 1, dict(meta, groupIndex=1))

        assert get_object.call_args_list[0].kwargs['obj'] == {
            'url': 'discord://44/55',
            'name': '55',
        }
        assert get_object.call_args_list[1].kwargs['obj']['url'] == 'discord://44/55/66'
        assert get_object.call_args_list[1].kwargs['obj']['name'] == '55:1'
        # Metadata is attached via the pipe's sendTagMetadata (contract API),
        # not by mutating the entry; both objects share the one pipe mock.
        text_meta = _pipe.sendTagMetadata.call_args_list[0].args[0]
        binary_meta = _pipe.sendTagMetadata.call_args_list[1].args[0]
        assert text_meta['correlationId'] == binary_meta['correlationId'] == '55'
        assert (text_meta['groupIndex'], binary_meta['groupIndex']) == (0, 1)
        assert text_meta['groupSize'] == binary_meta['groupSize'] == 2
        assert text_meta['eventType'] == binary_meta['eventType'] == 'message'

    def test_sse_broadcast_for_objects_and_events(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint, pipe = self._pipeline_endpoint()
        pipe.pipeId = 7
        entry = mock.Mock()
        entry.response.toDict.return_value = {'answers': []}
        fake_engine = types.ModuleType('rocketlib.engine')
        fake_engine.monitorSSE = mock.Mock()

        with (
            mock.patch.object(module, 'getObject', return_value=entry),
            mock.patch.dict(sys.modules, {'rocketlib.engine': fake_engine}),
        ):
            endpoint._run_text_pipeline('hello', 44, 55, {'correlationId': '55'})
            endpoint._emit_event_pipeline(
                {'messageId': '55', 'channelId': '44', 'correlationId': '55'}, 'no_reply', {'reason': 'no_answer'}
            )

        calls = fake_engine.monitorSSE.call_args_list
        assert [c.args[:2] for c in calls] == [(7, 'discord'), (7, 'discord')]
        message, no_reply = calls[0].args[2], calls[1].args[2]
        assert message['schemaVersion'] == 1
        assert (message['eventType'], message['lane'], message['text']) == ('message', 'text', 'hello')
        assert message['metadata']['correlationId'] == '55'
        assert (no_reply['eventType'], no_reply['reason']) == ('no_reply', 'no_answer')

    def test_sse_is_best_effort_without_engine_module(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint, _pipe = self._pipeline_endpoint()
        entry = mock.Mock()
        entry.response.toDict.return_value = {'answers': ['ok']}
        with mock.patch.object(module, 'getObject', return_value=entry):
            assert endpoint._run_text_pipeline('hello', 44, 55, {}) == 'ok'  # no rocketlib.engine: still ingests

    def test_message_metadata_contract(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._include_member_metadata = True
        endpoint._bot = mock.Mock()
        endpoint._bot.user.id = 999
        message = _make_message(content='hello')
        message.id = 55
        message.channel.id = 44
        message.author.display_name = 'Ada'
        message.author.roles = [types.SimpleNamespace(id=7)]
        message.mentions = [types.SimpleNamespace(id=8)]
        message.role_mentions = [types.SimpleNamespace(id=9)]
        message.reference = types.SimpleNamespace(message_id=10)

        metadata = endpoint._message_metadata(message)

        expected = {
            'messageId',
            'channelId',
            'threadId',
            'parentChannelId',
            'guildId',
            'createdAt',
            'authorId',
            'authorIsBot',
            'authorDisplayName',
            'authorRoleIds',
            'mentionedUserIds',
            'mentionedRoleIds',
            'repliedToMessageId',
            'botUserId',
            'attachments',
            'correlationId',
            'groupIndex',
            'groupSize',
        }
        assert expected <= metadata.keys()
        assert metadata['correlationId'] == metadata['messageId'] == '55'
        assert metadata['authorDisplayName'] == 'Ada'
        assert metadata['authorRoleIds'] == ['7']

    def test_no_reply_and_outbound_flags(self):
        endpoint = _make_endpoint()
        endpoint._emit_no_reply = True
        endpoint._emit_outbound = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._emit_outbound_event = mock.AsyncMock()
        endpoint._send_response.return_value = {'messageIds': ['77'], 'destination': 'reply'}
        message = _make_message()

        asyncio.run(endpoint._process_message(message))
        endpoint._emit_no_reply_event.assert_awaited_once()

        endpoint._run_with_optional_typing.return_value = 'answer'
        message.content = 'question'
        asyncio.run(endpoint._process_message(message))
        endpoint._emit_outbound_event.assert_awaited_once()

    def test_outbound_event_still_emitted_when_send_responses_disabled(self):
        endpoint = _make_endpoint(send_responses=False)
        endpoint._emit_outbound = True
        endpoint._emit_outbound_event = mock.AsyncMock()
        endpoint._run_with_optional_typing.return_value = 'answer'
        message = _make_message(content='question')

        asyncio.run(endpoint._process_message(message))

        assert endpoint._send_response.await_count == 0  # nothing posted
        endpoint._emit_outbound_event.assert_awaited_once()
        outbound = endpoint._emit_outbound_event.await_args.args[3]
        assert outbound == {'messageIds': [], 'destination': 'suppressed'}

    def test_event_helpers_noop_when_disabled_and_emit_when_enabled(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._emit_no_reply = False
        endpoint._emit_outbound = False
        endpoint._emit_reactions = False
        endpoint._emit_event_pipeline = mock.Mock()
        endpoint._bot = mock.Mock()
        # A bare Mock is not a user: a reaction removal resolves its reactor
        # through the cache, and an unknown account counts as a human.
        endpoint._bot.get_user = mock.Mock(return_value=None)
        metadata = {'messageId': '1', 'channelId': '2', 'correlationId': '1'}
        payload = types.SimpleNamespace(
            message_id=1,
            channel_id=2,
            guild_id=None,
            user_id=3,
            member=None,
            emoji='ok',
        )

        asyncio.run(endpoint._emit_no_reply_event(metadata, 'no_answer'))
        asyncio.run(endpoint._emit_outbound_event(mock.Mock(), metadata, 'answer', None))
        asyncio.run(endpoint._on_raw_reaction(payload, True))
        endpoint._emit_event_pipeline.assert_not_called()

        endpoint._emit_no_reply = True
        endpoint._emit_outbound = True
        endpoint._emit_reactions = True
        endpoint._include_member_metadata = False
        asyncio.run(endpoint._emit_no_reply_event(metadata, 'no_answer'))
        asyncio.run(endpoint._emit_outbound_event(mock.Mock(), metadata, 'answer', None))
        asyncio.run(endpoint._on_raw_reaction(payload, False))
        assert endpoint._emit_event_pipeline.call_count == 3


# ---------------------------------------------------------------------------
# Support-bot parity behaviors (thread context, pause, ack, feedback, hygiene)
# ---------------------------------------------------------------------------


class _FakeHistoryMessage:
    """A prior thread message as the node reads it (author, content, mentions)."""

    def __init__(self, message_id, content, author_id, *, mentions=(), system=False, author_name=None):
        self.id = message_id
        self.content = content
        self.author = types.SimpleNamespace(id=author_id, name=author_name or f'user{author_id}', bot=False)
        self.mentions = list(mentions)
        self._system = system

    def is_system(self):
        return self._system


class _FakeThread(discord.Thread):
    """A thread channel with a canned history (newest first, as Discord sends)."""

    def __init__(self, thread_id, history=(), parent_id=10):
        self.id = thread_id
        self.parent_id = parent_id
        self._history = list(history)
        self.history_limits = []
        self.history_before = []

    def history(self, limit=None, before=None, **_kwargs):
        self.history_limits.append(limit)
        self.history_before.append(getattr(before, 'id', None))
        items = self._history
        if before is not None:
            # Discord returns only messages older than ``before``, and
            # snowflakes are monotonic, so the id order is the time order.
            items = [item for item in items if item.id < before.id]
        items = items[:limit] if limit else list(items)

        async def _iterate():
            for item in items:
                yield item

        return _iterate()


def _thread_message(endpoint, thread, *, content='latest question', mentions=()):
    message = _make_message(content=content)
    message.channel = thread
    message.id = 555
    message.mentions = list(mentions)
    del endpoint  # only here to keep call sites symmetric
    return message


class TestThreadHistoryContext:
    """threadHistoryLimit carries the earlier thread messages as context."""

    @staticmethod
    def _endpoint(**attrs):
        endpoint = _make_endpoint()
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)
        endpoint._run_text_pipeline = mock.Mock(return_value='')
        endpoint._bot.user.display_name = 'Rocket Ralph'
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    @staticmethod
    def _history():
        return [
            _FakeHistoryMessage(3, 'the earlier answer', 999),  # the bot
            _FakeHistoryMessage(2, '   ', 7),  # blank: dropped
            _FakeHistoryMessage(1, 'the first question', 7, author_name='ada'),
        ]

    def test_context_prepended_for_a_thread_when_enabled(self):
        endpoint = self._endpoint(_thread_history_limit=25)
        thread = _FakeThread(321, self._history())
        message = _thread_message(endpoint, thread, content='and how do I stop it?')

        asyncio.run(endpoint._process_message(message))

        text = endpoint._run_text_pipeline.call_args.args[0]
        assert text == (
            "User's latest message: and how do I stop it?\n\n"
            'Earlier in this thread (oldest first, for context):\n'
            'ada: the first question\nRocket Ralph: the earlier answer'
        )
        assert thread.history_limits == [25]  # the configured limit, once

    def test_the_limit_counts_only_earlier_messages(self):
        """``threadHistoryLimit=N`` must give N messages of context, not N-1.

        Fetching the newest N included the message being answered, so the
        transcript only ever carried N-1 earlier messages (and none at all at
        ``threadHistoryLimit=1``). The fetch is bounded by ``before`` instead.
        """
        endpoint = self._endpoint(_thread_history_limit=2)
        thread = _FakeThread(
            321,
            [
                _FakeHistoryMessage(556, 'a later message', 7, author_name='ada'),
                _FakeHistoryMessage(554, 'third', 7, author_name='ada'),
                _FakeHistoryMessage(553, 'second', 7, author_name='ada'),
                _FakeHistoryMessage(552, 'first', 7, author_name='ada'),
            ],
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread, content='now what?')))

        transcript = endpoint._run_text_pipeline.call_args.args[0].split('for context):\n', 1)[1]
        assert transcript == 'ada: second\nada: third'
        assert thread.history_before == [555], 'the fetch must stop at the current message'

    def test_no_context_when_disabled_or_outside_a_thread(self):
        endpoint = self._endpoint(_thread_history_limit=0)
        thread = _FakeThread(321, self._history())
        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread, content='plain')))
        assert endpoint._run_text_pipeline.call_args.args[0] == 'plain'
        assert thread.history_limits == [], 'history must not be fetched when disabled'

        endpoint = self._endpoint(_thread_history_limit=25)
        asyncio.run(endpoint._process_message(_make_message(content='plain channel message')))
        assert endpoint._run_text_pipeline.call_args.args[0] == 'plain channel message'

    def test_current_message_excluded_and_transcript_capped(self):
        endpoint = self._endpoint(_thread_history_limit=25, _thread_history_max_chars=40)
        history = [_FakeHistoryMessage(555, 'the current message', 7)] + self._history()
        thread = _FakeThread(321, history)

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        text = endpoint._run_text_pipeline.call_args.args[0]
        assert 'the current message' not in text
        transcript = text.split('for context):\n', 1)[1]
        assert transcript.startswith('…\n') and len(transcript) == 42

    def test_history_failure_is_best_effort(self):
        endpoint = self._endpoint(_thread_history_limit=25)

        class _Broken(_FakeThread):
            def history(self, limit=None, **kwargs):
                raise RuntimeError('missing Read Message History')

        asyncio.run(endpoint._process_message(_thread_message(endpoint, _Broken(321), content='still asked')))

        assert endpoint._run_text_pipeline.call_args.args[0] == 'still asked'

    def test_sse_payload_keeps_the_original_text_and_reports_context_size(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint = IEndpoint.__new__(IEndpoint)
        pipe = mock.Mock()
        pipe.pipeId = 7
        target = mock.Mock()
        target.getPipe.return_value = pipe
        endpoint.target = target
        entry = mock.Mock()
        entry.response.toDict.return_value = {'answers': ['ok']}
        fake_engine = types.ModuleType('rocketlib.engine')
        fake_engine.monitorSSE = mock.Mock()

        with (
            mock.patch.object(module, 'getObject', return_value=entry),
            mock.patch.dict(sys.modules, {'rocketlib.engine': fake_engine}),
        ):
            endpoint._run_text_pipeline(
                "User's latest message: q\n\n...context...",
                44,
                55,
                {'correlationId': '55'},
                sse_text='q',
                context_chars=11,
            )

        payload = fake_engine.monitorSSE.call_args.args[2]
        assert payload['text'] == 'q', 'SSE must show what the user actually wrote'
        assert payload['contextChars'] == 11
        assert pipe.writeText.call_args.args[0].startswith("User's latest message: q")


class TestEscalationPause:
    """A thread that escalated stays quiet until the bot is mentioned again."""

    @staticmethod
    def _endpoint(**attrs):
        endpoint = _make_endpoint()
        endpoint._escalation_pause = True
        endpoint._escalation_markers = ['<@&77>']
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    def test_paused_thread_drops_without_mention_and_resumes_with_one(self):
        endpoint = self._endpoint()
        endpoint._paused_threads = {'321'}
        endpoint._resolved_threads = {'321'}  # already reconciled
        thread = _FakeThread(321)
        message = _thread_message(endpoint, thread)

        asyncio.run(endpoint._process_message(message))

        endpoint._run_with_optional_typing.assert_not_awaited()  # nothing ingested
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'paused'
        assert endpoint._paused_threads == {'321'}

        message.mentions = [endpoint._bot.user]
        asyncio.run(endpoint._process_message(message))

        endpoint._run_with_optional_typing.assert_awaited_once()  # processed
        assert endpoint._paused_threads == set(), 'a mention must unpause the thread'

    def test_pause_is_reconstructed_from_thread_history(self):
        endpoint = self._endpoint()
        thread = _FakeThread(
            321,
            [
                _FakeHistoryMessage(3, 'I have looped in <@&77>', 999),  # bot escalated
                _FakeHistoryMessage(2, 'any update?', 7),
                _FakeHistoryMessage(1, 'first question', 7),
            ],
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        assert endpoint._paused_threads == {'321'}
        assert endpoint._resolved_threads == {'321'}
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'paused'
        endpoint._run_with_optional_typing.assert_not_awaited()
        assert thread.history_limits == [50]

    def test_a_mention_after_the_escalation_resumes_the_thread(self):
        endpoint = self._endpoint()
        thread = _FakeThread(
            321,
            [
                _FakeHistoryMessage(3, 'hey <@999> one more thing', 7, mentions=[endpoint._bot.user]),
                _FakeHistoryMessage(2, 'I have looped in <@&77>', 999),
                _FakeHistoryMessage(1, 'first question', 7),
            ],
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        assert endpoint._paused_threads == set()
        endpoint._run_with_optional_typing.assert_awaited_once()

    def test_history_is_reconciled_once_per_thread(self):
        endpoint = self._endpoint()
        thread = _FakeThread(321, [_FakeHistoryMessage(1, 'plain history', 7)])

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))
        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        assert thread.history_limits == [50], 'reconciliation must not repeat per message'

    def test_an_unreadable_history_is_retried_on_the_next_message(self):
        """A failed fetch is "unknown", not "not paused" — it must not stick.

        Marking the thread resolved on a failure froze it as un-paused for the
        rest of the process, so a thread a human had taken over kept getting
        answered. The message in hand is still answered (nothing is known
        against it), but the next one reconciles again.
        """
        endpoint = self._endpoint()
        escalated = [_FakeHistoryMessage(3, 'I have looped in <@&77>', 999)]

        class _FlakyThread(_FakeThread):
            def history(self, limit=None, **kwargs):
                if not self.history_limits:
                    self.history_limits.append(limit)
                    raise RuntimeError('missing Read Message History')
                return super().history(limit=limit, **kwargs)

        thread = _FlakyThread(321, escalated)

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        assert endpoint._resolved_threads == set(), 'a failed fetch must not resolve the thread'
        assert endpoint._paused_threads == set()
        endpoint._run_with_optional_typing.assert_awaited_once()  # answered anyway

        asyncio.run(endpoint._process_message(_thread_message(endpoint, thread)))

        assert endpoint._paused_threads == {'321'}, 'the second message must reconcile again'
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'paused'

    def test_posting_a_marker_answer_into_a_thread_pauses_it(self):
        endpoint = self._endpoint()
        endpoint._resolved_threads = {'321'}
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='escalating to <@&77> now')
        endpoint._send_response = mock.AsyncMock(
            return_value={'messageIds': ['900'], 'destination': 'thread', 'threadId': '321', 'messages': []}
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, _FakeThread(321))))

        assert endpoint._paused_threads == {'321'}

    def test_a_plain_answer_leaves_the_thread_open(self):
        endpoint = self._endpoint()
        endpoint._resolved_threads = {'321'}
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='here is the answer')
        endpoint._send_response = mock.AsyncMock(
            return_value={'messageIds': ['900'], 'destination': 'thread', 'threadId': '321', 'messages': []}
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, _FakeThread(321))))

        assert endpoint._paused_threads == set()

    def test_allowed_mention_roles_count_as_markers(self):
        endpoint = self._endpoint(_escalation_markers=[], _allowed_mention_role_ids=['88'])
        assert endpoint._effective_markers() == ['<@&88>']

    def test_pause_state_is_ignored_when_the_behavior_is_off(self):
        endpoint = self._endpoint(_escalation_pause=False)
        endpoint._paused_threads = {'321'}

        asyncio.run(endpoint._process_message(_thread_message(endpoint, _FakeThread(321))))

        endpoint._run_with_optional_typing.assert_awaited_once()


class TestAimedAtSomeoneElse:
    """A message aimed at somebody else is acknowledged, not answered."""

    @staticmethod
    def _endpoint(**attrs):
        endpoint = _make_endpoint()
        endpoint._ignore_aimed_at_others = True
        endpoint._ack_emoji = '\N{EYES}'
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    def test_ack_reaction_added_and_processing_skipped(self):
        endpoint = self._endpoint()
        message = _make_message(content='hey @someone look at this')
        message.mentions = [types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock()

        asyncio.run(endpoint._process_message(message))

        message.add_reaction.assert_awaited_once_with('\N{EYES}')
        endpoint._run_with_optional_typing.assert_not_awaited()
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'aimed_elsewhere'

    def test_failed_reaction_still_skips(self):
        endpoint = self._endpoint()
        message = _make_message(content='hey @someone')
        message.mentions = [types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock(side_effect=RuntimeError('missing Add Reactions'))

        asyncio.run(endpoint._process_message(message))

        endpoint._run_with_optional_typing.assert_not_awaited()

    def test_no_reaction_without_a_configured_emoji(self):
        endpoint = self._endpoint(_ack_emoji='')
        message = _make_message(content='hey @someone')
        message.mentions = [types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock()

        asyncio.run(endpoint._process_message(message))

        message.add_reaction.assert_not_awaited()
        endpoint._run_with_optional_typing.assert_not_awaited()

    def test_a_mention_of_the_bot_is_answered(self):
        endpoint = self._endpoint()
        message = _make_message(content='hey bot')
        message.mentions = [endpoint._bot.user, types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock()

        asyncio.run(endpoint._process_message(message))

        message.add_reaction.assert_not_awaited()
        endpoint._run_with_optional_typing.assert_awaited_once()

    def test_reply_to_the_bot_is_answered_and_other_replies_are_not(self):
        endpoint = self._endpoint()
        message = _make_message(content='a reply')
        message.reference = types.SimpleNamespace(message_id=42)
        message.add_reaction = mock.AsyncMock()
        own = mock.Mock()
        own.author.id = 999
        message.fetch_reference = mock.AsyncMock(return_value=own)

        asyncio.run(endpoint._process_message(message))
        endpoint._run_with_optional_typing.assert_awaited_once()

        other = mock.Mock()
        other.author.id = 5
        message.fetch_reference = mock.AsyncMock(return_value=other)
        asyncio.run(endpoint._process_message(message))
        message.add_reaction.assert_awaited_once()

    def test_aimed_elsewhere_in_a_thread_pauses_it(self):
        endpoint = self._endpoint(_escalation_pause=True, _escalation_markers=['<@&77>'])
        endpoint._resolved_threads = {'321'}
        message = _thread_message(endpoint, _FakeThread(321))
        message.mentions = [types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock()

        asyncio.run(endpoint._process_message(message))

        assert endpoint._paused_threads == {'321'}


class TestFeedbackReactions:
    """Feedback affordances land on the last posted chunk."""

    @staticmethod
    def _sent(message_id):
        sent = mock.Mock()
        sent.id = message_id
        sent.add_reaction = mock.AsyncMock()
        return sent

    def test_reactions_on_the_last_chunk_only_and_reported_outbound(self):
        endpoint = _make_endpoint()
        endpoint._feedback_reactions = True
        endpoint._feedback_emojis = ['\N{WHITE HEAVY CHECK MARK}', '\N{CROSS MARK}']
        endpoint._emit_outbound = True
        endpoint._emit_outbound_event = mock.AsyncMock()
        first, last = self._sent(901), self._sent(902)
        endpoint._send_response = mock.AsyncMock(
            return_value={
                'messageIds': ['901', '902'],
                'destination': 'channel',
                'threadId': None,
                'messages': [first, last],
            }
        )
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='a long answer')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert [call.args[0] for call in last.add_reaction.await_args_list] == [
            '\N{WHITE HEAVY CHECK MARK}',
            '\N{CROSS MARK}',
        ]
        first.add_reaction.assert_not_awaited()
        outbound = endpoint._emit_outbound_event.await_args.args[3]
        assert outbound['feedbackEmojis'] == ['\N{WHITE HEAVY CHECK MARK}', '\N{CROSS MARK}']

    def test_failed_reaction_is_best_effort_and_not_reported(self):
        endpoint = _make_endpoint()
        endpoint._feedback_reactions = True
        endpoint._feedback_emojis = ['\N{WHITE HEAVY CHECK MARK}']
        last = self._sent(902)
        last.add_reaction = mock.AsyncMock(side_effect=RuntimeError('missing Add Reactions'))
        outbound = {'messageIds': ['902'], 'destination': 'channel', 'threadId': None, 'messages': [last]}
        endpoint._send_response = mock.AsyncMock(return_value=outbound)
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='an answer')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert 'feedbackEmojis' not in outbound

    def test_nothing_is_reacted_to_when_the_behavior_is_off(self):
        endpoint = _make_endpoint()
        last = self._sent(902)
        endpoint._send_response = mock.AsyncMock(
            return_value={'messageIds': ['902'], 'destination': 'channel', 'threadId': None, 'messages': [last]}
        )
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='an answer')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        last.add_reaction.assert_not_awaited()


class TestReplyHygiene:
    """sanitizeReplies strips leaked agent scratchpad before anything is posted."""

    @staticmethod
    def _endpoint(answer):
        endpoint = _make_endpoint()
        endpoint._sanitize_replies = True
        endpoint._escalation_markers = ['<@&77>']
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value=answer)
        return endpoint

    def test_final_answer_is_posted_without_the_scratchpad(self):
        endpoint = self._endpoint('Thought: I should look\nFinal Answer: the clean answer')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'the clean answer'

    def test_reasoning_only_posts_nothing_and_reports_non_answer(self):
        endpoint = self._endpoint('Thought: I have no idea what to do here')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'non_answer'

    def test_reasoning_with_a_marker_becomes_a_handoff(self):
        endpoint = self._endpoint('Thought: bring in <@&77> for this one')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == ("Thanks for flagging this — I've looped in the team to take a look. <@&77>")

    def test_a_plain_answer_is_posted_unchanged_when_disabled(self):
        endpoint = self._endpoint('  Thought: leaked  ')
        endpoint._sanitize_replies = False

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == '  Thought: leaked  '


class TestErrorReplies:
    """An engine/model failure that arrives as the answer is never relayed."""

    # The real one: a quota error that reached a user as Ralph's reply.
    ERROR = "Exception: Error code: 429 - {'error': {'message': 'You have no credits remaining...'}}"

    @staticmethod
    def _endpoint(answers, *, retries=1, sanitize=True):
        endpoint = _make_endpoint()
        endpoint._sanitize_replies = sanitize
        endpoint._non_answer_retries = retries
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)
        endpoint._run_text_pipeline = mock.Mock(side_effect=list(answers))
        return endpoint

    def test_an_error_answer_is_suppressed_and_reported_as_a_model_error(self):
        endpoint = self._endpoint([self.ERROR])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'model_error'

    def test_an_error_answer_is_not_retried(self):
        endpoint = self._endpoint([self.ERROR, 'a real answer'], retries=2)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 1, 'an error is not a transient non-answer'
        assert endpoint._send_response.await_count == 0

    def test_a_traceback_is_suppressed_too(self):
        endpoint = self._endpoint(['Traceback (most recent call last):\n  File "chat.py", line 4'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'model_error'

    def test_an_error_produced_by_a_retry_is_suppressed_as_well(self):
        endpoint = self._endpoint(['Thought: still thinking', self.ERROR, 'never asked'], retries=2)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 2  # the error ends the retries
        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'model_error'

    def test_with_sanitizing_off_the_text_is_posted_exactly_as_before(self):
        endpoint = self._endpoint([self.ERROR], sanitize=False, retries=0)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == self.ERROR

    def test_a_real_answer_is_unaffected(self):
        endpoint = self._endpoint(['Read the task log to see the error that was raised.'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'Read the task log to see the error that was raised.'


class TestTeamMentionAlias:
    """teamMentionAlias turns the literal team name into a real role ping."""

    @staticmethod
    def _endpoint(answer, **attrs):
        endpoint = _make_endpoint()
        endpoint._team_mention_alias = '@RocketRide team'
        endpoint._allowed_mention_role_ids = ['77']
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value=answer)
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    def test_the_alias_is_replaced_before_posting(self):
        endpoint = self._endpoint('Looping in @RocketRide team now.')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'Looping in <@&77> now.'

    def test_the_first_allowed_role_is_the_one_pinged(self):
        endpoint = self._endpoint('ping @RocketRide team', _allowed_mention_role_ids=['77', '88'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'ping <@&77>'

    def test_injection_happens_before_the_scratchpad_check(self):
        # Leaked reasoning that escalated becomes the hand-off line only if the
        # alias is already a real marker by the time the sanitizer runs.
        endpoint = self._endpoint('Thought: I should bring in @RocketRide team', _sanitize_replies=True)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == ("Thanks for flagging this — I've looped in the team to take a look. <@&77>")

    def test_the_injected_mention_pauses_the_thread(self):
        endpoint = self._endpoint('Handing this to @RocketRide team', _escalation_pause=True)
        endpoint._resolved_threads = {'321'}
        endpoint._send_response = mock.AsyncMock(
            return_value={'messageIds': ['900'], 'destination': 'thread', 'threadId': '321', 'messages': []}
        )

        asyncio.run(endpoint._process_message(_thread_message(endpoint, _FakeThread(321))))

        assert endpoint._paused_threads == {'321'}

    def test_without_an_allowed_role_there_is_nothing_to_ping(self):
        endpoint = self._endpoint('ping @RocketRide team', _allowed_mention_role_ids=[])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'ping @RocketRide team'

    def test_the_shipped_default_changes_nothing(self):
        assert IEndpoint._team_mention_alias == ''
        endpoint = self._endpoint('ping @RocketRide team', _team_mention_alias='')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert _sent_reply(endpoint) == 'ping @RocketRide team'

    def test_services_json_declares_the_field(self):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
            schema = json.load(handle)

        field = schema['fields']['discord.teamMentionAlias']
        assert field['default'] == ''
        assert 'discord.teamMentionAlias' in schema['fields']['Pipe.source.parameters']['properties']


class TestNonAnswerRetry:
    """A reply that sanitizes to nothing is asked again before giving up."""

    @staticmethod
    def _endpoint(answers, *, retries=1):
        endpoint = _make_endpoint()
        endpoint._sanitize_replies = True
        endpoint._non_answer_retries = retries
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        # The real text-pass path, with only the pipeline call faked, so the
        # object names the retry pushes are visible.
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)
        endpoint._run_text_pipeline = mock.Mock(side_effect=list(answers))
        return endpoint

    @staticmethod
    def _object_names(endpoint):
        """The object name each ``_run_text_pipeline`` call pushed (None = default)."""
        calls = endpoint._run_text_pipeline.call_args_list
        return [call.args[4] if len(call.args) > 4 else None for call in calls]

    def test_scratchpad_then_a_real_answer_posts_once(self):
        endpoint = self._endpoint(['Thought: I need to confirm that pipelines can do both', 'the real answer'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 2
        assert self._object_names(endpoint) == [None, '2:retry1']
        assert endpoint._send_response.await_count == 1
        assert _sent_reply(endpoint) == 'the real answer'
        endpoint._emit_no_reply_event.assert_not_awaited()

    def test_the_retry_repeats_the_question_verbatim_and_is_marked(self):
        endpoint = self._endpoint(['Thought: still thinking', 'the real answer'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        first, retry = endpoint._run_text_pipeline.call_args_list
        assert retry.args[:4] == first.args[:4]  # same text, channel, message, metadata
        assert retry.kwargs['sse_text'] == first.kwargs['sse_text']
        assert retry.kwargs['context_chars'] == first.kwargs['context_chars']
        assert retry.kwargs['retry'] == 1
        assert 'retry' not in first.kwargs  # the original run is unmarked

    def test_scratchpad_twice_gives_up_with_non_answer(self):
        endpoint = self._endpoint(['Thought: one', 'Thought: two'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 2  # the original plus one retry
        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'non_answer'

    def test_zero_retries_is_todays_behaviour(self):
        endpoint = self._endpoint(['Thought: one', 'never asked'], retries=0)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 1
        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'non_answer'

    def test_a_third_attempt_runs_when_configured(self):
        endpoint = self._endpoint(['Thought: one', 'Thought: two', 'the real answer'], retries=2)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert self._object_names(endpoint) == [None, '2:retry1', '2:retry2']
        assert _sent_reply(endpoint) == 'the real answer'

    def test_a_merged_question_is_reused_on_the_retry(self):
        endpoint = self._endpoint(['Thought: hmm', 'the real answer'])
        endpoint._max_attachment_bytes = 1024
        endpoint._process_attachment = IEndpoint._process_attachment.__get__(endpoint)
        endpoint._run_binary_pipeline = mock.Mock(return_value='image-answer')
        message = _make_message(content='why does this fail?')
        message.attachments = [_attachment('shot.png', b'\x89PNG', content_type='image/png')]

        asyncio.run(endpoint._process_message(message))

        first, retry = endpoint._run_text_pipeline.call_args_list
        assert 'What the pipeline found in the attached image "shot.png":' in first.args[0]
        assert retry.args[:4] == first.args[:4]  # the folded question is not rebuilt
        assert retry.args[4] == '2:retry1'
        assert endpoint._run_binary_pipeline.call_count == 1  # the image is not re-ingested
        assert _sent_reply(endpoint) == 'the real answer'

    def test_an_attachment_only_message_has_no_text_pass_to_retry(self):
        endpoint = _make_endpoint(merge_attachments=False)
        endpoint._sanitize_replies = True
        endpoint._non_answer_retries = 2
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_text_pipeline = mock.Mock()
        endpoint._process_attachment = mock.AsyncMock(return_value='Thought: still thinking')

        asyncio.run(endpoint._process_message(_make_message(attachment_count=1)))

        endpoint._run_text_pipeline.assert_not_called()
        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'non_answer'

    def test_sse_payload_marks_the_retry_run_only(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint = IEndpoint.__new__(IEndpoint)
        pipe = mock.Mock()
        pipe.pipeId = 7
        target = mock.Mock()
        target.getPipe.return_value = pipe
        endpoint.target = target
        entry = mock.Mock()
        entry.response.toDict.return_value = {'answers': ['ok']}
        fake_engine = types.ModuleType('rocketlib.engine')
        fake_engine.monitorSSE = mock.Mock()

        with (
            mock.patch.object(module, 'getObject', return_value=entry),
            mock.patch.dict(sys.modules, {'rocketlib.engine': fake_engine}),
        ):
            endpoint._run_text_pipeline('q', 44, 55, {'correlationId': '55'})
            endpoint._run_text_pipeline('q', 44, 55, {'correlationId': '55'}, '55:retry1', retry=1)

        original, retried = (call.args[2] for call in fake_engine.monitorSSE.call_args_list)
        assert 'retry' not in original
        assert retried['retry'] == 1
        assert (retried['lane'], retried['text'], retried['contextChars']) == ('text', 'q', 0)

    def test_retrying_once_is_the_shipped_default(self):
        assert IEndpoint._non_answer_retries == 1

    def test_services_json_declares_the_field(self):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
            schema = json.load(handle)

        field = schema['fields']['discord.nonAnswerRetries']
        assert field['default'] == 1
        assert (field['minimum'], field['maximum']) == (0, 3)
        assert 'discord.nonAnswerRetries' in schema['fields']['Pipe.source.parameters']['properties']


class TestEmptyAnswerRetry:
    """An empty text pass is asked again too, not only one that sanitizes away."""

    @staticmethod
    def _endpoint(answers, *, retries=1, sanitize=True, merge=True):
        endpoint = _make_endpoint(merge_attachments=merge)
        endpoint._sanitize_replies = sanitize
        endpoint._non_answer_retries = retries
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)
        endpoint._run_text_pipeline = mock.Mock(side_effect=list(answers))
        return endpoint

    def test_an_empty_answer_is_retried_and_the_second_run_is_posted(self):
        endpoint = self._endpoint(['', 'the real answer'])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 2
        assert TestNonAnswerRetry._object_names(endpoint) == [None, '2:retry1']
        assert _sent_reply(endpoint) == 'the real answer'
        endpoint._emit_no_reply_event.assert_not_awaited()

    def test_empty_twice_keeps_todays_no_answer_reason(self):
        endpoint = self._endpoint(['', ''])

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 2
        assert endpoint._send_response.await_count == 0
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'no_answer'

    def test_a_processing_error_is_never_retried(self):
        # The pipeline failed for this message; re-running it just repeats the
        # failure, and the error is the outcome worth reporting.
        endpoint = self._endpoint([], retries=2)

        def _fail(*args, **_kwargs):
            args[3]['_pipelineError'] = 'Failed to open a data pipe'
            return ''

        endpoint._run_text_pipeline = mock.Mock(side_effect=_fail)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 1
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'Failed to open a data pipe'

    def test_nothing_is_retried_when_sanitizing_is_off(self):
        endpoint = self._endpoint(['', 'never asked'], sanitize=False)

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._run_text_pipeline.call_count == 1
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'no_answer'

    def test_an_attachment_only_message_has_no_text_pass_to_retry(self):
        endpoint = self._endpoint([], merge=False, retries=2)
        endpoint._run_text_pipeline = mock.Mock(return_value='')
        endpoint._process_attachment = mock.AsyncMock(return_value='')

        asyncio.run(endpoint._process_message(_make_message(attachment_count=1)))

        endpoint._run_text_pipeline.assert_not_called()
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'no_answer'


class TestNoReplyPayload:
    """A skipped message is still observable: its text travels with the no_reply."""

    @staticmethod
    def _endpoint(**attrs):
        endpoint = _make_endpoint()
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = IEndpoint._emit_no_reply_event.__get__(endpoint)
        endpoint._emit_event_pipeline = mock.Mock()
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    @staticmethod
    def _emitted(endpoint):
        _metadata, event_type, payload = endpoint._emit_event_pipeline.call_args.args
        return event_type, payload

    def test_a_paused_thread_records_the_message_that_was_ignored(self):
        # A team member answering inside a paused thread is the signal a human
        # took over; with no `message` event the no_reply is the only record.
        endpoint = self._endpoint(_escalation_pause=True, _escalation_markers=['<@&77>'])
        endpoint._paused_threads = {'321'}
        endpoint._resolved_threads = {'321'}
        message = _thread_message(endpoint, _FakeThread(321), content='I will take this one')

        asyncio.run(endpoint._process_message(message))

        assert self._emitted(endpoint) == ('no_reply', {'reason': 'paused', 'text': 'I will take this one'})

    def test_an_aimed_elsewhere_message_records_its_text_too(self):
        endpoint = self._endpoint(_ignore_aimed_at_others=True)
        message = _make_message(content='hey @someone, any idea?')
        message.mentions = [types.SimpleNamespace(id=5)]
        message.add_reaction = mock.AsyncMock()

        asyncio.run(endpoint._process_message(message))

        assert self._emitted(endpoint) == ('no_reply', {'reason': 'aimed_elsewhere', 'text': 'hey @someone, any idea?'})

    def test_other_no_reply_reasons_keep_their_payload(self):
        endpoint = self._endpoint()
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert self._emitted(endpoint) == ('no_reply', {'reason': 'no_answer'})


class TestOwnReactionsIgnored:
    """The node's own feedback emojis never surface as user feedback."""

    @staticmethod
    def _endpoint():
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._emit_reactions = True
        endpoint._include_member_metadata = False
        endpoint._emit_event_pipeline = mock.Mock()
        endpoint._bot = mock.Mock()
        endpoint._bot.user.id = 999
        endpoint._bot.get_channel = mock.Mock(return_value=None)
        endpoint._bot.get_user = mock.Mock(return_value=None)
        return endpoint

    @staticmethod
    def _payload(user_id):
        return types.SimpleNamespace(
            message_id=1,
            channel_id=2,
            guild_id=None,
            user_id=user_id,
            member=None,
            emoji='\N{WHITE HEAVY CHECK MARK}',
        )

    def test_a_reaction_by_the_bot_itself_emits_nothing(self):
        endpoint = self._endpoint()

        asyncio.run(endpoint._on_raw_reaction(self._payload(999), True))
        asyncio.run(endpoint._on_raw_reaction(self._payload(999), False))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_the_same_reaction_from_a_human_is_emitted(self):
        endpoint = self._endpoint()

        asyncio.run(endpoint._on_raw_reaction(self._payload(7), True))

        endpoint._emit_event_pipeline.assert_called_once()
        event_type, payload = endpoint._emit_event_pipeline.call_args.args[1:3]
        assert event_type == 'reaction'
        assert payload['userId'] == '7'
        assert payload['added'] is True

    def test_a_reaction_is_stamped_once_with_occurred_at(self):
        """One timestamp, in the broadcast itself, so live capture and a later log import key it the same."""
        import time as _time

        endpoint = self._endpoint()
        before = int(_time.time() * 1000)

        asyncio.run(endpoint._on_raw_reaction(self._payload(7), True))

        payload = endpoint._emit_event_pipeline.call_args.args[2]
        assert isinstance(payload['occurredAt'], int)
        assert before <= payload['occurredAt'] <= int(_time.time() * 1000)


class TestReactionScoping:
    """A reaction is scoped exactly like a message: guild, channel, bots."""

    @staticmethod
    def _endpoint(**attrs):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._emit_reactions = True
        endpoint._include_member_metadata = False
        endpoint._emit_event_pipeline = mock.Mock()
        endpoint._guild_ids = []
        endpoint._channel_ids = []
        endpoint._allowed_bot_ids = []
        endpoint._ignore_bots = True
        endpoint._bot = mock.Mock()
        endpoint._bot.user.id = 999
        endpoint._bot.get_channel = mock.Mock(return_value=None)
        endpoint._bot.get_user = mock.Mock(return_value=None)
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    @staticmethod
    def _payload(*, channel_id=2, guild_id=None, user_id=7, member=None):
        return types.SimpleNamespace(
            message_id=1,
            channel_id=channel_id,
            guild_id=guild_id,
            user_id=user_id,
            member=member,
            emoji='\N{WHITE HEAVY CHECK MARK}',
        )

    def test_a_reaction_in_an_unlisted_guild_is_dropped(self):
        endpoint = self._endpoint(_guild_ids=['10'])

        asyncio.run(endpoint._on_raw_reaction(self._payload(guild_id=11), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_a_reaction_in_a_listed_guild_is_emitted(self):
        endpoint = self._endpoint(_guild_ids=['10'])

        asyncio.run(endpoint._on_raw_reaction(self._payload(guild_id=10), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_a_dm_reaction_is_dropped_by_a_guild_allowlist(self):
        endpoint = self._endpoint(_guild_ids=['10'])

        asyncio.run(endpoint._on_raw_reaction(self._payload(guild_id=None), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_a_reaction_in_an_unlisted_channel_is_dropped(self):
        endpoint = self._endpoint(_channel_ids=['20'])
        endpoint._bot.get_channel = mock.Mock(return_value=discord.TextChannel())

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=21), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_a_reaction_in_a_listed_channel_is_emitted(self):
        endpoint = self._endpoint(_channel_ids=['20'])
        endpoint._bot.get_channel = mock.Mock(return_value=discord.TextChannel())

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=20), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_a_thread_reaction_matches_through_its_parent_channel(self):
        endpoint = self._endpoint(_channel_ids=['20'])
        endpoint._bot.get_channel = mock.Mock(return_value=_FakeThread(21, parent_id=20))

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=21), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_an_unrelated_thread_reaction_is_dropped(self):
        endpoint = self._endpoint(_channel_ids=['20'])
        endpoint._bot.get_channel = mock.Mock(return_value=_FakeThread(21, parent_id=22))

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=21), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_an_unresolvable_channel_is_dropped_when_an_allowlist_is_set(self):
        """Without the channel there is no way to know it is in scope."""
        endpoint = self._endpoint(_channel_ids=['20'])
        endpoint._bot.get_channel = mock.Mock(return_value=None)

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=20), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_an_unresolvable_channel_is_fine_without_an_allowlist(self):
        endpoint = self._endpoint()

        asyncio.run(endpoint._on_raw_reaction(self._payload(channel_id=20), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_a_bot_reactor_is_dropped_while_ignore_bots_is_on(self):
        endpoint = self._endpoint()
        member = types.SimpleNamespace(id=8, bot=True, display_name='Helper', roles=[])

        asyncio.run(endpoint._on_raw_reaction(self._payload(user_id=8, member=member), True))

        endpoint._emit_event_pipeline.assert_not_called()

    def test_an_allowlisted_bot_reactor_is_emitted(self):
        endpoint = self._endpoint(_allowed_bot_ids=['8'])
        member = types.SimpleNamespace(id=8, bot=True, display_name='Helper', roles=[])

        asyncio.run(endpoint._on_raw_reaction(self._payload(user_id=8, member=member), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_a_bot_reactor_is_kept_when_bots_are_not_ignored(self):
        endpoint = self._endpoint(_ignore_bots=False)
        member = types.SimpleNamespace(id=8, bot=True, display_name='Helper', roles=[])

        asyncio.run(endpoint._on_raw_reaction(self._payload(user_id=8, member=member), True))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_a_removal_resolves_the_reactor_through_the_user_cache(self):
        """``payload.member`` is only populated on an add."""
        endpoint = self._endpoint()
        endpoint._bot.get_user = mock.Mock(return_value=types.SimpleNamespace(id=8, bot=True))

        asyncio.run(endpoint._on_raw_reaction(self._payload(user_id=8), False))

        endpoint._emit_event_pipeline.assert_not_called()
        endpoint._bot.get_user.assert_called_once_with(8)

    def test_an_unknown_reactor_is_treated_as_a_human(self):
        endpoint = self._endpoint()
        endpoint._bot.get_user = mock.Mock(return_value=None)

        asyncio.run(endpoint._on_raw_reaction(self._payload(user_id=8), False))

        endpoint._emit_event_pipeline.assert_called_once()

    def test_the_shipped_defaults_emit_every_human_reaction(self):
        endpoint = self._endpoint()

        asyncio.run(endpoint._on_raw_reaction(self._payload(), True))

        endpoint._emit_event_pipeline.assert_called_once()


class TestThreadSerialization:
    """escalationPause only works if a thread's messages are handled in order."""

    @staticmethod
    def _endpoint(*, escalation_pause=True):
        endpoint = _make_endpoint()
        endpoint._escalation_pause = escalation_pause
        endpoint._escalation_markers = ['<@&77>']
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._send_response = mock.AsyncMock(
            return_value={'messageIds': ['900'], 'destination': 'thread', 'threadId': '321', 'messages': []}
        )
        endpoint._resolved_threads = {'321'}
        endpoint._inflight = set()
        endpoint._ignore_bots = True
        endpoint._require_mention = False
        endpoint._require_mention_channel_ids = []
        endpoint._allowed_bot_ids = []
        endpoint._guild_ids = []
        endpoint._channel_ids = []

        answers = ['escalating to <@&77> now', 'and here is a second answer']

        async def _answer(_message, _factory):
            # Two suspension points: without serialization the follow-up's
            # pause check runs here, before the first answer is posted.
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return answers.pop(0)

        endpoint._run_with_optional_typing = mock.AsyncMock(side_effect=_answer)
        return endpoint

    @staticmethod
    def _messages(thread):
        messages = []
        for index, (message_id, content) in enumerate(((601, 'my build is broken'), (602, 'any update?'))):
            message = _make_message(content=content)
            message.id = message_id
            message.channel = thread
            messages.append(message)
            del index
        return messages

    @staticmethod
    async def _drive(endpoint, messages):
        for message in messages:
            await endpoint._on_message(message)
        while endpoint._inflight:
            await asyncio.gather(*list(endpoint._inflight), return_exceptions=True)

    def test_a_follow_up_sees_the_pause_the_first_answer_created(self):
        endpoint = self._endpoint()
        thread = _FakeThread(321)

        asyncio.run(self._drive(endpoint, self._messages(thread)))

        assert endpoint._send_response.await_count == 1, 'the follow-up must not be answered too'
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'paused'
        assert endpoint._paused_threads == {'321'}

    def test_the_lock_is_dropped_once_the_thread_is_idle(self):
        endpoint = self._endpoint()

        asyncio.run(self._drive(endpoint, self._messages(_FakeThread(321))))

        assert endpoint._thread_locks == {}

    def test_with_the_pause_off_processing_stays_concurrent(self):
        endpoint = self._endpoint(escalation_pause=False)
        thread = _FakeThread(321)

        asyncio.run(self._drive(endpoint, self._messages(thread)))

        assert endpoint._send_response.await_count == 2
        assert getattr(endpoint, '_thread_locks', {}) == {}


class TestSendFailure:
    """An answer that could not be posted is reported, not silently dropped."""

    @staticmethod
    def _endpoint(outbound, **attrs):
        endpoint = _make_endpoint()
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='the answer')
        endpoint._send_response = mock.AsyncMock(return_value=outbound)
        for name, value in attrs.items():
            setattr(endpoint, name, value)
        return endpoint

    @staticmethod
    def _outbound(message_ids):
        return {'messageIds': message_ids, 'destination': 'reply', 'threadId': None, 'messages': []}

    def test_a_reply_that_posted_nothing_is_reported(self):
        endpoint = self._endpoint(self._outbound([]))

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._emit_no_reply_event.await_args.args[1] == 'send_failed'

    def test_a_posted_reply_reports_nothing(self):
        endpoint = self._endpoint(self._outbound(['900']))

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        endpoint._emit_no_reply_event.assert_not_awaited()

    def test_an_outbound_event_is_still_only_emitted_for_a_real_send(self):
        endpoint = self._endpoint(self._outbound([]), _emit_outbound=True)
        endpoint._emit_outbound_event = mock.AsyncMock()

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        endpoint._emit_outbound_event.assert_not_awaited()

    def test_nothing_is_emitted_when_no_reply_events_are_off(self):
        endpoint = self._endpoint(self._outbound([]), _emit_no_reply=False)
        endpoint._emit_no_reply_event = IEndpoint._emit_no_reply_event.__get__(endpoint)
        endpoint._emit_event_pipeline = mock.Mock()

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        endpoint._emit_event_pipeline.assert_not_called()


class TestNoReplyReasonLength:
    """A ``no_reply`` reason is part of the capture key, so it is bounded."""

    @staticmethod
    def _endpoint():
        endpoint = _make_endpoint()
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = IEndpoint._emit_no_reply_event.__get__(endpoint)
        endpoint._emit_event_pipeline = mock.Mock()
        return endpoint

    def test_a_runaway_exception_message_is_clipped(self):
        module = sys.modules['_discord_node.IEndpoint']
        endpoint = self._endpoint()
        endpoint._run_with_optional_typing = mock.AsyncMock(side_effect=RuntimeError('x' * 5000))

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        payload = endpoint._emit_event_pipeline.call_args.args[2]
        assert len(payload['reason']) == module.MAX_NO_REPLY_REASON_CHARS
        assert payload['reason'] == 'x' * module.MAX_NO_REPLY_REASON_CHARS

    def test_a_short_reason_is_untouched(self):
        endpoint = self._endpoint()
        endpoint._run_with_optional_typing = mock.AsyncMock(return_value='')

        asyncio.run(endpoint._process_message(_make_message(content='question')))

        assert endpoint._emit_event_pipeline.call_args.args[2] == {'reason': 'no_answer'}


class TestBackfill:
    """One unreadable channel must not cost the rest of the backfill."""

    class _Channel:
        def __init__(self, channel_id, contents=(), *, broken=False):
            self.id = channel_id
            self._contents = list(contents)
            self._broken = broken

        def history(self, limit=None, **_kwargs):
            if self._broken:
                raise RuntimeError('missing Read Message History')

            async def _iterate():
                for item in self._contents[:limit]:
                    yield item

            return _iterate()

    @staticmethod
    def _endpoint(channels):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._backfill_limit = 5
        endpoint._channel_ids = [str(channel_id) for channel_id in channels]
        endpoint._bot = mock.Mock()
        endpoint._bot.get_channel = mock.Mock(side_effect=lambda channel_id: channels.get(channel_id))
        endpoint._on_message = mock.AsyncMock()
        return endpoint

    def test_a_broken_channel_is_skipped_and_the_rest_are_replayed(self):
        channels = {
            1: self._Channel(1, ['a2', 'a1']),
            2: self._Channel(2, broken=True),
            3: self._Channel(3, ['c1']),
        }
        endpoint = self._endpoint(channels)

        asyncio.run(endpoint._run_backfill())

        replayed = [call.args[0] for call in endpoint._on_message.await_args_list]
        assert replayed == ['a1', 'a2', 'c1'], 'oldest first, and channel 3 still runs'

    def test_every_channel_is_replayed_when_all_are_readable(self):
        channels = {1: self._Channel(1, ['a1']), 2: self._Channel(2, ['b1'])}
        endpoint = self._endpoint(channels)

        asyncio.run(endpoint._run_backfill())

        assert [call.args[0] for call in endpoint._on_message.await_args_list] == ['a1', 'b1']


class TestNumericAndMentionConfig:
    """``_run``'s config block, as the engine actually delivers values."""

    class _Proxy:
        """An engine-provided value: string-like, but not a ``str``."""

        def __init__(self, text):
            self._text = text

        def __str__(self):
            return self._text

    class _Stop(Exception):
        """Raised in place of the shared web server, to end ``_run`` early."""

    @classmethod
    def _parse(cls, config):
        """Run ``_run``'s config block and stop before it touches the engine."""
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint.endpoint = types.SimpleNamespace(serviceConfig={'parameters': config})
        endpoint.target = None

        node = types.ModuleType('ai.node')
        node.require_shared_web_server = mock.Mock(side_effect=cls._Stop())
        node.server_loop = None
        ai = types.ModuleType('ai')
        ai.__path__ = []
        ai.node = node

        with mock.patch.dict(sys.modules, {'ai': ai, 'ai.node': node}), pytest.raises(cls._Stop):
            endpoint._run()
        return endpoint

    @staticmethod
    def _numbers(endpoint):
        return (
            endpoint._max_attachment_bytes,
            endpoint._thread_name_max_length,
            endpoint._thread_auto_archive_minutes,
            endpoint._text_attachment_max_chars,
            endpoint._backfill_limit,
            endpoint._thread_history_limit,
            endpoint._thread_history_max_chars,
        )

    def test_the_shipped_defaults_are_unchanged(self):
        endpoint = self._parse({})

        assert self._numbers(endpoint) == (26214400, 90, 0, 12000, 0, 0, 6000)
        assert endpoint._reply_mode == 'reply'
        assert endpoint._thread_name == 'Pipeline Response'

    def test_string_proxies_are_coerced_to_int(self):
        endpoint = self._parse(
            {
                'maxAttachmentBytes': self._Proxy('1048576'),
                'threadNameMaxLength': self._Proxy('40'),
                'threadAutoArchiveMinutes': self._Proxy('1440'),
                'textAttachmentMaxChars': self._Proxy('5000'),
                'backfillLimit': self._Proxy('7'),
                'threadHistoryLimit': self._Proxy('12'),
                'threadHistoryMaxChars': self._Proxy('900'),
            }
        )

        assert self._numbers(endpoint) == (1048576, 40, 1440, 5000, 7, 12, 900)
        assert all(isinstance(value, int) for value in self._numbers(endpoint))

    def test_text_settings_are_real_strings(self):
        endpoint = self._parse({'threadName': self._Proxy('Answer: {content}'), 'replyMode': self._Proxy('thread')})

        assert type(endpoint._thread_name) is str and endpoint._thread_name == 'Answer: {content}'
        assert type(endpoint._reply_mode) is str and endpoint._reply_mode == 'thread'

    def test_an_unusable_number_falls_back_to_its_default(self):
        endpoint = self._parse(
            {
                'maxAttachmentBytes': 'lots',
                'threadNameMaxLength': None,
                'threadAutoArchiveMinutes': '',
                'textAttachmentMaxChars': object(),
                'backfillLimit': 'none',
                'threadHistoryLimit': [],
                'threadHistoryMaxChars': 'all of it',
            }
        )

        assert self._numbers(endpoint) == (26214400, 90, 0, 12000, 0, 0, 6000)

    def test_a_float_is_truncated_not_rejected(self):
        endpoint = self._parse({'threadHistoryLimit': 12.0, 'backfillLimit': '7.9'})

        assert endpoint._thread_history_limit == 12
        assert endpoint._backfill_limit == 7

    def test_only_numeric_mention_ids_survive(self):
        """One typo used to raise inside every send, so nothing was posted."""
        endpoint = self._parse(
            {
                'allowedMentionRoleIds': ['77', 'the-team', '88'],
                'allowedMentionUserIds': ['<@12345>', '12345'],
            }
        )

        assert endpoint._allowed_mention_role_ids == ['77', '88']
        assert endpoint._allowed_mention_user_ids == ['12345']

    def test_the_surviving_ids_still_build_the_mention_allowlist(self):
        endpoint = self._parse({'allowedMentionUserIds': ['oops', '555'], 'allowedMentionRoleIds': ['77']})

        allowed = endpoint._allowed_mentions()

        assert [obj.id for obj in allowed.users] == [555]
        assert [obj.id for obj in allowed.roles] == [77]
        assert allowed.everyone is False


# ---------------------------------------------------------------------------
# Lifecycle: terminal failures fail the source promptly
# ---------------------------------------------------------------------------


class TestLifecycle:
    """Missing/invalid credentials and Gateway failures propagate, not hang."""

    @staticmethod
    def _runner_endpoint():
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._bot_token = 'token'
        endpoint._closing = False
        endpoint._fatal_error = None
        endpoint._shutdown_event = threading.Event()
        endpoint._bot = mock.Mock()
        return endpoint

    def test_missing_token_raises_from_startup(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._bot_token = ''

        with pytest.raises(RuntimeError, match='missing bot token'):
            asyncio.run(endpoint._startup())

    def test_an_unset_token_variable_is_named(self):
        # Live F39: the engine passes an unknown ${NAME} through literally, and
        # it used to be reported as "login failed (invalid token)".
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._bot_token = '${ROCKETRIDE_DISCORD_NO_SUCH_TOKEN}'

        with pytest.raises(RuntimeError, match='ROCKETRIDE_DISCORD_NO_SUCH_TOKEN is not set'):
            asyncio.run(endpoint._startup())

    def test_a_broken_channel_list_fails_the_start(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._bot_token = 'token'
        endpoint._config_error = 'Discord Bot: channelIds is not valid JSON'

        with pytest.raises(RuntimeError, match='channelIds is not valid JSON'):
            asyncio.run(endpoint._startup())

    def test_login_failure_records_fatal_and_unblocks(self):
        endpoint = self._runner_endpoint()
        endpoint._bot.start = mock.AsyncMock(side_effect=discord.LoginFailure())

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error is not None
        assert 'login failed' in endpoint._fatal_error
        assert endpoint._shutdown_event.is_set()

    def test_privileged_intents_failure_records_fatal(self):
        endpoint = self._runner_endpoint()
        endpoint._bot.start = mock.AsyncMock(side_effect=discord.PrivilegedIntentsRequired())

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error is not None
        assert 'Message Content Intent' in endpoint._fatal_error
        assert endpoint._shutdown_event.is_set()

    def test_members_intent_failure_leads_with_server_members(self):
        # Live F36: with member metadata on, the missing intent is almost always
        # Server Members; the message used to lead with Message Content.
        endpoint = self._runner_endpoint()
        endpoint._include_member_metadata = True
        endpoint._bot.start = mock.AsyncMock(side_effect=discord.PrivilegedIntentsRequired())

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error.startswith('Discord Bot: enable the Server Members Intent')
        assert 'Message Content' in endpoint._fatal_error  # still named, as also required

    def test_unexpected_close_is_terminal(self):
        endpoint = self._runner_endpoint()
        endpoint._bot.start = mock.AsyncMock(return_value=None)  # returned on its own

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error is not None
        assert 'closed unexpectedly' in endpoint._fatal_error
        assert endpoint._shutdown_event.is_set()

    def test_close_during_shutdown_is_not_terminal(self):
        endpoint = self._runner_endpoint()
        endpoint._closing = True  # _shutdown in progress
        endpoint._bot.start = mock.AsyncMock(return_value=None)

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error is None
        assert not endpoint._shutdown_event.is_set()

    def test_cancellation_is_not_terminal(self):
        endpoint = self._runner_endpoint()
        endpoint._bot.start = mock.AsyncMock(side_effect=asyncio.CancelledError())

        asyncio.run(endpoint._bot_runner())

        assert endpoint._fatal_error is None
        assert not endpoint._shutdown_event.is_set()

    def test_shutdown_marks_closing(self):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._closing = False
        endpoint._inflight = set()
        endpoint._bot = None
        endpoint._bot_task = None

        asyncio.run(endpoint._shutdown())

        assert endpoint._closing is True


# ---------------------------------------------------------------------------
# Outbound sends: mentions suppressed, reply modes, thread reuse
# ---------------------------------------------------------------------------


class TestOutboundSends:
    """All reply modes send with mentions disabled; thread mode reuses its thread."""

    @staticmethod
    def _endpoint(mode):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._reply_mode = mode
        endpoint._allowed_mention_role_ids = []
        endpoint._allowed_mention_user_ids = []
        endpoint._thread_name = 'Pipeline Response'
        endpoint._thread_name_max_length = 90
        endpoint._thread_auto_archive_minutes = 1440
        return endpoint

    def test_reply_mode_suppresses_mentions(self):
        endpoint = self._endpoint('reply')
        message = mock.Mock()
        message.reply = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert result is None
        kwargs = message.reply.await_args.kwargs
        assert kwargs['mention_author'] is False
        assert kwargs['allowed_mentions'] is discord.AllowedMentions.none()

    def test_channel_mode_suppresses_mentions(self):
        endpoint = self._endpoint('channel')
        message = mock.Mock()
        message.channel = mock.Mock()
        message.channel.send = mock.AsyncMock()

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        kwargs = message.channel.send.await_args.kwargs
        assert kwargs['allowed_mentions'] is discord.AllowedMentions.none()

    def test_configured_user_and_role_mentions_are_allowlisted(self):
        endpoint = self._endpoint('channel')
        endpoint._allowed_mention_user_ids = ['101']
        endpoint._allowed_mention_role_ids = ['202']
        message = mock.Mock()
        message.channel.send = mock.AsyncMock()

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        policy = message.channel.send.await_args.kwargs['allowed_mentions']
        assert policy.everyone is False
        assert [user.id for user in policy.users] == [101]
        assert [role.id for role in policy.roles] == [202]

    def test_thread_mode_creates_thread_for_text_channel(self):
        endpoint = self._endpoint('thread')
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.channel = discord.TextChannel()  # threadable
        message.create_thread = mock.AsyncMock(return_value=thread)

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert result is thread
        message.create_thread.assert_awaited_once()
        kwargs = thread.send.await_args.kwargs
        assert kwargs['allowed_mentions'] is discord.AllowedMentions.none()

    def test_thread_name_template_length_and_archive_duration(self):
        endpoint = self._endpoint('thread')
        endpoint._thread_name = 'Answer: {content}'
        endpoint._thread_name_max_length = 12
        endpoint._thread_auto_archive_minutes = 60
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = 'a very long question'
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert message.create_thread.await_args.kwargs == {
            'name': 'Answer: a ve',
            'auto_archive_duration': 60,
        }

    def test_no_archive_duration_is_sent_by_default(self):
        """0 (the default) leaves the duration to the channel, as before the setting."""
        endpoint = self._endpoint('thread')
        endpoint._thread_name = 'Pipeline Response'
        endpoint._thread_name_max_length = 90
        endpoint._thread_auto_archive_minutes = 0
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = 'question'
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert message.create_thread.await_args.kwargs == {'name': 'Pipeline Response'}

    @staticmethod
    def _create_thread_kwargs(minutes):
        endpoint = TestOutboundSends._endpoint('thread')
        endpoint._thread_name = 'Pipeline Response'
        endpoint._thread_name_max_length = 90
        endpoint._thread_auto_archive_minutes = minutes
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = 'question'
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        return message.create_thread.await_args.kwargs

    @pytest.mark.parametrize('minutes', [60, 1440, 4320, 10080])
    def test_every_duration_discord_accepts_is_sent(self, minutes):
        assert self._create_thread_kwargs(minutes) == {
            'name': 'Pipeline Response',
            'auto_archive_duration': minutes,
        }

    @pytest.mark.parametrize('minutes', [1, 120, 1441, 20160, -60])
    def test_a_duration_discord_rejects_is_omitted(self, minutes):
        """Anything but 60/1440/4320/10080 would 400 and lose the whole answer."""
        assert self._create_thread_kwargs(minutes) == {'name': 'Pipeline Response'}

    def test_thread_mode_reuses_existing_thread_arg(self):
        endpoint = self._endpoint('thread')
        existing = discord.Thread()
        existing.send = mock.AsyncMock()
        message = mock.Mock()
        message.create_thread = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', existing))

        assert result is existing
        message.create_thread.assert_not_called()  # no second thread
        existing.send.assert_awaited_once()

    def test_thread_mode_posts_into_message_own_thread(self):
        # A message already inside a thread must post into that thread, not try
        # to create a nested one (which Discord rejects).
        endpoint = self._endpoint('thread')
        channel = discord.Thread()
        channel.send = mock.AsyncMock()
        message = mock.Mock()
        message.channel = channel
        message.create_thread = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert result is channel
        message.create_thread.assert_not_called()
        channel.send.assert_awaited_once()

    def test_a_failed_thread_creation_falls_back_to_replying(self):
        # Missing "Create Public Threads": reply in the channel instead of
        # losing the answer (which is what the node used to do).
        endpoint = self._endpoint('thread')
        message = mock.Mock()
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(side_effect=RuntimeError('Missing Permissions'))
        message.reply = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        message.reply.assert_awaited_once()
        assert message.reply.await_args.kwargs['mention_author'] is False

        # The rest of the reply keeps replying rather than asking Discord again.
        asyncio.run(endpoint._send_chunk(message, 'and more', result))
        assert message.create_thread.await_count == 1
        assert message.reply.await_count == 2

    def test_the_whole_reply_survives_a_thread_permission_failure(self):
        endpoint = self._endpoint('thread')
        message = mock.Mock()
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(side_effect=RuntimeError('Missing Permissions'))
        message.reply = mock.AsyncMock()

        outbound = asyncio.run(endpoint._send_response(message, 'Line\n' * 500))

        assert message.create_thread.await_count == 1
        assert message.reply.await_count > 1, 'every chunk must still be posted'
        assert outbound['destination'] == 'reply'
        assert outbound['threadId'] is None
        assert len(outbound['messageIds']) == message.reply.await_count

    def test_thread_name_uses_the_first_attachment_when_there_is_no_text(self):
        endpoint = self._endpoint('thread')
        endpoint._thread_name = '{content}'
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = ''
        message.attachments = [_attachment('pipeline-trace.log')]
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert message.create_thread.await_args.kwargs['name'] == 'pipeline-trace.log'

    def test_an_attachment_thread_name_is_capped_like_any_other(self):
        endpoint = self._endpoint('thread')
        endpoint._thread_name = '{content}'
        endpoint._thread_name_max_length = 8
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = '   '
        message.attachments = [_attachment('pipeline-trace.log')]
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert message.create_thread.await_args.kwargs['name'] == 'pipeline'

    def test_the_existing_fallback_stays_with_neither_text_nor_attachment(self):
        endpoint = self._endpoint('thread')
        endpoint._thread_name = '{content}'
        thread = discord.Thread()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.content = ''
        message.attachments = []
        message.channel = discord.TextChannel()
        message.create_thread = mock.AsyncMock(return_value=thread)

        asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert message.create_thread.await_args.kwargs['name'] == 'Pipeline Response'

    def test_thread_mode_falls_back_to_reply_in_dm(self):
        # DMs (and other non-threadable channels) can't host a thread; the node
        # must fall back to a plain reply instead of raising.
        endpoint = self._endpoint('thread')
        message = mock.Mock()
        message.channel = mock.Mock()  # neither Thread nor TextChannel
        message.reply = mock.AsyncMock()
        message.create_thread = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert result is None
        message.create_thread.assert_not_called()
        message.reply.assert_awaited_once()
        kwargs = message.reply.await_args.kwargs
        assert kwargs['mention_author'] is False
        assert kwargs['allowed_mentions'] is discord.AllowedMentions.none()


class TestNumberedChunks:
    """numberChunks labels a split reply so a reader sees the order."""

    @staticmethod
    def _endpoint(number):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._reply_mode = 'channel'
        endpoint._allowed_mention_role_ids = []
        endpoint._allowed_mention_user_ids = []
        endpoint._number_chunks = number
        return endpoint

    @staticmethod
    def _message():
        message = mock.Mock()
        message.channel.send = mock.AsyncMock()
        return message

    @staticmethod
    def _sent_texts(message):
        return [call.args[0] for call in message.channel.send.await_args_list]

    def test_each_chunk_is_labelled_and_still_fits_the_limit(self):
        endpoint = self._endpoint(True)
        message = self._message()

        asyncio.run(endpoint._send_response(message, 'This is a sentence. ' * 400))

        texts = self._sent_texts(message)
        total = len(texts)
        assert total > 1
        for index, text in enumerate(texts, 1):
            assert text.endswith(f'\n\n*({index}/{total})*')
            assert len(text) <= 2000

    def test_the_shipped_default_posts_todays_chunks(self):
        assert IEndpoint._number_chunks is False
        endpoint = self._endpoint(False)
        message = self._message()

        asyncio.run(endpoint._send_response(message, 'This is a sentence. ' * 400))

        texts = self._sent_texts(message)
        assert len(texts) > 1
        assert not any('*(' in text for text in texts)

    def test_a_single_message_reply_is_not_labelled(self):
        endpoint = self._endpoint(True)
        message = self._message()

        asyncio.run(endpoint._send_response(message, 'short answer'))

        assert self._sent_texts(message) == ['short answer']

    def test_services_json_declares_the_field(self):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
            schema = json.load(handle)

        assert schema['fields']['discord.numberChunks']['default'] is False
        assert 'discord.numberChunks' in schema['fields']['Pipe.source.parameters']['properties']


# ---------------------------------------------------------------------------
# Config coercion + gating + typing (regression guards)
# ---------------------------------------------------------------------------


class TestConfigCoercion:
    """_as_str_list guards against scalar / malformed allowlist values."""

    def test_none_and_empty_become_empty_list(self):
        assert IEndpoint._as_str_list(None) == []
        assert IEndpoint._as_str_list([]) == []
        assert IEndpoint._as_str_list('') == []

    def test_list_values_stringified(self):
        assert IEndpoint._as_str_list(['1', 2, 3]) == ['1', '2', '3']

    def test_json_text_and_delimited_strings_are_parsed(self):
        # The engine hands array-typed parameters to Python nodes as JSON text.
        assert IEndpoint._as_str_list('["900000000000000201"]') == ['900000000000000201']
        assert IEndpoint._as_str_list('["1", 2]') == ['1', '2']
        assert IEndpoint._as_str_list('[]') == []
        assert IEndpoint._as_str_list('123, 456 789') == ['123', '456', '789']
        assert IEndpoint._as_str_list('123') == ['123']
        assert IEndpoint._as_str_list('[not json') == ['[not', 'json']
        # ...and sometimes as a one-element list holding that JSON text.
        assert IEndpoint._as_str_list(['["900000000000000201"]']) == ['900000000000000201']
        assert IEndpoint._as_str_list(['["1","2"]', '3']) == ['1', '2', '3']

    def test_phrases_are_kept_whole_when_split_is_off(self):
        # Escalation markers are sentences; splitting them would turn "to" into a marker.
        phrase = 'Escalated to the RocketRide team.'
        assert IEndpoint._as_str_list(phrase, split=False) == [phrase]
        assert IEndpoint._as_str_list([phrase, '@RocketRide team'], split=False) == [phrase, '@RocketRide team']
        assert IEndpoint._as_str_list('["Escalated to the RocketRide team."]', split=False) == [phrase]
        assert IEndpoint._as_str_list(['["a b", "c"]'], split=False) == ['a b', 'c']
        assert IEndpoint._as_str_list('', split=False) == []
        assert IEndpoint._as_str_list(('a', 'b')) == ['a', 'b']

    def test_bare_string_is_single_element_not_per_character(self):
        assert IEndpoint._as_str_list('123456') == ['123456']

    def test_broken_json_is_reported_with_the_field_name(self):
        # Live F38: '["123"' became the literal id '["123"' and the allowlist
        # rejected everyone, with nothing in the task's warnings.
        with mock.patch.object(_ENDPOINT_MODULE, '_config_warning') as warn:
            assert IEndpoint._as_str_list('["123"', field='allowedBotIds') == ['["123"']
        warn.assert_called_once()
        assert 'allowedBotIds' in warn.call_args.args[0]
        assert 'not valid JSON' in warn.call_args.args[0]

    def test_valid_values_raise_no_warning(self):
        with mock.patch.object(_ENDPOINT_MODULE, '_config_warning') as warn:
            IEndpoint._as_str_list('["1", "2"]', field='channelIds')
            IEndpoint._as_str_list(['["1"]'], field='channelIds')
            IEndpoint._as_str_list('1, 2', field='channelIds')
            IEndpoint._as_str_list(['1', 2], field='channelIds')
        warn.assert_not_called()

    def test_only_a_broken_guild_or_channel_list_is_fatal(self):
        assert 'channelIds is not valid JSON' in IEndpoint._list_config_error({'channelIds': '["1"'})
        assert 'guildIds is not valid JSON' in IEndpoint._list_config_error({'guildIds': ['["1",']})
        assert IEndpoint._list_config_error({'channelIds': '["1"]', 'guildIds': '2'}) is None
        # Other lists keep the warning only: a broken allowlist must not stop the bot.
        assert IEndpoint._list_config_error({'allowedBotIds': '["1"'}) is None


class TestOptionalTyping:
    """The pipeline awaitable runs exactly once regardless of typing errors."""

    @staticmethod
    def _endpoint_with_typing(typing_cm):
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._show_typing = True
        message = mock.Mock()
        message.channel = mock.Mock()
        message.channel.typing = mock.Mock(return_value=typing_cm)
        return endpoint, message

    def test_pipeline_runs_once_when_typing_enter_fails(self):
        calls = []

        async def factory():
            calls.append(1)
            return 'result'

        class _EnterFails:
            async def __aenter__(self):
                raise RuntimeError('missing Send Typing permission')

            async def __aexit__(self, *args):
                return False

        endpoint, message = self._endpoint_with_typing(_EnterFails())
        result = asyncio.run(endpoint._run_with_optional_typing(message, factory))

        assert result == 'result'
        assert len(calls) == 1

    def test_pipeline_runs_once_when_typing_exit_fails(self):
        calls = []

        async def factory():
            calls.append(1)
            return 'result'

        class _ExitFails:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                raise RuntimeError('exit boom')

        endpoint, message = self._endpoint_with_typing(_ExitFails())
        result = asyncio.run(endpoint._run_with_optional_typing(message, factory))

        assert result == 'result'
        assert len(calls) == 1


class TestOnMessageGating:
    """_on_message applies the real gate before scheduling processing."""

    @staticmethod
    def _endpoint():
        endpoint = IEndpoint.__new__(IEndpoint)
        endpoint._ignore_bots = True
        endpoint._require_mention = True
        endpoint._require_mention_channel_ids = []
        endpoint._allowed_bot_ids = []
        endpoint._guild_ids = []
        endpoint._channel_ids = []
        bot_user = mock.Mock()
        bot_user.id = 999
        endpoint._bot = mock.Mock()
        endpoint._bot.user = bot_user
        endpoint._inflight = set()
        endpoint._process_message = mock.AsyncMock()
        return endpoint, bot_user

    @staticmethod
    def _message(*, mentions):
        message = mock.Mock()
        message.author.id = 1
        message.author.bot = False
        message.guild.id = 10
        message.channel.id = 20
        message.mentions = mentions
        return message

    async def _drive(self, endpoint, message):
        await endpoint._on_message(message)
        if endpoint._inflight:
            await asyncio.gather(*list(endpoint._inflight), return_exceptions=True)

    def test_require_mention_ignores_everyone_mention(self):
        endpoint, _bot_user = self._endpoint()
        message = self._message(mentions=[])

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_not_awaited()

    def test_require_mention_allows_direct_mention(self):
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_awaited_once()

    def test_channel_specific_mention_gate(self):
        endpoint, _bot_user = self._endpoint()
        endpoint._require_mention = False
        endpoint._require_mention_channel_ids = ['20']
        message = self._message(mentions=[])

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_not_awaited()

    def test_thread_parent_specific_mention_gate(self):
        endpoint, bot_user = self._endpoint()
        endpoint._require_mention = False
        endpoint._require_mention_channel_ids = ['20']
        channel = discord.Thread()
        channel.id = 21
        channel.parent_id = 20
        message = self._message(mentions=[])
        message.channel = channel

        asyncio.run(self._drive(endpoint, message))
        endpoint._process_message.assert_not_awaited()

        message.mentions = [bot_user]
        asyncio.run(self._drive(endpoint, message))
        endpoint._process_message.assert_awaited_once()

    def test_thread_parent_channel_allowlist(self):
        endpoint, _bot_user = self._endpoint()
        endpoint._require_mention = False
        endpoint._channel_ids = ['20']
        channel = discord.Thread()
        channel.id = 21
        channel.parent_id = 20
        message = self._message(mentions=[])
        message.channel = channel

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_awaited_once()

    def test_a_system_message_is_dropped(self):
        # Joins, pins, boosts and thread-created notices are not questions.
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])
        message.is_system = mock.Mock(return_value=True)

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_not_awaited()

    def test_an_ordinary_message_still_passes_the_system_check(self):
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])
        message.is_system = mock.Mock(return_value=False)

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_awaited_once()

    def test_a_non_bool_is_system_is_not_read_as_a_system_flag(self):
        # discord.py returns a real bool; a stand-in returning anything else
        # must not silently drop every message.
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])
        message.is_system = mock.Mock(return_value=object())

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_awaited_once()

    def test_a_message_with_neither_text_nor_attachments_is_dropped(self):
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])
        message.content = '   '
        message.attachments = []

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_not_awaited()

    def test_an_attachment_only_message_still_passes(self):
        endpoint, bot_user = self._endpoint()
        message = self._message(mentions=[bot_user])
        message.content = ''
        message.attachments = [_attachment('shot.png')]

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_awaited_once()

    def test_unrelated_thread_is_dropped_by_channel_allowlist(self):
        endpoint, _bot_user = self._endpoint()
        endpoint._require_mention = False
        endpoint._channel_ids = ['20']
        channel = discord.Thread()
        channel.id = 21
        channel.parent_id = 22
        message = self._message(mentions=[])
        message.channel = channel

        asyncio.run(self._drive(endpoint, message))

        endpoint._process_message.assert_not_awaited()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])


class TestPipelineTimeout:
    """pipelineTimeoutSeconds: opt-in give-up on a pipeline that does not answer."""

    @staticmethod
    def _endpoint(seconds, delay):
        endpoint = _make_endpoint()
        endpoint._pipeline_timeout_seconds = seconds
        endpoint._emit_no_reply = True
        endpoint._emit_no_reply_event = mock.AsyncMock()
        endpoint._run_with_optional_typing = IEndpoint._run_with_optional_typing.__get__(endpoint)

        def slow(*args, **kwargs):
            time.sleep(delay)
            return 'late answer'

        endpoint._run_text_pipeline = mock.Mock(side_effect=slow)
        return endpoint

    def test_off_by_default(self):
        assert IEndpoint._pipeline_timeout_seconds == 0

    def test_off_waits_for_a_slow_answer(self):
        endpoint = self._endpoint(0, 0.3)

        asyncio.run(endpoint._process_message(_make_message(content='q')))

        assert _sent_reply(endpoint) == 'late answer'
        endpoint._emit_no_reply_event.assert_not_awaited()

    def test_an_answer_inside_the_limit_is_posted(self):
        endpoint = self._endpoint(5, 0.1)

        asyncio.run(endpoint._process_message(_make_message(content='q')))

        assert _sent_reply(endpoint) == 'late answer'

    def test_a_slow_pipeline_is_given_up_with_timeout(self):
        endpoint = self._endpoint(0.2, 0.8)

        asyncio.run(endpoint._process_message(_make_message(content='q')))

        assert endpoint._send_response.await_count == 0, 'the late answer must be dropped'
        assert endpoint._emit_no_reply_event.await_args.args[1] == 'timeout'

    def test_an_attachment_timeout_is_not_swallowed(self):
        endpoint = _make_endpoint()
        endpoint._process_attachment = IEndpoint._process_attachment.__get__(endpoint)
        endpoint._max_attachment_bytes = 10_000
        endpoint._run_with_optional_typing = mock.AsyncMock(side_effect=_ENDPOINT_MODULE.PipelineTimeout('timeout'))
        attachment = _attachment('a.png', b'png', content_type='image/png')

        with pytest.raises(_ENDPOINT_MODULE.PipelineTimeout):
            asyncio.run(endpoint._process_attachment(_make_message(), attachment, {}, 0))

    def test_services_json_declares_the_field_off(self):
        with open(_SERVICES_JSON, 'r', encoding='utf-8') as handle:
            schema = json.load(handle)

        field = schema['fields']['discord.pipelineTimeoutSeconds']
        assert field['default'] == 0
        assert field['minimum'] == 0
        assert 'discord.pipelineTimeoutSeconds' in schema['fields']['Pipe.source.parameters']['properties']
