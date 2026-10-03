# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""L2 replay (R01..R10): the Rocket Ralph regression seeds as real messages.

The ten seed questions in ``replay_seeds.md`` (vendored copy of
``eval/replay-seeds.md`` from the reference bot repo) are posted into the live
test channel and driven through the node.

At this layer the *pipeline is stubbed*, so only plumbing is asserted: each seed
must produce exactly one text-lane object with the right ``messageId`` /
``correlationId`` / ``channelId`` / ``eventType``, and exactly one reply posted
in ``reply`` mode. Answer *content* grading is L3 (see ``test_engine_e2e.py``
and section 4 of ``.context/discord-test-plan.md``).

No second bot identity is configured (``driverTokenFile`` empty), so each seed
is posted by the bot under test and fed to ``_process_message`` directly —
option 2 of the plan's driver-identity choices. Verdicts are written to
``.context/replay-runs/<timestamp>.jsonl``.
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Dict, List

import pytest

from .live_support import StubTarget, live_only, make_endpoint

pytestmark = live_only

_SEEDS_FILE = os.path.join(os.path.dirname(__file__), 'replay_seeds.md')
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
_RUN_DIR = os.path.join(_REPO_ROOT, '.context', 'replay-runs')


def parse_seeds(path: str = _SEEDS_FILE) -> List[Dict[str, str]]:
    """Parse the seed table: one dict per row with id, question, topic, expectation."""
    seeds: List[Dict[str, str]] = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith('|'):
                continue
            cells = [cell.strip() for cell in line.strip('|').split('|')]
            if len(cells) != 4 or not re.fullmatch(r'\d+', cells[0]):
                continue
            seeds.append(
                {
                    'id': f'R{int(cells[0]):02d}',
                    'number': int(cells[0]),
                    'question': cells[1],
                    'topic': cells[2],
                    'expectation': cells[3],
                }
            )
    return seeds


SEEDS = parse_seeds()


def test_seed_table_parsed():
    """The vendored seed table still yields the ten expected regression seeds."""
    assert [seed['id'] for seed in SEEDS] == [f'R{index:02d}' for index in range(1, 11)]
    assert all(seed['question'] for seed in SEEDS)


@pytest.fixture(scope='module')
def replay_log():
    """Collect per-seed verdicts and write them as JSONL at module teardown."""
    rows: List[Dict[str, object]] = []
    yield rows
    if not rows:
        return
    os.makedirs(_RUN_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path = os.path.join(_RUN_DIR, f'{stamp}.jsonl')
    with open(path, 'w', encoding='utf-8') as handle:
        for row in rows:
            handle.write(json.dumps(row) + '\n')
    print(f'\nreplay run written: {path} ({len(rows)} seeds)')


@pytest.mark.parametrize('seed', SEEDS, ids=[seed['id'] for seed in SEEDS])
def test_replay_seed_plumbing(live_bot, replay_log, seed):
    """One seed in, one correlated text object out, one reply back."""
    answer = f'[stub answer {seed["id"]}] pipeline not attached at L1'
    target = StubTarget(answer=answer)
    endpoint = make_endpoint(live_bot.bot, target=target, replyMode='reply')

    row: Dict[str, object] = {
        'id': seed['id'],
        'topic': seed['topic'],
        'question': seed['question'],
        'postedMessageId': None,
        'replyMessageId': None,
        'status': 'error',
        'layer': 'L1-stub-pipeline',
        'note': 'plumbing only; answer content graded at L3',
    }
    replay_log.append(row)

    message = live_bot.post(live_bot.primary, f'[LIVE-TEST {seed["id"]}] {seed["question"]}')
    row['postedMessageId'] = str(message.id)

    live_bot.run(endpoint._process_message(message), timeout=180)

    text_pipes = target.text_pipes
    assert len(text_pipes) == 1, f'{seed["id"]}: expected one text-lane object, got {target.names}'
    meta = text_pipes[0].meta
    assert meta['messageId'] == str(message.id)
    assert meta['correlationId'] == str(message.id)
    assert meta['channelId'] == str(message.channel.id)
    assert meta['eventType'] == 'message'
    assert text_pipes[0].texts[0].endswith(seed['question'])

    replies = live_bot.wait_for_bot_message(live_bot.primary, after_id=message.id)
    assert len(replies) == 1, f'{seed["id"]}: expected exactly one reply, got {len(replies)}'
    assert replies[0].content == answer
    assert replies[0].reference is not None and replies[0].reference.message_id == message.id
    row['replyMessageId'] = str(replies[0].id)
    row['status'] = 'pass'
    time.sleep(0.5)
