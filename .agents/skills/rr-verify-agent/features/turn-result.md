# Turn result and needs you

When a turn ends, the chat says how it ended, and not only through the model's own words. Possible endings are done, not finished, or needs you, along with which files changed and which checks passed. When the agent needs something only the user can give, like a missing Variable, the turn ends as "needs you" and names it (PR C).

## Sub-features

- `result-done` shows a result row with "Done", the files changed, and the check that passed.
- `result-not-finished` shows "Not finished" with the failing check when a check failed, even if the reply says it is done.
- `needs-you-variable` shows "Needs you" and names the missing Variable.
- `needs-you-continue` lets the user set the Variable and send "continue", and the next turn finishes.

## How to get to it (user POV)

- `Agent`, `New session`. Ask for a pipeline that uses a key the workspace does not have, then read the row that appears when the turn ends.
- Any build request. The result row appears above the reply when the turn ends.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- No Variable named `ROCKETRIDE_VERIFY_MISSING_KEY` exists. The OSS engine only has the Variables launch passed.

- **Ask for something that needs a missing key.** Run `rr-verify-agent drive needs-you`. It sends "Build a pipeline called verify-search that answers questions with GPT-5 using my key in ROCKETRIDE_VERIFY_MISSING_KEY, then run it once to show me it works." It answers approval stops, up to 3 turns in total.
- **Proof.** `result.json` passes `needs-you-shown` when a row starting with "Needs you" is visible after the turn. The final reply goes in `result.json` (`finalReply`) for comparison.
- **Done row.** After PR C, add a steps file that runs a build and checks `expectText` "Done" and "validate passed".

## Gotchas

- Result on 369f0511 (2026-10-24): fail, real product behavior, and the gap PR C targets.
  - The agent built and validated `verify-search.pipe` and tried to run it. It quoted the engine's refusal: no variable named `ROCKETRIDE_VERIFY_MISSING_KEY`.
  - It asked the user to add the Variable, but only in reply text.
  - No row or structured outcome said "needs you", and each "approved" follow-up just retried the run.
  - Evidence: `needs-you/2026-10-24T02-26-49-311Z/`.
- The journey sends the approval reply while no "Needs you" row is visible, so today it runs all 3 turns even though the agent asked for a Variable. After PR C, the row should appear on turn 1 and the loop stops there.
- PR C starts with a one-line status row (decision pending with Krish), drawn like the thinking lines. The journey finds it by text ("Needs you"). If the card version lands later, switch to its handle.
- Status rows have no ARIA role or test id. `data-testid="chat-status"` with `data-sse-type` would make this journey robust.
- "Open Variables" as a button exists only in the card version.
