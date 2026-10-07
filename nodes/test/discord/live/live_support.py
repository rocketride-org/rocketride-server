# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Support library for the live Discord node tests.

The live layer keeps the *node* and the *Discord* side real and stubs only the
engine:

- ``rocketlib`` and ``depends`` are stubbed exactly as the unit tests do, so
  ``IEndpoint`` imports without an engine, but the **real** ``discord`` library
  is used;
- ``StubTarget`` / ``RecordingPipe`` stand in for the pipeline and record every
  ``open`` / ``sendTagMetadata`` / ``writeText`` / ``writeImage`` / tag call, so
  a test can assert what the node *would* hand downstream;
- the bot is a real ``commands.Bot`` connected to the real Gateway once per
  session on a background event loop; tests are ordinary synchronous functions
  that drive coroutines onto that loop with ``LiveBot.run()``.

The node's ``_run()`` is not usable here (it needs the engine's shared web
server), so tests drive ``_on_message`` (gating) and ``_process_message``
(everything else) directly, which is what ``_run`` ends up doing anyway.

Nothing in this module reads, prints, or stores the bot token beyond handing it
to discord.py.
"""

import asyncio
import importlib.util
import json
import os
import socket
import sys
import threading
import time
import types
from typing import Any, Dict, List, Optional
from unittest import mock
from urllib.parse import urlparse

import pytest

# The live suite drives real Discord; an offline run without discord.py must
# skip this directory instead of breaking collection for the unit tests.
pytest.importorskip('discord')

import discord  # noqa: E402
from discord.ext import commands

LIVE_ENV_FLAG = 'DISCORD_LIVE'
LIVE_PREFIX = '[LIVE-TEST'
E2E_PREFIX = '[e2e'
POST_THROTTLE_SECONDS = 1.5
# L3 drives a real LLM pipeline: one driver message at a time, well spaced.
E2E_POST_THROTTLE_SECONDS = 3.0

# Where the bot token (``{"token": "..."}``) and the live id map live. Both are
# read from the environment only; the repo carries no default location.
TOKEN_FILE_ENV = 'DISCORD_LIVE_TOKEN_FILE'
IDS_FILE_ENV = 'DISCORD_LIVE_IDS_FILE'

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../src/nodes/discord'))
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))


live_only = pytest.mark.skipif(
    os.environ.get(LIVE_ENV_FLAG) != '1',
    reason=f'{LIVE_ENV_FLAG}=1 not set (live Discord tests post to a real server)',
)


# -----------------------------------------------------------------------------
# Secrets / ids
# -----------------------------------------------------------------------------


def _env_path(name: str) -> str:
    """The file path an environment variable names, or '' when it is unset."""
    value = os.environ.get(name, '').strip()
    return os.path.expanduser(value) if value else ''


def token_file() -> str:
    return _env_path(TOKEN_FILE_ENV)


def load_token() -> str:
    """Return the bot token. Never log, print, or assert on the value."""
    path = token_file()
    if not path:
        raise FileNotFoundError(f'{TOKEN_FILE_ENV} is not set')
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)['token']


def load_ids() -> Dict[str, str]:
    """Return the live id map; empty strings mean 'not provided'.

    Raises:
        FileNotFoundError: ``DISCORD_LIVE_IDS_FILE`` is unset or names no file.
    """
    path = _env_path(IDS_FILE_ENV)
    if not path:
        raise FileNotFoundError(f'{IDS_FILE_ENV} is not set')
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


# -----------------------------------------------------------------------------
# Node loading (engine stubbed, real discord)
# -----------------------------------------------------------------------------


class _Response:
    """Stands in for the engine's entry response object."""

    def __init__(self, entry: 'Entry'):
        self._entry = entry

    def toDict(self) -> Dict[str, Any]:  # noqa: N802 — engine API name
        return {'answers': self._entry.resolve_answers()}


class Entry:
    """Recording stand-in for an engine object entry (``getObject``)."""

    def __init__(self, obj: Dict[str, Any]):
        self.obj = dict(obj)
        self.url = self.obj.get('url')
        self.name = self.obj.get('name')
        self.mimeType = self.obj.get('mimeType')
        self.size = self.obj.get('size')
        self.response = _Response(self)
        self._target: Optional['StubTarget'] = None

    def bind(self, target: 'StubTarget'):
        """Bind the entry to the target whose canned answer it should report."""
        self._target = target

    def resolve_answers(self) -> List[str]:
        if self._target is None:
            return []
        return self._target.answers_for(self)

    def __repr__(self) -> str:
        return f'Entry(name={self.name!r}, url={self.url!r})'


def _load_node(real_discord: bool = True):
    """Load ``IEndpoint`` + ``text_utils`` with only the engine stubbed.

    Mirrors ``test_process_message._load_endpoint_class`` (synthetic package,
    ``sys.modules`` restored afterwards so the collection-time isolation guard
    in ``nodes/test/_sys_modules_guard.py`` stays happy) but keeps the real
    ``discord`` package, because the point of this layer is to talk to Discord.
    """
    rocketlib = types.ModuleType('rocketlib')

    class _IEndpointBase:
        pass

    rocketlib.IEndpointBase = _IEndpointBase
    for _name in ('monitorOther', 'monitorStatus', 'monitorCompleted', 'monitorFailed', 'debug'):
        setattr(rocketlib, _name, mock.Mock(name=_name))

    def _get_object(obj):
        return Entry(obj)

    rocketlib.getObject = _get_object
    rocketlib.isCancelled = mock.Mock(name='isCancelled', return_value=False)

    class _AVI_ACTION:
        BEGIN = 'BEGIN'
        WRITE = 'WRITE'
        END = 'END'

    rocketlib.AVI_ACTION = _AVI_ACTION

    depends = types.ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None

    stubs = {'rocketlib': rocketlib, 'depends': depends}
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        pkg = types.ModuleType('_discord_live_node')
        pkg.__path__ = [_NODE_DIR]
        sys.modules['_discord_live_node'] = pkg
        for name in ('text_utils', 'IEndpoint'):
            spec = importlib.util.spec_from_file_location(
                f'_discord_live_node.{name}', os.path.join(_NODE_DIR, f'{name}.py')
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'_discord_live_node.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['_discord_live_node.IEndpoint'].IEndpoint,
            sys.modules['_discord_live_node.text_utils'],
            rocketlib,
        )
    finally:
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


IEndpoint, text_utils, rocketlib_stub = _load_node()


# -----------------------------------------------------------------------------
# Pipeline stubs
# -----------------------------------------------------------------------------


class RecordingPipe:
    """Records every call the node makes on a pipeline pipe."""

    def __init__(self, target: 'StubTarget'):
        self.target = target
        self.entry: Optional[Entry] = None
        self.metadata: List[Dict[str, Any]] = []
        self.texts: List[str] = []
        self.images: List[tuple] = []
        self.audios: List[tuple] = []
        self.videos: List[tuple] = []
        self.tag_calls: List[str] = []
        self.tag_data = b''
        self.closed = 0

    # -- engine pipe API ----------------------------------------------------
    def open(self, entry):
        self.entry = entry
        if isinstance(entry, Entry):
            entry.bind(self.target)

    def sendTagMetadata(self, metadata):  # noqa: N802 — engine API name
        self.metadata.append(dict(metadata))

    def writeText(self, text):  # noqa: N802 — engine API name
        self.target.maybe_raise('writeText')
        self.texts.append(text)

    def writeImage(self, action, mime_type, data=None):  # noqa: N802 — engine API name
        self.target.maybe_raise('writeImage')
        self.images.append((action, mime_type, len(data) if data else 0))

    def writeAudio(self, action, mime_type, data=None):  # noqa: N802 — engine API name
        self.target.maybe_raise('writeAudio')
        self.audios.append((action, mime_type, len(data) if data else 0))

    def writeVideo(self, action, mime_type, data=None):  # noqa: N802 — engine API name
        self.target.maybe_raise('writeVideo')
        self.videos.append((action, mime_type, len(data) if data else 0))

    def writeTagBeginObject(self):  # noqa: N802 — engine API name
        self.tag_calls.append('beginObject')

    def writeTagBeginStream(self):  # noqa: N802 — engine API name
        self.tag_calls.append('beginStream')

    def writeTagData(self, data):  # noqa: N802 — engine API name
        self.target.maybe_raise('writeTagData')
        self.tag_calls.append('data')
        self.tag_data += data

    def writeTagEndStream(self):  # noqa: N802 — engine API name
        self.tag_calls.append('endStream')

    def writeTagEndObject(self):  # noqa: N802 — engine API name
        self.tag_calls.append('endObject')

    def close(self):
        self.closed += 1

    # -- test helpers -------------------------------------------------------
    @property
    def name(self) -> Optional[str]:
        return self.entry.name if self.entry is not None else None

    @property
    def url(self) -> Optional[str]:
        return self.entry.url if self.entry is not None else None

    @property
    def meta(self) -> Dict[str, Any]:
        return self.metadata[0] if self.metadata else {}

    @property
    def tag_json(self) -> Dict[str, Any]:
        return json.loads(self.tag_data.decode('utf-8'))

    def __repr__(self) -> str:
        return f'RecordingPipe(name={self.name!r}, texts={len(self.texts)}, tags={len(self.tag_calls)})'


class StubTarget:
    """Stands in for the engine target endpoint (``getPipe`` / ``putPipe``).

    ``answer`` is the canned pipeline answer and may be a string, a list of
    strings, or a callable taking the entry. ``raises`` makes writes on the pipe
    raise, which is how the "pipeline blew up" paths are driven; ``raise_on``
    narrows that to specific write calls (so a failing text lane can coexist
    with a working event lane).
    """

    def __init__(self, answer: Any = '', raises: Optional[BaseException] = None, raise_on=None):
        self.answer = answer
        self.raises = raises
        self.raise_on = set(raise_on) if raise_on else None
        self.pipes: List[RecordingPipe] = []
        self.returned: List[RecordingPipe] = []

    def getPipe(self):  # noqa: N802 — engine API name
        pipe = RecordingPipe(self)
        self.pipes.append(pipe)
        return pipe

    def putPipe(self, pipe):  # noqa: N802 — engine API name
        self.returned.append(pipe)

    def maybe_raise(self, operation: str):
        if self.raises is not None and (self.raise_on is None or operation in self.raise_on):
            raise self.raises

    def answers_for(self, entry: Entry) -> List[str]:
        answer = self.answer
        if callable(answer):
            answer = answer(entry)
        if answer is None:
            return []
        if isinstance(answer, str):
            return [answer]
        return list(answer)

    # -- test helpers -------------------------------------------------------
    def reset(self):
        self.pipes = []
        self.returned = []

    @property
    def names(self) -> List[str]:
        return [pipe.name for pipe in self.pipes]

    @property
    def text_pipes(self) -> List[RecordingPipe]:
        return [pipe for pipe in self.pipes if pipe.texts]

    @property
    def tag_pipes(self) -> List[RecordingPipe]:
        return [pipe for pipe in self.pipes if pipe.tag_calls]

    def pipe_named(self, name: str) -> RecordingPipe:
        for pipe in self.pipes:
            if pipe.name == name:
                return pipe
        raise AssertionError(f'no pipe opened with name {name!r}; opened: {self.names}')


# -----------------------------------------------------------------------------
# Endpoint factory
# -----------------------------------------------------------------------------


def services_defaults() -> Dict[str, Any]:
    """Every ``discord.*`` config default straight out of ``services.json``."""
    # services.json is JSONC: drop its whole-line // comments before parsing.
    with open(_SERVICES_JSON, encoding='utf-8') as handle:
        lines = handle.read().split('\n')
    services = json.loads('\n'.join(line for line in lines if not line.lstrip().startswith('//')))
    defaults: Dict[str, Any] = {}
    for key, field in services['fields'].items():
        if not key.startswith('discord.'):
            continue
        name = key[len('discord.') :]
        if 'default' in field:
            defaults[name] = field['default']
        elif field.get('type') == 'array':
            defaults[name] = []
        else:
            defaults[name] = ''
    return defaults


class _ParsedConfig(Exception):
    """Raised where ``IEndpoint._run()`` would reach the engine's shared web server."""


def make_endpoint(bot, *, target: Optional[StubTarget] = None, **overrides):
    """Build an ``IEndpoint`` wired to ``bot`` and a ``StubTarget``.

    Starts from every ``services.json`` default, then applies ``overrides``
    (camelCase config names, exactly as the engine delivers them). The one
    harness-level deviation from the shipped defaults is ``showTyping=False``:
    the typing indicator is only interesting in D14 and otherwise just adds
    Discord traffic to every test. Pass ``showTyping=True`` to exercise it.

    The config is parsed by the real ``IEndpoint._run()``, stopped where it
    would reach the engine's shared web server, so the harness applies exactly
    the defaults, coercions and clamps production does (no hand-kept copy to
    drift out of step).
    """
    config = services_defaults()
    config['showTyping'] = False
    config.update(overrides)

    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint.target = target if target is not None else StubTarget()
    endpoint.endpoint = types.SimpleNamespace(serviceConfig={'parameters': config})

    node = types.ModuleType('ai.node')
    node.require_shared_web_server = mock.Mock(side_effect=_ParsedConfig())
    node.server_loop = None
    ai = types.ModuleType('ai')
    ai.__path__ = []
    ai.node = node
    with mock.patch.dict(sys.modules, {'ai': ai, 'ai.node': node}):
        try:
            endpoint._run()
        except _ParsedConfig:
            pass
        else:  # pragma: no cover - _run() always reaches the web server
            raise RuntimeError('IEndpoint._run() returned before reaching the shared web server')

    endpoint._bot = bot
    endpoint._bot_task = None
    endpoint._inflight = set()
    endpoint._shutdown_event = threading.Event()
    endpoint._fatal_error = None
    endpoint._closing = False
    return endpoint


# -----------------------------------------------------------------------------
# Identity helpers
# -----------------------------------------------------------------------------


class SynthUser(discord.user._UserTag):
    """A stand-in message author.

    The test server has exactly one bot identity, so a message the harness posts
    is always authored by the bot under test and would be dropped by the
    own-message gate. Replacing ``message.author`` on a *real* Gateway message
    keeps the channel, thread, mentions and reply reference real while letting
    the gate see a different author. Subclasses discord.py's ``_UserTag`` so
    ``Member.__eq__`` / ``in message.mentions`` behave as they do for real users.
    """

    def __init__(self, user_id: int, *, is_bot: bool = False, display_name: str = 'synthetic-author', roles=()):
        self.id = int(user_id)
        self.bot = is_bot
        self.display_name = display_name
        self.roles = list(roles)

    def __repr__(self) -> str:
        return f'SynthUser(id={self.id}, bot={self.bot})'


def with_author(message: discord.Message, author) -> discord.Message:
    """Re-author a real message (see :class:`SynthUser`)."""
    message.author = author
    return message


def _is_plain_message(message: discord.Message) -> bool:
    """True for an ordinary post or reply (not a thread-starter/system marker)."""
    return message.type in (discord.MessageType.default, discord.MessageType.reply)


# -----------------------------------------------------------------------------
# Connected bot
# -----------------------------------------------------------------------------


class LiveBot:
    """One real Gateway connection for the whole session.

    The bot runs on its own event loop in a background thread; tests stay
    synchronous and hand coroutines to :meth:`run`. That matches how the engine
    drives the node (``asyncio.run_coroutine_threadsafe`` onto the shared server
    loop) and avoids binding discord.py objects to a per-test event loop.
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.bot: Optional[commands.Bot] = None
        self.ids = live_ids()
        self.members_intent = False
        self.raw_reactions: List[tuple] = []
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._posted: List[discord.Message] = []
        self._threads: List[discord.Thread] = []
        self.residue: List[str] = []
        self.deleted = 0

    # -- lifecycle ----------------------------------------------------------
    def start(self):
        self._thread = threading.Thread(target=self._loop_forever, name='discord-live-loop', daemon=True)
        self._thread.start()
        token = load_token()
        # Discord's edge occasionally answers the login with a transient 5xx;
        # retry a couple of times rather than erroring every test in the session.
        last_error: Optional[BaseException] = None
        for attempt in range(3):
            try:
                if self._connect(token, members=True):
                    return self
                # Privileged members intent is off in the Developer Portal: fall
                # back so the rest of the suite runs and D08b skips with a reason.
                if self._connect(token, members=False):
                    return self
                last_error = RuntimeError('bot never reached ready state')
            except discord.DiscordServerError as error:
                last_error = error
            time.sleep(5 * (attempt + 1))
        raise RuntimeError(f'Discord live bot failed to connect: {last_error}')

    def _loop_forever(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _connect(self, token: str, *, members: bool) -> bool:
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.reactions = True
        intents.members = members
        self.bot = commands.Bot(command_prefix='!', intents=intents)
        self._ready.clear()

        @self.bot.event
        async def on_ready():
            self._ready.set()

        @self.bot.listen('on_raw_reaction_add')
        async def _on_add(payload):
            self.raw_reactions.append(('add', payload))

        @self.bot.listen('on_raw_reaction_remove')
        async def _on_remove(payload):
            self.raw_reactions.append(('remove', payload))

        future = asyncio.run_coroutine_threadsafe(self.bot.start(token), self.loop)
        deadline = time.time() + 60
        while time.time() < deadline:
            if self._ready.wait(timeout=0.5):
                self.members_intent = members
                return True
            if future.done():
                error = future.exception()
                if isinstance(error, discord.PrivilegedIntentsRequired):
                    return False
                if error is not None:
                    raise error
                return False
        raise RuntimeError('Discord live bot did not become ready within 60s')

    def run(self, coro, timeout: float = 120):
        """Run a coroutine on the bot loop from a synchronous test."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=timeout)

    def close(self):
        try:
            self.run(self.bot.close(), timeout=30)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=10)

    # -- guild helpers ------------------------------------------------------
    @property
    def guild(self) -> discord.Guild:
        return self.bot.get_guild(int(self.ids['guildId']))

    @property
    def primary(self) -> discord.TextChannel:
        return self.bot.get_channel(int(self.ids['primaryChannelId']))

    @property
    def guest(self) -> discord.TextChannel:
        return self.bot.get_channel(int(self.ids['guestChannelId']))

    @property
    def bot_user_id(self) -> int:
        return self.bot.user.id

    def human_user_id(self) -> int:
        """A real human member id: the configured one, else the guild owner."""
        configured = self.ids.get('humanUserId') or ''
        return int(configured) if configured else int(self.guild.owner_id)

    def team_role(self) -> Optional[discord.Role]:
        """A pingable stand-in team role, or None when the guild has none.

        Bot-managed roles cannot be mentioned by anyone, and ``@everyone`` is
        never allowed by the node, so a role-mention test needs a plain role.
        """
        configured = self.ids.get('teamRoleId') or ''
        if configured:
            return self.guild.get_role(int(configured))
        for role in self.guild.roles:
            if not role.managed and not role.is_default():
                return role
        return None

    # -- posting / reading --------------------------------------------------
    def post(self, channel, content: str, files=None, allowed_mentions=None, throttle: bool = True):
        """Post a message as the bot, register it for cleanup, and throttle."""
        mentions = allowed_mentions if allowed_mentions is not None else discord.AllowedMentions.none()
        message = self.run(channel.send(content, files=files or [], allowed_mentions=mentions))
        self.register(message)
        if throttle:
            time.sleep(POST_THROTTLE_SECONDS)
        return message

    def create_thread(self, message: discord.Message, name: str, minutes: int = 60) -> discord.Thread:
        thread = self.run(message.create_thread(name=name, auto_archive_duration=minutes))
        self._threads.append(thread)
        time.sleep(POST_THROTTLE_SECONDS)
        return thread

    def register(self, message: discord.Message):
        self._posted.append(message)

    def track_thread(self, thread: discord.Thread):
        """Register a thread the *node* created so cleanup archives it too."""
        if thread is not None and thread not in self._threads:
            self._threads.append(thread)
        return thread

    def fetch(self, channel, message_id: int) -> discord.Message:
        return self.run(channel.fetch_message(message_id))

    def bot_messages(self, channel, after_id: Optional[int] = None, limit: int = 50) -> List[discord.Message]:
        """Messages the *node* posted in ``channel`` (harness posts excluded)."""

        async def _collect():
            kwargs: Dict[str, Any] = {'limit': limit, 'oldest_first': True}
            if after_id is not None:
                kwargs['after'] = discord.Object(id=int(after_id))
            found = []
            async for message in channel.history(**kwargs):
                if message.author.id != self.bot.user.id or not _is_plain_message(message):
                    # A thread carries a "thread starter" pointer message authored
                    # by the thread creator; it is not something the node posted
                    # (and `is_system()` is False for it, so check the type).
                    continue
                if not message.content.startswith(LIVE_PREFIX):
                    found.append(message)
            return found

        return self.run(_collect())

    def wait_for_bot_message(self, channel, after_id: Optional[int] = None, timeout: float = 25, expected: int = 1):
        """Poll until the node's reply (or ``expected`` replies) is visible."""
        deadline = time.time() + timeout
        found: List[discord.Message] = []
        while time.time() < deadline:
            found = self.bot_messages(channel, after_id)
            if len(found) >= expected:
                break
            time.sleep(1.0)
        for message in found:
            self.register(message)
        return found

    def assert_no_bot_message(self, channel, after_id: int, settle: float = 6.0):
        """Give Discord time to show a reply, then assert none exists."""
        time.sleep(settle)
        posted = self.bot_messages(channel, after_id)
        assert posted == [], f'expected silence, found {[m.content[:60] for m in posted]}'

    def drain_reactions(self):
        self.raw_reactions = []

    def wait_for_raw_reaction(self, kind: str, message_id: int, timeout: float = 20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event_kind, payload in self.raw_reactions:
                if event_kind == kind and payload.message_id == int(message_id):
                    return payload
            time.sleep(0.5)
        raise AssertionError(f'no raw reaction {kind!r} for message {message_id} within {timeout}s')

    # -- cleanup ------------------------------------------------------------
    def cleanup(self) -> List[str]:
        """Delete everything the harness or the node posted; archive threads.

        The bot has no Manage Threads permission, so a thread it created can only
        be archived (verified live: deleting the starter message leaves the thread
        in place). Archived threads are reported as residue.
        """
        residue: List[str] = []

        async def _delete(message):
            try:
                await message.delete()
                return True
            except discord.NotFound:
                return False
            except Exception as error:  # permission / rate-limit edge
                residue.append(f'undeleted message {message.id}: {type(error).__name__}')
                return False

        async def _sweep():
            deleted = 0
            channels = [self.primary, self.guest] + list(self._threads)
            seen = set()
            for channel in channels:
                if channel is None:
                    continue
                try:
                    if getattr(channel, 'archived', False):
                        # Messages cannot be deleted inside an archived thread.
                        await channel.edit(archived=False)
                    async for message in channel.history(limit=200):
                        if message.id in seen or message.author.id != self.bot.user.id:
                            continue
                        if not _is_plain_message(message):
                            # Thread-starter / system messages cannot be deleted.
                            continue
                        seen.add(message.id)
                        if await _delete(message):
                            deleted += 1
                            await asyncio.sleep(0.35)
                except Exception as error:
                    residue.append(f'sweep of {getattr(channel, "id", "?")} failed: {type(error).__name__}')
            return deleted

        async def _archive():
            for thread in self._threads:
                try:
                    await thread.edit(archived=True)
                    residue.append(f'archived thread {thread.name!r} ({thread.id})')
                except Exception as error:
                    residue.append(f'thread {thread.id} not archived: {type(error).__name__}')

        try:
            self.deleted = self.run(_sweep(), timeout=300)
        except Exception as error:
            residue.append(f'cleanup sweep error: {type(error).__name__}')
        try:
            self.run(_archive(), timeout=120)
        except Exception as error:
            residue.append(f'thread archive error: {type(error).__name__}')
        self.residue = residue
        return residue


# -----------------------------------------------------------------------------
# L3: engine + driver bot
# -----------------------------------------------------------------------------

# Every key is read from the ``engine`` block of the ids file and can be
# overridden by ``DISCORD_E2E_<KEY IN UPPER CASE>``. ``engineUri`` additionally
# falls back to ``ROCKETRIDE_URI`` (which is also what gates the layer), so a
# one-off run against another engine only needs that variable.
ENGINE_CONFIG_KEYS = {
    'engineUri': '',
    'engineApiKey': 'MYAPIKEY',
    'guildId': '',
    'supportChannelId': '',
    'teamRoleId': '',
    'driverBotId': '',
    # The bot under test (the identity behind the engine's token variable).
    # Optional: the full engine suite needs it to @mention the bot.
    'botUserId': '',
    'driverTokenEnvFile': '',
    'driverTokenEnvKey': '',
}


def load_engine_config() -> Dict[str, str]:
    """Return the L3 id map. Never contains a token, only where to read one."""
    try:
        stored = load_ids().get('engine') or {}
    except (OSError, ValueError):
        stored = {}
    config: Dict[str, str] = {}
    for key, fallback in ENGINE_CONFIG_KEYS.items():
        override = os.environ.get(f'DISCORD_E2E_{key.upper()}', '')
        config[key] = str(override or stored.get(key) or fallback)
    if not os.environ.get('DISCORD_E2E_ENGINEURI'):
        config['engineUri'] = os.environ.get('ROCKETRIDE_URI', '') or config['engineUri']
    return config


# Top-level keys of the ids file that the environment can override, as
# DISCORD_LIVE_<KEY upper-cased> (DISCORD_LIVE_GUILDID, ...). noPermissionChannelId
# is a channel the bot deliberately has no permissions in: D01 only reads its
# permission bits and never posts there.
LIVE_ID_KEYS = (
    'guildId',
    'primaryChannelId',
    'guestChannelId',
    'botUserId',
    'teamRoleId',
    'humanUserId',
    'noPermissionChannelId',
    'driverBotId',
    'driverTokenFile',
)


def live_ids() -> Dict[str, Any]:
    """Return the live id map: the ids file, overridden per key by the environment.

    A missing or unreadable file is an empty map, so a run can be driven by the
    environment alone. Empty strings still mean 'not provided'.
    """
    try:
        ids: Dict[str, Any] = dict(load_ids())
    except (OSError, ValueError):
        ids = {}
    for key in LIVE_ID_KEYS:
        override = os.environ.get(f'DISCORD_LIVE_{key.upper()}', '')
        if override:
            ids[key] = override
    return ids


def driver_token_path(config: Dict[str, str]) -> str:
    """Absolute path of the env-style file holding the driver bot token."""
    path = os.path.expanduser(config.get('driverTokenEnvFile', ''))
    if not path:
        return ''
    return path if os.path.isabs(path) else os.path.join(_REPO_ROOT, path)


def load_driver_token(config: Dict[str, str]) -> str:
    """Return the driver bot token. Never log, print, or assert on the value."""
    path = driver_token_path(config)
    key = config.get('driverTokenEnvKey', '')
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            name, value = line.split('=', 1)
            if name.strip() == key:
                return value.strip().strip('"').strip("'")
    raise KeyError(f'{key!r} not found in {path}')


def driver_token_available(config: Dict[str, str]) -> bool:
    """True when the driver token can be read (the value never leaves here)."""
    try:
        return bool(load_driver_token(config))
    except (OSError, ValueError, KeyError):
        return False


def tcp_open(host: str, port: int, timeout: float = 3.0) -> bool:
    """True when something accepts a TCP connection on ``host:port``."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def engine_reachable(uri: str) -> bool:
    """True when ``uri`` parses to a host:port that accepts a connection."""
    if not uri:
        return False
    parsed = urlparse(uri if '//' in uri else f'//{uri}')
    if not parsed.hostname:
        return False
    return tcp_open(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 5565))


def _status_dict(status) -> Dict[str, Any]:
    """The SDK returns a pydantic ``TASK_STATUS``; tests want a plain dict."""
    if isinstance(status, dict):
        return status
    if hasattr(status, 'model_dump'):
        return status.model_dump()
    return dict(getattr(status, '__dict__', {}))


class EngineSession:
    """A RocketRide client bound to one running pipeline task.

    Like :class:`LiveBot` it owns a background event loop so the tests stay
    synchronous. ``on_event`` is overridden to record every server event, which
    is how the node's ``apaevt_sse`` payloads (the ``discord`` event stream) are
    observed without a second subscriber process.
    """

    def __init__(self, uri: str, api_key: str):
        self.uri = uri
        self.api_key = api_key
        self.loop = asyncio.new_event_loop()
        self.client = None
        self.token: Optional[str] = None
        self.mode: Optional[str] = None
        self.login_status: str = ''
        self.events: List[Dict[str, Any]] = []
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> 'EngineSession':
        from rocketride import RocketRideClient

        sink = self.events

        class _RecordingClient(RocketRideClient):
            async def on_event(self, message):
                sink.append(message)
                return await super().on_event(message)

        self._thread = threading.Thread(target=self._loop_forever, name='engine-e2e-loop', daemon=True)
        self._thread.start()
        self.client = _RecordingClient(uri=self.uri, auth=self.api_key)
        self.run(self.client.connect(), timeout=60)
        return self

    def _loop_forever(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro, timeout: float = 60):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=timeout)

    def close(self):
        self.terminate()
        try:
            self.run(self.client.disconnect(), timeout=30)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=10)

    # -- task ---------------------------------------------------------------
    def start_pipe(self, pipeline: Dict[str, Any], *, mode: str, source: str = 'discord_1', login_timeout: float = 30):
        """Run ``pipeline`` with ``ttl=0`` and wait for the node to log in.

        Any task already started by this session is terminated first: the pipe's
        bot token is the *same* identity, and two Gateway sessions on one token
        answer every message twice.
        """
        self.terminate()
        self.events.clear()
        try:
            result = self.run(self.client.use(pipeline=pipeline, source=source, ttl=0), timeout=120)
        except Exception as error:
            if 'not running' in str(error):
                pytest.fail(f'engine refused the pipe: {error}')
            raise
        text = json.dumps(result, default=str) if isinstance(result, dict) else str(result)
        if 'Your pipeline is not running' in text:
            pytest.fail('Your pipeline is not running')
        self.token = result.get('token') if isinstance(result, dict) else str(result)
        assert self.token, f'use() returned no task token: {text[:200]}'
        self.mode = mode
        self.run(self.client.set_events(self.token, ['SSE', 'FLOW', 'TASK']), timeout=30)
        self.login_status = self.wait_for_status_text('logged in as', timeout=login_timeout)
        return self.token

    def terminate(self):
        if self.token is None:
            return
        token, self.token, self.mode = self.token, None, None
        try:
            self.run(self.client.terminate(token), timeout=60)
        except Exception:
            pass
        # Give the Gateway session time to drop before the next login.
        time.sleep(3)

    def status(self) -> Dict[str, Any]:
        return _status_dict(self.run(self.client.get_task_status(self.token), timeout=30))

    def state(self) -> int:
        state = self.status().get('state')
        return int(getattr(state, 'value', state) or 0)

    def wait_for_status_text(self, needle: str, timeout: float = 30) -> str:
        """Poll the task status line until it contains ``needle`` (else '')."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                text = str(self.status().get('status') or '')
            except Exception:
                text = ''
            if needle in text:
                return text
            time.sleep(1.0)
        return ''

    # -- node events --------------------------------------------------------
    def discord_events(self, event_type: Optional[str] = None, correlation_id=None) -> List[Dict[str, Any]]:
        """Every ``apaevt_sse`` body of type ``discord``, newest last."""
        found = []
        for message in list(self.events):
            if not isinstance(message, dict) or message.get('event') != 'apaevt_sse':
                continue
            body = message.get('body') or {}
            if body.get('type') != 'discord':
                continue
            data = body.get('data') or {}
            if event_type is not None and data.get('eventType') != event_type:
                continue
            metadata = data.get('metadata') or {}
            if correlation_id is not None and str(metadata.get('correlationId')) != str(correlation_id):
                continue
            found.append(data)
        return found

    def wait_for_discord_event(self, event_type: str, correlation_id, timeout: float = 30) -> Dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = self.discord_events(event_type, correlation_id)
            if found:
                return found[0]
            time.sleep(0.5)
        seen = [(d.get('eventType'), (d.get('metadata') or {}).get('correlationId')) for d in self.discord_events()]
        raise AssertionError(f'no discord {event_type!r} event for {correlation_id} within {timeout}s; saw {seen}')


class DriverBot:
    """The second Discord identity that drives the engine tests.

    The bot *under test* is spawned by the engine from the pipe's ``botToken``,
    so the harness never holds that token and cannot delete what the node posts:
    cleanup covers the driver's own messages and archives the threads the node
    created (archiving is all the driver can do without Manage Threads).
    """

    def __init__(self, config: Dict[str, str]):
        self.config = config
        self.loop = asyncio.new_event_loop()
        self.client: Optional[discord.Client] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._posted: List[discord.Message] = []
        self._answers: List[discord.Message] = []
        self._threads: List[discord.Thread] = []
        self._last_post = 0.0
        self._own_threads: List[discord.Thread] = []
        self.typing: List[tuple] = []
        self.residue: List[str] = []
        self.deleted = 0

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> 'DriverBot':
        self._thread = threading.Thread(target=self._loop_forever, name='discord-driver-loop', daemon=True)
        self._thread.start()
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        self.client = discord.Client(intents=intents)

        @self.client.event
        async def on_ready():
            self._ready.set()

        @self.client.event
        async def on_typing(channel, user, when):
            # Typing is how the node's showTyping is observed from outside.
            self.typing.append((channel.id, getattr(user, 'id', None), time.time()))

        future = asyncio.run_coroutine_threadsafe(self.client.start(load_driver_token(self.config)), self.loop)
        deadline = time.time() + 60
        while time.time() < deadline:
            if self._ready.wait(timeout=0.5):
                return self
            if future.done():
                error = future.exception()
                if error is not None:
                    raise error
                break
        raise RuntimeError('Discord driver bot did not become ready within 60s')

    def _loop_forever(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro, timeout: float = 120):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=timeout)

    def close(self):
        try:
            self.run(self.client.close(), timeout=30)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=10)

    # -- guild helpers ------------------------------------------------------
    @property
    def bot_id(self) -> int:
        return int(self.config['driverBotId'])

    @property
    def channel(self):
        channel_id = int(self.config['supportChannelId'])
        return self.client.get_channel(channel_id) or self.run(self.client.fetch_channel(channel_id))

    # -- posting / reading --------------------------------------------------
    def post(
        self,
        text: Optional[str],
        channel=None,
        *,
        files: Optional[List[discord.File]] = None,
        embed: Optional[discord.Embed] = None,
        reference: Optional[discord.Message] = None,
        allowed_mentions: Optional[discord.AllowedMentions] = None,
    ) -> discord.Message:
        """Post one driver message, throttled so the pipeline is never raced.

        Mentions are suppressed unless ``allowed_mentions`` says otherwise: the
        test channel is visible to real people, and a test that puts
        ``@everyone`` or the team role in its text must not ping anyone.
        """
        target = channel if channel is not None else self.channel
        wait = E2E_POST_THROTTLE_SECONDS - (time.time() - self._last_post)
        if wait > 0:
            time.sleep(wait)
        kwargs: Dict[str, Any] = {
            'allowed_mentions': allowed_mentions if allowed_mentions is not None else discord.AllowedMentions.none()
        }
        if files:
            kwargs['files'] = files
        if embed is not None:
            kwargs['embed'] = embed
        if reference is not None:
            kwargs['reference'] = reference
            kwargs['mention_author'] = False
        message = self.run(target.send(text, **kwargs))
        self._last_post = time.time()
        self._posted.append(message)
        return message

    def delete(self, message: discord.Message):
        self.run(message.delete())

    def open_thread(self, name: str, message: Optional[discord.Message] = None, minutes: int = 60):
        """Create a thread as the driver (on ``message``, or a bare channel thread)."""
        if message is not None:
            thread = self.run(message.create_thread(name=name, auto_archive_duration=minutes))
        else:
            thread = self.run(
                self.channel.create_thread(
                    name=name, type=discord.ChannelType.public_thread, auto_archive_duration=minutes
                )
            )
        self._own_threads.append(thread)
        return thread

    def typing_by(self, user_id: int, channel_id: int, since: float) -> List[tuple]:
        return [
            entry for entry in list(self.typing) if entry[1] == user_id and entry[0] == channel_id and entry[2] >= since
        ]

    def refetch(self, message: discord.Message) -> discord.Message:
        return self.run(message.channel.fetch_message(message.id))

    def wait_for_thread(self, message: discord.Message, timeout: float = 60) -> Optional[discord.Thread]:
        """Wait for the node to open a thread on ``message`` and track it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            thread = getattr(self.refetch(message), 'thread', None)
            if thread is not None:
                self.track_thread(thread)
                return thread
            time.sleep(1.5)
        return None

    def track_thread(self, thread: discord.Thread):
        if thread is not None and thread.id not in [existing.id for existing in self._threads]:
            self._threads.append(thread)
        return thread

    def answers_after(self, channel, after: discord.Message, limit: int = 10) -> List[discord.Message]:
        """Messages posted after ``after`` by somebody other than the driver."""

        async def _collect():
            found = []
            async for message in channel.history(after=after, limit=limit, oldest_first=True):
                if message.author.id == self.bot_id or not _is_plain_message(message):
                    continue
                found.append(message)
            return found

        return self.run(_collect())

    def wait_for_answer(
        self, channel, after: discord.Message, timeout: float = 40, match=None
    ) -> Optional[discord.Message]:
        """Poll until the node's answer to ``after`` shows up (else ``None``)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            for message in self.answers_after(channel, after):
                if not message.content.strip():
                    continue
                if match is None or match(message):
                    self._answers.append(message)
                    return message
            time.sleep(2.0)
        return None

    # -- cleanup ------------------------------------------------------------
    def cleanup(self) -> List[str]:
        """Delete the driver's own messages; archive the node's threads."""
        residue: List[str] = []

        async def _delete():
            deleted = 0
            for message in self._posted:
                try:
                    channel = message.channel
                    if getattr(channel, 'archived', False):
                        await channel.edit(archived=False)
                    await message.delete()
                    deleted += 1
                    await asyncio.sleep(0.35)
                except discord.NotFound:
                    continue
                except Exception as error:
                    residue.append(f'undeleted driver message {message.id}: {type(error).__name__}')
            return deleted

        async def _archive():
            for thread in self._own_threads:
                try:
                    await thread.edit(archived=True)
                    residue.append(f'archived driver thread {thread.name!r} ({thread.id})')
                except Exception as error:
                    residue.append(f'driver thread {thread.name!r} ({thread.id}) not archived: {type(error).__name__}')
            for thread in self._threads:
                try:
                    await thread.edit(archived=True)
                    residue.append(f'archived thread {thread.name!r} ({thread.id})')
                except Exception as error:
                    # Only the thread's creator (the node) or Manage Threads can
                    # archive it; the thread then auto-archives on its own timer.
                    residue.append(f'open thread {thread.name!r} ({thread.id}): {type(error).__name__}')

        try:
            self.deleted = self.run(_delete(), timeout=300)
        except Exception as error:
            residue.append(f'driver cleanup error: {type(error).__name__}')
        try:
            self.run(_archive(), timeout=120)
        except Exception as error:
            residue.append(f'thread archive error: {type(error).__name__}')
        if self._answers:
            residue.append(f'{len(self._answers)} node answer(s) left (the driver cannot delete other bots posts)')
        self.residue = residue
        return residue


# -----------------------------------------------------------------------------
# Fixtures
# -----------------------------------------------------------------------------


@pytest.fixture(scope='session')
def live_bot():
    """One connected bot per session; cleans up every posted message at the end."""
    if os.environ.get(LIVE_ENV_FLAG) != '1':
        pytest.skip(f'{LIVE_ENV_FLAG}=1 not set')
    if not token_file():
        pytest.skip(f'{TOKEN_FILE_ENV} not set (path of a JSON file holding the bot token)')
    if not os.path.exists(token_file()):
        pytest.skip(f'{TOKEN_FILE_ENV} names a file that does not exist')
    ids = live_ids()
    missing = [key for key in ('guildId', 'primaryChannelId', 'guestChannelId', 'botUserId') if not ids.get(key)]
    if missing:
        pytest.skip(f'live ids missing: {", ".join(missing)} (set {IDS_FILE_ENV} or DISCORD_LIVE_<KEY> for each)')
    harness = LiveBot().start()
    try:
        yield harness
    finally:
        residue = harness.cleanup()
        print('\n--- live cleanup ---')
        print(f'deleted {harness.deleted} bot message(s)')
        for line in residue:
            print(f'residue: {line}')
        harness.close()
