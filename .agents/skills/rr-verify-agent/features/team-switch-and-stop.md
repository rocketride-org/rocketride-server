# Team switch mid-run, and stop

While the agent is working, the user can switch the active team or stop the turn. Switching team must not move a write the agent already started into the new team's workspace (PR A). Stopping must end the turn promptly and leave no work running after the chat says it stopped (Dylan's cancel work).

## Sub-features

- `team-switch-write` checks that a write in flight when the team changes lands in the old team's files. The new team's tree is untouched.
- `team-switch-session` checks that the conversation shows which team it belongs to after the switch.
- `stop-visible` checks that a Stop control shows while the agent works.
- `stop-ends-turn` checks that Stop ends the turn within 30 seconds and no tool call runs after it.

## How to get to it (user POV)

- Team: the account menu (`RD` button at the bottom of the rail), then switch team, during a running turn.
- Stop: the Stop control in the Agent panel while the typing dots show.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0.
- Team switch: the signed-in account belongs to at least two teams (`rr-verify-agent engine whoami`).

- **Team switch.** Run `rr-verify-agent drive team-switch`. It reads `whoami` into `whoami.json` and fails `precondition-two-teams` unless there are two teams. With two teams, drive the switch by hand with a steps file (`rr-verify-agent drive steps`): start a long build, open `RD`, switch team, wait for the turn to end. Then read both trees with `rr-verify-agent engine ls pipelines` while each team is active. The fix passes when the file lands only in the old team.
- **Stop.** Run `rr-verify-agent drive stop`. It sends a build request. While the dots show, it looks for a button named Stop or Cancel, screenshots `stop-visible.png`, clicks it, and waits up to 30 seconds for the turn to end. `result.json` passes `stop-control` and `stop-ends-turn`.

## Gotchas

- The OSS engine has one team (`local`), so `team-switch` fails its precondition here by design. It needs an engine with a two-team account, for example a SaaS dev stack.
- The in-flight team bug sits in a window of milliseconds. The deterministic test in PR A proves the race. This journey proves the fix is wired into the real app.
- Result on fda7c679 (2026-10-27, Dylan's tip, which has the Stop button from c560a80e), source engine: `stop` passes. The Stop control showed while the dots did, the journey clicked it 3 s into the turn, and the turn ended at once. Evidence: `stop/2026-10-27T05-58-35-000Z/`.
- Result on 369f0511 (2026-10-24): `stop` fails, real product behavior. While the typing dots showed, the only controls were the `Reply to the agent...` composer and a disabled `Send`. There was no Stop or Cancel, and the turn ran to its own end. Evidence: `stop/2026-10-24T02-28-48-463Z/`. This matches the "no way to stop the agent" finding that Dylan's cancel work owns.
- `team-switch` fails its precondition on the OSS engine (one team, `local`). Evidence: `team-switch/2026-10-24T00-21-39-244Z/`. The PR A team switch bug is not observed here; it needs a two-team account.
- Stop belongs to Dylan's resume and cancel work, not Krish's PRs. The journey is here so both sides prove it the same way.
- The Stop matcher also matches any visible button whose name starts with Cancel. Keep other dialogs closed during this journey.
