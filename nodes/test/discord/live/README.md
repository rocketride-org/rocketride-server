# Live Discord node harness (L1 / L2 / L3)

End-to-end tests for `nodes/src/nodes/discord` against a **real Discord server**
with the **pipeline stubbed**. The node and the Discord side are real; only the
engine (`rocketlib`, `depends`) and the target endpoint are stubbed, so these
tests catch everything the unit suite cannot: what Discord actually accepts,
what it actually reports back, and whether the gates hold on real Gateway
objects.

Layer map (from `.context/discord-test-plan.md`):

| Layer | File | Needs | Status |
|---|---|---|---|
| L1 live I/O | `test_live_io.py` (D01..D19) | bot token + Discord reachable | running |
| L2 replay | `test_replay.py` (R01..R10) | same | running (plumbing only) |
| L3 engine e2e | `test_engine_e2e.py` (E01..E06) | engine on `ROCKETRIDE_URI` + a driver bot | running (E06 pending) |
| L4 full engine suite | `test_engine_full.py` (F01..F46) | L3 + `DISCORD_E2E_FULL=1` + `botUserId` | running (see "Full engine suite") |

## How to run

```bash
# live (posts to the real test server, cleans up after itself)
DISCORD_LIVE=1 python3 -m pytest nodes/test/discord/live -v -s -p no:cacheprovider

# one test
DISCORD_LIVE=1 python3 -m pytest nodes/test/discord/live -v -s -k d09

# L3 only, against a local engine that has the node and the ROCKETRIDE_DISCORD_* env
DISCORD_LIVE=1 ROCKETRIDE_URI=http://localhost:5566 \
  python3 -m pytest nodes/test/discord/live/test_engine_e2e.py -v -s -p no:cacheprovider

# normal run: the whole directory is collected and skipped, no network touched
python3 -m pytest nodes/test/discord -q
```

Requirements: `python3` (3.9+) with `discord.py` installed, and two secret files
(never read into a transcript, never asserted on):

- `~/.secrets/rocketride-discord-bot.json` — `{"token": "..."}`
- `~/.secrets/rocketride-discord-live.json` — `guildId`, `primaryChannelId`,
  `guestChannelId`, `botUserId`, and optionally `teamRoleId`, `humanUserId`,
  `noPermissionChannelId` (a channel the bot has no permissions in; D01 reads
  its permission bits and never posts there), `driverBotId`, `driverTokenFile`.
  Each key can instead come from the environment as `DISCORD_LIVE_` plus the
  key upper-cased (`DISCORD_LIVE_GUILDID`, …), which wins over the file; with
  every required key in the environment the file is not needed. Empty strings
  mean "not provided": the harness self-discovers what it can
  (`guild.owner_id` for a human user, a non-managed non-default role for role
  tests) and skips the rest with a reason.

### L3 configuration

L3 skips unless **all** of: `DISCORD_LIVE=1`, `ROCKETRIDE_URI` set and its
host:port accepting a TCP connection, and the driver bot token readable. Its ids
live in the `engine` block of `~/.secrets/rocketride-discord-live.json`; every
key is overridable by an environment variable of the same name upper-cased and
prefixed `DISCORD_E2E_` (`DISCORD_E2E_SUPPORTCHANNELID`, …). `engineUri` also
falls back to `ROCKETRIDE_URI`, which wins over the stored value, so pointing a
run at another engine needs nothing else.

| key | example | what it is |
|---|---|---|
| `engineUri` | `http://localhost:5566` (5565 works too) | engine the pipe runs on |
| `engineApiKey` | `MYAPIKEY` | `auth` for `RocketRideClient` |
| `guildId` | `<guild id>` | guild the support channel is in |
| `supportChannelId` | `<support channel id>` | channel the driver posts in |
| `teamRoleId` | `<team role id>` | escalation role |
| `driverBotId` | `<driver bot user id>` | second bot, put on the node's `allowedBotIds` |
| `driverTokenEnvFile` | `.context/ralpgh.env` | env-style file (repo-relative) holding the driver token |
| `driverTokenEnvKey` | `SCHEDULER_BOT_TOKEN` | key to read from it |

The token of the bot **under test** is not needed and never read here: the
engine resolves `${ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN}` (and the guild /
channel / role placeholders in `engine_min.pipe`) from its own environment.
`replyMode` and `allowedBotIds` are the two knobs the tests set in code.

## Result matrix (live run 2026-09-29, guild "Mithilesh's server")

| Ralph / node feature | ID | Layer | Status | Note |
|---|---|---|---|---|
| Login, intents, per-channel permissions | D01 | L1 | PASS | `#test` confirmed no-perms; node requests `message_content`+`guilds`, adds `reactions`/`members` on demand |
| `replyMode=reply` | D02a | L1 | PASS | native reply, no author ping |
| `replyMode=channel` | D02b | L1 | PASS | no reply reference |
| `replyMode=thread` | D02c | L1 | PASS | `auto_archive_duration=60` accepted; name truncated to 20 |
| Thread follow-up gating (parent-aware) | D03 | L1 | PASS | allowlisted parent processed, other parent dropped |
| Per-channel mention gating | D04 | L1 | PASS | real Discord-resolved bot mention |
| Bot allowlist + own-message drop | D05 | L1 | PASS | own message dropped even when its own id is allowlisted |
| Mention suppression (default) | D06a | L1 | PASS | `mentions`/`role_mentions` empty, `mention_everyone` false |
| Allowed role ping | D06b | L1 | **SKIP** | guild has no non-managed, non-default role (`teamRoleId` empty); bot-managed roles are unmentionable by anyone, so the test cannot be meaningful. Needs config item C1 |
| Allowed user ping | D06c | L1 | PASS | exactly the allowlisted user pinged |
| Text-like attachments (`.pipe`, `.md`) | D07a | L1 | PASS | both framed `[attachment <name>]`, truncated to `textAttachmentMaxChars`, zero tag writes |
| Binary attachment routing | D07b | L1 | PASS | png → image lane, pdf → tag stream, `mimeType` on the entry |
| Oversized attachment skipped | D07c | L1 | PASS | never opened, excluded from `groupSize` |
| Object identity + metadata | D08 | L1 | PASS | names `mid`, `mid:0`, `mid:1`; urls `discord://ch/mid[/att]`; `groupIndex` 0/1/2, `groupSize` 3, shared `correlationId`, `eventType=message`, full documented key set |
| Member metadata | D08b | L1 | **SKIP** | privileged members intent is off in the Developer Portal (`discord.PrivilegedIntentsRequired` on connect). Needs config item C4 |
| Code-fence chunking | D09 | L1 | PASS | 4500 chars → 3 posted messages, each ≤2000 with balanced fences, reconstruction exact |
| `emitReactions` | D10a | L1 | PASS | real raw add/remove → two `mid:reaction` events |
| `emitNoReply` | D10b | L1 | PASS | `reason=no_answer` for an empty answer, exception text for a failing pipeline; nothing posted |
| `emitOutbound` | D10c | L1 | PASS | `messageIds` equals the real posted id, `destination=reply` |
| Backfill | D11 | L1 | PASS | newest 3, oldest first, nothing posted with `sendResponses=false` |
| Silence on empty answer | D12 | L1 | PASS | no post, no event |
| Mention / reply-reference metadata | D13 | L1 | PASS | `mentionedUserIds`, `repliedToMessageId`, `botUserId` |
| Typing indicator | D14 | L1 | PASS | real typing context entered and exited around a 2 s answer |
| Fatal startup paths | D15 | L1 | PASS | missing token raises; invalid token → "login failed (invalid token)"; missing privileged intent → fatal (see bug B1) |
| Thread history as context (`threadHistoryLimit`) | D16 | L1 | PASS (2026-09-29) | thread mode; the opening message is sent verbatim, the follow-up arrives as `User's latest message: ...` plus the earlier answer under the bot's display name, and excludes itself |
| Escalation pause (`escalationPause`) | D17 | L1 | PASS (2026-09-29) | a canned answer carrying a configured marker pauses the thread; a follow-up without a mention posts nothing and emits `no_reply` reason `paused`; a follow-up that @mentions the bot is answered and unpauses |
| Aimed elsewhere (`ignoreAimedAtOthers`) | D18 | L1 | PASS (2026-09-29) | a message mentioning the guild owner gets the 👀 acknowledgement only: nothing ingested, nothing posted, `no_reply` reason `aimed_elsewhere` |
| Feedback reactions (`feedbackReactions`) | D19 | L1 | PASS (2026-09-29) | a 2-chunk answer carries ✅/❌ on the LAST chunk only (read back via `message.reactions`), and the `outbound` event reports `feedbackEmojis` |
| Seed table parse | — | L2 | PASS | harness self-check on the vendored `replay_seeds.md` |
| Replay seeds | R01..R10 | L2 | PASS (10/10) | plumbing only: one correlated text object + one reply per seed |
| Engine e2e | E01 | L3 | PASS (2026-09-30) | engine spawns the node; logs in as Rocket Ralph (Beta); stays RUNNING with `ttl=0` |
| Engine e2e | E02 | L3 | PASS (2026-09-30) | node metadata (19 keys, `correlationId` = message id) reaches a subscriber through `apaevt_sse` type `discord`; pipeline traces never carry it. Then an `outbound` event with `destination=reply` and the real posted id |
| Engine e2e | E03 | L3 | PASS (2026-09-30) | real OpenAI answer posted as a native reply to a driver-bot message in the support channel |
| Engine e2e | E04 | L3 | PASS (2026-09-30) | thread mode: thread named from the message text (archive 1440), answer inside it; a follow-up posted in that thread was gated by its parent channel, answered in the thread, and its events carried `threadId` and `parentChannelId` |
| Engine e2e | E05 | L3 | PASS (2026-09-30) | escalation reply ends with the line `Escalated to the RocketRide team.` and pings nobody (`role_mentions` empty, `mention_everyone` false) |
| Engine e2e | E06 | L3 | SKIP | eval-capture pipe needs a local Qdrant (port 6333 closed); body is a TODO |

The L3 row set above is what `test_engine_e2e.py` now asserts on every run (five
tests, ~80 s end to end). E05's second variant — `allowedMentionRoleIds` plus a
prompt that emits `<@&teamRoleId>`, asserting `role_mentions == [teamRoleId]` —
is **not** implemented: it needs a different prompt, so a different pipe and
another task restart, which is not worth the run time. The role-ping path itself
is covered by D06c (user ping) and by the manual 2026-09-30 run recorded above.

Replay verdicts are written to `.context/replay-runs/<timestamp>.jsonl` (one
line per seed: id, topic, question, posted message id, reply message id,
status). That directory is gitignored.

## Node bugs or gaps found live

**B1 — the privileged-intent failure message names the wrong intent.**
`IEndpoint._bot_runner` maps every `discord.PrivilegedIntentsRequired` to
`'Discord Bot: enable the Message Content Intent in the Developer Portal'`.
D15 reproduces this with `includeMemberMetadata=true` on a bot whose **members**
intent is disabled: discord.py reports

> Shard ID None is requesting privileged intents that have not been explicitly
> enabled in the developer portal.

and the node tells the operator to enable Message Content, which is already on.
Operator-facing only (the source still fails fast, which is correct), but it
sends whoever hits it to the wrong toggle. A fix would name the intents the node
actually requested (`members` when `includeMemberMetadata`, `message_content`
always). Not fixed here: the node is out of this change's scope.

**G6 — a truncated `threadName` is not stripped.**
Discord silently strips leading/trailing whitespace from thread names, but
`_send_chunk` truncates with `thread_name[:max]` and no `.strip()`. When the cut
lands on a space, `thread.name` differs from the name the node asked for — so
anything that later matches on the thread name (or re-derives it) will miss.
D02c deliberately uses a content string whose cut lands on a non-space character
so the assertion is about the node and not about Discord's normalization.

**Confirmed, not bugs** — live risks from plan section 7 that held up:
`AllowedMentions(users=[discord.Object])` is accepted by the REST layer (D06c);
`create_thread(auto_archive_duration=60)` is accepted (D02c); the raw
reaction-**remove** payload really has no `member`, and the metadata falls back
to bot-less values without raising (D10a); a thread follow-up carries
`parent_id` immediately after creation (D03); `get_channel` is warm enough for
backfill (D11).

**Known limitation of the `mentionedUserIds` metadata** (not exercised as a
failure): the node reads `message.mentions`, which Discord populates only with
mentions it actually resolved. A mention the *sender* suppressed via
`allowed_mentions` is absent from `mentions` even though the text contains it
(`raw_mentions` still has it). D13 therefore posts its mention with the user
allowed. Harmless for human traffic; relevant if a pipeline ever needs
"was I named in the text".

## Single-identity compromise

The test server has exactly one bot identity, and no driver bot is configured
(`driverBotId` / `driverTokenFile` are empty), so plan option 2 applies: the
harness posts as the bot under test. The node's own-message gate would drop all
of it, so two narrow shims exist in `live_support.py`, each chosen so the thing
*under test* stays real:

- `SynthUser` + `with_author(message, author)` — a **real** Gateway message with
  a synthetic author identity. Used by D03/D04/D05, where the gate's channel,
  thread-parent, mention and bot-flag logic is all real and only "who sent it"
  is fabricated.
- `BotProxy(bot, user_id)` — the **real** bot with a different `user.id`. Used by
  D11 only, where the node fetches history itself so the messages cannot be
  re-authored; D11 asserts ordering and count, which the shim does not touch.

D05 additionally feeds the untouched, really-bot-authored message to prove the
own-message drop, and the mention gate in D04 is exercised with a mention
Discord itself resolved (a suppressed mention does not appear in
`message.mentions`, so the harness posts those with the bot allowed).

Providing a second bot token (config item C3) removes both shims.

## Residue policy

Every message the harness posts, and every message the node posts in response,
is deleted at session end: the fixture sweeps `#announcement-test`, `#updates`
and every thread the run created, deleting all plain messages authored by the
test bot (the bot can delete its own messages without Manage Messages). The
cleanup line is printed at the end of the run, e.g.

```
--- live cleanup ---
deleted 63 bot message(s)
residue: archived thread 'Q: [LIVE-TEST D02c]-' (<thread id>)
```

**Threads cannot be deleted.** The bot has no Manage Threads permission, and
deleting a thread's starter message does *not* remove the thread (verified
live). Threads the run creates are therefore archived by their creator and
listed as residue; each run leaves five archived threads:
`Q: [LIVE-TEST D02c]-`, `LIVE-TEST D03 thread`, `LIVE-TEST D03 guest thread`,
`D16 [LIVE-TEST D16] how do I start a pip` and
`D17 [LIVE-TEST D17] please escalate this`.
Granting Manage Threads (config item C5) would let cleanup delete them.

Other rules: `#test` (`noPermissionChannelId`) is never posted to — D01 only reads
its permission bits. Posts are throttled 1.5 s apart, one channel per test, and
`showTyping` is off except in D14. `#updates` is the guest channel per config
item C6.

**L3 leaves more behind**, because the driver bot is not the bot under test:

- the driver deletes its own messages (one per test, two for E04) and nothing
  else — it has no Manage Messages, so the node's answers stay in the channel
  and are reported as `N node answer(s) left`;
- a thread the node opens in E04 can only be archived by its creator or by
  Manage Threads, so the driver's attempt fails with `Forbidden` and the thread
  is reported as `open thread '[e2e E04] How do I run a pipeline from the Python
  SDK?'`. It auto-archives on the pipe's 1440-minute timer.

Driver posts are 3 s apart and one at a time, so the engine never has two
questions in flight.

## Files

- `live_support.py` — node loader (engine stubbed, real `discord`),
  `RecordingPipe` / `StubTarget` / `Entry`, `make_endpoint()`, the session
  `LiveBot` (background loop, posting, polling, cleanup), identity shims, and
  for L3 the `EngineSession` (SDK client + event recorder on its own loop) and
  `DriverBot` (the second identity).
- `conftest.py` — re-exports the `live_bot` fixture, adds the L3 fixtures
  (`engine_config`, `driver_bot`, `engine`) and skips the directory unless
  `DISCORD_LIVE=1`.
- `test_live_io.py` — D01..D19.
- `test_replay.py` — R01..R10 + the seed-table self-check.
- `replay_seeds.md` — vendored copy of `eval/replay-seeds.md` from the reference
  bot repo (read-only; re-copy it if the upstream regression set changes).
- `test_engine_e2e.py` — E01..E06 against a real engine and a driver bot.
- `test_engine_full.py` — F01..F46: every node feature through real pipelines on
  the engine (deterministic echo and fake-model pipes, one real AI run).
- `fake_llm.py` — a scripted OpenAI-compatible endpoint for `llm_openai_api`
  (scratchpad, `{"type":"final"}`, error text, empty, retry, HTTP 429, slow).
- `engine_min.pipe` — the pipe those tests run: discord -> prompt -> OpenAI ->
  answers, with `${ROCKETRIDE_*}` placeholders the **engine** resolves. It is a
  copy of `apps/discordDashboard/src/pipelines/discord-support-min.pipe` with
  `requireMentionChannelIds` and `allowedBotIds` emptied; re-copy the prompt if
  the app's support prompt changes.

## What this layer does not cover

Recorded as gaps, not failures (plan sections 3 and 6): slash and context-menu
commands, true text+attachment merge in one call, sink mode, and pipeline-side
aggregation (G2). Answer *content* grading of the replay seeds is L3 work and
needs `eval-judge.pipe` plus the Qdrant collection (E07).

Closed since: the node gained the five support-bot behaviors behind opt-in
fields, covered by D16..D19 — thread-history fetch for context (G1), escalation
pause state (G3), node-posted reaction acks (G4), feedback affordances (G5) —
plus reply sanitizing, whose pure logic is unit-tested in
`nodes/test/discord/test_discord.py` (a canned scratchpad answer needs no
Discord round trip, so it has no live row).

## Engine findings (2026-09-30)

- **Array parameters arrive as JSON text in string-like proxies.** Under a real engine every `array` field of `services.json` (`guildIds`, `channelIds`, `allowedBotIds`, ...) reaches the node as a one-element list holding the JSON text of the array, and that element is not a Python `str`. The old coercion wrapped it as one id, so every allowlist rejected every message with no error anywhere. Fixed in `IEndpoint._as_str_list` (always `str()`, then `json.loads` for `[...]`, else split on commas/whitespace); unit-tested with both shapes.
- **The minimal pipe's `prompt` node keeps history across questions.** Test 5 ("how do I get started") was answered with material from test 4 ("500 free tokens"). Unrelated askers leak into each other's answers; the support pipe needs per-thread memory or a stateless prompt.
- **Two bots on one token compete.** While the old `support.ts` Rocket Ralph (Beta) runs elsewhere, it opens a thread on every human post within a quarter second; the node then cannot create its own thread on that message. Stop the old bot before testing thread mode with human posts. Bot-authored test posts (scheduler bot on the node's `allowedBotIds`) are ignored by the old bot and work.
- **Dev-preview apps get no manifest settings.** The App Builder overlay registers the bundle only, so `contributes.configuration` defaults are absent in preview; the app must carry its defaults in code.

## Retrieval round (2026-09-30, app-driven on the bundled engine)

- Docs corpus: `https://docs.rocketride.org/llms-full.txt` (578 pages) + `llms.txt` ingested through `.context/discord-app/pipelines/docs-ingest-chroma.pipe` into a local Chroma server (`chroma run --port 8000`), collection `ROCKETRIDE_DOCS`, 746 chunks.
- The app's new "Support with docs retrieval" pipe (`discord-support-rag.pipe`) answered "How do I run a pipeline from the CLI?" with the documented install and env steps, and "Which Python versions does RocketRide support?" with "Python 3.10+" citing the SDK install page. Both rows showed as Answered in the app; escalations show as Escalated (plain line, no role ping this round).
- `rocketride_vector` is cloud-only on this engine (DSN comes from the cloud DB broker); use it once the app is deployed to RocketRide Cloud.
- Known issue: two open sessions of the app (the App Builder preview and another browser) overwrite each other's saved settings; the last writer wins.

## Agent pipe round (2026-09-30)

- Full agent pipe on Chroma (`discord-ralph-chroma.pipe`, now the app's "Support with RAG and tools" option): "Are there any open issues about the webhook component?" answered from a live `rocketride-org/rocketride-server` issue listing (GitHub tool), and "What is the difference between a lane and a profile in a .pipe file?" answered from the docs. Start-up warnings only ("unknown config key name" on chroma/http/frame_grabber, harmless). A `-slack` variant adds `tool_slack` (webhook URL `${ROCKETRIDE_SLACK_WEBHOOK_URL}`) with a paging instruction, for when that variable exists.

## Parity round (2026-09-30, app-driven on the bundled engine, agent pipe)

| Behavior | Field(s) | Driven by Relay | Result |
|---|---|---|---|
| Thread history as context | `threadHistoryLimit` 50 / `threadHistoryMaxChars` 6000 | question, then a follow-up in the thread | PASS: follow-up event carried `contextChars` 1392; the answer referred to "that same pipeline" |
| Escalation pause | `escalationPause` + marker "Escalated to the RocketRide team." | billing question, silent follow-up, mentioned follow-up | PASS: escalation line posted; silent follow-up -> `no_reply` reason `paused`, nothing posted; mentioned follow-up answered |
| Aimed at someone else | `ignoreAimedAtOthers` + `ackEmoji` 👀 | message mentioning a human | PASS: 👀 reaction, no thread, no reply, `no_reply` reason `aimed_elsewhere` |
| Feedback reactions | `feedbackReactions` | off in the app this round | covered by live test D19 on the test server |
| Reply hygiene | `sanitizeReplies` | on in the app | no reasoning-only reply observed this round |

Coercion fix shipped in this round: phrase-valued lists (`escalationMarkers`, `feedbackEmojis`) no longer split on whitespace (`_as_str_list(..., split=False)`); without it the app's default marker became five markers and "to" paused every thread.

## Slack paging round (2026-09-30, app-driven, `discord-ralph-slack.pipe`)

- The pipe adds `tool_slack_1` (webhook mode, `${ROCKETRIDE_SLACK_WEBHOOK_URL}`, the TEST webhook) as a control-edge tool of the CrewAI agent, plus a "SLACK PAGING" instruction: page once, on the first escalation of a thread, with the user's question, the reason and the thread name.
- Escalation ("[slack test 3] My Cloud invoice shows a charge I do not recognize, who can review my account?"): the agent replied with the plain "Escalated to the RocketRide team." line and called the tool (SSE `thinking` events "Calling tool_slack_1_message_post..." then "Tool complete" 314 ms later). The page landed in Slack at 23:54:38 PDT; the user confirmed it in the test channel.
- Plain question ("[slack negative test] How do I set the chunk size on the chunker node in a pipeline?"): answered from the docs in 6 s with no tool call of any kind. Nothing was paged.
- Once-per-thread, run live ("[slack once test] I was double charged on my Cloud subscription…"): the escalation paged Slack once (tool call 0.3 s). A follow-up in the thread without a mention never reached the agent (`no_reply` reason `paused`, `escalationPause`). A follow-up that mentioned the bot was answered ("I'm here and keeping an eye on this for you… escalated to the RocketRide team") with NO second tool call, so the model honoured the first-escalation-only instruction on its own as well. Exactly one Slack page per thread.
- Observability gap: the SSE stream carries only "Calling <tool>..." and "Tool complete" for tool use, never the arguments or the result, and the continuum log (`client.log.read`) has none either. Delivery is confirmed in Slack itself. A call that returns in about a millisecond is a local failure (missing SDK, bad config); a real webhook post takes a few hundred milliseconds.
- CrewAI names the tool `tool_slack_1_message_post`; the host catalog id is `tool_slack_1.message_post`. Instructions may use either, the model maps them.

## Eval round (2026-09-30, one seed end to end on the production pipe)

One pass of the reference eval loop's capture → grade → replay steps, driven the way the app will drive it: the bot on `discord-ralph-slack.pipe` with `emitReactions`, `feedbackReactions` and `emitOutbound` on, Rocket Relay posting seed R10 (the pipeline-schema regression guard) into `#support-forum`, the answer judged by a local port of the reference `eval-judge.pipe` (webhook → prompt → llm_openai → response_answers) fed `{question, golden_answer, reply}`, and the verdict written to `.context/replay-runs/<stamp>.jsonl` in the shape the Quality screen imports.

- Capture: the node emitted `message`, `outbound` (two message ids, the answer was split), and `reaction` events; Relay's ✅ on the answer arrived as `reaction` with Relay's user id. The bot's own ✅/❌ feedback emoji were ALSO emitted as `reaction` events (user id = the bot's) before the outbound event — a node bug, since a dashboard would count them as user feedback on every answer. Fixed in the node: a reaction whose user id is the bot's own is ignored (add and remove), so `feedbackReactions` no longer feeds `emitReactions`; verified live with seed R01 after the fix (see below).
- First attempt: no reply. The agent's raw output was a bare `Thought: I need to confirm …` with no Final Answer; `sanitizeReplies` reduced it to nothing and the node emitted `no_reply` reason `non_answer`. Correct node behaviour, and the same failure class the reference bot logged as "suppressed non-answer". Node improvement, landed: `nonAnswerRetries` (default 1, max 3) re-runs the text pass with a fresh object name (`<messageId>:retryN`, SSE `message` payload carries `retry: N`) before giving up; unit-tested, not yet caught in the act live.
- Second attempt (4 min later): answered in 8.1 s, two messages, bot added ✅/❌ itself. Judge verdict **fail**: top-level `components` is right (so not a hard fail), but the providers are invented (`pdf_parser`, `embedder_openai`, `vectordb_chroma`, `chat_source`, `retriever_db`, `response`), no `config` under a profile, no `response_answers`, and the LLM is wired as a data-lane consumer instead of through a `control` edge. This is the corpus-poison regression the seed exists to catch; it is a retrieval/prompt problem (the docs chunks the agent gets do not include a canonical .pipe), not a node problem.
- Observability: the agent's raw output is only visible through the task's continuum log (`client.log.read`, the `Task completed` event's `output.raw`); the SSE stream truncates it. A `no_reply` for `non_answer` should probably carry the first 200 chars of what was suppressed — noted as a follow-up.
- Judge harness: scratchpad scripts `eval_seed_run.py` (post as Relay, wait, react, record) and `judge_run.py` (start judge pipe with `client.use(..., source='webhook_1')`, `client.send(token, payload, {'name': ...}, 'text/plain')`, read `result['answers'][0]`), plus `write_verdict.py`. Worth folding into `test_replay.py` as the L3 grading step (E07) once the eval pipes live in the app.

## Eval loop port (2026-09-30, stage log)

Plan: capture (app state, no capture pipe) → grader (`eval-grader.pipe` + `eval-retrieve.pipe` on Chroma) → review tab → judge/replay (`eval-judge.pipe` + a new `tool_discord` sender node under the eval bot) → KB writeback (`eval-kb-writeback.pipe` into `ROCKETRIDE_DOCS`). Pipes live in `apps/discordDashboard/src/pipelines/`.

- Pipes validate on the bundled engine with no errors (grader, judge, kb-writeback, retrieve).
- Chroma score scale: the `score` on documents returned through the `chroma` node's questions lane is a DISTANCE (lower = closer), not the Qdrant similarity the reference's `matchScore 0.7` assumed. Probe on `ROCKETRIDE_DOCS` (miniLM, top_k 25): "What is a lane in a RocketRide pipeline?" top 0.776, nonsense "purple elephant tax return 1987 lottery" top 0.914. So the app's doc-gap test is `top distance > matchDistance` with `matchDistance` defaulting to 0.8, and `analyzeRetrieval` is called with the sign flipped (a note in `rules.ts`). Overlap detection keys on `metadata.objectId:chunkId` as the reference did.
- The engine derives a document's `objectId` from its name and returns it on `send`, so KB-writeback verification is: retrieve with the approved question and look for that `objectId` among the returned documents.
- `tool_discord` node landed (since moved out of this PR to its own branch, `feat/RR-1502-tool-discord`; was `nodes/src/nodes/tool_discord`, 77 unit tests, REST v10 via `requests`, tools `check_connection` / `message_post` / `messages_read` / `message_get` / `reaction_add`, token from `discord.token` or `ROCKETRIDE_DISCORD_TOKEN`). Copied into the bundled engine; `eval-replay.pipe` (webhook source + `tool_discord_1` with `${ROCKETRIDE_DISCORD_EVAL_BOT_TOKEN}`) validates, starts, and a `client.tool(check_connection)` call reaches Discord — HTTP 401 until the eval bot variable exists on the engine, which is the expected state before the user adds it. The manifest exposes the variable NAME as the `evalBotToken` envkey setting.
- Stage 1 capture, live (Relay: question → thread follow-up → ✅ on the last answer): ONE row in Conversations (count 30 → 31), event log `question · ralph_answer · ralph_answer · reaction_add`, Settings › Eval renders the seven tunables. Bug found and fixed on the spot: the first cut dropped thread follow-ups whose author is a bot, which hid the test driver's follow-up (`user_message` missing). The node only broadcasts messages its own gate accepted and the bot's own posts arrive as `outbound`, so the filter was wrong and is gone; re-verified with a second question + follow-up: event log `question · ralph_answer · user_message · escalation · reaction_add` on one row (the follow-up about Cloud variables was escalated by the agent, and the classifier read the plain "Escalated to the RocketRide team." line as an escalation as intended).
- Stage 2 grader, live: "Grade ungraded" on the Quality screen (with Settings › Eval "Grade now ignores quiet hours" on for the test). Rows opened by a bot in the test-bot list are excluded by the rules without a model call ("Excluded · decided by the rules"); with the test-bot list overridden by a dummy id, a fresh Relay question (answer, follow-up answered, ✅ from the opener) graded to "Resolved — confirmed". Engine logs: grader pipe 12 objects, retrieve pipe 13 objects, 0 failures across the two batches; both tasks are terminated when a batch ends and "Last graded" updates. Note for operators: Rocket Relay is both the test driver and, by default, a test bot, so its rows only enter the score when `Test Bot Ids` names something else.
- Stage 3 review + stage 5 teach, live: the Quality screen now has Scorecard · Review · Replay tabs. Scorecard on the captured rows: 1 of 13 decided, 7.7% success, Wilson [1.4%, 33.3%], 12 "Deferred — nobody answered" (the earlier escalation tests), policy floor 2/13, top clusters from the grader. Migration bug found and fixed on the spot: rows captured before the event log existed graded as "no reply / engine error" (12 phantom failures) because the rules saw no bot reply; the loader now synthesizes `question` + classified reply / `no_reply` events for such rows (reactions deliberately not attributed) and resets a grade decided on an empty log, and the re-grade came out right. Review: "Yes, a miss" on an invoice thread stamped "RocketRide Developer confirmed the grader's verdict" and toasted the reference wording. Teach Ralph: an answer for "How do I run a pipeline from the Python SDK?" approved in the card → `eval-kb-writeback.pipe` → Chroma `ROCKETRIDE_DOCS` went from 746 to 747 documents with `parent: ralph-qa-<message id>.md`; the app's landing check (retrieve by the question, match the send's `objectId`) marked it "in Ralph's KB". Golden case seeded for replay.
- Teach Ralph, closed loop: "How do I run a pipeline from the Python SDK?" was one of the escalated misses; after the approval above, Relay asked it again and Ralph answered in 5.9 s with the taught document nearly verbatim (`pip install rocketride`, `client.use(filepath=…)`, `send`, `terminate`) instead of escalating. Same bot task, no restart: the RAG pipe reads `ROCKETRIDE_DOCS` on every question.
- (Superseded below by the private-copy replay; kept for history.) Stage 4 replay, live as far as the token allows: the Replay tab's "Check preflight" runs seven checks (engine connection, bot running, eval-bot variable saved, support channel, golden set, replay pipe + eval bot sign-in, eval bot in Allowed bot ids). On this engine it passes the first two and stops at "The server holds no variable called ROCKETRIDE_DISCORD_EVAL_BOT_TOKEN" with the exact fix in the reason; the golden set has 11 cases (10 vendored seeds + the taught Python-SDK answer, expected `answer`). Run replay posts each seed verbatim as the eval bot through `tool_discord_1` in `eval-replay.pipe`, waits for the captured reply, applies the reference scoring (escalate-expected answered = HARD FAIL, unnecessary escalation = fail, judge pass/partial/fail with partial ≠ pass, top-level `"nodes"` = hard fail), writes the run and diffs regressions against the previous run. NOT yet exercised end to end: needs the eval bot's token saved under that variable name and its user id added to Allowed bot ids, then a bot restart.

## Replay on a private copy (2026-10-01, replaces the tool_discord sender)

#support-forum becomes the public channel, so Replay no longer posts in Discord. It now tests a private copy of Ralph on the engine, the way the reference `eval/replay.ts` used isolated pipe copies.

- **How the copy is built** (`apps/discordDashboard/src/eval/replayCopy.ts`): `resolvePipeline(PIPELINES[settings.pipeline.pipe], settings)` (exactly what the live bot starts), then the `discord` source becomes a `webhook` source `replay_webhook` with every edge repointed, `tool_slack` (and defensively `tool_discord`) plus their edges are removed, the agent's `SLACK PAGING` rule is dropped and the `[calls tool_slack…]` clause is cut from the escalation example (the example reply and its `Escalated to the RocketRide team.` line stay), and `project_id` becomes `0f6a2c9e-5b1d-4e7a-9c3f-8d2b7a1e4c60`. `assertReplayCopyIsolated` refuses to start anything that still has a Discord/Slack component, any `tool_slack`/`SLACK PAGING` string, a live project id, or a non-webhook source. Pure self-tests (`replayCopy.selftest.ts`, incl. the real Slack pipe) and the rules self-test: 0 failures under Node 26.
- **Verified on the engine** (`get_task_pipeline` of the copy task): project `0f6a2c9e…`, source `replay_webhook`, 15 components, providers agent_crewai, audio_transcribe, chroma, embedding_transformer, frame_grabber, llm_openai, ocr, parse, question, response_answers, tool_github, tool_http_request, webhook. Zero Discord or Slack components, zero `tool_slack`/`SLACK PAGING` strings, 54 agent instructions (live 55), escalation line present. The webhook feeds the same five components the discord source fed.
- **Same input shape**: a `text/plain` send reaches the webhook's `text` lane only (engine `_determine_lane`), the same way the discord node `writeText`s a new question. The agent's task text in the copy ends `### Current Task:\r\n    How do I get started with RocketRide?` after the retrieved docs, identical in structure to the live bot's task text for the same question.
- **Preflight**: engine connected, judge pipe validates, copy builds/isolates/starts (then the probe terminates it), golden set loaded. The eval-bot token, allowed-bot and support-channel checks are gone; the `evalBotToken` manifest setting is removed; `eval-replay.pipe` moved out of the app (kept in the session scratchpad); the `tool_discord` node folder is untouched.
- **Run one seed**: R01 pass (judge pass), copy started, answered and terminated in 36 s.
- **Full golden set, 11 cases** (`.context/replay-runs/20261001T050635Z.jsonl`), compared in-app against the imported `20260930T075831Z.jsonl`: 2 pass (R09 multimodal webhook; the taught Python-SDK case), 8 fail (R01, R03, R04, R05, R07, R08 judged partial; R02, R06 fail), 1 hard fail (R10: top-level `"nodes"`, the corpus-poison regression this seed guards), 0 regressions (the previous run had R01 and R10 failing too). Copy processed 12 objects in 126 s and was terminated.
- **Isolation, checked independently of the app**: #support-forum had 0 new messages and 0 new threads after 04:58:21 UTC (read-only check with the scheduler bot, which sees the 39 messages / 32 threads from the earlier tests in a 30-hour window); the live bot's event stream (observer on `tk_cef48e81…` for the whole session) recorded only its subscription handshake and one status snapshot, no `discord` or agent events; Slack search finds the two test pages from 2026-09-29/30 and nothing newer.
- **Surprises**: (1) R01 passed in the one-seed run and was judged partial two minutes later in the full run: the judge and the agent are not deterministic, so one run is a sample, not a verdict. (2) No seed escalated in the copy, including the escalate-or-answer seeds R05–R08; the judge marks those partial for not naming the escalation path. (3) R05's first answer was pure scratchpad and only the copy's one retry (mirroring the node's `nonAnswerRetries`) produced an answer. (4) The app's workspace file on the engine is last-writer-wins across shell sessions: it was overwritten with defaults twice today by another open session, and a tab's pending settings write can land after an external write. The taught golden case lost in the first wipe was restored by a guarded script while the test tab was closed.

## Postgres round (2026-10-01): server-side capture and a shared database

Local Postgres 16.14 in Docker (`rr-discord-pg`, 127.0.0.1:55432, volume `rr-discord-pg-data`, `--restart unless-stopped`; password only in `~/.secrets/rocketride-discord-pg.json` and the user-scope server variable `ROCKETRIDE_DISCORD_PG_PASSWORD`). Schema: ten `dd_*` tables (contract in the app's `src/db/schema.ts`). Production swaps `db_postgres` for `rocketride_sql` (app README, "Production swap").

**How events get in** (as first built; superseded by the next section, which reverted every shared-node change). The bot's own pipe now has a `capture_db` component (db_postgres, `allow_execute`, `defer_connect`) wired by control edges from `discord_1` and `tool_slack_1`. The discord node (opt-in `captureEvents`) queues every event it broadcasts and a background thread writes it with a fixed `INSERT … ON CONFLICT (message_id, event_type, event_key) DO NOTHING` through the db node's `execute` tool; tool_slack (opt-in `captureEvents`) writes a `slack_page` row keyed by the Discord message it was answering (`self.instance.currentObject.url`). The app only reads `dd_events`. New node tests: discord 148 → 227 (+ later fixes → 232 incl. existing), tool_slack 104 → 144, database base +26 (`test_db_defer_connect.py`, run under the engine's Python because the base needs `engLib`).

**Migration.** Workspace backup → 5 settings slices, 1 golden case, 2 replay runs / 13 results. One-time import of the bot's task logs (four answer pipes) → 83 events (34 questions, 33 replies, 4 no-replies, 10 reactions, 2 Slack pages) across 26 threads, mapped with the node's own `capture_row`. Re-running is a no-op (dedupe key).

**Live tests (Relay, one message at a time):**

| Test | Result |
|---|---|
| Dashboard closed: question, follow-up, ✅ | 5 rows written by `discord:discord` within seconds (message, reply, follow-up, reply, reaction). |
| Two tabs: same settings slice | Second save refused with "Someone else changed these settings — reloaded the latest"; the first tab's value stands (Eval v2 = 47). |
| Two tabs: different slices | Both saves kept (Eval v2, Pipeline v2). |
| Two tabs: review in one, watch the other | Tab A's queue went 13 → 12 of 20 about 1 s after tab B's "Actually resolved". |
| Grade | 20 threads graded into `dd_threads` (per-click limit). |
| Review | `dd_reviews` audit rows (confirm, resolve) + `dd_threads` stamps, reviewer "RocketRide Developer". |
| Teach Ralph | Approved pair → `dd_qa_pairs` (ingested, `kb_object_id`), `dd_golden_cases` upserted, KB doc `ralph-qa-<thread>.md` written; re-teach replaced the same document in place (still one chunk). |
| Replay | Run 3 stored in `dd_replay_runs`/`dd_replay_results` from the private copy (12 golden cases now); the copy wrote 0 capture rows. |
| Container stopped | Bot answered in 8.0 s; engine log: "Discord capture: writing message for message … to capture_db.dd_events failed: … server closed the connection unexpectedly"; dashboard banner within 5 s. |
| Container restarted | Next question, reply and ✅ captured within seconds; engine log "writes to capture_db recovered after 3 failures"; banner cleared by itself 9 s later; re-running the log import filled the 3 outage rows. |

**Bugs found live and fixed (tests first where in a node):**

1. `$11::jsonb` in the capture INSERT: the db node rewrites `$n` → `:bn`, and `:b11::jsonb` is not a bind, so every capture write would have failed with `42601`. Now `CAST($11 AS jsonb)` in both nodes; a regression test forbids `$n::`; verified 12/12 binds with the real translator.
2. The pipe an endpoint gets from `getPipe()` has no Python `invoke` (rocketlib patches it onto `IFilterInstance` only). Capture now falls back to `pipe.control(lane, IInvoke(param), nodeId=…)`, exactly what the patched `invoke` does. Found from the engine warning on the first live write.
3. A reply/no-reply to a channel question had `thread_id` NULL; it now carries the question's id (28 existing rows backfilled once — the only UPDATE ever made to `dd_events`).
4. A reaction captured live and again by the log import got two keys 1–2 ms apart. The node now stamps `occurredAt` once in the broadcast and the key uses it; 2 duplicate imported rows removed once.
5. A second tab never saw another tab's grades/reviews/settings (it only polled events). The poll now reads a one-row change fingerprint and reloads the tables that moved.
6. After a database outage the dashboard stayed in its error state until a reload. The gateway now re-probes every 10 s and recovers on its own.
7. The dev server died when `package.json` was saved mid-edit (rsbuild restarted on an unparseable file). Restarted detached; no code change.

**Surprises.** `source` reads `discord:discord`, not `discord:discord_1`: the endpoint key is the logical type, not the component id (cosmetic). `dd_settings.updated_by` records "dashboard" instead of the signed-in user (reviews do record the user). Postgres sequence gaps after the idempotent re-runs (`seq` 83 → 167) are expected: a conflicting insert still consumes a sequence value.

## Shared nodes left unchanged (2026-10-01)

Other pipelines use `tool_slack`, `db_postgres`, `rocketride_sql` and `packages/ai/src/ai/common/database/`, so this branch no longer changes them. Their capture and `defer_connect` changes were saved as a patch outside the repo, the files restored to HEAD, the two new test files removed, and the engine's installed copies restored from the pre-change backup. Only the discord node and the app change.

**What replaced them.**

- **Slack page, read from the escalation.** New opt-in discord field `captureSource` (a label written to each row's `source`, validated, default `discord:<component id>`). The app sets it to `discord:discord_1`, plus `+tool_slack` when the pipe has a Slack tool. The fold marks the first escalation reply in a thread whose rows carry `+tool_slack` as the page and shows **Paged Slack**. That means "a page was triggered": the engine never reports whether Slack got it.
- **Database down at start.** With no `defer_connect`, a db node connects when its pipeline starts. So with Capture To Database on, the app runs `SELECT 1` before Start and Restart, and if it fails it refuses with the fix: "Start it with: docker start rr-discord-pg". On Restart the check runs before anything is stopped.
- **Database down while running** needs nothing new. The discord node already writes off the answering path: a failed write is logged and dropped, and Ralph keeps answering (unit test `test_the_bot_still_answers_when_every_capture_write_raises`, and live below).

**Live tests (Relay, one message at a time, bot started from the app with the new wiring: `captureSource: discord:discord_1+tool_slack`, no capture keys on `tool_slack_1`, `capture_db` controlled only by `discord_1`, no `defer_connect`):**

| Test | Result |
|---|---|
| Container stopped, press Start | Refused: "Could not start the bot: The dashboard database is not reachable (SQL execution failed …). Start it with: docker start rr-discord-pg. Then press Start again, or turn off Settings › Advanced › Capture To Database." The engine reported the bot task as Stopped (state 6). |
| Dashboard closed: question, follow-up, ✅ | 5 rows (seq 317–321), all `discord:discord_1+tool_slack`: message, outbound, follow-up message, outbound, reaction. |
| Escalation ("charged twice … refund") | Reply ended "Escalated to the RocketRide team."; a Slack DM "[Ralph escalation] I was charged twice …" arrived at 00:54:03 PDT; the Conversations detail shows **Paged Slack**. |
| Container stopped while running | Ralph answered "[p1 db-down test]"; engine warning "Discord capture: writing message for message … to capture_db.dd_events failed"; bot still running. |
| Container restarted | The next question and reply were captured (seq 324–325); engine warning "writes to capture_db recovered after 2 failures". The 2 outage rows were not written, by design; the log import can fill them. |

Checks: discord node tests 245 passed / 1 skipped (new cases for `captureSource`: label recorded verbatim, invalid labels fall back, validation table, services.json field); `ruff check` and `ruff format --check` clean; `validate-node-readme.py` PASS for discord and for every node; `validate-client-docs.py` ok; the app's self-tests (replayCopy, rules, db incl. 4 new page-inference cases) report 0 failures; `tsc --noEmit` clean.

## Full engine suite (2026-10-03, L4)

Every current node feature, success and failure, through real pipelines on the
local engine (bundled engine on :5566, with this branch's node copied into its
`nodes/discord` and the engine restarted). Driven by Rocket Relay, one message
at a time, in the support channel only (a private channel; mentions in driver
posts are suppressed). Ralph's bot task was stopped from the dashboard first
(engine state 6) and restarted from the dashboard afterwards.

```bash
DISCORD_LIVE=1 DISCORD_E2E_FULL=1 ROCKETRIDE_URI=http://localhost:5566 \
DISCORD_E2E_PG_CONTAINER=rr-discord-pg DISCORD_E2E_PG_HOST=127.0.0.1:55432 \
DISCORD_E2E_PG_USER=rr_discord DISCORD_E2E_PG_DATABASE=discord_e2e \
DISCORD_E2E_ENGINE_DIR=<engine folder> DISCORD_E2E_ENGINE_LOG=<engine log> \
DISCORD_E2E_RALPH_PIPE=<saved copy of Ralph's pipe> \
  python3 -m pytest nodes/test/discord/live/test_engine_full.py \
  --confcutdir=nodes/test/discord/live -s -v -p no:cacheprovider
```

`--confcutdir` keeps pytest from loading `nodes/test/conftest.py`, which needs
the engine's `ai` package. The engine id block needs `botUserId` (the bot
under test). Results are appended to `.context/e2e-full/<stamp>.jsonl`, and the
fake model's request log to `<stamp>-fake-calls.json`.

**Pipes.** Node behaviour runs on deterministic pipes: `echo` (discord ->
`response_text` keyed `answers`, so the answer is the text the node sent,
including thread context and merged files) and `fake` (discord -> prompt ->
`llm_openai_api` pointed at `fake_llm.py`). Capture writes to an isolated
database (`discord_e2e`), never the dashboard's. F46 runs Ralph's production
pipe once with `tool_slack`, the Slack rule and capture removed.

**Channel without permission.** The bot under test is not a member of the
guild that holds `#test`, so `#test` serves only as the unreadable backfill
channel (F35). Thread refusal (F42) is produced in the support channel by the
driver taking the message's one thread first; a failed post (F43) by deleting
the question while the pipeline runs.

### Result matrix

44 of 44 rows pass. Wall time about 25 minutes for the full file. Rows
F12, F36, F38, F38b, F39, F40, F41b and F44 come from the 2026-10-03 rerun
against the fixed node (N1..N7 below); F04, F20, F35 and F45 from reruns after
test fixes (listed under "Test fixes"); every other row from the first full run.

| ID | Feature | Case | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| F01 | replyMode | channel | plain channel message, no reply reference, outbound destination=channel | answer=<id> reference=None destination=channel | PASS | outbound messageIds=['<id>'] |
| F02 | replyMode | reply | native reply to the question, author not pinged, destination=reply | reference=<id> posted=<id> mentions=[] | PASS | destination=reply |
| F03 | replyMode / thread naming | thread mode, template "Q: {content}", max length 25 (cut on a space) | thread 'Q: [e2e F03] thread name', answer inside, destination=thread | thread='Q: [e2e F03] thread name' answer_in_thread=True destination=thread | PASS | thread <id> |
| F04 | thread naming | attachment-only message (no text) | thread named after the first attachment (notes.md) | thread='notes.md' | PASS | posted <id> |
| F05 | threadAutoArchiveMinutes | 60 (valid) and 61 (invalid) | 60 -> thread archives after 60; 61 -> channel default used, answer still posted | 60 -> duration 60, answered True; 61 -> duration 1440, answered True | PASS | thread.auto_archive_duration read back by the driver |
| F06 | requireMention | global: without and with a bot mention | ignored (no event) without the mention; answered with it | without: posts=0 message_event=False; with: answered=True | PASS | questions <id>, <id> |
| F07 | requireMentionChannelIds | support channel listed: plain, mentioned, thread follow-up without mention | plain ignored; mentioned answered; follow-up in its thread ignored (parent rule applies) | plain posts=0; mentioned answered=True; follow-up posts=0 | PASS | thread <id> |
| F08 | guildIds / channelIds | support channel outside the guild allowlist; outside the channel allowlist | both ignored: no post, no message event | other guild: posts=0 event=False; other channel: posts=0 event=False | PASS | allowlisted case is every other test |
| F09 | ignoreBots / allowedBotIds | driver bot not allowlisted; ignoreBots off; allowlisted | ignored; answered; answered | ignoreBots on, driver not allowlisted: answered=False; ignoreBots off: answered=True; ignoreBots on, driver allowlisted: answered=True | PASS | driver is a bot account |
| F10 | showTyping | on and off around a 6 s pipeline | typing event(s) from the bot when on, none when off; answered both times | showTyping=True: typing events=2, answered=True; showTyping=False: typing events=0, answered=True | PASS | driver on_typing gateway events |
| F11 | sendResponses | off (listen only) | message ingested, nothing posted, outbound destination=suppressed with the answer text | posts=0 message_event=True destination=suppressed | PASS | outbound text='[e2e F11] listen only\n\n' |
| F12 | long answer split / numberChunks | ~5.5k-char answer, numberChunks off then on | chunks <= 2000 chars, whole lines, in order; no labels when off; *(i/n)* labels 1..n when on | off: 3 chunks, max 1995, ordered True, labels 0; on: 3 chunks, max 1982, ordered True, labels ['1/3', '2/3', '3/3'] | PASS | reassembled from the thread; boundaries cut mid-line inside the code fence: off 0, on 0; last chunk ends 'x\n```\n\n*(3/3)*' |
| F13 | allowedMention* | answer containing @everyone, the team role and the driver user; only the driver allowlisted | only the allowlisted user is pinged; @everyone and the role stay inert text | mention_everyone=False role_mentions=[] user_mentions=[driver] | PASS | team role deliberately not allowlisted (it would ping real people) |
| F14 | teamMentionAlias | answer containing the literal alias | alias rewritten to the first allowlisted role mention | answer has role mention=True, literal alias left=False | PASS | answer <id> (fake role id, nobody pinged) |
| F15 | attachments: image, audio, video, text | png + wav + mp4 + .md with text, mergeAttachments off | image/audio/video on their binary lanes; .md framed as text; reply is the text answer only | binary lanes=['image/png', 'audio/wav', 'video/mp4']; md framed=True; reply has file body=False | PASS | 2 text object(s), 3 binary object(s) |
| F16 | mergeAttachments | on: text + .md in one message | ONE text pass containing the question and the file; answer shows both | answer has file body=True; text passes=1 | PASS | answer <id> |
| F17 | textAttachmentExtensions | empty list (default): .md attachment | .md is NOT read as text; it travels as a binary object | answer has file body=False; binary lanes=['text/markdown'] | PASS | answer <id> |
| F18 | maxAttachmentBytes | 1 KB .bin over a 600-byte limit + a small png | oversized file skipped (never opened, not counted); png still routed; text answered | binary lanes=['image/png']; groupSize=[2]; answered=True | PASS | 2 message event(s) |
| F19 | unsupported attachment type | .bin only (application/octet-stream) | routed to the tag stream, no crash, nothing posted, no_reply reason no_answer | binary lanes=['application/octet-stream']; posts=0; no_reply=no_answer | PASS | [e2e F19] attachment-only message <id> |
| F20 | threadHistoryLimit / threadHistoryMaxChars | thread: opening, two follow-ups (limit 2); then a follow-up with an 80-char cap | follow-ups carry earlier turns; only the last 2 messages at limit 2; cap keeps the newest 80 chars behind an ellipsis; SSE text is the user's own words | 1st follow-up saw the opening=True; 2nd follow-up entries=2 saw the opening=False; capped transcript 82 chars, ellipsis=True, contextChars=82 | PASS | transcripts read from the fake model's request log; thread <id> |
| F21 | escalationPause / markers / resume / team reply | escalating answer, silent follow-up, team reply, @mention, plain follow-up | paused after the marker; silent and team replies -> no_reply paused (team text on the event); @mention answered and unpauses | silent=paused posts=0; team=paused text_on_event=True; mention answered=True; after resume answered=True | PASS | thread <id> |
| F22 | escalationPause | pipeline restarted while the thread is escalated | pause rebuilt from thread history: follow-up gets no_reply paused, nothing posted | posts=0 no_reply=paused | PASS | thread <id> |
| F23 | ignoreAimedAtOthers / ackEmoji | message mentioning another user; reply to a non-bot message | acknowledged with the emoji only: nothing posted, no_reply aimed_elsewhere (both) | mention: posts=0 reactions=['👀'] reason=aimed_elsewhere; reply: posts=0 reason=aimed_elsewhere | PASS | question <id> |
| F24 | feedbackReactions / emitReactions | bot adds feedback emoji; driver adds then removes a reaction | bot adds the emoji (not emitted as events); driver add and remove each emit a reaction event | bot reactions=['✅', '❌']; outbound.feedbackEmojis=['✅', '❌']; events before driver=0; add event=True; remove events=1 | PASS | answer <id> |
| F25 | sanitizeReplies | {"type":"final"} envelope, scratchpad, a 429 error as the answer text, empty answer | envelope unwrapped and posted; scratchpad retried then dropped (non_answer); error text dropped (model_error); empty -> no_answer | final: ok (posted unwrapped); scratchpad: ok (calls=2); 429 text: ok (model_error); empty: ok (calls=4) | PASS | fake model; posted envelope answer <id>; error text was "Error code: 429 - {'error': {'"... |
| F26 | nonAnswerRetries | scratchpad first, real answer second; retries 1 then 0 | retries=1: second call answers and is posted (message event retry=1); retries=0: one call, non_answer | retries=1: answered=True calls=2 retry_events=1 no_reply=<no no_reply event>; retries=0: answered=False calls=1 retry_events=0 no_reply=non_answer | PASS | fake model call log |
| F27 | system / empty messages | "started a thread" system notice and an embed-only message (no text, no file) | both ignored: no message event, nothing posted | embed-only message events=0; posts=0; driver message events in window=0 | PASS | driver thread <id> |
| F32 | captureEvents / captureSource / default table | question, answer and a reaction with capture on and no captureTable set | table discord_events created by default; message, outbound, reaction rows with source e2e:full | discord_events exists=t; rows=['message:e2e:full', 'outbound:e2e:full', 'reaction:e2e:full'] | PASS | database discord_e2e |
| F33 | capture dedupe | the same message emitted twice (backfill after a restart) | second message event emitted but not stored again (ON CONFLICT DO NOTHING) | rows before=1; re-emitted events=1; rows after=1 | PASS | message <id> |
| F34 | capture: database down mid-run | container stopped, question, container started, question | answered while down (capture write logged and dropped); next question captured again | answered while down=True; rows for outage question=0; answered after=True; rows after=2 | PASS | log: failed=[] recovered=[] |
| F35 | backfillLimit | limit 2 over the support channel plus a channel the bot cannot read | the 2 newest support messages replayed oldest first; unreadable channel skipped; task keeps running | replayed=['seed1', 'seed2']; running=True | PASS | log: [] |
| F36 | includeMemberMetadata | on, on a bot whose Server Members intent may be off | either runs with member metadata, or fails fast leading with the Server Members intent | logged in=False; names Server Members=True; state=5 | PASS | status='Completed' errors=['Exception*Scanning path failed / : Exception  (ap:0x13) … |
| F37 | config coercion | numbers as strings, a bare-string id, a JSON-text channel list | all honoured: name <= 20, archive 60, driver allowed, channel matched | thread='[e2e F37] numbers as' archive=60 answered=True | PASS | thread <id> |
| F38 | config coercion | allowedBotIds given as broken JSON text | no crash; the driver is not allowed; the task warnings name the setting | running=True; answered=False; warnings naming allowedBotIds=1 | PASS | task warning: ['lowedBotIds is not valid JSON (\'["<id>"\'); it is read as plain text. Fix the setting.… |
| F38b | config coercion | channelIds given as broken JSON text | the start fails with a message naming channelIds (a bot that answers nothing is not left running) | logged in=False; state=5 | PASS | task error='Ride/engine/nodes/discord/IEndpoint.py:548 Message: Discord Bot: channelIds is not valid JSON (\'["<id>"\'); fix the setting*scan.cpp:303' |
| F39 | botToken | missing variable; invalid token | missing: fails naming the unset variable; invalid: "login failed (invalid token)"; engine keeps serving | missing variable: state=5 status='Completed' task error='e/engine/nodes/discord/IEndpoint.py:543 Message: Discord Bot: the bot token variable ROCKETRIDE_DISCORD_E2E_NO_SUCH_TOKEN is not set on this server*scan.cpp:303'; invalid token: state=5 status='Complete… | PASS | engine reachable afterwards=True |
| F40 | pipeline throws | model endpoint returns HTTP 429 on every call | nothing posted (no raw error); no_reply model_error; the next question is answered | replies posted=[]; no_reply after 3s='model_error'; outbound=None; model calls=6; next answered=True | PASS | question <id> |
| F41 | pipeline times out | model takes 90 s; a second question meanwhile | no node-side timeout exists: the slow answer arrives late; the other question is not blocked | quick answered in 4s (True); slow answered=True after 92s; no_reply=<no no_reply event> | PASS | the node has no pipeline timeout setting; the model client timed out or not as shown |
| F41b | pipelineTimeoutSeconds | limit 15 s, model takes 45 s | no_reply timeout after ~15 s; the late answer is dropped, nothing posted | no_reply=timeout after 15s; late answer posted=False | PASS | fake model |
| F42 | thread creation refused | the question already has a thread (created by the driver first) | create_thread fails; the answer is posted as a reply in the channel (destination=reply) | answered in channel=True; destination=reply; posts in the taken thread=0 | PASS | the bot under test is not in the guild that holds #test, so the refusal is produced in the support channel |
| F43 | send failure | question deleted while the pipeline runs (reply target gone) | nothing posted; no_reply reason send_failed | no_reply=send_failed; posts=0 | PASS | question <id> (deleted) |
| F44 | Discord rate limit | ~20k-char answer posted as many chunks in a burst | every chunk lands, whole lines, in order, nothing dropped; discord.py waits out the 429s | chunks=11; all lines in order=True; largest gap=4.94s; span=7.7s | PASS | gaps between chunks=[0.32, 0.34, 0.26, 0.17, 0.29, 4.94, 0.32, 0.24, 0.39, 0.45]; mid-line cuts=0; log lines mentioning rate limit=0 |
| F45 | engine restart mid-thread | engine killed and restarted between turns of a thread; a message posted while it was down | after restart the thread is answered with the full history (incl. the message posted while down); the missed message is not answered on its own | answered=True; history has pre-restart turn=True, missed message=True; missed message answered on its own=False | PASS | thread <id>; port closed after 0s, discord task process gone after 5s |
| F46 | AI path (Ralph pipe, no tool_slack, no capture) | one realistic support question | a sanitized model answer in a thread, with the feedback emoji | answered=True chars=1356 leaked scratchpad/error=False reactions=['✅', '❌'] chunks=1 no_reply= | PASS | first 100 chars: 'You can run a RocketRide pipeline from the Python SDK in just a few steps:\n\n1. **Install the SDK:**\n' |

**Event coverage.** `outbound` destinations seen: `channel` (F01), `reply`
(F02, F42), `thread` (F03), `suppressed` (F11). `no_reply` reasons seen:
`paused` (F21, F22), `aimed_elsewhere` (F23), `model_error` (F25),
`non_answer` (F25, F26), `no_answer` (F19, F25), `send_failed` (F43),
`model_error` for a provider failure that arrives as answer text (F40, after
N1), `timeout` (F41b). The pipeline-error reason (exception text) is not
reachable with these pipes: the LLM layer reports a failure as answer text
rather than raising. `reaction` add and remove (F24),
`message` with `retry: 1` (F26), and `contextChars` (F20).

### Node findings (all fixed 2026-10-03, tests first)

| # | Severity | Found by | Finding | Fix | Verified live |
|---|---|---|---|---|---|
| N1 | high | F40 | With `sanitizeReplies` on, a model failure was posted to Discord: the engine's LLM layer turns the exception into the answer text `**LLM error** — ValueError: An error occurred with the API.`, and no error signature matched it. Same class as the 2026-10-02 incident. | Two signatures: the `**LLM error**` prefix at the start of the answer, and the bare `An error occurred with the API.` sentence when it is the whole answer (prose that mentions API errors is not matched). | F40: nothing posted, `no_reply` `model_error` after 3 s |
| N2 | medium | F12, F44 | Inside a code fence the chunker cut mid-line (every boundary): a code line was split across two messages. | Break at the last newline in the second half of the window; the synthetic close/reopen fence pair stands in for that newline, so the text rebuilds exactly by replacing each `\n``````\n` with `\n`. | F12: 0 of 2 + 0 of 2 cuts; F44: 0 of 10 |
| N3 | low | F12 | A numbered last chunk kept the answer's trailing blank lines before its label. | Strip each piece before the label. | F12: last chunk ends `` ``` `` then `*(3/3)*` |
| N4 | medium | F38 | A list setting with broken JSON (`["123"`) became a literal id and the allowlist rejected everything, with no warning. | A task warning names the setting; broken JSON in `guildIds` or `channelIds` fails the start instead. | F38 warning; F38b start fails naming `channelIds` |
| N5 | low | F39 | An unset token variable reached the node as `${NAME}` and was reported as "login failed (invalid token)". | An unresolved `${NAME}` fails the start: "the bot token variable NAME is not set on this server". | F39 |
| N6 | medium | F41 | No pipeline timeout. | Opt-in `pipelineTimeoutSeconds` (default 0, off): `no_reply` `timeout`, late answer dropped. Each run (question, attachment, retry) gets the full limit. | F41b: `timeout` after 15 s, nothing posted at 45 s |
| N7 | low | F36 | The members-intent failure led with Message Content, which was already on. | With member metadata on: "enable the Server Members Intent ... (the Message Content Intent is required too)". | F36 |

### Observations (not node bugs)

- **Engine shutdown order.** On SIGTERM the engine closes its port at once but
  the discord task process keeps its Gateway session for about 5 s (F45). The
  first F45 run posted a "while down" message inside that window and the old
  process answered it. The test now waits for the task process to exit.
- **Fatal source start reads as `Completed`.** A source that fails at start
  (F36, F39) ends in state 5 with status "Completed"; the node's message is only
  in `errors`, wrapped in "Scanning path failed ... scan.cpp".
- **Node warnings are not in the engine's stdout log** (capture failed /
  recovered); they surface in task status `warnings`. F34 is judged on the
  database rows.
- **Empty completions are retried below the node.** F25's empty answer made 4
  model calls: the LLM layer repeats an empty completion once, and
  `nonAnswerRetries` doubles that.
- **Discord rate limit.** discord.py absorbs the 5-per-5-seconds channel limit
  silently: F44's 11 chunks show one 4.8 s stall after the sixth message and no
  error or retry in the node.

### Test fixes during the run

F04 (an attachment-only `.md` needs `textAttachmentExtensions` to be answered,
else no thread is opened), F12/F44 (judge on the reassembled text; the mid-line
cuts are N2), F20 (moved to the fake pipe: the echo pipe nests earlier answers,
so the history limit could not be isolated), F35 (stop the previous pipe before
posting the seeds, or their answers push a seed out of the backfill window),
F40 (look for any reply to the question, not a tagged one), F45 (wait for the
task process to exit, not just the port).

### Residue

Rocket Relay deleted its own messages (about 100 across both days, all of
them) and archived its two threads. Left behind, because the driver cannot delete or archive another
bot's messages: about 60 node answers in the support channel (including the
three N1 error posts) and about 25 node-created threads, which auto-archive
after 60 minutes (the post-check threads on Ralph's own pipe after 1440). The
isolated `discord_e2e` database was dropped after the run.

