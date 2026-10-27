# Steps files

`rr-verify-agent drive steps <file.json or a name in this folder>` runs a list of user actions in one browser session, with the same recording as the scripted journeys (screenshots, console, WebSocket frames, `result.json`). Use it for a feature path no journey covers yet, then promote it to a journey in `scripts/drive.mjs` once it is stable.

Each step is an object with `do` and an optional `label` (used in file names and checks):

| `do` | Fields | What it does |
|---|---|---|
| `open` | | Shell home, Sign In with the local key, open Rocket Builder |
| `view` | `name` | Select a rail view (`Explorer`, `Agent`, `Pipelines`), clicking until it is selected |
| `openFile` | `path` | `Explorer`, then the folders and file of a workspace path (folders already open stay open), then wait for the Monaco editor |
| `newSession` | | `Agent` tab, `New session`, wait for the composer |
| `send` | `text` | Type into the visible composer and press Send |
| `waitTurn` | optional `answer`, `expectDialogs` | Wait for the typing dots to appear and go away, and check that the turn ended. With `answer` (a button name such as `Save mine first`), every "Unsaved changes" dialog during the turn gets that button, with a screenshot of each. With `expectDialogs`, check how many there were |
| `click` | `role` + `name`, or `text`, or `placeholder`, or `label`, or `css`; optional `exact`, `nth` | Click the matching element (`nth`, default 0; `css` matches visible elements only) |
| `fill` | the same selectors, plus `value` | Fill a field |
| `press` | `key` | Press a key, for example `Control+s`. Letters are case-sensitive: `Control+S` sends a capital S, which the editors do not treat as save |
| `type` | `value` | Type at the current focus |
| `wait` | `ms` | Wait that long |
| `shot` | | Screenshot and ARIA snapshot |
| `engine` | `args` | Run `engine-read.cjs` with these arguments and log the output. An argument that starts with `fixtures/` names a file in this folder's `fixtures/`, so steps files work from any checkout |
| `expectText` | `text` | Check: the text is visible |
| `expectNoText` | `text` | Check: the text is not visible anywhere on the page |
| `expectEngine` | `args`, `contains` and/or `lacks` | Check: the engine command's output contains, or lacks, the string |

Steps files kept here:

Both seed `apps/verify-notes/package.json` (from `fixtures/package.json`) before `App.tsx`, so check_app finds a valid manifest and the agent leaves the app's scaffold alone. Run them by name: `rr-verify-agent drive steps closed-dirty-tab`.

- `closed-dirty-tab.json`: type in `App.tsx` without saving, close the tab, ask the agent to change the heading (answering any dialog Save mine first), reopen the file and press Ctrl+S. Passes when the stored file holds both the user's line and the agent's heading. On PR A round 2 it failed: no dialog, and the reopened tab saved the old text over the agent's change.
- `split-save.json`: open `App.tsx`, split it with Ctrl+\, type and save in the left split, then ask the agent to change the heading. Passes when no split shows "changed outside this editor" or ●, the agent asks nothing, and both changes are stored. On PR A round 2 the right split stayed dirty and stale, and the agent asked about the saved change.

Example, the "Done" row once PR C lands:

```json
[
  { "do": "open" },
  { "do": "newSession" },
  { "do": "send", "text": "Build a pipeline called verify-done that chats with Claude Sonnet 4.6 using ROCKETRIDE_ANTHROPIC_KEY.", "label": "turn1" },
  { "do": "waitTurn", "label": "turn1" },
  { "do": "expectText", "text": "Done", "label": "done-row" },
  { "do": "expectEngine", "args": ["ls", "pipelines"], "contains": "verify-done.pipe", "label": "file-written" }
]
```
