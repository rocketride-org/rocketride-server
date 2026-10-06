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
import contextlib
import time
import json
import os
import re
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

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

from .text_utils import (
    attachment_kind,
    chunk_message,
    clip_attachment_text,
    compose_merged_question,
    decode_text_attachment,
    fold_binary_answer,
    fold_text_attachment,
    guess_media_type,
    should_process_message,
)

# Returned by ``_send_chunk`` in place of a thread when creating the response
# thread failed: the remaining chunks must keep replying instead of asking
# Discord for a thread again (and failing) once per chunk.
_THREAD_FALLBACK = object()

# The only auto-archive durations the Discord API accepts. Anything else is
# rejected with a 400, which would cost the whole answer, so an unsupported
# value is dropped and the channel's own default applies instead.
THREAD_ARCHIVE_DURATIONS = (60, 1440, 4320, 10080)

# Discord rejects a thread name outside 1..100 characters.
THREAD_NAME_MAX_CHARS = 100

# Some ``no_reply`` reasons are built from an exception message. Clipped here,
# at the one place every reason passes through, so a runaway string cannot
# reach the emitted event.
MAX_NO_REPLY_REASON_CHARS = 200

# Upper bounds for maxConcurrentMessages and maxAttachmentBytes (the schema
# declares the same): every message being processed holds its downloaded
# attachments in memory until the pipeline answers.
MAX_CONCURRENT_MESSAGES = 32
MAX_ATTACHMENT_BYTES = 104857600


# A ``${NAME}`` the engine could not resolve reaches the node as literal text.
_UNRESOLVED_VARIABLE = re.compile(r'^\$\{([A-Za-z0-9_]+)\}$')

# The engine resolves only ``ROCKETRIDE_*`` variables; any other ``${NAME}``
# is replaced with this literal (see ``resolve_pipeline_env``).
_REDACTED_VARIABLE = '<REDACTED>'


def _unresolved_variable(value: Any) -> Optional[str]:
    """Describe the variable a setting value failed to resolve, else None.

    Args:
        value (Any): One setting value (the token, or one list entry).

    Returns:
        Optional[str]: A clause naming the problem, for example
            ``the variable NAME, which is not set on this server (...)``, or
            None when the value is not an unresolved variable.
    """
    text = str(value).strip()
    if text == _REDACTED_VARIABLE:
        problem = 'a variable without the ROCKETRIDE_ prefix, which the engine does not resolve'
    else:
        unresolved = _UNRESOLVED_VARIABLE.match(text)
        if not unresolved:
            return None
        problem = f'the variable {unresolved.group(1)}, which is not set on this server'
    return f'{problem} (only ROCKETRIDE_* server variables are resolved)'


def _engine_warning(message: str) -> None:
    """Log through the engine's logger when there is one."""
    try:
        from rocketlib import warning  # type: ignore  # engine-only module
    except ImportError:
        return
    warning(message)


def _config_warning(message: str) -> None:
    """Report a configuration problem where an operator looks: the task's warnings."""
    debug(message)
    _engine_warning(message)


def _broken_json_text(value: Any) -> Optional[str]:
    """The first item of a list setting that looks like JSON but does not parse."""
    if not value:
        return None
    items = list(value) if isinstance(value, (list, tuple)) else [value]
    for item in items:
        if item is None or isinstance(item, (int, float)):
            continue
        text = str(item).strip()
        if not text.startswith('['):
            continue
        try:
            json.loads(text)
        except ValueError:
            return text
    return None


def _raw_item_count(value: Any) -> int:
    """How many items a list setting was given, blank ones included.

    A JSON-text item (the engine's encoding of an array) counts the items it
    holds, so ``'[]'`` and ``['[]']`` count none while ``'[""]'`` counts one.
    """
    if not value:
        return 0
    items = list(value) if isinstance(value, (list, tuple)) else [value]
    count = 0
    for item in items:
        if item is None:
            continue
        text = str(item).strip()
        if text.startswith('['):
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None
            if isinstance(parsed, list):
                count += len(parsed)
                continue
        count += 1
    return count


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
    _require_mention_channel_ids: List[str]
    _allowed_bot_ids: List[str]
    _allowed_mention_role_ids: List[str]
    _allowed_mention_user_ids: List[str]
    _ignore_bots: bool = True
    _require_mention: bool = False
    _reply_mode: str = 'reply'
    _show_typing: bool = True
    _max_attachment_bytes: int = 26214400
    _max_concurrent_messages: int = 4
    # Created in _startup on the loop that runs the handlers; bounds how many
    # _process_message bodies run at once.
    _message_slots: Optional[asyncio.Semaphore] = None
    _send_responses: bool = True
    _thread_name: str = 'Pipeline Response'
    _thread_name_max_length: int = 90
    # 0 = the channel's own default (what discord.py does when none is passed).
    _thread_auto_archive_minutes: int = 0
    _number_chunks: bool = False
    _text_attachment_extensions: List[str]
    _text_attachment_max_chars: int = 12000
    _merge_attachments: bool = False
    _emit_reactions: bool = False
    _emit_no_reply: bool = False
    _emit_outbound: bool = False
    _include_member_metadata: bool = False
    _config_error: Optional[str] = None
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
    def _as_str_list(value: Any, field: str = '', split: bool = True) -> List[str]:
        """Coerce a config value into a list of strings.

        Guards against a bare string (which would otherwise iterate into a
        per-character allowlist and silently block every real id) and other
        non-list shapes.

        Args:
            value (Any): The raw config value (expected: list of ids).
            field (str): The setting's name, for the warning a value that
                looks like JSON but does not parse produces.
            split (bool): Split each item on commas and whitespace (ids).
                False keeps every item whole (phrases); items are still
                stripped and blank ones dropped either way.

        Returns:
            List[str]: The strings, or an empty list.
        """
        if not value:
            return []
        items = list(value) if isinstance(value, (list, tuple)) else [value]

        def parts(text: str) -> List[str]:
            if not split:
                return [text] if text else []
            return [part for part in re.split(r'[,\s]+', text) if part]

        out: List[str] = []
        for item in items:
            if item is None:
                continue
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                out.append(str(item))
                continue
            # Engine-provided values may be string-like proxies rather than str:
            # always go through str() before inspecting the text.
            text = str(item).strip()
            if not text:
                continue
            # The engine delivers array-typed parameters to Python nodes as JSON
            # text, either bare ('["123","456"]') or as the only element of a
            # list (['["123","456"]']). Treating that text as one id made every
            # allowlist reject every message. Parse it back, and also accept a
            # comma/whitespace-separated list a user may type by hand.
            if text.startswith('['):
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
                    # Read as plain text below, which matches nothing it was
                    # meant to: say so, or an allowlist silently rejects all.
                    _config_warning(
                        f'Discord: {field or "a list setting"} is not valid JSON ({text[:80]!r}); '
                        f'it is read as plain text. Fix the setting.'
                    )
                if isinstance(parsed, list):
                    # Each item gets the same strip + split as a bare string,
                    # so '[" 123 "]' and '["123,456"]' read as ids too.
                    for parsed_item in parsed:
                        out.extend(parts(str(parsed_item).strip()))
                    continue
            out.extend(parts(text))
        return out

    @classmethod
    def _list_config_error(cls, config: Dict[str, Any]) -> Optional[str]:
        """A fatal problem in the guild, channel or mention-channel list, else None.

        Broken JSON in any of the three lists, or a ``${NAME}`` the engine
        could not resolve in any of the three (it arrives as literal text, or
        as ``<REDACTED>``, and becomes an id that matches nothing), leaves the
        bot connected but answering nothing, or for the mention-channel list
        answering without the mention it was meant to require, so the start
        fails with the reason. Other lists only warn.

        A list that was given items but resolves to no ids (a set
        ``${ROCKETRIDE_X}`` whose value is empty arrives as ``""``) fails too:
        an empty list means "everywhere", which is not what was configured.
        """
        for field in ('guildIds', 'channelIds', 'requireMentionChannelIds'):
            value = config.get(field)
            text = _broken_json_text(value)
            if text is not None:
                return f'Discord Bot: {field} is not valid JSON ({text[:80]!r}); fix the setting'
            ids = cls._as_str_list(value, field=field)
            for item in ids:
                problem = _unresolved_variable(item)
                if problem:
                    return f'Discord Bot: {field} uses {problem}'
            if not ids and _raw_item_count(value):
                return (
                    f'Discord Bot: {field} is set but resolves to no ids (an empty variable?); '
                    f'fix the setting or remove it'
                )
        return None

    @staticmethod
    def _as_int(value: Any, default: int) -> int:
        """Coerce a numeric config value to ``int``, falling back to ``default``.

        The engine delivers ``number`` parameters to Python nodes as
        string-like proxies rather than ints, and these values are used where
        only a real int works (slice bounds, size comparisons, a Discord API
        argument). Goes through ``float`` so ``'12.0'`` is accepted too.

        Args:
            value (Any): The raw config value.
            default (int): Used when the value is missing or unusable.

        Returns:
            int: The coerced value, or ``default``.
        """
        try:
            return int(float(str(value)))
        except (TypeError, ValueError):
            return default

    @classmethod
    def _snowflake_ids(cls, value: Any, field: str) -> List[str]:
        """Coerce an id allowlist, keeping only ids Discord could have issued.

        ``_allowed_mentions`` turns every entry into ``int(...)``, and that
        call sits inside the per-chunk send: one non-numeric entry (a role
        name, a pasted ``<@&123>``) raised for every chunk of every answer, so
        a single typo silenced the bot completely. Bad entries are dropped
        with a debug line instead.

        Args:
            value (Any): The raw config value.
            field (str): Field name, for the debug line.

        Returns:
            List[str]: The digit-only ids, in configured order.
        """
        ids: List[str] = []
        for item in cls._as_str_list(value, field=field):
            if item.isdigit():
                ids.append(item)
                continue
            problem = _unresolved_variable(item)
            if problem:
                # Dropped like any non-numeric entry, but an operator has to
                # hear about it: the mention it was meant to allow never pings.
                _config_warning(f'Discord: {field} uses {problem}; the entry is ignored')
            else:
                debug(f'Discord: ignoring {field} entry {item!r} - not a numeric Discord id')
        return ids

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
        self._guild_ids = self._as_str_list(config.get('guildIds'), field='guildIds')
        self._channel_ids = self._as_str_list(config.get('channelIds'), field='channelIds')
        self._require_mention_channel_ids = self._as_str_list(
            config.get('requireMentionChannelIds'), field='requireMentionChannelIds'
        )
        self._allowed_bot_ids = self._as_str_list(config.get('allowedBotIds'), field='allowedBotIds')
        for item in self._allowed_bot_ids:
            problem = _unresolved_variable(item)
            if problem:
                # Not fatal (an unmatched entry only keeps a bot out), but the
                # bot it was meant to let through is ignored: say so.
                _config_warning(f'Discord: allowedBotIds uses {problem}; the entry matches no bot')
        self._config_error = self._list_config_error(config)
        # Mention allowlists are the one config the outbound path cannot
        # tolerate garbage in, so a non-numeric entry is dropped here.
        self._allowed_mention_role_ids = self._snowflake_ids(
            config.get('allowedMentionRoleIds'), 'allowedMentionRoleIds'
        )
        self._allowed_mention_user_ids = self._snowflake_ids(
            config.get('allowedMentionUserIds'), 'allowedMentionUserIds'
        )
        self._ignore_bots = config.get('ignoreBots', True)
        self._require_mention = config.get('requireMention', False)
        # Engine-provided strings may be proxies; this one is compared to
        # literals and the numbers below are used where only an int works.
        self._reply_mode = str(config.get('replyMode') or 'reply')
        self._show_typing = config.get('showTyping', True)
        self._max_attachment_bytes = min(MAX_ATTACHMENT_BYTES, self._as_int(config.get('maxAttachmentBytes'), 26214400))
        self._max_concurrent_messages = max(
            1, min(MAX_CONCURRENT_MESSAGES, self._as_int(config.get('maxConcurrentMessages'), 4))
        )
        self._send_responses = config.get('sendResponses', True)
        self._thread_name = str(config.get('threadName') or 'Pipeline Response')
        self._thread_name_max_length = max(
            1, min(THREAD_NAME_MAX_CHARS, self._as_int(config.get('threadNameMaxLength'), 90))
        )
        self._thread_auto_archive_minutes = self._as_int(config.get('threadAutoArchiveMinutes'), 0)
        self._number_chunks = config.get('numberChunks', False)
        self._text_attachment_extensions = [
            value.lower()
            for value in self._as_str_list(config.get('textAttachmentExtensions', []), field='textAttachmentExtensions')
        ]
        self._text_attachment_max_chars = self._as_int(config.get('textAttachmentMaxChars'), 12000)
        self._merge_attachments = config.get('mergeAttachments', False)
        self._emit_reactions = config.get('emitReactions', False)
        self._emit_no_reply = config.get('emitNoReply', False)
        self._emit_outbound = config.get('emitOutbound', False)
        self._include_member_metadata = config.get('includeMemberMetadata', False)
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
        # Messages past the limit wait for a slot; none are dropped.
        self._message_slots = asyncio.Semaphore(self._max_concurrent_messages)

        if not self._bot_token:
            # Fail fast: a source with no token can never receive messages, so
            # surface it to the engine instead of idling forever.
            monitorStatus('Discord Bot: missing bot token')
            raise RuntimeError('Discord Bot: missing bot token')

        problem = _unresolved_variable(self._bot_token)
        if problem:
            # The engine passes an unset ${ROCKETRIDE_*} through as text and
            # any other ${NAME} as <REDACTED>; Discord would only say "invalid
            # token", which points at the wrong fix.
            message = f'Discord Bot: the bot token uses {problem}'
            monitorStatus(message)
            raise RuntimeError(message)

        config_error = getattr(self, '_config_error', None)
        if config_error:
            monitorStatus(config_error)
            raise RuntimeError(config_error)

        if not getattr(self, '_guild_ids', []) and not getattr(self, '_channel_ids', []):
            # Valid, and the default, but a new Discord application is a Public
            # Bot: anyone can add it to their server and it will answer there.
            # A channel list alone already limits it (and refuses DMs).
            _config_warning(
                'Discord: guildIds and channelIds are empty, so the bot will answer in any server it is added to; '
                'set guildIds and turn off Public Bot in the Developer Portal'
            )

        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        if self._include_member_metadata and hasattr(intents, 'members'):
            intents.members = True
        if self._emit_reactions and hasattr(intents, 'reactions'):
            intents.reactions = True

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

        if self._emit_reactions:

            @self._bot.event
            async def on_raw_reaction_add(payload):
                await self._on_raw_reaction(payload, True)

            @self._bot.event
            async def on_raw_reaction_remove(payload):
                await self._on_raw_reaction(payload, False)

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
            # discord.py does not say which intent was refused. Message Content
            # is always requested, so with member metadata on the likely missing
            # one is Server Members: lead with it.
            if getattr(self, '_include_member_metadata', False):
                self._fail(
                    'Discord Bot: enable the Server Members Intent in the Developer Portal '
                    '(the Message Content Intent is required too)'
                )
            else:
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

    async def _on_message(self, message: discord.Message, wait: bool = False):
        """Filter an incoming message and dispatch it for processing.

        Applies bot-loop prevention, the guild/channel allowlists, and the
        optional @mention gate before scheduling _process_message as a tracked
        background task.

        Args:
            message (discord.Message): The incoming Gateway message.

        Returns:
            None
        """
        # Once shutdown has started it has already taken stock of the work in
        # flight; a task started now would never be awaited.
        if getattr(self, '_closing', False):
            return
        try:
            # Discord's own notices (joins, pins, boosts, "started a thread")
            # are not questions, and a message with neither text nor a file has
            # nothing to ask about. ``is_system`` must be a real bool: a
            # stand-in returning anything else is not a system flag.
            is_system = getattr(message, 'is_system', None)
            if callable(is_system) and is_system() is True:
                return
            content = getattr(message, 'content', '') or ''
            if isinstance(content, str):
                content = content.strip()
            if not content and not (getattr(message, 'attachments', None) or []):
                return

            bot_user = self._bot.user
            parent_channel_id = (
                getattr(message.channel, 'parent_id', None) if isinstance(message.channel, discord.Thread) else None
            )
            require_mention_channels = getattr(self, '_require_mention_channel_ids', [])
            require_mention = self._require_mention or (
                str(message.channel.id) in require_mention_channels
                or str(parent_channel_id) in require_mention_channels
            )
            if not should_process_message(
                author_id=message.author.id,
                bot_user_id=bot_user.id if bot_user is not None else None,
                author_is_bot=message.author.bot,
                ignore_bots=self._ignore_bots,
                guild_id=message.guild.id if message.guild is not None else None,
                channel_id=message.channel.id,
                parent_channel_id=parent_channel_id,
                allowed_guild_ids=self._guild_ids,
                allowed_channel_ids=self._channel_ids,
                allowed_bot_ids=getattr(self, '_allowed_bot_ids', []),
                require_mention=require_mention,
                # Direct @mention only: `mentioned_in` also returns True for
                # @everyone/@here, which would defeat the require_mention gate.
                is_mentioned=bool(bot_user is not None and bot_user in message.mentions),
            ):
                return

            task = asyncio.create_task(self._process_message(message))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)
            if wait:
                await task
        except Exception as e:
            debug(f'Discord _on_message: EXCEPTION {e}')

    @staticmethod
    def _question_text(message: discord.Message) -> str:
        """The message's own text, or '' when it is only whitespace.

        The intake gate strips the text to decide whether a message has
        anything to ask; processing must see the same answer, or blank text
        next to a file runs a text pass of its own.
        """
        content = message.content if isinstance(message.content, str) else str(message.content or '')
        return content if content.strip() else ''

    @staticmethod
    def _answer_text(answer: Any) -> str:
        """A pipeline answer, or '' when it is only whitespace.

        Answers are chosen by truthiness, so a blank one (``'\\n'``) would
        otherwise win over a real answer from a later lane.
        """
        text = answer if isinstance(answer, str) else str(answer or '')
        return text if text.strip() else ''

    def _message_metadata(self, message: discord.Message) -> Dict[str, Any]:
        """Build the stable downstream metadata contract for one message."""
        channel = message.channel
        is_thread = isinstance(channel, discord.Thread)
        created_at = getattr(message, 'created_at', None)
        author = message.author
        reference = getattr(message, 'reference', None)
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        include_member = getattr(self, '_include_member_metadata', False)
        roles_value = getattr(author, 'roles', []) if include_member else []
        roles = roles_value if isinstance(roles_value, (list, tuple)) else []
        mentions_value = getattr(message, 'mentions', [])
        mentions = mentions_value if isinstance(mentions_value, (list, tuple)) else []
        role_mentions_value = getattr(message, 'role_mentions', [])
        role_mentions = role_mentions_value if isinstance(role_mentions_value, (list, tuple)) else []
        attachments = []
        for attachment in getattr(message, 'attachments', []):
            attachments.append(
                {
                    'name': getattr(attachment, 'filename', None),
                    'contentType': getattr(attachment, 'content_type', None),
                    'size': getattr(attachment, 'size', None),
                }
            )
        return {
            'messageId': str(message.id),
            'channelId': str(channel.id),
            'threadId': str(channel.id) if is_thread else None,
            'parentChannelId': (
                str(channel.parent_id) if is_thread and getattr(channel, 'parent_id', None) is not None else None
            ),
            'guildId': str(message.guild.id) if getattr(message, 'guild', None) is not None else None,
            'createdAt': created_at.isoformat() if created_at is not None else None,
            'authorId': str(author.id),
            'authorIsBot': bool(author.bot),
            'authorDisplayName': getattr(author, 'display_name', None) if include_member else None,
            'authorRoleIds': [str(role.id) for role in roles],
            'mentionedUserIds': [str(user.id) for user in mentions],
            'mentionedRoleIds': [str(role.id) for role in role_mentions] if include_member else [],
            'repliedToMessageId': (
                str(reference.message_id) if reference is not None and reference.message_id is not None else None
            ),
            'botUserId': str(bot_user.id) if bot_user is not None else None,
            'attachments': attachments,
            'correlationId': str(message.id),
            'groupIndex': 0,
            'groupSize': 1,
        }

    def _reactor_is_bot(self, payload, added: bool) -> bool:
        """Whether the account that reacted is a bot, as far as we can tell.

        ``payload.member`` is only populated on an add (and only in a guild),
        so a removal is resolved through the user cache instead. An account
        neither source knows is treated as human: dropping every unknown
        reactor would quietly lose real feedback.

        Args:
            payload: The raw reaction payload.
            added (bool): True for an add, False for a remove.

        Returns:
            bool: True only when the reactor is known to be a bot.
        """
        member = getattr(payload, 'member', None)
        if added and member is not None:
            return bool(getattr(member, 'bot', False))
        bot = getattr(self, '_bot', None)
        get_user = getattr(bot, 'get_user', None) if bot is not None else None
        user = get_user(payload.user_id) if callable(get_user) else None
        return bool(getattr(user, 'bot', False))

    async def _on_raw_reaction(self, payload, added: bool):
        """Emit one raw reaction event when reaction capture is enabled."""
        if not getattr(self, '_emit_reactions', False):
            return
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        # The node's own reactions are not feedback: emitting them would have
        # a subscriber count a user grade on every answer before anyone reacted.
        if bot_user is not None and str(payload.user_id) == str(getattr(bot_user, 'id', None)):
            return
        member = getattr(payload, 'member', None)
        channel = self._bot.get_channel(payload.channel_id) if self._bot is not None else None
        is_thread = isinstance(channel, discord.Thread)

        # A reaction is scoped exactly like a message: without this the
        # allowlists and ignoreBots applied to questions but not to the
        # reaction events the same node emits.
        allowed_channel_ids = getattr(self, '_channel_ids', []) or []
        if allowed_channel_ids and channel is None:
            # The parent of a thread is the only way a thread matches the
            # allowlist, and an unresolved channel cannot say either way.
            debug(f'Discord: reaction in unresolved channel {payload.channel_id} dropped by the channel allowlist')
            return
        if not should_process_message(
            author_id=payload.user_id,
            bot_user_id=getattr(bot_user, 'id', None),
            author_is_bot=self._reactor_is_bot(payload, added),
            ignore_bots=getattr(self, '_ignore_bots', True),
            guild_id=getattr(payload, 'guild_id', None),
            channel_id=payload.channel_id,
            parent_channel_id=getattr(channel, 'parent_id', None) if is_thread else None,
            allowed_guild_ids=getattr(self, '_guild_ids', []) or [],
            allowed_channel_ids=allowed_channel_ids,
            allowed_bot_ids=getattr(self, '_allowed_bot_ids', []) or [],
            # A reaction carries no text, so there is nothing to mention in.
            require_mention=False,
            is_mentioned=False,
        ):
            return

        metadata = {
            'messageId': str(payload.message_id),
            'channelId': str(payload.channel_id),
            'threadId': str(payload.channel_id) if is_thread else None,
            'parentChannelId': str(channel.parent_id) if is_thread else None,
            'guildId': str(payload.guild_id) if getattr(payload, 'guild_id', None) is not None else None,
            'createdAt': None,
            'authorId': str(payload.user_id),
            'authorIsBot': bool(getattr(member, 'bot', False)),
            'authorDisplayName': getattr(member, 'display_name', None)
            if getattr(self, '_include_member_metadata', False)
            else None,
            'authorRoleIds': [str(role.id) for role in getattr(member, 'roles', [])]
            if getattr(self, '_include_member_metadata', False) and member is not None
            else [],
            'mentionedUserIds': [],
            'mentionedRoleIds': [],
            'repliedToMessageId': None,
            'botUserId': str(bot_user.id) if bot_user is not None else None,
            'attachments': [],
            'correlationId': str(payload.message_id),
            'groupIndex': 0,
            'groupSize': 1,
        }
        await asyncio.to_thread(
            self._emit_event_pipeline,
            metadata,
            'reaction',
            # occurredAt is stamped once, here, so every consumer of this event — the
            # broadcast and a later import from the task log — keys the same
            # reaction identically.
            {
                'emoji': str(payload.emoji),
                'added': added,
                'userId': str(payload.user_id),
                'occurredAt': int(time.time() * 1000),
            },
        )

    async def _process_message(self, message: discord.Message):
        """Route a message to the pipeline and send back its answer.

        With ``mergeAttachments`` on a message that carries text
        plus attachments produces ONE answer that has seen everything, the way
        the support bot did: text-like files are folded into the question,
        image/audio/video/other attachments still run as their own lane objects
        first, and their answers are folded in as context before the single
        text pass whose answer is posted. With it off, text and attachments are
        ingested independently and only the first non-empty answer overall —
        text first, then attachments in order — is sent back.

        Either way every attachment is ingested (a message may carry up to 10)
        and the reply is posted per the configured reply mode.

        Args:
            message (discord.Message): The message to process.

        Returns:
            None
        """
        # Each message holds its downloaded attachments until the pipeline
        # answers: bound how many are in here at once. Later ones wait.
        slots = getattr(self, '_message_slots', None)
        async with slots if slots is not None else contextlib.nullcontext():
            metadata = self._message_metadata(message)
            if getattr(self, '_closing', False):
                # Shutdown began while this message waited for a slot: it must
                # not download, run the pipeline or reply after that point.
                await self._emit_no_reply_event(metadata, 'shutdown')
                return
            eligible_attachments = [
                attachment
                for attachment in message.attachments
                if not isinstance(getattr(attachment, 'size', None), (int, float))
                or attachment.size <= self._max_attachment_bytes
            ]
            merge = bool(getattr(self, '_merge_attachments', False)) and bool(message.attachments)
            question = self._question_text(message)
            group_size = (1 if question else 0) + len(eligible_attachments)
            group_index = 0
            processing_errors: List[str] = []
            try:
                reply = ''

                if merge:
                    reply = await self._process_merged(message, metadata, eligible_attachments, processing_errors)
                else:
                    if question:
                        text_meta = dict(metadata, groupIndex=group_index, groupSize=group_size)
                        group_index += 1
                        text_reply = await self._run_with_optional_typing(
                            message,
                            lambda: asyncio.to_thread(
                                self._run_text_pipeline,
                                question,
                                message.channel.id,
                                message.id,
                                text_meta,
                            ),
                        )
                        text_reply = self._answer_text(text_reply)
                        if text_reply:
                            reply = text_reply
                        if text_meta.get('_pipelineError'):
                            processing_errors.append(text_meta.pop('_pipelineError'))

                    # A single Discord message can carry up to 10 attachments. As a
                    # source node we ingest every one (each is downloaded, routed, and
                    # counted via monitorCompleted); only the first non-empty answer is
                    # kept for the reply.
                    for attachment_index, attachment in enumerate(message.attachments):
                        attachment_meta = dict(metadata, groupIndex=group_index, groupSize=group_size)
                        if attachment in eligible_attachments:
                            group_index += 1
                        att_reply = self._answer_text(
                            await self._process_attachment(message, attachment, attachment_meta, attachment_index)
                        )
                        if attachment_meta.get('_pipelineError'):
                            processing_errors.append(attachment_meta.pop('_pipelineError'))
                        if att_reply and not reply:
                            reply = att_reply

                if reply and self._send_responses:
                    outbound = await self._send_response(message, reply)
                    if outbound.get('messageIds'):
                        if getattr(self, '_emit_outbound', False):
                            await self._emit_outbound_event(message, metadata, reply, outbound)
                    else:
                        # There was an answer and posting it was wanted, but every
                        # chunk failed (a missing Send Messages permission, a
                        # deleted channel). Without this the question has a
                        # ``message`` event and no outcome at all.
                        await self._emit_no_reply_event(metadata, 'send_failed')
                elif reply and getattr(self, '_emit_outbound', False):
                    # sendResponses is off: still make the answer observable downstream
                    await self._emit_outbound_event(
                        message, metadata, reply, {'messageIds': [], 'destination': 'suppressed'}
                    )
                elif not reply and getattr(self, '_emit_no_reply', False):
                    await self._emit_no_reply_event(
                        metadata, processing_errors[0] if processing_errors else 'no_answer'
                    )
            except Exception as e:
                debug(f'Discord _process_message: EXCEPTION {e}')
                if getattr(self, '_emit_no_reply', False):
                    await self._emit_no_reply_event(metadata, str(e))

    async def _process_merged(
        self,
        message: discord.Message,
        metadata: Dict[str, Any],
        eligible_attachments: List[Any],
        processing_errors: List[str],
    ) -> str:
        """Answer a message with attachments in a single text pass.

        Mirrors the support bot's ``collectParts`` / ``combineIfNeeded``:
        text-like files are folded into the question, every other attachment
        still becomes its own lane object (same lane, same metadata, same SSE
        event as when merging is off) and its answer is folded in as context.
        The one text pass that follows is the reply; if it produces nothing the
        first non-empty attachment answer is used, exactly as before.

        Args:
            message (discord.Message): The message being processed.
            metadata (Dict[str, Any]): The per-message metadata contract.
            eligible_attachments (List[Any]): Attachments within the size cap.
            processing_errors (List[str]): Collects pipeline/download errors.

        Returns:
            str: The reply to post, or '' when nothing answered.
        """
        text_like: List[Any] = []
        binaries: List[Any] = []
        for attachment_index, attachment in enumerate(message.attachments):
            if attachment in eligible_attachments and self._is_text_attachment(attachment):
                text_like.append((attachment_index, attachment))
            else:
                # Oversized files go here too: _process_attachment skips them
                # with a debug log, as it does when merging is off.
                binaries.append((attachment_index, attachment))

        blocks: List[str] = []
        downloaded: Dict[int, bytes] = {}
        for attachment_index, attachment in text_like:
            block, binary_data = await self._folded_text_attachment(attachment, processing_errors)
            if block:
                blocks.append(block)
            elif binary_data is not None:
                # Binary content after all: its own lane object, as it is with
                # merging off, instead of being dropped.
                binaries.append((attachment_index, attachment))
                downloaded[attachment_index] = binary_data
        binaries.sort(key=lambda item: item[0])
        eligible_binaries = [item for item in binaries if item[1] in eligible_attachments]

        # groupSize has to be on the objects pushed below, before the text pass
        # has happened: anything foldable means a text pass is coming. The one
        # case that can still fall through (no text, no text file, and no
        # attachment answered) leaves the count one high on objects already
        # pushed, and behaves as it did before otherwise.
        question = self._question_text(message)
        text_pass = bool(question or blocks or eligible_binaries)
        group_size = (1 if text_pass else 0) + len(eligible_binaries)
        group_index = 1 if text_pass else 0
        first_answer = ''
        for attachment_index, attachment in binaries:
            attachment_meta = dict(metadata, groupIndex=group_index, groupSize=group_size)
            if attachment in eligible_attachments:
                group_index += 1
            att_reply = self._answer_text(
                await self._process_attachment(
                    message,
                    attachment,
                    attachment_meta,
                    attachment_index,
                    file_data=downloaded.get(attachment_index),
                )
            )
            if attachment_meta.get('_pipelineError'):
                processing_errors.append(attachment_meta.pop('_pipelineError'))
            if not att_reply:
                continue
            if not first_answer:
                first_answer = att_reply
            kind = attachment_kind(guess_media_type(attachment.filename, attachment.content_type or ''))
            blocks.append(fold_binary_answer(kind, attachment.filename, att_reply))

        if not question and not blocks:
            return first_answer

        text_meta = dict(metadata, groupIndex=0, groupSize=group_size)
        pipeline_text = compose_merged_question(question, blocks)
        text_reply = await self._run_with_optional_typing(
            message,
            lambda: asyncio.to_thread(
                self._run_text_pipeline,
                pipeline_text,
                message.channel.id,
                message.id,
                text_meta,
                sse_text=question or pipeline_text,
            ),
        )
        if text_meta.get('_pipelineError'):
            processing_errors.append(text_meta.pop('_pipelineError'))
        return self._answer_text(text_reply) or first_answer

    def _is_text_attachment(self, attachment: discord.Attachment) -> bool:
        """Whether this attachment is decoded as text instead of routed as binary.

        Args:
            attachment (discord.Attachment): The attachment to classify.

        Returns:
            bool: True for a ``text/*`` MIME type or a configured extension,
                and only when ``textAttachmentExtensions`` is configured: with
                the list empty (the default) every attachment is routed as
                binary, as before the setting existed.
        """
        extensions = getattr(self, '_text_attachment_extensions', [])
        if not extensions:
            return False
        mime_type = guess_media_type(attachment.filename, attachment.content_type or '')
        extension = os.path.splitext(attachment.filename)[1].lower()
        return mime_type.startswith('text/') or extension in extensions

    async def _folded_text_attachment(
        self, attachment: discord.Attachment, processing_errors: List[str]
    ) -> Tuple[str, Optional[bytes]]:
        """Download one text-like attachment and render it for the question.

        The caller has already applied the size cap; this applies the character
        cap and hands back a file that turns out to hold binary content, so it
        can be routed like any other binary attachment.

        Args:
            attachment (discord.Attachment): A text-like attachment.
            processing_errors (List[str]): Collects a failed download's error.

        Returns:
            Tuple[str, Optional[bytes]]: The block to fold in ('' when there
                is none), and the downloaded bytes when the file is binary
                content (else None).
        """
        try:
            file_data = await attachment.read()
        except Exception as e:
            debug(f'Discord: attachment {attachment.filename} error: {e}')
            processing_errors.append(str(e))
            return '', None
        if not file_data:
            return '', None
        decoded = decode_text_attachment(file_data)
        if decoded is None:
            debug(f'Discord: attachment {attachment.filename} holds binary content; routing it as binary')
            return '', file_data
        block = fold_text_attachment(attachment.filename, decoded, getattr(self, '_text_attachment_max_chars', 12000))
        return block, None

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

    async def _process_attachment(
        self,
        message: discord.Message,
        attachment: discord.Attachment,
        meta: Optional[Dict[str, Any]] = None,
        attachment_index: int = 0,
        file_data: Optional[bytes] = None,
    ) -> str:
        """Download one attachment and route it to the matching lane.

        Args:
            message (discord.Message): The parent message (for entry URL).
            attachment (discord.Attachment): The attachment to download.
            file_data (Optional[bytes]): The bytes, when the caller already
                downloaded them; not fetched again.

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
            if file_data is None:
                file_data = await attachment.read()
            if not file_data:
                return ''
            if meta is None:
                meta = self._message_metadata(message)
            # Same decode and cap as the merged path; a file with a NUL byte
            # is binary content and goes down the binary path below.
            decoded = decode_text_attachment(file_data) if self._is_text_attachment(attachment) else None
            if decoded is not None:
                decoded = clip_attachment_text(decoded, getattr(self, '_text_attachment_max_chars', 12000))
                framed = f'[attachment {attachment.filename}]\n{decoded}'
                return await self._run_with_optional_typing(
                    message,
                    lambda: asyncio.to_thread(
                        self._run_text_pipeline,
                        framed,
                        message.channel.id,
                        message.id,
                        meta,
                        f'{message.id}:{attachment_index}',
                        attachment.id,
                    ),
                )
            return await self._run_with_optional_typing(
                message,
                lambda: asyncio.to_thread(
                    self._run_binary_pipeline,
                    file_data,
                    mime_type,
                    attachment.id,
                    message.channel.id,
                    message.id,
                    attachment_index,
                    meta,
                ),
            )
        except Exception as e:
            debug(f'Discord: attachment {attachment.filename} error: {e}')
            if meta is not None:
                meta['_pipelineError'] = str(e)
            return ''

    # -------------------------------------------------------------------------
    # Pipeline execution
    # -------------------------------------------------------------------------

    @staticmethod
    def _send_metadata(pipe, metadata: Dict[str, Any]):
        """Attach per-object metadata via the pipe's ``sendTagMetadata``.

        ``sendTagMetadata`` is the engine's contract API for attaching a
        metadata dict to the object flowing through the pipe (see
        ``IServiceFilterPipe``); it does not touch the entry's url/name. Called
        best-effort so a pipe implementation without it never breaks ingestion.
        """
        try:
            pipe.sendTagMetadata(metadata)
        except Exception as e:
            debug(f'Discord: sendTagMetadata failed: {e}')

    @staticmethod
    def _send_sse(pipe, event_type: str, metadata: Dict[str, Any], payload: Dict[str, Any]):
        """Broadcast the object as a real-time ``apaevt_sse`` event of type ``discord``.

        Lets a UI (for example a dashboard app) follow questions,
        answers, no-reply outcomes and reactions live. Pipeline traces never
        carry tag-lane data or tag metadata, so SSE is the only channel that
        exposes the node's metadata contract to a subscriber. Best-effort: a
        missing ``rocketlib.engine`` (unit tests) or pipe id never breaks
        ingestion.
        """
        try:
            from rocketlib.engine import monitorSSE  # type: ignore  # engine-only module

            pipe_id = getattr(pipe, 'pipeId', None)
            if pipe_id is None:
                return
            monitorSSE(
                pipe_id,
                'discord',
                {'schemaVersion': 1, 'eventType': event_type, 'metadata': metadata, **payload},
            )
        except Exception as e:
            debug(f'Discord: monitorSSE failed: {e}')

    def _new_entry(self, obj: Dict[str, Any]):
        """Create an engine entry for a Discord object."""
        return getObject(obj=obj)

    def _run_text_pipeline(
        self,
        text: str,
        channel_id: int,
        message_id: int,
        meta: Dict[str, Any],
        object_name: Optional[str] = None,
        attachment_id: Optional[int] = None,
        sse_text: Optional[str] = None,
    ) -> str:
        """Push a text message through the pipeline on the text lane.

        Blocking; must be called via asyncio.to_thread.

        Args:
            text (str): The message text.
            channel_id (int): The originating channel id (entry URL).
            message_id (int): The originating message id (entry URL).
            sse_text (Optional[str]): Text to broadcast instead of ``text`` —
                the user's own message when attachments were folded in.

        Returns:
            str: The first pipeline answer, or '' on error / no answers.
        """
        suffix = f'/{attachment_id}' if attachment_id is not None else ''
        obj_meta = dict(meta, eventType='message')
        entry = self._new_entry(
            {
                'url': f'discord://{channel_id}/{message_id}{suffix}',
                'name': object_name or str(message_id),
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            self._send_metadata(pipe, obj_meta)
            broadcast_text = text if sse_text is None else sse_text
            payload: Dict[str, Any] = {'lane': 'text', 'text': broadcast_text[:2000]}
            self._send_sse(pipe, 'message', obj_meta, payload)
            pipe.writeText(text)
            pipe.close()
            results = entry.response.toDict()
            answers = results.get('answers', [])
            monitorCompleted(len(text.encode('utf-8')))
            return answers[0] if answers else ''
        except Exception as e:
            monitorFailed(len(text.encode('utf-8')))
            debug(f'Discord: text pipeline error: {e}')
            meta['_pipelineError'] = str(e)
            return ''
        finally:
            self.target.putPipe(pipe)

    def _run_binary_pipeline(
        self,
        file_data: bytes,
        mime_type: str,
        attachment_id: int,
        channel_id: int,
        message_id: int,
        attachment_index: int,
        meta: Dict[str, Any],
    ) -> str:
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
        obj_meta = dict(meta, eventType='message')
        entry = self._new_entry(
            {
                'url': f'discord://{channel_id}/{message_id}/{attachment_id}',
                'name': f'{message_id}:{attachment_index}',
                'size': len(file_data),
                'mimeType': mime_type,
            }
        )
        pipe = self.target.getPipe()
        try:
            pipe.open(entry)
            self._send_metadata(pipe, obj_meta)
            binary_payload = {'lane': 'binary', 'mimeType': mime_type, 'size': len(file_data)}
            self._send_sse(pipe, 'message', obj_meta, binary_payload)
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
            meta['_pipelineError'] = str(e)
            return ''
        finally:
            self.target.putPipe(pipe)

    def _emit_event_pipeline(self, metadata: Dict[str, Any], event_type: str, payload: Dict[str, Any]):
        """Emit a small tagged JSON event object without waiting for an answer."""
        event_meta = dict(metadata, eventType=event_type)
        message_id = event_meta.get('messageId') or event_meta.get('correlationId') or 'event'
        channel_id = event_meta.get('channelId') or 'unknown'
        entry = self._new_entry(
            {
                'url': f'discord://{channel_id}/{message_id}/{event_type}',
                'name': f'{message_id}:{event_type}',
            }
        )
        pipe = self.target.getPipe()
        data = json.dumps({'eventType': event_type, 'metadata': event_meta, **payload}).encode('utf-8')
        try:
            pipe.open(entry)
            self._send_metadata(pipe, event_meta)
            self._send_sse(pipe, event_type, event_meta, payload)
            pipe.writeTagBeginObject()
            pipe.writeTagBeginStream()
            pipe.writeTagData(data)
            pipe.writeTagEndStream()
            pipe.writeTagEndObject()
            pipe.close()
            monitorCompleted(len(data))
        except Exception as e:
            monitorFailed(len(data))
            debug(f'Discord: {event_type} event pipeline error: {e}')
        finally:
            self.target.putPipe(pipe)

    async def _emit_no_reply_event(self, metadata: Dict[str, Any], reason: str):
        """Emit one ``no_reply`` event.

        The reason is clipped to :data:`MAX_NO_REPLY_REASON_CHARS` here, at the
        one place every reason passes through: a reason built from an exception
        message is unbounded.

        Args:
            metadata (Dict[str, Any]): The message's metadata contract.
            reason (str): Why nothing was posted.
        """
        if not getattr(self, '_emit_no_reply', False):
            return
        payload: Dict[str, Any] = {'reason': str(reason)[:MAX_NO_REPLY_REASON_CHARS]}
        await asyncio.to_thread(self._emit_event_pipeline, metadata, 'no_reply', payload)

    async def _emit_outbound_event(
        self,
        message: discord.Message,
        metadata: Dict[str, Any],
        text: str,
        outbound: Optional[Dict[str, Any]],
    ):
        """Emit one ``outbound`` event for an answer, when emitOutbound is on.

        Args:
            message (discord.Message): The message the answer is for.
            metadata (Dict[str, Any]): The message's metadata contract.
            text (str): The answer text.
            outbound (Optional[Dict[str, Any]]): What ``_send_response``
                returned, or ``{'messageIds': [], 'destination': 'suppressed'}``
                when sendResponses is off; None falls back to no ids and the
                configured reply mode. A missing ``complete`` counts as True.

        Returns:
            None
        """
        if not getattr(self, '_emit_outbound', False):
            return
        details = outbound or {'messageIds': [], 'destination': self._reply_mode}
        payload: Dict[str, Any] = {
            'messageIds': details['messageIds'],
            'destination': details['destination'],
            'complete': bool(details.get('complete', True)),
            'text': text,
        }
        await asyncio.to_thread(
            self._emit_event_pipeline,
            dict(metadata, groupIndex=0, groupSize=1),
            'outbound',
            payload,
        )

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
            Dict[str, Any]: What was posted, with these keys:
                ``messageIds`` (List[str]): the ids of the posted messages, in
                order; empty when nothing was posted.
                ``destination`` (str): where the first chunk went (``reply``,
                ``thread`` or ``channel``), or the configured reply mode when
                nothing was posted.
                ``complete`` (bool): False when a chunk failed and the rest
                were abandoned, so Discord shows only part of the answer.
        """
        thread = None
        sent_ids: List[str] = []
        destinations: List[str] = []
        # Earlier chunks may already be on Discord when a later one fails, so
        # "some ids came back" is not "the whole answer was posted".
        complete = True
        # A blank chunk is not a message Discord accepts; zero chunks left is
        # nothing to send, not a failed send.
        chunks = [
            chunk
            for chunk in chunk_message(response, number=bool(getattr(self, '_number_chunks', False)))
            if chunk.strip()
        ]
        for chunk in chunks:
            try:
                thread = await self._send_chunk(message, chunk, thread, sent_ids, destinations)
            except discord.RateLimited as e:
                # discord.py handles 429s internally (honoring Retry-After) and
                # only surfaces RateLimited when the client sets
                # max_ratelimit_timeout, which we do not — this is defensive:
                # retry once after the reported delay if it is ever raised.
                debug(f'Discord: rate limited; retrying after {e.retry_after}s')
                await asyncio.sleep(float(e.retry_after))
                try:
                    thread = await self._send_chunk(message, chunk, thread, sent_ids, destinations)
                except Exception as e2:
                    debug(f'Discord: send retry failed, abandoning remaining chunks: {e2}')
                    complete = False
                    break
            except Exception as e:
                debug(f'Discord: send failed, abandoning remaining chunks: {e}')
                complete = False
                break
        destination = destinations[0] if destinations else self._reply_mode
        return {'messageIds': sent_ids, 'destination': destination, 'complete': complete}

    def _allowed_mentions(self):
        """Build the outbound mention allowlist; never permit everyone/here."""
        role_ids = getattr(self, '_allowed_mention_role_ids', [])
        user_ids = getattr(self, '_allowed_mention_user_ids', [])
        if not role_ids and not user_ids:
            return discord.AllowedMentions.none()
        return discord.AllowedMentions(
            everyone=False,
            users=[discord.Object(id=int(user_id)) for user_id in user_ids],
            roles=[discord.Object(id=int(role_id)) for role_id in role_ids],
        )

    def _thread_name_for(self, message: discord.Message) -> str:
        """Resolve the response thread's name from the configured template.

        ``{content}`` is the triggering message's text; a message that carries
        only files has none, so the first attachment's filename stands in for
        it (the support bot's ``text || firstAttachment.name || 'Support'``).
        The resolved name is capped by ``threadNameMaxLength``, and the node's
        own default is used when nothing is left.

        Args:
            message (discord.Message): The triggering message.

        Returns:
            str: The thread name to create.
        """
        content = message.content if isinstance(message.content, str) else str(message.content or '')
        if not content.strip():
            attachments = getattr(message, 'attachments', None) or []
            if attachments:
                content = str(getattr(attachments[0], 'filename', '') or '')
        thread_name = getattr(self, '_thread_name', 'Pipeline Response').replace('{content}', content)
        thread_name = thread_name[: getattr(self, '_thread_name_max_length', 90)].strip()
        return thread_name or 'Pipeline Response'

    @staticmethod
    def _record_sent(
        sent,
        destination: str,
        sent_ids: Optional[List[str]],
        destinations: Optional[List[str]],
    ):
        """Record one posted chunk in the caller's collectors.

        Args:
            sent: The message Discord returned for the chunk; its id is kept
                when it has one.
            destination (str): Where the chunk went (``reply``, ``thread`` or
                ``channel``).
            sent_ids (Optional[List[str]]): Collects posted message ids; None
                to skip.
            destinations (Optional[List[str]]): Collects the destination of
                every chunk; None to skip.

        Returns:
            None
        """
        if sent_ids is not None and sent is not None and getattr(sent, 'id', None) is not None:
            sent_ids.append(str(sent.id))
        if destinations is not None:
            destinations.append(destination)

    async def _send_chunk(
        self,
        message: discord.Message,
        chunk: str,
        thread,
        sent_ids: Optional[List[str]] = None,
        destinations: Optional[List[str]] = None,
    ):
        """Send a single chunk using the configured reply mode.

        Args:
            message (discord.Message): The originating message.
            chunk (str): The chunk text (already within the char limit).
            thread: The thread created for a prior chunk, or None.
            sent_ids: Collects the posted message ids.
            destinations: Collects the destination used per chunk.

        Returns:
            The thread used (for 'thread' mode) so later chunks reuse it, else None.
        """
        # Outbound content is model-generated: by default all mentions are
        # suppressed. Only the explicitly configured allowedMentionRoleIds /
        # allowedMentionUserIds may ping; @everyone/@here are never allowed.
        allowed_mentions = self._allowed_mentions()

        if self._reply_mode == 'reply':
            sent = await message.reply(chunk, mention_author=False, allowed_mentions=allowed_mentions)
            self._record_sent(sent, 'reply', sent_ids, destinations)
            return None

        if self._reply_mode == 'thread':
            if thread is None:
                channel = message.channel
                if isinstance(channel, discord.Thread):
                    # The message already lives in a thread: post into it
                    # rather than trying to create a nested one (which fails).
                    thread = channel
                elif isinstance(channel, discord.TextChannel):
                    # Discord accepts exactly four durations. No duration
                    # configured (0) — or any value Discord would reject, which
                    # would 400 and cost the whole answer — leaves it to the
                    # channel's own default, as discord.py does when the
                    # argument is absent.
                    thread_kwargs: Dict[str, Any] = {'name': self._thread_name_for(message)}
                    archive_minutes = self._as_int(getattr(self, '_thread_auto_archive_minutes', 0), 0)
                    if archive_minutes in THREAD_ARCHIVE_DURATIONS:
                        thread_kwargs['auto_archive_duration'] = archive_minutes
                    elif archive_minutes:
                        debug(
                            f'Discord: threadAutoArchiveMinutes={archive_minutes} is not one of '
                            f'{", ".join(str(value) for value in THREAD_ARCHIVE_DURATIONS)}; '
                            f"using the channel's default"
                        )
                    try:
                        thread = await message.create_thread(**thread_kwargs)
                    except Exception as e:
                        # Usually a missing "Create Public Threads" /
                        # "Send Messages in Threads": reply in the channel
                        # instead of losing the whole answer.
                        debug(f'Discord: create_thread failed, replying in the channel instead: {e}')
                        thread = _THREAD_FALLBACK
                else:
                    # DMs and other non-threadable channels cannot host a
                    # thread; fall back to a plain reply.
                    sent = await message.reply(chunk, mention_author=False, allowed_mentions=allowed_mentions)
                    self._record_sent(sent, 'reply', sent_ids, destinations)
                    return None
            if thread is _THREAD_FALLBACK:
                sent = await message.reply(chunk, mention_author=False, allowed_mentions=allowed_mentions)
                self._record_sent(sent, 'reply', sent_ids, destinations)
                return _THREAD_FALLBACK
            sent = await thread.send(chunk, allowed_mentions=allowed_mentions)
            self._record_sent(sent, 'thread', sent_ids, destinations)
            return thread

        sent = await message.channel.send(chunk, allowed_mentions=allowed_mentions)
        self._record_sent(sent, 'channel', sent_ids, destinations)
        return None
