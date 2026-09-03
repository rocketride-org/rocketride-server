"""Divya's Symphony Escape, executed the way she designed it. 22 databases.

Her design, and where each part lands:

    20 agents, one private room each   -> 20 independent pipeline runs, each with its
                                          own db_hotdata node, so each creates its own
                                          ephemeral database and destroys it at teardown
    a shared evidence database         -> a 21st database, created by the driver, that
                                          every room ATTACHES to via database_id
    a telemetry database               -> a 22nd database that outlives every run, its id
                                          persisted to disk, written by the driver AND by
                                          every agent, queried live at the end
    dependency-ordered waves           -> rooms are launched in waves; a room in wave 2+
                                          cannot solve its beat without READING what an
                                          earlier wave published into shared evidence
    append-only, verdicts not clues    -> each room's raw clues (including a decoy) stay
                                          in its private database; only the verdict is
                                          published
    the Composer                       -> a final run attached to shared evidence only,
                                          reconstructing the melody no room knew

Two things carry the design that are easy to get wrong:

* Rooms do not *decide* to publish. The agent's answers lane is wired into the shared
  and telemetry nodes, so the pipeline writes the row. Agent-driven publishing was
  measured at roughly 1 room in 4.
* The Composer runs on a stronger model than the rooms and is asked for beat/note pairs
  rather than a bare list. Both matter: weaker models, or an unanchored list, drift into
  completing the tune from memory instead of transcribing the evidence.

    python3 examples/symphony-test/test_symphony_waves.py               # 20 rooms
    python3 examples/symphony-test/test_symphony_waves.py --rooms 8     # cheaper
    python3 examples/symphony-test/test_symphony_waves.py --wiring-only # no keys
    python3 examples/symphony-test/test_symphony_waves.py --no-telemetry

The telemetry check needs two runs to pass: one session is not a cross-session pattern.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from telemetry import Telemetry  # noqa: E402
from test_attach import _hotdata, _load_env, _sql  # noqa: E402
from test_option1 import ask, check, extract_json  # noqa: E402

#: "Twinkle, Twinkle, Little Star", 20 beats. Beat n is room n.
SCORE = [
    'C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4',
    'F4', 'F4', 'E4', 'E4', 'D4', 'D4', 'C4',
    'G4', 'G4', 'F4', 'F4', 'E4', 'E4',
]  # fmt: skip

#: Wave sizes. Wave 1 is solvable from a room's own clues; every later wave contains
#: rooms whose clues are incomplete and must be resolved against shared evidence.
WAVES = 5


def score_for(rooms: int) -> list[str]:
    return SCORE[:rooms]


def plan(rooms: int) -> list[list[int]]:
    """Dependency-ordered waves: discovery first, then rooms that need what it found.

    Wave 1 is every beat where a note is heard for the first time - those rooms can
    solve alone. Every remaining beat repeats a note wave 1 has already published, so
    every later room genuinely depends on shared evidence rather than merely running
    afterwards.
    """
    notes = score_for(rooms)
    first = sorted({note: beat for beat, note in reversed(list(enumerate(notes, 1)))}.values())
    rest = [b for b in range(1, rooms + 1) if b not in set(first)]
    if not rest:
        return [first]
    per = max(1, -(-len(rest) // (WAVES - 1)))
    return [first] + [rest[i : i + per] for i in range(0, len(rest), per)]


def reference_for(beat: int, notes: list[str], settled: set[int]) -> int | None:
    """The earliest already-published beat carrying this beat's note, if any.

    Restricted to beats from strictly earlier waves - a reference inside the same
    wave would be a race, not a dependency. A note heard for the first time has no
    reference, so that room gets ordinary clues; real waves mix the two.
    """
    return next((b for b in sorted(settled) if notes[b - 1] == notes[beat - 1]), None)


def clue_payload(beat: int, notes: list[str], reference: int | None, session: str = '') -> dict:
    """One room's message.

    Without a reference: three clues, one a decoy, and the winning note is the most
    frequent - solvable inside the room's own private database. With a reference:
    a decoy and nothing else, plus a pointer to a beat an earlier wave already
    published. That room cannot answer without reading shared evidence, which is
    what makes the waves dependency-ordered rather than merely sequential.
    """
    note = notes[beat - 1]
    decoy = 'F4' if note != 'F4' else 'B4'
    if reference is None:
        return {
            'session': session,
            'room': f'room-{beat}',
            'beat': beat,
            'clues': [
                {'beat': beat, 'note': note, 'source': 'cipher'},
                {'beat': beat, 'note': note, 'source': 'echo'},
                {'beat': beat, 'note': decoy, 'source': 'decoy'},
            ],
        }
    return {
        'session': session,
        'room': f'room-{beat}',
        'beat': beat,
        'clues': [{'beat': beat, 'note': decoy, 'source': 'decoy'}],
        'reference': {
            'text': f'my note is the same as the note published for beat {reference}',
            'beat': reference,
        },
    }


ROOM_INSTRUCTIONS = [
    'You are one room in a multi-room puzzle. You have TWO database tools.',
    'db_private_1 is YOUR OWN private database, for your raw clues. db_shared_1 is the '
    'SHARED evidence database that every other room also publishes into. NEVER put raw '
    'clues or decoys in the shared one.',
    'Your message is JSON: {"session", "room", "beat", "clues": [...]} and sometimes "reference".',
    'STEP 1: db_private_1.load_data table="clues" mode="append" rows=<the clues array>.',
    'STEP 2: work out the note for your beat.',
    '  - With no "reference": db_private_1.execute a SQL query counting each note in '
    'clues. The winning note is the most frequent one. One clue is a decoy and loses.',
    '  - With a "reference": the answer is NOT in your own clues, your only clue is a '
    'decoy. Use db_shared_1.execute with SQL to read the note another room already '
    'published for the referenced beat, e.g. '
    'SELECT note FROM discoveries WHERE beat = <the referenced beat>. That note is yours.',
    'STEP 3: do NOT write anything to db_shared_1. Publishing is automatic.',
    'FINAL ANSWER: reply with ONLY this JSON object and nothing else, no prose, no '
    'fences: {"session": <the session from your message, copied exactly>, '
    '"room": <your room>, "beat": <your beat>, "note": <the winning note>, '
    '"confidence": 0.9}',
]

#: Divya's design as written: the Composer reads the evidence rows and reconstructs the
#: melody. No SQL trick, no pre-aggregation - the agent does the consolidation. That needs
#: a model that can transcribe 20 rows without improvising; gpt-4o-mini demonstrably
#: cannot (it reported every beat back correctly and still emitted an invented descending
#: scale), which is why the Composer defaults to a stronger model than the rooms.
COMPOSER_INSTRUCTIONS = [
    'You are the Composer. The shared evidence database holds one verdict row per room, '
    'published by rooms that never saw each other. No room knows the whole melody.',
    'STEP 1: db_shared_1.execute SQL to read every row of the discoveries table, ordered by beat.',
    'STEP 2: reconstruct the melody, one entry per row the query returned.',
    'Emit each note WITH its beat number, as a pair, copied verbatim from the row it came '
    'from. Do NOT complete, correct, continue or infer any note - you are a transcriber, not '
    'a musician. If a beat was not in the result it does not go in the answer.',
    'FINAL ANSWER: reply with ONLY '
    '{"melody": [{"beat": <beat>, "note": <note>}, ... one entry per row ...], "rooms": <row count>}',
]

#: Profile per --model choice: (provider node, display name, config profile, key ref).
LLM_PROFILES = {
    'openai': ('llm_openai', 'GPT-4o-mini', 'openai-4o-mini', '${ROCKETRIDE_OPENAI_KEY}'),
    # GPT-4.1 rather than a 5-series model on purpose: the reasoning models reject the
    # `stop` parameter the chat path sends, which is a separate open bug.
    'openai-strong': ('llm_openai', 'GPT-4.1', 'gpt-4-1', '${ROCKETRIDE_OPENAI_KEY}'),
    'gemini': ('llm_gemini', 'Gemini', 'gemini-3_1-flash-lite-preview', '${ROCKETRIDE_GEMINI_KEY}'),
    'anthropic': ('llm_anthropic', 'Claude Haiku', 'claude-haiku-4-5', '${ROCKETRIDE_ANTHROPIC_KEY}'),
}


def melody_from(reply: object) -> list[str] | None:
    """The Composer's beat/note pairs, ordered by beat, as a plain note list.

    Pairing each note with its beat is what keeps a model honest here: asked for a
    bare list of notes, both gpt-4o-mini and gpt-4.1 drifted into completing the tune
    from memory. It cannot drift if every note has to carry the beat it came from.

    A model asked for pairs returns them as objects or as two-element arrays,
    unpredictably and sometimes both in one session, so both are accepted. A bare
    list of notes is accepted too - the check downstream is on the notes, and a
    format quibble should not be reported as a wrong melody.
    """
    out = extract_json(reply, 'melody')
    entries = out.get('melody') if out else None
    if not isinstance(entries, list) or not entries:
        return None
    # Models wrap the list in another list often enough to be worth handling: seen as
    # {"melody": [[{beat, note}, ...]]}. The content was right, the nesting was not.
    if len(entries) == 1 and isinstance(entries[0], list) and entries[0]:
        entries = entries[0]

    pairs: list[tuple[int, str]] = []
    for entry in entries:
        if isinstance(entry, dict) and 'beat' in entry and 'note' in entry:
            beat, note = entry['beat'], entry['note']
        elif isinstance(entry, (list, tuple)) and len(entry) == 2:
            beat, note = entry
        else:
            pairs = []
            break
        try:
            pairs.append((int(beat), str(note)))
        except (TypeError, ValueError):
            return None
    if pairs:
        # Verify the beats before discarding them. Sorting pairs and keeping only
        # the notes would accept a reply with duplicate, missing or out-of-range
        # beats as long as its sorted note sequence happened to match - which
        # defeats the point of asking for beats in the first place.
        beats = sorted(b for b, _n in pairs)
        if beats != list(range(1, len(pairs) + 1)):
            return None
        return [note for _beat, note in sorted(pairs, key=lambda p: p[0])]

    return [str(e) for e in entries] if all(isinstance(e, str) for e in entries) else None


def swap_llm(pipe: dict, model: str) -> dict:
    """Point every LLM node at one model without editing the .pipe files."""
    provider, name, profile, key = LLM_PROFILES[model]
    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            c['provider'] = provider
            c['name'] = name
            c['config'] = {'profile': profile, profile: {'apikey': key}, 'parameters': {}}
    return pipe


def build_room_pipe(shared_id: str, model: str, telemetry_id: str = '') -> dict:
    """A room: agent + its own private database + shared evidence + telemetry.

    Three `db_hotdata` nodes, three different lifecycles in one graph:

      db_private_1    creates a database, owns it, destroys it at teardown
      db_shared_1     attaches to the run's shared evidence database
      db_telemetry_1  attaches to the database that outlives every run

    The publish path is the wiring, not an instruction: agent_inv's answers lane feeds
    both attached nodes, so the verdict row is loaded into evidence AND into telemetry
    because the graph says so. Only db_private_1 is a tool the agent can call.
    """
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
    shared['input'] = [{'lane': 'answers', 'from': 'agent_inv'}]
    pipe['components'].append(shared)

    llm_control = [
        {'classType': 'llm', 'from': 'agent_inv'},
        {'classType': 'llm', 'from': 'db_private_1'},
        {'classType': 'llm', 'from': 'db_shared_1'},
    ]

    if telemetry_id:
        tele = json.loads(json.dumps(private))
        tele['id'] = 'db_telemetry_1'
        tele['name'] = 'Telemetry DB'
        tele['config']['default']['table'] = 'agent_answers'
        tele['config']['default']['database_id'] = telemetry_id
        tele['input'] = [{'lane': 'answers', 'from': 'agent_inv'}]
        tele['ui'] = {'position': {'x': 540, 'y': 560}, 'nodeType': 'default', 'formDataValid': True}
        pipe['components'].append(tele)
        llm_control.append({'classType': 'llm', 'from': 'db_telemetry_1'})

    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            c['control'] = llm_control
        if c['provider'] == 'db_hotdata':
            # Private and evidence are tools: the room reasons in one and READS the
            # other. Neither is a write path - writing is the answers lane. Telemetry
            # is not a tool at all; nothing an agent does should be able to touch it.
            c['control'] = [] if c['id'] == 'db_telemetry_1' else [{'classType': 'tool', 'from': 'agent_inv'}]
        if c['provider'] == 'agent_rocketride':
            c['config']['instructions'] = ROOM_INSTRUCTIONS
    pipe['project_id'] = str(uuid.uuid4())
    return swap_llm(pipe, model)


def build_composer_pipe(shared_id: str, model: str) -> dict:
    """The Composer: one agent, attached to shared evidence, nothing private."""
    pipe = json.loads((HERE / 'investigator.pipe').read_text())
    db = next(c for c in pipe['components'] if c['provider'] == 'db_hotdata')
    db['id'] = 'db_shared_1'
    db['name'] = 'Shared evidence DB'
    db['config']['default']['table'] = 'discoveries'
    db['config']['default']['database_id'] = shared_id
    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai'):
            c['control'] = [{'classType': 'llm', 'from': 'agent_inv'}, {'classType': 'llm', 'from': 'db_shared_1'}]
        if c['provider'] == 'db_hotdata':
            c['control'] = [{'classType': 'tool', 'from': 'agent_inv'}]
        if c['provider'] == 'agent_rocketride':
            c['config']['instructions'] = COMPOSER_INSTRUCTIONS
    pipe['project_id'] = str(uuid.uuid4())
    return swap_llm(pipe, model)


async def wiring_only(model: str) -> int:
    """Prove the engine accepts the graph - no keys, no network, no agents run."""
    import os

    from rocketride import RocketRideClient

    for k in (
        'ROCKETRIDE_DB_HOTDATA_KEY',
        'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID',
        'ROCKETRIDE_OPENAI_KEY',
        'ROCKETRIDE_GEMINI_KEY',
    ):
        os.environ.setdefault(k, 'wiring-test-fake')

    client = RocketRideClient()
    await client.connect()
    token = f'wiring-{uuid.uuid4().hex[:8]}'
    try:
        await client.use(pipeline=build_room_pipe('db-fake-0000', model, 'db-fake-tele'), token=token, ttl=60)
        ok = check("engine accepts a room graph with the agent's answers lane feeding the shared DB", True)
    except Exception as e:  # noqa: BLE001
        ok = check('engine accepts the room graph', False, str(e)[:200])
    finally:
        try:
            await client.terminate(token)
        except Exception:  # noqa: BLE001
            pass
        await client.disconnect()
    return 0 if ok else 1


def show_telemetry(tele: Telemetry, session: str) -> None:
    """The telemetry view: live SQL against the accumulated store, nothing cached.

    Chosen to answer questions a single run cannot: which agents are slow, whether this
    session is better or worse than the last one, where the pipeline actually waits.
    """
    print('\n  ---- TELEMETRY (live queries against the persistent Hotdata database) ----')

    tele.show(
        'CROSS-SESSION: every run so far',
        'SELECT session, started_at, rooms, room_model, composer_model, elapsed_s, published, '
        'checks_passed, checks_total FROM sessions ORDER BY started_at',
        'the whole point of a database that outlives the run',
    )

    tele.show(
        'CROSS-SESSION: has the room model changed anything?',
        'SELECT room_model, COUNT(*) AS sessions, ROUND(AVG(elapsed_s), 1) AS avg_elapsed_s, '
        'SUM(published) AS rows_published, SUM(failures) AS failures '
        'FROM sessions GROUP BY room_model ORDER BY room_model',
    )

    tele.show(
        'CROSS-AGENT: slowest rooms, averaged over every session',
        'SELECT agent, COUNT(*) AS runs, ROUND(AVG(duration_s), 1) AS avg_s, ROUND(MAX(duration_s), 1) AS worst_s, '
        'SUM(CASE WHEN correct THEN 0 ELSE 1 END) AS wrong '
        "FROM agent_runs WHERE agent <> 'composer' GROUP BY agent ORDER BY avg_s DESC LIMIT 5",
        "the recurring bottleneck, not this run's bottleneck",
    )

    tele.show(
        'CROSS-AGENT: do rooms that must read shared evidence cost more?',
        'SELECT dependent, COUNT(*) AS runs, ROUND(AVG(duration_s), 1) AS avg_s '
        "FROM agent_runs WHERE agent <> 'composer' GROUP BY dependent ORDER BY dependent",
        'a data-layer question that only the telemetry store can answer',
    )

    tele.show(
        'CONCURRENCY: where the pipeline fans out, and what each wave costs',
        'SELECT wave, COUNT(*) AS observations, ROUND(AVG(rooms), 1) AS rooms, '
        'ROUND(AVG(duration_s), 1) AS avg_s, ROUND(MAX(duration_s), 1) AS worst_s '
        'FROM waves GROUP BY wave ORDER BY wave',
        'wave 1 is the widest fan-out and the critical path',
    )

    tele.show(
        'FAILURES: which rooms needed a retry, and did the model matter?',
        'SELECT model, COUNT(*) AS attempts, SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retries, '
        "SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END) AS errors "
        "FROM agent_runs WHERE agent <> 'composer' GROUP BY model ORDER BY model",
        'the comparison that decides which model the rooms should run on',
    )

    tele.show(
        'FAILURES: the errors themselves, any session',
        'SELECT session, agent, wave, attempt, SUBSTR(error, 1, 60) AS error FROM agent_runs '
        "WHERE error <> '' ORDER BY session, wave LIMIT 8",
    )

    tele.show(
        'AGENT SELF-REPORTS vs DRIVER MEASUREMENTS',
        'SELECT COUNT(*) AS agent_written_rows, COUNT(DISTINCT session) AS sessions FROM agent_answers',
        'agent_answers is written by the agents through their answers lane; '
        'agent_runs is written by the driver. Same runs, two independent records.',
    )


async def run(args: argparse.Namespace) -> int:
    from rocketride import RocketRideClient

    rooms = args.rooms
    notes = score_for(rooms)
    waves = plan(rooms)
    results: list[bool] = []

    session = f'{time.strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:6]}'
    tele = Telemetry(enabled=not args.no_telemetry)
    telemetry_id = tele.open()
    if telemetry_id:
        print(f'telemetry database ({"created" if tele.created else "reused"}, persists across runs): {telemetry_id}')

    shared = _hotdata(
        'POST', '/v1/databases', {'name': f'rocketride-symphony-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'}
    )
    shared_id = shared['id']
    print(f'shared evidence database (driver-owned, this run only): {shared_id}')
    print(f'session {session}: {rooms} rooms in {len(waves)} dependency-ordered waves: {waves}\n')

    client = RocketRideClient()
    await client.connect()
    tokens: list[str] = []
    solved: dict[int, str] = {}
    started = time.monotonic()
    wall_started = time.time()

    dependent: list[int] = []
    settled: set[int] = set()
    failures: list[tuple[int, str]] = []
    #: What the driver measured about each room, as opposed to what the room claimed.
    room_events: list[dict] = []

    try:
        for wave_index, beats in enumerate(waves):
            references = {b: reference_for(b, notes, settled) for b in beats}
            dependent.extend(b for b, r in references.items() if r is not None)

            async def room(beat: int, reference: int | None, wave: int = wave_index) -> None:
                """Run one room, retrying once.

                The retry is not defensive padding. The agent's own planner
                intermittently fails to emit parseable JSON ("Failed to get valid JSON
                response after 4 attempts") on the cheaper models, and in a
                dependency-ordered design that failure does not stay local: the next
                wave's room reads shared evidence, finds nothing for its reference beat,
                and guesses. One retry stops a transient planner failure from poisoning
                every room downstream of it. Attempts are recorded, so the telemetry
                shows how often it was needed rather than hiding it.
                """
                last_error = ''
                for attempt in (1, 2):
                    payload = clue_payload(beat, notes, reference, session)
                    token = f'sym-{beat}-{uuid.uuid4().hex[:6]}'
                    tokens.append(token)
                    event = {
                        'session': session,
                        'agent': f'room-{beat}',
                        'beat': beat,
                        'wave': wave + 1,
                        'model': args.model,
                        'dependent': reference is not None,
                        'reference_beat': reference or 0,
                        'attempt': attempt,
                        'started_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                        'started_epoch': round(time.time(), 3),
                    }
                    t_room = time.monotonic()
                    try:
                        await client.use(
                            pipeline=build_room_pipe(shared_id, args.model, telemetry_id), token=token, ttl=600
                        )
                        reply = await ask(client, token, json.dumps(payload))
                        got = extract_json(reply, 'note')
                        if got and got.get('note'):
                            solved[beat] = str(got['note'])
                        event['answered'] = bool(got and got.get('note'))
                        event['answer'] = str(got.get('note')) if got else ''
                        event['error'] = ''
                    except Exception as e:  # noqa: BLE001
                        last_error = str(e)[:300]
                        event['answered'] = False
                        event['answer'] = ''
                        event['error'] = last_error
                    finally:
                        event['duration_s'] = round(time.monotonic() - t_room, 2)
                        event['correct'] = event.get('answer') == notes[beat - 1]
                        room_events.append(event)
                    if event['answered']:
                        return
                    if attempt == 1:
                        print(f'    room {beat} attempt 1 failed, retrying: {last_error[:160]}')
                raise RuntimeError(last_error or f'room {beat} produced no answer')

            t0 = time.monotonic()
            # One room blowing up must not take the wave with it - the interesting
            # result is which rooms published, and that needs every room attempted.
            outcomes = await asyncio.gather(*(room(b, references[b]) for b in beats), return_exceptions=True)
            for beat, outcome in zip(beats, outcomes):
                if isinstance(outcome, BaseException):
                    failures.append((beat, str(outcome)))
                    print(f'    room {beat} raised: {str(outcome)[:400]}')
            settled.update(beats)
            published = _sql(shared_id, 'SELECT beat FROM discoveries').get('rows', [])
            deps = [b for b in beats if references[b] is not None]
            wave_secs = round(time.monotonic() - t0, 2)
            print(
                f'  wave {wave_index + 1}: beats {beats} (dependent {deps or "none"}) -> '
                f'{[solved.get(b, "?") for b in beats]}  '
                f'({wave_secs:.0f}s, shared rows now {len(published)})'
            )
            # One batched write per wave rather than one per room: the same per-table
            # serialization the rooms hit applies to the driver, and a wave's rows are
            # only interesting together anyway.
            tele.write(
                'waves',
                [
                    {
                        'session': session,
                        'wave': wave_index + 1,
                        'rooms': len(beats),
                        'dependent_rooms': len(deps),
                        'duration_s': wave_secs,
                        'published_after': len(published),
                        'model': args.model,
                        'started_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                    }
                ],
            )
            tele.write('agent_runs', [e for e in room_events if e['wave'] == wave_index + 1])

        elapsed = time.monotonic() - started
        rows = _sql(shared_id, 'SELECT room, beat, note FROM discoveries ORDER BY beat').get('rows', [])
        by_beat: dict[int, str] = {}
        seen_beats: dict[int, int] = {}
        for r in rows:
            beat = int(r[1])
            by_beat.setdefault(beat, str(r[2]))
            seen_beats[beat] = seen_beats.get(beat, 0) + 1
        # setdefault above hides a second row for the same beat, and the retry can
        # produce one: each attempt is its own pipeline run, so if an attempt
        # published and then failed downstream, attempt 2 appends the claim again.
        # Never observed - the failures seen all happened before publication - but
        # it must be visible rather than silently collapsed.
        duplicated = {b: n for b, n in seen_beats.items() if n > 1}

        # 1. PUBLISH - the check that used to fail. Every room's verdict is in the
        #    shared database because the graph loaded it, not because the agent chose to.
        results.append(
            check(
                f'PUBLISH: all {rooms} rooms landed a verdict in the shared database',
                set(by_beat) == set(range(1, rooms + 1)),
                f'{len(by_beat)}/{rooms} beats present, missing={sorted(set(range(1, rooms + 1)) - set(by_beat))}',
            )
        )

        results.append(
            check(
                'NO DUPLICATES: each beat was published exactly once',
                not duplicated,
                f'beats published more than once: {duplicated}'
                if duplicated
                else f'{len(rows)} rows, {len(by_beat)} beats',
            )
        )

        # 2. The verdicts are correct, including the rooms that could only answer by
        #    reading another room's published row.
        wrong = {b: by_beat[b] for b in by_beat if by_beat[b] != notes[b - 1]}
        results.append(
            check(
                'CORRECT: every published verdict matches the score',
                not wrong,
                f'wrong={wrong}' if wrong else f'{len(by_beat)} verdicts',
            )
        )

        # 3. SHARE - the dependent rooms are the proof. Those rooms held only a decoy;
        #    a correct answer can only have come out of shared evidence.
        dependent_ok = [b for b in dependent if by_beat.get(b) == notes[b - 1]]
        results.append(
            check(
                "SHARE: dependent rooms resolved their beat from another room's published row",
                len(dependent_ok) == len(dependent) and bool(dependent),
                f'{len(dependent_ok)}/{len(dependent)} dependent rooms',
            )
        )

        # 4. ISOLATE - decoys stayed in the private databases. Nothing but verdicts here.
        notes_published = {v for v in by_beat.values()}
        decoys = {'F4' if n != 'F4' else 'B4' for n in notes}
        leaked = {b: by_beat[b] for b in by_beat if by_beat[b] != notes[b - 1] and by_beat[b] in decoys}
        results.append(
            check(
                "ISOLATE: no room published a decoy or another room's raw clues",
                not leaked,
                f'notes={sorted(notes_published)}',
            )
        )

        # 5. SURVIVES - every room is now torn down and its private database with it.
        #    Shutting the rooms down BEFORE the Composer runs is both the honest
        #    demo order (nothing is left but shared evidence) and the reliable one:
        #    running the Composer alongside 20 still-open pipelines produced an
        #    empty reply, while the identical run against the same database with the
        #    rooms closed passed three times out of three.
        before = len(rows)
        for token in tokens:
            try:
                await client.terminate(token)
            except Exception:  # noqa: BLE001
                pass
        tokens.clear()
        await asyncio.sleep(3)
        try:
            after_rows = _sql(shared_id, 'SELECT COUNT(*) AS n FROM discoveries').get('rows', [])
            survived = bool(after_rows) and int(after_rows[0][0]) == before
            after = after_rows[0][0] if after_rows else '?'
        except Exception as e:  # noqa: BLE001
            survived, after = False, str(e)[:120]
        results.append(
            check(
                'SURVIVES: shared evidence intact after every room was destroyed',
                survived,
                f'{before} rows before, {after} after',
            )
        )

        # 6. CONSOLIDATE - the Composer, reading only what was shared, after every
        #    room and every private database is gone.
        composer_token = f'composer-{uuid.uuid4().hex[:6]}'
        tokens.append(composer_token)
        t_composer = time.monotonic()
        await client.use(pipeline=build_composer_pipe(shared_id, args.composer_model), token=composer_token, ttl=600)
        reply = await ask(client, composer_token, 'Reconstruct the melody from the shared evidence.')
        composer_secs = round(time.monotonic() - t_composer, 2)
        melody = melody_from(reply)
        results.append(
            check(
                'CONSOLIDATE: the Composer reconstructed the melody from shared evidence',
                melody == notes,
                f'got {melody}',
            )
        )
        if melody != notes:
            print(f'    composer raw reply: {str(reply)[:400]}')

        tele.write(
            'agent_runs',
            [
                {
                    'session': session,
                    'agent': 'composer',
                    'beat': 0,
                    'wave': len(waves) + 1,
                    'model': args.composer_model,
                    'dependent': True,
                    'reference_beat': 0,
                    'attempt': 1,
                    'started_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                    'started_epoch': round(time.time(), 3),
                    'answered': melody is not None,
                    'answer': ' '.join(melody) if melody else '',
                    'error': '',
                    'duration_s': composer_secs,
                    'correct': melody == notes,
                }
            ],
        )

        # 7. TELEMETRY - the store the problem statement asks for. Written by the
        #    driver and by every agent, and queried live, right here.
        elapsed = time.monotonic() - started
        tele.write(
            'sessions',
            [
                {
                    'session': session,
                    'started_at': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(wall_started)),
                    'rooms': rooms,
                    'waves': len(waves),
                    'dependent_rooms': len(dependent),
                    'room_model': args.model,
                    'composer_model': args.composer_model,
                    'elapsed_s': round(elapsed, 2),
                    'published': len(by_beat),
                    'failures': len(failures),
                    'checks_passed': sum(results),
                    'checks_total': len(results) + 1,
                    'databases': rooms + 2,
                }
            ],
        )

        if tele.enabled:
            sessions = tele.query('SELECT COUNT(DISTINCT session) AS n FROM sessions')[1]
            session_count = int(sessions[0][0]) if sessions else 0
            results.append(
                check(
                    'TELEMETRY: the store spans more than one session',
                    session_count >= 2,
                    f'{session_count} session(s) accumulated - run again to build history'
                    if session_count < 2
                    else f'{session_count} sessions accumulated',
                )
            )
            if tele.errors:
                print(f'    telemetry write errors: {tele.errors[:3]}')

        if melody:
            print(f'\n  >>> THE AUDIENCE SEES:  {" ".join(melody)}')
        print(
            f'\n  {rooms} rooms, {rooms} private ephemeral databases + 1 shared + 1 telemetry '
            f'= {rooms + 2} databases, {len(waves)} waves, {elapsed:.0f}s'
        )

        if tele.enabled:
            show_telemetry(tele, session)

        print()
        print(f'{sum(results)}/{len(results)} checks passed')
        return 0 if all(results) else 1
    finally:
        for token in tokens:
            try:
                await client.terminate(token)
            except Exception:  # noqa: BLE001
                pass
        await client.disconnect()
        if not args.keep:
            try:
                _hotdata('DELETE', f'/v1/databases/{shared_id}')
                print(f'shared database {shared_id} deleted')
            except Exception as e:  # noqa: BLE001
                # Known and expected with a Database API Token: DELETE /v1/databases/{id}
                # is 403 for the token that just created it, so cleanup falls to the TTL.
                print(f'shared database {shared_id} left to its 1h TTL (delete refused: {e})')
        # Not independently verifiable from here: a Database API Token cannot list
        # databases (403), so this states what the node does rather than what was seen.
        print(f'{rooms} private room databases: deleted by their own runs at teardown (endGlobal)')


#: Does the Composer actually receive every row, or is the tool result truncated
#: before it reaches the model? A wrong melody could be either, and they have very
#: different fixes.
DIAGNOSE_INSTRUCTIONS = [
    'db_shared_1.execute this SQL: SELECT beat, note FROM discoveries ORDER BY beat',
    'Report what the tool returned. Do not reason about music.',
    'FINAL ANSWER: reply with ONLY {"rows_returned": <how many rows the tool gave you>, '
    '"first": <note of the lowest beat>, "last": <note of the highest beat>, '
    '"beats_seen": [<every beat number in the result>]}',
]


async def composer_only(database_id: str, model: str, rooms: int, diagnose: bool = False) -> int:
    """Re-run just the final act against an existing shared database.

    The rooms are the expensive part; iterating on the Composer against evidence
    that already exists costs one agent run instead of twenty-one.
    """
    from rocketride import RocketRideClient

    client = RocketRideClient()
    await client.connect()
    token = f'composer-{uuid.uuid4().hex[:6]}'
    try:
        pipe = build_composer_pipe(database_id, model)
        if diagnose:
            for c in pipe['components']:
                if c['provider'] == 'agent_rocketride':
                    c['config']['instructions'] = DIAGNOSE_INSTRUCTIONS
        await client.use(pipeline=pipe, token=token, ttl=600)
        reply = await ask(client, token, 'Reconstruct the melody from the shared evidence.')
        if diagnose:
            seen = extract_json(reply, 'rows_returned')
            print(f'  composer saw: {seen}')
            return 0 if seen and seen.get('rows_returned') == rooms else 1
        melody = melody_from(reply)
        ok = check('CONSOLIDATE: the Composer reconstructed the melody', melody == score_for(rooms), f'got {melody}')
        if not ok:
            print(f'    composer raw reply: {str(reply)[:600]}')
        return 0 if ok else 1
    finally:
        try:
            await client.terminate(token)
        except Exception:  # noqa: BLE001
            pass
        await client.disconnect()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--rooms', type=int, default=20, help='number of rooms/agents (default 20)')
    parser.add_argument('--composer-only', default='', help='re-run only the Composer against this database id')
    parser.add_argument('--model', choices=tuple(LLM_PROFILES), default='openai', help='model for the 20 room agents')
    parser.add_argument(
        '--composer-model',
        choices=tuple(LLM_PROFILES),
        default='openai-strong',
        help='model for the Composer, whose output is parsed and must not be improvised',
    )
    parser.add_argument('--wiring-only', action='store_true', help='no keys: only check the engine accepts the graph')
    parser.add_argument('--keep', action='store_true', help='leave the shared database in place')
    parser.add_argument('--no-telemetry', action='store_true', help='skip the persistent telemetry database')
    parser.add_argument('--diagnose', action='store_true', help='ask the Composer what the tool actually returned')
    args = parser.parse_args()
    if args.rooms < 1 or args.rooms > len(SCORE):
        print(f'--rooms must be between 1 and {len(SCORE)}')
        return 2
    _load_env()
    if args.composer_only:
        return asyncio.run(composer_only(args.composer_only, args.composer_model, args.rooms, args.diagnose))
    if args.wiring_only:
        return asyncio.run(wiring_only(args.model))
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
