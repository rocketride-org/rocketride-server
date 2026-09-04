# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Behavioural tests for ``IEndpoint._process_message`` attachment routing.

Unlike ``test_discord.py`` (which tests the pure ``text_utils`` helpers), these
tests exercise the real ``IEndpoint`` coroutine to lock in the source-node
contract: **every** attachment on a message is ingested into the pipeline (a
Discord message may carry up to 10), while only the first non-empty answer —
text first, then attachments in order — is sent back as the reply.

``IEndpoint`` imports engine-only modules (``rocketlib``, ``ai.web``,
``depends``) and uses PEP 604 (``X | None``) class annotations, so it targets
Python 3.10+. Here we stub the engine modules and load the node as a synthetic
package. The module skips where it cannot be imported (Python < 3.10, or an env
without discord.py installed) so the portable helper suite is never affected.
"""

import asyncio
import importlib.util
import os
import sys
import types
from unittest import mock

import pytest

if sys.version_info < (3, 10):
    pytest.skip(
        'Discord node targets Python 3.10+ (PEP 604 class annotations)',
        allow_module_level=True,
    )

# discord.py must be importable for IEndpoint's module-level imports.
pytest.importorskip('discord', reason='discord.py not installed in this test env')

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../src/nodes/discord'))


def _load_endpoint_class():
    """Load the real ``IEndpoint`` class with engine modules stubbed out."""
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

    ai = types.ModuleType('ai')
    ai.__path__ = []
    ai_web = types.ModuleType('ai.web')
    # Must be a real class: IEndpoint uses it in a PEP 604 `WebServer | None`
    # class annotation, which requires a type on the left of `|`.
    ai_web.WebServer = type('WebServer', (), {})
    ai.web = ai_web

    depends = types.ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None

    stubs = {'rocketlib': rocketlib, 'ai': ai, 'ai.web': ai_web, 'depends': depends}
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
        return sys.modules['_discord_node.IEndpoint'].IEndpoint
    finally:
        # IEndpoint has already bound the names it imported; restore the real
        # module table so we don't leak stubs into other test modules.
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


IEndpoint = _load_endpoint_class()


def _make_endpoint(*, send_responses=True):
    """Build an IEndpoint instance with only the fields _process_message reads."""
    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint._send_responses = send_responses
    endpoint._show_typing = False
    # Patched collaborators so no real pipeline / Gateway is needed.
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
    """Return the reply text passed to _send_response, or None if not called."""
    if endpoint._send_response.await_count == 0:
        return None
    return endpoint._send_response.await_args.args[1]


class TestProcessMessageAttachments:
    """Every attachment is ingested; only the first non-empty answer is replied."""

    def test_all_attachments_ingested_even_after_answer_found(self):
        # Regression: an earlier `break` stopped after the first answering
        # attachment, silently dropping the rest (no download / routing /
        # monitorCompleted). A source node must feed every input object.
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
        endpoint._run_with_optional_typing.return_value = 'text-answer'  # text lane answers
        endpoint._process_attachment.side_effect = ['att-answer-1', 'att-answer-2']
        message = _make_message(content='caption', attachment_count=2)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 2  # not skipped by text reply
        assert _sent_reply(endpoint) == 'text-answer'  # text takes priority

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

        assert endpoint._process_attachment.await_count == 2  # ingested for the pipeline
        assert endpoint._send_response.await_count == 0  # but nothing posted back

    def test_text_only_message_sends_text_answer(self):
        endpoint = _make_endpoint()
        endpoint._run_with_optional_typing.return_value = 'hello-back'
        message = _make_message(content='hello', attachment_count=0)

        asyncio.run(endpoint._process_message(message))

        assert endpoint._process_attachment.await_count == 0
        assert _sent_reply(endpoint) == 'hello-back'


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
        # Regression: a scalar "123456" must not iterate into
        # ['1','2','3','4','5','6'], which would block every real id.
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
        # Regression: the old `async with typing(): return await factory()` form
        # re-ran factory (double ingestion) if the context __aexit__ raised.
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
        # @everyone (bot not in message.mentions) must NOT satisfy the gate.
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
