"""End-to-end test of Divya's Symphony Escape workflow on RocketRide.

The real shape, not a primitive:

    N room pipelines, each an INDEPENDENT run, each carrying TWO Hotdata nodes
      - a PRIVATE database it creates for its own clues (no database_id)
      - the SHARED evidence database it ATTACHES to (database_id set by the driver)
    then a SYNTHESIS pipeline that attaches to the shared evidence and reconstructs
    the melody for the audience.

Each room solves its own beat against a decoy, publishes only its verdict, and never
sees another room's clues. The synthesiser never sees any room's private data - only
what was published.

    python3 examples/symphony-test/test_symphony.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

#: Swap the pipeline's LLM without editing the .pipe files. gemini-flash-lite is cheap
#: but weak at multi-step tool use (see .context/hotdata-test/FINDINGS.md); gpt-4o-mini
#: is the cheap control that tells us whether a failure is the model or the wiring.
USE_OPENAI = '--gemini' not in sys.argv


def swap_llm(pipe: dict) -> dict:
    """Replace the Gemini node with a cheap OpenAI one, rewiring its control links."""
    if not USE_OPENAI:
        return pipe
    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            c['provider'] = 'llm_openai'
            c['name'] = 'GPT-4o-mini'
            c['config'] = {
                'profile': 'openai-4o-mini',
                'openai-4o-mini': {'apikey': '${ROCKETRIDE_OPENAI_KEY}'},
                'parameters': {},
            }
    return pipe


from test_attach import _hotdata, _load_env, _sql  # noqa: E402
from test_option1 import ask, check, extract_json  # noqa: E402

# "Twinkle, Twinkle" opening. Each room gets one beat, with a decoy clue that must lose.
SCORE = [(1, 'C4'), (2, 'C4'), (3, 'G4'), (4, 'G4')]


def build_room_pipe(shared_id: str) -> dict:
    """A room: agent + its own private DB + the attached shared evidence DB."""
    pipe = json.loads((HERE / 'investigator.pipe').read_text())
    private = next(c for c in pipe['components'] if c['provider'] == 'db_hotdata')
    private['id'] = 'db_private_1'
    private['name'] = 'Private room DB'
    private['config']['default']['table'] = 'clues'
    private['config']['default'].pop('database_id', None)  # creates its own

    shared = json.loads(json.dumps(private))
    shared['id'] = 'db_shared_1'
    shared['name'] = 'Shared evidence DB'
    shared['config']['default']['table'] = 'discoveries'
    shared['config']['default']['database_id'] = shared_id  # attaches
    pipe['components'].append(shared)

    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            # Rebuild rather than append: the node id was renamed above.
            c['control'] = [
                {'classType': 'llm', 'from': 'agent_inv'},
                {'classType': 'llm', 'from': 'db_private_1'},
                {'classType': 'llm', 'from': 'db_shared_1'},
            ]
        if c['provider'] == 'db_hotdata':
            c['control'] = [{'classType': 'tool', 'from': 'agent_inv'}]
        if c['provider'] == 'agent_rocketride':
            c['config']['instructions'] = [
                'You are one room in a multi-room puzzle. You have TWO database tools.',
                'db_private_1 is YOUR OWN private database. db_shared_1 is the SHARED evidence '
                'database every other room also publishes into. Never put raw clues in the shared one.',
                'Your message is JSON: {"room", "beat", "clues": [...]}.',
                'STEP 1: db_private_1.load_data table="clues" mode="append" rows=<the clues array>.',
                'STEP 2: db_private_1.execute a SQL query counting how many times each note appears. '
                'The winning note is the most frequent. One clue is a decoy and will lose.',
                'STEP 3: db_shared_1.load_data table="discoveries" mode="append" rows='
                '[{"room": <room>, "beat": <beat>, "note": <the winning note>, "confidence": 0.9}]. '
                'Publish ONLY this verdict, never the raw clues.',
                'FINAL ANSWER: reply with ONLY {"room": <room>, "beat": <beat>, "note": <winning note>}.',
            ]
    pipe['project_id'] = str(uuid.uuid4())
    return swap_llm(pipe)


def build_synth_pipe(shared_id: str) -> dict:
    """The synthesiser: one agent, attached to the shared evidence only."""
    pipe = json.loads((HERE / 'investigator.pipe').read_text())
    db = next(c for c in pipe['components'] if c['provider'] == 'db_hotdata')
    db['id'] = 'db_shared_1'
    db['config']['default']['table'] = 'discoveries'
    db['config']['default']['database_id'] = shared_id
    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            c['control'] = [{'classType': 'llm', 'from': 'agent_inv'}, {'classType': 'llm', 'from': 'db_shared_1'}]
        if c['provider'] == 'db_hotdata':
            c['control'] = [{'classType': 'tool', 'from': 'agent_inv'}]
        if c['provider'] == 'agent_rocketride':
            c['config']['instructions'] = [
                'You are the Composer. The shared evidence database holds one verdict row per room, '
                'published by rooms that never saw each other.',
                'Use db_shared_1.execute with SQL to read every row from the discoveries table, ordered by beat.',
                'Reconstruct the melody: the ordered list of notes by beat.',
                'FINAL ANSWER: reply with ONLY {"melody": [<note for beat 1>, <beat 2>, ...], "rooms": <row count>}.',
            ]
    pipe['project_id'] = str(uuid.uuid4())
    return swap_llm(pipe)


async def run() -> int:
    from rocketride import RocketRideClient

    results: list[bool] = []
    shared = _hotdata(
        'POST', '/v1/databases', {'name': f'rocketride-symphony-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'}
    )
    shared_id = shared['id']
    print(f'shared evidence database: {shared_id}\n')

    client = RocketRideClient()
    await client.connect()
    tokens: list[str] = []
    try:
        # --- every room is its own pipeline run, solving in isolation ---
        async def room(beat: int, note: str) -> None:
            decoy = 'F4' if note != 'F4' else 'B4'
            payload = {
                'room': f'room-{beat}',
                'beat': beat,
                'clues': [
                    {'beat': beat, 'note': note, 'source': 'cipher'},
                    {'beat': beat, 'note': note, 'source': 'echo'},
                    {'beat': beat, 'note': decoy, 'source': 'decoy'},
                ],
            }
            token = f'sym-{beat}-{uuid.uuid4().hex[:6]}'
            tokens.append(token)
            await client.use(pipeline=build_room_pipe(shared_id), token=token, ttl=300)
            r = await ask(client, token, json.dumps(payload))
            got = extract_json(r, 'note')
            print(f'  room-{beat}: solved {got.get("note") if got else "?"} (truth {note}, decoy {decoy})')

        await asyncio.gather(*(room(b, n) for b, n in SCORE))

        # 1. Every room published into the one shared database.
        rows = _sql(shared_id, 'SELECT room, beat, note FROM discoveries ORDER BY beat').get('rows', [])
        published = {(r[1], r[2]) for r in rows}
        expected = set(SCORE)
        results.append(
            check(
                f'{len(SCORE)} independent rooms published verdicts to one shared database',
                expected <= published,
                f'published={sorted(published)}',
            )
        )

        # 2. Decoys stayed private - the shared table holds verdicts only, no raw clues.
        notes = {r[2] for r in rows}
        results.append(
            check(
                'decoys never reached shared evidence (rooms published verdicts only)',
                'F4' not in notes and 'B4' not in notes,
                f'notes={sorted(notes)}',
            )
        )

        # 3. The synthesis step: an agent reads the accumulated evidence and produces
        #    the audience-facing result. This is the part that was never tested before.
        synth_token = f'synth-{uuid.uuid4().hex[:6]}'
        tokens.append(synth_token)
        await client.use(pipeline=build_synth_pipe(shared_id), token=synth_token, ttl=300)
        r = await ask(client, synth_token, 'Reconstruct the melody from the shared evidence.')
        out = extract_json(r, 'melody')
        melody = out.get('melody') if out else None
        expected_melody = [n for _, n in SCORE]
        results.append(
            check(
                'SYNTHESIS: composer reconstructed the melody from shared evidence',
                melody == expected_melody,
                f'got {melody}, expected {expected_melody}',
            )
        )
        if melody:
            print(
                f'\n  >>> THE AUDIENCE SEES:  {" ".join(melody)}   ({len(rows)} rooms, '
                f'{len(SCORE)} private databases + 1 shared)'
            )

        print()
        print(f'{sum(results)}/{len(results)} checks passed')
        return 0 if all(results) else 1
    finally:
        for t in tokens:
            try:
                await client.terminate(t)
            except Exception:  # noqa: BLE001
                pass
        await client.disconnect()


def main() -> int:
    _load_env()
    return asyncio.run(run())


if __name__ == '__main__':
    sys.exit(main())
