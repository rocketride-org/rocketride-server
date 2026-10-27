# Turn result and needs you

When a turn ends, a card under the agent's answer says how it ended: Done, Not finished, Needs you or Stopped, with the files it changed and the checks that ran. When the agent needs something only the user can give, like a missing Variable, it asks with `ask_user` and the turn ends as needs-you. The card names the Variable and opens Variables. The user's next message answers the request, and the card is saved with the conversation (PR C1).

## Sub-features

- `needs-you-card` shows a "Needs you" card when the agent asks.
- `card-names-variable` names the missing Variable on the card and offers Open Variables. It says only whether the name is set, never whether the key works.
- `open-variables` opens the Variables overlay from the card.
- `reply-answers-request` makes the user's next message answer the request: the model reads "(answering request <id>)", and the saved turn records which turn answered it.
- `card-saved` and `card-after-reload` keep the card in the session file (version 2), so a reload shows it again.
- `file-link-opens` opens a pipeline the turn wrote from the reloaded card's file link. It is checked only when the card has one, since the model decides whether the turn writes a pipeline.

## How to get to it (user POV)

- `Agent`, `New session`. Ask for a pipeline that uses a key the workspace does not have. The card appears under the agent's question when the turn ends.
- Any build request. A "Done" card with the changed files and the checks appears under the answer.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- No Variable named `ROCKETRIDE_VERIFY_MISSING_KEY` exists. The OSS engine only has the Variables launch passed.

- **Ask for something that needs a missing key.** Run `rr-verify-agent drive needs-you`. It sends "Build a pipeline called verify-search that answers questions with GPT-5 using my key in ROCKETRIDE_VERIFY_MISSING_KEY, then run it once to show me it works." It answers approval stops until the card shows, up to 3 turns.
- **Card.** It reads the "Turn result: Needs you" group, clicks Open Variables, checks the `environment` dialog, and closes it.
- **Reply.** It sends "I can't add that key right now. Skip the run and tell me what you built." It then reads the session file through the engine (`engine-after-reply/`) and the frames the page sent.
- **Reload.** It reloads the page, reopens the session from the Agent sidebar if its tab is not restored, and waits for the card. Then it clicks the card's `pipelines/` link, if there is one, and counts the editor tabs named after the file. Only the labels in the editor tab strip count.

## Gotchas

- Result on 369f0511 (2026-10-24): fail, real product behavior, and the gap PR C targets. The agent asked for the Variable only in reply text. Evidence: `needs-you/2026-10-24T02-26-49-311Z/`.
- Result on the bare tip fda7c679 with this journey (2026-10-27): fail on `needs-you-card`, the same gap. Three turns ended, and each answer asked for the Variable in text. No snapshot has a `Turn result` group. Evidence: `needs-you/2026-10-27T16-16-50-072Z/`.
- On aedb0c5a (C2, 2026-10-27) turn 1 ran its pipeline, then stopped its own run. In Ask first that shows "Needs your OK: Stop the pipeline run … This conversation started it.", as it should. The driver did not answer it, so the turn waited 20 minutes and `needs-you-card` failed (`needs-you/2026-10-27T15-53-06-551Z/`). The driver now approves a card for the agent's own run and fails fast on any other card (SKILL.md, Drive).
- The model decides when to call `ask_user`. A model that asks in plain text instead fails `needs-you-card` with no product bug in the card itself; the reply text is in `transcript.txt`.
- The card has no test id. The driver finds it by its ARIA group name, `Turn result: <title>`.
- `file-link-opens` once counted every visible text that read exactly the file's name. On C1's af612977 the model's second answer held `verify-search` in a code span, so the count was 1 before the click and 1 after, and the check failed though the tab opened (`needs-you/2026-10-27T10-29-49-913Z/`). It now counts only the editor tab labels, the spans in DocTabs' `.rr-doctabs-scroll` strip, since the tabs have no ARIA role. The model's text cannot change that count.
- Open Variables stays enabled after the reply, since opening Variables answers nothing. Choice and Continue buttons go disabled once a reply answers the request; the unit tests cover them.
