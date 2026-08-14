# docs/

Hand-written documentation source for RocketRide, gathered into the docs site by
`./builder docs:build`. Nothing generated is committed under `docs/` — generated
reference material lives next to the code it's generated from and node docs stay
co-located with their nodes.

The three folders split by **audience**: `public/` is for people outside the repo,
`development/` is for contributors, `agents/` is for AI assistants.

## `public/` — humans outside the repo

- **`product/`** — the site spine, and the only folder here whose paths are public
  URLs verbatim: `quickstart/`, `evaluate/`, `concepts/`, `examples/`,
  `integrations/`, `develop/`, `operate/`, `reference/`, plus
  `protocols/websocket/` (the WebSocket (5565) engine wire protocol, for people
  building their own client).
- **`typescript/`, `python/`, `vscode/`, `mcp/`** — the per-surface guides, each
  mounted into the docs site. Each folder also holds a `README.md` (the package
  distribution readme — see Rules) and an `assets/` folder for its own images.
- **`n8n/`** — `README.md` only; the export source for `packages/n8n-nodes/`.
  Nothing here is published to the site.
- **`assets/`** — images shared by more than one section.

## `development/` — contributors

`index.md` is the setup guide; the rest is grouped by **subsystem**, so a new
contributor page has exactly one correct home:

- **`builder/`** — `reference.md` (run builds: commands, modules, output, CLI flags,
  compiler toolchain), `authoring.md` (write a package's `scripts/tasks.js`),
  `pre-commit-hooks.md`.
- **`engine/`** — C++ engine internals (`index.md`) and `crash-reporting.md`.
- **`nodes/`** — `index.md` (how nodes connect, adding one, local prototyping),
  `services-schema.md` (the `services*.json` contract), `readme-schema.md`
  (the node README contract), `testing.md`.
- **`clients/`** — `readme-schema.md`, the client-docs contract.
- **`apps/`** — building first-party shell apps inside the monorepo.
- `docs-pipeline.md` — how this docs system is assembled, and how to add a page.
- `ci-gates.md` — what gates a PR, and how to reproduce each check locally.

The two documentation contracts (`nodes/readme-schema.md`,
`clients/readme-schema.md`) are enforced by `scripts/validate-node-readme.py` and
`scripts/validate-client-docs.py`; move or rename either and update both scripts,
which name the schema paths in their output.

**Nothing here is published, with no exceptions.** `docs:gather` only sweeps
`public/`, so a page whose audience is outside the repo belongs in `public/` —
move it there rather than mounting out of `development/`.

## `agents/` — AI assistants

- The eight `ROCKETRIDE_*` assistant-facing integration docs, exported to
  `.rocketride/docs/` (a local, gitignored artifact) by `./builder docs:export`.
- **`stubs/`** — assistant-stub templates (`AGENTS.md`, `CLAUDE.md`,
  Cursor/Windsurf rules files, etc.), packaged into the VS Code extension.
- **`skills/`** — reserved for agent skills; empty until the first one ships.

The export copies top-level `.md` files only, so `stubs/` and `skills/` are
deliberately excluded from it.

## Rules

- Hand-written only. Nothing generated is committed under `docs/`.
- Node docs stay with their nodes: `nodes/src/nodes/<name>/README.md` (generated
  params between markers via `nodes:docs-generate`), following
  `development/nodes/readme-schema.md` — check with
  `python3 scripts/validate-node-readme.py <node-dir>`.
- A `README.md` in a `public/` section is that package's README export source —
  after editing it, run `./builder docs:export` to regenerate the committed
  package `README.md`. Never hand-edit the package `README.md` directly. This
  covers `typescript`, `python`, `mcp`, and `n8n`; `public/vscode/README.md` is
  the marketplace readme, copied into the VSIX at package time rather than
  exported.
- `README.md` files are never site pages — the site mounts skip them.
- CI runs `./builder docs:check` to catch export drift.

Root GitHub files (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.cursorrules`, ...)
never move into `docs/`; they stay at the repo root.
