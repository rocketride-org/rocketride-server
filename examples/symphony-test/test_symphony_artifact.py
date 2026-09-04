"""Symphony Escape checked against the claims in Divya's published artifact.

`test_symphony_escape.py` runs her design and checks the *outcome*: the melody comes
back, the three planted contradictions are caught, the MIDI file is real. That is a
necessary test and not a sufficient one, because a run can produce the right melody
while violating every architectural claim the artifact makes about how it got there.
An agent that quietly read another room's clues, or published a discovery nothing can
attribute, still returns "Twinkle, Twinkle, Little Star".

This test checks the claims instead. They are transcribed in ARTIFACT.md next to this
file, with the two places the implementation deliberately differs and why.

    DATABASES      every agent owns a private database holding clues, observations,
                   hypotheses, evidence and discoveries
    ISOLATION      "no agent ever saw the whole picture" - verified by querying each
                   private database directly, not by asking the agent
    REGISTRY       a write-only room registry, one row per room, 20/20 solved
    ATTRIBUTION    every discovery carries an agent and a confidence, and joins to a
                   measured timestamp in one SQL query
    BLOCKED        a mirror agent whose dependency has not been published reports
                   itself blocked instead of guessing
    APPEND_ONLY    nothing is ever updated or removed; later rows only accumulate
    CONTRADICTIONS the three planted decoys are all caught; a fourth from a genuine
                   race is reported, not failed - her live run found exactly that
    REPLAY         one SQL query over shared evidence reconstructs all 15 beats

The interesting one is ISOLATION. Nothing in this repo has verified it before: the
Database API Token cannot list databases, so the private rooms were taken on trust. It
turns out it does not have to be - an agent can report the id of the database its own
node provisioned, and the driver can then query that database itself, while the run is
still alive, and read what is actually in it. The agent's self-report is reduced to one
opaque id it has no reason to fake and no ability to fake usefully.

    python3 examples/symphony-test/test_symphony_artifact.py
    python3 examples/symphony-test/test_symphony_artifact.py --wiring-only   # no keys
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.error
import uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import escape_design as design  # noqa: E402
from telemetry import Telemetry  # noqa: E402
from test_attach import _hotdata, _load_env, _sql  # noqa: E402
from test_option1 import ask, check  # noqa: E402
from test_symphony_escape import (  # noqa: E402
    COMPOSER,
    CONDUCTOR,
    CRITIC,
    build_agent_pipe,
    claims_from,
)
from test_symphony_waves import LLM_PROFILES  # noqa: E402

#: The five tables the artifact says an agent's own database holds.
PRIVATE_TABLES = ('clues', 'observations', 'hypotheses', 'evidence', 'discoveries')


# ---------------------------------------------------------------------------
# Role instructions
#
# Same puzzle as test_symphony_escape, three additions the claims require: the five
# private tables rather than one `workings` table, the private database_id on every
# claim so the driver can verify the room itself, and an explicit blocked state.
# ---------------------------------------------------------------------------

_PRIVATE_DB_STEPS = [
    'STEP 1: record your work in your OWN database. Five load_data calls, all with '
    'mode="append", and you may issue them together:',
    '  table="clues"        rows=<the clues array from your message, unchanged>',
    '  table="observations" rows=<one row {"beat","kind","observation"} per clue, saying what you read off it>',
    '  table="hypotheses"   rows=<one row {"beat","note","confidence"} per note you '
    'considered, including the ones you rejected>',
    '  table="evidence"     rows=<one row {"beat","note","why"} for the note you settled on and what settled it>',
    'The fifth table, "discoveries", comes last - it is STEP 4.',
]

_FINAL_ANSWER_SHAPE = (
    'FINAL ANSWER: reply with ONLY a JSON array of claim objects, no prose, no fences. '
    'Your own beat first. Every object carries all six keys: '
    '[{"session": <session from your message>, "agent": <your agent name>, '
    '"beat": <beat>, "note": <note like G4>, "confidence": <number>, '
    '"database_id": <the id from db_private_1.get_schema>}] '
    'and one more object in the same shape for the stray claim if you had one, carrying '
    'the same database_id.'
)

INVESTIGATOR_1A = [
    'You are an escape-room investigator. You hold clues for ONE beat of a stolen melody.',
    'db_private_1 is your own private database. db_shared_1 is the shared evidence database '
    'every other investigator also publishes into. You may READ db_shared_1 but never write '
    'to it: publishing is automatic and happens after you answer.',
    'Your message is JSON with "agent", "beat", "confidence" and "clues".',
    *_PRIVATE_DB_STEPS,
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
    'STEP 4: call db_private_1.get_schema once and note the database_id. Then '
    'db_private_1.load_data table="discoveries" mode="append" '
    'rows=<one row {"beat","note","confidence"} per claim you are about to report>.',
    _FINAL_ANSWER_SHAPE,
]

INVESTIGATOR_1B = [
    'You are an escape-room investigator. Your beat MIRRORS another beat: nothing in your own '
    'room resolves it. Another investigator may already have published that beat to shared '
    'evidence.',
    'db_private_1 is your own private database. db_shared_1 is the shared evidence database. '
    'You may READ db_shared_1 but never write to it: publishing is automatic.',
    'Your message is JSON with "agent", "beat", "confidence" and "clues".',
    *_PRIVATE_DB_STEPS,
    'STEP 2: find the clue with kind "mirror" and read its "mirrors_beat". Then use '
    'db_shared_1.execute with SQL to read what was published for it, e.g. '
    'SELECT note, confidence FROM discoveries WHERE beat = <mirrors_beat> ORDER BY confidence DESC. '
    'The highest-confidence note there is YOUR note.',
    'STEP 2b: if that query returns no rows, or fails because the table does not exist, then '
    'your dependency has NOT been published yet and your beat is unresolvable. Do NOT guess a '
    'note, do not reason about what the melody probably is, and do not use your own musical '
    'knowledge. Report yourself blocked - see the blocked answer shape below.',
    'STEP 3: if and only if a clue has kind "stray", it is a weak claim about SOMEONE ELSE\'S '
    'beat. Report it too, at the confidence the clue states, as a second entry.',
    'STEP 4: call db_private_1.get_schema once and note the database_id. Then '
    'db_private_1.load_data table="discoveries" mode="append" '
    'rows=<one row {"beat","note","confidence"} per claim you are about to report>. If you are '
    'blocked, load one row {"beat": <your beat>, "note": "BLOCKED", "confidence": 0} instead.',
    _FINAL_ANSWER_SHAPE,
    'BLOCKED ANSWER: if and only if step 2b applies, reply with ONLY this JSON array instead, '
    'no prose, no fences: [{"session": <session>, "agent": <your agent name>, '
    '"beat": <your beat>, "blocked": true, "waiting_on": <the mirrors_beat>, '
    '"database_id": <the id from db_private_1.get_schema>}]',
]


# ---------------------------------------------------------------------------
# Reading a database the driver did not create
# ---------------------------------------------------------------------------


def _pipe(**kwargs) -> dict:
    """build_agent_pipe, with each database described to the agent as what it actually is.

    `investigator.pipe` describes its one `db_hotdata` node as "One investigator's private
    room. clues(beat, note, source)", and `build_agent_pipe` clones that node three times -
    so shared evidence and the telemetry store both introduce themselves to the agent as
    its private room. It mostly gets this right anyway because the tool ids say
    `db_private_1` and `db_shared_1`, but a tool description that contradicts the
    instructions is a coin flip nobody needs, and this test is specifically about what an
    agent can see and reach.
    """
    pipe = build_agent_pipe(**kwargs)
    described = {
        'db_private_1': (
            'clues',
            'YOUR OWN private database. No other agent can read it. Tables: '
            'clues(the clues you were handed), observations(beat, kind, observation), '
            'hypotheses(beat, note, confidence), evidence(beat, note, why), '
            'discoveries(beat, note, confidence).',
        ),
        'db_shared_1': (
            None,
            'The SHARED evidence database every agent publishes into. Read it freely; never '
            'write to it - your answer is published for you. '
            'discoveries(session, agent, beat, note, confidence, database_id), '
            'contradictions(...), room_registry(...).',
        ),
        'db_telemetry_1': (None, 'Telemetry store, written by the pipeline. Not a tool; you cannot reach it.'),
    }
    for c in pipe['components']:
        if c['provider'] == 'db_hotdata' and c['id'] in described:
            table, description = described[c['id']]
            if table:
                c['config']['default']['table'] = table
            c['config']['default']['db_description'] = description
    return pipe


def _try_sql(database_id: str, sql: str) -> tuple[list, str]:
    """Rows, or an empty list and the error - a failed probe must not abort the run.

    Every call here is a probe against a database the driver does not own, over a token
    whose scope is already known to be partial (`GET /v1/databases/{id}` is 403). A
    check that cannot run should report why, not raise into the wave that called it.
    """
    try:
        return _sql(database_id, sql).get('rows', []) or [], ''
    except urllib.error.HTTPError as e:  # noqa: PERF203
        body = ''
        try:
            body = e.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        return [], f'HTTP {e.code} {body}'
    except Exception as e:  # noqa: BLE001
        return [], str(e)[:200]


def _as_int(value: object) -> int | None:
    """A beat as an int, or None if it is not one.

    try/except rather than a string predicate, for the reason `beat_note_pairs` in
    test_symphony_escape spells out: `str(v).lstrip('-').isdigit()` strips *every*
    leading hyphen, so "--1" passes the test and then raises on int().
    """
    if isinstance(value, bool):
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _tables_in(database_id: str) -> tuple[set, str]:
    """The table names in a database, read over SQL.

    `information_schema` rather than the REST schema endpoint on purpose: the endpoint
    needs a connection id the driver cannot fetch for a database it did not create.
    """
    rows, error = _try_sql(database_id, 'SELECT table_name FROM information_schema.tables')
    return {str(r[0]) for r in rows if r}, error


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


async def run(args: argparse.Namespace) -> int:  # noqa: PLR0915
    from rocketride import RocketRideClient

    results: list[bool] = []
    session = f'{time.strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:6]}'

    tele = Telemetry(enabled=not args.no_telemetry)
    telemetry_id = tele.open()
    shared = _hotdata(
        'POST', '/v1/databases', {'name': f'symphony-artifact-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'}
    )
    shared_id = shared['id']

    print(f'session {session}')
    if telemetry_id:
        print(f'  telemetry database  {telemetry_id}  ({"created" if tele.created else "reused"}, persists)')
    print(f'  shared evidence     {shared_id}  (this run only)')
    print(f'  checking {design.agent_count()} agents against the claims in ARTIFACT.md\n')

    client = RocketRideClient()
    await client.connect()
    tokens: list[str] = []
    started = time.monotonic()

    #: agent -> what the driver read out of that agent's own database, and when.
    rooms: dict[str, dict] = {}
    events: list[dict] = []

    async def run_agent(name: str, wave: int, pipe: dict, message: dict, label: str) -> object:
        token = f'art-{name.lower()}-{uuid.uuid4().hex[:5]}'
        tokens.append(token)
        t0 = time.monotonic()
        started_at = time.strftime('%Y-%m-%dT%H:%M:%S')
        error = ''
        reply: object = None
        try:
            await client.use(pipeline=pipe, token=token, ttl=900)
            reply = await ask(client, token, json.dumps(message))
        except Exception as e:  # noqa: BLE001
            error = str(e)[:300]
        rooms.setdefault(name, {})
        rooms[name].update(
            {
                'agent': name,
                'role': label,
                'wave': wave,
                'started_at': started_at,
                'duration_s': round(time.monotonic() - t0, 2),
                'error': error,
            }
        )
        events.append({'session': session, 'model': args.model, **rooms[name]})
        if error:
            print(f'    {name} failed: {error[:160]}')
        return reply

    try:
        # ---- BLOCKED, first and on its own ------------------------------------
        #
        # Run one mirror agent against a shared database nobody has published into.
        # Deliberately a throwaway database rather than the real one: the point is an
        # unmet dependency, and creating that state inside the real run would mean
        # holding wave 1A back, which is the one thing the design is built not to do.
        t_wave = time.monotonic()
        empty = _hotdata(
            'POST', '/v1/databases', {'name': f'symphony-empty-{uuid.uuid4().hex[:8]}', 'expires_at': '1h'}
        )
        probe_name, probe_beat, probe_mirrors = design.WAVE_1B[0]
        blocked_reply = await run_agent(
            f'{probe_name}-probe',
            0,
            _pipe(
                shared_id=empty['id'],
                telemetry_id='',
                model=args.model,
                instructions=INVESTIGATOR_1B,
                publish_table='discoveries',
                role='investigator',
            ),
            {
                'session': session,
                'agent': f'{probe_name}-probe',
                'beat': probe_beat,
                'confidence': design.confidence_for(probe_beat),
                'clues': design.clues_for(probe_name, probe_beat, 'mirror', probe_mirrors),
            },
            'probe',
        )
        print(f'  probe:   1 mirror agent, empty evidence      {time.monotonic() - t_wave:.0f}s')

        # ---- waves 1A and 1B: fifteen investigators ---------------------------
        async def investigator(name: str, beat: int, puzzle: str, wave: int, mirrors: int | None = None) -> None:
            message = {
                'session': session,
                'agent': name,
                'beat': beat,
                'confidence': design.confidence_for(beat),
                'clues': design.clues_for(name, beat, puzzle, mirrors),
            }
            pipe = _pipe(
                shared_id=shared_id,
                telemetry_id=telemetry_id,
                model=args.model,
                instructions=INVESTIGATOR_1A if puzzle != 'mirror' else INVESTIGATOR_1B,
                publish_table='discoveries',
                role='investigator',
            )
            reply = await run_agent(name, wave, pipe, message, 'investigator')

            # Read the room while it still exists. db_private_1 has no database_id, so
            # the node provisioned this database at the start of the run and destroys it
            # at teardown - and teardown is `terminate`, in the finally below. This is
            # the whole window, and it is why the check runs here and not at the end.
            claims = claims_from(reply)
            private_id = next((str(c['database_id']) for c in claims if c.get('database_id')), '')
            own = next((c for c in claims if str(c.get('beat')) == str(beat)), None)
            tables, table_error = _tables_in(private_id) if private_id else (set(), 'no database_id reported')
            clue_beats, clue_error = ([], '')
            if 'clues' in tables:
                clue_beats, clue_error = _try_sql(private_id, 'SELECT DISTINCT beat FROM clues')
            rooms[name].update(
                {
                    'beat': beat,
                    'private_database_id': private_id,
                    'private_tables': sorted(tables),
                    'private_error': table_error or clue_error,
                    'clue_beats': sorted({b for b in (_as_int(r[0]) for r in clue_beats if r) if b is not None}),
                    'solved': bool(own and own.get('note')),
                }
            )

        t_wave = time.monotonic()
        await asyncio.gather(*(investigator(n, b, p, 1) for n, b, p in design.WAVE_1A), return_exceptions=True)
        print(f'  wave 1A: 9 investigators                     {time.monotonic() - t_wave:.0f}s')

        t_wave = time.monotonic()
        await asyncio.gather(
            *(investigator(n, b, 'mirror', 2, m) for n, b, m in design.WAVE_1B), return_exceptions=True
        )
        print(f'  wave 1B: 6 investigators                     {time.monotonic() - t_wave:.0f}s')

        # Snapshot before the critics run, for APPEND_ONLY. Taken here rather than at the
        # end because the claim is that nothing already written can change, and the only
        # writers after this point are the critics, conductor and composer.
        before, _ = _try_sql(shared_id, 'SELECT agent, beat, note, confidence FROM discoveries')
        snapshot = {(str(a), str(b), str(n), str(c)) for a, b, n, c in before}

        # ---- wave 2: three critics --------------------------------------------
        t_wave = time.monotonic()

        async def critic(name: str, lo: int, hi: int) -> None:
            await run_agent(
                name,
                3,
                _pipe(
                    shared_id=shared_id,
                    telemetry_id=telemetry_id,
                    model=args.model,
                    instructions=CRITIC,
                    publish_table='contradictions',
                    role='critic',
                ),
                {'session': session, 'agent': name, 'beat_from': lo, 'beat_to': hi},
                'critic',
            )

        await asyncio.gather(*(critic(n, lo, hi) for n, lo, hi in design.CRITICS), return_exceptions=True)
        print(f'  wave 2:  3 critics                           {time.monotonic() - t_wave:.0f}s')

        # ---- waves 3 and 4: conductor and composer ----------------------------
        # Run so the registry really covers 20 rooms. Their outputs are already checked
        # by test_symphony_escape; nothing here re-checks the melody or the MIDI file.
        t_wave = time.monotonic()
        await run_agent(
            design.CONDUCTOR,
            4,
            _pipe(
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
        await run_agent(
            design.COMPOSER,
            5,
            _pipe(
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
        print(f'  wave 3-4: conductor and composer             {time.monotonic() - t_wave:.0f}s')

        elapsed = time.monotonic() - started

        # The registry is the driver's, written once, read by nobody. It carries the
        # measured timestamp that ATTRIBUTION joins to - a number no model was asked for.
        registry = [
            {
                'session': session,
                'agent': r['agent'],
                'role': r['role'],
                'wave': r['wave'],
                'room': f'room-{r.get("beat", 0)}',
                'solved': bool(r.get('solved', not r['error'])),
                'started_at': r['started_at'],
                'duration_s': r['duration_s'],
                'private_database_id': str(r.get('private_database_id', '')),
            }
            for r in rooms.values()
            if r['role'] != 'probe'
        ]
        _hotdata('POST', '/v1/tables/load', {'table': 'room_registry', 'mode': 'append', 'rows': registry}, shared_id)
        tele.write('agent_runs_artifact', events)

        # ------------------------------------------------------------------
        # The claims
        # ------------------------------------------------------------------
        print()
        investigators = [r for r in rooms.values() if r['role'] == 'investigator']
        reported = [r for r in investigators if r.get('private_database_id')]
        readable = [r for r in investigators if r.get('private_tables')]

        # DATABASES
        missing = {r['agent']: sorted(set(PRIVATE_TABLES) - set(r['private_tables'])) for r in readable}
        complete = [a for a, m in missing.items() if not m]
        first_error = next((r['private_error'] for r in investigators if r.get('private_error')), '')
        results.append(
            check(
                f'DATABASES: every room holds all {len(PRIVATE_TABLES)} tables the artifact names',
                bool(readable) and len(complete) == len(investigators),
                f'{len(complete)}/{len(investigators)} complete, {len(readable)}/{len(investigators)} readable'
                + (f'; first error: {first_error}' if first_error else '')
                + (f'; short: { {a: m for a, m in missing.items() if m} }' if any(missing.values()) else ''),
            )
        )

        # ISOLATION - the claim the whole design rests on, and the one never checked.
        # A room may hold its own beat and beats it was handed a decoy about. Anything
        # else in its clues table came from somewhere it should not have been able to see.
        leaks = {}
        for r in readable:
            decoy = design.decoy_for(r['agent'])
            allowed = {0, r['beat']} | ({decoy[0]} if decoy else set())
            seen = set(r['clue_beats']) - allowed
            if seen:
                leaks[r['agent']] = sorted(seen)
        distinct = {r['private_database_id'] for r in reported}
        results.append(
            check(
                'ISOLATION: every room is a distinct database holding only its own clues',
                bool(readable) and not leaks and len(distinct) == len(reported) == len(investigators),
                f'{len(distinct)} distinct databases across {len(investigators)} rooms'
                + (f', leaked beats {leaks}' if leaks else ", no room saw another room's clues"),
            )
        )

        # REGISTRY
        reg_rows, reg_error = _try_sql(shared_id, 'SELECT agent, solved FROM room_registry')
        solved = [r for r in reg_rows if str(r[1]).lower() in ('true', '1')]
        results.append(
            check(
                f'REGISTRY: write-only registry covers all {design.agent_count()} rooms',
                len(reg_rows) == design.agent_count(),
                f'{len(solved)}/{len(reg_rows)} solved, expected {design.agent_count()} rooms'
                + (f'; {reg_error}' if reg_error else ''),
            )
        )

        # ATTRIBUTION
        attributed, attr_error = _try_sql(
            shared_id,
            'SELECT d.agent, d.beat, d.confidence, r.started_at '
            'FROM discoveries d JOIN room_registry r ON d.agent = r.agent ORDER BY d.beat',
        )
        discoveries, _ = _try_sql(shared_id, 'SELECT agent, beat, note, confidence FROM discoveries')
        anonymous = [row for row in attributed if not all(str(v).strip() and str(v) != 'None' for v in row)]
        results.append(
            check(
                'ATTRIBUTION: every discovery joins to an agent, a confidence and a measured time',
                bool(attributed) and not anonymous and len(attributed) == len(discoveries),
                f'{len(attributed)}/{len(discoveries)} discovery rows attributable in one query'
                + (f'; {len(anonymous)} incomplete' if anonymous else '')
                + (f'; {attr_error}' if attr_error else ''),
            )
        )

        # BLOCKED
        probe_claims = claims_from(blocked_reply)
        # Models emit the flag as a bool or as the string "true", unpredictably, and a
        # format quibble must not be reported as an agent that guessed.
        said_blocked = any(str(c.get('blocked')).lower() == 'true' for c in probe_claims)
        guessed = [c.get('note') for c in probe_claims if c.get('note') and str(c.get('note')) != 'BLOCKED']
        results.append(
            check(
                'BLOCKED: a mirror agent with no published dependency refuses to guess',
                said_blocked and not guessed,
                f'reported blocked on beat {probe_beat} (mirrors {probe_mirrors})'
                if said_blocked and not guessed
                else f'blocked={said_blocked}, guessed {guessed}',
            )
        )

        # APPEND_ONLY
        after, _ = _try_sql(shared_id, 'SELECT agent, beat, note, confidence FROM discoveries')
        now = {(str(a), str(b), str(n), str(c)) for a, b, n, c in after}
        lost = snapshot - now
        results.append(
            check(
                'APPEND_ONLY: nothing written before the critic wave was changed or removed',
                bool(snapshot) and not lost,
                f'{len(snapshot)} rows before the critics, {len(now)} after'
                + (f', {len(lost)} lost: {sorted(lost)[:3]}' if lost else ', all still present'),
            )
        )

        # CONTRADICTIONS - "4 / 3 planted + 1 real race" in her live run, so a fourth is
        # the design working, not failing. Missing one of the three planted is failing.
        logged_rows, _ = _try_sql(shared_id, 'SELECT beat, resolved_to FROM contradictions ORDER BY beat')
        logged = {b: str(r[1]) for r in logged_rows if (b := _as_int(r[0])) is not None}
        truth = design.expected_contradictions()
        planted_found = set(truth) <= set(logged)
        misresolved = {b: logged[b] for b in truth if b in logged and logged[b] != truth[b]}
        extra = sorted(set(logged) - set(truth))
        results.append(
            check(
                'CONTRADICTIONS: all 3 planted decoys caught and resolved by confidence',
                planted_found and not misresolved,
                f'planted {sorted(truth)} -> { {b: logged.get(b) for b in sorted(truth)} }'
                + (f'; plus {len(extra)} race(s) at {extra}' if extra else '')
                + (f'; misresolved {misresolved}' if misresolved else ''),
            )
        )

        # REPLAY - the artifact's "a SQL query away", taken literally: one query, run by
        # the driver against shared evidence, with no agent in the loop.
        replay_rows, replay_error = _try_sql(
            shared_id,
            'SELECT beat, note FROM discoveries d '
            'WHERE confidence = (SELECT MAX(confidence) FROM discoveries WHERE beat = d.beat) '
            'ORDER BY beat',
        )
        by_beat: dict[int, str] = {}
        for beat, note in replay_rows:
            resolved = _as_int(beat)
            if resolved is not None:
                by_beat.setdefault(resolved, str(note))
        replayed = [by_beat.get(b, '?') for b in range(1, len(design.MELODY) + 1)]
        results.append(
            check(
                f'REPLAY: one SQL query reconstructs all {len(design.MELODY)} beats',
                replayed == list(design.MELODY),
                ' '.join(replayed) + (f'; {replay_error}' if replay_error else ''),
            )
        )

        print(f'\n  {len(distinct)} rooms read directly, {len(discoveries)} discoveries, {elapsed:.0f}s')
        print('  artifact reports 35 discoveries; see ARTIFACT.md for why that is not asserted')
        print()
        print(f'{sum(results)}/{len(results)} claims hold')
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
    """No keys, no network: does the engine accept the graphs this test builds?"""
    import os

    from rocketride import RocketRideClient

    for k in ('ROCKETRIDE_DB_HOTDATA_KEY', 'ROCKETRIDE_DB_HOTDATA_WORKSPACE_ID', 'ROCKETRIDE_OPENAI_KEY'):
        os.environ.setdefault(k, 'wiring-test-fake')

    client = RocketRideClient()
    await client.connect()
    ok = []
    graphs = [
        ('investigator-1a', dict(instructions=INVESTIGATOR_1A, publish_table='discoveries', role='investigator')),
        ('investigator-1b', dict(instructions=INVESTIGATOR_1B, publish_table='discoveries', role='investigator')),
        ('critic', dict(instructions=CRITIC, publish_table='contradictions', role='critic')),
        ('conductor', dict(instructions=CONDUCTOR, publish_table='synthesis', role='conductor')),
        ('composer', dict(instructions=COMPOSER, publish_table='renders', role='composer', with_python=True)),
    ]
    try:
        for label, kwargs in graphs:
            token = f'wiring-{uuid.uuid4().hex[:6]}'
            try:
                pipe = _pipe(shared_id='db-fake', telemetry_id='db-fake-tele', model=model, **kwargs)
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
    parser.add_argument('--wiring-only', action='store_true')
    parser.add_argument('--no-telemetry', action='store_true')
    args = parser.parse_args()
    _load_env()
    if args.wiring_only:
        return asyncio.run(wiring_only(args.model))
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
