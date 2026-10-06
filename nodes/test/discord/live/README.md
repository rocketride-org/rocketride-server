# Live Discord node tests

Tests for `nodes/src/nodes/discord` against a real Discord server. They catch what
the unit suite cannot: what Discord actually accepts and reports back, and whether
the gates hold on real Gateway objects. They post real messages, so every layer
is off unless `DISCORD_LIVE=1` is set; a normal run collects and skips them.

## Layers

| Layer | File | What is real | What is stubbed |
|---|---|---|---|
| L1 live I/O | `test_live_io.py` (D01..D19; backfill is in F35) | Discord, the node | engine and pipeline |
| L2 replay | `test_replay.py` (R01..R10) | Discord, the node | engine and pipeline |
| L3 engine e2e | `test_engine_e2e.py` (E01..E04) | Discord, the node, the engine, a real model | nothing |
| L4 full engine suite | `test_engine_full.py` | Discord, the node, the engine | the model (`fake_llm.py`) or none (`echo` pipe) |

- **L1** drives `_on_message` (gating) and `_process_message` directly on a real
  bot connection: reply modes, mention and channel gating, outbound mentions,
  attachments, metadata, chunking, events, typing, fatal startup paths, and the
  support behaviours: thread history as context (D16), the escalation pause
  (D17), acknowledging a message aimed at someone else (D18) and feedback
  reactions (D19).
- **L2** posts the ten made-up questions in `replay_seeds.md` and checks the
  plumbing: one correlated text object in, one reply out.
- **L3** has a real engine spawn the node from `engine_min.pipe`; a second bot
  (the driver) posts questions and reads back what the node posted.
- **L4** walks every feature, success and failure, through real pipelines on
  the engine, driven by the same driver bot. The support behaviour cases are:

  | Case | Feature |
  |---|---|
  | F14 | `teamMentionAlias` rewritten to the first allowlisted role |
  | F20 | `threadHistoryLimit` / `threadHistoryMaxChars` |
  | F21, F22 | `escalationPause`: pause, team reply on `no_reply`, resume on mention, pause rebuilt after a restart |
  | F23, F23b | `ignoreAimedAtOthers` / `ackEmoji`; a reply to the bot is still answered |
  | F24 | `feedbackReactions` with `emitReactions` |
  | F25 | `sanitizeReplies`: envelope, scratchpad, error text, empty answer |
  | F26 | `nonAnswerRetries` |
  | F35 | `backfillLimit` with an unreadable channel |
  | F40 | the model endpoint rejecting every call |
  | F41b | `pipelineTimeoutSeconds` |
  | F45 | engine restarted mid-thread (needs `DISCORD_E2E_ENGINE_DIR`) |
  | F46 | one realistic AI run on a saved pipe (needs `DISCORD_E2E_AI_PIPE`) |

## How to run

```bash
# offline: everything here is collected and skipped
python3 -m pytest nodes/test/discord -q

# L1 + L2
DISCORD_LIVE=1 DISCORD_LIVE_TOKEN_FILE=<token file> DISCORD_LIVE_IDS_FILE=<ids file> \
  python3 -m pytest nodes/test/discord/live -v -s -p no:cacheprovider

# L3, against an engine that has the node and the ROCKETRIDE_DISCORD_* variables
DISCORD_LIVE=1 DISCORD_LIVE_IDS_FILE=<ids file> ROCKETRIDE_URI=<engine uri> \
  python3 -m pytest nodes/test/discord/live/test_engine_e2e.py -v -s -p no:cacheprovider

# L4 (long; restarts the task many times)
DISCORD_LIVE=1 DISCORD_E2E_FULL=1 DISCORD_LIVE_IDS_FILE=<ids file> ROCKETRIDE_URI=<engine uri> \
  python3 -m pytest nodes/test/discord/live/test_engine_full.py \
  --confcutdir=nodes/test/discord/live -v -s -p no:cacheprovider
```

`--confcutdir` keeps pytest from loading `nodes/test/conftest.py`, which needs the
engine's `ai` package. Requirements: Python 3.10+ with `discord.py` installed, and
the `rocketride` SDK for L3 and L4.

## Configuration

All values come from the environment or from files the environment names. No
path, id or token is stored in the repo.

| Variable | Used by | What it is |
|---|---|---|
| `DISCORD_LIVE` | all | `1` to run anything here |
| `DISCORD_LIVE_TOKEN_FILE` | L1, L2 | JSON file whose `token` key holds the token of the bot under test |
| `DISCORD_LIVE_IDS_FILE` | all | JSON file with the id map below |
| `DISCORD_LIVE_<KEY>` | L1, L2 | overrides one top-level key of the id map, e.g. `DISCORD_LIVE_GUILDID` |
| `ROCKETRIDE_URI` | L3, L4 | engine to run the pipes on |
| `DISCORD_E2E_<KEY>` | L3, L4 | overrides one key of the id map's `engine` block, e.g. `DISCORD_E2E_SUPPORTCHANNELID` |
| `DISCORD_E2E_FULL` | L4 | `1` to run the full suite |
| `DISCORD_E2E_ENGINE_LOG` | L4, optional | engine log file, grepped for evidence |
| `DISCORD_E2E_ENGINE_DIR` | L4, optional | engine install directory; F45 kills and restarts the engine from it |
| `DISCORD_E2E_AI_PIPE` | L4, optional | a saved AI pipe with a discord source, for F46; Slack tool and database components are removed before it runs |
| `DISCORD_E2E_RESULTS_DIR` | L4, optional | where result rows are written (default: system temp directory) |
| `DISCORD_LIVE_RESULTS_DIR` | L2, optional | where replay verdicts are written (default: system temp directory) |

Id map (empty strings mean "not provided"; the harness discovers what it can and
skips the rest with a reason):

```json
{
  "guildId": "<guild id>",
  "primaryChannelId": "<channel id>",
  "guestChannelId": "<second channel id>",
  "botUserId": "<bot under test user id>",
  "teamRoleId": "<optional: a plain role for mention tests>",
  "humanUserId": "<optional: a human member>",
  "noPermissionChannelId": "<optional: a channel the bot cannot use>",
  "engine": {
    "engineUri": "<engine uri>",
    "engineApiKey": "<engine api key>",
    "guildId": "<guild id>",
    "supportChannelId": "<channel the driver posts in>",
    "teamRoleId": "<role id>",
    "driverBotId": "<driver bot user id>",
    "botUserId": "<bot under test user id, needed by L4>",
    "driverTokenEnvFile": "<env-style file holding the driver bot token>",
    "driverTokenEnvKey": "<key of the driver token in that file>"
  }
}
```

In L3 and L4 the harness never holds the token of the bot under test: the engine
resolves `${ROCKETRIDE_*}` in the pipes from its own environment.

### Engine variables

L3 and L4 need these variables set on the engine (not in the harness's
environment):

| Variable | Used by | What it is |
|---|---|---|
| `ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN` | L3, L4 | token of the bot under test |
| `ROCKETRIDE_DISCORD_GUILD_ID` | L3, L4 | the test server's id (the id map's `engine.guildId`) |
| `ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID` | L3, L4 | the channel the driver posts in (the id map's `engine.supportChannelId`) |
| `ROCKETRIDE_DISCORD_TEAM_ROLE_ID` | L3 | a role the answers may mention (`allowedMentionRoleIds` in `engine_min.pipe`) |
| `ROCKETRIDE_OPENAI_KEY` | L3 | OpenAI key for the model in `engine_min.pipe` |

`ROCKETRIDE_DISCORD_E2E_NO_SUCH_TOKEN` must stay unset: L4 uses it to check
that an unset variable in the token fails the start with a message naming it.

## Residue policy

- Every harness post is prefixed `[LIVE-TEST <id>]` (L1, L2) or `[e2e <id>]` (L3,
  L4), posts are throttled, and mentions in harness posts are suppressed.
- At session end L1 and L2 delete every plain message the bot posted in the two
  channels and in the threads the run created. Threads cannot be deleted without
  Manage Threads, so they are archived and printed as residue.
- In L3 and L4 the driver deletes only its own messages; the node's answers and
  threads stay (the driver cannot delete another bot's posts) and are printed as
  residue. Use a private channel for these layers.
- `noPermissionChannelId` is never posted to; D01 only reads its permission bits.

## What these tests do not cover

- Slash commands, context-menu commands, and message edits or deletes (the node
  handles `MESSAGE_CREATE` only).
- Grading answer content: L2 checks plumbing only, and L3 checks a few fixed
  expectations of a real model.
- Event capture ships in a follow-up change and is not exercised here.
