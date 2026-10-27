# Unsaved edits while the agent edits

A user has typed into a file without saving, and the agent wants to change the same file. The user's unsaved work must not be lost. After PR A, the agent stops and asks with three choices (Save mine first, Discard mine, Keep mine) instead of writing behind the editor or silently refusing.

## Sub-features

- `dirty-monaco` covers unsaved typing in a code editor tab (Monaco), for example an app source file.
- `dirty-canvas` covers unsaved changes on the pipeline canvas for a `.pipe` file.
- `choice-save` saves the user's text first, then the agent edits on top of it.
- `choice-discard` drops the user's text, then the agent edits the stored file.
- `choice-keep` keeps the user's text, and the agent does not write.
- `no-silent-split` checks that the stored file and the editor never end up holding different versions without the user knowing.
- `closed-dirty-tab` covers unsaved typing in a tab the user then closed. Monaco keeps the text, so the file is still unsaved: the agent must ask, and the reopened tab must not save the old text over a change made meanwhile. Driven by `steps/closed-dirty-tab.json`.
- `split-save` covers two splits of one file: a save in one must leave the other clean, so the agent does not ask about changes already saved. Driven by `steps/split-save.json`.

## How to get to it (user POV)

- `Explorer` rail tab, open `apps/<app>/src/<file>`, type without saving, then `Agent`, `New session`, and ask for a change to that file.
- `Pipelines` or `Explorer`, open a `.pipe` on the canvas, change a node without saving, then ask the agent to change that pipeline.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- The journey seeds `apps/verify-notes/src/App.tsx` (from `steps/fixtures/App.tsx`) through the engine.

- **Open the file.** Run `rr-verify-agent drive unsaved-edits`. It opens `Explorer`, clicks `apps`, `verify-notes`, `src`, `App.tsx`, and waits for the Monaco editor.
- **Type without saving.** It clicks into the editor, presses Control+End and types `// RRVERIFY user edit, not saved`. `user-typed-unsaved.png` shows the dirty tab.
- **Ask the agent.** In a new session it sends: "Change the heading in apps/verify-notes/src/App.tsx to say "Hello from the agent". Keep everything else as it is."
- **Answer the prompt (after PR A).** Run it once per answer: `rr-verify-agent drive unsaved-edits --choice keep`, then `--choice save`, then `--choice discard` (`keep` is the default). Every "Unsaved changes" dialog during the turn gets the same answer, so an agent that asks again after Keep mine cannot leave the turn waiting. Each dialog is saved as `choice-dialog-<n>.png`, and its text and button names go in `steps.log` and `result.json`.
- **Proof.** `stored-after.txt` holds the file read through the engine after the turn, and `editor-after.txt` holds the editor's visible lines. `result.json` has five checks, and all of them must pass:
  - `turn-ended`: the turn ended on its own.
  - `user-asked-or-merged` (unchanged from the first version): the agent asked, or left the stored file unchanged, or both edits survived without a split. It fails when the store holds the agent's change while the editor still holds the unsaved line. That is the silent split, and the next save loses one side.
  - `choice-dialog`: an "Unsaved changes" dialog appeared with the buttons `Keep mine`, `Discard mine` and `Save mine first`.
  - `no-silent-split`: the silent split above, checked on its own, so a dialog cannot hide a split that follows it.
  - `end-state-<choice>`: what the answer must leave behind. Text is compared with whitespace collapsed, because Monaco shows tabs as spaces.
    - keep: the stored file is unchanged, and the editor still holds the unsaved line and is marked unsaved (●).
    - save: the stored file holds both the user's line and "Hello from the agent", and the editor is clean and shows the stored file.
    - discard: the stored file holds "Hello from the agent" and not the user's line, and the editor is clean and shows the stored file.

## Gotchas

- Result on the bare tip fda7c679 (2026-10-27), source engine, with the fixture manifest: `closed-dirty-tab` fails only `agent-edit-kept`, which is A1's missing behavior. No dialog appeared. The agent read App.tsx, made one `edit_file` and ran check_app, which said "CHECK PASSED: local.verify-notes" (types and build not run, because no editor or preview was open). The turn took 21 s and the agent left the scaffold alone. Then the reopened tab's Ctrl+S stored the old text, with the user's line, over the agent's heading. Evidence: `steps-closed-dirty-tab/2026-10-27T06-05-25-367Z/`.
- Results with PR A round 3 (worktree a-file-safety on 8bd0122f, 2026-10-25), one launch: all pass.
  - unsaved-edits keep 25 s, save 224 s, discard 129 s; one dialog each. Evidence: `unsaved-edits/2026-10-25T04-08-31-623Z/`, `.../2026-10-25T04-09-07-722Z/`, `.../2026-10-25T04-13-02-581Z/`.
  - closed-dirty-tab: one dialog about the closed tab's text, answered Save mine first; both lines stored; the reopened tab clean. Evidence: `.../steps-closed-dirty-tab/2026-10-25T04-15-23-094Z/`.
  - split-save: both splits clean after the save; no dialog; both edits stored. Evidence: `.../steps-split-save/2026-10-25T04-21-36-392Z/`.
- Results with PR A round 2 for the two steps files: both fail. closed-dirty-tab: no dialog, the reopened tab showed the old text as unsaved, and Ctrl+S stored it over the agent's heading (`.../steps-closed-dirty-tab/2026-10-25T03-42-22-391Z/`). split-save: the other split showed "changed outside this editor" and ●, and the agent asked about the saved change (`.../steps-split-save/2026-10-25T03-46-39-225Z/`).
- `press` keys are case-sensitive: `Control+S` sends a capital S, which neither the Monaco tab nor the shell treats as save. Use `Control+s`.
- The split menu item ("Split Right") did not take a Playwright click; Ctrl+\ on the focused tab splits it.
- Results with PR A (worktree a-file-safety on 8bd0122f, 2026-10-25): pass for all three answers, one dialog each.
  - keep: the stored file is unchanged, and the editor keeps the unsaved line (●). The agent asks the user how to proceed. Turn: 24 s. Evidence: `unsaved-edits/2026-10-25T00-38-46-933Z/`.
  - save: the stored file has the user's line and "Hello from the agent", and the editor is clean. Turn: 309 s. Evidence: `.../unsaved-edits/2026-10-25T00-39-22-612Z/`.
  - discard: the stored file has "Hello from the agent" and not the user's line, and the editor is clean. Turn: 173 s. Evidence: `.../unsaved-edits/2026-10-25T00-44-42-725Z/`.
- Result on 8bd0122f before PR A (2026-10-24): fail, the same as on 369f0511. No dialog; the agent wrote the stored file behind the dirty tab. That run used the driver before the checks above were added, so its `result.json` has only `turn-ended` and `user-asked-or-merged`. Evidence: `unsaved-edits/2026-10-24T23-02-36-576Z/`.
- Until 2026-10-27 the fixture app had no package.json, so check_app failed on its manifest. After a change to App.tsx the agent rebuilt the app's scaffold before it could finish, which was most of the save and discard turn time. Once (A1 round 6) it rewrote the app folder and deleted the saved line, failing `closed-dirty-tab` for a reason unrelated to the save race. `unsaved-edits`, `closed-dirty-tab` and `split-save` now seed `apps/verify-notes/package.json` from `steps/fixtures/package.json`, a manifest with an id and a name, so check_app's manifest step passes.
- Result on 369f0511 (2026-10-24): fail, real product behavior, and the bug PR A targets.
  - No prompt appeared. The agent wrote "Hello from the agent" into the stored file and reported success with "The app check passed".
  - The editor still held the user's unsaved line on top of the old heading. Its header read "apps/verify-notes/src/App.tsx changed outside this editor — saving overwrites ●".
  - So the next save drops the agent's change, and a reload drops the user's.
  - The agent could not see the unsaved typing because the Monaco tab does not report it to the agent's view of the files.
  - Evidence: `unsaved-edits/2026-10-24T02-22-23-196Z/`.
- Driver problems found and fixed on the way:
  - The first `Explorer` click after load was swallowed, so the journey now clicks until the tab is selected.
  - The tree rows have no role, so text matches are scoped to the side panel (`role="tabpanel"`). `role="treeitem"` with a path label would still be better.
  - Monaco renders spaces as non-breaking spaces. Compared raw, the user's line looked "gone" when it was still there. The text is normalized now.
  - The editor header spans sibling elements, so the journey reads the whole row.
- `editor-after.txt` reads Monaco's visible lines only. Keep the fixture short so the whole file is on screen.
- `dirty-canvas` is not scripted yet. A canvas change needs a node edit through the canvas UI. Use `rr-verify-agent drive steps` and record what you did.
- The timing variant of the bug (the user saves in the gap between the agent's check and its write) cannot be hit reliably from a browser. The generated-input test in PR A covers it. This journey proves the fix is wired into the real editors.
