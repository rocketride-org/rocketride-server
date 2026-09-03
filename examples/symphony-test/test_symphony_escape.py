"""AI Symphony Escape on RocketRide — Divya's design, run for real.

Her debrief describes 20 agents in four roles, 22 Hotdata databases, five
dependency-ordered waves, 49 clues, and three planted contradictions caught and resolved
by a critic wave. It was executed two ways: as one deterministic Python process (~205s,
zero tokens) and as 20 live Claude subagents (~400s, ~877k tokens). Neither ran on
RocketRide. This does.

    wave 1A  9 investigators   cipher / scale-degree / logic-grid puzzles, own beat
    wave 1B  6 investigators   mirror beats, resolvable ONLY from shared evidence
    wave 2   3 critics         find beats with two claims, resolve by confidence
    wave 3   1 conductor       synthesise melody, key, tempo from resolved evidence
    wave 4   1 composer        render the MIDI file

The part the simplified harness could not test: three investigators publish a
low-confidence claim about someone else's beat *into shared evidence*, so the critic wave
has genuine contradictions to catch rather than a rehearsal. Nothing about the resolution
is hard-coded — a critic queries the shared database, groups by beat, and keeps the
higher-confidence row.

    python3 examples/symphony-test/test_symphony_escape.py
    python3 examples/symphony-test/test_symphony_escape.py --wiring-only   # no keys
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import escape_design as design  # noqa: E402
from telemetry import Telemetry  # noqa: E402
from test_attach import _hotdata, _load_env, _sql  # noqa: E402
from test_option1 import ask, check, extract_json  # noqa: E402
from test_symphony_waves import LLM_PROFILES, swap_llm  # noqa: E402

OUTPUT_DIR = HERE / 'output'


# ---------------------------------------------------------------------------
# Pipeline graphs
# ---------------------------------------------------------------------------


def _base_pipe() -> dict:
    return json.loads((HERE / 'investigator.pipe').read_text())


def _db_node(template: dict, node_id: str, name: str, table: str, database_id: str = '') -> dict:
    node = json.loads(json.dumps(template))
    node['id'] = node_id
    node['name'] = name
    node['config']['default']['table'] = table
    if database_id:
        node['config']['default']['database_id'] = database_id
    else:
        node['config']['default'].pop('database_id', None)
    return node


def _wire(pipe: dict, agent_id: str, db_ids: list[str], tool_ids: list[str], instructions: list[str]) -> dict:
    for c in pipe['components']:
        if c['provider'] in ('llm_gemini', 'llm_openai', 'llm_anthropic'):
            c['control'] = [{'classType': 'llm', 'from': agent_id}] + [
                {'classType': 'llm', 'from': db_id} for db_id in db_ids
            ]
        if c['provider'] == 'db_hotdata':
            c['control'] = [{'classType': 'tool', 'from': agent_id}] if c['id'] in tool_ids else []
        if c['provider'] == 'agent_rocketride':
            c['config']['instructions'] = instructions
            c['config']['max_waves'] = 12
    pipe['project_id'] = str(uuid.uuid4())
    return pipe


def build_agent_pipe(
    *,
    shared_id: str,
    telemetry_id: str,
    model: str,
    instructions: list[str],
    publish_table: str,
    role: str,
    reads_shared: bool = True,
    with_python: bool = False,
) -> dict:
    """One agent, its own private database, and the shared surfaces it is allowed.

    `publish_table` is where the agent's answer lands in shared evidence — the write is
    the answers lane, never a tool call, so it happens because the graph says so.
    """
    pipe = _base_pipe()
    template = next(c for c in pipe['components'] if c['provider'] == 'db_hotdata')

    private = _db_node(template, 'db_private_1', 'Private agent DB', 'workings')
    pipe['components'] = [c for c in pipe['components'] if c['provider'] != 'db_hotdata']
    pipe['components'].append(private)

    shared = _db_node(template, 'db_shared_1', 'Shared evidence DB', publish_table, shared_id)
    shared['input'] = [{'lane': 'answers', 'from': 'agent_inv'}]
    shared['ui'] = {'position': {'x': 540, 'y': 380}, 'nodeType': 'default', 'formDataValid': True}
    pipe['components'].append(shared)

    db_ids = ['db_private_1', 'db_shared_1']
    tool_ids = ['db_private_1'] + (['db_shared_1'] if reads_shared else [])

    if telemetry_id:
        # One table per role, not one table for every agent. Hotdata requires a write
        # to carry the table's full column set, and null-filling a numeric column
        # re-types it, which the server refuses - so a table can hold exactly one row
        # shape. A critic's verdict and an investigator's claim are different shapes.
        tele = _db_node(template, 'db_telemetry_1', 'Telemetry DB', f'answers_{role}', telemetry_id)
        tele['input'] = [{'lane': 'answers', 'from': 'agent_inv'}]
        tele['ui'] = {'position': {'x': 540, 'y': 560}, 'nodeType': 'default', 'formDataValid': True}
        pipe['components'].append(tele)
        db_ids.append('db_telemetry_1')

    if with_python:
        pipe['components'].append(
            {
                'id': 'tool_python_1',
                'provider': 'tool_python',
                'name': 'Python',
                'config': {
                    'profile': 'default',
                    'default': {'serverName': 'python', 'timeout': 60},
                    'parameters': {},
                },
                'control': [{'classType': 'tool', 'from': 'agent_inv'}],
                'ui': {'position': {'x': 800, 'y': 380}, 'nodeType': 'default', 'formDataValid': True},
            }
        )

    _wire(pipe, 'agent_inv', db_ids, tool_ids, instructions)
    return swap_llm(pipe, model)


# ---------------------------------------------------------------------------
# Role instructions
# ---------------------------------------------------------------------------

INVESTIGATOR_1A = [
    'You are an escape-room investigator. You hold clues for ONE beat of a stolen melody.',
    'db_private_1 is your own private database. db_shared_1 is the shared evidence database '
    'every other investigator also publishes into. You may READ db_shared_1 but never write '
    'to it: publishing is automatic and happens after you answer.',
    'Your message is JSON with "agent", "beat", "confidence" and "clues".',
    'STEP 1: db_private_1.load_data table="workings" mode="append" rows=<the clues array>.',
    'STEP 2: solve YOUR beat from your clues. Clue kinds:',
    '  cipher      - shift the ciphertext letter back 3 places through A B C D E F G, wrapping. '
    'Append the given octave. So ciphertext "F" with octave "4" resolves to C4.',
    '  scale_degree- take that degree of the given key. In C major degree 1=C, 2=D, 3=E, 4=F, '
    '5=G, 6=A, 7=B. Append the octave.',
    '  elimination - exactly one candidate survives every elimination. That is your note.',
    '  echo        - tells you where the same pitch recurs. It does NOT name the note.',
    '  noise       - irrelevant. Ignore it.',
    'STEP 3: if and only if a clue has kind "stray", it is a weak claim about SOMEONE ELSE\'S '
    'beat. Report it too, at the confidence the clue states, as a second entry. It may well '
    'be wrong - that is expected, report it anyway with its low confidence.',
    'FINAL ANSWER: reply with ONLY a JSON array of claim objects, no prose, no fences. Your own '
    'beat first: [{"session": <session from your message>, "agent": <your agent name>, '
    '"beat": <beat>, "note": <note like G4>, "confidence": <number>}] and one more object in '
    'the same shape for the stray claim if you had one.',
]

INVESTIGATOR_1B = [
    'You are an escape-room investigator. Your beat MIRRORS another beat: nothing in your own '
    'room resolves it. Another investigator has already published that beat to shared evidence.',
    'db_private_1 is your own private database. db_shared_1 is the shared evidence database. '
    'You may READ db_shared_1 but never write to it: publishing is automatic.',
    'Your message is JSON with "agent", "beat", "confidence" and "clues".',
    'STEP 1: db_private_1.load_data table="workings" mode="append" rows=<the clues array>.',
    'STEP 2: find the clue with kind "mirror" and read its "mirrors_beat". Then use '
    'db_shared_1.execute with SQL to read what was published for it, e.g. '
    'SELECT note, confidence FROM discoveries WHERE beat = <mirrors_beat> ORDER BY confidence DESC. '
    'The highest-confidence note there is YOUR note. If more than one note is on record, take the '
    'one with the higher confidence.',
    'STEP 3: if and only if a clue has kind "stray", it is a weak claim about SOMEONE ELSE\'S '
    'beat. Report it too, at the confidence the clue states, as a second entry.',
    'FINAL ANSWER: reply with ONLY a JSON array of claim objects, no prose, no fences: '
    '[{"session": <session from your message>, "agent": <your agent name>, "beat": <beat>, '
    '"note": <note>, "confidence": <number>}] plus the stray claim object if you had one.',
]

CRITIC = [
    'You are an Evidence Critic. Investigators have published claims into the shared evidence '
    'database. Some beats have TWO different notes on record, because a claim was planted or an '
    'agent was wrong. Your job is to find every such beat in your scope and resolve it.',
    'db_shared_1 is the shared evidence database; you may READ it. db_private_1 is your own.',
    'Your message is JSON with "agent", "session", "beat_from" and "beat_to".',
    'STEP 1: let the database find the contradictions - do not eyeball them. '
    'db_shared_1.execute this SQL, substituting your scope for <beat_from> and <beat_to>: '
    'SELECT beat FROM discoveries WHERE beat >= <beat_from> AND beat <= <beat_to> '
    'GROUP BY beat HAVING COUNT(DISTINCT note) > 1 ORDER BY beat',
    'Every beat that query returns is a contradiction. Every beat it does not return is NOT a '
    'contradiction, however it looks to you. If it returns no rows, your scope is clean.',
    'STEP 2: for EACH beat that came back, db_shared_1.execute: '
    'SELECT beat, note, confidence, agent FROM discoveries WHERE beat = <that beat> '
    'ORDER BY confidence DESC',
    'STEP 3: the FIRST row of that result is the winner, because it has the highest confidence. '
    'Never use your own musical judgement - the rule is confidence, and only confidence.',
    'STEP 4: db_private_1.load_data table="workings" mode="append" rows=<the rows you read>, so '
    'your reasoning is recorded.',
    'FINAL ANSWER: reply with ONLY a JSON array, one object per contradiction you found, and an '
    'empty array [] if you found none. No prose, no fences: '
    '[{"session": <session>, "beat": <beat>, "claim_a_agent": <agent>, "claim_a_note": <note>, '
    '"claim_a_confidence": <number>, "claim_b_agent": <agent>, "claim_b_note": <note>, '
    '"claim_b_confidence": <number>, "resolved_to": <winning note>, "resolved_by": <your agent name>}]',
]

CONDUCTOR = [
    'You are the Conductor. Every beat of the melody has been published to shared evidence by an '
    'investigator that saw only its own room, and the critics have resolved the beats that had two '
    'claims. Reconstruct the whole melody.',
    'STEP 1: db_shared_1.execute SQL to read every claim: '
    'SELECT beat, note, confidence FROM discoveries ORDER BY beat, confidence DESC',
    'STEP 2: for each beat keep ONLY the note with the highest confidence. That is the resolved '
    'melody. Copy the note strings verbatim - you are a transcriber, not a musician. Do not '
    'complete, correct or continue the tune from memory.',
    'STEP 3: db_shared_1.execute SQL to count the resolved contradictions: SELECT COUNT(*) AS n FROM contradictions',
    'FINAL ANSWER: reply with ONLY this JSON object, no prose, no fences: '
    '{"session": <session from your message>, "agent": "Conductor-01", "key": "C major", '
    '"tempo": 108, "confidence": 0.92, "beats": <how many beats you resolved>, '
    '"contradictions_resolved": <the count>, '
    '"melody": [{"beat": <beat>, "note": <note>}, ... one entry per beat, in beat order ...]}',
]

#: The composer is given the byte layout rather than left to invent a MIDI serializer.
#: Left to invent one it burned 275s and still emitted a file whose track header declared
#: 164 bytes over 46 bytes of data. It still does the real work - it reads the melody out
#: of the shared database and runs the code - but it is not asked to rediscover a 1996
#: file format under a stopwatch.
COMPOSER = [
    'You are the Composer. The Conductor has published the resolved melody to shared evidence. '
    'Render it as a real MIDI file.',
    'STEP 1: db_shared_1.execute this SQL to read the resolved melody: '
    'SELECT beat, note, confidence FROM discoveries ORDER BY beat, confidence DESC '
    '- then keep, for each beat, only the FIRST row (the highest confidence). That ordered '
    'list of notes is the melody.',
    'STEP 2: call python.execute with exactly this code, replacing NOTES with your ordered '
    'list of note strings and nothing else:',
    """
import struct, hashlib
NAMES = {'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
notes = NOTES
def vlq(n):
    out = bytearray([n & 0x7F]); n >>= 7
    while n: out.insert(0, (n & 0x7F) | 0x80); n >>= 7
    return bytes(out)
track = bytearray()
track += b'\\x00\\xff\\x51\\x03' + struct.pack('>I', 60000000 // 108)[1:]
for name in notes:
    pitch = 12 * (int(name[1:]) + 1) + NAMES[name[0]]
    track += vlq(0) + bytes([0x90, pitch, 100])
    track += vlq(480) + bytes([0x80, pitch, 0])
track += b'\\x00\\xff\\x2f\\x00'
midi = b'MThd' + struct.pack('>IHHH', 6, 0, 1, 480) + b'MTrk' + struct.pack('>I', len(track)) + bytes(track)
result = {'sha256': hashlib.sha256(midi).hexdigest(), 'bytes': len(midi), 'notes': len(notes)}
""".strip(),
    'STEP 3: the tool returns sha256, bytes and notes. Report those three, plus the ordered '
    'melody you read in step 1. They are all short - copy them exactly.',
    'FINAL ANSWER: reply with ONLY this JSON object, no prose, no fences: '
    '{"session": <session from your message>, "agent": "Composer-01", '
    '"midi_sha256": <the sha256 from the tool>, "midi_bytes": <the bytes value>, '
    '"notes": <the notes value>, "melody": <your ordered list of note strings>}',
]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def render_midi(notes: list[str], tempo: int = 108) -> bytes:
    """The same bytes the Composer's python tool produces, built here independently.

    The agent really does render the file — it runs this algorithm in the sandbox and
    reports the digest. The driver reproduces it so the artifact on disk can be proven
    byte-identical to what the agent produced, without asking a language model to
    transcribe 224 characters of base64, which it demonstrably cannot do: two runs
    returned files 8 bytes over and 108 bytes under their own declared track length.
    """
    import struct

    names = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}

    def vlq(n: int) -> bytes:
        out = bytearray([n & 0x7F])
        n >>= 7
        while n:
            out.insert(0, (n & 0x7F) | 0x80)
            n >>= 7
        return bytes(out)

    track = bytearray()
    track += b'\x00\xff\x51\x03' + struct.pack('>I', 60000000 // tempo)[1:]
    for name in notes:
        pitch = 12 * (int(name[1:]) + 1) + names[name[0]]
        track += vlq(0) + bytes([0x90, pitch, 100])
        track += vlq(480) + bytes([0x80, pitch, 0])
    track += b'\x00\xff\x2f\x00'
    return b'MThd' + struct.pack('>IHHH', 6, 0, 1, 480) + b'MTrk' + struct.pack('>I', len(track)) + bytes(track)


def _validate_midi(blob: bytes, expected_notes: int) -> tuple[bool, str]:
    """Is this a complete Standard MIDI File with the right number of notes?

    Checking the magic bytes alone is not enough and this is not hypothetical: a run
    passed a "valid" file whose track header declared 164 bytes over 46 bytes of data,
    because the agent truncated its base64. Verify the declared track length against
    what actually arrived, and count the note-on events.
    """
    import struct

    if len(blob) < 22 or blob[:4] != b'MThd':
        return False, f'not a MIDI header ({len(blob)} bytes)'
    header_len, fmt, tracks, division = struct.unpack('>IHHH', blob[4:14])
    if header_len != 6 or fmt not in (0, 1) or tracks < 1 or division <= 0:
        return False, f'bad header: len={header_len} format={fmt} tracks={tracks} division={division}'
    if blob[14:18] != b'MTrk':
        return False, 'no track chunk'
    declared = struct.unpack('>I', blob[18:22])[0]
    actual = len(blob) - 22
    if actual != declared:
        return False, f'truncated: track header declares {declared} bytes, file carries {actual}'
    data = blob[22:]
    note_ons = sum(1 for i in range(len(data) - 2) if data[i] == 0x90 and data[i + 2] > 0)
    if note_ons != expected_notes:
        return False, f'{note_ons} note-on events, expected {expected_notes}'
    if not data.endswith(b'\xff\x2f\x00'):
        return False, 'no end-of-track event'
    return True, f'{len(blob)} bytes, {note_ons} notes'


def claims_from(reply: object) -> list[dict]:
    """Every claim object in an agent's reply, whatever shape it wrapped them in."""
    out = extract_json(reply, 'beat')
    if isinstance(out, dict):
        return [out]
    # extract_json only finds objects; scan the raw strings for a bare array too.
    for text in _strings(reply):
        for candidate in _json_candidates(text):
            if isinstance(candidate, list) and candidate and all(isinstance(e, dict) for e in candidate):
                return candidate
            if isinstance(candidate, dict) and 'beat' in candidate:
                return [candidate]
    return []


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, (list, tuple)):
        return [s for v in value for s in _strings(v)]
    return []


def _json_candidates(text: str) -> list[object]:
    decoder = json.JSONDecoder()
    found = []
    for index, char in enumerate(text):
        if char in '[{':
            try:
                value, _ = decoder.raw_decode(text[index:])
            except ValueError:
                continue
            found.append(value)
    return found


async def run(args: argparse.Namespace) -> int:
    from rocketride import RocketRideClient

    results: list[bool] = []
    session = f'{time.strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:6]}'

    tele = Telemetry(enabled=not args.no_telemetry)
    telemetry_id = tele.open()
    shared = _hotdata('POST', '/v1/databases', {'name': f'symphony-escape-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'})
    shared_id = shared['id']

    print(f'session {session}')
    if telemetry_id:
        print(f'  telemetry database  {telemetry_id}  ({"created" if tele.created else "reused"}, persists)')
    print(f'  shared evidence     {shared_id}  (this run only)')
    print(
        f'  {design.agent_count()} agents, {design.total_clues()} clues, {len(design.MELODY)} beats, '
        f'{len(design.DECOYS)} planted contradictions\n'
    )

    client = RocketRideClient()
    await client.connect()
    tokens: list[str] = []
    started = time.monotonic()
    events: list[dict] = []
    registry: list[dict] = []

    async def run_agent(name: str, wave: int, pipe: dict, message: dict, label: str) -> object:
        token = f'esc-{name.lower()}-{uuid.uuid4().hex[:5]}'
        tokens.append(token)
        t0 = time.monotonic()
        error = ''
        reply: object = None
        try:
            await client.use(pipeline=pipe, token=token, ttl=900)
            reply = await ask(client, token, json.dumps(message))
        except Exception as e:  # noqa: BLE001
            error = str(e)[:300]
        events.append(
            {
                'session': session,
                'agent': name,
                'role': label,
                'wave': wave,
                'model': args.model,
                'duration_s': round(time.monotonic() - t0, 2),
                'error': error,
                'started_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                'answered': bool(reply) and not error,
            }
        )
        if error:
            print(f'    {name} failed: {error[:160]}')
        return reply

    try:
        # ---- wave 1A: nine investigators, each solving its own beat ----------
        t_wave = time.monotonic()

        async def investigator(name: str, beat: int, puzzle: str, wave: int, mirrors: int | None = None) -> None:
            clues = design.clues_for(name, beat, puzzle, mirrors)
            message = {
                'session': session,
                'agent': name,
                'beat': beat,
                'confidence': design.confidence_for(beat),
                'clues': clues,
            }
            pipe = build_agent_pipe(
                shared_id=shared_id,
                telemetry_id=telemetry_id,
                model=args.model,
                instructions=INVESTIGATOR_1A if puzzle != 'mirror' else INVESTIGATOR_1B,
                publish_table='discoveries',
                role='investigator',
            )
            reply = await run_agent(name, wave, pipe, message, 'investigator')
            claims = claims_from(reply)
            own = next((c for c in claims if str(c.get('beat')) == str(beat)), None)
            registry.append(
                {
                    'session': session,
                    'room': f'room-{beat}',
                    'agent': name,
                    'beat': beat,
                    'wave': wave,
                    'solved': bool(own and own.get('note')),
                    'claims_published': len(claims),
                }
            )

        await asyncio.gather(*(investigator(n, b, p, 1) for n, b, p in design.WAVE_1A), return_exceptions=True)
        rows = _sql(shared_id, 'SELECT beat FROM discoveries').get('rows', [])
        print(
            f'  wave 1A: 9 investigators (cipher/scale/logic)  {time.monotonic() - t_wave:.0f}s, '
            f'{len(rows)} claims in shared evidence'
        )

        # ---- wave 1B: six mirror investigators, dependent on 1A -------------
        t_wave = time.monotonic()
        await asyncio.gather(
            *(investigator(n, b, 'mirror', 2, m) for n, b, m in design.WAVE_1B), return_exceptions=True
        )
        rows = _sql(shared_id, 'SELECT beat FROM discoveries').get('rows', [])
        print(
            f'  wave 1B: 6 investigators (mirror, read shared) {time.monotonic() - t_wave:.0f}s, '
            f'{len(rows)} claims in shared evidence'
        )

        # ---- wave 2: three critics --------------------------------------------
        t_wave = time.monotonic()

        async def critic(name: str, lo: int, hi: int) -> None:
            pipe = build_agent_pipe(
                shared_id=shared_id,
                telemetry_id=telemetry_id,
                model=args.model,
                instructions=CRITIC,
                publish_table='contradictions',
                role='critic',
            )
            await run_agent(
                name,
                3,
                pipe,
                {'session': session, 'agent': name, 'beat_from': lo, 'beat_to': hi},
                'critic',
            )

        await asyncio.gather(*(critic(n, lo, hi) for n, lo, hi in design.CRITICS), return_exceptions=True)
        found = _sql(shared_id, 'SELECT beat, resolved_to, resolved_by FROM contradictions ORDER BY beat')
        contradictions = found.get('rows', [])
        print(
            f'  wave 2:  3 critics                            {time.monotonic() - t_wave:.0f}s, '
            f'{len(contradictions)} contradictions logged'
        )

        # ---- wave 3: the conductor ---------------------------------------------
        t_wave = time.monotonic()
        conductor_reply = await run_agent(
            design.CONDUCTOR,
            4,
            build_agent_pipe(
                shared_id=shared_id,
                telemetry_id=telemetry_id,
                model=args.model,
                instructions=CONDUCTOR,
                publish_table='synthesis',
                role='conductor',
            ),
            {'session': session, 'agent': design.CONDUCTOR},
            'conductor',
        )
        synthesis = extract_json(conductor_reply, 'melody')
        print(f'  wave 3:  1 conductor                          {time.monotonic() - t_wave:.0f}s')

        # ---- wave 4: the composer ----------------------------------------------
        t_wave = time.monotonic()
        composer_reply = await run_agent(
            design.COMPOSER,
            5,
            build_agent_pipe(
                shared_id=shared_id,
                telemetry_id=telemetry_id,
                model=args.model,
                instructions=COMPOSER,
                publish_table='renders',
                role='composer',
                with_python=True,
            ),
            {'session': session, 'agent': design.COMPOSER},
            'composer',
        )
        render = extract_json(composer_reply, 'midi_sha256')
        print(f'  wave 4:  1 composer                           {time.monotonic() - t_wave:.0f}s')

        elapsed = time.monotonic() - started
        tele.write('agent_runs_escape', events)
        tele.write('room_registry', registry)

        # ------------------------------------------------------------------
        # Checks, against the numbers in the debrief
        # ------------------------------------------------------------------
        print()
        claims = _sql(shared_id, 'SELECT beat, note, confidence, agent FROM discoveries ORDER BY beat').get('rows', [])
        by_beat: dict[int, list[tuple[str, float]]] = {}
        for beat, note, confidence, _agent in claims:
            by_beat.setdefault(int(beat), []).append((str(note), float(confidence or 0)))

        results.append(
            check(
                f'ROOMS: all {len(design.MELODY)} beats have a claim in shared evidence',
                set(by_beat) == set(range(1, len(design.MELODY) + 1)),
                f'{len(by_beat)}/{len(design.MELODY)}, missing='
                f'{sorted(set(range(1, len(design.MELODY) + 1)) - set(by_beat))}',
            )
        )

        # The decoys MUST have reached shared evidence, or the critic wave was a rehearsal.
        contested = {b for b, cl in by_beat.items() if len({n for n, _c in cl}) > 1}
        expected_contested = set(design.expected_contradictions())
        results.append(
            check(
                'DECOYS: all 3 planted claims reached shared evidence and contest a beat',
                expected_contested <= contested,
                f'contested beats {sorted(contested)}, expected {sorted(expected_contested)}',
            )
        )

        logged = {int(r[0]): (str(r[1]), str(r[2])) for r in contradictions}
        results.append(
            check(
                'CRITICS: exactly the 3 contradictions were found, at beats 3, 8 and 13',
                set(logged) == expected_contested,
                f'logged {sorted(logged)} expected {sorted(expected_contested)}',
            )
        )

        truth = design.expected_contradictions()
        misresolved = {b: logged[b][0] for b in logged if logged[b][0] != truth.get(b)}
        results.append(
            check(
                'RESOLUTION: every contradiction resolved to the high-confidence claim',
                bool(logged) and not misresolved,
                f'{ {b: logged[b] for b in sorted(logged)} }' if logged else 'none logged',
            )
        )

        resolved = {b: max(cl, key=lambda p: p[1])[0] for b, cl in by_beat.items()}
        expected_melody = list(design.MELODY)
        actual_melody = [resolved.get(b, '?') for b in range(1, len(design.MELODY) + 1)]
        results.append(
            check(
                'EVIDENCE: highest-confidence note per beat reconstructs the melody',
                actual_melody == expected_melody,
                f'{" ".join(actual_melody)}',
            )
        )

        melody = None
        if synthesis:
            entries = synthesis.get('melody')
            if isinstance(entries, list):
                pairs = [
                    (int(e['beat']), str(e['note']))
                    for e in entries
                    if isinstance(e, dict) and 'beat' in e and 'note' in e
                ]
                # Check beat identity before discarding it: duplicate or
                # out-of-range beats must not pass just because the sorted notes
                # line up with the expected melody.
                if pairs and sorted(b for b, _n in pairs) == list(range(1, len(pairs) + 1)):
                    melody = [n for _b, n in sorted(pairs)]
        results.append(
            check(
                'CONDUCTOR: reconstructed the melody from resolved evidence',
                melody == expected_melody,
                f'{" ".join(melody) if melody else melody}',
            )
        )

        # The agent rendered the file in its own sandbox and reported the digest. Rebuild
        # the same bytes here and require the digests to match: that proves the artifact
        # on disk is the agent's, byte for byte, without a language model having to
        # transcribe 224 characters of base64 - which it demonstrably cannot do. Two runs
        # returned files 8 bytes over and 108 bytes under their own declared track length.
        midi_ok, midi_detail, midi_path = False, 'no render reported', ''
        if render and render.get('midi_sha256'):
            blob = render_midi(expected_melody, design.TEMPO)
            ours = hashlib.sha256(blob).hexdigest()
            theirs = str(render.get('midi_sha256') or '').strip().lower()
            structurally_ok, structure = _validate_midi(blob, len(expected_melody))
            if not structurally_ok:
                midi_detail = f'reproduction is not a valid MIDI file: {structure}'
            elif ours != theirs:
                midi_detail = (
                    f'digest mismatch: the agent rendered {theirs[:16]}..., the resolved melody renders {ours[:16]}...'
                )
            else:
                OUTPUT_DIR.mkdir(exist_ok=True)
                path = OUTPUT_DIR / f'symphony_escape_{session}.mid'
                path.write_bytes(blob)
                midi_ok = True
                midi_path = str(path)
                midi_detail = f'{len(blob)} bytes, {len(expected_melody)} notes, sha256 matches -> {path}'
        results.append(check('COMPOSER: rendered a real MIDI file from the resolved melody', midi_ok, midi_detail))

        results.append(
            check(
                f'TIME: escaped inside the documented budget ({args.budget}s)',
                elapsed <= args.budget,
                f'{elapsed:.0f}s against ~400s for her 20 live agents',
            )
        )

        solved = sum(1 for r in registry if r['solved'])
        print(f'\n  ROOM REGISTRY: {solved}/{len(registry)} rooms solved')
        if melody:
            print(f'  >>> ESCAPED — {" ".join(melody)}')
            print(f'      {design.KEY} · {design.TEMPO} bpm{" · " + midi_path if midi_path and midi_ok else ""}')
        print(
            f'\n  {design.agent_count()} agents · {len(design.WAVE_1A) + len(design.WAVE_1B) + len(design.CRITICS) + 2}'
            f' private + 1 shared + 1 telemetry = 22 databases · 5 waves · {elapsed:.0f}s'
        )

        if logged:
            print('\n  CONTRADICTIONS RESOLVED (read back from shared evidence)')
            for beat in sorted(logged):
                note, by = logged[beat]
                print(f'    beat {beat:>2}  ->  {note}   resolved by {by}')

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
        print(f'shared evidence {shared_id} left to its 1h TTL (a Database API Token cannot delete)')


async def wiring_only(model: str) -> int:
    """No keys, no network: does the engine accept every one of the four graphs?"""
    import os

    from rocketride import RocketRideClient

    for k in ('ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID', 'ROCKETRIDE_OPENAI_KEY'):
        os.environ.setdefault(k, 'wiring-test-fake')

    client = RocketRideClient()
    await client.connect()
    ok = []
    graphs = [
        ('investigator', dict(instructions=INVESTIGATOR_1A, publish_table='discoveries', role='investigator')),
        ('critic', dict(instructions=CRITIC, publish_table='contradictions', role='critic')),
        ('conductor', dict(instructions=CONDUCTOR, publish_table='synthesis', role='conductor')),
        ('composer', dict(instructions=COMPOSER, publish_table='renders', role='composer', with_python=True)),
    ]
    try:
        for label, kwargs in graphs:
            token = f'wiring-{uuid.uuid4().hex[:6]}'
            try:
                pipe = build_agent_pipe(shared_id='db-fake', telemetry_id='db-fake-tele', model=model, **kwargs)
                await client.use(pipeline=pipe, token=token, ttl=60)
                ok.append(check(f'engine accepts the {label} graph', True))
            except Exception as e:  # noqa: BLE001
                ok.append(check(f'engine accepts the {label} graph', False, str(e)[:200]))
            finally:
                try:
                    await client.terminate(token)
                except Exception:  # noqa: BLE001
                    pass
    finally:
        await client.disconnect()
    return 0 if all(ok) else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=tuple(LLM_PROFILES), default='openai-strong')
    parser.add_argument('--budget', type=float, default=400.0, help='seconds; her live-agent run was ~400s')
    parser.add_argument('--wiring-only', action='store_true')
    parser.add_argument('--no-telemetry', action='store_true')
    args = parser.parse_args()
    _load_env()
    if args.wiring_only:
        return asyncio.run(wiring_only(args.model))
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
