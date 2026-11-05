# Browser agent eval judge

`judgeApp` grades a running app against a checklist a person wrote. Each run is a fresh `claude -p` session that uses the app through a browser and gives every line `pass`, `fail` or `not_tested`, with what it did and what it saw. The verdict is advisory. The report shows it beside the checks, and it doesn't change the result.

The runner serves the app and passes the URL. This folder doesn't deploy anything.

## Run it by hand

Install the browser once. This command gets the Chromium build that the pinned `@playwright/mcp` expects, about 580 MB:

```bash
npx -y -p @playwright/mcp@0.0.84 playwright install chromium
```

Then point the CLI at a running app:

```bash
node tools/browser-agent-evals/judge/cli.mjs \
  --url http://127.0.0.1:8080/ \
  --checklist checklist.txt \
  --out ~/judge-results/run-1
```

The checklist file has one expectation per line. The CLI prints each run and line, writes the full result to `result.json` in `--out`, and exits 0 for `pass`, 1 for `fail`, 2 for `inconclusive` and 64 for bad input.

| Flag              | Default             | Meaning                                                                          |
| ----------------- | ------------------- | -------------------------------------------------------------------------------- |
| `--runs`          | 3                   | Sessions to run, one after another                                               |
| `--model`         | `claude-sonnet-5-5` | Model for the session                                                            |
| `--budget-usd`    | 0.6                 | Spend limit for each run                                                         |
| `--timeout-ms`    | 600000              | Time limit for each run                                                          |
| `--local-storage` | none                | JSON file of `localStorage` values to seed, such as `{ "rr:user_token": "..." }` |

## Call it from code

```js
import { judgeApp } from './judge/judge.mjs';

const { verdict, lines, runs, costUsd } = await judgeApp({
	url,
	checklist: ['Adding a tool puts it in the list.'],
	outDir,
	localStorage: { 'rr:user_token': token },
});
```

The JSDoc in `judge.mjs` describes the options and result. Failed lines carry their evidence in `runs[n].lines`.

## How verdicts roll up

| Verdict        | When                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `fail`         | A valid run failed a line, or passed every line and said `fail` overall |
| `inconclusive` | No failure, and a run was invalid or a line was `not_tested`            |
| `pass`         | Every run tested every line and found nothing wrong                     |

A `pass` means the judge found nothing wrong, and it doesn't prove the app works.

A run is invalid when any of these is true, and its claims don't count:

- It hit its time or budget limit, or `claude` didn't start.
- A checklist line is missing, or the line numbers are off.
- A line has no verdict, no `did` or no `saw`.
- It never navigated to the app.
- The session was offered a tool outside the browser allowlist in `judge.mjs`.

## What it needs

- `claude` on `PATH`, logged in or with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` set. The session gets a minimal environment, and `INHERITED_ENV` in `judge.mjs` lists what passes through.
- `npx` with access to the npm registry. Each session starts `@playwright/mcp@0.0.84` through it, so this folder adds no workspace package.
- The browser from the command above. Set `PLAYWRIGHT_BROWSERS_PATH` if you installed it somewhere else.

## What a run leaves behind

`outDir` keeps `run-N.jsonl`, the session's transcript, and `run-N.stderr`. Don't commit them, because they hold whatever the app showed.

Scratch files live in `outDir/run-N.scratch` during a run. `judgeApp` deletes that folder when the run ends, including the file that holds the seeded `localStorage`. Playwright's socket goes in a temp directory under `os.tmpdir()`, because macOS limits socket paths to 104 bytes and `outDir` can be longer. `judgeApp` deletes that directory too.

`judgeApp` replaces seeded values of 8 characters or more with `[redacted]` in the saved transcripts and the result, in case a page shows or logs them. It can't replace a value drawn in a screenshot.

## Limits

- The judge sees the `outDir` path in its tool results, so don't name it after the expected verdict.
- The browser stays on the URL's origin, but it can open anything on that origin, including the app's own bundle.
- A run killed at its time limit reports no cost, so `costUsd` can undercount.

## Tests

```bash
node --test tools/browser-agent-evals/judge/judge.test.mjs
```

The tests use a fake `claude` on `PATH`, so they need no browser or key and spend nothing.
