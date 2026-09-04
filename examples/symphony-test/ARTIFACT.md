# The artifact, transcribed

Divya's published debrief lives at
`claude.ai/code/artifact/e5037e84-51f9-4f76-bc70-80a248db6112`. It renders inside a
signed-in iframe, so it is transcribed here: the tests below assert against these
sentences, and a reader needs to be able to check them without an account.

Only the load-bearing claims are kept. Prose about the puzzle design is not repeated —
that is already data in `escape_design.py`.

## Headline

> 20 agents · 22 databases · 49 clues · 35 discoveries · 3 contradictions · ~3.4m run time
>
> ESCAPED · 20/20 rooms solved

> 20 agents, each with its own Hotdata database, independently decoded fragments of a
> stolen 15-beat melody and reconstructed it by reading and writing a shared evidence
> database — no agent ever saw the whole picture.

Two execution modes are reported, on the same architecture:

| | Deterministic pipeline | 20 live agents |
|---|---|---|
| Executor | 1 Python process | 21 Claude invocations |
| Reasoning | regex + rules | genuine, per-agent |
| Wall clock | ~205s | ~400s, 5 waves |
| Token cost | 0 | ~877,000 |
| Contradictions found | 3 / 3 planted | **4 / 3 planted + 1 real race** |

## The claims this repo tests

Each is quoted, then given the id the conformance test reports it under.

**DATABASES** — "Every agent has exclusive read/write access to its own database — its
clues, its reasoning, its confidence scores." The private database is described as
holding `clues, observations, hypotheses, evidence, discoveries`.

**ISOLATION** — "no agent ever saw the whole picture"; "None of the 20 agents saw one
another's conversation. Every fact that mattered ... existed only because it was written
to Hotdata first. Coordination is a query, not a relay."

**REGISTRY** — a third surface beside the private and shared databases: "Room registry —
which of the 20 rooms is solved — **write-only**."

**ATTRIBUTION** — "Each of the 35 discoveries carries its own agent_id, confidence, and
timestamp. The full path from 49 raw clues to one resolved melody is a SQL query away —
nothing about the result depends on trusting an agent's self-report."

**BLOCKED** — "The six mirror-dependent agents didn't wait on an event system — they
queried shared evidence for a specific key and either got their answer **or reported
themselves blocked**."

**APPEND_ONLY** — "Hotdata's `tables load` is append-only (there's no `UPDATE`), so
'current state' is always read as 'the latest, highest-confidence row for this key' —
which turns out to model contradiction and correction naturally." And: "'two agents
disagree' and 'one agent corrected itself' look identical in the data — multiple rows
for the same key. One resolution rule (highest published confidence) handles both,
**including the race no one planned for**."

**CONTRADICTIONS** — the three planted decoys, resolved by confidence:

| Beat | Claim A | Claim B | Resolved to | Resolved by |
|---|---|---|---|---|
| 3 | Cryptographer-03 · G4 (0.95) | Musicologist-01 · F4 (0.40) planted decoy | G4 | EvidenceCritic-01 |
| 8 | Musicologist-03 · F4 (0.92) | LogicSolver-01 · A4 (0.40) planted decoy | F4 | EvidenceCritic-02 |
| 13 | TimelineAnalyst-02 · D4 (0.92) | TimelineAnalyst-01 · B4 (0.40) planted decoy | D4 | EvidenceCritic-03 |

**REPLAY** — "C major · 108 bpm · confidence 0.92 ... Reconstructed by the Conductor from
15 independently-resolved beats — 'Twinkle, Twinkle, Little Star', verified against the
original melody on all 15 notes": `C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4 C4`.

## Where the implementation deliberately differs

Two, both driven by measured failures rather than preference. They are deviations from
the artifact's text and are called out here so nobody has to discover them by diffing.

**Agents do not write to shared evidence.** The artifact gives every agent "read + write"
on the shared database. Here an agent may only *read* it; the write is the `answers` lane
wired into the shared `db_hotdata` node. When publishing was an instruction, roughly one
agent in four silently skipped it across two model families — see `RESULTS.md`. Anything
that must happen is an edge in the graph, not a line in a prompt.

**Discovery rows carry no model-written timestamp.** The artifact wants `agent_id,
confidence, timestamp` per discovery. The first two are on the row. The timestamp is
measured by the driver and lands in `room_registry`, joined to `discoveries` on `agent` —
because asking a model to read a clock is the same mistake as asking it to transcribe a
binary artifact, which cost 265 seconds and two corrupt MIDI files before it was removed.

## Where the numbers differ, and why

**35 discoveries.** The artifact reports 35; this design publishes 18 discovery rows
(15 beats + 3 planted decoys). The artifact does not give the derivation, and 35 is not
reachable from 15 beats, 20 agents and 3 decoys by any arithmetic worth guessing at, so
the conformance test asserts the shape of every discovery row and reports the count
rather than asserting a number it cannot derive.

**~3.4m / ~205s / ~400s.** Runtime on RocketRide is ~92s for the same 20 agents. Not
asserted here; `test_symphony_escape.py` already checks the run against a 400s budget.
