# The Docs Pipeline

How `docs.rocketride.org` is assembled from this repo, and what you have to touch
to add, move, or rename a page.

The governing idea: **documentation is co-located with the code it documents**, and
a build step gathers the pieces into one Docusaurus site. Nothing generated is
committed under `docs/`; nothing hand-written lives in the assembled tree.

Everything here lives in `packages/docs/`:

| Path | Role |
| ---- | ---- |
| `scripts/tasks.js` | The builder module: `docs:gather`, `docs:index`, `docs:compile`, `docs:build`, `docs:dev`, `docs:serve`, `docs:test`, `docs:export`, `docs:check`, `docs:clean` |
| `scripts/lib/spine.js` | The information-architecture spine — the single source of truth for routes and navigation |
| `scripts/lib/gather.js` | Discovery + staging: finds every doc source and assembles the content tree |
| `scripts/lib/llms.js` | The `/nodes` catalog page and the `llms.txt` / `llms-full.txt` surfaces |
| `scripts/lib/export.js` | Copies docs-owned files out to the package destinations that consume them |
| `redirects.ts` | Old-URL → new-route map |
| `docusaurus.config.ts`, `sidebars.ts` | Site config; the sidebar is derived from the spine |

---

## The actions

```bash
./builder docs:build     # gather -> index -> compile  (the whole site)
./builder docs:dev       # gather-dev (symlinks) + docusaurus start, live reload
./builder docs:serve     # preview the built site from dist/docs
./builder docs:test      # unit tests for the docs helpers
./builder docs:export    # refresh the generated copies under packages/ and .rocketride/
./builder docs:check     # same computation, read-only: fail if a copy has drifted
./builder docs:clean     # drop the content tree, dist/docs, .docusaurus, and the gather hash
```

`docs:build` expands to:

```text
parallel(nodes:docs-generate, client-typescript:docs-generate)
  -> docs:gather -> docs:index -> docs:compile
```

Only the two light in-tree generators run as part of it. Heavier emitters (the
Python SDK reference, engine reference) refresh under their own `:build`; gather
collects whatever is present in the tree at the time.

> **`docs:build` is deliberately excluded from bare `./builder build`.** The
> orchestrator expands the aggregate build to actions that carry a `description`,
> and `docs:build` has none. It runs on its own cadence and is deployed by
> `.github/workflows/docs.yml`. Adding a description to make it show up in
> `--help` would silently re-couple it to the full build.

### Where things go

| Constant (`scripts/tasks.js`) | Location | What it is |
| --- | --- | --- |
| `CONTENT_STATIC_DIR` | `docs/public/product/` | The shell-authored **spine pages**, staged first because they own the routes |
| `CONTENT_DIR` | `build/docs-content/` | The assembled tree Docusaurus reads. Rebuilt from scratch every gather; never edit it |
| `STATIC_DIR` | `packages/docs/static/` | Raw pre-MDX `.md` siblings of every page, for the LLM surface and copy-as-markdown |
| `SITE_OUT` | `dist/docs/` | The compiled static site |

Docusaurus finds the assembled tree through the `ROCKETRIDE_DOCS_CONTENT`
environment variable, which `docsEnv()` sets alongside `DOCS_VERSION`,
`DOCS_HASH`, `DOCS_STAMP`, and `DOCS_SAAS`.

---

## The spine: ids are routes

`scripts/lib/spine.js` exports a single `SPINE` array. It is consumed by
**both** `sidebars.ts` (the rendered navigation) and `docs:gather` (mount
validation and placeholder generation), so the two can never drift apart.

`routeBasePath` is `/`, so **a doc id *is* the public URL**. `evaluate/security`
is `https://docs.rocketride.org/evaluate/security`. There is no separate route
table to keep in step — and no way to move a page without moving its URL.

Node shapes:

| Shape | Meaning |
| --- | --- |
| `{ id, label }` | A single authored page (leaf) |
| `{ id, label, mount: true }` | A leaf that a package may mount a whole subtree into |
| `{ label, items: [...] }` | A category of leaves or nested categories |
| `{ label, autogen: 'nodes' }` | A category whose pages are generated (the node catalog) |

A category itself renders no link. When a section needs an overview page, add a
plain leaf whose id is the section root — `docIdFor()` collapses
`quickstart/index.mdx` to the id `quickstart`, which keeps `/quickstart` working.

---

## How gather finds content

`gather()` runs five passes and rebuilds `build/docs-content/` from empty each
time. Every staged page is claimed by doc id through `claim()`; two sources
resolving to the same id abort the build with a route-collision error.

**1. Shell-authored spine pages.** Everything under `docs/public/product/`
(`CONTENT_STATIC_DIR`), staged first because it owns the spine. These are *not*
a mount — their doc id is their path relative to that directory.

**2. Node READMEs.** `nodes/src/nodes/*/README.md`, but only when the file
carries the `<!-- ROCKETRIDE:GENERATED:PARAMS START -->` marker; a legacy README
without markers is ignored. Each node is staged into a category folder chosen by
the first `classType` in its `services*.json` (`NODE_CATEGORIES` in `gather.js`),
which is what groups the Nodes sidebar like the editor canvas. An injected
`slug` pins the flat `/nodes/<name>` route that `redirects.ts` and existing links
depend on. A node with `nodes/src/nodes/<name>/<variant>/README.md`
subdirectories renders as a folder: the top-level README becomes the index page
and each backend variant a nested page.

**3. Mounted docs trees.** Two kinds, handled identically:

- **Package mounts.** A package declares them on its module export in
  `scripts/tasks.js`:

  ```javascript
  module.exports = {
      name: 'client-typescript',
      docs: [{ source: 'docs/reference/pipeline', mount: 'reference/pipeline-reference' }],
      actions: [...]
  };
  ```

  The mount must resolve to a spine slot marked `mount: true` (or a descendant
  path of one), or gather throws and lists the valid slots.

- **Root mounts.** `DOCS_ROOT_MOUNTS` in `gather.js` maps directories of the
  top-level `docs/` tree to spine slots:

  | Source | Mount |
  | --- | --- |
  | `docs/public/typescript` | `develop/typescript` |
  | `docs/public/python` | `develop/python` |
  | `docs/public/vscode` | `ide-extensions/vscode` |
  | `docs/public/mcp` | `protocols/mcp` |

The sweep covers **all** of `docs/public/`, so a new `.md` there with no covering
mount aborts the build rather than being silently dropped. `docs/public/product/`
is excluded (pass 1 owns it) and `README.md` files are excluded everywhere under
`docs/public/` — those are package-README export sources, never site pages. That
is why `docs/public/n8n/README.md`, which sits under no mount at all, does not
trip the sweep.

**`docs/development/` is never swept, with no exceptions.** It is unpublished
contributor documentation. A page whose audience is outside the repo belongs in
`docs/public/`; move it there rather than mounting out of `development/`.

**4. Placeholders.** Any spine id with no backing file gets a generated "coming
soon" stub so an unresolved sidebar link cannot break the build. See the gate
below.

**5. The manifest.** `build/docs-content/.manifest.json` records every staged
page (id, route, title, source, description, category) for `docs:index`.

Alongside each staged page, gather writes the raw pre-MDX source to
`packages/docs/static/<id>.md` — that is the copy-as-markdown and LLM surface.
It also stamps each page's front matter with the **source** file's last git
commit date, because the assembled tree is not git-tracked and Docusaurus would
otherwise find no date at all. (A shallow CI clone collapses every date to the
clone day, which is why the docs workflow checks out with full history.)

---

## The placeholder gate

`ensurePlaceholders()` writes a stub for every spine id with no backing file. A
doc id is the public URL, so an unexpected stub means a **live "coming soon" page
shipped in silence** — which is exactly what a page moved without updating its
spine id (or the reverse) looks like.

`assertNoUnexpectedPlaceholders()` turns that into a build failure. It runs in
the `docs:gather` *action* rather than inside `gather()` itself, so `gather()`
stays callable against a partial tree from tests and tooling while every real
build is gated.

Two allowlists in `gather.js`:

- `EXPECTED_PLACEHOLDERS` — **currently empty**, seeded that way once the tree
  reached zero placeholders. Add an id only when a stub page is genuinely wanted,
  with a comment naming who fills it in. Never add an id to quiet a failing
  build: the failure is telling you a spine id and a file path disagree.
- `STRUCTURAL_PLACEHOLDERS` — `nodes/example` only. It is emitted when the node
  corpus produced no pages at all (a docs-only checkout, or `nodes:docs-generate`
  never ran), which is already visible in the task's "Staged N pages, N nodes"
  line, so it is not a spine desync.

---

## `docs:index` and the LLM surface

`docs:index` (`scripts/lib/llms.js`) consumes the manifest and writes:

- `/nodes` — the generated node catalog landing page, grouped by category with a
  one-line description per group (`CATEGORY_DESCRIPTIONS`).
- `/llms.txt` — a per-section index linking each page's `.md` sibling.
- `/llms-full.txt` — every page's raw markdown, concatenated.

Section grouping comes from `sections()` / `sectionFor()` in the spine, so the
LLM surface follows the same IA as the sidebar.

---

## Redirects

`packages/docs/redirects.ts` is a flat `{ to, from[] }` array wired into
`@docusaurus/plugin-client-redirects` in `docusaurus.config.ts`.

**Any change to a published page's id needs an entry here**, because the id is
the URL. Moving `cli.mdx` under `reference/` is what produced
`{ to: '/reference/cli', from: ['/cli'] }`. Pages under `docs/development/` are
unpublished, so relocating them needs no redirect at all.

---

## Adding a page

Which steps apply depends on whether the page is a **spine page** or lives
**under an existing mount**. Only spine leaves and mount roots are `SPINE`
entries; mounted descendants are not.

**A new spine page** (a page the shell owns, under `docs/public/product/`):

1. Write the file under `docs/public/product/`. Its doc id is its path relative
   to that directory, so the path you pick is the URL.
2. Add that id and a label to `SPINE` in `scripts/lib/spine.js`, at the position
   you want it to appear in the sidebar.
3. `./builder docs:build`. If it publishes as a placeholder, the id and the file
   path disagree.

**A page under an existing mount** (one `SPINE` edit fewer):

1. Write the file inside that mount's source directory. Its doc id is
   `<mount>/<path under the source dir>` (`docIdFor()`; an `index` file collapses
   to its directory), so again the path is the URL.
2. **Do not add a `SPINE` entry.** Only the mount root is a spine node —
   `toSidebar()` renders it as a single `type: 'doc'` leaf, and the descendants
   are staged and routed by the mount, not by the spine. Adding an id for a
   descendant makes it a spine leaf the placeholder gate then expects to find on
   its own terms.
3. `./builder docs:build`. Consequence of step 2: a mounted descendant gets a
   route but no sidebar entry of its own, so link to it from the mount root or a
   sibling page.

**A new mount** (a package that wants to own a whole subtree):

1. Add a leaf to the spine carrying `mount: true`, or nest under an existing one.
2. Declare `docs: [{ source, mount }]` on the package's module export in its
   `scripts/tasks.js`. For a directory in the top-level `docs/` tree, add an
   entry to `DOCS_ROOT_MOUNTS` in `gather.js` instead.
3. `./builder docs:build`. An unmounted `.md` under `docs/public/` fails the
   build by design.

**Moving or renaming a published page:** update the spine id in the same change,
and add a `redirects.ts` entry from the old URL.

---

## Node READMEs: the autogen path

Node documentation is never written in `docs/`. It lives at
`nodes/src/nodes/<name>/README.md`, and only the region between

```text
<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
```

is machine-owned. `./builder nodes:docs-generate` (`nodes/scripts/gen-node-tables.mjs`)
rewrites that region with the node's dependencies, parsed from `requirements.txt`,
and a Source link resolved from git so it tracks renames rather than pinning a
branch. Prose outside the markers is preserved; a README with no markers is never
touched, and a node with no README is skipped.

The markers are also the **admission test**: `docs:gather` stages a node README
as a site page only when it carries them. On the rendered page the generated
`## Source` link is lifted into a "View source" breadcrumb action rather than a
content section, so README.md, the site page, and the `.md` LLM sibling all carry
the same content.

`nodes:docs-generate` runs as a step of `nodes:build` and again at the head of
`docs:build`. Node README prose must satisfy
[the node README schema](nodes/readme-schema.md).

---

## `docs:export` and `docs:check`

Some files are owned by `docs/` but have to physically exist somewhere else —
npm and PyPI render a package's own `README.md`, and the RocketRide assistant
skill reads `.rocketride/docs/`. `docs:export` copies them out with a
`GENERATED by ./builder docs:export — DO NOT EDIT` header, so anyone opening the
copy knows to edit upstream.

| Source | Destination |
| --- | --- |
| `docs/public/typescript/README.md` | `packages/client-typescript/README.md` |
| `docs/public/python/README.md` | `packages/client-python/README.md` |
| `docs/public/mcp/README.md` | `packages/client-mcp/README.md` |
| `docs/public/n8n/README.md` | `packages/n8n-nodes/README.md` |
| `docs/agents/*.md` (top level only) | `.rocketride/docs/` |

`docs:check` runs the identical computation with `check: true`, writes nothing,
and fails listing any destination that was hand-edited or never exported. The
`.rocketride/docs` entry is marked `checked: false` — its destination is
gitignored and absent from a fresh clone, so drift-checking it would always fail.
The export copies top-level `.md` files only, which deliberately excludes
`docs/agents/stubs/` (those are packaged into the VSIX by the vscode module).

Edit the source, then run `./builder docs:export`. Never hand-edit a destination.

---

## Local loop

```bash
./builder docs:dev      # live reload; stages by symlink so edits show immediately
./builder docs:build    # what CI runs — the only thing that catches link and mount errors
./builder docs:serve    # preview the built output
./builder docs:check    # export drift
./builder docs:test     # the gather/export helpers themselves
```

`docs:dev` uses `gather-dev`, which symlinks sources into the content tree
instead of copying, so saving a file updates the page without re-gathering. Node
pages are always real writes, because the staging step edits front matter and a
symlink cannot carry those edits.

`docs:build` is the one that fails on a broken internal link, an unmounted file,
or a spine/path desync. Run it before opening a docs PR — see
[CI Gates](ci-gates.md).
