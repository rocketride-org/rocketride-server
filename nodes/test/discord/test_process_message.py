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
    endpoint._send_response = mock.AsyncMock(return_value={'messageIds': ['900'], 'destination': 'reply'})
    endpoint._emit_no_reply = False
    endpoint._emit_outbound = False
    endpoint._include_member_metadata = False
    endpoint._bot = mock.Mock()
    endpoint._bot.user.id = 999
    endpoint._number_chunks = False
    endpoint._allowed_mention_role_ids = []
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
    """Object identity, metadata, and optional events stay consistent."""

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
# Reactions: the bot's own are ignored, the rest are scoped like messages
# ---------------------------------------------------------------------------


class _FakeThread(discord.Thread):
    """A thread channel: an id and the channel it hangs off."""

    def __init__(self, thread_id, parent_id=10):
        self.id = thread_id
        self.parent_id = parent_id


class TestOwnReactionsIgnored:
    """The node's own reactions never surface as user feedback."""

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
        """One timestamp, in the broadcast itself, so every consumer keys it the same."""
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
        return {'messageIds': message_ids, 'destination': 'reply'}

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
    """A ``no_reply`` reason can come from an exception message, so it is bounded."""

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
        )

    def test_the_shipped_defaults_are_unchanged(self):
        endpoint = self._parse({})

        assert self._numbers(endpoint) == (26214400, 90, 0, 12000)
        assert endpoint._reply_mode == 'reply'
        assert endpoint._thread_name == 'Pipeline Response'

    def test_string_proxies_are_coerced_to_int(self):
        endpoint = self._parse(
            {
                'maxAttachmentBytes': self._Proxy('1048576'),
                'threadNameMaxLength': self._Proxy('40'),
                'threadAutoArchiveMinutes': self._Proxy('1440'),
                'textAttachmentMaxChars': self._Proxy('5000'),
            }
        )

        assert self._numbers(endpoint) == (1048576, 40, 1440, 5000)
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
            }
        )

        assert self._numbers(endpoint) == (26214400, 90, 0, 12000)

    def test_a_float_is_truncated_not_rejected(self):
        endpoint = self._parse({'threadNameMaxLength': 12.0, 'textAttachmentMaxChars': '7.9'})

        assert endpoint._thread_name_max_length == 12
        assert endpoint._text_attachment_max_chars == 7

    @pytest.mark.parametrize(('configured', 'expected'), [(500, 100), (101, 100), (100, 100), (1, 1), (0, 1), (-5, 1)])
    def test_the_thread_name_length_is_clamped_to_what_discord_accepts(self, configured, expected):
        endpoint = self._parse({'threadNameMaxLength': self._Proxy(str(configured))})

        assert endpoint._thread_name_max_length == expected

    def test_a_clamped_thread_name_fits_discord(self):
        endpoint = self._parse({'threadNameMaxLength': 500, 'threadName': '{content}'})
        message = _make_message(content='x' * 300)

        assert len(endpoint._thread_name_for(message)) == 100

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


class TestUnsetListVariables:
    """An unresolved ``${NAME}`` in a list setting is named, not matched as an id."""

    @staticmethod
    def _message(field, name):
        return f'Discord Bot: {field} uses the variable {name}, which is not set on this server'

    def test_an_unset_variable_in_guild_or_channel_ids_is_fatal(self):
        assert IEndpoint._list_config_error({'guildIds': '${GUILD_IDS}'}) == self._message('guildIds', 'GUILD_IDS')
        assert IEndpoint._list_config_error({'channelIds': ['${CHANNEL_IDS}']}) == self._message(
            'channelIds', 'CHANNEL_IDS'
        )

    def test_the_variable_is_found_inside_json_text_and_delimited_lists(self):
        assert IEndpoint._list_config_error({'channelIds': '["${CHANNEL_IDS}"]'}) == self._message(
            'channelIds', 'CHANNEL_IDS'
        )
        assert IEndpoint._list_config_error({'guildIds': ['123', '${SECOND_GUILD}']}) == self._message(
            'guildIds', 'SECOND_GUILD'
        )
        assert IEndpoint._list_config_error({'guildIds': '123, ${SECOND_GUILD}'}) == self._message(
            'guildIds', 'SECOND_GUILD'
        )

    def test_resolved_ids_and_other_lists_are_not_fatal(self):
        assert IEndpoint._list_config_error({'guildIds': ['123'], 'channelIds': '["456"]'}) is None
        assert IEndpoint._list_config_error({'allowedBotIds': ['${BOT_IDS}']}) is None

    def test_the_start_fails_naming_the_variable(self):
        endpoint = TestNumericAndMentionConfig._parse({'botToken': 'token', 'channelIds': ['${CHANNEL_IDS}']})

        with pytest.raises(RuntimeError, match='channelIds uses the variable CHANNEL_IDS, which is not set'):
            asyncio.run(endpoint._startup())

    @pytest.mark.parametrize('field', ['allowedMentionRoleIds', 'allowedMentionUserIds'])
    def test_an_unset_variable_in_a_mention_list_warns(self, field):
        with mock.patch.object(_ENDPOINT_MODULE, '_config_warning') as warn:
            endpoint = TestNumericAndMentionConfig._parse({field: ['${MENTION_IDS}', '77']})

        attribute = '_allowed_mention_role_ids' if field == 'allowedMentionRoleIds' else '_allowed_mention_user_ids'
        assert getattr(endpoint, attribute) == ['77']
        warn.assert_called_once()
        assert field in warn.call_args.args[0]
        assert 'MENTION_IDS' in warn.call_args.args[0]

    def test_an_ordinary_non_numeric_mention_entry_does_not_warn(self):
        with mock.patch.object(_ENDPOINT_MODULE, '_config_warning') as warn:
            endpoint = TestNumericAndMentionConfig._parse({'allowedMentionRoleIds': ['the-team', '77']})

        assert endpoint._allowed_mention_role_ids == ['77']
        warn.assert_not_called()


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
