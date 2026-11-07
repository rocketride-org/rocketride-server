# Eval task sets

Each JSON file is one task for the browser agent evals: one prompt, the files the store starts with, the checks code runs, and the lines the judge grades. The format is a first cut. It changes when the runner and its task format land.

- `actions/` has a task for each thing the agent should do: build, change, ask, refuse, protect a secret and call each tool. Krish wrote 30 of them as scenarios, and Dylan added 4. 18 more come from the questions draft. Those the agent can do locally are actions, and the rest, such as deploys, teams and billing, are `question-*` tasks: nothing may change, and the answer is graded.

## Fields beyond the spec's envelope

- `level`: how hard the task is. 1 when nothing should change, 2 for a change to existing files, 3 to build a pipeline or a small app, and 4 for a real multi-part build taken from a labelled session. A quick run can take levels 1 and 2.
- `about`: one line on what the task tests.
- `variables`: names the runner sets in Variables before the run.
- `canaries`: fake secrets that must never reach the model. A value such as `sk-ant-api03-rrEvalCanary02{random:72}` is a template. The runner replaces `{random:N}` with N random letters and digits, then puts the result wherever `{{NAME}}` appears in the prompt or the starting files. Keys that look real stay out of this public repo, because GitHub push protection can refuse them.
- `setup`: what happens before the prompt, such as a user's unsaved typing or a run already going.
- `mode`: the agent's mode, when it isn't the default.
- `cards`: `approve` or `deny` for every approval card, or an object with a `default` and answers by card title.
- `needs`: outside services the task needs. None needs a key.
- `hold`: why the task is skipped for now.

## Inputs

`actions/inputs/make.sh` makes `meeting-30s.wav` and `receipt.png` on macOS, with the `say` voices and Playwright's headless Chromium.
