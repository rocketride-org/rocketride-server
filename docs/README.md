# docs/

Hand-written documentation source for RocketRide, gathered into the docs site by
`./builder docs:build`. Nothing generated is committed under `docs/` — generated
reference material lives next to the code it's generated from (see below) and node
docs stay co-located with their nodes.

Every section is either entirely published to the docs site or entirely not —
folders are never mixed.

## Published to the docs site

- **`product/`** — the site spine: quickstart, concepts, integrations, examples,
  evaluate, glossary, troubleshooting, cloud, self-hosting.
- **`clients/typescript/`, `clients/python/`, `clients/vscode/`** — per-client guides.
  Each has a `readme.md`, the source for that package's `README.md` — except vscode's,
  which is gitignored and copied at package time rather than committed.
- **`protocols/websocket/`, `protocols/mcp/`** — the wire protocol surfaces:
  the WebSocket (5565) engine protocol and MCP. `protocols/mcp/readme.md` is the
  source for `packages/client-mcp/README.md`.

## Not published

- **`development/`** — contributor docs: environment setup, builder, engine
  internals, node schema/testing, pre-commit hooks. The documentation contracts
  live here too: `development/node-readme-schema.md` (node READMEs) and
  `development/client-readme-schema.md` (client readmes).
- **`agents/`** — the `ROCKETRIDE_*` assistant-facing integration docs, exported to
  `.rocketride/docs/` by `./builder docs:export`.
- **`stubs/`** — assistant-stub templates (`AGENTS.md`, `CLAUDE.md`, Cursor/Windsurf
  rules files, etc.), packaged into the VS Code extension.
- **`images/`** — image assets referenced by the docs above.

## Rules

- Hand-written only. Nothing generated is committed under `docs/`.
- Node docs stay with their nodes: `nodes/src/nodes/<name>/README.md` (generated
  params between markers via `nodes:docs-generate`), following
  `development/node-readme-schema.md` — check with
  `python3 scripts/validate-node-readme.py <node-dir>`.
- A `readme.md` in a client (or `protocols/mcp/`) section is that package's README
  export source — after editing it, run `./builder docs:export` to regenerate the
  committed package `README.md`. Never hand-edit the package `README.md` directly.
- CI runs `./builder docs:check` to catch export drift.

Root GitHub files (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.cursorrules`, ...)
never move into `docs/`; they stay at the repo root.
