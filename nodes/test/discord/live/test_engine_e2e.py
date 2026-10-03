# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""L3 engine end-to-end tests (E01..E06).

The layer L1/L2 deliberately stub out: a **real** RocketRide engine spawns the
discord node from ``engine_min.pipe``, a real pipeline (prompt -> OpenAI ->
answers) answers, and a **second** Discord identity (the "driver" bot) posts the
questions and reads back what the node posted. Nothing here holds the token of
the bot under test — the engine resolves ``${ROCKETRIDE_DISCORD_*}`` from its
own environment.

The module skips unless ``DISCORD_LIVE=1``, ``ROCKETRIDE_URI`` is set and its
host:port accepts a connection, and the driver token can be read; see the
README for the id map (``engine`` block of ``~/.secrets/rocketride-discord-live.json``,
every key overridable by ``DISCORD_E2E_<KEY>``).

Each test posts one driver message (E04 posts its follow-up as a second),
prefixed ``[e2e <id>]``, at least ``E2E_POST_THROTTLE_SECONDS`` apart; the
session fixture deletes them afterwards.
"""

import json
import os
import time

import pytest

from .live_support import (
    LIVE_ENV_FLAG,
    driver_token_available,
    engine_reachable,
    live_only,
    load_engine_config,
    tcp_open,
)
from .test_live_io import METADATA_KEYS

pytestmark = live_only

PIPE_PATH = os.path.join(os.path.dirname(__file__), 'engine_min.pipe')
ESCALATION_LINE = 'Escalated to the RocketRide team.'
TASK_STATE_RUNNING = 3
QDRANT_PORT = 6333


def _gate_reason() -> str:
    """Why this layer cannot run here, or '' when it can."""
    if os.environ.get(LIVE_ENV_FLAG) != '1':
        return f'{LIVE_ENV_FLAG}=1 not set'
    if not os.environ.get('ROCKETRIDE_URI'):
        return 'ROCKETRIDE_URI not set'
    config = load_engine_config()
    if not engine_reachable(config['engineUri']):
        return f'engine not reachable on {config["engineUri"]}'
    if not driver_token_available(config):
        return 'driver bot token not readable (driverTokenEnvFile / driverTokenEnvKey)'
    return ''


SKIP_REASON = _gate_reason()
requires_engine = pytest.mark.skipif(bool(SKIP_REASON), reason=SKIP_REASON or 'engine reachable')


def _pipeline(config, *, reply_mode: str):
    """``engine_min.pipe`` with the two knobs each test owns set in code."""
    with open(PIPE_PATH, encoding='utf-8') as handle:
        pipeline = json.load(handle)
    component = next(item for item in pipeline['components'] if item['id'] == 'discord_1')
    parameters = component['config']['parameters']
    parameters['replyMode'] = reply_mode
    parameters['allowedBotIds'] = [config['driverBotId']]
    return pipeline


def _running(engine, config, mode: str):
    """Make sure the engine runs the pipe in ``mode`` (restart on a switch)."""
    if engine.mode != mode:
        engine.start_pipe(_pipeline(config, reply_mode=mode), mode=mode)
    return engine


def _is_reply_to(posted):
    return lambda message: message.reference is not None and message.reference.message_id == posted.id


# ---------------------------------------------------------------------------
# E01 — the engine spawns the node
# ---------------------------------------------------------------------------


@requires_engine
def test_e01_engine_spawns_node(engine, engine_config):
    """``use(ttl=0)`` spawns the node: it logs in within 30 s and stays RUNNING."""
    _running(engine, engine_config, 'reply')
    assert 'logged in as' in engine.login_status, f'no login within 30s; last status: {engine.login_status!r}'
    assert engine.state() == TASK_STATE_RUNNING
    time.sleep(5)
    assert engine.state() == TASK_STATE_RUNNING, 'task did not stay RUNNING'
    print(f'\nE01 task status: {engine.login_status}')


# ---------------------------------------------------------------------------
# E02 — node metadata reaches a subscriber
# ---------------------------------------------------------------------------


@requires_engine
def test_e02_metadata_visible_downstream(engine, engine_config, driver_bot):
    """The node's ``message`` and ``outbound`` events reach an SSE subscriber.

    The whole eval-capture design (events keyed by ``correlationId``) rests on
    this: the metadata never appears in a pipeline trace, only here.
    """
    _running(engine, engine_config, 'reply')
    posted = driver_bot.post('[e2e E02] Which SDKs can drive a RocketRide pipeline?')

    event = engine.wait_for_discord_event('message', posted.id, timeout=30)
    metadata = event['metadata']
    assert set(metadata) == METADATA_KEYS, f'metadata key drift: {set(metadata) ^ METADATA_KEYS}'
    assert str(metadata['messageId']) == str(posted.id)
    assert str(metadata['correlationId']) == str(posted.id)
    assert metadata['authorIsBot'] is True
    assert str(metadata['authorId']) == engine_config['driverBotId']

    outbound = engine.wait_for_discord_event('outbound', posted.id, timeout=45)
    assert outbound['destination'] == 'reply'
    assert outbound['messageIds'], 'outbound event carried no posted message id'
    print(f'\nE02 metadata keys={len(metadata)} outbound={outbound["messageIds"]}')


# ---------------------------------------------------------------------------
# E03 — a real LLM answer comes back as a native reply
# ---------------------------------------------------------------------------


@requires_engine
def test_e03_real_llm_answer_posted(engine, engine_config, driver_bot):
    """A posted question comes back as real LLM text, as a native reply."""
    _running(engine, engine_config, 'reply')
    posted = driver_bot.post('[e2e E03] What is a lane in a RocketRide pipeline?')
    answer = driver_bot.wait_for_answer(driver_bot.channel, posted, timeout=40, match=_is_reply_to(posted))
    assert answer is not None, 'no native reply within 40s'
    assert answer.content.strip(), 'the node replied with empty text'
    print(f'\nE03 reply {answer.id}: {answer.content[:120]!r}')


# ---------------------------------------------------------------------------
# E04 — thread mode, including a follow-up inside the thread
# ---------------------------------------------------------------------------


@requires_engine
def test_e04_thread_followup_reaches_pipeline(engine, engine_config, driver_bot):
    """Thread mode: a thread named from the message, the answer inside it, and a
    follow-up answered in the thread carrying ``threadId`` / ``parentChannelId``.
    """
    _running(engine, engine_config, 'thread')
    question = '[e2e E04] How do I run a pipeline from the Python SDK?'
    posted = driver_bot.post(question)

    thread = driver_bot.wait_for_thread(posted, timeout=60)
    assert thread is not None, 'the node created no thread within 60s'
    assert thread.name == question, f'thread name {thread.name!r} is not the message text'
    assert thread.parent_id == int(engine_config['supportChannelId'])

    first = driver_bot.wait_for_answer(thread, posted, timeout=60)
    assert first is not None, 'no answer inside the thread within 60s'

    followup = driver_bot.post('[e2e E04] Follow-up: and how do I pass arguments to it?', channel=thread)
    second = driver_bot.wait_for_answer(thread, followup, timeout=60)
    assert second is not None, 'the thread follow-up was not answered within 60s'

    event = engine.wait_for_discord_event('message', followup.id, timeout=30)
    metadata = event['metadata']
    assert str(metadata['threadId']) == str(thread.id)
    assert str(metadata['parentChannelId']) == engine_config['supportChannelId']
    print(f'\nE04 thread {thread.id} {thread.name!r}; follow-up answered by {second.id}')


# ---------------------------------------------------------------------------
# E05 — escalation
# ---------------------------------------------------------------------------


@requires_engine
def test_e05_escalation_line_without_ping(engine, engine_config, driver_bot):
    """A question that needs a human ends with the escalation line and pings nobody."""
    _running(engine, engine_config, 'reply')
    posted = driver_bot.post('[e2e E05] What is my invoice total this month?')
    answer = driver_bot.wait_for_answer(driver_bot.channel, posted, timeout=60, match=_is_reply_to(posted))
    assert answer is not None, 'no escalation reply within 60s'
    lines = [line.strip() for line in answer.content.strip().splitlines() if line.strip()]
    assert lines[-1] == ESCALATION_LINE, f'reply does not end with the escalation line: {lines[-1]!r}'
    assert answer.role_mentions == []
    assert answer.mention_everyone is False
    print(f'\nE05 reply {answer.id}: {answer.content[-120:]!r}')


# ---------------------------------------------------------------------------
# E06 — eval-capture branch (needs a local Qdrant)
# ---------------------------------------------------------------------------


@requires_engine
@pytest.mark.skipif(
    not tcp_open('localhost', QDRANT_PORT, timeout=2), reason='capture pipe needs a Qdrant on port 6333'
)
def test_e06_event_branch_lands_in_store(engine, engine_config, driver_bot):
    """reaction, no_reply and outbound events land in the store branch with matching correlationId."""
    # TODO: discord-eval-capture.pipe — run it alongside the support pipe, post
    # one driver message, then assert the event lane's reaction / no_reply /
    # outbound records reach the Qdrant collection keyed by correlationId.
    pytest.skip('TODO: discord-eval-capture.pipe is not wired into the harness yet')
