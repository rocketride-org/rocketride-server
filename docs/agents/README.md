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

The site does not render this folder. Edit `context/` and rebuild any client
(`./builder client-typescript:build`, `client-python:build`, `vscode:build`)
or run `./builder client-docs:agent` to restage the bundle.
