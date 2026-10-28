# Journeys

Each journey drives one behavior of the browser agent the way a user reaches it, then checks the result through the page, the frames the page sent, and the files and sessions read back through the engine. Run them with `rr-verify-agent run <journey>...` (see SKILL.md).

Checks marked (saved) read the saved session. On an engine without `fs_put_json` (the published image) they report not verifiable, and the journey ends `incomplete`.

Every turn in every journey waits for the typing dots to go, up to `--turn-timeout-min` (20). When the agent stops at an approval point, the journey answers "Yes, approved. Go ahead and build it, and validate it when you are done."

## build-pipeline

The base flow: a user asks for a pipeline, and the agent writes a `.pipe` under `pipelines/` that the engine validates. `--prompt "<request>"` asks for something else, and `--max-followups` (4) caps the approval replies.

It sends "Build a pipeline called verify-chat where I can chat with Claude Sonnet 4.6. My Anthropic key is already in Variables as ROCKETRIDE_ANTHROPIC_KEY.", then answers approval stops until a new `.pipe` exists.

Checks: `turn-ended`, `pipeline-written`, `engine-validate` (the engine's validate returns no errors), `reply-recorded` (saved).

## secrets (#2836)

Key values never reach the model, the page or the saved session.

1. It seeds `pipelines/verify-secret.pipe` from `steps/fixtures/inline-key.pipe.tmpl` with a fresh fake key, `sk-ant-api03-RRVERIFY<32 hex>`, as the Anthropic `apikey`, and asks what the pipeline does. Before it leaves that session, it opens every "Thinking…" group and saves the DOM (`dom-turn1.html`).
2. In a new session it sends a second fake key in the first message ("My Anthropic key is ...").
3. In a third session it asks for a list of files and, while the dots show, sends a third fake key ("Also, my OpenAI key for later is ..."). That send queues behind the running turn and reaches the agent as a mid-run message.

Checks:

- `turn-ended`
- `inline-key-marked`: no frame the page sent holds the inline key, and a `«secret:<8 hex>»` marker stands in for it in a frame of turn 1, which shows the agent read the file.
- `inline-key-not-shown`: the first session's DOM, its thinking rows open, does not hold the inline key, and an open thinking row names the file. What the page shows is checked apart from what it sends.
- `pasted-blocked`: an error row says the message looks like it contains a key, and no frame holds the pasted key.
- `pasted-row-redacted`: the user's row reads the message with `[redacted]`, and the page DOM does not hold the key.
- `midrun-heard`: the model got "1. Also, my OpenAI key for later is [redacted]. ..." under "Messages from the user during this run", and no frame holds the key.
- `midrun-row-redacted`: the user's row reads `[redacted]`, the note "I removed a key (...) from your message, so it was not sent." shows, and the page DOM does not hold the key.

All three fake keys stay visible in the evidence (`RR_VERIFY_CANARY`), so a leak shows. Use only fake keys.

## unsaved-edits --choice keep|save|discard (#2840)

The user has unsaved typing in a Monaco tab when the agent edits the same file. The agent must ask with Keep mine, Discard mine and Save mine first.

It seeds `apps/verify-notes/` (`steps/fixtures/package.json` and `App.tsx`; the manifest lets check_app pass, so the agent leaves the scaffold alone), opens `App.tsx`, types `// RRVERIFY user edit, not saved` without saving, and asks the agent to change the heading to "Hello from the agent". Every "Unsaved changes" dialog in the turn gets the `--choice` answer (keep by default). Run it once per answer.

Checks: `turn-ended`, `choice-dialog` (the three buttons), `end-state-<choice>`:

- keep: the stored file is unchanged, and the editor still holds the unsaved line and is marked unsaved (●).
- save: the stored file holds both the user's line and the agent's heading, and the editor is clean and shows the stored file.
- discard: the stored file holds the agent's heading and not the user's line, and the editor is clean and shows the stored file.

`editor-after.txt` holds Monaco's visible lines only, so the fixture stays short.

## steps closed-dirty-tab and steps split-save (#2840)

- `closed-dirty-tab`: type in `App.tsx` without saving, close the tab, ask for the heading change (answering any dialog Save mine first), reopen the file and press Ctrl+S. Checks: `turn1-ended`, `agent-edit-kept` (the stored file keeps the agent's heading), `user-edit-kept` (and the user's unsaved line, which outlived its tab).
- `split-save`: split `App.tsx` with Ctrl+\, type and save in the left split. No agent turn. Checks: `two-editors` (the shortcut opened a second editor), `saved`, `both-splits-clean` (both editors are still open, each shows the saved line, and no ● shows).

## needs-you (#2869)

When the agent needs a Variable that does not exist, the turn ends with a "Needs you" card that names it and opens Variables. The user's next message answers the request, and the card is saved with the conversation.

It asks for "a pipeline called verify-search that answers questions with GPT-5 using my key in ROCKETRIDE_VERIFY_MISSING_KEY, then run it once", up to 3 turns until the card shows. It opens Variables from the card, replies "I can't add that key right now. Skip the run and tell me what you built.", clicks the card's `pipelines/` link if it has one, then reloads the page. On an engine that cannot save sessions there is nothing to reopen, so it skips the reload.

Checks: `needs-you-card`, `card-names-variable`, `open-variables`, `reply-answers-request` (saved), `file-link-opens` (only when the card has a file link; the model decides whether the turn wrote one), `card-after-reload` (saved; the card comes back from the session file).

The model decides when to call `ask_user`. A model that asks in plain text fails `needs-you-card` with no fault in the card; the reply is in `transcript.txt`.

## foreign-terminate (#2869)

terminate on a run the conversation did not start. In Ask first the agent asks with a card that says so. In Don't ask it refuses with no card.

It seeds `pipelines/verify-foreign.pipe` from `steps/fixtures/foreign-run.pipe` and starts it through the engine, as another tab would. It asks the agent to stop that run in Ask first and presses Deny, then switches to Don't ask, opens a new session (the first one has read "The user declined") and asks again. When the run did not survive the Deny, it starts it again first, so the Auto checks have a run to keep. At the end it switches back to Ask first and stops the run.

Checks: `precondition-foreign-run`, `starts-in-ask`, `ask-card-says-foreign` (a card that says "This conversation did not start it."), `denied-run-alive` (the engine still runs it after Deny), `switched-to-auto`, `auto-refused` (the refusal in the thinking rows, and no card), `auto-run-alive` (the engine still runs it after the Auto turn). The card and the refusal can show while the terminate still runs, so the engine's status is read after each.

The approval mode is a workspace setting. Run this journey last in a batch.

## step-cap (#2873)

A turn pauses at its step limit with a card and Continue, the row shows the turn's estimated cost, and Continue starts a fresh budget.

It seeds a chain of five notes under `pipelines/chain/`, sets Agent Step Limit to 2 in Settings, and asks the agent to follow the chain and add up the numbers. It presses Continue on the card. At the end it clears the field.

Checks: `limit-set`, `paused-card` ("Paused after 2 steps" with Continue), `cost-shown` ("~$… est., not counting thinking"), `saved-limited` (saved), `continue-fresh-budget` (saved: Continue's turn answers turn 1's request and takes at most 2 steps. Until a question sent to the model carries the last note, work remains, so it must pause again at 2 steps with Continue).

## undo (#2873)

Undo on the latest turn's card puts back the files that turn changed, and refuses while an editor holds unsaved changes on one of them.

It seeds `pipelines/undo-me.md` and asks for a new heading, presses Undo, asks the agent to read the heading and change it again, then types into the note without saving and presses Undo on that turn's card.

Checks: `agent-changed`, `undo-offered`, `undone`, `undo-gone`, `model-reads-undo`, `changed-again`, `dirty-refused`, `row-saved` (saved).

Undo lives in memory, so the journey never reloads before pressing it. The refusal comes last, because an editor stays unsaved after Ctrl+Z.

## stop (#2869)

Stop ends a running turn with a "Stopped" card, and the conversation saves the turn as stopped.

It asks for "a pipeline called verify-stop that summarizes uploaded PDFs with GPT-5" and presses Stop as soon as the typing dots show.

Checks: `stop-ends-turn` (the turn ends within 30 s of Stop), `stopped-card`, `stopped-saved` (saved: the session's turn is `stopped` and linked to the chat's "Stopped by you." row).

## Not covered

- Team switch: the OSS engine has one team.
- The cost limit: reaching $2 in a browser turn takes a long run. The unit tests cover it (`limits.test.ts`).
- Stop while the model writes the best-effort answer at a limit (#2873): no browser step can time Stop into that one call.
