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
import collections
import concurrent.futures
import contextlib
import contextvars
import functools
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

from ai.common.utils import parse_bool

from .text_utils import (
    attachment_kind,
    contains_alias,
    chunk_message,
    clip_attachment_text,
    compose_merged_question,
    decode_text_attachment,
    find_marker,
    fold_binary_answer,
    fold_text_attachment,
    format_thread_transcript,
    guess_media_type,
    inject_role_mention,
    is_aimed_at_someone_else,
    looks_like_error,
    sanitize_reply,
    should_process_message,
    with_thread_context,
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

# How many handled message ids are remembered. Shared by the live path and
# backfill, so a message seen by both (or redelivered) is processed once;
# bounded so a long-running bot does not grow it forever.
HANDLED_MESSAGE_IDS_LIMIT = 1000

# At most one injected team-role ping per conversation (a thread, or a
# channel outside threads) in this many seconds. Any user who gets the model to
# write the alias makes the bot ping the role, so repeats within the window
# are posted with the alias as plain text. In memory only: a restart forgets it.
TEAM_PING_COOLDOWN_SECONDS = 3600


def _monotonic() -> float:
    """``time.monotonic``, behind a name tests can patch without touching asyncio's clock."""
    return time.monotonic()


# Pipeline runs get their own bounded pool (and a semaphore of the same size),
# so runs that hang cannot take the loop's default pool, which event emits use.
PIPELINE_WORKERS = 8


class PipelineTimeout(Exception):
    """A pipeline run took longer than ``pipelineTimeoutSeconds``."""


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


# A Discord id is plain ASCII digits. ``str.isdigit`` is not enough: it accepts
# '²', which ``int()`` then rejects. A snowflake is a 64-bit integer, so at most
# 20 digits: two ids pasted together are not one.
_NUMERIC_ID = re.compile(r'[0-9]{1,20}')

# Messages about a list entry show at most this many of its characters. The
# entry may be a bot token or a secret ${ROCKETRIDE_*} value pasted by mistake,
# and the message reaches the task status, the start error and the logs.
_SHOWN_ENTRY_CHARS = 12

# A channel, role or user mention pasted where its id belongs.
_MENTION_WRAPPER = re.compile(r'<(#|@&|@!?)([0-9]{1,20})>')
_MENTION_KIND = {'#': 'channel', '@&': 'role', '@': 'user', '@!': 'user'}

# What each list holds, as a mention kind; a server has no mention form.
_LIST_ID_KIND = {
    'guildIds': ('server', None),
    'channelIds': ('channel', 'channel'),
    'requireMentionChannelIds': ('channel', 'channel'),
    'allowedBotIds': ('bot user', 'user'),
}


def _is_numeric_id(item: str) -> bool:
    """Whether a list entry is an id Discord could have issued (ASCII digits, 64-bit)."""
    return _NUMERIC_ID.fullmatch(item) is not None and int(item) < 2**64


def _shown_entry(item: str) -> str:
    """Quote a list entry for a message without ever echoing a secret in full.

    Args:
        item (str): The entry.

    Returns:
        str: The quoted entry, whole when it is a mention (``<#123>``) or at
            most ``_SHOWN_ENTRY_CHARS`` long, else its first
            ``_SHOWN_ENTRY_CHARS`` characters followed by ``…``.
    """
    if len(item) <= _SHOWN_ENTRY_CHARS or _MENTION_WRAPPER.fullmatch(item):
        return repr(item)
    return repr(item[:_SHOWN_ENTRY_CHARS] + '…')


def _non_numeric_id(field: str, item: str) -> str:
    """Name a list entry that is not a numeric id, with a hint at the fix.

    Args:
        field (str): The setting's name.
        item (str): The offending entry.

    Returns:
        str: For example ``channelIds has '<#123>', which is not a numeric
            Discord id; use 123, the id inside the mention``. A mention of
            another kind (a role in a channel list, anything in the server
            list) never suggests its digits: they are the id of something else.
    """
    noun, mention_kind = _LIST_ID_KIND.get(field, ('', None))
    wrapped = _MENTION_WRAPPER.fullmatch(item)
    if wrapped is None:
        hint = 'use the numeric id'
    else:
        kind = _MENTION_KIND[wrapped.group(1)]
        if kind == mention_kind:
            hint = f'use {wrapped.group(2)}, the id inside the mention'
        else:
            target = f'a {noun} id' if noun else 'an id'
            hint = f'that is a {kind} mention, not {target}; use the numeric id'
    return f'{field} has {_shown_entry(item)}, which is not a numeric Discord id; {hint}'


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

    Args:
        value (Any): The raw config value of a list setting.

    Returns:
        int: The number of items given, blank ones included.
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
    _backfill_limit: int = 0
    # Support-bot parity behaviors; all off by default so the node stays generic.
    _thread_history_limit: int = 0
    _thread_history_max_chars: int = 6000
    _escalation_pause: bool = False
    _escalation_markers: List[str]
    _team_mention_alias: str = ''
    _ignore_aimed_at_others: bool = False
    _ack_emoji: str = ''
    _feedback_reactions: bool = False
    _feedback_emojis: List[str]
    _sanitize_replies: bool = False
    _non_answer_retries: int = 1
    _pipeline_timeout_seconds: float = 0
    _config_error: Optional[str] = None
    # Escalation-pause state for this process: threads gone quiet until the bot
    # is @mentioned again, and threads whose state was already reconciled with
    # Discord history. Per-instance (created in _pause_state / _startup).
    _paused_threads: set
    _resolved_threads: set
    # thread id -> [asyncio.Lock, borrowers]; only populated while
    # ``escalationPause`` is on. Created on demand by _thread_lock.
    _thread_locks: Dict[str, List[Any]]
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
                        f'Discord: {field or "a list setting"} is not valid JSON ({_shown_entry(text)}); '
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

        Any other entry that is not plain ASCII digits (a pasted ``<#123>``,
        a channel or server name) matches nothing in the same way, so it
        fails the start too, naming the entry.

        Args:
            config (Dict[str, Any]): The Discord config block.

        Returns:
            Optional[str]: The error to fail the start with, or None.
        """
        for field in ('guildIds', 'channelIds', 'requireMentionChannelIds'):
            value = config.get(field)
            text = _broken_json_text(value)
            if text is not None:
                return f'Discord Bot: {field} is not valid JSON ({_shown_entry(text)}); fix the setting'
            ids = cls._as_str_list(value, field=field)
            for item in ids:
                problem = _unresolved_variable(item)
                if problem:
                    return f'Discord Bot: {field} uses {problem}'
                if not _is_numeric_id(item):
                    return f'Discord Bot: {_non_numeric_id(field, item)}'
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
        except (TypeError, ValueError, OverflowError):
            # OverflowError: 'inf' and '1e400' parse as floats no int holds.
            return default

    @classmethod
    def _snowflake_ids(cls, value: Any, field: str) -> List[str]:
        """Coerce an id allowlist, keeping only ids Discord could have issued.

        ``_allowed_mentions`` turns every entry into ``int(...)``, and that
        call sits inside the per-chunk send: one non-numeric entry (a role
        name, a pasted ``<@&123>``) raised for every chunk of every answer, so
        a single typo silenced the bot completely. Bad entries (anything but
        plain ASCII digits) are dropped with a debug line instead.

        Args:
            value (Any): The raw config value.
            field (str): Field name, for the debug line.

        Returns:
            List[str]: The digit-only ids, in configured order.
        """
        ids: List[str] = []
        for item in cls._as_str_list(value, field=field):
            if _is_numeric_id(item):
                ids.append(item)
                continue
            problem = _unresolved_variable(item)
            if problem:
                # Dropped like any non-numeric entry, but an operator has to
                # hear about it: the mention it was meant to allow never pings.
                _config_warning(f'Discord: {field} uses {problem}; the entry is ignored')
            else:
                debug(f'Discord: ignoring {field} entry {_shown_entry(item)} - not a numeric Discord id')
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
            elif not _is_numeric_id(item):
                _config_warning(f'Discord: {_non_numeric_id("allowedBotIds", item)}; the entry matches no bot')
        self._config_error = self._list_config_error(config)
        # Mention allowlists are the one config the outbound path cannot
        # tolerate garbage in, so a non-numeric entry is dropped here.
        self._allowed_mention_role_ids = self._snowflake_ids(
            config.get('allowedMentionRoleIds'), 'allowedMentionRoleIds'
        )
        self._allowed_mention_user_ids = self._snowflake_ids(
            config.get('allowedMentionUserIds'), 'allowedMentionUserIds'
        )
        self._ignore_bots = parse_bool(config.get('ignoreBots'), True)
        self._require_mention = parse_bool(config.get('requireMention'), False)
        # Engine-provided strings may be proxies; this one is compared to
        # literals and the numbers below are used where only an int works.
        self._reply_mode = str(config.get('replyMode') or 'reply')
        self._show_typing = parse_bool(config.get('showTyping'), True)
        # Zero or below would skip every attachment with only a debug line, so
        # it means "not set" and the default applies, as in ``config_int``.
        max_attachment_bytes = self._as_int(config.get('maxAttachmentBytes'), 26214400)
        if max_attachment_bytes <= 0:
            max_attachment_bytes = 26214400
        self._max_attachment_bytes = min(MAX_ATTACHMENT_BYTES, max_attachment_bytes)
        self._max_concurrent_messages = max(
            1, min(MAX_CONCURRENT_MESSAGES, self._as_int(config.get('maxConcurrentMessages'), 4))
        )
        self._send_responses = parse_bool(config.get('sendResponses'), True)
        self._thread_name = str(config.get('threadName') or 'Pipeline Response')
        self._thread_name_max_length = max(
            1, min(THREAD_NAME_MAX_CHARS, self._as_int(config.get('threadNameMaxLength'), 90))
        )
        self._thread_auto_archive_minutes = self._as_int(config.get('threadAutoArchiveMinutes'), 0)
        self._number_chunks = parse_bool(config.get('numberChunks'), False)
        # Compared with os.path.splitext, which keeps the dot: 'md' and '.md'
        # both have to match a.md.
        self._text_attachment_extensions = [
            '.' + extension.lower()
            for extension in (
                value.strip().lstrip('.')
                for value in self._as_str_list(
                    config.get('textAttachmentExtensions', []), field='textAttachmentExtensions'
                )
            )
            if extension
        ]
        self._text_attachment_max_chars = self._as_int(config.get('textAttachmentMaxChars'), 12000)
        self._merge_attachments = parse_bool(config.get('mergeAttachments'), False)
        self._emit_reactions = parse_bool(config.get('emitReactions'), False)
        self._emit_no_reply = parse_bool(config.get('emitNoReply'), False)
        self._emit_outbound = parse_bool(config.get('emitOutbound'), False)
        self._include_member_metadata = parse_bool(config.get('includeMemberMetadata'), False)
        # Zero (the default) turns each of these off, so a negative value
        # means the same.
        self._backfill_limit = max(0, self._as_int(config.get('backfillLimit'), 0))
        self._thread_history_limit = max(0, self._as_int(config.get('threadHistoryLimit'), 0))
        self._thread_history_max_chars = max(0, self._as_int(config.get('threadHistoryMaxChars'), 6000))
        self._escalation_pause = parse_bool(config.get('escalationPause'), False)
        self._escalation_markers = self._as_str_list(
            config.get('escalationMarkers'), field='escalationMarkers', split=False
        )
        # Engine-provided strings may be proxies; this one becomes a regex.
        self._team_mention_alias = str(config.get('teamMentionAlias', '') or '')
        self._ignore_aimed_at_others = parse_bool(config.get('ignoreAimedAtOthers'), False)
        # Engine-provided strings may be proxies; discord.py needs a real str.
        self._ack_emoji = str(config.get('ackEmoji', '') or '')
        self._feedback_reactions = parse_bool(config.get('feedbackReactions'), False)
        self._feedback_emojis = self._as_str_list(
            config.get('feedbackEmojis', ['✅', '❌']), field='feedbackEmojis', split=False
        )
        self._sanitize_replies = parse_bool(config.get('sanitizeReplies'), False)
        # Clamped to the schema's 0..3; a malformed value falls back to the default.
        # _as_int, not int(): engine number proxies are string-like with no __int__.
        self._non_answer_retries = max(0, min(3, self._as_int(config.get('nonAnswerRetries'), 1)))
        # Off (0) unless set: a pipeline is otherwise waited for as long as it takes.
        try:
            self._pipeline_timeout_seconds = max(0.0, float(str(config.get('pipelineTimeoutSeconds') or 0)))
        except (TypeError, ValueError):
            self._pipeline_timeout_seconds = 0
        self._paused_threads = set()
        self._resolved_threads = set()
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
        self._backfill_done = False
        self._handled_message_ids = collections.OrderedDict()
        self._pipeline_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=PIPELINE_WORKERS, thread_name_prefix='discord-pipeline'
        )
        self._pipeline_slots = asyncio.Semaphore(PIPELINE_WORKERS)
        self._pause_state()

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
            if self._backfill_limit > 0 and not getattr(self, '_backfill_done', False):
                self._backfill_done = True
                await self._run_backfill()

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

        # Without waiting: a hung run would otherwise hold up the shutdown.
        executor = getattr(self, '_pipeline_executor', None)
        if executor is not None:
            executor.shutdown(wait=False)
            self._pipeline_executor = None

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
            wait (bool): Await the processing task before returning instead
                of leaving it to run in the background (used by tests).

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
            if not self._mark_handled(message.id):
                return

            task = asyncio.create_task(self._process_serialized(message))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)
            if wait:
                await task
        except Exception as e:
            debug(f'Discord _on_message: EXCEPTION {e}')

    def _mark_handled(self, message_id: Any) -> bool:
        """Remember a message id; False when it was already handled.

        Keeps only the most recent :data:`HANDLED_MESSAGE_IDS_LIMIT` ids.

        Args:
            message_id (Any): The Discord message id.

        Returns:
            bool: True the first time an id is seen, False after that.
        """
        handled = getattr(self, '_handled_message_ids', None)
        if handled is None:
            handled = self._handled_message_ids = collections.OrderedDict()
        key = str(message_id)
        if key in handled:
            return False
        handled[key] = True
        while len(handled) > HANDLED_MESSAGE_IDS_LIMIT:
            handled.popitem(last=False)
        return True

    def _thread_lock(self, thread_id: str) -> asyncio.Lock:
        """Borrow the serialization lock for one thread, creating it on demand.

        Each entry is ``[lock, holders]``; the count is what lets the lock be
        dropped exactly when nothing holds or waits on it (``Lock.locked()``
        is already False while a waiter is still being woken, so it cannot
        answer that on its own).

        Args:
            thread_id (str): The thread the caller is about to process in.

        Returns:
            asyncio.Lock: The lock to hold; release it with
                :meth:`_release_thread_lock`.
        """
        locks = getattr(self, '_thread_locks', None)
        if locks is None:
            locks = self._thread_locks = {}
        entry = locks.get(thread_id)
        if entry is None:
            entry = locks[thread_id] = [asyncio.Lock(), 0]
        entry[1] += 1
        return entry[0]

    def _release_thread_lock(self, thread_id: str):
        """Give back a borrowed lock, forgetting the thread once it is idle."""
        locks = getattr(self, '_thread_locks', None) or {}
        entry = locks.get(thread_id)
        if entry is None:
            return
        entry[1] -= 1
        if entry[1] <= 0:
            locks.pop(thread_id, None)

    async def _process_serialized(self, message: discord.Message):
        """Process one message, one at a time per thread when the pause is on.

        ``escalationPause`` pauses a thread only once the escalating answer has
        been posted. A follow-up that arrived while that answer was still being
        produced therefore checked a pause that did not exist yet and was
        answered as well — exactly the second answer the pause exists to
        prevent. Holding a per-thread lock across the whole handler makes the
        follow-up see the pause.

        Only threads, and only with ``escalationPause`` on: with it off (the
        default) nothing is serialized and processing stays as concurrent as it
        was.

        Args:
            message (discord.Message): The message to process.

        Returns:
            None
        """
        channel = getattr(message, 'channel', None)
        if not getattr(self, '_escalation_pause', False) or not isinstance(channel, discord.Thread):
            await self._process_message(message)
            return

        thread_id = str(channel.id)
        lock = self._thread_lock(thread_id)
        try:
            async with lock:
                await self._process_message(message)
        finally:
            self._release_thread_lock(thread_id)

    async def _run_backfill(self):
        """Process the most recent configured messages, oldest first."""
        try:
            channels = []
            if self._channel_ids:
                for channel_id in self._channel_ids:
                    channel = self._bot.get_channel(int(channel_id))
                    if channel is not None:
                        channels.append(channel)
            else:
                # Every visible text channel, but only in allowed guilds: the
                # gate would drop the rest anyway, after their history was read.
                guild_ids = getattr(self, '_guild_ids', []) or []
                channels = [
                    channel
                    for channel in self._bot.get_all_channels()
                    if isinstance(channel, discord.TextChannel)
                    and (not guild_ids or str(getattr(getattr(channel, 'guild', None), 'id', None)) in guild_ids)
                ]
        except Exception as e:
            debug(f'Discord backfill error: {e}')
            return

        for channel in channels:
            # Per channel: one the bot cannot read history in (a missing
            # permission on a single channel is common) must not silently
            # cancel the backfill for every channel after it.
            try:
                messages = [message async for message in channel.history(limit=self._backfill_limit)]
                answered = self._answered_in_history(messages)
                for message in reversed(messages):
                    if str(getattr(message, 'id', None)) in answered:
                        continue
                    await self._on_message(message, wait=True)
            except Exception as e:
                debug(f'Discord backfill: skipping channel {getattr(channel, "id", "?")}: {e}')

    def _answered_in_history(self, messages: List[Any]) -> set:
        """Ids in a fetched backfill window that the bot already answered.

        Uses only the window backfill fetched (newest first), so no extra API
        call is made per message. A message counts as answered when it has a
        thread (thread mode), when a bot message in the window replies to it,
        or, in channel mode, when the bot posted in the channel after it.

        Args:
            messages (List[Any]): The channel history, newest first.

        Returns:
            set: The ids (as strings) to skip.
        """
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        bot_id = getattr(bot_user, 'id', None)
        reply_mode = getattr(self, '_reply_mode', 'reply')
        answered = set()
        seen_bot_post = False
        for message in messages:
            author_id = getattr(getattr(message, 'author', None), 'id', None)
            is_bot = bot_id is not None and author_id == bot_id
            if is_bot:
                reference = getattr(message, 'reference', None)
                replied_to = getattr(reference, 'message_id', None)
                if replied_to is not None:
                    answered.add(str(replied_to))
            if reply_mode == 'channel' and seen_bot_post:
                answered.add(str(getattr(message, 'id', None)))
            if reply_mode == 'thread' and getattr(message, 'thread', None) is not None:
                answered.add(str(getattr(message, 'id', None)))
            seen_bot_post = seen_bot_post or is_bot
        return answered

    @staticmethod
    def _question_text(message: discord.Message) -> str:
        """The message's own text, or '' when it is only whitespace.

        The intake gate strips the text to decide whether a message has
        anything to ask; processing must see the same answer, or blank text
        next to a file runs a text pass of its own.

        Args:
            message (discord.Message): The incoming message.

        Returns:
            str: The message text, or '' when it is empty or only whitespace.
        """
        content = message.content if isinstance(message.content, str) else str(message.content or '')
        return content if content.strip() else ''

    @staticmethod
    def _answer_text(answer: Any) -> str:
        """A pipeline answer, or '' when it is only whitespace.

        Answers are chosen by truthiness, so a blank one (``'\\n'``) would
        otherwise win over a real answer from a later lane.

        Args:
            answer (Any): One pipeline answer.

        Returns:
            str: The answer text, or '' when it is empty or only whitespace.
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
        """Emit one raw reaction event when reaction capture is enabled.

        Args:
            payload: The raw reaction payload.
            added (bool): True for an add, False for a remove.

        Returns:
            None
        """
        if not getattr(self, '_emit_reactions', False):
            return
        # The Gateway keeps delivering reactions while _shutdown waits for
        # in-flight messages; an emit started now would outlive the pipeline.
        if getattr(self, '_closing', False):
            return
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        # The node's own feedback reactions (feedbackReactions adds ✅/❌ to every
        # answer it posts) are affordances, not feedback: emitting them would have
        # a subscriber count a user grade on every answer before anyone reacted.
        if bot_user is not None and str(payload.user_id) == str(getattr(bot_user, 'id', None)):
            return
        member = getattr(payload, 'member', None)
        channel = self._bot.get_channel(payload.channel_id) if self._bot is not None else None
        is_thread = isinstance(channel, discord.Thread)
        # Used for the gate and the emitted metadata alike: ``payload.member``
        # is None on a removal, so it alone would call every bot a human.
        reactor_is_bot = self._reactor_is_bot(payload, added)

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
            author_is_bot=reactor_is_bot,
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
            'authorIsBot': reactor_is_bot,
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
        # Tracked like a message handler, so _shutdown waits for an emit that is
        # already under way instead of tearing the endpoint down beneath it.
        emit = asyncio.ensure_future(
            asyncio.to_thread(
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
        )
        inflight = getattr(self, '_inflight', None)
        if inflight is not None:
            inflight.add(emit)
            emit.add_done_callback(inflight.discard)
        await emit

    # -------------------------------------------------------------------------
    # Support-bot parity behaviors (all opt-in)
    # -------------------------------------------------------------------------

    def _pause_state(self):
        """Return the (paused, resolved) thread-id sets, creating them on demand.

        Created lazily so the sets exist however the endpoint was brought up
        (``_run`` / ``_startup`` in production, direct construction in tests).

        Returns:
            tuple: ``(paused_thread_ids, resolved_thread_ids)`` as str sets.
        """
        if getattr(self, '_paused_threads', None) is None:
            self._paused_threads = set()
        if getattr(self, '_resolved_threads', None) is None:
            self._resolved_threads = set()
        return self._paused_threads, self._resolved_threads

    def _effective_markers(self) -> List[str]:
        """The escalation markers that count for pausing and sanitizing.

        The configured ``escalationMarkers`` plus a role mention for every id in
        ``allowedMentionRoleIds`` — a role the node is allowed to ping is by
        construction the team it escalates to (the support bot hardcodes exactly
        one such mention).

        Returns:
            List[str]: Markers in configured order, role mentions appended.
        """
        markers = list(getattr(self, '_escalation_markers', []) or [])
        for role_id in getattr(self, '_allowed_mention_role_ids', []) or []:
            marker = f'<@&{role_id}>'
            if marker not in markers:
                markers.append(marker)
        return markers

    def _handoff_alias(self) -> str:
        """The team alias, when there is a role to turn it into (else '')."""
        alias = getattr(self, '_team_mention_alias', '')
        role_ids = getattr(self, '_allowed_mention_role_ids', []) or []
        return alias if alias and role_ids else ''

    def _with_team_mention(self, text: str, conversation_id: Optional[str] = None) -> str:
        """Turn the configured team alias in an answer into a real role mention.

        Mirrors the support bot's ``injectRoleMention``. The agent is prompted
        to hand off to a literal team name, which Discord renders as plain text
        and pings nobody; the first id in ``allowedMentionRoleIds`` is the role
        the node may actually mention, so that is the one substituted.

        Any user who gets the model to write the alias makes the bot ping the
        role, so a conversation gets at most one injected ping per
        :data:`TEAM_PING_COOLDOWN_SECONDS`; within that window the alias is
        posted as plain text.

        Args:
            text (str): The answer about to be posted.
            conversation_id (Optional[str]): The thread or channel the answer
                belongs to, which the cooldown is kept per.

        Returns:
            str: The answer, unchanged unless the alias and an allowed role id
                are configured, the answer names the alias, and the
                conversation is not on cooldown.
        """
        alias = self._handoff_alias()
        if not text or not alias or not contains_alias(text, alias):
            return text
        pings = getattr(self, '_team_pings', None)
        if pings is None:
            pings = self._team_pings = {}
        now = _monotonic()
        for key in [key for key, pinged in pings.items() if now - pinged >= TEAM_PING_COOLDOWN_SECONDS]:
            del pings[key]
        if conversation_id is not None:
            if conversation_id in pings:
                debug(f'Discord: team ping on cooldown in {conversation_id}; the alias is posted as plain text')
                return text
            pings[conversation_id] = now
        role_ids = getattr(self, '_allowed_mention_role_ids', []) or []
        return inject_role_mention(text, alias, f'<@&{role_ids[0]}>')

    def _is_escalation(self, text: str) -> bool:
        """Whether a posted answer hands the conversation over.

        It carries an escalation marker, or the team alias left as plain text
        because the ping was on cooldown: the hand-off is just as real.
        """
        return bool(find_marker(text, self._effective_markers())) or contains_alias(text, self._handoff_alias())

    def _is_bot_mentioned(self, message: discord.Message) -> bool:
        """True when this bot is directly @mentioned (never @everyone/@here)."""
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        if bot_user is None:
            return False
        mentions = getattr(message, 'mentions', []) or []
        if not isinstance(mentions, (list, tuple)):
            return False
        return bot_user in mentions

    def _is_bot_named_in_text(self, message: discord.Message) -> bool:
        """True when the message text itself holds ``<@bot>`` / ``<@!bot>``.

        Discord's Reply (with its ping on, the default) adds the replied-to
        author to ``mentions`` without any mention in the text, so a plain reply
        to one of the bot's messages would count as a mention. Resuming a paused
        thread needs somebody to actually ask the bot back in, so it reads
        ``raw_mentions`` (the ids discord.py parses from the content) instead.
        """
        bot_user_id = getattr(getattr(getattr(self, '_bot', None), 'user', None), 'id', None)
        if bot_user_id is None:
            return False
        raw_mentions = getattr(message, 'raw_mentions', []) or []
        if not isinstance(raw_mentions, (list, tuple)):
            return False
        return bot_user_id in raw_mentions

    async def _paused_from_history(self, thread) -> Optional[bool]:
        """Reconstruct a thread's escalation pause from its recent history.

        Mirrors the support bot's ``isPausedFromHistory``: walk the last 50
        messages oldest first; a bot message carrying an escalation marker
        pauses, a later non-bot message whose text @mentions the bot resumes
        (a reply ping alone does not). Used the first time this process sees a
        thread, so a restart does not resume a conversation a human took over.

        Args:
            thread (discord.Thread): The thread to reconcile.

        Returns:
            Optional[bool]: True when the thread should be treated as paused,
                False when it should not, and None when the history could not
                be read — which is "unknown", not "not paused", so the caller
                must try again on the next message rather than fixing the
                thread as open for the rest of the process.
        """
        if not self._effective_markers() and not self._handoff_alias():
            return False
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        bot_user_id = getattr(bot_user, 'id', None)
        try:
            history = [item async for item in thread.history(limit=50)]
        except Exception as e:
            debug(f'Discord: pause-state history fetch failed: {e}')
            return None

        paused = False
        for item in reversed(history):  # Discord returns newest first
            author = getattr(item, 'author', None)
            if getattr(author, 'id', None) == bot_user_id:
                if self._is_escalation(getattr(item, 'content', '') or ''):
                    paused = True
            elif self._is_bot_named_in_text(item):
                paused = False
        return paused

    async def _thread_transcript(self, message: discord.Message) -> str:
        """Build the thread transcript handed to the pipeline as context.

        Mirrors the support bot's ``threadTranscript``: up to
        ``threadHistoryLimit`` prior messages, oldest first, excluding the
        current message, system messages, and empty content; capped at
        ``threadHistoryMaxChars``. Best-effort — a failed fetch means no context.

        The fetch is bounded by ``before=message`` so the limit counts
        ``threadHistoryLimit`` EARLIER messages: fetching the newest N included
        the message being answered, which left N-1 of context (and none at all
        at ``threadHistoryLimit=1``).

        Args:
            message (discord.Message): The message being processed (excluded).

        Returns:
            str: The transcript, or '' when there is nothing usable.
        """
        limit = getattr(self, '_thread_history_limit', 0)
        if limit <= 0:
            return ''
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        bot_user_id = getattr(bot_user, 'id', None)
        bot_name = getattr(bot_user, 'display_name', None) or getattr(bot_user, 'name', None) or 'assistant'
        try:
            history = [item async for item in message.channel.history(limit=limit, before=message)]
        except Exception as e:
            debug(f'Discord: thread history fetch failed: {e}')
            return ''

        starter_type = getattr(getattr(discord, 'MessageType', None), 'thread_starter_message', None)
        entries = []
        for item in reversed(history):  # Discord returns newest first
            # ``before`` already excludes it; kept as a harmless guard.
            if getattr(item, 'id', None) == message.id:
                continue
            if starter_type is not None and getattr(item, 'type', None) == starter_type:
                # A thread made from a message (``thread`` reply mode) opens
                # with an empty starter that only references that message, so
                # the question itself lives in the parent channel.
                item = await self._thread_starter(item, message.channel)
                if item is None:
                    continue
            is_system = getattr(item, 'is_system', None)
            if callable(is_system) and is_system():
                continue
            content = getattr(item, 'content', '') or ''
            if not content.strip():
                continue
            author = getattr(item, 'author', None)
            if getattr(author, 'id', None) == bot_user_id:
                name = bot_name
            else:
                name = getattr(author, 'name', None) or 'user'
            entries.append((str(name), str(content)))
        return format_thread_transcript(entries, getattr(self, '_thread_history_max_chars', 6000))

    @staticmethod
    async def _thread_starter(starter: Any, thread: Any) -> Any:
        """The parent-channel message a thread's starter message stands for.

        Tried in the order discord.py offers it: the referenced message sent
        along by the Gateway, discord.py's cache, then a fetch from the parent
        channel (a thread made from a message shares that message's id).

        Args:
            starter (Any): The ``thread_starter_message`` item.
            thread (Any): The thread it opens.

        Returns:
            Any: The original message, or None when it cannot be read (it is
                then left out of the transcript).
        """
        reference = getattr(starter, 'reference', None)
        for candidate in (getattr(reference, 'resolved', None), getattr(reference, 'cached_message', None)):
            if candidate is not None and getattr(candidate, 'author', None) is not None:
                return candidate
        try:
            return await thread.parent.fetch_message(thread.id)
        except Exception as e:
            debug(f'Discord: could not read the message thread {getattr(thread, "id", "?")} was started from: {e}')
            return None

    @staticmethod
    async def _replied_to_message(message: discord.Message) -> Any:
        """The message ``message`` replies to, as discord.py exposes it.

        discord.py has no ``Message.fetch_reference``. The Gateway usually sends
        the replied-to message along (``reference.resolved``), discord.py may
        hold it in its cache (``reference.cached_message``), and otherwise it is
        fetched by id from the channel. A deleted target resolves to an object
        without an author, so it falls through to the fetch, which then fails.

        Args:
            message (discord.Message): The reply.

        Returns:
            Any: The replied-to message, or None when the message is not a reply.

        Raises:
            Exception: Whatever the fetch raises (not found, no permission).
        """
        reference = getattr(message, 'reference', None)
        if reference is None:
            return None
        for candidate in (getattr(reference, 'resolved', None), getattr(reference, 'cached_message', None)):
            if candidate is not None and getattr(candidate, 'author', None) is not None:
                return candidate
        message_id = getattr(reference, 'message_id', None)
        if message_id is None:
            return None
        return await message.channel.fetch_message(message_id)

    async def _aimed_at_someone_else(self, message: discord.Message) -> bool:
        """Whether this message belongs to someone else's conversation.

        Gathers the plain values the pure predicate needs (mentions, role
        mentions, reply reference) and fetches the replied-to message only when
        it can change the answer. The fetch is best-effort.

        Args:
            message (discord.Message): The incoming message.

        Returns:
            bool: True when the node should acknowledge instead of answering.
        """
        bot_user = getattr(getattr(self, '_bot', None), 'user', None)
        bot_user_id = getattr(bot_user, 'id', None)
        is_mentioned = self._is_bot_mentioned(message)
        reference = getattr(message, 'reference', None)
        is_reply = reference is not None and getattr(reference, 'message_id', None) is not None
        mentions = getattr(message, 'mentions', []) or []
        mentions = mentions if isinstance(mentions, (list, tuple)) else []
        role_mentions = getattr(message, 'role_mentions', []) or []
        role_mentions = role_mentions if isinstance(role_mentions, (list, tuple)) else []
        author_id = getattr(getattr(message, 'author', None), 'id', None)

        reply_target_is_bot = None
        reply_target_is_author = None
        if is_reply and not is_mentioned:
            try:
                referenced = await self._replied_to_message(message)
                author = getattr(referenced, 'author', None)
                if author is not None:
                    reply_target_is_bot = getattr(author, 'id', None) == bot_user_id
                    reply_target_is_author = author_id is not None and getattr(author, 'id', None) == author_id
            except Exception as e:
                debug(f'Discord: could not look up the message replied to: {e}')

        return is_aimed_at_someone_else(
            is_bot_mentioned=is_mentioned,
            # The author is never somebody else: a reply to their own message
            # pings them, which puts them in ``mentions``.
            mentioned_user_ids=[str(user.id) for user in mentions if user.id != author_id],
            bot_user_id=str(bot_user_id) if bot_user_id is not None else None,
            role_mention_count=len(role_mentions),
            is_reply=is_reply,
            reply_target_is_bot=reply_target_is_bot,
            reply_target_is_author=reply_target_is_author,
        )

    async def _react(self, message: discord.Message, emoji: str) -> bool:
        """Add one reaction, best-effort (needs the Add Reactions permission)."""
        try:
            await message.add_reaction(emoji)
            return True
        except Exception as e:
            debug(f'Discord: reaction {_shown_entry(str(emoji))} failed (grant "Add Reactions"): {e}')
            return False

    async def _skip_reason(self, message: discord.Message) -> Optional[str]:
        """Decide whether to stay quiet on this message, mirroring the bot.

        Two opt-in gates, in the support bot's order: a thread that escalated
        stays quiet until the bot is @mentioned again, and a message aimed at
        somebody else gets an acknowledging reaction instead of an answer (and
        pauses its thread, as the bot does).

        Args:
            message (discord.Message): The message about to be processed.

        Returns:
            Optional[str]: A ``no_reply`` reason (``'paused'`` /
                ``'aimed_elsewhere'``) when the message must not be processed,
                else None.
        """
        channel = message.channel
        thread_id = str(channel.id) if isinstance(channel, discord.Thread) else None
        escalation_pause = getattr(self, '_escalation_pause', False)

        if escalation_pause and thread_id is not None:
            paused, resolved = self._pause_state()
            is_paused = thread_id in paused
            reconciled = True
            if not is_paused and thread_id not in resolved:
                # First sight of this thread in this process: reconcile with
                # Discord so a restart does not resume a handed-over thread.
                from_history = await self._paused_from_history(channel)
                if from_history is None:
                    # The fetch failed, so nothing is known either way. Leave
                    # the thread unreconciled so the next message asks again,
                    # and answer this one: a transient permission or network
                    # failure must not freeze a handed-over thread as open.
                    reconciled = False
                else:
                    is_paused = from_history
                    if is_paused:
                        paused.add(thread_id)
                        debug(f'Discord: thread {thread_id} restored as paused from history')
            if reconciled:
                resolved.add(thread_id)
            if is_paused:
                if not self._is_bot_named_in_text(message):
                    return 'paused'
                paused.discard(thread_id)  # the user re-engaged the bot
                debug(f'Discord: thread {thread_id} re-engaged by mention')

        if getattr(self, '_ignore_aimed_at_others', False) and await self._aimed_at_someone_else(message):
            ack_emoji = getattr(self, '_ack_emoji', '')
            if ack_emoji:
                await self._react(message, ack_emoji)
            if escalation_pause and thread_id is not None:
                self._pause_state()[0].add(thread_id)
            return 'aimed_elsewhere'

        return None

    async def _after_send(self, message: discord.Message, reply: str, outbound: Dict[str, Any]):
        """Apply the post-reply side effects the support bot applies.

        Pauses the thread when the posted answer escalated (it carries an
        escalation marker), and adds the configured feedback affordances to the
        last posted chunk when the whole answer went out. Both are best-effort
        and never fail the reply.

        Args:
            message (discord.Message): The originating message.
            reply (str): The answer that was posted.
            outbound (Dict[str, Any]): The result of :meth:`_send_response`;
                mutated with ``feedbackEmojis`` when reactions were applied.

        Returns:
            None
        """
        if not outbound.get('messageIds'):
            return

        if getattr(self, '_escalation_pause', False) and self._is_escalation(reply):
            thread_id = outbound.get('threadId')
            if thread_id is None and isinstance(message.channel, discord.Thread):
                thread_id = str(message.channel.id)
            if thread_id is not None:
                self._pause_state()[0].add(str(thread_id))
                debug(f'Discord: escalated - thread {thread_id} paused')

        # A partial delivery (``complete`` False) has no last chunk of the
        # answer to grade: the reactions would land on a cut-off message.
        if getattr(self, '_feedback_reactions', False) and outbound.get('complete', True):
            sent_messages = outbound.get('messages') or []
            if not sent_messages:
                return
            applied: List[str] = []
            for emoji in getattr(self, '_feedback_emojis', []) or []:
                if emoji and await self._react(sent_messages[-1], emoji):
                    applied.append(emoji)
            if applied:
                outbound['feedbackEmojis'] = applied

    async def _process_message(self, message: discord.Message):
        """Route a message to the pipeline and send back its answer.

        With ``mergeAttachments`` on a message that carries text
        plus attachments produces ONE answer that has seen everything:
        text-like files are folded into the question,
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
                # Paused thread / message aimed at somebody else: stay quiet without
                # ingesting anything, exactly as the support bot does.
                skip_reason = await self._skip_reason(message)
                if skip_reason is not None:
                    # The message itself still travels with the event: a team
                    # member answering inside a paused thread is the signal that a
                    # human took over, and no ``message`` event is emitted for it.
                    content = message.content if isinstance(message.content, str) else str(message.content or '')
                    await self._emit_no_reply_event(metadata, skip_reason, text=content[:2000])
                    return

                reply = ''
                # What it would take to ask the text pass again; None when this
                # message never had one (attachments only). Set by whichever branch
                # below ran it, and consumed by the non-answer retry.
                text_pass: Optional[Dict[str, Any]] = None

                if merge:
                    reply = await self._process_merged(message, metadata, eligible_attachments, processing_errors)
                    text_pass = metadata.pop('_textPass', None)
                else:
                    if question:
                        text_meta = dict(metadata, groupIndex=group_index, groupSize=group_size)
                        group_index += 1
                        # In a thread, carry the earlier conversation as context. The SSE
                        # payload keeps the user's own words (plus how much context was
                        # added) so a UI still shows the question that was asked.
                        transcript = (
                            await self._thread_transcript(message)
                            if isinstance(message.channel, discord.Thread)
                            else ''
                        )
                        pipeline_text = with_thread_context(question, transcript)
                        text_reply = await self._run_with_optional_typing(
                            message,
                            lambda: self._run_pipeline(
                                self._run_text_pipeline,
                                pipeline_text,
                                message.channel.id,
                                message.id,
                                text_meta,
                                sse_text=question,
                                context_chars=len(transcript),
                            ),
                        )
                        text_reply = self._answer_text(text_reply)
                        if text_reply:
                            reply = text_reply
                        if text_meta.get('_pipelineError'):
                            processing_errors.append(text_meta.pop('_pipelineError'))
                        text_pass = {
                            'text': pipeline_text,
                            'meta': text_meta,
                            'sseText': question,
                            'contextChars': len(transcript),
                        }

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

                if reply and looks_like_error(reply):
                    # An engine or model failure arrived as the "answer" (a
                    # provider error, a traceback). Whatever sanitizeReplies
                    # says: a raw provider exception can carry account details
                    # or internal URLs. It is not a transient non-answer, so it
                    # is neither relayed nor retried.
                    debug(f'Discord: suppressed an error-looking answer for {message.id}: {reply[:160]}')
                    await self._emit_no_reply_event(metadata, 'model_error')
                    return

                if getattr(self, '_sanitize_replies', False):
                    # Leaked agent scratchpad is not an answer: post the hand-off
                    # line when it escalated, otherwise ask once more (a ReAct agent
                    # that stopped at "Thought:" usually answers on a second run)
                    # before staying quiet. An empty answer is transient in the same
                    # way, so it is retried too — unless the pipeline itself failed
                    # for this message, where asking again only repeats the failure.
                    sanitized = sanitize_reply(reply, self._effective_markers(), self._handoff_alias()) if reply else ''
                    if not sanitized and text_pass is not None and (reply or not processing_errors):
                        retry_errors: List[str] = []
                        sanitized = await self._retry_non_answer(message, text_pass, retry_errors)
                        if retry_errors:
                            await self._emit_no_reply_event(metadata, 'model_error')
                            return
                    if reply and not sanitized:
                        # The pipeline did answer; nothing in it was postable.
                        await self._emit_no_reply_event(metadata, 'non_answer')
                        return
                    reply = sanitized

                # The literal team alias becomes a real role mention only in the
                # text that is posted, after sanitizing: reasoning that merely
                # names the team must never ping it. Escalation detection after
                # the send sees the injected mention.
                reply = self._with_team_mention(reply, str(message.channel.id))

                if reply and self._send_responses:
                    outbound = await self._send_response(message, reply)
                    if getattr(self, '_escalation_pause', False) or getattr(self, '_feedback_reactions', False):
                        await self._after_send(message, reply, outbound)
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
            except PipelineTimeout as e:
                debug(f'Discord: {e} for {message.id}; its late answer will be dropped')
                await self._emit_no_reply_event(metadata, 'timeout')
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

        Text-like files are folded into the question, every other attachment
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
        # Thread context is carried exactly as it is without attachments: only
        # a message the user actually typed gets the transcript framing.
        transcript = (
            await self._thread_transcript(message) if question and isinstance(message.channel, discord.Thread) else ''
        )
        pipeline_text = compose_merged_question(with_thread_context(question, transcript), blocks)
        text_reply = await self._run_with_optional_typing(
            message,
            lambda: self._run_pipeline(
                self._run_text_pipeline,
                pipeline_text,
                message.channel.id,
                message.id,
                text_meta,
                sse_text=question or pipeline_text,
                context_chars=len(pipeline_text) - len(question),
            ),
        )
        if text_meta.get('_pipelineError'):
            processing_errors.append(text_meta.pop('_pipelineError'))
        # Hand the text pass back to _process_message (which pops the key right
        # away) so a non-answer can be retried. Set last: every dict copied from
        # ``metadata`` above has already been made, so the key never reaches an
        # object's tag metadata or an emitted event.
        metadata['_textPass'] = {
            'text': pipeline_text,
            'meta': text_meta,
            'sseText': question or pipeline_text,
            'contextChars': len(pipeline_text) - len(question),
        }
        return self._answer_text(text_reply) or first_answer

    async def _retry_non_answer(
        self,
        message: discord.Message,
        text_pass: Dict[str, Any],
        errors: Optional[List[str]] = None,
    ) -> str:
        """Ask the text pass again after it produced nothing postable.

        A ReAct agent that returned only scratchpad (``Thought:`` with no
        ``Final Answer:``), or nothing at all, answers normally on a second
        run, so up to ``nonAnswerRetries`` re-runs are attempted before the
        node gives up. Each re-run uses the same pipeline text, metadata, and
        SSE text as the original but a distinct object name, so a stateful
        prompt node does not treat it as the object it already saw.

        Args:
            message (discord.Message): The message being answered.
            text_pass (Dict[str, Any]): The original text pass (``text``,
                ``meta``, ``sseText``, ``contextChars``).
            errors (Optional[List[str]]): Collects ``'model_error'`` when a
                re-run answered with an engine/model failure, which ends the
                retries — the caller reports that instead of ``non_answer``.

        Returns:
            str: The first non-empty sanitized answer, or '' when none came.
        """
        retries = getattr(self, '_non_answer_retries', 0) or 0
        markers = self._effective_markers()
        for attempt in range(1, int(retries) + 1):
            debug(f'Discord: non-answer reply for {message.id}, retry {attempt}/{retries}')
            # A copy: a retry's pipeline error must not overwrite the original's.
            meta = dict(text_pass['meta'])
            answer = await self._run_with_optional_typing(
                message,
                lambda: self._run_pipeline(
                    self._run_text_pipeline,
                    text_pass['text'],
                    message.channel.id,
                    message.id,
                    meta,
                    f'{message.id}:retry{attempt}',
                    sse_text=text_pass['sseText'],
                    context_chars=text_pass['contextChars'],
                    retry=attempt,
                ),
            )
            answer = self._answer_text(answer)
            if answer and looks_like_error(answer):
                debug(f'Discord: retry {attempt} for {message.id} returned an error, not an answer')
                if errors is not None:
                    errors.append('model_error')
                return ''
            reply = sanitize_reply(answer, markers, self._handoff_alias()) if answer else ''
            if reply:
                return reply
        return ''

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

    async def _run_pipeline(self, func: Callable, *args, **kwargs):
        """Run one blocking pipeline call on the node's own bounded pool.

        Waits for a free slot first. The slot is given back when the call
        returns, not when the caller stops waiting, so a run that timed out
        keeps its worker until it finishes and the pool never holds more runs
        than it has workers.

        Args:
            func (Callable): The blocking pipeline call.
            *args: Its positional arguments.
            **kwargs: Its keyword arguments.

        Returns:
            Any: What the call returned.
        """
        executor = getattr(self, '_pipeline_executor', None)
        if executor is None:
            executor = self._pipeline_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=PIPELINE_WORKERS, thread_name_prefix='discord-pipeline'
            )
        slots = getattr(self, '_pipeline_slots', None)
        if slots is None:
            slots = self._pipeline_slots = asyncio.Semaphore(PIPELINE_WORKERS)

        await slots.acquire()
        loop = asyncio.get_running_loop()
        try:
            # Like asyncio.to_thread: the call sees this task's context variables.
            call = functools.partial(contextvars.copy_context().run, func, *args, **kwargs)
            future = executor.submit(call)
        except BaseException:
            slots.release()
            raise
        future.add_done_callback(lambda _future: loop.call_soon_threadsafe(slots.release))
        return await asyncio.wrap_future(future)

    async def _await_pipeline(self, coro_factory):
        """Await one pipeline run, giving up after ``pipelineTimeoutSeconds`` when set.

        The limit covers waiting for a free pipeline slot as well as the run.
        The run itself cannot be cancelled (it is a worker thread): on timeout
        it keeps its worker until it finishes in the background, returns its
        pipe, and its answer is dropped because nothing awaits it any more.

        Raises:
            PipelineTimeout: The run did not answer within the limit.
        """
        seconds = getattr(self, '_pipeline_timeout_seconds', 0) or 0
        if seconds <= 0:
            return await coro_factory()
        try:
            return await asyncio.wait_for(coro_factory(), timeout=seconds)
        except asyncio.TimeoutError:
            raise PipelineTimeout(f'pipeline gave no answer within {seconds:g}s') from None

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
            return await self._await_pipeline(coro_factory)

        typing_cm = None
        try:
            typing_cm = message.channel.typing()
            await typing_cm.__aenter__()
        except Exception as e:
            debug(f'Discord: typing indicator failed to start: {e}')
            typing_cm = None

        try:
            return await self._await_pipeline(coro_factory)
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
            meta (Optional[Dict[str, Any]]): The object's metadata contract
                (group index and size already set); built from the message
                when None. A pipeline or download error is recorded on it
                as ``_pipelineError``.
            attachment_index (int): The attachment's position in the
                message (object name ``<message_id>:<index>``).
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
                    lambda: self._run_pipeline(
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
                lambda: self._run_pipeline(
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
        except PipelineTimeout:
            raise  # the whole message is given up, not just this attachment
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

        Args:
            pipe (Any): The engine pipe the object is being written to.
            metadata (Dict[str, Any]): The per-object metadata contract.

        Returns:
            None
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

        Args:
            pipe (Any): The engine pipe, for its ``pipeId``.
            event_type (str): ``message``, ``reaction``, ``no_reply`` or ``outbound``.
            metadata (Dict[str, Any]): The per-object metadata contract.
            payload (Dict[str, Any]): The event-specific fields.

        Returns:
            None
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
        context_chars: int = 0,
        retry: int = 0,
    ) -> str:
        """Push a text message through the pipeline on the text lane.

        Blocking; must be called via :meth:`_run_pipeline`.

        Args:
            text (str): The message text.
            channel_id (int): The originating channel id (entry URL).
            message_id (int): The originating message id (entry URL).
            meta (Dict[str, Any]): The object's metadata contract; a
                pipeline error is recorded on it as ``_pipelineError``.
            object_name (Optional[str]): The entry name; the message id
                when None (a text attachment passes ``<message_id>:<index>``).
            attachment_id (Optional[int]): Appended to the entry URL for a
                text attachment; None for the message's own text.
            sse_text (Optional[str]): Text to broadcast instead of ``text`` —
                the user's own message when thread context was prepended.
            context_chars (int): Size of the prepended thread transcript.
            retry (int): Which non-answer retry this run is (1-based). Reported
                on the ``message`` SSE event so a UI can tell a re-run from the
                original, which carries no ``retry`` key.

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
            payload: Dict[str, Any] = {
                'lane': 'text',
                'text': broadcast_text[:2000],
                'contextChars': int(context_chars),
            }
            if retry > 0:
                payload['retry'] = int(retry)
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

        Blocking; must be called via :meth:`_run_pipeline`.

        Args:
            file_data (bytes): The raw attachment bytes.
            mime_type (str): The attachment MIME type (selects the lane).
            attachment_id (int): The attachment id (entry URL).
            channel_id (int): The originating channel id (entry URL).
            message_id (int): The originating message id (entry URL and name).
            attachment_index (int): The attachment's position in the message
                (entry name ``<message_id>:<index>``).
            meta (Dict[str, Any]): The object's metadata contract; a
                pipeline error is recorded on it as ``_pipelineError``.

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
        """Emit a small tagged JSON event object without waiting for an answer.

        The object goes out on the ``tags`` lane with the URL
        ``discord://<channel_id>/<message_id>/<event_type>`` and the name
        ``<message_id>:<event_type>``, and is broadcast as an ``apaevt_sse``
        event. Blocking; called through ``asyncio.to_thread``.

        Args:
            metadata (Dict[str, Any]): The message's metadata contract.
            event_type (str): ``reaction``, ``no_reply`` or ``outbound``.
            payload (Dict[str, Any]): The event-specific fields.

        Returns:
            None
        """
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

    async def _emit_no_reply_event(self, metadata: Dict[str, Any], reason: str, text: Optional[str] = None):
        """Emit one ``no_reply`` event.

        The reason is clipped to :data:`MAX_NO_REPLY_REASON_CHARS` here, at the
        one place every reason passes through: a reason built from an exception
        message is unbounded.

        Args:
            metadata (Dict[str, Any]): The message's metadata contract.
            reason (str): Why nothing was posted.
            text (Optional[str]): The message content, for a message that was
                skipped without being ingested — nothing else records it. Left
                off every other reason, whose question is already on a
                ``message`` event.

        Returns:
            None
        """
        if not getattr(self, '_emit_no_reply', False):
            return
        payload: Dict[str, Any] = {'reason': str(reason)[:MAX_NO_REPLY_REASON_CHARS]}
        if text is not None:
            payload['text'] = text
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
        if details.get('feedbackEmojis'):
            payload['feedbackEmojis'] = details['feedbackEmojis']
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
        sent_messages: List[Any] = []
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
                thread = await self._send_chunk(message, chunk, thread, sent_ids, destinations, sent_messages)
            except discord.RateLimited as e:
                # discord.py handles 429s internally (honoring Retry-After) and
                # only surfaces RateLimited when the client sets
                # max_ratelimit_timeout, which we do not — this is defensive:
                # retry once after the reported delay if it is ever raised.
                debug(f'Discord: rate limited; retrying after {e.retry_after}s')
                await asyncio.sleep(float(e.retry_after))
                try:
                    thread = await self._send_chunk(message, chunk, thread, sent_ids, destinations, sent_messages)
                except Exception as e2:
                    debug(f'Discord: send retry failed, abandoning remaining chunks: {e2}')
                    complete = False
                    break
            except Exception as e:
                debug(f'Discord: send failed, abandoning remaining chunks: {e}')
                complete = False
                break
        destination = destinations[0] if destinations else self._reply_mode
        # ``messages`` and ``threadId`` stay internal (the escalation pause and
        # the feedback reactions need them); the emitted event keeps its shape.
        return {
            'messageIds': sent_ids,
            'destination': destination,
            'complete': complete,
            'threadId': str(thread.id) if thread is not None and getattr(thread, 'id', None) is not None else None,
            'messages': sent_messages,
        }

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
        it. The resolved name is capped by ``threadNameMaxLength``, and the node's
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
        sent_messages: Optional[List[Any]] = None,
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
        if sent_messages is not None and sent is not None:
            sent_messages.append(sent)

    async def _send_chunk(
        self,
        message: discord.Message,
        chunk: str,
        thread,
        sent_ids: Optional[List[str]] = None,
        destinations: Optional[List[str]] = None,
        sent_messages: Optional[List[Any]] = None,
    ):
        """Send a single chunk using the configured reply mode.

        Args:
            message (discord.Message): The originating message.
            chunk (str): The chunk text (already within the char limit).
            thread: The thread created for a prior chunk, or None.
            sent_ids: Collects the posted message ids.
            destinations: Collects the destination used per chunk.
            sent_messages: Collects the posted message objects (the feedback
                reactions go on the last one).

        Returns:
            The thread used (for 'thread' mode) so later chunks reuse it, else None.
        """
        # Outbound content is model-generated: by default all mentions are
        # suppressed. Only the explicitly configured allowedMentionRoleIds /
        # allowedMentionUserIds may ping; @everyone/@here are never allowed.
        allowed_mentions = self._allowed_mentions()

        if self._reply_mode == 'reply':
            sent = await message.reply(chunk, mention_author=False, allowed_mentions=allowed_mentions)
            self._record_sent(sent, 'reply', sent_ids, destinations, sent_messages)
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
                    self._record_sent(sent, 'reply', sent_ids, destinations, sent_messages)
                    return None
            if thread is _THREAD_FALLBACK:
                sent = await message.reply(chunk, mention_author=False, allowed_mentions=allowed_mentions)
                self._record_sent(sent, 'reply', sent_ids, destinations, sent_messages)
                return _THREAD_FALLBACK
            sent = await thread.send(chunk, allowed_mentions=allowed_mentions)
            self._record_sent(sent, 'thread', sent_ids, destinations, sent_messages)
            return thread

        sent = await message.channel.send(chunk, allowed_mentions=allowed_mentions)
        self._record_sent(sent, 'channel', sent_ids, destinations, sent_messages)
        return None
