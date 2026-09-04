"""Generate a single pipeline containing 20 agent nodes, one database each.

The escape runs 20 agents as 20 independent pipeline runs, driven from the SDK.
This is the other shape of the same idea: **one** pipeline whose graph contains all
twenty agents, fanned out from one source and merged back into one shared database.

    chat ─┬─ agent_01 ─┬─ db_private_01 (creates its own database, tool)
          │            └─ memory_01
          ├─ agent_02 ─┬─ db_private_02
          │            └─ memory_02
          │   ... x20
          └─ agent_20 ...

    every agent's `answers` lane ──> db_shared_1  (one database, 20 writers)
    every agent's `answers` lane ──> response_answers_1
    one llm_openai node drives all 20 agents and all 21 database nodes

64 nodes, 41 control connections on one LLM node, 20 writers on one lane.

What this tests that the 20-run version cannot:

* whether the engine accepts a graph this wide at all;
* whether ONE `db_hotdata` node can receive the answers lane from 20 different
  agents - many-to-one on a lane, which nothing has exercised before;
* whether 20 agent nodes in one pipeline actually run concurrently;
* whether 20 sibling `db_hotdata` nodes each provision a genuinely separate
  database inside a single run.

Two honest differences from the 20-run version, both inherent to the shape:

* **No dependency-ordered waves.** One source emits once, so all 20 agents start
  together. Waves need the driver to hold the next batch back until the previous
  one has published. This graph is a fan-out, not a pipeline of waves.
* **Isolation is at the database, not the prompt.** One source means one message,
  so every agent's prompt carries every room's clues and each is told to use only
  its own. The private databases are still genuinely private; the clues are not.
  The 20-run version gives each agent only its own clues.

    python3 make_swarm_pipe.py            # writes swarm20.pipe
    python3 make_swarm_pipe.py --rooms 8  # smaller, cheaper to run
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from test_symphony_waves import LLM_PROFILES, SCORE  # noqa: E402

OUT = HERE / 'swarm20.pipe'

#: Grid spacing for the canvas, so 64 nodes are readable rather than stacked.
COL_X = {'source': 20, 'agent': 320, 'memory': 320, 'private': 620, 'shared': 980}
ROW_H = 150


def agent_instructions(beat: int) -> list[str]:
    return [
        f'You are room {beat}. Your beat is beat {beat} and no other.',
        'The message contains the clues for EVERY room. Use ONLY the entries whose '
        f'"beat" is {beat}. Ignore every other room\'s clues - they are not yours to solve.',
        f'STEP 1: db_private_{beat:02d}.load_data table="clues" mode="append" rows=<your beat\'s clues>. '
        'This database is yours alone; no other room can read it.',
        f'STEP 2: db_private_{beat:02d}.execute a SQL query counting how many times each note '
        'appears in your clues. The winning note is the most frequent one. Exactly one clue '
        'is a decoy and it loses.',
        'STEP 3: do NOT write to the shared database. Publishing happens automatically when you answer.',
        'FINAL ANSWER: reply with ONLY this JSON object, no prose and no code fences: '
        f'{{"room": "room-{beat}", "beat": {beat}, "note": "<the winning note>", "confidence": 0.9}}',
    ]


def build(rooms: int, model: str, llm_per_agent: bool = False) -> dict:
    provider, llm_name, profile, key = LLM_PROFILES[model]
    components: list[dict] = []
    llm_control: list[dict] = []
    answers_from: list[dict] = []

    components.append(
        {
            'id': 'chat_1',
            'provider': 'chat',
            'name': 'Clues in',
            'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'chat'},
            'ui': {'position': {'x': COL_X['source'], 'y': ROW_H * rooms // 2}, 'nodeType': 'default'},
        }
    )

    for beat in range(1, rooms + 1):
        agent_id = f'agent_{beat:02d}'
        private_id = f'db_private_{beat:02d}'
        memory_id = f'memory_{beat:02d}'
        y = ROW_H * (beat - 1)

        components.append(
            {
                'id': agent_id,
                'provider': 'agent_rocketride',
                'name': f'Room {beat}',
                'config': {'instructions': agent_instructions(beat), 'max_waves': 8, 'parameters': {}},
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
                'ui': {'position': {'x': COL_X['agent'], 'y': y}, 'nodeType': 'default'},
            }
        )
        # No database_id: every one of these provisions its own database and
        # destroys it at teardown. Twenty siblings, twenty databases, one run.
        components.append(
            {
                'id': private_id,
                'provider': 'db_hotdata',
                'name': f'Room {beat} private DB',
                'config': {
                    'profile': 'default',
                    'default': {
                        'apikey': '${ROCKETRIDE_DB_HOTDATA_KEY}',
                        'workspace_id': '${ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID}',
                        'api_url': '',
                        'ttl': '1h',
                        'table': 'clues',
                        'db_description': f'Room {beat} private scratch. clues(beat, note, source).',
                        'max_attempts': 3,
                        'max_execute_rows': 25000,
                        'allow_execute': True,
                        'allow_destructive_load': False,
                        'job_timeout_secs': 180,
                        'async_after_ms': 5000,
                    },
                    'parameters': {},
                },
                'control': [{'classType': 'tool', 'from': agent_id}],
                'ui': {'position': {'x': COL_X['private'], 'y': y}, 'nodeType': 'default'},
            }
        )
        components.append(
            {
                'id': memory_id,
                'provider': 'memory_internal',
                'config': {'type': 'memory_internal'},
                'control': [{'classType': 'memory', 'from': agent_id}],
                'ui': {'position': {'x': COL_X['memory'], 'y': y + 60}, 'nodeType': 'default'},
            }
        )

        if llm_per_agent:
            # One LLM node per agent, to test whether a single shared llm node is
            # what serializes the fan-out.
            components.append(
                {
                    'id': f'llm_{beat:02d}',
                    'provider': provider,
                    'name': f'{llm_name} {beat}',
                    'config': {'profile': profile, profile: {'apikey': key}, 'parameters': {}},
                    'control': [
                        {'classType': 'llm', 'from': agent_id},
                        {'classType': 'llm', 'from': private_id},
                    ],
                    'ui': {'position': {'x': COL_X['agent'] - 160, 'y': y}, 'nodeType': 'default'},
                }
            )
        else:
            llm_control.append({'classType': 'llm', 'from': agent_id})
            llm_control.append({'classType': 'llm', 'from': private_id})
        answers_from.append({'lane': 'answers', 'from': agent_id})

    # ONE shared database, written by all 20 agents through their answers lanes.
    # No database_id: inside a single pipeline the node itself is the shared thing,
    # so nothing has to attach - the sharing is the graph, not a configured id.
    components.append(
        {
            'id': 'db_shared_1',
            'provider': 'db_hotdata',
            'name': 'Shared evidence DB',
            'config': {
                'profile': 'default',
                'default': {
                    'apikey': '${ROCKETRIDE_DB_HOTDATA_KEY}',
                    'workspace_id': '${ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID}',
                    'api_url': '',
                    'ttl': '1h',
                    'table': 'discoveries',
                    'db_description': 'One verdict row per room: discoveries(room, beat, note, confidence).',
                    'max_attempts': 3,
                    'max_execute_rows': 25000,
                    'allow_execute': True,
                    'allow_destructive_load': False,
                    'job_timeout_secs': 180,
                    'async_after_ms': 5000,
                },
                'parameters': {},
            },
            'control': [{'classType': 'tool', 'from': f'agent_{b:02d}'} for b in range(1, rooms + 1)],
            'input': list(answers_from),
            'ui': {'position': {'x': COL_X['shared'], 'y': ROW_H * rooms // 2}, 'nodeType': 'default'},
        }
    )
    llm_control.append({'classType': 'llm', 'from': 'db_shared_1'})

    components.append(
        {
            'id': 'response_answers_1',
            'provider': 'response_answers',
            'name': 'Verdicts',
            'config': {'laneName': 'answers'},
            'input': list(answers_from),
            'ui': {'position': {'x': COL_X['shared'], 'y': ROW_H * rooms // 2 + 200}, 'nodeType': 'default'},
        }
    )

    components.append(
        {
            'id': 'llm_1',
            'provider': provider,
            'name': llm_name,
            'config': {'profile': profile, profile: {'apikey': key}, 'parameters': {}},
            'control': llm_control,
            'ui': {'position': {'x': COL_X['source'], 'y': ROW_H * rooms // 2 + 240}, 'nodeType': 'default'},
        }
    )

    return {
        'components': components,
        'project_id': str(uuid.uuid4()),
        'viewport': {'x': 0, 'y': 0, 'zoom': 0.35},
        'version': 1,
    }


def clues_for_all(rooms: int) -> dict:
    """One message carrying every room's clues, since one source feeds all agents."""
    clues = []
    for beat in range(1, rooms + 1):
        note = SCORE[beat - 1]
        decoy = 'F4' if note != 'F4' else 'B4'
        clues.append({'beat': beat, 'note': note, 'source': 'cipher'})
        clues.append({'beat': beat, 'note': note, 'source': 'echo'})
        clues.append({'beat': beat, 'note': decoy, 'source': 'decoy'})
    return {'rooms': rooms, 'clues': clues}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--rooms', type=int, default=20)
    parser.add_argument('--model', choices=tuple(LLM_PROFILES), default='openai-strong')
    parser.add_argument('--llm-per-agent', action='store_true')
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()

    pipe = build(args.rooms, args.model, args.llm_per_agent)
    Path(args.out).write_text(json.dumps(pipe, indent='\t') + '\n')

    kinds: dict[str, int] = {}
    for c in pipe['components']:
        kinds[c['provider']] = kinds.get(c['provider'], 0) + 1
    llm = next(c for c in pipe['components'] if c['id'] == 'llm_1')
    shared = next(c for c in pipe['components'] if c['id'] == 'db_shared_1')

    print(f'wrote {args.out}')
    print(f'  {len(pipe["components"])} nodes: ' + ', '.join(f'{v}x {k}' for k, v in sorted(kinds.items())))
    print(f'  {len(llm["control"])} control connections on one LLM node')
    print(f'  {len(shared["input"])} agents writing to db_shared_1 through the answers lane')
    print(f'  {args.rooms} private databases + 1 shared = {args.rooms + 1} databases in ONE run')
    return 0


if __name__ == '__main__':
    sys.exit(main())
