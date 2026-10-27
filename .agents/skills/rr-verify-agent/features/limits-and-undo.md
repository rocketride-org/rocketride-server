# Step limit, cost estimate and Undo

A turn has a step limit (Agent Step Limit in Settings, 60 by default, 0 for none) and a cost limit (Agent Cost Limit, $2 by default). At either limit the turn pauses with a card, "Paused after 60 steps" or "Paused at the cost limit of $2.00", and a Continue button that starts a new turn with a fresh budget. Each turn's row shows its estimated cost ("~$0.42 est."). The latest turn's card has Undo, which puts back the files that turn changed. It refuses, naming the file, while an editor holds unsaved changes on one of them, and it leaves a note row that the model reads in the next turn (PR C2).

## Sub-features

- `limit-set`: the Agent Step Limit field in Settings takes 2.
- `paused-card`: a turn that needs more than 2 steps ends with a "Paused after 2 steps" card and Continue.
- `cost-shown`: a bot row's meta line reads "~$… est." (or "<$0.01 est.").
- `saved-limited`: the saved turn says `needs_input`, reason `limited`, 2 waves, a `continue` request and an estimated cost.
- `continue-fresh-budget`: Continue starts a second turn that takes steps of its own and answers the request ("(answering request <id>)" reaches the model).
- `agent-changed` and `undo-offered`: the agent changes a note, and the "Done" card has an enabled Undo.
- `undone` and `undo-gone`: Undo puts the note back as it was, says so in a row, and the card has no Undo after.
- `model-reads-undo` and `changed-again`: the next turn's frames carry the Undo row, and the agent changes the note again, with Undo on that turn's card.
- `dirty-refused`: with the note typed into in an editor, Undo says "Undo refused, nothing was changed: … has unsaved changes in an editor." and the note keeps the agent's second change.
- `row-saved`: the saved session keeps the Undo row.

## How to get to it (user POV)

- The sidebar footer's menu, Settings, search "Step Limit" or "Cost Limit", change the field, then Save. The page keeps a draft until Save.
- The card under the agent's answer: Continue on a paused turn, Undo on the latest turn.
- The meta line under the agent's answer shows the estimate.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0, on `--engine source`: the checks that read saved sessions need `fs_put_json`.
- The engine has `ROCKETRIDE_ANTHROPIC_KEY`. The stand-in's model has a price, so the estimate is in dollars.

- **`step-cap`.** It seeds a chain of five notes under `pipelines/chain/`, each naming the next, and sets Agent Step Limit to 2 in Settings, with Save. It asks the agent to follow the chain and add up the numbers. It reads the card and the meta line, then the saved turn. It presses Continue and reads the second turn and the frames sent. At the end it clears the field, so the limit is back to its default.
- **`undo`.** It seeds `pipelines/undo-me.md` and asks the agent to change its heading. It presses Undo and reads the row and the stored note. It asks the agent to read the heading and change it again, and reads the frames sent. Then it opens the note from the Explorer, types without saving, brings the conversation back from the Agent sidebar, presses Undo, and reads the row and the stored note. Last, it reads the saved session.

## Gotchas

- The engine reader writes only under `pipelines/`, `apps/` and `nodes/`. A note under `pipelines/` needs no check, so the turn ends "Done" without check_app.
- A chain keeps the model from finishing in two steps. A model that reads every note in one wave still needs a third step to answer.
- Undo is in memory only. A reload or a team switch ends it, and the journey never reloads before pressing it.
- The refusal comes last. A text editor stays unsaved after Ctrl+Z, and closing its tab keeps the unsaved text, so the journey cannot make the note clean again without saving it.
- The cost limit has no journey. Reaching $2 in a browser turn takes a long run, and a tiny limit would pause before the first request. The unit tests cover it (`limits.test.ts`).
