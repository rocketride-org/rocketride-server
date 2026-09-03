"""AI Symphony Escape, exactly as Divya documented it — the puzzle, not the plumbing.

Everything here is her run debrief turned into data: the 15-beat melody, the 20 agents
in their four roles, the five dependency-ordered waves, the 49 clues across four puzzle
types, and the three contradictions planted so the critic wave has something real to
catch.

The contradiction table in her debrief is reproduced exactly, agent for agent:

    beat 3   Cryptographer-03  G4 (0.95)  vs  Musicologist-01    F4 (0.40)  -> EvidenceCritic-01
    beat 8   Musicologist-03   F4 (0.92)  vs  LogicSolver-01     A4 (0.40)  -> EvidenceCritic-02
    beat 13  TimelineAnalyst-02 D4 (0.92) vs  TimelineAnalyst-01 B4 (0.40)  -> EvidenceCritic-03

The decoys are the point. In the simplified harness a decoy stays in its room's private
database and never contradicts anything; here it is *published into shared evidence* at
low confidence, by an agent it does not belong to, which is the only way the critic wave
has work to do.
"""

from __future__ import annotations

#: "Twinkle, Twinkle, Little Star", 15 beats, as listed in the debrief.
MELODY = ['C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4', 'F4', 'F4', 'E4', 'E4', 'D4', 'D4', 'C4', 'C4']

#: C major, so a scale-degree clue resolves without accidentals.
SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
KEY = 'C major'
TEMPO = 108

#: Wave 1A - nine investigators whose beats are solvable from their own clues alone.
#: (agent, beat, puzzle type)
WAVE_1A = [
    ('Cryptographer-01', 1, 'cipher'),
    ('Cryptographer-02', 2, 'cipher'),
    ('Cryptographer-03', 3, 'cipher'),
    ('Musicologist-01', 5, 'scale_degree'),
    ('Musicologist-02', 7, 'scale_degree'),
    ('Musicologist-03', 8, 'scale_degree'),
    ('LogicSolver-01', 10, 'elimination'),
    ('LogicSolver-02', 12, 'elimination'),
    ('LogicSolver-03', 14, 'elimination'),
]

#: Wave 1B - six investigators whose beat mirrors one an earlier wave published. They
#: hold no clue that resolves it; the answer exists only in shared evidence.
#: (agent, beat, mirrored beat)
WAVE_1B = [
    ('PatternAnalyst-01', 4, 3),
    ('PatternAnalyst-02', 6, 5),
    ('PatternAnalyst-03', 9, 8),
    ('TimelineAnalyst-01', 11, 10),
    ('TimelineAnalyst-02', 13, 12),
    ('TimelineAnalyst-03', 15, 14),
]

#: The planted decoys: (carrier agent, someone else's beat, wrong note, confidence).
#: Each carrier publishes this alongside its own high-confidence claim.
DECOYS = [
    ('Musicologist-01', 3, 'F4', 0.40),
    ('LogicSolver-01', 8, 'A4', 0.40),
    ('TimelineAnalyst-01', 13, 'B4', 0.40),
]

#: Wave 2 - three critics, each owning a slice of the melody. The scopes are chosen so
#: each one contains exactly one planted contradiction, matching her debrief.
CRITICS = [
    ('EvidenceCritic-01', 1, 5),
    ('EvidenceCritic-02', 6, 10),
    ('EvidenceCritic-03', 11, 15),
]

CONDUCTOR = 'Conductor-01'
COMPOSER = 'Composer-01'

#: Confidence an investigator publishes its own beat at. High enough that the 0.40
#: decoy loses on the one rule the critics apply.
OWN_CONFIDENCE = {3: 0.95, 8: 0.92, 13: 0.92}
DEFAULT_CONFIDENCE = 0.93

#: Irrelevant clues, one per room, so a room that pattern-matches "any note mentioned
#: in my clues" gets it wrong.
NOISE = [
    'the room smells faintly of rosin',
    'a metronome in the corner is stopped at 60',
    'the previous occupant left a receipt for two coffees',
    'someone has written "not this one" on the wall in pencil',
    'a tuning fork rests on the sill, unstruck',
]


def note_letter(note: str) -> str:
    return note[0]


def octave(note: str) -> str:
    return note[1:]


def _cipher_clue(beat: int, note: str) -> dict:
    """The letter, shifted forward three places through A..G, wrapping."""
    letters = 'ABCDEFG'
    shifted = letters[(letters.index(note_letter(note)) + 3) % len(letters)]
    return {
        'beat': beat,
        'kind': 'cipher',
        'ciphertext': shifted,
        'rule': 'shift the letter back 3 places through the alphabet A B C D E F G, wrapping around',
        'octave': octave(note),
    }


def _scale_degree_clue(beat: int, note: str) -> dict:
    return {
        'beat': beat,
        'kind': 'scale_degree',
        'key': KEY,
        'degree': SCALE.index(note_letter(note)) + 1,
        'rule': 'the note is that scale degree of the key, where degree 1 is the tonic',
        'octave': octave(note),
    }


def _elimination_clue(beat: int, note: str) -> dict:
    """A logic grid: five candidates, four of them ruled out explicitly."""
    candidates = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4']
    if note not in candidates:
        candidates = [note] + candidates[:5]
    keep = [c for c in candidates if c != note][:4]
    return {
        'beat': beat,
        'kind': 'elimination',
        'candidates': sorted(set(keep + [note])),
        'eliminations': [f'the note is not {c}' for c in keep],
        'rule': 'exactly one candidate survives every elimination',
    }


def _mirror_clue(beat: int, mirrors: int) -> dict:
    return {
        'beat': beat,
        'kind': 'mirror',
        'mirrors_beat': mirrors,
        'rule': (
            f'this beat is the same note as beat {mirrors}, which another agent has already '
            'published to shared evidence. Nothing in this room resolves it.'
        ),
    }


def clues_for(agent: str, beat: int, puzzle: str, mirrors: int | None = None) -> list[dict]:
    """Every clue that lands in one room: signal, noise, and any planted decoy."""
    note = MELODY[beat - 1]
    if puzzle == 'cipher':
        clues = [_cipher_clue(beat, note)]
    elif puzzle == 'scale_degree':
        clues = [_scale_degree_clue(beat, note)]
    elif puzzle == 'elimination':
        clues = [_elimination_clue(beat, note)]
    else:
        clues = [_mirror_clue(beat, mirrors or 0)]

    # A cross-beat echo. Deliberately does NOT carry the note: it says where else the
    # same pitch occurs, which corroborates the puzzle without solving it. An echo that
    # spelled the answer out would make the cipher and the logic grid decoration.
    if puzzle != 'mirror':
        twin = next((b for b in range(1, len(MELODY) + 1) if b != beat and MELODY[b - 1] == note), None)
        if twin:
            clues.append(
                {
                    'beat': beat,
                    'kind': 'echo',
                    'text': f'whatever sounds at beat {beat} sounds again at beat {twin}',
                }
            )

    clues.append({'beat': 0, 'kind': 'noise', 'text': NOISE[beat % len(NOISE)]})
    # A second piece of noise in half the rooms, to reach the 49 clues in the debrief.
    if beat % 2 == 0:
        clues.append({'beat': 0, 'kind': 'noise', 'text': NOISE[(beat + 2) % len(NOISE)]})

    for carrier, target, wrong, conf in DECOYS:
        if carrier == agent:
            clues.append(
                {
                    'beat': target,
                    'kind': 'stray',
                    'note': wrong,
                    'confidence': conf,
                    'text': (
                        f'a torn page claims beat {target} is {wrong}. It is not your beat and the '
                        'page is water-damaged, so you are only weakly confident in it.'
                    ),
                }
            )
    return clues


def decoy_for(agent: str) -> tuple[int, str, float] | None:
    for carrier, target, wrong, conf in DECOYS:
        if carrier == agent:
            return target, wrong, conf
    return None


def confidence_for(beat: int) -> float:
    return OWN_CONFIDENCE.get(beat, DEFAULT_CONFIDENCE)


def total_clues() -> int:
    count = 0
    for agent, beat, puzzle in WAVE_1A:
        count += len(clues_for(agent, beat, puzzle))
    for agent, beat, mirrors in WAVE_1B:
        count += len(clues_for(agent, beat, 'mirror', mirrors))
    return count


def agent_count() -> int:
    return len(WAVE_1A) + len(WAVE_1B) + len(CRITICS) + 2


def expected_contradictions() -> dict[int, str]:
    """Beat -> the note that must win, i.e. the truth, not the decoy."""
    return {beat: MELODY[beat - 1] for _agent, beat, _note, _conf in DECOYS}
