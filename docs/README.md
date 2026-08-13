# docs/

Hand-written documentation source for RocketRide, gathered into the docs site by
`./builder docs:build`. Nothing generated is committed under `docs/` — generated
reference material lives next to the code it's generated from and node docs stay
co-located with their nodes.

The three folders split by **audience**: `public/` is for people outside the repo,
`development/` is for contributors, `agents/` is for AI assistants.

## `public/` — humans outside the repo

- **`product/`** — the site spine: quickstart, concepts, integrations, examples,
  evaluate, glossary, troubleshooting, cloud, self-hosting.
- **`typescript/`, `python/`, `vscode/`, `mcp/`** — the per-surface guides, each
  mounted into the docs site. Each folder also holds a `README.md` (the package
  distribution readme — see Rules) and an `assets/` folder for its own images.
- **`n8n/`** — `README.md` only; the export source for `packages/n8n-nodes/`.
  Nothing here is published to the site.
- **`assets/`** — images shared by more than one section.

## `development/` — contributors

Environment setup, builder, engine internals, node and client authoring, apps,
pre-commit hooks. The documentation contracts live here too:
`development/node-readme-schema.md` (node READMEs) and
`development/client-readme-schema.md` (client readmes).

Not published — with one exception: **`development/websocket/`** documents the
WebSocket (5565) engine wire protocol and *is* mounted to the site at
`protocols/websocket`. It sits here because its audience is people working on
the engine.

## `agents/` — AI assistants

- The eight `ROCKETRIDE_*` assistant-facing integration docs, exported to
  `.rocketride/docs/` (a local, gitignored artifact) by `./builder docs:export`.
- **`stubs/`** — assistant-stub templates (`AGENTS.md`, `CLAUDE.md`,
  Cursor/Windsurf rules files, etc.), packaged into the VS Code extension. The
  export copies top-level `.md` files only, so `stubs/` is deliberately excluded.

## Rules

- Hand-written only. Nothing generated is committed under `docs/`.
- Node docs stay with their nodes: `nodes/src/nodes/<name>/README.md` (generated
  params between markers via `nodes:docs-generate`), following
  `development/node-readme-schema.md` — check with
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
