# Discord Dashboard

The control surface for a Discord support bot whose backend is a RocketRide
pipeline built on the built-in [`discord`](../../nodes/src/nodes/discord/README.md)
source node. The bot answers questions in a support channel, escalates to a team
role when it cannot, and this app is where you start it, watch it, and see what
it said.

Private app: published to `@me` or `@team`, never `@public`.

|           |                                                      |
| --------- | ---------------------------------------------------- |
| App id    | `mithilesh_clock.discordDashboard`                   |
| Publisher | `rocketride`                                         |
| Screens   | Bot · Conversations · Quality · Knowledge · Settings |
| Backend   | one shared always-on task, not one per viewer        |

---

## Screens

**Bot** — the daily landing. Status header (who the bot is connected as, which
server and channels, since when, when the last message arrived), then the "Needs
you" list — escalated threads and unanswered questions from the last 24 hours —
and the Get-started checklist below it, until setup is complete. Start, Restart
and Stop live here; the disconnected state shows the node's own last line, one
Restart, and after a second failed recovery in a row the tail of the engine's
error and warning lines.

"Connected as" is the name the node logged in with, read out of its own ready
line (`Discord Bot ready - logged in as …`). Until that line arrives the header
shows the task's name, labelled "Task", rather than passing it off as the bot.

**Conversations** — every question the bot saw while this app was open, with the
outcome (answered, escalated, no reply, quiet, error) and any reactions. Filter by
outcome, channel and date; click a row for the full question, the attachment
list, the answer and the Discord link. Read-only.

**Quiet** is the bot deliberately staying out of it: a thread it had already
escalated (Pause After Escalation) or a message aimed at someone else (Ignore
Messages Aimed At Others). Quiet rows never reach "Needs you" — nobody has to do
anything about them — and the side panel gives the node's reason in words. A
reply that Reply Hygiene suppressed is **not** quiet: that is a question nobody
answered, so it stays a No reply and stays on the list.

**Quality** — three tabs over one question. **Scorecard**: the success rate over
the trailing window against its target, with the breakdowns behind it.
**Review**: one card per graded thread, where a person decides whether it was a
win or a miss and teaches Ralph the answer it should have given. **Test**: the
regression check — **Run test** asks the golden seeds of a private copy of the
pipeline the bot runs and judges the answers, behind a preflight that has to pass
first. It never posts in Discord and never pages Slack. The run shows passed,
failed, hard fails and regressions against the previous run, plus a per-seed table
with the previous grade beside the current one, and downloads as JSONL; **Run
first seed** asks one seed instead of ten when you only want to know whether the
copy answers at all. The same tab holds **Grade ungraded**, which grades
the captured conversations that have gone quiet. A regression puts a badge on the
Quality nav entry. See "Eval" below for all three.

**Knowledge** — Ralph's knowledge base as documents a person can read: the
docs pages, the answers taught on the Review tab, and documents added here. One
row per document (title, source, when and by whom, size; docs pages show their
route), newest first, with source chips and a title filter. **Search by meaning**
(or Enter in the search box) runs the same retrieval as `eval-retrieve.pipe` and
groups the passages by document, closest first, each marked _closer_ or _further_
against the eval rules' match distance (Settings › Eval). Click a document to read
its stored text; **Show chunks** lists the passages the vector store holds for it,
read through the `chroma` node's `get` tool. **Add document** (signed-in users)
pastes text with a title or uploads a `.md`, `.txt` or `.pdf`, sends it through
`eval-kb-writeback.pipe` exactly as Teach Ralph does (`upload-<slug>.<ext>`; the
same title again replaces it) and catalogues it. A PDF's text is not returned by
the writeback, so the catalog keeps its file name. There is no remove and no add
from URL. **What Ralph retrieved**, on a conversation and on a review card, opens
this screen's meaning search with that question.

The list is the app's own catalog, `dd_kb_documents`, because the store nodes
cannot list a collection. It holds each document's full text, so reading one does
not depend on the vector store. It was seeded once from the KB rebuild
(`.context/discord-app/kb/seed-catalog.sql`, idempotent); Teach Ralph adds a row
when an answer lands, and Add document when a document is sent.

**Settings** — five sub-pages: **Discord** (server, channels, team role, and the
NAMES of the secret variables), **Behavior** (reply mode, thread naming, typing,
ignore bots, and the five original-bot behaviors below), **Pipeline** (which
`.pipe` runs, the capture branch, restart behavior), **Advanced** (ingestion
limits, event emission, Sample data), **Eval** (who counts as the team, what is
test traffic, and the scoring tunables — see "Eval" below). One draft across all
of them, one Save, and the Save is confirmed by the DATABASE: each sub-page is
one row with a version, and a save that loses the race to another admin says
"Someone else changed these settings — reloaded the latest", loads theirs and
keeps your edits on screen. A save writes only the sub-pages you actually
edited — see "Two sessions at once". Saved settings apply on the next start, so a save offers a restart —
nothing restarts silently. Task tokens on the Pipeline page are shown shortened;
the full token can terminate the bot.

Every screen implements loading, empty, populated, error and a read-only
sample-data mode.

---

## Setup

### 1. Discord portal

Create the application and bot, then enable:

| Intent / permission                                | Needed for                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Message Content Intent**                         | reading question text at all                                                                                                                             |
| **Server Members Intent**                          | display names in Conversations, and clearing an escalation when a team member replies (Settings › Advanced › Include Member Metadata, **on by default**) |
| **Message Reactions**                              | the Reactions column (Settings › Advanced › Emit Reactions)                                                                                              |
| View Channels, Send Messages, Read Message History | answering in the channel                                                                                                                                 |
| Create Public Threads, Send Messages in Threads    | `replyMode: thread`, which is the app's default                                                                                                          |

### 2. Save the secrets as server variables

The app never holds a secret. It stores the **name** of a server variable; the
engine resolves the value at pipeline start (`resolve_pipeline_env`), so the
token never travels through the browser.

Save these on the server (the shell's variables overlay, or
`rocketride store` / the Environment surface):

| Variable                               | Used by                                     | What it is                                                                                                                   |
| -------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN` | all three pipes                             | The Discord bot token.                                                                                                       |
| `ROCKETRIDE_OPENAI_KEY`                | minimal and RAG pipes                       | The OpenAI key the answer model uses.                                                                                        |
| `ROCKETRIDE_GITHUB_TOKEN`              | RAG pipe only                               | Read-only GitHub token for the agent's tools.                                                                                |
| `ROCKETRIDE_QDRANT_HOST`               | eval-capture pipe only                      | Qdrant host for the capture store.                                                                                           |
| `ROCKETRIDE_SLACK_WEBHOOK_URL`         | Slack-paging pipe only                      | Slack incoming-webhook URL the agent pages on the first escalation in a thread. Point it at a TEST webhook while testing.    |
| `ROCKETRIDE_DISCORD_PG_PASSWORD`       | the dashboard database (`db_postgres` only) | Password for the Postgres everything is stored in — see [Database](#database). Not needed with `dbProvider: rocketride_sql`. |

A test needs no variable and no second bot of its own: it runs a private copy of
the pipeline the bot runs, so it needs exactly what that pipe already needs.

Only names beginning with `ROCKETRIDE_` are substituted — anything else is
rewritten to `<REDACTED>` by the exfiltration guard.

### 3. Point the app at those names

In the shell's app settings (Settings overlay, grouped under "Discord
Dashboard"):

| Setting                                         | Default                                | Required               |
| ----------------------------------------------- | -------------------------------------- | ---------------------- |
| `mithilesh_clock.discordDashboard.botToken`     | `ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN` | yes                    |
| `mithilesh_clock.discordDashboard.openaiKey`    | `ROCKETRIDE_OPENAI_KEY`                | yes                    |
| `mithilesh_clock.discordDashboard.githubToken`  | `ROCKETRIDE_GITHUB_TOKEN`              | RAG pipe only          |
| `mithilesh_clock.discordDashboard.qdrantHost`   | `ROCKETRIDE_QDRANT_HOST`               | capture pipe only      |
| `mithilesh_clock.discordDashboard.slackWebhook` | `ROCKETRIDE_SLACK_WEBHOOK_URL`         | Slack-paging pipe only |

All of them are `rocketride.envkey` fields: the widget offers the variable names
your account has, and the value stored is the name.

The five database settings are in the same group and are covered by
[Database](#database); their defaults point at the local container, so a
development machine needs nothing changed here.

The last three are optional because only one pipe each references them. The app
checks them the way it checks the ids: picking the RAG pipeline blocks Start
until `ROCKETRIDE_GITHUB_TOKEN` is saved, enabling the capture branch blocks it
until `ROCKETRIDE_QDRANT_HOST` is, and picking the Slack-paging pipe blocks it
until `ROCKETRIDE_SLACK_WEBHOOK_URL` is — rather than letting the start fail
server-side with nothing on screen to explain it. Settings › Discord lists the
names with whether the server holds them; when the variable list itself cannot be
read, it says so instead of reporting them as missing.

### 4. Fill in the ids and start

Settings › Discord: server id, support channel ids, the team role id for
escalations. Then Bot › Start. The Get-started checklist walks the same path and
ticks itself off as each step lands.

The app substitutes the id placeholders
(`${ROCKETRIDE_DISCORD_GUILD_ID}`, `..._SUPPORT_CHANNEL_ID`,
`..._MENTION_CHANNEL_ID`, `..._TEAM_ROLE_ID`) from Settings before starting, and
leaves the two secret placeholders alone for the server.

---

## Pipelines

Three `.pipe` files ship in `src/pipelines/`:

| File                        | What it is                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `discord-support-min.pipe`  | Discord → prompt → OpenAI → reply. The default. Fewest moving parts.                                        |
| `discord-ralph.pipe`        | Adds retrieval over the docs collection, the CrewAI agent and its tools.                                    |
| `discord-eval-capture.pipe` | Shadow capture branch. Posts nothing; records questions, reactions and no-reply outcomes for the eval loop. |

Settings › Pipeline picks which answer pipeline runs and whether the capture
branch runs alongside it. The bot always starts with `ttl: 0` (runs until
stopped) and `useExisting: true` — the app attaches to one shared task rather
than starting one per viewer, and resolves its token from the server by
`(projectId, source)` so a reload or a second viewer finds the same bot.

The capture branch is a second task with its own identity, and every lifecycle
verb reconciles it: Start brings it up when Settings › Pipeline asks for it,
Restart restarts it on the new configuration, turning it off terminates it, and
Stop stops both. The app never leaves a second Gateway session running with
nobody watching.

The eval loop's own pipes ship beside them — `eval-grader.pipe`,
`eval-retrieve.pipe`, `eval-judge.pipe` and `eval-kb-writeback.pipe` — and are
**not** the bot's. Each is request/response rather than always-on: it is started
with a short `ttl` when a batch or a run begins and terminated when it ends, so no
click leaves an engine task warm. Their identities live in one place
(`src/eval/pipes.ts`).

The test stage has no `.pipe` file of its own, and that is the point: it builds
one in memory from whatever the bot is running (`src/eval/replayCopy.ts`) so a
regression check always measures the pipe you deployed. See "Test" below.

---

## How the app sees what the bot does

The screens are fed by the node's own real-time events, not by pipeline traces.
Every object the `discord` node opens — messages, attachments, and the
`outbound`, `no_reply` and `reaction` events — is broadcast with `monitorSSE`
and arrives in the browser as the DAP event `apaevt_sse`:

```jsonc
{ "event": "apaevt_sse", "body": { "pipe_id": 1, "type": "discord", "data": { "schemaVersion": 1, "eventType": "outbound", "metadata": { "messageId": "…", "channelId": "…", "…": "…" }, "messageIds": ["…"], "destination": "thread", "text": "…" } } }
```

The app subscribes `['SSE', 'TASK']` on each running task (`addMonitor`) and
folds `message`, `outbound`, `no_reply` and `reaction` into the conversation
list; `TASK` is what lets the status header notice a task that died between
status polls. `pipelineTraceLevel` is `none`: traces carry neither tag-lane data
nor tag metadata at any level, so they could not deliver this even at `full`,
and asking for them would cost the engine a serialization per lane write for
nothing. The payload shapes are documented in the
[node README](../../nodes/src/nodes/discord/README.md) under "Attachments,
events, and backfill".

Two consequences worth knowing:

- A `reaction` names the message that was reacted **to**, which for feedback on
  an answer is one of the bot's own messages. Rows record the answer's message
  ids from the `outbound` event and match reactions through them, so the
  Reactions column only fills for questions this app saw answered.
- With the capture branch on, both tasks see the same Discord traffic and both
  emit an `outbound` event. The capture branch runs with `sendResponses: false`,
  so its answer is marked `destination: "suppressed"` and never overwrites the
  answer the bot actually posted.

---

## Settings › Behavior: the original bot's behaviors

The `discord` node ships the behaviors the original RocketRide support bot had as
opt-in parameters — its own defaults are off, so a node used for anything else
gets a plain question-in, answer-out source. This app is that bot's console, so
it turns them on and lets you turn them off:

| Setting                         | Writes                                       | App default                         | Node default | What it does                                                                                                                                                       |
| ------------------------------- | -------------------------------------------- | ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread History Limit            | `discord.threadHistoryLimit`                 | `50`                                | `0` (off)    | Prepends the last N messages of the thread as context on a follow-up.                                                                                              |
| Thread History Max Characters   | `discord.threadHistoryMaxChars`              | `6000`                              | `6000`       | Caps that transcript so a long thread cannot crowd out the question.                                                                                               |
| Pause After Escalation          | `discord.escalationPause`                    | on                                  | off          | After escalating in a thread the bot stays quiet there until it is @mentioned again.                                                                               |
| Escalation Markers              | `discord.escalationMarkers`                  | `Escalated to the RocketRide team.` | `[]`         | Reply text that counts as an escalation, one phrase per line. Every role mention the bot is allowed to make counts automatically.                                  |
| Ping The Team On Escalation     | the prompt + `discord.allowedMentionRoleIds` | off                                 | —            | See below.                                                                                                                                                         |
| Ignore Messages Aimed At Others | `discord.ignoreAimedAtOthers`                | on                                  | off          | A message that @mentions someone else, or replies to a message that is not the bot's, is not answered.                                                             |
| Acknowledgement Emoji           | `discord.ackEmoji`                           | `👀`                                | `''`         | The reaction added to such a message instead of an answer.                                                                                                         |
| Add Feedback Reactions          | `discord.feedbackReactions`                  | **off**                             | off          | Adds the feedback emoji to the last chunk of every answer. Left off: it asks every reader for a verdict, and reactions readers add unprompted are captured anyway. |
| Feedback Emojis                 | `discord.feedbackEmojis`                     | `✅`, `❌`                          | `✅`, `❌`   | The emoji it adds.                                                                                                                                                 |
| Sanitize Replies                | `discord.sanitizeReplies`                    | on                                  | off          | Strips the model's reasoning scaffolding, and posts nothing when what is left is not an answer (a `non_answer` No reply).                                          |

**Ping The Team On Escalation** is the one Behavior setting that is not a node
parameter. Off — the default — the shipped prompts end an escalating reply with
the plain line `Escalated to the RocketRide team.` and the node is allowed to
mention no role at all, so a test round escalates in words and notifies nobody.
On, `resolvePipeline` appends `<@&<team role id>>` to that one prompt line and
sets `discord.allowedMentionRoleIds` to the team role from Settings › Discord, so
the reply really pings. The `.pipe` files on disk are never rewritten — the
setting is the single place the switch lives. Both forms count as an escalation
on the screens.

Turn the ones you do not want off and save; they apply on the next start, like
every other setting. The two switches whose effect you will notice first are
Pause After Escalation (the bot goes silent in a thread it handed over) and
Ignore Messages Aimed At Others (it answers less, and reacts 👀 instead).

## Eval

Every captured row carries an **event log**: one entry per thing that happened
in its thread, which is what the eval loop reads. This is the same model the
original support bot kept in SQLite (`threads` + `events`), ported into the app
so the labels a screen shows and the labels the bot's own grader produced are
decided by the same code (`src/eval/rules.ts`, a verbatim port; the self-test in
`src/eval/rules.selftest.ts` is the reference's unit tests, and it is not wired
to anything yet).

**A row is a thread.** The node answers in a thread created from the question
message, and Discord gives that thread the question's own id — so a follow-up
question, a team reply, the bot's answer to the follow-up and every reaction
fold into the row the thread started from. Earlier versions gave a follow-up a
row of its own.

The log's entry types:

| Type                                                             | From                               | Means                                          |
| ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `question`                                                       | the opening `message`              | what was asked                                 |
| `user_message`                                                   | a later `message` in the thread    | the asker, or anyone else, said more           |
| `team_reply` / `team_mention`                                    | a later `message` by a team member | the team answered, or spoke to the bot         |
| `ralph_answer` / `escalation` / `manipulation_flag` / `dead_end` | `outbound`                         | what the bot's reply was, classified           |
| `no_reply`                                                       | `no_reply`                         | the bot posted nothing, with the node's reason |
| `reaction_add` / `reaction_remove`                               | `reaction`                         | a reader's verdict (✅ / ❌ are read as one)   |
| `slack_page`                                                     | the agent's tool-call broadcast    | the agent paged Slack while answering          |

Insertion is idempotent on (type, message id, actor, emoji), because both tasks
see the same traffic and the shell re-delivers on reconnect — and a duplicated
`team_reply` would change the label. Text on an entry is clipped to 4000
characters.

**Settings › Eval** holds what the labelling needs and the bot does not: the
team members who do not carry the escalation role, the bots whose questions are
test traffic (empty reuses Settings › Discord's Allowed Bot Ids), and the
scoring tunables — quiet hours (48), window (28 days), target (0.6), match
distance (0.8) and re-ask days (14), plus the testing switch **Grade Now Ignores
Quiet Hours**. They were the reference bot's `EVAL_*` environment variables.
None of them is a `discord.*` parameter, so none of them needs a restart.

### Grading

**Quality › Test › Grade ungraded** runs one batch of the eval loop's grader over the
captured rows (`src/eval/grader.ts`, a port of the reference bot's
`eval/grader.ts`). Up to 20 rows per click, newest first, and only rows that are
still `open` and have been quiet for **Quiet Hours** — turn on **Grade Now
Ignores Quiet Hours** in Settings › Eval to grade a thread the moment it is
captured, which is for testing and nothing else. The button is disabled in
sample-data mode, while disconnected, and when no row qualifies; the line beside
it says how long ago the last batch ran.

What one row costs, in order:

1. **Excluded rows cost nothing.** `decideOutcome` with no grader signals already
   knows whether the thread is out of the denominator — the opener is on the
   team, the opener is a test bot, or the bot flagged a manipulation attempt — so
   the row is saved `excluded` without an LLM call. This is the reference's own
   "cheap" pre-check.
2. **The grader LLM** (`eval-grader.pipe`) gets ONE JSON object: the question, the
   thread's transcript (each entry clipped to 1500 characters, roles `user` /
   `ralph` / `team` / `other`), the escalation text if there was one, and the
   clusters proposed so far. It answers with the cluster, the escalation
   category, what the team's reply was, whether the asker confirmed, an
   LLM-only root cause, a knowledge-base draft and a summary. The LLM supplies
   SIGNALS; it does not pick the label.
3. **The retrieval pipe** (`eval-retrieve.pipe`) is asked about the question, and
   — when a team member answered in the thread — about the team's answer text.
   That is the doc-gap analysis: no team answer near anything in the knowledge
   base is a `content_gap`, a team answer whose top chunk the question already
   retrieved is a `bad_answer`, and a team answer the question's retrieval did
   not surface is a `retrieval_miss`.
4. **The pure rules decide.** `decideOutcome` and `decideCause` in
   `src/eval/rules.ts` turn the signals and the retrieval numbers into the
   outcome and the cause, and the row is saved with `outcomeSource: 'auto'`.

The retrieval numbers are Chroma **distances**, so lower is closer: a real docs
question tops out around 0.78 and nonsense sits around 0.91. That is the one
place this port inverts the reference, which scored similarities — hence
`matchDistance` rather than `matchScore`, and `analyzeRetrievalDistance` beside
the untouched `analyzeRetrieval`. `grade.qTopScore` and `grade.aTopScore` on a
row are distances too.

A row whose grader output will not parse is **left open** and counted; the next
click tries it again. The batch ends with a toast — "Graded N, excluded M, K
failed to parse; causes: …" — and both eval tasks are terminated, so nothing is
left running between clicks. Every write is folded into the workspace by row id,
so a question arriving mid-batch does not lose the grade beside it.

What a row shows today: the events, the last reply's class, the retry count, the
exclusion reason and — once a batch has run — the eval outcome and cause, in the
Conversations side panel. The Review tab below is where a human decides them.

### Review

**Quality › Review** is what replaces the reference bot's `#ralph-eval` channel:
one card per graded thread, newest activity first, with the same four head states
the bot posted — excluded, a win, needs a verdict, or a miss with the reason
named. Filter chips narrow the queue (Needs verdict · Misses · Wins · Excluded ·
Reviewed); it opens on **Needs verdict + Misses**, and a thread you have already
decided is hidden until the Reviewed chip is on. A card carries the question with
a link to the real thread, the cluster, the q/a **distances**, the grader's
one-line reasoning, and — once somebody has reviewed it — one line saying who did
what.

Three rows of controls, in the reference's own order:

1. **The verdict.** Always agree/keep, flip, exclude. "Ralph resolved it" counts
   the thread as a success; "Ralph missed it" stores it as `rejected` and counts
   against the rate; "Not a real question" drops it out of the metric entirely.
   On a miss, "Yes, a miss" confirms the grader — which deliberately re-writes
   the same cause, because that is what puts the thread in the grader-agreement
   figure on the Scorecard.
2. **Teach Ralph the answer**, and a link that opens a prefilled GitHub issue.
   The app never files the issue itself.
3. **The reason** — the eleven causes in plain language. Changing it explains a
   miss without changing the verdict.

Every verdict stamps who reviewed it, when, and whether the label came from the
rules or from a person (`outcomeSource` / `causeSource`), which is what the
Scorecard's agreement figure reads. **Who** is the signed-in shell user; being
able to open the app is the whole permission model (the manifest is
`authenticated: true`), so there is no role check to fail. Every verdict also
appends an audit row to `dd_reviews`. Verdicts and reasons need the DATABASE
(they are shared decisions now, not one browser's); the knowledge-base write
needs the engine as well, which is why it is the one control with a disabled
reason of its own.

### Teach Ralph — the knowledge-base writeback

**Teach Ralph the answer** opens an inline editor: the question (prefilled from
the grader's draft, or the thread's own) and the answer Ralph should have given.
Both hold 4000 characters. The grader only drafts a pair when a TEAM member
supplied the answer, so the answer box is legitimately blank much of the time.

Approving does three things, and they are the only path into the bot's knowledge
base:

1. **The pair is approved on the row** — `qaApproved` with who and when, and
   `ingestedAt: null`. Teaching stamps the review fields but touches neither the
   outcome nor the cause: writing the answer the bot should have given says
   nothing about whether the miss was labelled right, and counting it as
   agreement would inflate the grader's score.
2. **A golden case is seeded** into `quality.golden` — the question, and whether
   a correct run should ANSWER it or ESCALATE it. A thread that failed on
   `policy_account` or `policy_other` needed a human, so its case expects an
   escalation and carries no golden answer. One case per thread; re-teaching
   replaces it. The test stage reads the set.
3. **The pair is written to the KB** (`eval-kb-writeback.pipe`): a markdown
   document whose H1 is the question and whose body is the answer, sent as
   `ralph-qa-<threadId>.md` into the same `ROCKETRIDE_DOCS` Chroma collection the
   bot retrieves from. The stable name means re-teaching a thread REPLACES its
   document rather than adding a second answer.

`ingestedAt` is set only when the document can actually be found: the task-status
poll never reports the store step, so the runner queries `eval-retrieve.pipe`
with the question up to ten times, two seconds apart, looking for a chunk whose
`metadata.objectId` is the one the send returned. Until then the card says
_adding it to Ralph's KB…_; afterwards _in Ralph's KB._ A pair that never shows
up keeps `ingestedAt: null`, the card says _not marked as reaching the KB_ and
offers **Retry the KB write** — which is strictly better than a card claiming the
bot learned something it did not. Runs are serialised, and one run settles every
approved pair that is still pending, not only the one just taught. The same stamp
catalogues the answer on the Knowledge screen (`dd_kb_documents`, source taught,
added by the approver), in one transaction.

### Scorecard

**Quality › Scorecard** is the reference's weekly summary embed, computed from the
rows the app holds rather than posted anywhere: the success rate over the
trailing window against the target, the 95% Wilson interval, the pending count,
the outcome histogram, failures by cause (doc gaps marked), the policy floor (the
share of misses no bot could have won), the top five clusters with each one's
failure share, and the grader-agreement figure. **Pending is in neither half of
the fraction** — a thread the bot answered and nobody confirmed is not a win and
not a miss, it is a thread nobody has looked at, so the denominator is
confirmed + misses and the pending count is shown beside the rate as the size of
the queue it is waiting on. Reviewed rows count as graded rows: the first review
click moves a row out of `graded`, and a population that dropped those would
score only the threads nobody checked.

Nothing here is scheduled. The reference posted this every Monday at 09:00; the
tab is computed on every render instead.

### Test

**Quality › Test › Run test** asks the one question grading cannot: _did a
change to the bot break an answer that used to work._ It asks each golden seed of a
**private copy of the pipeline the bot runs**, reads the answer off the result,
judges it, and diffs the run against the previous one. The logic is
`src/eval/replay.ts` (a port of the reference's `eval/replay.ts`), the copy is
`src/eval/replayCopy.ts`, and the seeds are `src/eval/golden.ts`.

**A test never posts in Discord and never pages Slack.** That is not a promise
about how the code is written; it is a property of the document that gets started.
`buildReplayCopy` takes the pipeline the Bot screen would start — Settings and all
— and does four things to it:

| Transform                                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `discord` source becomes a **webhook** source (`replay_webhook`), and every `input`/`control` edge and the top-level `source` field is repointed at it | The webhook source emits `tags, text, json, audio, video, image, questions`, a superset of the discord source's lanes, so every existing edge stays valid — and `client.send(token, question, …, 'text/plain')` lands on the `text` lane, which is the same lane the node writes a new question to (`pipe.writeText(message.content)`). The agent sees exactly the shape a real asker produces |
| Every `tool_slack` component is removed (and `tool_discord`, defensively), with every edge that fed from one                                               | The two tools that can speak to the outside world on their own. `tool_github` ×3 (read-only) and the GET-only `tool_http_request` stay, because the answer they help produce is the answer under test                                                                                                                                                                                          |
| The agent's **`SLACK PAGING` instruction is dropped** and the `[calls tool_slack…]` stage direction is cut out of its examples                             | Deleting the component is not enough: an agent still told to call a tool that is not there spends a turn failing. The example's REPLY text is kept, because that is what teaches the escalation wording the scoring reads                                                                                                                                                                      |
| `project_id` becomes a constant nothing else uses                                                                                                          | `(project_id, source)` **is** the task identity, so a copy that kept the live id would restart — or attach to — the bot it was copied from                                                                                                                                                                                                                                                     |

Then `assertReplayCopyIsolated` re-reads the finished document and **aborts the run**
unless all four hold: no `discord` / `tool_discord` / `tool_slack` component, a
project id that is not any pipe the app ships, no string anywhere mentioning
`tool_slack` or `SLACK PAGING`, and a source that really is a webhook. This is the
reference's own `assertIsolated`, widened. `src/eval/replayCopy.selftest.ts` checks
the whole transform against the real `discord-ralph-slack.pipe` — including that
every edge still points at a component that exists — and, like
`rules.selftest.ts`, is wired to nothing.

**Nothing sanitizes the copy's answers, so the app does.** The scratchpad
sanitizer lives in the `discord` node, and the copy has no node. So each raw answer
goes through `sanitizeShownReply`, a port of the node's own `sanitize_reply`
(`nodes/src/nodes/discord/text_utils.py`), whenever Settings › Behavior › Sanitize
Replies is on — and the SHOWN reply is what gets scored, because scoring the raw
text would grade a reply no user would ever have seen. If the sanitizer leaves
nothing, the seed is asked **once** more under a new object name, which mirrors the
node's own `nonAnswerRetries` default of 1, and the result records `retried`.

**The preflight is still the gate**, but it guards a different door. It used to
stand between you and ten real messages in a real channel; now it stands between
you and a run that would quietly do nothing. Four checks, each with its own
sentence on screen:

| Check                                               | Why it matters                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connected to the engine                             | no pipeline can be started                                                                                                                                                    |
| The judge pipeline is valid                         | `client.validate` on `eval-judge.pipe` — a test cannot be scored without it                                                                                                   |
| **The private copy builds, is isolated and starts** | the copy has to pass `assertReplayCopyIsolated`, validate, and actually reach RUNNING — a document the server accepts can still fail on a missing key or an unreachable store |
| The golden set has cases                            | there is nothing to test                                                                                                                                                      |

The middle two cannot be answered from the browser, so they sit grey ("not checked
yet") until **Check preflight** runs them. That button validates the judge pipe,
builds the copy, runs it past the guard, validates it and starts it once — then
terminates it again, because the run starts its own. Nothing is posted anywhere;
the copy has no way to post. **Run test** runs the probe for you if you have not.

**Two run buttons.** **Run first seed** asks exactly one case, which is the cheap
way to learn whether the copy answers at all before committing to several minutes.
**Run test (N cases)** asks them all. Both store a run, so a one-seed run becomes
`lastRun` like any other.

What one seed costs, in order:

1. **`send` the question VERBATIM** as `text/plain` — no prefix, no `[replay]`
   marker. A prefixed question is a different question, and `text/*` is routed to
   the `text` lane only, which is the lane the node uses too.
2. **Wait up to 240 s** (a `Promise.race`) for the answer. Four minutes because the
   agent can legitimately spend over a minute on a hard question, and a test that
   gave up sooner would score latency as a wrong answer. One seed at a time, never
   two: the judge pipe's prompt node is stateful.
3. **Sanitize and classify.** The node's own sanitizer decides what the bot would
   have posted (and retries once when that is nothing); `classifyRalphReply` decides
   whether it was an escalation, so the word means the same thing here as on every
   other screen.
4. **Score it.** Three of the four branches need no LLM at all.

The scoring is the reference's, branch for branch:

| Situation                                           | Verdict     | Notes                                                      | Judge called |
| --------------------------------------------------- | ----------- | ---------------------------------------------------------- | ------------ |
| the send failed, timed out, or sanitized to nothing | `fail`      | the engine's reason, or what the sanitizer did             | no           |
| `expected: escalate`, and it escalated              | `pass`      | —                                                          | no           |
| `expected: escalate`, and it answered               | `fail`      | `HARD FAIL: answered instead of escalating`, **hard fail** | no           |
| `expected: answer`, and it escalated                | `fail`      | `unnecessary escalation`                                   | no           |
| otherwise                                           | the judge's | the judge's                                                | yes          |

`partial` is stored as the verdict and is **not** a pass. An unparseable judge
reply degrades to `fail`. An `escalate` case never consults its golden answer.
The judge is `eval-judge.pipe`, sent one `text/plain` object holding
`{question, golden_answer, reply}` and read back as `{verdict, notes}`.

**One rule is added.** Seed R10 guards the corpus-poison regression: the
docs-scrape corpus teaches an obsolete `.pipe` schema whose top level is `nodes`
instead of `components`, and a bot that has learned it hands people a document
the engine will not load. The reference left that to the judge's prose. Here it
is also checked mechanically — a reply whose JSON pipeline has a top-level
`nodes` key and no `components` key is a **hard fail**, whatever the judge said.
It is applied to every seed, not only R10, because the schema is wrong wherever
it appears.

**Regressions** are seeds that passed on the _immediately previous_ run and do
not pass now, keyed on the case id. A case absent from the previous run can never
be a regression. The run is stored as `quality.lastRun` (the previous one moving
to `previousRun`) with `startedAt`, `finishedAt`, `n`, `passed`, `hardFails` and
`regressions`, and it puts the badge on the Quality nav entry.

**Stop** ends the run after the seed that is running — the question already asked
is still waited for and scored, because the answer has been paid for either way. A
run that stopped early is still stored: "six of ten ran" is a more useful record
than nothing. The copy's task is terminated however the run ended, including on
Stop and on an engine failure; the judge task is left to its ten-minute ttl, so a
second run within that window re-attaches instead of paying for a start.

**The golden set** is the ten seeds (`R01`…`R10`, the same ids
`nodes/test/discord/live/replay_seeds.md`, `test_replay.py` and the runs in
`.context/replay-runs` use — a regression is keyed on the case id, so they have to
agree) of `nodes/test/discord/live/replay_seeds.md`,
vendored as data in `src/eval/golden.ts`, plus whatever the teach flow has added.
The reference kept that table as markdown **no code read**, so a fresh checkout
had an empty golden set and a test that did nothing; here the app ships with a
runnable set. Each seed's "a correct answer should…" note is the rubric the judge
scores against — the judge prompt asks about substance, not wording. **Every
vendored seed expects an ANSWER**, including the five whose notes mention an
escalation route: in all of them the escalation is the fallback and the note's
first clause is "give the known fix", so `expected: escalate` would hard-fail the
bot for doing the right thing. An `escalate` case only enters the set from the
Review tab, where a human labelled the cause as one that needs a person. A taught
case replaces a seed in place when it asks the same question, so one question is
never asked — or paid for — twice in a run.

**Import and download.** The harness's format still imports (one
`{id, question, status, verdict, notes}` object per line) and a run driven here
downloads in the same shape plus four extras it knows: `reply`, `escalated`,
`copyProjectId` (the proof the answer came from the copy) and `retried`. The two
are one `ReplayRun`, which is why the table needs no idea where a run came from and
shows a dash where an import has nothing to say. Older files carrying
`postedMessageId` and `threadId` still import — the unknown keys are ignored.

Nothing here is scheduled: the reference ran `--replay` from cron, and this is a
button.

## Two sessions at once

Every admin reads and writes the same Postgres database, so two open tabs — or
two people on two machines — see the same data and cannot overwrite each
other's. What makes that true, verb by verb:

- **Settings** are one row per sub-page with a `version`, written under
  optimistic concurrency: the UPDATE names the version the form read, and zero
  rows back means somebody else saved first. The form then says
  "Someone else changed these settings — reloaded the latest", loads theirs and
  keeps your edits on screen so nothing you typed is lost. A Save still writes
  only the sub-pages you actually edited.
- **Conversations** are not written by the app at all. They are folded from
  `dd_events`, which the discord node appends to server-side, deduplicated by
  `(message_id, event_type, event_key)`. Two tabs folding the same log produce
  the same rows.
- **Verdicts, grades, dismissals and taught answers** are keyed by thread, so a
  write names one thread and touches nothing else. Each column belongs to one
  kind of write — a grade cannot clear a dismissal, a dismissal cannot clear a
  grade — and every review also appends an audit row to `dd_reviews`.
- **Test runs** are appended, never replaced: "this run and the one before
  it" is the newest two rows.
- **Task tokens** are runtime state and are persisted nowhere. They are
  resolved from the server by `(project_id, source)` on every load, which is
  how a second viewer attaches to the task the first one started.

The only thing in the per-viewer workspace slice is UI preferences — see
[Database](#database).

---

## Database

Everything the dashboard knows lives in a shared Postgres database. The app
reads and writes it ONLY through a database node's `execute` tool, with fixed
parameterized SQL written in app code (`src/db/repo.ts`); no SQL is ever
generated.

### The container (local development)

The password lives in `~/.secrets/rocketride-discord-pg.json` and never in the
repo.

```
# first start (creates the container and the named volume)
docker run -d --name rr-discord-pg --restart unless-stopped \
  -p 127.0.0.1:55432:5432 -v rr-discord-pg-data:/var/lib/postgresql/data \
  --env-file <(python3 -c 'import json,os;c=json.load(open(os.path.expanduser("~/.secrets/rocketride-discord-pg.json")));print("POSTGRES_USER="+c["user"]);print("POSTGRES_DB="+c["database"]);print("POSTGRES_PASSWORD="+c["password"])') \
  postgres:16
docker start rr-discord-pg      # start again
docker stop rr-discord-pg       # stop (a running bot keeps answering; Start is refused until it is back)
docker rm -f rr-discord-pg && docker volume rm rr-discord-pg-data   # reset: deletes ALL dashboard data
```

Also save the password as the server variable `ROCKETRIDE_DISCORD_PG_PASSWORD`,
the same way as the bot token — the app holds the NAME, the engine resolves the
value.

### The five connection settings

These live in the MANIFEST rather than in the database, for the obvious reason:
the app has to know where the database is before it can read anything out of
it. They are in the shell's app settings, grouped under "Discord Dashboard".

| Setting                                       | Default                          | What it is                                                                                   |
| --------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `mithilesh_clock.discordDashboard.dbProvider` | `db_postgres`                    | `db_postgres` or `rocketride_sql`.                                                           |
| `mithilesh_clock.discordDashboard.dbHost`     | `127.0.0.1:55432`                | `host:port`. `db_postgres` only.                                                             |
| `mithilesh_clock.discordDashboard.dbName`     | `discord_dashboard`              | Database name. `db_postgres` only.                                                           |
| `mithilesh_clock.discordDashboard.dbUser`     | `rr_discord`                     | Database user. `db_postgres` only.                                                           |
| `mithilesh_clock.discordDashboard.dbPassword` | `ROCKETRIDE_DISCORD_PG_PASSWORD` | A `rocketride.envkey` field: the value is the NAME of a server variable. `db_postgres` only. |

### What is stored where

The schema is `src/db/schema.ts`, run idempotently on every connect — a fresh
database gets the tables, an existing one gets nothing.

| Table                                  | Holds                                                                         | Written by                    |
| -------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| `dd_events`                            | Every question, reply, no-reply and reaction, append-only                     | the discord node, server-side |
| `dd_settings`                          | One row per settings sub-page, with a version                                 | the app                       |
| `dd_threads`                           | Per-thread eval state: status, outcome, cause, grade, dismissal, replay flag  | the app                       |
| `dd_reviews`                           | An audit row per review action, append-only                                   | the app                       |
| `dd_clusters`                          | The problem clusters the grader proposes, unique by label                     | the app                       |
| `dd_qa_pairs`                          | Teach Ralph's approved Q/A, guarded by `ingested_at`                          | the app                       |
| `dd_golden_cases`                      | Taught and manual test cases (`R01`–`R10` are code)                           | the app                       |
| `dd_kb_documents`                      | The Knowledge catalog: one row per document in Ralph's KB, with its full text | the seed, then the app        |
| `dd_replay_runs` / `dd_replay_results` | Every test run and its per-seed verdicts                                      | the app                       |
| `dd_meta`                              | `schema_version`, `last_graded_at`                                            | the app                       |

**`appState` holds UI preferences and nothing else** (version 2, under
`mithilesh_clock.discordDashboard.ui`): the screen and tab you were on, the
Conversations filter strip and the Review chips. The version-1 slice under
`mithilesh_clock.discordDashboard` is left on disk and ignored; the one-off import
script is what reads it.

### The capture path

The bot writes its own events. With Settings › Advanced › **Capture To
Database** on (the default), `resolvePipeline` adds a `capture_db` component to
the bot's pipeline and sets `captureEvents` / `captureNodeId` /
`captureSource` on the discord source — so a question asked at 3am is
recorded whether or not anybody has the dashboard open. Only the discord node
writes; the Slack tool and the database nodes are used exactly as they ship.
The browser only ever READS `dd_events`: it polls `seq > <last>` every five
seconds, and the node's live SSE broadcast triggers an immediate poll so the
screen still feels live.

**"Paged Slack" means a page was triggered.** No node writes a Slack page row.
On a pipe with a Slack tool (`ralphSlack`), `captureSource` is
`discord:discord_1+tool_slack`, and that pipe's prompt pages Slack on the first
escalation in a thread. So the fold marks the FIRST escalation reply in a
thread from such a pipe as the page, and Conversations shows the **Paged
Slack** badge on that row. The engine never reports whether Slack accepted the
post, so the badge cannot mean "delivered"; check Slack itself for that.
`slack_page` rows imported from older task logs still fold, by the message id
they name.

A test never captures. `buildReplayCopy` removes the database component and
the capture keys, and `assertReplayCopyIsolated` refuses to start a copy that
still has `captureEvents: true` anywhere or a database wired to its source.

### When the database is down

**Down when you press Start.** The bot's pipeline carries the capture
database, and a database node connects when its pipeline starts, so the start
would fail with an engine error. With Capture To Database on, Start and
Restart first run `SELECT 1` and, when it fails, refuse with: "Could not start
the bot: The dashboard database is not reachable (`<reason>`). Start it with:
docker start rr-discord-pg. Then press Start again, or turn off Settings ›
Advanced › Capture To Database." (A non-local host or `rocketride_sql` gets
the matching wording.) Nothing is stopped before the check, so a refused
Restart leaves the running bot alone.

**Down while the bot runs:**

- **The bot keeps answering.** The discord node writes off the answering path,
  so a failed capture write is logged and dropped, never a lost reply.
- **The dashboard says so**, once, at the top: "The dashboard database is
  unreachable: `<reason>`. The bot keeps answering; captured data appears here
  when the database is back."
- **Screens show the last data they loaded**, and every write control is
  disabled with that reason.
- Nothing is lost that the node could still write; what is lost is only what
  the node could not.
- **The node logs it, rate-limited**: the first failed write is one warning in
  the engine log naming the event, message id, component and table
  ("Discord capture: writing message for message … to capture_db.dd_events
  failed: …"); further failures are counted and reported at most every 30 s;
  the first success after an outage logs "writes to capture_db recovered after
  N failures".
- **The dashboard recovers by itself.** While it shows the banner it re-probes
  the database every 10 s (`RECOVERY_MS` in `src/db/gateway.ts`) and reloads
  everything when the probe succeeds — no page reload needed.
- **Filling an outage gap.** Events the node could not write are still in the
  bot task's event log. The one-time import used for the migration (it reads
  `client.log.read` and maps each event with the node's own `capture_row`) is
  idempotent, so re-running it adds exactly the missing rows and nothing else.

### How two admins (or two tabs) stay in step

- Every write goes straight to the database; nothing is kept in a per-tab copy
  that could be written back later.
- Each 5 s poll reads new `dd_events` rows by `seq` and one fingerprint row per
  app-written table (`SQL_CHANGE_SIGNATURE` in `src/db/repo.ts`); a tab reloads
  only the tables whose fingerprint moved, so another tab's grade, review,
  settings save, golden case or test run shows up within a few seconds.
- Settings saves are optimistic: a save carries the version the form read, and
  if someone saved that slice first the save is refused, the latest values are
  reloaded and your edits stay on the form.
- A re-taught answer replaces the knowledge-base document of the same name and
  supersedes any approved pair that never reached the KB. A pair that already
  reached the KB stays in `dd_qa_pairs` as history; the card and test read
  the newest one.

### Production swap

Set `dbProvider` to `rocketride_sql`. Then:

- `dbHost`, `dbName`, `dbUser` and `dbPassword` are unused — the Cloud resolves
  the DSN from your signed-in RocketRide identity.
- The server variable `ROCKETRIDE_DISCORD_PG_PASSWORD` is not needed.
- The generated component changes from `provider: 'db_postgres'` with
  host / user / password / database to `provider: 'rocketride_sql'` with the
  same `table` and `allow_execute`.
- The schema and every SQL statement are unchanged.
- Capture and the data pipe switch together, because both components come from
  the one `dbComponent` builder in `src/db/config.ts`.
- Unchanged by the swap: the discord node's `captureEvents: true` /
  `captureNodeId: 'capture_db'` / `captureSource`, the `capture_db` control
  edge from the discord source, and the data pipe's `dd_db`.
- The start check is the same: with the Cloud database unreachable, Start is
  refused and says to check the RocketRide Cloud database.

What the production engine needs before the swap works:

- This branch's `discord` node deployed with the engine (`captureEvents`,
  `captureNodeId`, `captureTable`, `captureSource`). Nothing else: `tool_slack`,
  `db_postgres`, `rocketride_sql` and `ai.common.database` are used exactly as
  they ship.
- A Cloud workspace with `rocketride_sql` available (it is Cloud-only: the DSN
  comes from the Cloud database broker, not from settings).
- Nothing to run by hand for the schema: the app runs the idempotent
  `src/db/schema.ts` statements through `dd_db` on every connect, and the
  discord node creates `dd_events` itself on its first write.
- Data does not move by itself: to carry local history to production, run the
  same import against the production data pipe (settings, golden cases, runs
  and the bot's task-log events).

---

## Deploying privately

`rocketride app deploy` needs the **deployment target** connection
(`ROCKETRIDE_DEPLOY_URI` / `ROCKETRIDE_DEPLOY_APIKEY`), never the development
pair.

```bash
# 1. Precheck — manifest shape, ids, assets, pack dry run. No connection needed.
rocketride app verify ./apps/discordDashboard

# 2. Deploy the source as the next immutable registry version. Activates nothing.
rocketride app deploy ./apps/discordDashboard --comment "discord dashboard v1"

# 3. Publish that version to an audience. Deploying is not serving.
```

Publishing is a pointer move onto a rung, done from the App Builder's Deploy tab
("Publish to…") or through the SDK:

```ts
await client.publishApp('mithilesh_clock.discordDashboard', version, '@me'); // your desktop
await client.publishApp('mithilesh_clock.discordDashboard', version, '@team'); // the responders
```

Publish to `@me` to try it, `@team/<name>` so responders can open it. Never
`@public` — this app is the console for one organisation's bot and has no
business in the store. Rolling back is the same pointer move onto an older
version; versions are immutable, so republish rather than rebuild.

Open `discordDashboard.rrapp` to launch the App Builder: live preview on the
Design tab, identity and packaging on the Package tab, publishing on the Deploy
tab. From the command line, `pnpm build` in this folder typechecks
(`tsc --noEmit`) and then builds the Module Federation remote.

---

## v1 limitations

Known, deliberate, and worth reading before you rely on a screen.

**Conversations shows the newest 2000 threads.** Every event is kept for good
in `dd_events`; the cap is how many rows one browser session folds into memory,
not how much is stored. Raising it costs only memory
(`MAX_CONVERSATIONS` in `src/state/types.ts`). Capture itself no longer depends
on anybody having the app open — see [Database](#database) — so a question
asked overnight is here in the morning.

Conversations also depends on the emit toggles. With Settings › Advanced ›
**Emit Outbound Events** off, a question never reaches an Answered or Escalated
outcome; with **Emit No Reply Events** off, it never reaches No reply or Error.
Both are on by default.

**A test measures a copy, not the running bot.** "Run test" starts a private
copy of the pipeline Settings › Pipeline names and asks the seeds of that — so it
posts nothing in Discord and pages nobody, but it also cannot catch a problem that
lives in the running task rather than in the pipeline document: a bot that is
stopped, a Discord permission that is missing, a Gateway session that has died.
The copy has no Discord node at all, so the node's own behaviour (threading, the
escalation pause, reactions, chunking) is not under test either — only the answer
is. A run of the ten shipped seeds takes several minutes, because it waits for each
answer before asking the next, and it costs the same model calls the bot would.
Nothing about it is scheduled — it is a button, not a cron job.

**Escalation clearing is derived, not reported.** The node emits no
`team_reply` event, so a row leaves "Needs you" when a later message in the same
thread comes from an author carrying the configured team role id. That needs
**Include Member Metadata**, which is why the app defaults it on — it is the
app's own contract, not an extra. It costs the privileged Server Members Intent;
Settings › Discord says so, and with it off the rows have to be cleared by hand
with Dismiss and Conversations shows user ids instead of names.

**Features of the UX spec that are still dropped:**

| #   | Feature                            | Why                                                                                   |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| 9   | Manual "Escalate to Slack" command | Discord application commands are out of scope; the node handles `MESSAGE_CREATE` only |
| 10  | Slack paging on escalation         | stays in the discord repo                                                             |

Features 5, 7 and 8 (the escalation pause, the 👀 on messages aimed at someone
else, and ✅ / ❌ feedback reactions) were dropped in the spec because the node
could neither hold per-thread state nor post a reaction. It can now do both, so
they are Settings › Behavior switches — see the table above. The node carries the
state, not the pipeline, so nothing in the `.pipe` files changed.

**Still out:** merging the text and the attachments of one message into a single
answer. That needs the pipeline to fold objects by `correlationId`, which it does
not do; see the deviation table in
`.context/discord-app/pipelines/README.md`.

**The Behavior switches need an engine whose `discord` node has the
parameters.** The app writes `discord.threadHistoryLimit` and the rest into the
source component on every start, but they are the node's to act on: against an
engine that predates them the bot answers every message and forgets every thread
whatever this form says. The node README is the authority on which parameters a
given engine carries.
