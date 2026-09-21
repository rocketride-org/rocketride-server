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

import asyncio
import json
import os
import threading
from typing import Any, Callable, Dict, List, Optional

from rocketlib import (
    IEndpointBase,
    monitorOther,
    monitorStatus,
    monitorCompleted,
    monitorFailed,
    debug,
    getObject,
    AVI_ACTION,
)

from depends import depends  # type: ignore

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

import discord
from discord.ext import commands

from .text_utils import chunk_message, guess_media_type, should_process_message


class IEndpoint(IEndpointBase):
    """
    IEndpoint for the Discord Bot source node.

    Connects to the Discord Gateway via discord.py, routes each incoming
    message (text plus image/audio/video/document attachments) to the matching
    pipeline lane, and sends the pipeline's answer back to the originating
    channel, message, or thread.

    Mirrors the Telegram node's architecture: the endpoint registers on the
    shared WebServer bootstrapped by ``node.py`` and blocks on a shutdown event,
    while the Discord Gateway client runs as a background task on the shared
    server's event loop.
    """

    target: Optional[IEndpointBase] = None
    _bot: Optional[commands.Bot] = None
    _bot_task: Optional[asyncio.Task] = None
    _bot_token: str = ''
    # _guild_ids / _channel_ids are populated per-instance in _run(); declared
    # as annotations only to avoid a mutable list shared across instances.
    _guild_ids: List[str]
    _channel_ids: List[str]
    _ignore_bots: bool = True
    _require_mention: bool = False
    _reply_mode: str = 'reply'
    _show_typing: bool = True
    _max_attachment_bytes: int = 26214400
    _send_responses: bool = True
    _inflight: set
    _shutdown_event: threading.Event
    # Set to a human-readable message when the Gateway client terminally fails
    # (bad token, missing intent, unexpected disconnect); makes _run re-raise so
    # the engine marks the source failed instead of hanging with a dead bot.
    _fatal_error: Optional[str] = None
    # True once _shutdown has begun, so _bot_runner does not mistake an
    # intentional close for a terminal failure.
    _closing: bool = False

    def _get_discord_config(self) -> Dict[str, Any]:
        """Read the Discord config block from serviceConfig parameters.

        The engine delivers the ``discord.*`` fields flat under ``parameters``
        (the ``discord.`` prefix is stripped), matching the Telegram node. A
        nested ``discord`` mapping is honored if one is present, but only when
        it is actually a dict; otherwise the flat ``parameters`` are used.

        Returns:
            Dict[str, Any]: The Discord configuration dictionary, or an empty
                dict if the config block is missing or cannot be read.
        """
        try:
            parameters = self.endpoint.serviceConfig['parameters']
            block = parameters.get('discord')
            return block if isinstance(block, dict) else parameters
        except Exception as e:
            debug(f'Discord _get_discord_config: EXCEPTION {e}')
            return {}

    # -------------------------------------------------------------------------
    # Server lifecycle
    # -------------------------------------------------------------------------

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Entry point called by the RocketRide engine to start the node.

        Stores the engine-provided target endpoint, then delegates to _run()
        which registers on the shared WebServer and blocks until shutdown. The
        _path and _scanCallback arguments are part of the IEndpointBase
        interface but are unused here because this source receives data via the
        Discord Gateway push rather than by scanning a filesystem path.

        Args:
            _path (str): Unused. Provided by the engine as the scan root path.
            _scanCallback (Callable): Unused. Provided by the engine as the
                callback for discovered objects.

        Returns:
            None
        """
        self.target = self.endpoint.target
        self._run()

    @staticmethod
    def _as_str_list(value: Any) -> List[str]:
        """Coerce a config value into a list of string ids.

        Guards against a bare string (which would otherwise iterate into a
        per-character allowlist and silently block every real id) and other
        non-list shapes.

        Args:
            value (Any): The raw config value (expected: list of ids).

        Returns:
            List[str]: The ids as strings, or an empty list.
        """
        if not value:
            return []
        if isinstance(value, str):
            return [value]
        if isinstance(value, (list, tuple)):
            return [str(v) for v in value]
        return [str(value)]

    def _run(self):
        """Register on the shared WebServer from ``node.py`` and block on shutdown.

        EaaS spawns this subprocess with ``--data_port=N``; ``node.py``
        bootstraps a shared :class:`WebServer` on a background event loop and
        exposes it as ``ai.node.shared_web_server``. We register our target
        endpoint on that server and drive the Gateway client's startup/shutdown
        on the shared ``server_loop`` — so the background bot task outlives
        ``_startup`` — then block on a shutdown event so ``scanObjects()`` does
        not return. This mirrors the Telegram source node. Constructing a second
        WebServer here (as an earlier version did) collides with the shared
        server already bound to ``--data_port`` (``EADDRINUSE``) and wires the
        target onto the wrong server, so the node never starts under EaaS.

        Returns:
            None
        """
        config = self._get_discord_config()
        self._bot_token = config.get('botToken', '')
        self._guild_ids = self._as_str_list(config.get('guildIds'))
        self._channel_ids = self._as_str_list(config.get('channelIds'))
        self._ignore_bots = config.get('ignoreBots', True)
        self._require_mention = config.get('requireMention', False)
        self._reply_mode = config.get('replyMode', 'reply')
        self._show_typing = config.get('showTyping', True)
        self._max_attachment_bytes = config.get('maxAttachmentBytes', 26214400)
        self._send_responses = config.get('sendResponses', True)
        debug(f'Discord _run: token_present={bool(self._bot_token)} reply_mode={self._reply_mode!r}')

        # Discover the shared server lazily — node.py assigns its module-level
        # ``shared_web_server`` at runtime, after this file is imported. Raises a
        # self-explaining error if this process has no shared server.
        from ai import node

        shared = node.require_shared_web_server('discord')
        shared.app.state.target = self.target

        # Drive _startup on the shared ``server_loop`` (not a throwaway
        # asyncio.run loop): _startup launches the Gateway client as a
        # background task that must live for the whole subprocess, so it needs
        # the long-lived loop that hosts the shared WebServer.
        from ai.node import server_loop

        # Create the shutdown event before _startup runs so the background bot
        # task can always signal a terminal failure back to this thread (a
        # failure that fires before the event existed would otherwise hang).
        self._shutdown_event = threading.Event()

        try:
            startup_future = asyncio.run_coroutine_threadsafe(self._startup(), server_loop)
            startup_future.result(timeout=30)
        except Exception as e:
            # Startup validation failed (e.g. missing token): fail the source
            # promptly rather than blocking forever with no bot.
            debug(f'Discord _startup raised: {e}')
            raise

        # Block scanObjects() until shutdown or a terminal Gateway failure. In
        # production the subprocess is terminated by EaaS, interrupting this
        # wait — mirroring how uvicorn's server.run() blocked until the same
        # external signal. _bot_runner sets this event on a terminal failure.
        self._shutdown_event.wait()

        try:
            shutdown_future = asyncio.run_coroutine_threadsafe(self._shutdown(), server_loop)
            shutdown_future.result(timeout=10)
        except Exception as e:
            debug(f'Discord _shutdown raised: {e}')

        # A terminal Gateway failure (invalid token, missing intent, unexpected
        # disconnect) surfaces as a failed source instead of a silent no-op.
        if self._fatal_error is not None:
            raise RuntimeError(self._fatal_error)

    async def _startup(self):
        """Initialize the Discord Gateway client and start it as a background task.

        Scheduled by _run on the shared server's event loop. Validates the
        token, builds the bot with the required intents, registers the
        on_ready / on_message handlers, and launches bot.start() concurrently.

        Returns:
            None
        """
        self._inflight = set()
        self._fatal_error = None
        self._closing = False

        if not self._bot_token:
            # Fail fast: a source with no token can never receive messages, so
            # surface it to the engine instead of idling forever.
            monitorStatus('Discord Bot: missing bot token')
            raise RuntimeError('Discord Bot: missing bot token')

        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True

        self._bot = commands.Bot(command_prefix='!', intents=intents)

        @self._bot.event
        async def on_ready():
            info = {
                'url-text': 'Discord Bot',
                'url-link': 'https://discord.com/',
                'auth-text': 'Bot Token (last 6 chars)',
                'auth-key': f'...{self._bot_token[-6:]}' if len(self._bot_token) >= 6 else '(set)',
            }
            monitorOther('usr', json.dumps([info]))
            monitorStatus(f'Discord Bot ready - logged in as {self._bot.user}')

        @self._bot.event
        async def on_message(message: discord.Message):
            await self._on_message(message)

        self._bot_task = asyncio.create_task(self._bot_runner())
        monitorStatus('Discord Bot: connecting to Gateway...')

    async def _bot_runner(self):
        """Run the Gateway client; a terminal failure fails the source promptly.

        On any non-recoverable outcome (invalid token, missing privileged
        intent, unexpected gateway error, or the connection closing while we are
        not shutting down) this records a fatal error and unblocks _run so the
        source reports a failure instead of idling with a dead bot.
        """
        try:
            await self._bot.start(self._bot_token)
            # start() returned without _shutdown cancelling it: the Gateway
            # closed on its own, so there is no working bot left.
            if not self._closing:
                self._fail('Discord Bot: gateway connection closed unexpectedly')
        except asyncio.CancelledError:
            pass  # expected: _shutdown cancelled the task
        except discord.LoginFailure:
            self._fail('Discord Bot: login failed (invalid token)')
        except discord.PrivilegedIntentsRequired:
            self._fail('Discord Bot: enable the Message Content Intent in the Developer Portal')
        except Exception as e:
            debug(f'Discord _bot_runner: EXCEPTION {e}')
            self._fail(f'Discord Bot: gateway error - {e}')

    def _fail(self, message: str):
        """Record a terminal Gateway failure and unblock _run so it fails.

        Called from _bot_runner on the shared server loop. Records the first
        error message and sets the thread-safe event _run waits on; _run then
        tears down and re-raises so the engine marks the source failed.

        Args:
            message (str): Actionable status describing the failure.

        Returns:
            None
        """
        if self._fatal_error is None:
            self._fatal_error = message
        monitorStatus(message)
        event = getattr(self, '_shutdown_event', None)
        if event is not None:
            event.set()

    async def _shutdown(self):
        """Gracefully tear down the Gateway client.

        Awaits in-flight message handlers, closes the bot connection, and
        cancels the background task. Clears the monitor user-info panel.

        Returns:
            None
        """
        # Mark shutdown first so _bot_runner treats the imminent close as
        # intentional rather than a terminal failure.
        self._closing = True

        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)

        if self._bot is not None:
            try:
                await self._bot.close()
            except Exception as e:
                debug(f'Discord _shutdown: close error {e}')

        if self._bot_task is not None:
            self._bot_task.cancel()
            try:
                await self._bot_task
            except asyncio.CancelledError:
                pass
            self._bot_task = None

        monitorOther('usr')

    # -------------------------------------------------------------------------
    # Message handling
    # -------------------------------------------------------------------------

    async def _on_message(self, message: discord.Message):
        """Filter an incoming message and dispatch it for processing.

        Applies bot-loop prevention, the guild/channel allowlists, and the
        optional @mention gate before scheduling _process_message as a tracked
        background task.

        Args:
            message (discord.Message): The incoming Gateway message.

        Returns:
            None
        """
        try:
            bot_user = self._bot.user
            if not should_process_message(
                author_id=message.author.id,
                bot_user_id=bot_user.id if bot_user is not None else None,
                author_is_bot=message.author.bot,
                ignore_bots=self._ignore_bots,
                guild_id=message.guild.id if message.guild is not None else None,
                channel_id=message.channel.id,
                allowed_guild_ids=self._guild_ids,
                allowed_channel_ids=self._channel_ids,
                require_mention=self._require_mention,
                # Direct @mention only: `mentioned_in` also returns True for
                # @everyone/@here, which would defeat the require_mention gate.
                is_mentioned=bool(bot_user is not None and bot_user in message.mentions),
            ):
                return

            task = asyncio.create_task(self._process_message(message))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)
        except Exception as e:
            debug(f'Discord _on_message: EXCEPTION {e}')

    async def _process_message(self, message: discord.Message):
        """Route a message to the pipeline and send back the first answer.

        Text content and attachments are ingested independently: the text is
        routed to the text lane, and every attachment is downloaded (subject to
        the size cap) and routed to the image/audio/video/tags lane by MIME
        type. All attachments are ingested (a message may carry up to 10); only
        the first non-empty answer overall — text first, then attachments in
        order — is sent back per the configured reply mode.

        Args:
            message (discord.Message): The message to process.

        Returns:
            None
        """
        try:
            reply = ''

            if message.content:
                text_reply = await self._run_with_optional_typing(
                    message,
                    lambda: asyncio.to_thread(self._run_text_pipeline, message.content, message.channel.id, message.id),
                )
                if text_reply:
                    reply = text_reply

            # A single Discord message can carry up to 10 attachments. As a
            # source node we ingest every one (each is downloaded, routed, and
            # counted via monitorCompleted); only the first non-empty answer is
            # kept for the reply.
            for attachment in message.attachments:
                att_reply = await self._process_attachment(message, attachment)
                if att_reply and not reply:
                    reply = att_reply

            if reply and self._send_responses:
                await self._send_response(message, reply)
        except Exception as e:
            debug(f'Discord _process_message: EXCEPTION {e}')

    async def _run_with_optional_typing(self, message: discord.Message, coro_factory):
        """Run an awaitable, optionally showing the Discord typing indicator.

        The pipeline awaitable is executed exactly once. Showing or closing the
        typing indicator is best-effort: a failure there must not cause the
        pipeline to run a second time (which would re-ingest the input and
        double the monitor accounting).

        Args:
            message (discord.Message): The message whose channel shows typing.
            coro_factory (Callable): Zero-arg callable returning the awaitable.

        Returns:
            Any: The awaited result.
        """
        if not self._show_typing:
            return await coro_factory()

        typing_cm = None
        try:
            typing_cm = message.channel.typing()
            await typing_cm.__aenter__()
        except Exception as e:
            debug(f'Discord: typing indicator failed to start: {e}')
            typing_cm = None

        try:
            return await coro_factory()
        finally:
            if typing_cm is not None:
                try:
                    await typing_cm.__aexit__(None, None, None)
                except Exception as e:
                    debug(f'Discord: typing indicator failed to close: {e}')

    async def _process_attachment(self, message: discord.Message, attachment: discord.Attachment) -> str:
        """Download one attachment and route it to the matching lane.

        Args:
            message (discord.Message): The parent message (for entry URL).
            attachment (discord.Attachment): The attachment to download.

        Returns:
            str: The first pipeline answer, or '' if skipped or none produced.
        """
        try:
            if attachment.size > self._max_attachment_bytes:
                debug(
                    f'Discord: skipping {attachment.filename} ({attachment.size} > {self._max_attachment_bytes} bytes)'
                )
                return ''
            mime_type = guess_media_type(attachment.filename, attachment.content_type or '')
            file_data = await attachment.read()
            if not file_data:
                return ''
            return await self._run_with_optional_typing(
                message,
                lambda: asyncio.to_thread(
                    self._run_binary_pipeline, file_data, mime_type, attachment.id, message.channel.id
                ),
            )
        except Exception as e:
            debug(f'Discord: attachment {attachment.filename} error: {e}')
            return ''

    # -------------------------------------------------------------------------
    # Pipeline execution
    # -------------------------------------------------------------------------

    def _run_text_pipeline(self, text: str, channel_id: int, message_id: int) -> str:
        """Push a text message through the pipeline on the text lane.

        Blocking; must be called via asyncio.to_thread.

        Args:
            text (str): The message text.
            channel_id (int): The originating channel id (entry URL).
            message_id (int): The originating message id (entry URL).

        Returns:
            str: The first pipeline answer, or '' on error / no answers.
        """
        entry = getObject(obj={'url': f'discord://{channel_id}/{message_id}', 'name': text[:200]})
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            pipe.writeText(text)
            pipe.close()
            results = entry.response.toDict()
            answers = results.get('answers', [])
            monitorCompleted(len(text.encode('utf-8')))
            return answers[0] if answers else ''
        except Exception as e:
            monitorFailed(len(text.encode('utf-8')))
            debug(f'Discord: text pipeline error: {e}')
            return ''
        finally:
            self.target.putPipe(pipe)

    def _run_binary_pipeline(self, file_data: bytes, mime_type: str, attachment_id: int, channel_id: int) -> str:
        """Push binary attachment data through the matching pipeline lane.

        Blocking; must be called via asyncio.to_thread.

        Args:
            file_data (bytes): The raw attachment bytes.
            mime_type (str): The attachment MIME type (selects the lane).
            attachment_id (int): The attachment id (entry URL / name).
            channel_id (int): The originating channel id (entry URL).

        Returns:
            str: The first pipeline answer, or '' on error / no answers.
        """
        entry = getObject(
            obj={
                'url': f'discord://{channel_id}/{attachment_id}',
                'name': str(attachment_id),
                'size': len(file_data),
                'mimeType': mime_type,
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            if mime_type.startswith('image/'):
                pipe.writeImage(AVI_ACTION.BEGIN, mime_type)
                pipe.writeImage(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeImage(AVI_ACTION.END, mime_type)
            elif mime_type.startswith('audio/'):
                pipe.writeAudio(AVI_ACTION.BEGIN, mime_type)
                pipe.writeAudio(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeAudio(AVI_ACTION.END, mime_type)
            elif mime_type.startswith('video/'):
                pipe.writeVideo(AVI_ACTION.BEGIN, mime_type)
                pipe.writeVideo(AVI_ACTION.WRITE, mime_type, file_data)
                pipe.writeVideo(AVI_ACTION.END, mime_type)
            else:
                pipe.writeTagBeginObject()
                pipe.writeTagBeginStream()
                pipe.writeTagData(file_data)
                pipe.writeTagEndStream()
                pipe.writeTagEndObject()
            pipe.close()
            results = entry.response.toDict()
            answers = results.get('answers', [])
            monitorCompleted(len(file_data))
            return answers[0] if answers else ''
        except Exception as e:
            monitorFailed(len(file_data))
            debug(f'Discord: binary pipeline error ({mime_type}): {e}')
            return ''
        finally:
            self.target.putPipe(pipe)

    # -------------------------------------------------------------------------
    # Replies
    # -------------------------------------------------------------------------

    async def _send_response(self, message: discord.Message, response: str):
        """Send the pipeline answer back to Discord per the configured mode.

        Long answers are chunked at Discord's 2000-character limit. discord.py
        transparently handles most 429s; if it surfaces a ``RateLimited`` the
        send is retried once after the reported ``retry_after`` delay. If a send
        is still unrecoverable, the remaining chunks are abandoned (rather than
        silently sending a reply with a hole in the middle).

        Args:
            message (discord.Message): The originating message.
            response (str): The pipeline answer text.

        Returns:
            None
        """
        thread = None
        for chunk in chunk_message(response):
            try:
                thread = await self._send_chunk(message, chunk, thread)
            except discord.RateLimited as e:
                # discord.py handles 429s internally (honoring Retry-After) and
                # only surfaces RateLimited when the client sets
                # max_ratelimit_timeout, which we do not — this is defensive:
                # retry once after the reported delay if it is ever raised.
                debug(f'Discord: rate limited; retrying after {e.retry_after}s')
                await asyncio.sleep(float(e.retry_after))
                try:
                    thread = await self._send_chunk(message, chunk, thread)
                except Exception as e2:
                    debug(f'Discord: send retry failed, abandoning remaining chunks: {e2}')
                    return
            except Exception as e:
                debug(f'Discord: send failed, abandoning remaining chunks: {e}')
                return

    async def _send_chunk(self, message: discord.Message, chunk: str, thread):
        """Send a single chunk using the configured reply mode.

        Args:
            message (discord.Message): The originating message.
            chunk (str): The chunk text (already within the char limit).
            thread: The thread created for a prior chunk, or None.

        Returns:
            The thread used (for 'thread' mode) so later chunks reuse it, else None.
        """
        # Suppress all mentions on outbound content: the reply is model-generated
        # text and must never ping users, roles, @here or @everyone even if it
        # contains mention syntax.
        no_mentions = discord.AllowedMentions.none()

        if self._reply_mode == 'reply':
            await message.reply(chunk, mention_author=False, allowed_mentions=no_mentions)
            return None

        if self._reply_mode == 'thread':
            if thread is None:
                channel = message.channel
                if isinstance(channel, discord.Thread):
                    # The message already lives in a thread: post into it
                    # rather than trying to create a nested one (which fails).
                    thread = channel
                elif isinstance(channel, discord.TextChannel):
                    thread = await message.create_thread(name='Pipeline Response')
                else:
                    # DMs and other non-threadable channels cannot host a
                    # thread; fall back to a plain reply.
                    await message.reply(chunk, mention_author=False, allowed_mentions=no_mentions)
                    return None
            await thread.send(chunk, allowed_mentions=no_mentions)
            return thread

        await message.channel.send(chunk, allowed_mentions=no_mentions)
        return None
