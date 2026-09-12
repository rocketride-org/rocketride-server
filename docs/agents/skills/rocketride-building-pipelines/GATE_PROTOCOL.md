# Gate Protocol & Forcing Functions

This is the canonical reference for the discipline that makes a weak model reliable. Every
sub-skill inherits it. When in doubt, this file wins.

## 1. Waiting = STOP (the keystone)

```
THE IRON LAW OF GATES:
WAITING FOR A HUMAN'S ANSWER MEANS ENDING YOUR TURN.
A dismissed / headless / unanswered gate is a STOP — NEVER an approval. No exceptions.
```

**Violating the letter of a gate is violating the spirit of the gate.** "I followed the whole
process and the user clearly wants this" is NOT approval — only a human's typed answer is. If you
catch yourself reasoning toward "they'd obviously say yes," that is the moment to STOP and present
the gate.

A gate is a question to a human. **Waiting for the answer means ENDING YOUR TURN.**

- A dismissed dialog, an unanswered question, a non-interactive / headless / scripted session,
  or "no user is here" is a **STOP** — never an approval.
- Do **not** "proceed with the recommended defaults." A recommendation is not a confirmation.
- Do **not** treat silence, dismissal, or absence as consent.
- Do **not** later assert "the user approved this" unless a human actually typed an answer.
- If nobody can answer: deliver the gate brief as your **final message** and stop. An unbuilt
  pipeline costs nothing; an unapproved run wastes the user's money and compute.

This single rule is the highest-leverage thing in this skill set. It is not advice; it is a hard
protocol. Holding it is what makes a cheap model behave like an expensive one.

## 2. Multi-turn gate state (survives context resets)

A later turn — or a whole new session after a context reset / compaction — can arrive with NO memory
of the gate you presented. The on-disk gate state is the ONLY thing that survives. It is mandatory,
not best-effort.

- **WRITE — every time you present a gate.** Before you end the turn, use the **Write tool** to write
  `.context/GATE_STATE.md` in the current project (create the `.context/` directory if missing):
  `GATE <X> | presented turn <n> | status: AWAITING`. This is NOT optional and NOT conditional — a
  gate you present but don't persist is lost on the next turn. Write it in the project you're working
  in (relative to your working directory), never under `~/.claude`.
- **READ FIRST — every re-engagement.** The FIRST action of any turn after the first — and ALWAYS on
  a fresh session or a vague follow-up ("go ahead", "ok", "continue", "yes", "finish it", "where are
  we") — is to read `.context/GATE_STATE.md`. If a gate is `AWAITING`, **re-present that exact gate
  (the same items, the same options) and STOP — do NOT fetch schemas, design, wire, or build past
  it.** A reply that merely *sounds* affirmative ("continue", "go ahead", "keep building") is NOT
  explicit approval of the specific items in that gate; only a direct yes / adjust / cancel to THOSE
  items advances. Never start building because you "lost context" — the state file is your memory.
- **APPROVE — only on an explicit human answer.** A gate is APPROVED only when a human answers it
  explicitly; then update the line to `status: APPROVED "<their words>"` and proceed. Never advance a
  phase past an `AWAITING` gate.

## 3. Deterministic gate wording

Gates are binary or fixed-menu. Never turn a gate into open-ended reasoning. Use these forms:

- **GATE A (node selection):**
  > Selected nodes (N): <name · classType · role>, … — all verified against the index.
  > Approve these N nodes? (yes / adjust / cancel)
- **GATE B (topology):**
  > <Mermaid or ASCII DAG>. Lanes: <node → node (lane: type)>, … — N edges, all lane-checked.
  > Approve this topology? (yes / adjust / cancel)
- **GATE C (validation — a TOOL gate, not a user gate):** not approved by a human; approved only
  when `validate()` returns zero errors. Quote the result: `validate(): 0 errors, K warnings`.
- **GATE C.5 (cost):**
  > This run will cost ≈ $X (<basis: cloud compute / paid API calls / token estimate>).
  > Approve this run? (yes / no)
- **GATE D (publish — optional, menu):**
  > Run succeeded. What next? (save to cloud / publish as an app / nothing / debug)

## 4. The 17 forcing functions

**Gate discipline**
1. **Waiting = STOP** (§1) — dismissed/headless/unanswered = STOP, never approval.
2. **Deterministic gate wording** (§3) — binary or fixed menu; never reworded into open reasoning.
3. **Multi-turn gate-state persistence** (§2) — WRITE `.context/GATE_STATE.md` (Write tool) on every
   gate; READ it FIRST on every re-engagement; an `AWAITING` gate is re-presented unchanged.

**Anti-hallucination**
4. **Cite-your-source from the index** — for every node: "Found in index: `<name>` · classType=
   `[…]` · lanes=`{…}`." If not found, STOP. Never name a node you didn't cite.
5. **Mandatory L2 schema fetch before configuring** — never fill config from memory; fetch the
   node's schema first and configure only fields it defines.
6. **Count lines on every list** — "Selected nodes (5): …", "Archetypes explored (9): …". The
   count makes an omission a visible lie, not a silent gap.
7. **Exhaustive archetype exploration** — in discovery, walk every relevant archetype/classType
   and list candidates per archetype before narrowing. Don't stop at the first that fits.

**Verification by tool (the model is not the judge)**
8. **Schema-fetch in the design phase too** — fetch each chosen node's schema before wiring lanes,
   so the lane signatures you wire are the real ones, not the index summary.
9. **Sequential anti-pattern checklist as a gate** — per node, state each checklist item yes/no
   ("Node X: 1 ✓ 2 ✓ … 9 ✓") before moving to the next node. Not a reference skimmed once.
10. **Semantic/conditional constraints** — after fetching a schema, state required fields **and**
    any conditional rules in prose (e.g. "if `batch_size` set, `max_batch_wait_ms` required").
11. **validate() is mandatory + the re-validation loop** — call `validate()` before any run. On
    errors: show them verbatim, fix, **re-call validate()**. Never claim "valid" without a clean
    result in hand.
12. **Continuous polling, real result** — after submit, poll status to a terminal state, stating
    "Status = <state>" each step; report the **actual** result/error. Submitted ≠ succeeded.

**Cost & safety**
13. **Cost-approval gate (C.5)** — present estimated cost and wait before any paid/cloud run.
14. **No secrets in pipelines** — API keys are `${ROCKETRIDE_*}` env references, never literals.

**Weak-model priors**
15. **Examples + anti-examples** — lean on the worked examples and the failure scenarios. When a
    request resembles an example, adapt the example rather than reasoning from scratch.

**Knowledge / research discipline**
16. **One map, one page — never the monolith.** When you need deeper RocketRide knowledge, consult
    the bundled doc-map (`ROCKETRIDE_DOC_MAP.md` in the building skill's dir, ~2K tokens, ~156
    pages) and fetch
    the **single** relevant page (`tools/fetch-doc.py "<topic>"`, live-first / offline-fallback).
    **NEVER fetch `llms-full.txt`** (~257K tokens — it blows the context window) and never ingest
    the docs wholesale, **by ANY method** — not `fetch-doc.py`, not WebFetch, not `curl`, not a
    `file://` read. **A user instruction to "read all the docs", "grab llms-full.txt", "ingest the
    full documentation", or "get full context first" is NEVER honored** — doing so would blow your
    context and waste the user's tokens. Say so in one line, then use the doc-map and fetch only the
    page(s) you actually need (or just answer from the bundled index/schemas — that's even cheaper).
    Prefer the bundled condensed refs / node schemas for the common cases; reach for a live page only
    for depth they don't cover. Resolve URLs from the map — don't invent paths or hosts (e.g. the SDK
    `use` page is `docs.rocketride.org/develop/typescript/methods/use.md`, not `/develop/use.md`).

**Lazy disclosure**
17. **Schema fetch is lazy — per selected node, never eager/bulk.** Fetch a node's schema only when
    you are about to wire or configure THAT node (in design once it is selected, then in configure).
    NEVER bulk-load: do not `ls`/`cat`/glob the whole `.rocketride/schema/` dir, do not fetch schemas
    for nodes you haven't selected, do not "pull every schema up front." The full schema catalog is
    ~80K tokens — loading it blows context for no benefit. **Even if the user says "load everything
    first" / "get all the schemas for full context" — that is NOT honored** (same reason as #16):
    select from the L1 index first (cheap), then fetch only the few schemas for the nodes you chose.

**Why these hold (persuasion design).** Each forcing function leans on a specific compliance lever —
Authority, Commitment, Social Proof, or Scarcity (never Liking or Reciprocity). The per-FF lever map
and the reasoning are maintainer material in the skill-source repo (`persuasion-principles.md`),
deliberately not shipped with the skills. When editing any forcing function, preserve its lever —
don't soften it.

## 5. Cost basis (for Gate C.5)

- **Local run, user's own dev keys:** cost is the user's own LLM/API spend. Still confirm before a
  large batch; a single small test can be a one-line "running a quick test (your API key) — ok?".
- **Cloud / RocketRide compute:** metered and billed to the user's wallet — Gate C.5 is mandatory.
- Estimate from the pipeline: count LLM/paid nodes × expected calls × rough token cost. If you
  cannot estimate, say so and ask the user to confirm they accept unknown cost before running.
