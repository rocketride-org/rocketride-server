# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""L4 full engine suite: every base discord node feature through a real engine.

L3 (``test_engine_e2e.py``) proves the node runs under the engine. This layer
walks every base feature, success and failure, through real pipelines on the
engine, driven by the driver bot in the test channel only:

- ``echo`` is discord -> a ``response_text`` node keyed ``answers``, so the
  answer is the question's own text (plus whatever the node adds, such as
  merged attachments).
- ``fake`` is discord -> prompt -> ``llm_openai_api`` pointed at
  :mod:`fake_llm`, a scripted local endpoint for scratchpad, envelope, error,
  empty, retry, raising and slow answers. No real model is involved.
- **One realistic AI run** (F46) on a saved AI pipe, with any Slack tool and
  database components removed.

Each test posts messages tagged ``[e2e Fxx]``, one at a time, and records a
result row (feature, case, expected, actual, pass/fail, evidence) to a JSONL
file under ``DISCORD_E2E_RESULTS_DIR`` (default: the system temp directory).

Gates (all must hold, else the module skips): ``DISCORD_LIVE=1``,
``DISCORD_E2E_FULL=1`` (the run takes a while and restarts tasks many times),
the L3 gates, and ``botUserId`` in the engine id block. Optional gates:

- ``DISCORD_E2E_ENGINE_DIR`` (+ ``DISCORD_E2E_ENGINE_LOG``): F45 kills and
  restarts the engine process on ``engineUri``'s port.
- ``DISCORD_E2E_AI_PIPE``: a saved AI pipe with a discord source, for F46.
- ``DISCORD_E2E_ENGINE_LOG``: the engine's log file, grepped for evidence.
- ``DISCORD_E2E_PG_CONTAINER`` / ``_PG_HOST`` / ``_PG_USER`` / ``_PG_DATABASE``
  (plus the engine variable ``ROCKETRIDE_DISCORD_PG_PASSWORD``): a disposable
  PostgreSQL container for the capture cases (F32..F34). They drop and create
  the capture table in that database, and F34 stops and starts the container,
  so they also need ``DISCORD_E2E_PG_DISPOSABLE`` set to exactly
  ``<container>/<database>``, and they refuse a database that holds any other
  table.
"""

import json
import os
import re
import subprocess
import tempfile
import time
import wave
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

import discord
import pytest

from .fake_llm import ERROR_TEXT, FINAL_CONTENT, RETRY_ANSWER, FakeLLM
from .live_support import EngineSession, engine_reachable, live_ids, live_only
from .test_engine_e2e import SKIP_REASON as L3_SKIP_REASON

TASK_STATE_RUNNING = 3
PROJECT_ID = '5d1f0e2a-7c3b-4e9a-8f21-6b0c9d4e3a17'
ESCALATION_LINE = 'Escalated to the RocketRide team.'
FAKE_ROLE_ID = '900000000000000301'
FAKE_CHANNEL_ID = '900000000000000302'
QUIET_SECONDS = 15
# capture.BACKOFF_SECONDS: how long the node drops capture rows after a failed write.
CAPTURE_BACKOFF_SECONDS = 60
RUN_STAMP = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
RESULTS_DIR = os.environ.get('DISCORD_E2E_RESULTS_DIR', '') or os.path.join(tempfile.gettempdir(), 'discord-e2e-full')
RESULTS_PATH = os.path.join(RESULTS_DIR, f'{RUN_STAMP}.jsonl')

ENGINE_DIR = os.environ.get('DISCORD_E2E_ENGINE_DIR', '')
ENGINE_LOG = os.environ.get('DISCORD_E2E_ENGINE_LOG', '')
PG_CONTAINER = os.environ.get('DISCORD_E2E_PG_CONTAINER', '')
PG_HOST = os.environ.get('DISCORD_E2E_PG_HOST', '')
PG_USER = os.environ.get('DISCORD_E2E_PG_USER', '')
PG_DATABASE = os.environ.get('DISCORD_E2E_PG_DATABASE', '')
AI_PIPE = os.environ.get('DISCORD_E2E_AI_PIPE', '')


def _full_gate() -> str:
    if L3_SKIP_REASON:
        return L3_SKIP_REASON
    if os.environ.get('DISCORD_E2E_FULL') != '1':
        return 'DISCORD_E2E_FULL=1 not set (the full suite runs ~30 minutes)'
    from .live_support import load_engine_config

    if not load_engine_config().get('botUserId'):
        return 'botUserId (the bot under test) missing from the engine id block'
    return ''


FULL_SKIP = _full_gate()
pytestmark = [live_only, pytest.mark.skipif(bool(FULL_SKIP), reason=FULL_SKIP or 'full suite enabled')]
PG_DISPOSABLE = os.environ.get('DISCORD_E2E_PG_DISPOSABLE', '')


def _pg_gate() -> str:
    """Why the capture cases cannot run, or '' when they may.

    F32 drops the capture table and F34 stops the container, so naming a
    database is not enough: the operator must also confirm that exact
    container and database are disposable.
    """
    if not (PG_CONTAINER and PG_HOST and PG_USER and PG_DATABASE):
        return 'DISCORD_E2E_PG_* not set'
    expected = f'{PG_CONTAINER}/{PG_DATABASE}'
    if PG_DISPOSABLE != expected:
        return (
            f'DISCORD_E2E_PG_DISPOSABLE must be "{expected}" to confirm that container may be stopped '
            'and that database may have its discord_events table dropped'
        )
    return ''


PG_SKIP = _pg_gate()
needs_pg = pytest.mark.skipif(bool(PG_SKIP), reason=PG_SKIP or 'capture cases enabled')


def _require_disposable_database():
    """Refuse to touch a database that holds anything but the capture table."""
    others = _psql(
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') "
        "AND tablename <> 'discord_events'"
    )
    # The cases are switched on, so an unreachable database is a setup error.
    assert others.isdigit(), f'cannot query {PG_DATABASE} in {PG_CONTAINER}: {others!r}'
    if others != '0':
        pytest.skip(f'{PG_DATABASE} holds {others} other table(s); the capture cases need a disposable database')


needs_engine_dir = pytest.mark.skipif(not ENGINE_DIR, reason='DISCORD_E2E_ENGINE_DIR not set')
needs_ai_pipe = pytest.mark.skipif(not AI_PIPE, reason='DISCORD_E2E_AI_PIPE not set')


# -----------------------------------------------------------------------------
# Result rows
# -----------------------------------------------------------------------------


def _record(fid: str, feature: str, case: str, expected: str, actual: str, ok: bool, evidence: str):
    row = {
        'id': fid,
        'feature': feature,
        'case': case,
        'expected': expected,
        'actual': actual,
        'result': 'PASS' if ok else 'FAIL',
        'evidence': evidence,
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    os.makedirs(os.path.dirname(RESULTS_PATH), exist_ok=True)
    with open(RESULTS_PATH, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    print(f'\n{fid} {row["result"]} | {feature} | {case} | {actual} | {evidence}')


def _check(fid, feature, case, expected, ok, actual, evidence=''):
    """Record a row, then fail the test when the row failed."""
    _record(fid, feature, case, expected, actual, bool(ok), evidence)
    assert ok, f'{fid} {case}: expected {expected}; got {actual}'


# -----------------------------------------------------------------------------
# Pipelines
# -----------------------------------------------------------------------------


def _params(config: Dict[str, str], **overrides) -> Dict[str, Any]:
    """Discord parameters every test starts from: support channel only, the
    driver bot allowed, events on, typing off (F09 turns it on).
    """
    params: Dict[str, Any] = {
        'botToken': '${ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN}',
        'guildIds': ['${ROCKETRIDE_DISCORD_GUILD_ID}'],
        'channelIds': ['${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}'],
        'allowedBotIds': [config['driverBotId']],
        'replyMode': 'reply',
        'threadAutoArchiveMinutes': 60,
        'showTyping': False,
        'emitNoReply': True,
        'emitOutbound': True,
    }
    params.update(overrides)
    return params


def _discord_component(params: Dict[str, Any]) -> Dict[str, Any]:
    return {
        'id': 'discord_1',
        'provider': 'discord',
        'config': {'hideForm': True, 'mode': 'Source', 'type': 'discord', 'parameters': params},
    }


def _echo(params: Dict[str, Any]) -> Dict[str, Any]:
    """Discord -> response_text keyed ``answers``: the answer is the text the node sent."""
    return {
        'project_id': PROJECT_ID,
        'version': 1,
        'components': [
            _discord_component(params),
            {
                'id': 'echo_1',
                'provider': 'response_text',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'text', 'from': 'discord_1'}],
            },
        ],
    }


def _fake(params: Dict[str, Any], fake: FakeLLM) -> Dict[str, Any]:
    """Discord -> prompt -> llm_openai_api (the scripted fake) -> answers."""
    return {
        'project_id': PROJECT_ID,
        'version': 1,
        'components': [
            _discord_component(params),
            {
                'id': 'prompt_1',
                'provider': 'prompt',
                'config': {'instructions': ['Answer the user.']},
                'input': [{'lane': 'text', 'from': 'discord_1'}],
            },
            {
                'id': 'llm_1',
                'provider': 'llm_openai_api',
                'config': {
                    'profile': 'custom',
                    'custom': {
                        'model': 'fake-e2e',
                        'base_url': fake.base_url,
                        'modelTotalTokens': 32768,
                        'apikey': 'sk-fake-e2e',
                    },
                },
                'input': [{'lane': 'questions', 'from': 'prompt_1'}],
            },
            {
                'id': 'answers_1',
                'provider': 'response_answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': 'llm_1'}],
            },
        ],
    }


def _with_capture(pipeline: Dict[str, Any], source: Optional[str] = 'e2e:full', user: str = '') -> Dict[str, Any]:
    """Add a db_postgres capture component, in the disposable test database.

    The database node is connected to the Discord source only, as the node
    README requires of a capture database. ``user`` replaces
    ``DISCORD_E2E_PG_USER`` as the database user (same password).
    """
    params = pipeline['components'][0]['config']['parameters']
    params.update({'captureEvents': True, 'captureNodeId': 'capture_db'})
    if source:
        params['captureSource'] = source
    pipeline['components'].append(
        {
            'id': 'capture_db',
            'provider': 'db_postgres',
            'config': {
                'profile': 'default',
                'default': {
                    'host': PG_HOST,
                    'user': user or PG_USER,
                    'password': '${ROCKETRIDE_DISCORD_PG_PASSWORD}',
                    'database': PG_DATABASE,
                    'table': 'discord_events',
                    'allow_execute': True,
                },
                'parameters': {},
            },
            'control': [{'classType': 'tool', 'from': 'discord_1'}],
        }
    )
    return pipeline


def _start(engine: EngineSession, pipeline: Dict[str, Any]) -> str:
    """(Re)start ``pipeline`` and wait for the node to log in."""
    engine.start_pipe(pipeline, mode=f'run-{time.time()}', login_timeout=45)
    assert 'logged in as' in engine.login_status, f'node did not log in: {engine.login_status!r}'
    return engine.login_status


def _start_raw(engine: EngineSession, pipeline: Dict[str, Any], settle: float = 20) -> Dict[str, Any]:
    """Start a pipe that may fail on purpose; report what the engine says."""
    engine.terminate()
    engine.events.clear()
    outcome: Dict[str, Any] = {'error': '', 'status': '', 'state': None}
    try:
        result = engine.run(engine.client.use(pipeline=pipeline, source='discord_1', ttl=0), timeout=120)
        engine.token = result.get('token') if isinstance(result, dict) else str(result)
        engine.mode = f'raw-{time.time()}'
        engine.run(engine.client.set_events(engine.token, ['SSE', 'FLOW', 'TASK']), timeout=30)
    except Exception as error:
        outcome['error'] = f'{type(error).__name__}: {error}'[:400]
        return outcome
    deadline = time.time() + settle
    while time.time() < deadline:
        try:
            status = engine.status()
            outcome['status'] = str(status.get('status') or '')[:400]
            state = status.get('state')
            outcome['state'] = int(getattr(state, 'value', state) or 0)
            errors = status.get('errors') or []
            if errors:
                outcome['errors'] = [str(item)[:300] for item in errors][:3]
            if 'logged in as' in outcome['status'] or outcome['state'] not in (None, 0, 1, 2, 3):
                break
        except Exception as error:
            outcome['error'] = f'{type(error).__name__}: {error}'[:400]
            break
        time.sleep(1.5)
    return outcome


# -----------------------------------------------------------------------------
# Observation helpers
# -----------------------------------------------------------------------------


def _tag(fid: str) -> str:
    return f'[e2e {fid}]'


def _has(tag: str) -> Callable[[discord.Message], bool]:
    return lambda message: tag in message.content


def _answer(driver, channel, posted, tag, timeout: float = 45):
    return driver.wait_for_answer(channel, posted, timeout=timeout, match=_has(tag))


def _quiet(driver, channel, posted, tag, settle: float = QUIET_SECONDS) -> List[discord.Message]:
    """Wait ``settle`` seconds; return anything the bot posted carrying ``tag``."""
    time.sleep(settle)
    return [message for message in driver.answers_after(channel, posted) if tag in message.content]


def _event(engine, event_type: str, correlation_id, timeout: float = 30) -> Optional[Dict[str, Any]]:
    try:
        return engine.wait_for_discord_event(event_type, correlation_id, timeout=timeout)
    except AssertionError:
        return None


def _events(engine, event_type: str, correlation_id) -> List[Dict[str, Any]]:
    return engine.discord_events(event_type, correlation_id)


def _reason(engine, correlation_id, timeout: float = 30) -> str:
    event = _event(engine, 'no_reply', correlation_id, timeout=timeout)
    return str(event.get('reason')) if event else '<no no_reply event>'


def _log_tail(since_bytes: int, pattern: str) -> List[str]:
    """Lines matching ``pattern`` that the engine logged after ``since_bytes``."""
    if not ENGINE_LOG or not os.path.exists(ENGINE_LOG):
        return []
    with open(ENGINE_LOG, encoding='utf-8', errors='replace') as handle:
        handle.seek(since_bytes)
        return [line.strip()[:240] for line in handle if re.search(pattern, line)]


def _log_size() -> int:
    return os.path.getsize(ENGINE_LOG) if ENGINE_LOG and os.path.exists(ENGINE_LOG) else 0


def _psql(sql: str) -> str:
    """Run ``sql`` in the test database through ``psql`` inside its container."""
    result = subprocess.run(
        ['docker', 'exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DATABASE, '-tAc', sql],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return (result.stdout or result.stderr).strip()


def _media(tmpdir: str) -> Dict[str, str]:
    """A tiny png, wav and mp4 plus two text-like files, all generated here."""
    paths = {}
    png = os.path.join(tmpdir, 'pixel.png')
    with open(png, 'wb') as handle:
        handle.write(
            bytes.fromhex(
                '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082'
            )
        )
    paths['png'] = png
    wav = os.path.join(tmpdir, 'tone.wav')
    with wave.open(wav, 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b'\x00\x00' * 1600)
    paths['wav'] = wav
    mp4 = os.path.join(tmpdir, 'clip.mp4')
    try:
        subprocess.run(
            ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.4']
            + ['-pix_fmt', 'yuv420p', mp4],
            check=True,
            timeout=60,
        )
    except Exception:
        with open(mp4, 'wb') as handle:
            handle.write(b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 64)
    paths['mp4'] = mp4
    notes = os.path.join(tmpdir, 'notes.md')
    with open(notes, 'w', encoding='utf-8') as handle:
        handle.write('# notes\nNOTES-BODY-MARKER: the pipeline must see this line.\n')
    paths['md'] = notes
    blob = os.path.join(tmpdir, 'data.bin')
    with open(blob, 'wb') as handle:
        handle.write(bytes(range(256)) * 4)
    paths['bin'] = blob
    return paths


def _files(*paths: str) -> List[discord.File]:
    return [discord.File(path) for path in paths]


# -----------------------------------------------------------------------------
# Fixtures
# -----------------------------------------------------------------------------


@pytest.fixture(scope='module')
def fake_llm():
    server = FakeLLM().start()
    try:
        yield server
    finally:
        server.close()
        # The request log is the evidence for every fake-model case.
        os.makedirs(os.path.dirname(RESULTS_PATH), exist_ok=True)
        with open(RESULTS_PATH.replace('.jsonl', '-fake-calls.json'), 'w', encoding='utf-8') as handle:
            json.dump(server.calls, handle, indent=1, ensure_ascii=False)


@pytest.fixture(scope='module')
def tmp_media():
    with tempfile.TemporaryDirectory(prefix='discord-e2e-') as tmpdir:
        yield _media(tmpdir)


@pytest.fixture(scope='module')
def bot_id(engine_config) -> int:
    return int(engine_config['botUserId'])


# =============================================================================
# Basics
# =============================================================================


def test_f01_reply_mode_channel(engine, engine_config, driver_bot):
    tag = _tag('F01')
    _start(engine, _echo(_params(engine_config, replyMode='channel')))
    posted = driver_bot.post(f'{tag} channel mode question')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    outbound = _event(engine, 'outbound', posted.id)
    ok = answer is not None and answer.reference is None and outbound and outbound['destination'] == 'channel'
    _check(
        'F01',
        'replyMode',
        'channel',
        'plain channel message, no reply reference, outbound destination=channel',
        ok,
        f'answer={getattr(answer, "id", None)} reference={getattr(answer, "reference", None)} '
        f'destination={outbound and outbound["destination"]}',
        f'outbound messageIds={outbound and outbound["messageIds"]}',
    )


def test_f02_reply_mode_reply(engine, engine_config, driver_bot):
    tag = _tag('F02')
    _start(engine, _echo(_params(engine_config, replyMode='reply')))
    posted = driver_bot.post(f'{tag} reply mode question')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    outbound = _event(engine, 'outbound', posted.id)
    ref = answer.reference.message_id if answer is not None and answer.reference else None
    pinged = bool(answer and answer.mentions)
    ok = answer is not None and ref == posted.id and not pinged and outbound and outbound['destination'] == 'reply'
    _check(
        'F02',
        'replyMode',
        'reply',
        'native reply to the question, author not pinged, destination=reply',
        ok,
        f'reference={ref} posted={posted.id} mentions={[m.id for m in (answer.mentions if answer else [])]}',
        f'destination={outbound and outbound["destination"]}',
    )


def test_f03_reply_mode_thread_and_naming(engine, engine_config, driver_bot):
    tag = _tag('F03')
    # 'Q: ' + content cut at 25 lands on a space: the name must come back stripped.
    _start(
        engine,
        _echo(_params(engine_config, replyMode='thread', threadName='Q: {content}', threadNameMaxLength=25)),
    )
    content = f'{tag} thread name test with words'
    posted = driver_bot.post(content)
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    answer = _answer(driver_bot, thread, posted, tag) if thread else None
    outbound = _event(engine, 'outbound', posted.id)
    expected_name = ('Q: ' + content)[:25].strip()
    ok = (
        thread is not None
        and thread.name == expected_name
        and len(thread.name) <= 25
        and answer is not None
        and outbound
        and outbound['destination'] == 'thread'
    )
    _check(
        'F03',
        'replyMode / thread naming',
        'thread mode, template "Q: {content}", max length 25 (cut on a space)',
        f'thread {expected_name!r}, answer inside, destination=thread',
        ok,
        f'thread={getattr(thread, "name", None)!r} answer_in_thread={answer is not None} '
        f'destination={outbound and outbound["destination"]}',
        f'thread {getattr(thread, "id", None)}',
    )


def test_f04_thread_name_from_attachment(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F04')
    # The .md must be read as text, or an attachment-only message has no answer
    # and the node never opens a thread.
    _start(
        engine,
        _echo(_params(engine_config, replyMode='thread', threadName='{content}', textAttachmentExtensions=['.md'])),
    )
    posted = driver_bot.post(None, files=_files(tmp_media['md']))
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    ok = thread is not None and thread.name == 'notes.md'
    _check(
        'F04',
        'thread naming',
        'attachment-only message (no text)',
        'thread named after the first attachment (notes.md)',
        ok,
        f'thread={getattr(thread, "name", None)!r}',
        f'posted {posted.id}',
    )
    del tag


def test_f05_archive_minutes_valid_and_invalid(engine, engine_config, driver_bot):
    tag = _tag('F05')
    results = []
    for minutes in (60, 61):
        _start(engine, _echo(_params(engine_config, replyMode='thread', threadAutoArchiveMinutes=minutes)))
        posted = driver_bot.post(f'{tag} archive {minutes}')
        thread = driver_bot.wait_for_thread(posted, timeout=45)
        answer = _answer(driver_bot, thread, posted, tag) if thread else None
        results.append((minutes, getattr(thread, 'auto_archive_duration', None), answer is not None))
    valid, invalid = results
    ok = valid[1] == 60 and valid[2] and invalid[1] in (60, 1440, 4320, 10080) and invalid[2]
    _check(
        'F05',
        'threadAutoArchiveMinutes',
        '60 (valid) and 61 (invalid)',
        '60 -> thread archives after 60; 61 -> channel default used, answer still posted',
        ok,
        f'60 -> duration {valid[1]}, answered {valid[2]}; 61 -> duration {invalid[1]}, answered {invalid[2]}',
        'thread.auto_archive_duration read back by the driver',
    )


def test_f06_require_mention_global(engine, engine_config, driver_bot, bot_id):
    tag = _tag('F06')
    _start(engine, _echo(_params(engine_config, requireMention=True)))
    plain = driver_bot.post(f'{tag} no mention')
    quiet = _quiet(driver_bot, driver_bot.channel, plain, tag)
    no_event = not _events(engine, 'message', plain.id)
    mentioned = driver_bot.post(
        f'<@{bot_id}> {tag} with mention', allowed_mentions=discord.AllowedMentions(users=[discord.Object(bot_id)])
    )
    answer = _answer(driver_bot, driver_bot.channel, mentioned, tag)
    ok = not quiet and no_event and answer is not None
    _check(
        'F06',
        'requireMention',
        'global: without and with a bot mention',
        'ignored (no event) without the mention; answered with it',
        ok,
        f'without: posts={len(quiet)} message_event={not no_event}; with: answered={answer is not None}',
        f'questions {plain.id}, {mentioned.id}',
    )


def test_f07_require_mention_per_channel(engine, engine_config, driver_bot, bot_id):
    tag = _tag('F07')
    _start(
        engine,
        _echo(
            _params(
                engine_config,
                requireMention=False,
                requireMentionChannelIds=['${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}'],
                replyMode='thread',
            )
        ),
    )
    plain = driver_bot.post(f'{tag} no mention')
    quiet = _quiet(driver_bot, driver_bot.channel, plain, tag)
    mentioned = driver_bot.post(
        f'<@{bot_id}> {tag} with mention', allowed_mentions=discord.AllowedMentions(users=[discord.Object(bot_id)])
    )
    thread = driver_bot.wait_for_thread(mentioned, timeout=45)
    answer = _answer(driver_bot, thread, mentioned, tag) if thread else None
    # A follow-up in the thread inherits the parent's rule.
    follow = driver_bot.post(f'{tag} follow-up without mention', channel=thread) if thread else None
    follow_quiet = _quiet(driver_bot, thread, follow, f'{tag} follow-up') if follow else ['no thread']
    ok = not quiet and answer is not None and not follow_quiet
    _check(
        'F07',
        'requireMentionChannelIds',
        'support channel listed: plain, mentioned, thread follow-up without mention',
        'plain ignored; mentioned answered; follow-up in its thread ignored (parent rule applies)',
        ok,
        f'plain posts={len(quiet)}; mentioned answered={answer is not None}; follow-up posts={len(follow_quiet)}',
        f'thread {getattr(thread, "id", None)}',
    )


def test_f08_guild_and_channel_filters(engine, engine_config, driver_bot):
    tag = _tag('F08')
    # A guild id that does not exist, so the support channel's own guild is never allowlisted.
    other_guild = '900000000000000303'
    rows = []
    for label, overrides in (
        ('other guild', {'guildIds': [other_guild]}),
        ('other channel', {'channelIds': [FAKE_CHANNEL_ID]}),
    ):
        _start(engine, _echo(_params(engine_config, **overrides)))
        posted = driver_bot.post(f'{tag} {label}')
        quiet = _quiet(driver_bot, driver_bot.channel, posted, tag)
        rows.append((label, len(quiet), bool(_events(engine, 'message', posted.id))))
    ok = all(count == 0 and not event for _, count, event in rows)
    _check(
        'F08',
        'guildIds / channelIds',
        'support channel outside the guild allowlist; outside the channel allowlist',
        'both ignored: no post, no message event',
        ok,
        '; '.join(f'{label}: posts={count} event={event}' for label, count, event in rows),
        'allowlisted case is every other test',
    )


def test_f09_ignore_bots_and_allowed_bot_ids(engine, engine_config, driver_bot):
    tag = _tag('F09')
    rows = []
    for label, overrides, expect_answer in (
        ('ignoreBots on, driver not allowlisted', {'allowedBotIds': []}, False),
        ('ignoreBots off', {'allowedBotIds': [], 'ignoreBots': False}, True),
        ('ignoreBots on, driver allowlisted', {}, True),
    ):
        _start(engine, _echo(_params(engine_config, **overrides)))
        posted = driver_bot.post(f'{tag} {label}')
        if expect_answer:
            got = _answer(driver_bot, driver_bot.channel, posted, tag) is not None
        else:
            got = bool(_quiet(driver_bot, driver_bot.channel, posted, tag))
        rows.append((label, expect_answer, got))
    ok = all(expect == got for _, expect, got in rows)
    _check(
        'F09',
        'ignoreBots / allowedBotIds',
        'driver bot not allowlisted; ignoreBots off; allowlisted',
        'ignored; answered; answered',
        ok,
        '; '.join(f'{label}: answered={got}' for label, _, got in rows),
        'driver is a bot account',
    )


def test_f10_typing_indicator(engine, engine_config, driver_bot, fake_llm, bot_id):
    tag = _tag('F10')
    rows = []
    for show in (True, False):
        _start(engine, _fake(_params(engine_config, showTyping=show), fake_llm))
        since = time.time()
        posted = driver_bot.post(f'{tag} typing={show} [fake:slow:6]')
        answer = _answer(driver_bot, driver_bot.channel, posted, 'Fake answer after 6s', timeout=60)
        typing = driver_bot.typing_by(bot_id, driver_bot.channel.id, since)
        rows.append((show, len(typing), answer is not None))
    ok = rows[0][1] >= 1 and rows[0][2] and rows[1][1] == 0 and rows[1][2]
    _check(
        'F10',
        'showTyping',
        'on and off around a 6 s pipeline',
        'typing event(s) from the bot when on, none when off; answered both times',
        ok,
        '; '.join(f'showTyping={show}: typing events={count}, answered={ans}' for show, count, ans in rows),
        'driver on_typing gateway events',
    )


def test_f11_send_responses_off(engine, engine_config, driver_bot):
    tag = _tag('F11')
    _start(engine, _echo(_params(engine_config, sendResponses=False)))
    posted = driver_bot.post(f'{tag} listen only')
    quiet = _quiet(driver_bot, driver_bot.channel, posted, tag)
    outbound = _event(engine, 'outbound', posted.id)
    message = _event(engine, 'message', posted.id, timeout=5)
    ok = not quiet and message is not None and outbound and outbound['destination'] == 'suppressed'
    _check(
        'F11',
        'sendResponses',
        'off (listen only)',
        'message ingested, nothing posted, outbound destination=suppressed with the answer text',
        ok,
        f'posts={len(quiet)} message_event={message is not None} destination={outbound and outbound["destination"]}',
        f'outbound text={(outbound or {}).get("text", "")[:60]!r}',
    )


# =============================================================================
# Answers
# =============================================================================


def _long_text(fid: str, lines: int) -> str:
    return '\n'.join(f'{fid} line {index:04d} ' + 'x' * 12 for index in range(lines))


def _chunks_in(thread, driver, posted) -> List[discord.Message]:
    return [message for message in driver.answers_after(thread, posted, limit=50) if message.content.strip()]


_LABEL = re.compile(r'\n*\*\(\d+/\d+\)\*$')


def _reassemble(chunks: List[discord.Message], fid: str):
    """Undo the chunker: drop labels and the synthetic fence close/reopen.

    Returns the rebuilt text and how many chunk boundaries fell mid-line: the
    last line before a synthetic closing fence is not one whole ``<fid> line``.
    A boundary between lines consumes that newline (the fence pair stands in
    for it), so the parts are joined with one.
    """
    whole = re.compile(rf'{re.escape(fid)} line \d{{4}} x{{12}}')
    parts, midline = [], 0
    for index, chunk in enumerate(chunks):
        text = _LABEL.sub('', chunk.content).rstrip()
        if index < len(chunks) - 1 and text.endswith('\n```'):
            text = text[: -len('\n```')]
            if not whole.fullmatch(text.rsplit('\n', 1)[-1]):
                midline += 1
        if index > 0 and text.startswith('```\n'):
            text = text[len('```\n') :]
        parts.append(text)
    return '\n'.join(parts), midline


def test_f12_long_answer_split(engine, engine_config, driver_bot, tmp_media):
    rows = []
    for fid, number in (('F12a', False), ('F12b', True)):
        tag = _tag(fid)
        _start(
            engine,
            _echo(
                _params(
                    engine_config,
                    replyMode='thread',
                    mergeAttachments=True,
                    textAttachmentExtensions=['.txt'],
                    textAttachmentMaxChars=20000,
                    numberChunks=number,
                )
            ),
        )
        path = os.path.join(os.path.dirname(tmp_media['md']), f'{fid}.txt')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(_long_text(fid, 180))
        posted = driver_bot.post(f'{tag} long answer', files=_files(path))
        thread = driver_bot.wait_for_thread(posted, timeout=45)
        time.sleep(12)
        chunks = _chunks_in(thread, driver_bot, posted) if thread else []
        joined, midline = _reassemble(chunks, fid)
        lines_seen = [int(n) for n in re.findall(rf'{fid} line (\d{{4}}) x{{12}}', joined)]
        labels = re.findall(r'\*\((\d+)/(\d+)\)\*', '\n'.join(chunk.content for chunk in chunks))
        rows.append(
            {
                'fid': fid,
                'number': number,
                'chunks': len(chunks),
                'max_len': max((len(c.content) for c in chunks), default=0),
                'ordered': lines_seen == list(range(180)),
                'labels': labels,
                'midline': midline,
            }
        )
    plain, numbered = rows
    ok = (
        plain['chunks'] >= 3
        and plain['max_len'] <= 2000
        and plain['ordered']
        and plain['midline'] == 0
        and numbered['midline'] == 0
        and not plain['labels']
        and numbered['chunks'] >= 3
        and numbered['max_len'] <= 2000
        and numbered['ordered']
        and [int(i) for i, _ in numbered['labels']] == list(range(1, numbered['chunks'] + 1))
    )
    _check(
        'F12',
        'long answer split / numberChunks',
        '~5.5k-char answer, numberChunks off then on',
        'chunks <= 2000 chars, whole lines, in order; no labels when off; *(i/n)* labels 1..n when on',
        ok,
        f'off: {plain["chunks"]} chunks, max {plain["max_len"]}, ordered {plain["ordered"]}, labels {len(plain["labels"])}; '
        f'on: {numbered["chunks"]} chunks, max {numbered["max_len"]}, ordered {numbered["ordered"]}, '
        f'labels {["/".join(label) for label in numbered["labels"]]}',
        f'reassembled from the thread; boundaries cut mid-line inside the code fence: '
        f'off {plain["midline"]}, on {numbered["midline"]}; last chunk ends {(chunks[-1].content[-14:] if chunks else "")!r}',
    )


def test_f13_mentions_only_allowlisted_ping(engine, engine_config, driver_bot):
    tag = _tag('F13')
    driver_id = driver_bot.bot_id
    team_role = engine_config['teamRoleId']
    _start(
        engine,
        _echo(_params(engine_config, allowedMentionUserIds=[str(driver_id)], allowedMentionRoleIds=[FAKE_ROLE_ID])),
    )
    # The driver's own post pings nobody (mentions suppressed on send).
    posted = driver_bot.post(f'{tag} @everyone <@&{team_role}> <@{driver_id}> please look')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    ok = (
        answer is not None
        and answer.mention_everyone is False
        and [role.id for role in answer.role_mentions] == []
        and [user.id for user in answer.mentions] == [driver_id]
        and '@everyone' in answer.content
    )
    _check(
        'F13',
        'allowedMention*',
        'answer containing @everyone, the team role and the driver user; only the driver allowlisted',
        'only the allowlisted user is pinged; @everyone and the role stay inert text',
        ok,
        f'mention_everyone={getattr(answer, "mention_everyone", None)} '
        f'role_mentions={[r.id for r in (answer.role_mentions if answer else [])]} '
        f'user_mentions={"[driver]" if answer and [u.id for u in answer.mentions] == [driver_id] else [u.id for u in (answer.mentions if answer else [])]}',
        'team role deliberately not allowlisted (it would ping real people)',
    )


def test_f14_team_mention_alias(engine, engine_config, driver_bot):
    tag = _tag('F14')
    _start(
        engine,
        _echo(_params(engine_config, teamMentionAlias='@RocketRide team', allowedMentionRoleIds=[FAKE_ROLE_ID])),
    )
    posted = driver_bot.post(f'{tag} handing over to @RocketRide team now')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    content = answer.content if answer else ''
    ok = f'<@&{FAKE_ROLE_ID}>' in content and '@RocketRide team' not in content
    _check(
        'F14',
        'teamMentionAlias',
        'answer containing the literal alias',
        'alias rewritten to the first allowlisted role mention',
        ok,
        f'answer has role mention={f"<@&{FAKE_ROLE_ID}>" in content}, literal alias left={"@RocketRide team" in content}',
        f'answer {getattr(answer, "id", None)} (fake role id, nobody pinged)',
    )


# =============================================================================
# Attachments
# =============================================================================


def _binary_lanes(engine, message_id) -> List[str]:
    return [
        str(event.get('mimeType')) for event in _events(engine, 'message', message_id) if event.get('lane') == 'binary'
    ]


def test_f15_media_routing(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F15')
    _start(engine, _echo(_params(engine_config, textAttachmentExtensions=['.md'])))
    posted = driver_bot.post(
        f'{tag} media routing',
        files=_files(tmp_media['png'], tmp_media['wav'], tmp_media['mp4'], tmp_media['md']),
    )
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(6)
    mimes = _binary_lanes(engine, posted.id)
    texts = [event for event in _events(engine, 'message', posted.id) if event.get('lane') != 'binary']
    framed = any('[attachment notes.md]' in str(event.get('text', '')) for event in texts)
    ok = (
        answer is not None
        and any(m.startswith('image/') for m in mimes)
        and any(m.startswith('audio/') for m in mimes)
        and any(m.startswith('video/') for m in mimes)
        and framed
        and 'NOTES-BODY-MARKER' not in answer.content
    )
    _check(
        'F15',
        'attachments: image, audio, video, text',
        'png + wav + mp4 + .md with text, mergeAttachments off',
        'image/audio/video on their binary lanes; .md framed as text; reply is the text answer only',
        ok,
        f'binary lanes={mimes}; md framed={framed}; reply has file body={answer is not None and "NOTES-BODY-MARKER" in answer.content}',
        f'{len(texts)} text object(s), {len(mimes)} binary object(s)',
    )


def test_f16_merge_attachments_on(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F16')
    _start(engine, _echo(_params(engine_config, textAttachmentExtensions=['.md'], mergeAttachments=True)))
    posted = driver_bot.post(f'{tag} merged question', files=_files(tmp_media['md']))
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    text_events = [e for e in _events(engine, 'message', posted.id) if e.get('lane') != 'binary']
    ok = answer is not None and 'NOTES-BODY-MARKER' in answer.content and len(text_events) == 1
    _check(
        'F16',
        'mergeAttachments',
        'on: text + .md in one message',
        'ONE text pass containing the question and the file; answer shows both',
        ok,
        f'answer has file body={answer is not None and "NOTES-BODY-MARKER" in answer.content}; text passes={len(text_events)}',
        f'answer {getattr(answer, "id", None)}',
    )


def test_f17_text_extensions_off(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F17')
    _start(engine, _echo(_params(engine_config, textAttachmentExtensions=[], mergeAttachments=True)))
    posted = driver_bot.post(f'{tag} md without extension list', files=_files(tmp_media['md']))
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(4)
    mimes = _binary_lanes(engine, posted.id)
    ok = answer is not None and 'NOTES-BODY-MARKER' not in answer.content and len(mimes) == 1
    _check(
        'F17',
        'textAttachmentExtensions',
        'empty list (default): .md attachment',
        '.md is NOT read as text; it travels as a binary object',
        ok,
        f'answer has file body={answer is not None and "NOTES-BODY-MARKER" in answer.content}; binary lanes={mimes}',
        f'answer {getattr(answer, "id", None)}',
    )


def test_f18_oversized_and_unsupported(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F18')
    _start(engine, _echo(_params(engine_config, maxAttachmentBytes=600)))
    posted = driver_bot.post(f'{tag} big and odd files', files=_files(tmp_media['bin'], tmp_media['png']))
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(5)
    events = _events(engine, 'message', posted.id)
    mimes = _binary_lanes(engine, posted.id)
    group = sorted({event['metadata'].get('groupSize') for event in events})
    ok = answer is not None and mimes == ['image/png'] and group == [2]
    _check(
        'F18',
        'maxAttachmentBytes',
        '1 KB .bin over a 600-byte limit + a small png',
        'oversized file skipped (never opened, not counted); png still routed; text answered',
        ok,
        f'binary lanes={mimes}; groupSize={group}; answered={answer is not None}',
        f'{len(events)} message event(s)',
    )
    tag2 = _tag('F19')
    _start(engine, _echo(_params(engine_config)))
    posted2 = driver_bot.post(None, files=_files(tmp_media['bin']))
    quiet = _quiet(driver_bot, driver_bot.channel, posted2, '', settle=12)
    mimes2 = _binary_lanes(engine, posted2.id)
    reason = _reason(engine, posted2.id, timeout=10)
    ok2 = not quiet and mimes2 == ['application/octet-stream'] and reason == 'no_answer'
    _check(
        'F19',
        'unsupported attachment type',
        '.bin only (application/octet-stream)',
        'routed to the tag stream, no crash, nothing posted, no_reply reason no_answer',
        ok2,
        f'binary lanes={mimes2}; posts={len(quiet)}; no_reply={reason}',
        f'{tag2} attachment-only message {posted2.id}',
    )


# =============================================================================
# Support behaviour
# =============================================================================


def _node_section(fake: FakeLLM, question: str) -> str:
    """What the node sent for ``question``: its framing line plus the transcript."""
    needle = f"User's latest message: {question}"
    for call in reversed(list(fake.calls)):
        full = call.get('full', '')
        index = full.rfind(needle)
        if index >= 0:
            return full[index:]
    return ''


def test_f20_thread_history_and_limits(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F20')
    # The fake model answers "Fake answer: <first line of the question>", so an
    # answer never carries earlier turns and the transcript the node built is
    # read straight from the model's request log.
    params = _params(engine_config, replyMode='thread', threadHistoryLimit=2, threadHistoryMaxChars=4000)
    _start(engine, _fake(params, fake_llm))
    posted = driver_bot.post(f'{tag} opening question ALPHA')
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    _answer(driver_bot, thread, posted, 'ALPHA') if thread else None
    q1, q2 = f'{tag} follow-up BRAVO', f'{tag} follow-up CHARLIE'
    f1 = driver_bot.post(q1, channel=thread)
    a1 = _answer(driver_bot, thread, f1, 'BRAVO')
    f2 = driver_bot.post(q2, channel=thread)
    a2 = _answer(driver_bot, thread, f2, 'CHARLIE')
    s1, s2 = _node_section(fake_llm, q1), _node_section(fake_llm, q2)
    ev2 = _event(engine, 'message', f2.id) or {}
    # The prompt node pads the user turn with blank lines; they are not transcript.
    entries2 = s2.split('(oldest first, for context):\n', 1)[-1].rstrip().splitlines() if s2 else []

    # Character cap: same thread, a long history, a tiny cap.
    _start(engine, _fake(dict(params, threadHistoryLimit=10, threadHistoryMaxChars=80), fake_llm))
    q3 = f'{tag} follow-up DELTA'
    f3 = driver_bot.post(q3, channel=thread)
    a3 = _answer(driver_bot, thread, f3, 'DELTA')
    s3 = _node_section(fake_llm, q3)
    transcript3 = s3.split('(oldest first, for context):\n', 1)[-1].rstrip() if s3 else ''
    ev3 = _event(engine, 'message', f3.id) or {}
    ok = (
        a1 is not None
        and 'ALPHA' in s1
        and a2 is not None
        and len(entries2) == 2
        and 'ALPHA' not in s2
        and str(ev2.get('text', '')) == q2
        and a3 is not None
        and transcript3.startswith('\u2026\n')
        and len(transcript3) <= 82
        and int(ev3.get('contextChars') or 0) <= 82
    )
    _check(
        'F20',
        'threadHistoryLimit / threadHistoryMaxChars',
        'thread: opening, two follow-ups (limit 2); then a follow-up with an 80-char cap',
        "follow-ups carry earlier turns; only the last 2 messages at limit 2; cap keeps the newest 80 chars behind an ellipsis; SSE text is the user's own words",
        ok,
        f'1st follow-up saw the opening={"ALPHA" in s1}; 2nd follow-up entries={len(entries2)} saw the opening={"ALPHA" in s2}; '
        f'capped transcript {len(transcript3)} chars, ellipsis={transcript3.startswith(chr(8230))}, contextChars={ev3.get("contextChars")}',
        f"transcripts read from the fake model's request log; thread {getattr(thread, 'id', None)}",
    )


def test_f21_escalation_pause_resume_team_reply_and_restart(engine, engine_config, driver_bot, bot_id):
    tag = _tag('F21')
    params = _params(engine_config, replyMode='thread', escalationPause=True, escalationMarkers=[ESCALATION_LINE])
    _start(engine, _echo(params))
    posted = driver_bot.post(f'{tag} billing problem. {ESCALATION_LINE}')
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    first = _answer(driver_bot, thread, posted, tag) if thread else None
    silent = driver_bot.post(f'{tag} silent follow-up', channel=thread)
    silent_posts = _quiet(driver_bot, thread, silent, 'silent follow-up')
    silent_reason = _reason(engine, silent.id)
    team = driver_bot.post(f'{tag} team member: I will take this one', channel=thread)
    team_event = _event(engine, 'no_reply', team.id) or {}
    team_posts = _quiet(driver_bot, thread, team, 'team member', settle=8)
    mention = driver_bot.post(
        f'<@{bot_id}> {tag} mentioned follow-up',
        channel=thread,
        allowed_mentions=discord.AllowedMentions(users=[discord.Object(bot_id)]),
    )
    resumed = _answer(driver_bot, thread, mention, 'mentioned follow-up')
    after = driver_bot.post(f'{tag} plain after resume', channel=thread)
    after_answer = _answer(driver_bot, thread, after, 'plain after resume')
    ok = (
        first is not None
        and not silent_posts
        and silent_reason == 'paused'
        and team_event.get('reason') == 'paused'
        and 'I will take this one' in str(team_event.get('text', ''))
        and not team_posts
        and resumed is not None
        and after_answer is not None
    )
    _check(
        'F21',
        'escalationPause / markers / resume / team reply',
        'escalating answer, silent follow-up, team reply, @mention, plain follow-up',
        'paused after the marker; silent and team replies -> no_reply paused (team text on the event); @mention answered and unpauses',
        ok,
        f'silent={silent_reason} posts={len(silent_posts)}; team={team_event.get("reason")} text_on_event='
        f'{"I will take this one" in str(team_event.get("text", ""))}; mention answered={resumed is not None}; '
        f'after resume answered={after_answer is not None}',
        f'thread {getattr(thread, "id", None)}',
    )

    # Pause rebuilt after a pipeline restart: escalate again, restart, follow up.
    again = driver_bot.post(f'{tag} still broken. {ESCALATION_LINE}', channel=thread)
    _answer(driver_bot, thread, again, 'still broken')
    _start(engine, _echo(params))
    probe = driver_bot.post(f'{tag} after restart, no mention', channel=thread)
    probe_posts = _quiet(driver_bot, thread, probe, 'after restart')
    probe_reason = _reason(engine, probe.id)
    _check(
        'F22',
        'escalationPause',
        'pipeline restarted while the thread is escalated',
        'pause rebuilt from thread history: follow-up gets no_reply paused, nothing posted',
        not probe_posts and probe_reason == 'paused',
        f'posts={len(probe_posts)} no_reply={probe_reason}',
        f'thread {getattr(thread, "id", None)}',
    )


def test_f23_aimed_at_others_with_ack(engine, engine_config, driver_bot):
    tag = _tag('F23')
    driver_id = driver_bot.bot_id
    _start(engine, _echo(_params(engine_config, ignoreAimedAtOthers=True, ackEmoji='\U0001f440')))
    # Mention someone other than the bot: the driver mentions itself (harmless).
    posted = driver_bot.post(
        f'<@{driver_id}> {tag} this is for you, not the bot',
        allowed_mentions=discord.AllowedMentions(users=[discord.Object(driver_id)]),
    )
    quiet = _quiet(driver_bot, driver_bot.channel, posted, tag, settle=10)
    reactions = [str(r.emoji) for r in driver_bot.refetch(posted).reactions]
    reason = _reason(engine, posted.id)
    reply_to_other = driver_bot.post(f'{tag} replying to my own message', reference=posted)
    quiet2 = _quiet(driver_bot, driver_bot.channel, reply_to_other, 'replying to my own', settle=10)
    reason2 = _reason(engine, reply_to_other.id)
    ok = (
        not quiet
        and '\U0001f440' in reactions
        and reason == 'aimed_elsewhere'
        and not quiet2
        and reason2 == 'aimed_elsewhere'
    )
    _check(
        'F23',
        'ignoreAimedAtOthers / ackEmoji',
        'message mentioning another user; reply to a non-bot message',
        'acknowledged with the emoji only: nothing posted, no_reply aimed_elsewhere (both)',
        ok,
        f'mention: posts={len(quiet)} reactions={reactions} reason={reason}; reply: posts={len(quiet2)} reason={reason2}',
        f'question {posted.id}',
    )


def test_f23b_reply_to_the_bot_is_answered(engine, engine_config, driver_bot):
    # Review of #1503: the node looked up a reply's target with a method
    # discord.py does not have, so every reply counted as aimed elsewhere.
    tag = _tag('F23b')
    _start(engine, _echo(_params(engine_config, ignoreAimedAtOthers=True, ackEmoji='\U0001f440')))
    posted = driver_bot.post(f'{tag} first question')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    # A native reply with no ping: the bot is not in message.mentions, so only
    # the reply-target lookup can tell the node this is for it.
    reply = driver_bot.post(f'{tag} replying to the bot without a mention', reference=answer)
    reply_answer = _answer(driver_bot, driver_bot.channel, reply, 'replying to the bot')
    reactions = [str(r.emoji) for r in driver_bot.refetch(reply).reactions]
    reason = _reason(engine, reply.id, timeout=3) if reply_answer is None else ''
    _check(
        'F23b',
        'ignoreAimedAtOthers',
        "a reply to the bot's own answer, without a mention",
        'answered; no ack emoji, no aimed_elsewhere',
        answer is not None and reply_answer is not None and '\U0001f440' not in reactions,
        f'answered={reply_answer is not None}; reactions={reactions}; no_reply={reason or None}',
        'driver reply has mention_author off, so the bot is not in its mentions',
    )


def test_f24_feedback_and_reaction_events(engine, engine_config, driver_bot):
    tag = _tag('F24')
    _start(engine, _echo(_params(engine_config, feedbackReactions=True, emitReactions=True)))
    posted = driver_bot.post(f'{tag} feedback please')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(4)
    bot_reactions = [str(r.emoji) for r in driver_bot.refetch(answer).reactions] if answer else []
    outbound = _event(engine, 'outbound', posted.id) or {}
    own_reaction_events = list(_events(engine, 'reaction', answer.id)) if answer else []
    driver_bot.react(answer, '✅')
    added = _event(engine, 'reaction', answer.id, timeout=20)
    driver_bot.react(answer, '✅', remove=True)
    time.sleep(5)
    reaction_events = _events(engine, 'reaction', answer.id)
    removed = [event for event in reaction_events if event.get('added') is False]
    ok = (
        set(bot_reactions) >= {'✅', '❌'}
        and outbound.get('feedbackEmojis') == ['✅', '❌']
        and not own_reaction_events
        and added is not None
        and added.get('added') is True
        and str(added.get('userId')) == str(driver_bot.bot_id)
        and removed
    )
    _check(
        'F24',
        'feedbackReactions / emitReactions',
        'bot adds feedback emoji; driver adds then removes a reaction',
        'bot adds the emoji (not emitted as events); driver add and remove each emit a reaction event',
        ok,
        f'bot reactions={bot_reactions}; outbound.feedbackEmojis={outbound.get("feedbackEmojis")}; '
        f'events before driver={len(own_reaction_events)}; add event={added is not None}; remove events={len(removed)}',
        f'answer {getattr(answer, "id", None)}',
    )


def test_f25_sanitize_replies(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F25')
    _start(engine, _fake(_params(engine_config, sanitizeReplies=True, nonAnswerRetries=1), fake_llm))
    rows = {}

    final = driver_bot.post(f'{tag} envelope [fake:final]')
    final_answer = _answer(driver_bot, driver_bot.channel, final, FINAL_CONTENT, timeout=40)
    rows['final'] = (final_answer is not None and '"type"' not in final_answer.content, 'posted unwrapped')

    scratch = driver_bot.post(f'{tag} scratchpad [fake:scratchpad]')
    posts = _quiet(driver_bot, driver_bot.channel, scratch, 'Thought:', settle=15)
    calls = len(fake_llm.calls_matching(f'{tag} scratchpad'))
    rows['scratchpad'] = (not posts and _reason(engine, scratch.id) == 'non_answer' and calls >= 2, f'calls={calls}')

    error = driver_bot.post(f'{tag} raw error [fake:errtext]')
    posts = _quiet(driver_bot, driver_bot.channel, error, 'Error code', settle=12)
    rows['429 text'] = (not posts and _reason(engine, error.id) == 'model_error', 'model_error')

    empty = driver_bot.post(f'{tag} empty [fake:empty]')
    posts = _quiet(driver_bot, driver_bot.channel, empty, tag, settle=12)
    empty_calls = len(fake_llm.calls_matching(f'{tag} empty'))
    rows['empty'] = (not posts and _reason(engine, empty.id) == 'no_answer', f'calls={empty_calls}')

    ok = all(passed for passed, _ in rows.values())
    _check(
        'F25',
        'sanitizeReplies',
        '{"type":"final"} envelope, scratchpad, a 429 error as the answer text, empty answer',
        'envelope unwrapped and posted; scratchpad retried then dropped (non_answer); error text dropped (model_error); empty -> no_answer',
        ok,
        '; '.join(f'{name}: {"ok" if passed else "FAIL"} ({note})' for name, (passed, note) in rows.items()),
        f'fake model; posted envelope answer {getattr(final_answer, "id", None)}; error text was {ERROR_TEXT[:30]!r}...',
    )


def test_f26_non_answer_retries(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F26')
    rows = []
    for retries in (1, 0):
        _start(engine, _fake(_params(engine_config, sanitizeReplies=True, nonAnswerRetries=retries), fake_llm))
        posted = driver_bot.post(f'{tag} retries={retries} [fake:retry]')
        answer = _answer(driver_bot, driver_bot.channel, posted, RETRY_ANSWER, timeout=40)
        calls = len(fake_llm.calls_matching(f'{tag} retries={retries}'))
        retry_events = [e for e in _events(engine, 'message', posted.id) if e.get('retry')]
        rows.append((retries, answer is not None, calls, len(retry_events), _reason(engine, posted.id, timeout=5)))
    with_retry, without = rows
    ok = (
        with_retry[1]
        and with_retry[2] == 2
        and with_retry[3] == 1
        and not without[1]
        and without[2] == 1
        and without[4] == 'non_answer'
    )
    _check(
        'F26',
        'nonAnswerRetries',
        'scratchpad first, real answer second; retries 1 then 0',
        'retries=1: second call answers and is posted (message event retry=1); retries=0: one call, non_answer',
        ok,
        '; '.join(f'retries={r}: answered={a} calls={c} retry_events={e} no_reply={n}' for r, a, c, e, n in rows),
        'fake model call log',
    )


# =============================================================================
# Message filtering
# =============================================================================


def test_f27_system_and_empty_messages(engine, engine_config, driver_bot):
    tag = _tag('F27')
    _start(engine, _echo(_params(engine_config)))
    since = time.time()
    thread = driver_bot.open_thread(f'{tag} bare thread', minutes=60)
    embed_only = driver_bot.post(None, embed=discord.Embed(title=f'{tag} embed only', description='no text'))
    time.sleep(QUIET_SECONDS)
    message_events = [
        e
        for e in engine.discord_events('message')
        if (e.get('metadata') or {}).get('authorId') == str(driver_bot.bot_id)
    ]
    late = [e for e in message_events if str((e.get('metadata') or {}).get('messageId')) == str(embed_only.id)]
    posts = [m for m in driver_bot.answers_after(driver_bot.channel, embed_only) if tag in m.content]
    ok = not late and not posts and time.time() - since >= QUIET_SECONDS
    _check(
        'F27',
        'system / empty messages',
        '"started a thread" system notice and an embed-only message (no text, no file)',
        'both ignored: no message event, nothing posted',
        ok,
        f'embed-only message events={len(late)}; posts={len(posts)}; driver message events in window={len(message_events)}',
        f'driver thread {thread.id}',
    )


# =============================================================================
# Capture
# =============================================================================


@needs_pg
def test_f32_capture_into_postgres(engine, engine_config, driver_bot):
    tag = _tag('F32')
    _require_disposable_database()
    _psql('DROP TABLE IF EXISTS discord_events')
    _start(engine, _with_capture(_echo(_params(engine_config))))
    posted = driver_bot.post(f'{tag} capture me')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(10)
    table = _psql("SELECT to_regclass('public.discord_events') IS NOT NULL")
    rows = _psql(
        "SELECT event_type || '|' || event_key || '|' || source FROM discord_events "
        f"WHERE message_id = '{posted.id}' ORDER BY seq"
    ).splitlines()
    ok = answer is not None and table == 't' and 'message|text|e2e:full' in rows and 'outbound||e2e:full' in rows
    _check(
        'F32',
        'captureEvents / captureSource / default table',
        'question and answer with capture on, no captureTable set, and no table yet',
        'the check before the first INSERT finds no table, discord_events is created; '
        'message and outbound rows with source e2e:full',
        ok,
        f'discord_events exists={table}; rows={rows}',
        f'database {PG_DATABASE}',
    )


INSERT_ONLY_ROLE = 'discord_capture_insert_only'


@needs_pg
def test_f32b_capture_with_an_insert_only_role(engine, engine_config, driver_bot):
    """A database user granted only INSERT on an existing table captures every row.

    PostgreSQL wants SELECT on the columns of a named ``ON CONFLICT`` target,
    even for ``DO NOTHING``, so this is the case that broke when the insert
    named one. The role gets the same password as ``DISCORD_E2E_PG_USER``,
    which the engine already holds as ``ROCKETRIDE_DISCORD_PG_PASSWORD``; the
    test process must have that variable too.
    """
    tag = _tag('F32b')
    password = os.environ.get('ROCKETRIDE_DISCORD_PG_PASSWORD', '')
    if not password:
        pytest.skip('F32b needs ROCKETRIDE_DISCORD_PG_PASSWORD in the test environment too')
    _require_disposable_database()
    if _psql("SELECT to_regclass('public.discord_events') IS NOT NULL") != 't':
        pytest.skip('F32b writes into the table F32 creates; run F32 first')
    quoted = password.replace("'", "''")
    _psql(f'DO $$ BEGIN CREATE ROLE {INSERT_ONLY_ROLE} LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$')
    _psql(f"ALTER ROLE {INSERT_ONLY_ROLE} PASSWORD '{quoted}'")
    _psql(f'REVOKE ALL ON discord_events FROM {INSERT_ONLY_ROLE}')
    _psql(f'GRANT INSERT ON discord_events TO {INSERT_ONLY_ROLE}')
    _start(engine, _with_capture(_echo(_params(engine_config)), user=INSERT_ONLY_ROLE))
    posted = driver_bot.post(f'{tag} capture me with INSERT only')
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(10)
    rows = _psql(
        f"SELECT event_type || '|' || event_key FROM discord_events WHERE message_id = '{posted.id}' ORDER BY seq"
    ).splitlines()
    grants = _psql(
        "SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants "
        f"WHERE grantee = '{INSERT_ONLY_ROLE}' AND table_name = 'discord_events'"
    )
    ok = answer is not None and grants == 'INSERT' and 'message|text' in rows and 'outbound|' in rows
    _check(
        'F32b',
        'captureEvents with an INSERT-only database user',
        'existing discord_events, database user granted only INSERT on it',
        'message and outbound rows written; no SELECT grant needed',
        ok,
        f'grants={grants}; rows={rows}',
        f'database {PG_DATABASE}, role {INSERT_ONLY_ROLE}',
    )


@needs_pg
def test_f33_every_part_kept_and_duplicates_ignored(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F33')
    _require_disposable_database()
    _start(engine, _with_capture(_echo(_params(engine_config, textAttachmentExtensions=['.md']))))
    posted = driver_bot.post(f'{tag} text and a file', files=_files(tmp_media['md']))
    answer = _answer(driver_bot, driver_bot.channel, posted, tag)
    time.sleep(10)
    where = f"WHERE message_id = '{posted.id}' AND event_type = 'message'"
    keys = _psql(f'SELECT event_key FROM discord_events {where} ORDER BY event_key').splitlines()
    # A redelivered Gateway event reaches the table as the same INSERT again.
    _psql(
        'INSERT INTO discord_events (event_type, message_id, event_key, occurred_at, payload, source) '
        f'SELECT event_type, message_id, event_key, now(), payload, source FROM discord_events {where} '
        'ON CONFLICT DO NOTHING'
    )
    after = _psql(f'SELECT count(*) FROM discord_events {where}')
    ok = answer is not None and keys == ['text', 'text:1'] and after == '2'
    _check(
        'F33',
        'capture keys and dedupe',
        'text + .md attachment, mergeAttachments off; then the same rows inserted again',
        'two message rows (text, text:1); the repeated inserts are ignored (ON CONFLICT DO NOTHING)',
        ok,
        f'message keys={keys}; rows after the repeat={after}',
        f'message {posted.id}',
    )


@needs_pg
def test_f34_database_down_mid_run(engine, engine_config, driver_bot):
    tag = _tag('F34')
    # The pass condition includes the failed / recovered log lines.
    if not ENGINE_LOG:
        pytest.skip('F34 checks the capture log lines; set DISCORD_E2E_ENGINE_LOG')
    # Checked before anything starts capturing into that database.
    engine.terminate()
    _require_disposable_database()
    _start(engine, _with_capture(_echo(_params(engine_config))))
    mark = _log_size()
    subprocess.run(['docker', 'stop', PG_CONTAINER], capture_output=True, timeout=60)
    try:
        down = driver_bot.post(f'{tag} while the database is down')
        down_answer = _answer(driver_bot, driver_bot.channel, down, tag, timeout=60)
        time.sleep(8)
    finally:
        subprocess.run(['docker', 'start', PG_CONTAINER], capture_output=True, timeout=60)
    for _ in range(30):
        if _psql('SELECT 1') == '1':
            break
        time.sleep(1)
    # After a failed write the node drops rows for its 60-second backoff
    # before it tries again; the outage question started that window.
    time.sleep(CAPTURE_BACKOFF_SECONDS)
    up = driver_bot.post(f'{tag} after the database is back')
    up_answer = _answer(driver_bot, driver_bot.channel, up, 'after the database')
    time.sleep(10)
    up_rows = _psql(f"SELECT count(*) FROM discord_events WHERE message_id = '{up.id}'")
    down_rows = _psql(f"SELECT count(*) FROM discord_events WHERE message_id = '{down.id}'")
    failed = _log_tail(mark, r'Discord capture: writing .* failed')
    recovered = _log_tail(mark, r'Discord capture: writes to .* recovered after')
    ok = (
        down_answer is not None
        and up_answer is not None
        and up_rows not in ('', '0')
        and down_rows == '0'
        and bool(failed)
        and bool(recovered)
    )
    _check(
        'F34',
        'capture: database down mid-run',
        'container stopped, question, container started, question',
        'answered while down; the failed capture write is logged and dropped; '
        'next question captured again and the recovery logged',
        ok,
        f'answered while down={down_answer is not None}; rows for outage question={down_rows}; '
        f'answered after={up_answer is not None}; rows after={up_rows}',
        f'log: failed={failed[:1]} recovered={recovered[:1]}',
    )


# =============================================================================
# Startup and config
# =============================================================================


def test_f35_backfill_with_unreadable_channel(engine, engine_config, driver_bot):
    tag = _tag('F35')
    # Nothing may answer the seeds: their replies would become the newest
    # channel messages and push a seed out of the backfill window.
    engine.terminate()
    seed1 = driver_bot.post(f'{tag} backfill seed one')
    seed2 = driver_bot.post(f'{tag} backfill seed two')
    no_access = live_ids().get('noPermissionChannelId') or FAKE_CHANNEL_ID
    mark = _log_size()
    _start(
        engine,
        _echo(
            _params(
                engine_config,
                backfillLimit=2,
                sendResponses=False,
                channelIds=['${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}', str(no_access)],
            )
        ),
    )
    time.sleep(15)
    got = [str(e['metadata']['messageId']) for e in engine.discord_events('message')]
    running = engine.state() == TASK_STATE_RUNNING
    log = _log_tail(mark, r'[Bb]ackfill')
    ok = (
        str(seed1.id) in got
        and str(seed2.id) in got
        and got.index(str(seed1.id)) < got.index(str(seed2.id))
        and running
    )
    _check(
        'F35',
        'backfillLimit',
        'limit 2 over the test channel plus a channel the bot cannot read',
        'the 2 newest test-channel messages replayed oldest first; unreadable channel skipped; task keeps running',
        ok,
        f'replayed={[("seed1" if i == str(seed1.id) else "seed2" if i == str(seed2.id) else "other") for i in got]}; running={running}',
        f'log: {log[:2]}',
    )


def test_f36_member_metadata_without_intent(engine, engine_config):
    outcome = _start_raw(engine, _echo(_params(engine_config, includeMemberMetadata=True)), settle=30)
    text = ' '.join(str(v) for v in outcome.values())
    logged_in = 'logged in as' in outcome.get('status', '')
    clear = 'enable the Server Members Intent' in text
    ok = logged_in or clear
    _check(
        'F36',
        'includeMemberMetadata',
        'on, on a bot whose Server Members intent may be off',
        'either runs with member metadata, or fails fast leading with the Server Members intent',
        ok,
        f'logged in={logged_in}; names Server Members={clear}; state={outcome.get("state")}',
        f'status={outcome.get("status")[:160]!r} errors={outcome.get("errors")}',
    )
    engine.terminate()


def test_f37_numbers_and_lists_as_text(engine, engine_config, driver_bot):
    tag = _tag('F37')
    _start(
        engine,
        _echo(
            _params(
                engine_config,
                replyMode='thread',
                threadName='{content}',
                threadNameMaxLength='20',
                threadAutoArchiveMinutes='60',
                allowedBotIds=str(engine_config['driverBotId']),
                channelIds='["${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}"]',
            )
        ),
    )
    posted = driver_bot.post(f'{tag} numbers as text')
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    answer = _answer(driver_bot, thread, posted, tag) if thread else None
    ok = thread is not None and len(thread.name) <= 20 and thread.auto_archive_duration == 60 and answer is not None
    _check(
        'F37',
        'config coercion',
        'numbers as strings, a bare-string id, a JSON-text channel list',
        'all honoured: name <= 20, archive 60, driver allowed, channel matched',
        ok,
        f'thread={getattr(thread, "name", None)!r} archive={getattr(thread, "auto_archive_duration", None)} answered={answer is not None}',
        f'thread {getattr(thread, "id", None)}',
    )


def _status_warnings(engine, needle: str) -> List[str]:
    return [str(item)[-200:] for item in (engine.status().get('warnings') or []) if needle in str(item)]


def test_f38_bad_json_list(engine, engine_config, driver_bot):
    tag = _tag('F38')
    _start(engine, _echo(_params(engine_config, allowedBotIds=f'["{engine_config["driverBotId"]}"')))
    posted = driver_bot.post(f'{tag} bad json allowlist')
    quiet = _quiet(driver_bot, driver_bot.channel, posted, tag)
    warned = _status_warnings(engine, 'allowedBotIds')
    running = engine.state() == TASK_STATE_RUNNING
    _check(
        'F38',
        'config coercion',
        'allowedBotIds given as broken JSON text',
        'no crash; the driver is not allowed; the task warnings name the setting',
        running and not quiet and any('not valid JSON' in item for item in warned),
        f'running={running}; answered={bool(quiet)}; warnings naming allowedBotIds={len(warned)}',
        f'task warning: {warned[:1]}',
    )


def test_f38b_bad_json_channel_list(engine, engine_config):
    outcome = _start_raw(
        engine, _echo(_params(engine_config, channelIds='["${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}"'))
    )
    text = ' '.join(str(value) for value in outcome.values())
    logged_in = 'logged in as' in outcome.get('status', '')
    _check(
        'F38b',
        'config coercion',
        'channelIds given as broken JSON text',
        'the start fails with a message naming channelIds (a bot that answers nothing is not left running)',
        not logged_in and 'channelIds is not valid JSON' in text,
        f'logged in={logged_in}; state={outcome.get("state")}',
        f'task error={str((outcome.get("errors") or [""])[0])[-150:]!r}',
    )
    engine.terminate()


def test_f39_token_missing_and_invalid(engine, engine_config):
    rows = []
    for label, token in (
        ('missing variable', '${ROCKETRIDE_DISCORD_E2E_NO_SUCH_TOKEN}'),
        ('invalid token', 'not-a-real-discord-token'),
    ):
        outcome = _start_raw(engine, _echo(_params(engine_config, botToken=token)), settle=25)
        rows.append((label, outcome))
        engine.terminate()
    alive = engine_reachable(engine_config['engineUri'])
    texts = [' '.join(str(v) for v in outcome.values()) for _, outcome in rows]
    clear = [
        'ROCKETRIDE_DISCORD_E2E_NO_SUCH_TOKEN is not set' in texts[0],
        'login failed (invalid token)' in texts[1],
    ]
    no_login = ['logged in as' not in text for text in texts]
    ok = all(clear) and all(no_login) and alive is not False
    _check(
        'F39',
        'botToken',
        'missing variable; invalid token',
        'missing: fails naming the unset variable; invalid: "login failed (invalid token)"; engine keeps serving',
        ok,
        '; '.join(
            f'{label}: state={o.get("state")} status={o.get("status", "")[:40]!r} '
            f'task error={str((o.get("errors") or [""])[0])[-160:]!r}'
            for label, o in rows
        ),
        f'engine reachable afterwards={alive is not False}',
    )


# =============================================================================
# Failures
# =============================================================================


def test_f40_pipeline_throws(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F40')
    _start(engine, _fake(_params(engine_config, sanitizeReplies=True), fake_llm))
    posted = driver_bot.post(f'{tag} provider rejects [fake:http429]')
    started = time.time()
    event = _event(engine, 'no_reply', posted.id, timeout=90)
    took = time.time() - started
    reason = str(event.get('reason')) if event else '<no no_reply event in 90 s>'
    # Whatever the node posted in reply to this question, tagged or not.
    quiet = [
        m
        for m in driver_bot.answers_after(driver_bot.channel, posted)
        if m.reference is not None and m.reference.message_id == posted.id
    ]
    outbound = _event(engine, 'outbound', posted.id, timeout=2) or {}
    calls = len(fake_llm.calls_matching(f'{tag} provider rejects'))
    next_q = driver_bot.post(f'{tag} next question works')
    next_answer = _answer(driver_bot, driver_bot.channel, next_q, 'next question works', timeout=40)
    ok = not quiet and reason == 'model_error' and next_answer is not None
    _check(
        'F40',
        'pipeline throws',
        'model endpoint returns HTTP 429 on every call',
        'nothing posted (no raw error); no_reply model_error; the next question is answered',
        ok,
        f'replies posted={[m.content[:70] for m in quiet]}; no_reply after {took:.0f}s={reason[:120]!r}; '
        f'outbound={outbound.get("destination")}; model calls={calls}; next answered={next_answer is not None}',
        f'question {posted.id}',
    )


def test_f41_pipeline_slow_beyond_a_minute(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F41')
    _start(engine, _fake(_params(engine_config), fake_llm))
    slow = driver_bot.post(f'{tag} very slow [fake:hang:90]')
    started = time.time()
    other = driver_bot.post(f'{tag} meanwhile a quick one')
    other_answer = _answer(driver_bot, driver_bot.channel, other, 'meanwhile a quick one', timeout=40)
    other_latency = time.time() - started
    slow_answer = _answer(driver_bot, driver_bot.channel, slow, 'Fake answer after 90s', timeout=150)
    slow_latency = time.time() - started
    reason = _reason(engine, slow.id, timeout=2)
    _record(
        'F41',
        'pipeline times out',
        'model takes 90 s; a second question meanwhile',
        'no node-side timeout exists: the slow answer arrives late; the other question is not blocked',
        f'quick answered in {other_latency:.0f}s ({other_answer is not None}); slow answered={slow_answer is not None} '
        f'after {slow_latency:.0f}s; no_reply={reason}',
        other_answer is not None and slow_answer is not None,
        'the node has no pipeline timeout setting; the model client timed out or not as shown',
    )
    assert other_answer is not None, 'a slow pipeline blocked other questions'


def test_f41b_pipeline_timeout(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F41b')
    _start(engine, _fake(_params(engine_config, pipelineTimeoutSeconds=15), fake_llm))
    slow = driver_bot.post(f'{tag} very slow [fake:hang:45]')
    started = time.time()
    event = _event(engine, 'no_reply', slow.id, timeout=40)
    took = time.time() - started
    time.sleep(40)  # past the model's 45 s: the late answer must not be posted
    late = [m for m in driver_bot.answers_after(driver_bot.channel, slow) if 'Fake answer after 45s' in m.content]
    _check(
        'F41b',
        'pipelineTimeoutSeconds',
        'limit 15 s, model takes 45 s',
        'no_reply timeout after ~15 s; the late answer is dropped, nothing posted',
        event is not None and event.get('reason') == 'timeout' and not late,
        f'no_reply={event and event.get("reason")} after {took:.0f}s; late answer posted={bool(late)}',
        'fake model',
    )


def test_f42_thread_creation_refused(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F42')
    _start(engine, _fake(_params(engine_config, replyMode='thread'), fake_llm))
    posted = driver_bot.post(f'{tag} thread already taken [fake:slow:5]')
    # Take the message's one thread before the node can: its create_thread then fails.
    taken = driver_bot.open_thread(f'{tag} driver thread', message=posted)
    answer = _answer(driver_bot, driver_bot.channel, posted, 'Fake answer after 5s', timeout=45)
    outbound = _event(engine, 'outbound', posted.id) or {}
    in_driver_thread = [m for m in driver_bot.answers_after(taken, posted) if 'Fake answer' in m.content]
    ok = answer is not None and outbound.get('destination') == 'reply' and not in_driver_thread
    _check(
        'F42',
        'thread creation refused',
        'the question already has a thread (created by the driver first)',
        'create_thread fails; the answer is posted as a reply in the channel (destination=reply)',
        ok,
        f'answered in channel={answer is not None}; destination={outbound.get("destination")}; posts in the taken thread={len(in_driver_thread)}',
        "the refusal is produced by taking the question's one thread before the node can",
    )


def test_f43_reply_fails_to_post(engine, engine_config, driver_bot, fake_llm):
    tag = _tag('F43')
    _start(engine, _fake(_params(engine_config, replyMode='reply'), fake_llm))
    posted = driver_bot.post(f'{tag} delete me before the answer [fake:slow:6]')
    time.sleep(2)
    driver_bot.delete(posted)
    time.sleep(15)
    reason = _reason(engine, posted.id, timeout=20)
    posts = [m for m in driver_bot.answers_after(driver_bot.channel, posted) if 'Fake answer after 6s' in m.content]
    ok = reason == 'send_failed' and not posts
    _check(
        'F43',
        'send failure',
        'question deleted while the pipeline runs (reply target gone)',
        'nothing posted; no_reply reason send_failed',
        ok,
        f'no_reply={reason}; posts={len(posts)}',
        f'question {posted.id} (deleted)',
    )


def test_f44_discord_rate_limit(engine, engine_config, driver_bot, tmp_media):
    tag = _tag('F44')
    _start(
        engine,
        _echo(
            _params(
                engine_config,
                replyMode='thread',
                mergeAttachments=True,
                textAttachmentExtensions=['.txt'],
                textAttachmentMaxChars=40000,
            )
        ),
    )
    path = os.path.join(os.path.dirname(tmp_media['md']), 'F44.txt')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(_long_text('F44', 760))
    mark = _log_size()
    posted = driver_bot.post(f'{tag} rate limit', files=_files(path))
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    time.sleep(40)
    chunks = _chunks_in(thread, driver_bot, posted) if thread else []
    joined, midline = _reassemble(chunks, 'F44')
    lines_seen = [int(n) for n in re.findall(r'F44 line (\d{4}) x{12}', joined)]
    stamps = [chunk.created_at.timestamp() for chunk in chunks]
    gaps = [round(b - a, 2) for a, b in zip(stamps, stamps[1:])]
    limited = _log_tail(mark, r'rate limit')
    # Discord allows 5 messages per 5 s per channel: a burst of 10+ must stall
    # once, and every chunk must still arrive, in order.
    ok = len(chunks) >= 10 and lines_seen == list(range(760)) and max(gaps, default=0) >= 2.0 and midline == 0
    _check(
        'F44',
        'Discord rate limit',
        f'~{len(_long_text("F44", 760)) // 1000}k-char answer posted as many chunks in a burst',
        'every chunk lands, whole lines, in order, nothing dropped; discord.py waits out the 429s',
        ok,
        f'chunks={len(chunks)}; all lines in order={lines_seen == list(range(760))}; largest gap={max(gaps, default=0)}s; '
        f'span={round(stamps[-1] - stamps[0], 1) if stamps else 0}s',
        f'gaps between chunks={gaps}; mid-line cuts={midline}; log lines mentioning rate limit={len(limited)}',
    )


# =============================================================================
# The realistic AI run
# =============================================================================


def _ai_pipe_for_test(path: str, config: Dict[str, str]) -> Dict[str, Any]:
    """Load a saved AI pipe and point its discord source at the test channel.

    Components that reach outside Discord (a Slack tool) or write to a database
    are dropped with their edges, so the run has no side effects beyond the
    channel.
    """
    with open(path, encoding='utf-8') as handle:
        pipeline = json.load(handle)
    drop = {
        c['id'] for c in pipeline['components'] if c.get('provider') in ('tool_slack', 'db_postgres', 'rocketride_sql')
    }
    components = []
    for component in pipeline['components']:
        if component['id'] in drop:
            continue
        for key in ('input', 'control'):
            if component.get(key):
                component[key] = [edge for edge in component[key] if edge.get('from') not in drop]
        components.append(component)
    pipeline['components'] = components
    pipeline['project_id'] = PROJECT_ID

    source = next(c for c in pipeline['components'] if c['provider'] == 'discord')
    params = source['config']['parameters']
    params.update(
        {
            'channelIds': ['${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}'],
            'guildIds': ['${ROCKETRIDE_DISCORD_GUILD_ID}'],
            'allowedBotIds': [config['driverBotId']],
            'allowedMentionRoleIds': [],
            'replyMode': 'thread',
            'threadAutoArchiveMinutes': 60,
        }
    )
    assert not drop & {c['id'] for c in pipeline['components']}
    return pipeline


@needs_ai_pipe
def test_f46_ai_run(engine, engine_config, driver_bot):
    tag = _tag('F46')
    _start(engine, _ai_pipe_for_test(AI_PIPE, engine_config))
    posted = driver_bot.post(f'{tag} How do I run a pipeline from the Python SDK?')
    thread = driver_bot.wait_for_thread(posted, timeout=60)
    answer = driver_bot.wait_for_answer(thread, posted, timeout=150) if thread else None
    outbound = _event(engine, 'outbound', posted.id, timeout=10) or {}
    reason = _reason(engine, posted.id, timeout=2) if answer is None else ''
    reactions = [str(r.emoji) for r in driver_bot.refetch(answer).reactions] if answer else []
    content = answer.content if answer else ''
    leaked = bool(re.search(r'Thought:|Error code|Traceback|"type"\s*:\s*"final"', content))
    ok = answer is not None and not leaked and len(content) > 40
    _check(
        'F46',
        'AI path (saved AI pipe, no Slack tool, no database)',
        'one realistic support question',
        'a sanitized model answer in a thread, with the feedback emoji',
        ok,
        f'answered={answer is not None} chars={len(content)} leaked scratchpad/error={leaked} reactions={reactions} '
        f'chunks={len(outbound.get("messageIds") or [])} no_reply={reason}',
        f'first 100 chars: {content[:100]!r}',
    )


# =============================================================================
# Engine restart (last: it replaces the engine process)
# =============================================================================


@needs_engine_dir
def test_f45_engine_restarts_mid_thread(engine, engine_config, driver_bot):
    tag = _tag('F45')
    params = _params(engine_config, replyMode='thread', threadHistoryLimit=10)
    _start(engine, _echo(params))
    posted = driver_bot.post(f'{tag} before restart ALPHA')
    thread = driver_bot.wait_for_thread(posted, timeout=45)
    _answer(driver_bot, thread, posted, tag)

    port = urlparse(engine_config['engineUri']).port or 5565
    pid = subprocess.run(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True).stdout.split()
    engine.token = None  # the task dies with the engine; nothing to terminate
    for item in pid:
        subprocess.run(['kill', item], timeout=10)
    killed_at = time.time()
    for _ in range(40):
        if not subprocess.run(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True).stdout:
            break
        time.sleep(1)
    port_closed = time.time() - killed_at
    # The engine closes its port first; the task process (still on the
    # Gateway) exits later. "Down" means that process is gone.
    for _ in range(90):
        tasks = subprocess.run(['pgrep', '-f', 'node.py .*discord_1'], capture_output=True, text=True).stdout.split()
        if not tasks:
            break
        time.sleep(1)
    task_gone = time.time() - killed_at
    while_down = driver_bot.post(f'{tag} posted while the engine is down BRAVO', channel=thread)
    log = open(ENGINE_LOG or os.devnull, 'a')
    subprocess.Popen(
        ['./engine', 'ai/eaas.py', '--host=127.0.0.1', f'--port={port}'],
        cwd=ENGINE_DIR,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(60):
        if subprocess.run(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True).stdout:
            break
        time.sleep(1)
    time.sleep(5)
    fresh = EngineSession(engine_config['engineUri'], engine_config['engineApiKey']).start()
    try:
        _start(fresh, _echo(params))
        down_quiet = _quiet(driver_bot, thread, while_down, 'BRAVO', settle=8)
        after = driver_bot.post(f'{tag} after restart CHARLIE', channel=thread)
        answer = _answer(driver_bot, thread, after, 'CHARLIE')
        content = answer.content if answer else ''
        ok = answer is not None and 'ALPHA' in content and 'BRAVO' in content and not down_quiet
        _check(
            'F45',
            'engine restart mid-thread',
            'engine killed and restarted between turns of a thread; a message posted while it was down',
            'after restart the thread is answered with the full history (incl. the message posted while down); the missed message is not answered on its own',
            ok,
            f'answered={answer is not None}; history has pre-restart turn={"ALPHA" in content}, '
            f'missed message={"BRAVO" in content}; missed message answered on its own={bool(down_quiet)}',
            f'thread {getattr(thread, "id", None)}; port closed after {port_closed:.0f}s, discord task process gone after {task_gone:.0f}s',
        )
    finally:
        fresh.close()
