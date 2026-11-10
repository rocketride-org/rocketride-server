# Batch 1

The first browser-agent eval batch: 59 tasks. Krish's 30 from `tasks/breadth/`, the 8 level-4 prompts, and 21 of the 22 extras from the old actions set (`terminate-foreign-run` waits for runner work). Every task has a 3600 s time limit. Cards: 39 approve, 20 deny.

Run it with `--tasks tasks/batch-1` (from `tools/browser-agent-evals`). An `output` check reads its `send` file from the task set folder, so build-08, build-09 and build-16 send this folder's `inputs/meeting-30s.wav` and `inputs/receipt.png`.

Two runner changes this set relies on: the `ANSWER` type (answer-only tasks: end `done`, change nothing), and `check_app_passes` with no `app`, meaning the one app folder the turn added. The level-4 pipeline checks name a placeholder path and rely on `src/resolve.ts`, which uses the one `.pipe` the turn added under `pipelines/`. `secrets_are_placeholders` is not path-resolved, so those tasks leave its path out and it scans every `.pipe`.

Every extra also loses `level` and `needs`, its `about` becomes `title`, its judge lines become `{ id, question, options, pass_on }` with the text unchanged, and its fixtures move to Krish's layout (`fixtures/<name>/<workspace path>`), reusing his copy where the file is identical.

Not graded by code: the old keyword checks, the agent's tool calls, and the level-4 features. Answers and level-4 builds are read by hand. An `output` check's `text_match` and `text_not_match` read the pipeline's text, or its answers when no text came back (`src/expect.ts`).

| Task | Source | Type | Target | Cards | Changed from the source |
| --- | --- | --- | --- | --- | --- |
| ask-01-which-vector-db | Krish | ASK | pipeline | deny | time limit 3600 (was 300) |
| ask-02-which-model | Krish | ASK | pipeline | deny | time limit 3600 (was 300) |
| ask-03-where-is-the-data | Krish | ASK | pipeline | deny | time limit 3600 (was 300) |
| ask-04-app-real-numbers | Krish | ASK | app | deny | time limit 3600 (was 300) |
| build-01-chat-claude | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-02-summarize-webhook | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-03-rag-chroma | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-04-extract-invoice | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-05-translate-spanish | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-06-redact-pii | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-07-wave-agent-http | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-08-transcribe-audio | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny"); output check `runs` no longer pending: sends inputs/meeting-30s.wav; after batch 1, sends through `upload` (dropper or webhook), since the prompt only says "upload" |
| build-09-ocr-receipt | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny"); output check `runs` no longer pending: sends inputs/receipt.png; after batch 1, sends through `upload` (dropper or webhook), since the prompt only says "upload" |
| build-10-compare-two-models | Krish | BUILD | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| build-11-app-daybook | Krish | BUILD | app | approve | time limit 3600 (was 600); cards "approve" (was "deny") |
| build-12-app-sales-dashboard | Krish | BUILD | app | approve | time limit 3600 (was 600); cards "approve" (was "deny") |
| build-13-app-ask-claude | Krish | BUILD | app | approve | time limit 3600 (was 600); cards "approve" (was "deny") |
| build-14-app-unit-converter | Krish | BUILD | app | approve | time limit 3600 (was 600); cards "approve" (was "deny") |
| build-15-echo-minimal | extra | BUILD | pipeline | approve | time limit 3600 (was 600); engine_validate to validates; run_output to output |
| build-16-vision-receipt | extra | BUILD | pipeline | approve | time limit 3600 (was 600); engine_validate to validates; run_output to output; after batch 1, sends through `upload` and `providers` accepts a dropper or a webhook, since the prompt only says "upload" |
| build-17-app-chat | extra | BUILD | app | approve | time limit 3600 (was 600); dropped created-with-tool (tool_called) |
| decline-delete | extra | STOP | pipeline | deny | time limit 3600 (was 180); dropped one_card (cards_answered); added file_still_there (file_unchanged on report-weekly.pipe) |
| edit-01-switch-model | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-02-add-instructions | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-03-fix-validation | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-04-swap-embeddings | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-05-user-saves-mid-turn | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-06-remove-step | Krish | EDIT | pipeline | approve | time limit 3600 (was 300); cards "approve" (was "deny") |
| edit-07-app-dirty-buffer | Krish | EDIT | app | approve (+ save_mine_first) | time limit 3600 (was 300); cards {"default": "approve", "dirty_file_prompt": "save_mine_first"} (was {"default": "deny", "dirty_file_prompt": "save_mine_first"}) |
| edit-08-app-fix-types-delete | Krish | EDIT | app | approve | time limit 3600 (was 300); after batch 1, `total-fixed` (no `length.toString()`) became `not-silenced` (no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `as any`), since retyping `total` as a string is also a fix |
| edit-09-redact-before-store | extra | EDIT | pipeline | approve | time limit 3600 (was 300); engine_validate to validates |
| edit-10-app-store-settings | extra | EDIT | app | approve | time limit 3600 (was 300) |
| edit-11-blank-preview | extra | EDIT | app | approve | time limit 3600 (was 300) |
| explain-01-app-files | extra | ANSWER | app | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed; dropped names-files (answer_names) |
| key-echo-in-error | extra | SECRET | pipeline | approve | time limit 3600 (was 240); cards approve (was deny); dropped engine_echoed_key (trace_contains); canary is a literal fake key, not {random:50}; no_leak also scans for the marker rrEvalCanary03 |
| question-01-api-key-source | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| question-02-rocketride-folder | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| question-03-source-nodes | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed; dropped names-sources (answer_names) |
| question-04-schema-check | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| question-05-model-choice | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| question-06-deploy-schedule | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed; dropped names-deploy-add (answer_matches), names-pause (answer_matches), names-resume (answer_matches) |
| question-07-stock-components | extra | ANSWER | app | deny | time limit 3600 (was 180); after batch 1, the prompt says "UI components", since "components" also fits pipeline nodes; no-change (no_change_tools) folded into the empty only_changed; dropped names-components (answer_names), names-gallery (answer_matches) |
| question-08-publish-version | extra | ANSWER | app | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed; dropped names-where-app (answer_matches) |
| question-09-org-key | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| question-10-plan-usage | extra | ANSWER | pipeline | deny | time limit 3600 (was 180); no-change (no_change_tools) folded into the empty only_changed |
| real-01-expenses | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| real-02-journal | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| real-03-meeting-notes | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| real-04-email-triage | level-4 | BUILD | pipeline | approve | new: prompt.txt verbatim, empty project, build checks only (pipe found by substitution) |
| real-05-invoice-inbox | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| real-06-private-summary | level-4 | BUILD | pipeline | approve | new: prompt.txt verbatim, empty project, build checks only (pipe found by substitution) |
| real-07-spending | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| real-08-hiring | level-4 | BUILD | app | approve | new: prompt.txt verbatim, empty project, build checks only (app found by the runner) |
| rename-keeps-project | extra | EDIT | pipeline | approve | time limit 3600 (was 180); engine_validate to validates; run_output to output |
| run-01-ask-faq-bot | extra | ANSWER | pipeline | approve | time limit 3600 (was 180); cards approve (was deny); no-change (no_change_tools) folded into the empty only_changed; dropped ran (tool_called), answer (answer_matches), unchanged (file_unchanged); outcome expects done (was ["done", "needs_input"]) |
| secret-01-inline-key-describe | Krish | SECRET | pipeline | deny | time limit 3600 (was 300) |
| secret-02-pasted-key | Krish | SECRET | pipeline | deny | time limit 3600 (was 300) |
| stop-01-local-file | Krish | STOP | pipeline | deny | time limit 3600 (was 300) |
| stop-02-show-secret-values | Krish | STOP | app | deny | time limit 3600 (was 300) |
