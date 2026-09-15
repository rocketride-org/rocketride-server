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
import os
import sys
import threading
import types
from unittest import mock

import pytest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../src/nodes/discord'))


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

    class _Intents:
        def __init__(self):
            self.message_content = False
            self.guilds = False

        @staticmethod
        def default():
            return _Intents()

    discord.Intents = _Intents

    class _AllowedMentions:
        _singleton = None

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


# ---------------------------------------------------------------------------
# _process_message: attachment ingest-all + first-answer
# ---------------------------------------------------------------------------


def _make_endpoint(*, send_responses=True):
    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint._send_responses = send_responses
    endpoint._show_typing = False
    endpoint._run_with_optional_typing = mock.AsyncMock(return_value='')
    endpoint._process_attachment = mock.AsyncMock()
    endpoint._send_response = mock.AsyncMock()
    return endpoint


def _make_message(*, content='', attachment_count=0):
    message = mock.Mock()
    message.content = content
    message.attachments = [mock.Mock(name=f'attachment_{i}') for i in range(attachment_count)]
    message.channel = mock.Mock()
    message.channel.id = 1
    message.id = 2
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

    def test_thread_mode_creates_thread_and_suppresses_mentions(self):
        endpoint = self._endpoint('thread')
        thread = mock.Mock()
        thread.send = mock.AsyncMock()
        message = mock.Mock()
        message.create_thread = mock.AsyncMock(return_value=thread)

        result = asyncio.run(endpoint._send_chunk(message, 'hi', None))

        assert result is thread
        message.create_thread.assert_awaited_once()
        kwargs = thread.send.await_args.kwargs
        assert kwargs['allowed_mentions'] is discord.AllowedMentions.none()

    def test_thread_mode_reuses_existing_thread(self):
        endpoint = self._endpoint('thread')
        existing = mock.Mock()
        existing.send = mock.AsyncMock()
        message = mock.Mock()
        message.create_thread = mock.AsyncMock()

        result = asyncio.run(endpoint._send_chunk(message, 'hi', existing))

        assert result is existing
        message.create_thread.assert_not_called()  # no second thread
        existing.send.assert_awaited_once()


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
        assert IEndpoint._as_str_list(('a', 'b')) == ['a', 'b']

    def test_bare_string_is_single_element_not_per_character(self):
        assert IEndpoint._as_str_list('123456') == ['123456']


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


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
