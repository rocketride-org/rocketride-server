# docs/agents/

Documentation written for AI coding assistants, not people.

- **`context/`** — installed verbatim into a workspace's `.rocketride/docs/` by the
  VS Code extension and by `rocketride init`. `client-docs:agent`
  (`scripts/tasks.js` here) packs this folder — the `ROCKETRIDE_*.md` files at
  the root and `stubs/` beneath them — into `docs.zip`, which the engine serves
  at `GET /client/docs`. Everything in `context/` ships; nothing outside it does.
  `stubs/` holds the per-assistant pointer files (`CLAUDE.md`, `cursor.mdc`, ...)
  the installer writes next to a workspace's code.
- **`skills/`** — hand-curated pipeline-building skills. Not part of the bundle;
  installed only by an explicit skill install.
- **`task-battery.md`** — the acceptance test for `context/`: 256 tasks a user
  would hand a coding agent, grouped by category, with the latest doc-coverage
  scoring pass. Run a category against an agent that has only `context/` loaded
  when you change a doc; items it cannot complete are the gaps. Not part of the
  bundle.

The site does not render this folder. Edit `context/` and rebuild any client
(`./builder client-typescript:build`, `client-python:build`, `vscode:build`)
or run `./builder client-docs:agent` to restage the bundle.
