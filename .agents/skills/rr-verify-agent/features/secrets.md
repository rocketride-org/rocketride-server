# Secrets stay out of the model

Key values in workspace files, run errors and pipeline output must never reach the model. The agent works with placeholders or markers instead, and the user's real values stay where they are. PR B1 does this in the browser for key-shaped values. PR B2 does it on the engine for exact Variable values.

## Sub-features

- `inline-key-read` covers a `.pipe` with a key pasted inline (not `${ROCKETRIDE_*}`). Asking about it never sends the key toward the model.
- `inline-key-edit` covers editing that `.pipe` through the agent. It keeps the user's real key in the file (marker round trip, PR B1).
- `pasted-key` covers a key the user pastes into the chat. The message is blocked before the model: the chat shows an error row telling the user to put the key in Variables, and the saved session, title and catalog hold `[redacted]` (PR B1).
- `midrun-key` covers a key the user sends while a turn runs. The send queues, the running turn takes it as a mid-run message, and the model gets the message with `[redacted]` in place of the key (PR B1, after the rebase onto Dylan's queue and steer work).
- `variable-value` covers an exact Variable value appearing in a run error or output. It never reaches the model (PR B2, engine side).

## How to get to it (user POV)

- A `.pipe` with an inline key exists in the workspace. In `Agent`, `New session`, ask what the pipeline does or ask for a change to it.
- Paste a key into the composer while asking for a pipeline.
- Send a message with a key while the agent is still working on a request.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- The journey makes a fresh fake key per run, `sk-ant-api03-RRVERIFY<32 hex>`, and seeds `pipelines/verify-secret.pipe` from `steps/fixtures/inline-key.pipe.tmpl` with it as the Anthropic `apikey`.

- **Ask about the pipeline.** Run `rr-verify-agent drive secrets`. It sends "What does pipelines/verify-secret.pipe do? Walk through each node and how it is configured." and waits for the turn to end. It then opens every "Thinking…" group, so the thinking rows are in the DOM, and saves the DOM as `dom-turn1.html`.
- **Paste a key.** In a new session it sends "My Anthropic key is <second fake key>. Keep it in mind for later; there is nothing else to do now." as the first message, so it also names the session.
- **Send a key mid-run.** In a third session it sends "List the files in pipelines/ and say in one line what each one is for." As soon as the typing dots show, it sends "Also, my OpenAI key for later is <third fake key>. Nothing to do with it now." The send queues behind the running turn.
- **Proof.** Each check is in `result.json`:
  - `sessions-saved`: 3 session files and the catalog exist in the engine snapshot. The stored checks below read them, so without this check they would pass on nothing. On a failure it quotes the console's save error. On an engine without `fs_put_json` (the published image) it and the four stored checks below (`canary-not-in-session`, `canary-not-in-catalog`, `pasted-not-stored`, `midrun-not-stored`) are not verifiable, and the journey is at best `incomplete`. Use `--engine source`.
  - `canary-not-sent`: no WebSocket frame the page sent (`ws-sent.jsonl`) holds the inline key. A hit lists the frame numbers.
  - `marker-sent`: a frame the page sent in turn 1 holds a `«secret:<8 hex>»` marker, raw or JSON-escaped, where the key was.
  - `canary-not-in-dom`: the page DOM after turn 1, thinking groups open.
  - `canary-not-in-thinking`: the opened thinking rows, and the thinking rows in the saved sessions.
  - `canary-not-in-session` and `canary-not-in-catalog`: every session file and the catalog, read back through the engine.
  - `pasted-not-sent`: no frame holds the pasted key.
  - `pasted-blocked`: an error row says the message looks like it contains a key.
  - `pasted-not-stored`: no session file and no catalog row holds the pasted key.
  - `midrun-not-sent`: no frame holds the mid-run key, and the send happened while the turn ran.
  - `midrun-heard`: a frame holds `1. Also, my OpenAI key for later is [redacted]. Nothing to do with it now.`, the message as the loop lists it under "Messages from the user during this run". It fails when the message opened its own turn instead, because then the mid-run path did not run.
  - `midrun-not-stored`: no session file and no catalog row holds the mid-run key.
  - Diagnostic only: whether `pipelines/verify-secret.pipe` still holds the inline key afterwards (the user's value stays in the file).
  All three fake keys stay visible in the evidence on purpose (`RR_VERIFY_CANARY` takes them comma-separated), while real key shapes are blanked.

## Gotchas

- Result on the bare tip fda7c679 (2026-10-27), source engine (`fs_put_json` present): fail, 10 of 14, all for B1's missing behavior. `sessions-saved` passes: 3 session files and the catalog were saved. The fake key left the page in #77, #79 and #109 with no marker, the pasted key was not blocked (#90, #93), and the mid-run key left the page raw (#106, #109, #111). With sessions saved, the stored checks now see the leaks: `canary-not-in-session`, `pasted-not-stored` and `midrun-not-stored` fail because the keys are in saved session files. On the image those three passed on nothing. `canary-not-in-thinking` and `canary-not-in-catalog` pass. Evidence: `secrets/2026-10-27T06-04-25-152Z/`.
- Results on c560a80e (2026-10-25, Dylan's tip after the feat/appdev-cloud merge), with the 14 checks above. No session saves on this base with the published engine image: commit 9bd5d931 made `fsWriteJson` send `fs_put_json`, which only the branch's engine has, and the console logs `session save failed Error: Unknown subcommand: fs_put_json`. So `sessions-saved` fails on both runs, and the three stored checks pass on nothing.
  - PR B1 rebased (b01c3a12): 13 of 14 pass, all but `sessions-saved`. The marker went out in frames #76 and #79, and the mid-run message reached the model with its key replaced in #94 and #97. Evidence: `secrets/2026-10-25T05-41-12-862Z/`.
  - Bare tip c560a80e: 7 of 14 fail: `sessions-saved`, `canary-not-sent` (#76, #101), `marker-sent`, `pasted-not-sent` (#86, #88), `pasted-blocked`, `midrun-not-sent` (#98 and #101, the plan questions' list of mid-run messages; #103, a session save) and `midrun-heard`. Evidence: `secrets/2026-10-25T05-43-20-812Z/`.
- The mid-run key also stays visible in the user's own bubble, like the pasted key.
- Driver changes for c560a80e: part 3 and its three checks, and `sessions-saved`. No check was loosened. Nothing else in the shell's new Stop button, queued sends or ChoiceDialog needed a driver change for this journey.
- Result on 8bd0122f (2026-10-24, the PR B1 base), with the checks above: fail on `canary-not-sent` (frame #71, the `read_file` summary in the model question), `marker-sent`, `pasted-not-sent` (frame #96, the pasted key as the question's goal; #99, the session write), `pasted-blocked` and `pasted-not-stored`. Evidence: `secrets/2026-10-24T23-09-28-274Z/`. The run at `2026-10-24T23-07-36-122Z` is superseded: its engine snapshot blanked the pasted key, so `pasted-not-stored` passed falsely.
- Result on the PR B1 branch (feat/rocket-agent-secrets, uncommitted on 8bd0122f): pass, every check. The marker went out in frames #71 and #74. Evidence: `secrets/2026-10-24T23-31-42-435Z/`.
- The pasted key stays visible in the user's own chat bubble until the session is reloaded: the chat hook appends the user row before the agent sees it. The journey does not check the DOM for the pasted key for that reason; the stored row is checked instead.
- Result on 369f0511 (2026-10-24, the first checks: frames only): fail, real product behavior, and the bug PR B1 targets. The agent read `verify-secret.pipe`. The fake key left the page in frame #71, an `rrext_process` write to the stand-in pipeline (the model question). It sat inside the `read_file` result summary as `apikey: "sk-ant-api03-RRVERIFY..."`. It was not in the saved session. Evidence: `secrets/2026-10-24T02-22-01-969Z/`.
- No driver problems on this journey.
- The page's frames are the model boundary only for the browser side (PR B1). PR B2 scrubs on the engine after the frame arrives (`on_rrext_process`, cmd_data.py:94), so the page still sends the raw text, and this journey cannot prove B2. B2 needs an engine-side observation, for example a test model node that records the question it received, plus an engine built from the B2 branch, not the published image.
- `variable-value` needs a Variable holding a fake value. On the OSS image, Variables come from the container's environment (`ROCKETRIDE_*`). Add a fake one at launch when B2 lands.
- Use only fake keys. Never seed a real key to test this.
