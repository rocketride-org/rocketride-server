# Eval run, 2026-10-27: browser and VS Code surfaces

Branch `feat/verification-e2e-tests`, the same engine build as the headless run (`ada02aec`), with the UIs (`ui:build`), the docs site (`docs:build`), and the VS Code extension (`vscode:build`) built in each eval checkout before the run. `prepare` rebuilds the UIs for every case and the docs site and the extension only when a case needs them. 13 new cases (4 planted bugs, 2 replayed real bugs, 7 clean controls), each run once per variant: Claude Code (`sonnet`) and Codex (`gpt-6.1-sol`, medium effort), each with and without this skill. 52 runs. Scored by `score.py`; Claude Haiku judged matches.

## Results

| Variant | Bugs caught | False alarms | No verdict | Median minutes | Median tokens |
|---|---|---|---|---|---|
| Claude, with skill | 6 of 6 | 2 of 7 | 1 | 1.4 | 317,758 |
| Claude, no skill | 5 of 6 | 2 of 7 | 0 | 6.8 | 1,691,050 |
| Codex, with skill | 6 of 6 | 0 of 7 | 0 | 1.9 | 841,292 |
| Codex, no skill | 6 of 6 | 0 of 7 | 0 | 4.2 | 2,056,220 |

Paired by case, the skill made Claude faster in 13 of 13 cases (median 4.83x) and Codex faster in 13 of 13 (median 2.35x). Total tokens fell from 30.0M to 4.5M for Claude and from 31.5M to 11.9M for Codex.

Across all 34 cases (this run plus `2026-10-24-headless.md`):

| Variant | Bugs caught | False alarms | Median minutes | Median tokens |
|---|---|---|---|---|
| Claude, with skill | 17 of 17 | 2 of 17 | 0.9 | 316,564 |
| Claude, no skill | 15 of 17 | 3 of 17 | 2.4 | 1,148,993 |
| Codex, with skill | 17 of 17 | 1 of 17 | 1.6 | 676,957 |
| Codex, no skill | 17 of 17 | 3 of 17 | 2.4 | 1,399,571 |

The skill made Claude faster in 33 of 34 cases (median 2.68x) and Codex faster in 31 of 34 (median 1.84x).

- The one miss without the skill (R8, Claude) reported the known Pipeline Builder crash instead of the missing canvas icons.
- Every defect reported on a clean control was reproduced by hand. Five turned out to be real bugs on develop and are now `known_issues` and Gotchas: "Connect without a key" fails on a keyless engine; the docs 404 page has the home page's title; removing one of two same-named dropper files removes both results; a slow external writer can leave a `.pipe` file with trailing starter-pipeline bytes; empty `.pipe` files copied in with `cp -r` are sometimes never seeded.
- The four remaining false alarms: an EXPERIMENTAL badge judged too large (it renders as designed), the dropper replacing files on a second upload (documented as intended), the extension writing a deploy pair into `.env` (intended when no deployment target is set), and the extension filling in a missing `project_id` (intended). The last one came from `features/vscode.md`, which said the sidebar "never rewrites a file without asking"; that line is now accurate.
- The no-verdict run (C-canvas, Claude with the skill) did finish with its JSON verdict, but a background command it had started completed afterwards and woke it for one more reply, and `claude -p` returns only the last reply. That reply says it found nothing beyond the known crash.

## Caveats

- One run per case per variant. Treat differences of one case as noise.
- The area prompt tells the agent where to look, and `prepare` builds everything before the agent starts, so the no-skill numbers are an upper bound on what an agent does unaided.
- Planted bugs are small and local. Replayed bugs are real fixes reverted onto current code.
- Other sessions on the eval machine ran engines on port 5565, the engine's default. One agent without the skill started its own engine with `--port=5565` while the port was free; its log shows that engine bound and served its requests. The skill always picks a free port.

## By case

| Case | Kind | Area | Variant | Outcome | Minutes | Why |
|---|---|---|---|---|---|---|
| C-canvas | clean | canvas | claude (sonnet) | no-verdict | 12.6 | the agent did not finish with a JSON verdict |
| C-canvas | clean | canvas | claude (sonnet), no skill | false-alarm | 15.5 | The Pipeline Builder #185 crash matches the known issue, but the oversized EXPERIMENTAL badge in the canvas node header is not among the listed pre-existing issues. |
| C-canvas | clean | canvas | codex (gpt-6.1-sol) | clean | 2.1 | only known issues reported |
| C-canvas | clean | canvas | codex (gpt-6.1-sol), no skill | clean | 5.4 | only known issues reported |
| C-chat-ui | clean | chat-ui | claude (sonnet) | clean | 1.8 | no defect reported |
| C-chat-ui | clean | chat-ui | claude (sonnet), no skill | clean | 9.2 | no defect reported |
| C-chat-ui | clean | chat-ui | codex (gpt-6.1-sol) | clean | 1.9 | no defect reported |
| C-chat-ui | clean | chat-ui | codex (gpt-6.1-sol), no skill | clean | 3.1 | no defect reported |
| C-docs-site | clean | docs-site | claude (sonnet) | clean | 1.0 | no defect reported |
| C-docs-site | clean | docs-site | claude (sonnet), no skill | clean | 3.1 | only known issues reported |
| C-docs-site | clean | docs-site | codex (gpt-6.1-sol) | clean | 1.2 | no defect reported |
| C-docs-site | clean | docs-site | codex (gpt-6.1-sol), no skill | clean | 2.2 | no defect reported |
| C-dropper-ui | clean | dropper-ui | claude (sonnet) | false-alarm | 3.7 | The first reported defect, where uploading a second file replaces the earlier files instead of adding to the list, is not among the known issues, which cover only the stale public key hang and the same-name removal bug. |
| C-dropper-ui | clean | dropper-ui | claude (sonnet), no skill | clean | 6.8 | only known issues reported |
| C-dropper-ui | clean | dropper-ui | codex (gpt-6.1-sol) | clean | 1.7 | no defect reported |
| C-dropper-ui | clean | dropper-ui | codex (gpt-6.1-sol), no skill | clean | 3.0 | only known issues reported |
| C-vscode-canvas | clean | vscode-canvas | claude (sonnet) | clean | 1.5 | no defect reported |
| C-vscode-canvas | clean | vscode-canvas | claude (sonnet), no skill | clean | 9.5 | only known issues reported |
| C-vscode-canvas | clean | vscode-canvas | codex (gpt-6.1-sol) | clean | 1.9 | only known issues reported |
| C-vscode-canvas | clean | vscode-canvas | codex (gpt-6.1-sol), no skill | clean | 7.6 | only known issues reported |
| C-vscode-env | clean | vscode-env | claude (sonnet) | clean | 2.5 | no defect reported |
| C-vscode-env | clean | vscode-env | claude (sonnet), no skill | false-alarm | 8.6 | After VS Code is closed and reopened on a workspace already connected via Direct Connect, the extension writes ROCKETRIDE_DEPLOY_URI and ROCKETRIDE_DEPLOY_APIKEY (copies of the dev address and key, wi |
| C-vscode-env | clean | vscode-env | codex (gpt-6.1-sol) | clean | 1.7 | no defect reported |
| C-vscode-env | clean | vscode-env | codex (gpt-6.1-sol), no skill | clean | 4.2 | no defect reported |
| C-vscode-pipe-files | clean | vscode-pipe-files | claude (sonnet) | false-alarm | 1.4 | The reported defect (the sidebar rewriting a non-empty .pipe file that lacks a project_id, inserting a generated project_id) is not one of the three known pre-existing issues, which cover the restart prompt after editing, the starter pipeline written into empty files, and empty files in a new folder not getting the starter pipeline. |
| C-vscode-pipe-files | clean | vscode-pipe-files | claude (sonnet), no skill | clean | 6.5 | only known issues reported |
| C-vscode-pipe-files | clean | vscode-pipe-files | codex (gpt-6.1-sol) | clean | 2.6 | only known issues reported |
| C-vscode-pipe-files | clean | vscode-pipe-files | codex (gpt-6.1-sol), no skill | clean | 4.9 | only known issues reported |
| P6 | planted | chat-ui | claude (sonnet) | caught | 0.6 | The reported defect says the chat page removes the user's own question once the answer arrives, leaving only the greeting and answers, which is the same product problem as the reference. |
| P6 | planted | chat-ui | claude (sonnet), no skill | caught | 3.3 | Defect 1 reports the /chat page showing only the greeting and bot answers with no user question bubbles, which is the same visible symptom as the reference bug where the user's question disappears from the conversation. |
| P6 | planted | chat-ui | codex (gpt-6.1-sol) | caught | 1.1 | The reported defect says each user question disappears when its reply arrives, which is the same problem as the reference bug where the chat page drops the user's question once the answer comes in. |
| P6 | planted | chat-ui | codex (gpt-6.1-sol), no skill | caught | 2.6 | The reported defect is that submitted questions disappear when replies arrive and are dropped from later history, which is the same problem as the reference bug where the chat page drops the user's question when the answer arrives. |
| P7 | planted | dropper-ui | claude (sonnet) | caught | 1.0 | The reported defect describes the same bug: removing a file on the dropper page keeps the removed file's result and drops the results of the other files. |
| P7 | planted | dropper-ui | claude (sonnet), no skill | caught | 4.2 | The reported defect is the same bug as the reference: removing a file via its X button keeps the removed file's result and drops the other files' results, which the reference describes as the only-file case and the report shows with the middle file. |
| P7 | planted | dropper-ui | codex (gpt-6.1-sol) | caught | 1.7 | The reported defect describes the same bug: removing a file keeps its result, discards the other files' results, and leaves stale text even when the only uploaded file is removed. |
| P7 | planted | dropper-ui | codex (gpt-6.1-sol), no skill | caught | 3.2 | The reported defect describes the same problem as the reference: removing a file keeps that file's result, drops the other files' results, and leaves a stale result after the last file is removed. |
| P8 | planted | vscode-canvas | claude (sonnet) | caught | 1.4 |  |
| P8 | planted | vscode-canvas | claude (sonnet), no skill | caught | 9.3 | The reported defect describes the same Stop-on-canvas failure: the same 'Invalid pipeline: missing project ID or component ID' error, with the pipeline still running after Stop. |
| P8 | planted | vscode-canvas | codex (gpt-6.1-sol) | caught | 1.9 | The reported defect describes the same canvas Stop failure as the reference: the same "Invalid pipeline: missing project ID or component ID" error, the node stuck in stopping, and the engine task still running. |
| P8 | planted | vscode-canvas | codex (gpt-6.1-sol), no skill | caught | 9.5 | The reported defect describes the same problem as the reference: Canvas Stop fails to stop the pipeline, shows the missing project/component ID error, and leaves the Chat node stuck stopping. |
| P9 | planted | vscode-env | claude (sonnet) | caught | 0.8 | The reported defect is the same as the reference: on reopen, the extension rewrites the workspace .env and deletes the user's own variables (ROCKETRIDE_OPENAI_KEY, MY_VAR) while keeping managed lines and comments. |
| P9 | planted | vscode-env | claude (sonnet), no skill | caught | 8.4 | The reported defect describes the same problem as the reference: the extension's .env rewrite on connect and reopen deletes the user's own variables (MY_TOKEN, DATABASE_URL) and keeps only the managed ROCKETRIDE lines. |
| P9 | planted | vscode-env | codex (gpt-6.1-sol) | caught | 1.4 | The reported defect describes the same problem as the reference: reopening VS Code rewrites the workspace .env and deletes unmanaged variables such as ROCKETRIDE_OPENAI_KEY while comments remain. |
| P9 | planted | vscode-env | codex (gpt-6.1-sol), no skill | caught | 4.2 | The reported defect is the same problem as the reference: reconnecting on VS Code reopen deletes the user's unrelated variable assignments from the workspace .env file. |
| R8 | replay | canvas | claude (sonnet) | caught | 0.8 | The reported defect is that the Chat node on the Pipeline Builder canvas has no icon in its header even after its settings load, which is the same missing-header-icon problem as the reference bug. |
| R8 | replay | canvas | claude (sonnet), no skill | wrong-defect | 4.8 | The reported defect is a crash ('Pipeline Builder encountered an error', React #185) when choosing Chat, Webhook, or Dropper as a starting source, while the reference bug is node header icons disappearing after the full definition loads, so they are different product problems. |
| R8 | replay | canvas | codex (gpt-6.1-sol) | caught | 2.6 | The first reported defect describes Chat and Return Text nodes losing their header icons on the canvas, including after opening settings, which is the same icon-loss-after-definition-load problem as the reference, while the React #185 crash is a different problem. |
| R8 | replay | canvas | codex (gpt-6.1-sol), no skill | caught | 4.0 | The second reported defect says Webhook, Parser, and OpenAI nodes lose their service icons in canvas headers while the catalog still shows them, which is the same problem as the reference bug. |
| R9 | replay | vscode-pipe-files | claude (sonnet) | caught | 0.9 | The reported defect is the same problem as the reference: copying a .pipe file with cp makes the extension rewrite the copy on disk with no duplicate project_id warning. The tester saw project_id removed from the copy where the reference says it is reassigned, but the silent rewrite and missing warning are the same defect. |
| R9 | replay | vscode-pipe-files | claude (sonnet), no skill | caught | 4.2 | Both defects are the same product bug: the extension sees a duplicate project_id in a .pipe file and silently rewrites the file on disk with a new project_id and reformatted JSON, whether the duplicate came from cp (reference) or an in-place mv (report). |
| R9 | replay | vscode-pipe-files | codex (gpt-6.1-sol) | caught | 2.2 | The reported defect describes the same problem as the reference: the sidebar silently rewrites externally copied pipelines that have duplicate project_id values, assigning new IDs and reformatting the files without consent or notification. |
| R9 | replay | vscode-pipe-files | codex (gpt-6.1-sol), no skill | caught | 5.7 | The reported defect describes the same problem as the reference: the sidebar silently rewrites copied .pipe files, changing project_id and formatting without warning. |
