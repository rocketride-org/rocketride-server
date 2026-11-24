# docs/cursor/

The RocketRide plugin for Cursor, staged here until it has a public repository
of its own. Cursor's Marketplace and cursor.directory both take a public Git
repository with the plugin manifest at its root. `plugin/` holds exactly what
that repository's root will hold. It points Cursor at the hosted RocketRide
server, `https://api.rocketride.ai/mcp`, and carries no skills or code.

It is separate from `docs/agents/`, the Claude Code and Codex plugin, because
every file there goes to those plugins' users. The docs site does not render
this folder.

## Files in `plugin/`

| File | What it holds |
| --- | --- |
| `.cursor-plugin/plugin.json` | The manifest: name, display name, version, description, author, links, license, logo, keywords and category. |
| `mcp.json` | The one MCP server, by URL, with no headers, auth settings or variables. Cursor signs in through the browser. |
| `.mcp.json` | The same bytes. cursor.directory finds servers in a file with this name, and Cursor may read either file, so the two must stay identical. |
| `assets/logo.png` | 512 by 512 pixels, the RocketRide mark on a navy tile. It is the same image as the ChatGPT app's icon, drawn from `packages/shell/src/components/RocketRideMark.tsx`. |
| `README.md` | What the plugin does and needs, how to install it and sign in, the Cursor CLI and API key options, the steps for Cursor teams, and where to get help. |
| `LICENSE` | A copy of the repository's root `LICENSE`. |
| `CHANGELOG.md` | One entry per version. |

`tests/test_cursor_plugin.py` checks the folder: the manifest fields Cursor
reads, a kebab-case `name`, a semantic `version`, a description that starts
with the shared RocketRide sentence and avoids a short list of words, one
server at the hosted URL in two identical files, a square PNG logo, the
`LICENSE` copy, and the README's install link. CI runs it in `docs:test`.

## Move it to its own repository

1. Copy the contents of `plugin/` to the root of the new repository, including
   the two files whose names start with a dot.
2. In the copy, change `repository` in `.cursor-plugin/plugin.json` to the new
   repository's URL.
3. From then on, the new repository is the source of truth. Delete this folder
   and `tests/test_cursor_plugin.py` from this repository in one small PR.

## Before each submission or update

1. Raise `version` in `.cursor-plugin/plugin.json` and add a `CHANGELOG.md`
   entry. Cursor reviews every update to a Marketplace plugin.
2. Run the check: `python3 -m pytest tests/test_cursor_plugin.py`.
3. Load the folder in Cursor from `~/.cursor/plugins/local/rocketride`, reload
   the window, sign in, and run one tool.
4. Open every link in the manifest and the README.
5. Submit the repository URL at cursor.com/marketplace/publish, and at
   cursor.directory for the community directory.

A reviewer login for Cursor's team is entered in the submission form or sent
to Cursor directly. It is never committed here or in the new repository.
