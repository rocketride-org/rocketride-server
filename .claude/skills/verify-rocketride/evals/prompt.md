You are verifying a change in the RocketRide repository before it merges. Work only in {worktree}. It is a dedicated checkout, and its build in `dist/` already matches the code in it.

Task: verify that {area} works correctly on this checkout, and report any defect you find in the product's behavior.

{skill_line}

Rules:
- Use the run ID `{run_id}` for anything you start that takes a name or ID.
- Do not edit, add, or commit tracked files. Scratch files under /tmp and anything under the gitignored `.verify/` directory are fine.
- Do not rebuild: `dist/` is current. Starting, running, and stopping things is fine.
- Stop any engine or process you start before you finish.
- Judge the product by running it. Do not read git history or diffs to find what changed; read source code only to explain a behavior you observed.
- Report only defects in the product's behavior, not problems with these instructions or your tools.

Finish your reply with exactly one fenced JSON block in this shape:

```json
{"defect_found": true, "defects": [{"behavior": "what is wrong, in one sentence", "evidence": "the command and its output, or an evidence file path"}], "checked": ["each behavior you checked"]}
```

Set `defect_found` to false and `defects` to an empty list if everything you checked worked.
