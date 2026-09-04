# Symphony Escape on RocketRide: feasibility results

> **Her full design now runs: `test_symphony_escape.py`, 8/8 checks, 92 seconds.**
> 20 agents in four roles, 22 databases, 5 waves, 49 clues, and the three planted
> contradictions found and resolved by the critic wave — beats 3, 8 and 13, exactly the
> table in her debrief. Her live-agent run was ~400s and ~877k tokens, and did not run on
> RocketRide. See [The full design](#the-full-design-symphony-escape) below.
> `test_symphony_waves.py` remains the simplified substrate harness.

Divya's "AI Symphony Escape" simulation (20 agents, 22 Hotdata databases, dependency-
ordered waves, coordination through a shared evidence database) was tested against a
**live RocketRide engine and her live Hotdata workspace**, not reviewed on paper.

**Verdict: the design runs end to end, 7/7 checks, at her full scale of 20 agents and 22
databases, including the persistent telemetry store the hackathon brief requires.** It
took two changes to the node and two to the demo design, all of them driven by failures
this test exposed rather than anticipated.

Reproduce: `python3 examples/symphony-test/test_symphony_waves.py --rooms 20`

## The run

```
session 20260903T010808: 20 rooms in 5 dependency-ordered waves
                         [[1,3,5,8,10,12], [2,4,6,7], [9,11,13,14], [15,16,17,18], [19,20]]

  wave 1: beats [1,3,5,8,10,12]  (dependent none)          (21s, shared rows now 6)
  wave 2: beats [2,4,6,7]        (dependent all)           (11s, shared rows now 10)
  wave 3: beats [9,11,13,14]     (dependent all)           (16s, shared rows now 14)
  wave 4: beats [15,16,17,18]    (dependent all)           (14s, shared rows now 18)
  wave 5: beats [19,20]          (dependent all)           ( 9s, shared rows now 20)

  [PASS] PUBLISH      all 20 rooms landed a verdict in the shared database
  [PASS] CORRECT      every published verdict matches the score
  [PASS] SHARE        14/14 dependent rooms resolved their beat from another room's row
  [PASS] ISOLATE      no room published a decoy or another room's raw clues
  [PASS] SURVIVES     shared evidence intact after every room was destroyed
  [PASS] CONSOLIDATE  the Composer reconstructed the melody from shared evidence
  [PASS] TELEMETRY    the store spans more than one session (4 accumulated)

  >>> C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4 G4 G4 F4 F4 E4 E4

  20 rooms, 20 private ephemeral databases + 1 shared + 1 telemetry = 22 databases,
  5 waves, 196s
```

## What each part of her design maps to

| Symphony Escape                  | RocketRide                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| 20 agents, one private room each | 20 independent pipeline runs; `db_hotdata` provisions and destroys one database each    |
| Shared evidence database         | a 21st database, created by the driver, that every room attaches to via `database_id`   |
| Telemetry database               | a 22nd database, id persisted to disk, attached by every room and written by the driver |
| 5 dependency-ordered waves       | driver-level wave sequencing; later rooms cannot answer without reading shared evidence |
| Append-only, verdicts not clues  | raw clues and decoys stay in the private database; only the verdict is published        |
| Room registry                    | a table in the shared database                                                          |
| Conductor / Composer             | a final run attached to shared evidence only, after every room is gone                  |

Three `db_hotdata` nodes in one room graph, three different lifecycles: `db_private_1`
creates and destroys its own database, `db_shared_1` attaches to evidence for this run,
`db_telemetry_1` attaches to the database that outlives every run. Private and evidence
are tools the agent can query. Telemetry is not a tool at all — nothing the agent does
can touch it.

The dependency is real, not decorative. Wave 1 holds the beats where a note is heard for
the first time. Every later room is handed **only a decoy** plus a pointer to a beat an
earlier wave published — it has to query the shared database to answer at all. All 14
such rooms answered correctly.

## The two node changes this test forced

**1. Publishing must be structural, not an agent's decision.** Previously the room agent
was instructed to call `load_data` on the shared database as step 3. Across two model
families, roughly one room in four actually did it — agents reasoned correctly, reported
the right answer, and dropped the write. The fix is to wire the agent's `answers` lane
into the shared `db_hotdata` node, so the pipeline loads the row because the graph says
so. That needed `writeAnswers` to tolerate what agents actually emit: `Answer.getJson()`
is a bare `json.loads` that raises, and models fence their JSON and prefix it with prose.
It now unwraps fences, finds the first balanced object, expands a `{"rows": [...]}`
wrapper into N rows, and raises with the text quoted when there is genuinely no JSON.

**2. Concurrent publishers into one table were losing rows.** With the first fix in, 5 of
6 rooms published; one failed on the load endpoint. Isolated with
`probe_concurrent_loads.py`, which drives the same three REST calls the node makes from N
threads:

```
8 concurrent appends to one table, no retry:   1 landed, 7 rejected
    409 {"code": "RESOURCE_LOCKED",
         "message": "another operation is already running for conn:...:main:discoveries; retry shortly"}
12 concurrent appends to one table, with retry: 12 landed, 0 rejected (slowest: 6 attempts, 12s)
```

Hotdata serializes writes per table. The client retried 429 and idempotent methods only,
so every concurrent publisher but one lost. It now replays a 409 whose body code is
`RESOURCE_LOCKED` on any method — the request is refused before doing any work, so a
replay cannot double-load — while a plain `CONFLICT` 409 (table exists, upload already
consumed) still propagates untouched.

## The telemetry database

The hackathon brief asks for something the original design did not have: a dedicated
Hotdata database scoped to the whole event rather than a run, written by every agent and
by the pipeline, with the telemetry view built from live queries against it. That is the
22nd database, and it is why the id is persisted to `.telemetry-db.json` — a second run
adds to the first run's data instead of starting over.

Two writers, deliberately kept in separate tables:

- **`agent_runs`, `waves`, `sessions`** — the driver, over REST. Measurements: per-room
  wall clock, wave boundaries, whether the room published, whether it was right, which
  attempt it was. Nothing self-reported.
- **`agent_answers`** — every room agent, structurally, through its answers lane into an
  attached `db_hotdata` node. The same verdict row that goes to shared evidence also
  lands here, tagged with the session. Self-reports, kept separate from measurements so
  the distinction stays visible.

The database must be created by the driver, not by a pipeline: anything a `db_hotdata`
node creates, it deletes at teardown, so a store that outlives runs has to be owned by
whoever owns the demo.

Live output after four sessions, which is what the demo shows:

```
CROSS-SESSION: has the room model changed anything?
  room_model     sessions  avg_elapsed_s  rows_published  failures
  openai         3         208.3          32              3
  openai-strong  1         195.8          20              0

CROSS-AGENT: do rooms that must read shared evidence cost more?
  dependent  runs  avg_s
  False      20    23.3
  True       36    17.0

CONCURRENCY: where the pipeline fans out, and what each wave costs
  wave  observations  rooms  avg_s  worst_s
  1     4             5.0    31.4   36.7
  2     4             2.5    18.5   26.7
  ...
```

Three of those are worth saying out loud:

- **Dependent rooms are faster, not slower.** Reading one row out of shared evidence
  (17.0s) beats loading three clues into a private database and aggregating them (23.3s).
  The shared read is cheaper than the private write, which is the opposite of the
  intuition that shared state is the expensive part.
- **Wave 1 is the critical path** — widest fan-out and slowest, every session.
- **The model comparison is what changed the build.** See below.

**Adding a column mid-event works.** The `attempt` column was added to `agent_runs`
after two sessions had already been written. The load was accepted and the older rows
read back as `None`. Worth knowing, because every team will evolve its telemetry schema
during the day.

## What the telemetry showed, and what changed because of it

This is the part the prize actually asks for, and it happened for real rather than being
staged. The first 20-room run scored 1/7. The store said why:

```
FAILURES: which rooms needed a retry, and did the model matter?
  model          attempts  retries  errors
  openai         36        0        3
  openai-strong  20        0        0
```

Two rooms in wave 1 died inside the agent's own planner — "Failed to get valid JSON
response after 4 attempts" — and in a dependency-ordered design that does not stay local:
the next wave's rooms queried shared evidence for a beat that was never published, found
nothing, and guessed. Three planner failures cost five wrong verdicts.

Two changes followed:

1. **The rooms run on GPT-4.1, not gpt-4o-mini** — it is the default now, on this
   evidence. Wall clock is not the reason: one GPT-4.1 session ran 21/11/16/14/9s per
   wave and the next ran 36/26/26/23/20s, which is run-to-run variance against the API,
   and the session averages (195.8s against 208.3s) are too close to call. The reason is
   that three of 56 gpt-4o-mini room runs died in the planner and none of 40 GPT-4.1 runs
   did.
2. **One retry per room**, recorded as `attempt` in telemetry rather than hidden, so a
   transient planner failure cannot poison every room downstream of it.

## Things that are the model, not the platform

- **The Composer must be anchored, and it must be a strong model.** Asked for a bare list
  of notes, gpt-4o-mini emitted an invented descending scale — and it demonstrably had
  all 20 rows, because asked to report what the tool returned it listed every beat 1..20
  correctly. GPT-4.1 asked for a bare list still corrupted the tail on one run in two.
  Asked for `{beat, note}` pairs it is right every time: a note that has to carry its
  beat cannot drift into completing the tune from memory. Generalise: for any agent whose
  output is parsed, anchor each value to its key and use a model that can be trusted to
  transcribe.
- **Models return pairs as objects or as two-element arrays, unpredictably**, and
  sometimes wrap the whole list in another list. The driver accepts all three shapes; a
  format quibble should not be reported as a wrong answer.
- **Do not run the final agent alongside the fan-out.** The Composer returned an empty
  reply while 20 room pipelines were still open, and passed 3/3 against the same database
  once they were terminated. Tear the rooms down first — which is also the better story,
  since it proves the shared evidence outlives every room that produced it.

## Known limits still in force

- **A failed room poisons its dependents.** That is the design working as specified, not a
  defect: dependency-ordered waves mean an upstream gap is an unanswerable question
  downstream. The retry is the mitigation; a demo at larger scale should also consider
  re-running a wave whose publish count is short.
- **The retry can duplicate a row** if an attempt publishes and then fails afterwards, since
  each attempt is a separate pipeline run and the load-dedup cache is per run. Not observed
  — the failures seen all happened before publication — and the checks read one row per
  beat, but it is a real edge.

- **A `chat` source returns the agent's answer; a `webhook` source does not.** `send()` on
  a webhook pipeline returns object metadata only. Investigator pipelines use `chat`.
- **The Database API Token cannot delete or read databases by id** (403 on both), so the
  shared database falls back to its TTL and an attached run cannot fetch
  `default_connection_id`. Schema introspection works anyway via `information_schema` over
  SQL; `build_index` does not, and must be done by the run that created the database.
- **`client.terminate(token)` is required**, not `disconnect()`, or pipelines keep running
  and databases survive to their TTL.
- Private-database deletion at teardown is the node's `endGlobal` behaviour and is unit
  tested, but is not independently verified in this run — the API token cannot list
  databases.

## Reproducing

```bash
# engine (a worktree at the release tag, with the node rsynced in - see the memory note)
rsync -a nodes/src/nodes/db_hotdata/ /tmp/rr-v330/nodes/src/nodes/db_hotdata/
cd /tmp/rr-v330 && ./builder server:run

# the full design, 20 agents, 22 databases
python3 examples/symphony-test/test_symphony_waves.py --rooms 20

# cheaper, same shape
python3 examples/symphony-test/test_symphony_waves.py --rooms 8

# the model comparison the telemetry reports on
python3 examples/symphony-test/test_symphony_waves.py --rooms 20 --model openai

# skip the persistent store (the TELEMETRY check needs two runs to pass)
python3 examples/symphony-test/test_symphony_waves.py --rooms 20 --no-telemetry

# no keys, no network: just proves the engine accepts the graph
python3 examples/symphony-test/test_symphony_waves.py --wiring-only

# iterate on the final act alone against evidence that already exists
python3 examples/symphony-test/test_symphony_waves.py --composer-only <database_id> --rooms 20

# the concurrency finding, in isolation
python3 examples/symphony-test/probe_concurrent_loads.py --writers 8
python3 examples/symphony-test/probe_concurrent_loads.py --writers 12 --retry
```

Credentials are read from `.context/hotdata-test/.env`, then the repo-root `.env`.

## Checking the artifact's claims, not just the outcome

`test_symphony_escape.py` checks what the run produces. `test_symphony_artifact.py`
checks the claims Divya's published debrief makes about _how_ it produces it — the
things a passing outcome cannot vouch for, since a run can return the right melody
while every one of them is false. The claims are transcribed in `ARTIFACT.md`, along
with the two places this implementation deliberately differs from her text.

```bash
python3 examples/symphony-test/test_symphony_artifact.py
python3 examples/symphony-test/test_symphony_artifact.py --wiring-only
```

Eight claims: DATABASES, ISOLATION, REGISTRY, ATTRIBUTION, BLOCKED, APPEND_ONLY,
CONTRADICTIONS, REPLAY.

The one worth calling out is ISOLATION, because nothing here had verified it. The
private rooms were taken on trust — a Database API Token cannot list databases, so
"each agent has its own" rested on the node's behaviour plus the agents' self-report.
It does not have to: an agent can report the id of the database its own `db_private_1`
node provisioned, and the driver can then query _that database directly_, while the run
is still alive, and read what is in it. The self-report shrinks to one opaque id the
agent has no way to fake usefully. The check reads each room's `clues` table and fails
if it holds any beat but its own and the one it was handed a decoy about.

Two claims are expected to be interesting rather than green:

- **DATABASES** asks each agent for five `load_data` calls into its own database
  (`clues`, `observations`, `hypotheses`, `evidence`, `discoveries`) rather than the one
  `workings` table the escape test uses. That is five chances to do what agents were
  already measured doing one time in four — deciding not to write. If it comes back
  short, that is the finding, and it is the same finding as "publishing must be wiring".
- **CONTRADICTIONS** passes on three or more, not exactly three. Her live-agent run
  found 4 — the three planted decoys plus one from a genuine race — so a fourth is the
  append-only model working, and the check reports extras rather than failing them.

**Status: written and statically verified, not yet run live.** Graph construction, lint
and the pure check logic are exercised; the eight claims need an engine. The local
prebuilt (`server-v3.3.1`) predates `db_hotdata`, and the worktree that ran the earlier
results was in `/tmp` and has been cleaned.

## Earlier results, still valid

The first round of testing (`test_option1.py`, `test_attach.py`) established the pieces
this run builds on: two agent nodes can share one `db_hotdata` node inside a pipeline and
address the same database; each agent's own node is a separate database, proven with data
rather than the agents' self-report; a separate pipeline run gets its own isolated
database; and an attached database survives its participants' runs terminating.

## The full design (Symphony Escape)

Her run debrief, implemented and run against a live engine: `test_symphony_escape.py`.
The puzzle itself is data in `escape_design.py`.

```
session 20260903T022419: 20 agents, 49 clues, 15 beats, 3 planted contradictions

  wave 1A: 9 investigators (cipher/scale/logic)  23s, 11 claims in shared evidence
  wave 1B: 6 investigators (mirror, read shared) 20s, 18 claims in shared evidence
  wave 2:  3 critics                            22s,  3 contradictions logged
  wave 3:  1 conductor                          13s
  wave 4:  1 composer                           13s

  [PASS] ROOMS       all 15 beats have a claim in shared evidence
  [PASS] DECOYS      all 3 planted claims reached shared evidence and contest a beat
  [PASS] CRITICS     exactly the 3 contradictions were found, at beats 3, 8 and 13
  [PASS] RESOLUTION  every contradiction resolved to the high-confidence claim
  [PASS] EVIDENCE    highest-confidence note per beat reconstructs the melody
  [PASS] CONDUCTOR   reconstructed the melody from resolved evidence
  [PASS] COMPOSER    rendered a real MIDI file (168 bytes, 15 notes, sha256 matches)
  [PASS] TIME        92s against ~400s for her 20 live agents

  >>> ESCAPED — C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4 C4   C major · 108 bpm

  beat  3 -> G4  resolved by EvidenceCritic-01
  beat  8 -> F4  resolved by EvidenceCritic-02
  beat 13 -> D4  resolved by EvidenceCritic-03
```

Shared evidence reproduces her contradiction table agent for agent, and nothing about
the resolution is hard-coded — a critic asks the database which beats carry more than one
distinct note, then keeps the higher-confidence row:

```
beat 3   Cryptographer-03   G4 0.95   vs  Musicologist-01     F4 0.40
beat 8   Musicologist-03    F4 0.92   vs  LogicSolver-01      A4 0.40
beat 13  TimelineAnalyst-02 D4 0.93   vs  TimelineAnalyst-01  B4 0.40
```

### The node change this forced

**An append must carry every column the table already has.** Hotdata rejects a write that
omits one, because a column left out would be dropped from the table:

```
400 BAD_REQUEST  upload is missing column 'room'; an append must carry every column the
                 table has ... Project each row onto the full table schema — writing NULL
                 where a row has no value — before uploading.
```

That is exactly what a shared-evidence or telemetry table hits: the second producer writes
a different shape and fails. `load_data` now catches that 400, reads the table's live
columns over SQL (so it works on an attached database with no connection id), projects
each row onto the full schema and loads again. The projection runs only after a failure,
so a well-shaped load pays nothing for it.

There is a limit underneath it, found the same way: **null-filling only works for text
columns.** A numeric column that is null in every row of a batch is inferred as text, and
the server refuses to re-type it:

```
409 CONFLICT  column 'confidence' can't change type from float64 to varchar automatically
```

No payload satisfies both rules, so the node now raises with the actual fix named — one
table, one row shape; give each kind of record its own table — instead of passing a bare
CONFLICT up. The demo follows its own advice: telemetry is written to `answers_investigator`,
`answers_critic`, `answers_conductor` and `answers_composer` rather than one table.

### Two things that were the demo's fault, not the platform's

- **The critic wave needs the database to do the set logic.** Asked to read the claims and
  spot contradictions itself, one critic in three was right — one missed a real one, another
  invented a beat. Given `GROUP BY beat HAVING COUNT(DISTINCT note) > 1` to run, and told
  that any beat it does not return is not a contradiction, all three were right. Same lesson
  as the Composer in the simplified harness: set logic belongs in SQL, orchestration belongs
  in the agent.
- **Never ask a model to transcribe a binary artifact.** The Composer originally returned the
  MIDI file as base64. It took 265 seconds — 80% of the whole run — and produced files 108
  bytes under and 8 bytes over their own declared track length, one of which passed an
  earlier, too-weak check that only looked at the magic bytes. The Composer now renders the
  file in its sandbox and reports the sha256; the driver rebuilds the same bytes and requires
  the digests to match. Same artifact, proven identical, and the wave dropped to 13 seconds.

---

## Twenty agent nodes in ONE pipeline: it works, and it is slower

The escape runs 20 agents as 20 independent pipeline runs. The obvious alternative is to
put all twenty on one canvas — which is what a hackathon team will try first, because it
is the version you can see. `make_swarm_pipe.py` generates it and `test_swarm_pipe.py`
runs it.

The graph: 64 nodes — 1 chat source, 20 `agent_rocketride`, 20 private `db_hotdata` (no
`database_id`, so each provisions its own), 20 `memory_internal`, 1 shared `db_hotdata`
fed by all twenty agents' `answers` lanes, 1 `response_answers`, 1 `llm_openai` carrying
41 control connections.

### What works

| Claim                                                                     | Result                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| The engine opens a 64-node graph with 20 agent nodes                      | PASS — 2.5s                                            |
| One `db_hotdata` node accepts the `answers` lane from 20 different agents | PASS — many-to-one on a lane, not previously exercised |
| All 20 agents produce a verdict through that one shared node              | PASS — 20/20                                           |
| Every verdict beats its decoy                                             | PASS — melody exact                                    |

Sharing needs no `database_id` here: inside one pipeline the node _is_ the shared thing.
Attach mode is for the case this shape cannot express — agents in **separate** runs.

### What does not: they run in series

| rooms      | 1   | 4   | 8   | 20   |
| ---------- | --- | --- | --- | ---- |
| wall clock | 7s  | 28s | 57s | 152s |

About 7.6 seconds per agent, near-perfectly linear. **Twenty agent nodes on one canvas is
not twenty parallel agents.** The same twenty agents as twenty separate pipeline runs
finish in ~83s, and that version also gets dependency-ordered waves, which this one
cannot express at all — one source emits once, so nothing can hold a later batch back.

Giving each agent its own LLM node rather than sharing one changes nothing (8 rooms: 55s
against 57s), so a contended LLM node is not the cause. The mechanism is not established
— only that it is not that.

### What to tell anyone building on this

Use the canvas fan-out when the graph is the message: it is far more legible, and for a
handful of agents the difference does not matter. Use separate pipeline runs when you
want the parallelism to be real. The two are not interchangeable, and the slow one is the
one that looks right.

Reproduce:

```bash
python3 examples/symphony-test/make_swarm_pipe.py            # writes swarm20.pipe
python3 examples/symphony-test/test_swarm_pipe.py --rooms 8  # 57s
python3 examples/symphony-test/test_swarm_pipe.py            # 20 agents, 152s
```
