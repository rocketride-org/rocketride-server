# docs/

Four folders, split by **audience**: `public/` is for people outside the repo,
`docusaurus/` is the docs site itself plus the pages that only exist for it,
`development/` is for contributors, `agents/` is for AI assistants.

## `public/` — humans outside the repo

- **`product/`** — the site spine, and the only folder here whose paths are public
  URLs verbatim: `quickstart/`, `evaluate/`, `concepts/`, `examples/`,
  `integrations/`, `develop/`, `operate/`, `reference/`, `ide-extensions/`, plus
  `protocols/websocket/` (the WebSocket (5565) engine wire protocol, for people
  building their own client).
- **`typescript/`, `python/`, `mcp/`** — the per-SDK guides, each mounted into
  the docs site. Each folder also holds a `README.md` (the package distribution
  readme — see Rules) and an `assets/` folder for its own images; `mcp/` splits
  into `http/` and `stdio/`, and its readme source lives at `mcp/stdio/README.md`.
- **`n8n/`** — `README.md` only; the export source for `packages/n8n-nodes/`.
  Nothing here is published to the site.
- **`chat-widget/`** — `README.md` only; the export source for
  `packages/chat-widget/README.md`. Nothing here is published to the site.
- **`assets/`** — images shared by more than one section.

## `docusaurus/` — the site, and site-only app pages

The Docusaurus project (`docusaurus.config.ts`, `sidebars.ts`, `src/`, `static/`,
`scripts/tasks.js` exposing `docs:build`, `docs:check`, `docs:test` (runs
`docs:validate` — the node README + client-doc schema validators, blocking —
then `docs:unit`, the docs helper unit tests), `docs:export`). It holds no
product content — `docs:gather` assembles the site
from `public/`, from the co-located node docs, and from the one content folder
below:

- **`apps/`** — pages about shipped apps that only the site renders, one folder
  per app: `vscode/` (mounted at `/clients/vscode`), and `app-builder/` when its
  user docs land. An app's *README* is not here: it lives with the app
  (`apps/vscode/README.md`, `apps/<app>/README.md`), next to its `assets/`. Not
  to be confused with `development/apps/`, which is about building apps inside
  the monorepo.

## `development/` — contributors

`index.md` is the setup guide; the rest is grouped by **subsystem**, so a new
contributor page has exactly one correct home:

- **`builder/`** — `reference.md` (run builds: commands, modules, output, CLI flags,
  compiler toolchain), `authoring.md` (write a package's `scripts/tasks.js`),
  `pre-commit-hooks.md`.
- **`engine/`** — C++ engine internals (`index.md`), `crash-reporting.md`, and
  `mcp-module.md`.
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
`public/` and `docusaurus/apps/`, so a page whose audience is outside the repo
belongs in one of those — move it there rather than mounting out of
`development/`.

## `agents/` — AI assistants

- **`context/`** — the ten `ROCKETRIDE_*` assistant-facing docs plus `stubs/`
  (the per-assistant pointer files). Installed verbatim into a workspace's
  `.rocketride/docs/` by the VS Code extension and `rocketride init`, via the
  `docs.zip` bundle that `client-docs:agent` (`agents/scripts/tasks.js`) stages
  for the engine's `GET /client/docs`. Everything in `context/` ships.
- **`skills/`** — hand-curated pipeline-building skills. Not in the bundle.

See `agents/README.md`.

## Rules

- Hand-written only. Nothing generated is committed under `docs/`.
- Node docs stay with their nodes: `nodes/src/nodes/<name>/README.md` (generated
  params between markers via `nodes:docs-generate`), following
  `development/nodes/readme-schema.md` — check with
  `python3 scripts/validate-node-readme.py <node-dir>`.
- A `README.md` in a `public/` section is that package's README export source —
  after editing it, run `./builder docs:export` to regenerate the committed
  package `README.md`. Never hand-edit the package `README.md` directly. This
  covers `typescript`, `python`, `mcp`, `n8n`, and `chat-widget`. App READMEs (the VS Code
  marketplace readme, store listings) are not exported: each app owns its
  `README.md` and `assets/` in its own folder under `apps/`.
- `README.md` files are never site pages — the site mounts skip them.
- Image links are relative everywhere (`./assets/x.png` beside the file), so any
  branch previews on GitHub. The two copy steps that publish a README outside
  GitHub — `docs:export` for the package READMEs and the VSIX stage step for
  `apps/vscode/README.md` — rewrite them to raw-GitHub URLs on `main` via
  `absolutizeImageLinks` in `scripts/lib`. No other README copy is rewritten;
  the site build's rewrite of node-README `example.png`/`example.pipe`
  references (gather.js) is a separate, site-only step.
- CI runs `./builder docs:check` to catch export drift.

Root GitHub files (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.cursorrules`, ...)
never move into `docs/`; they stay at the repo root.
