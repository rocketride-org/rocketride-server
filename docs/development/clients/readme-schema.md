# Client docs schema

The Python and TypeScript client docs live in `docs/public/python/` and
`docs/public/typescript/`. Each folder holds two kinds of files:

- **`README.md`** — the source for the published PyPI / npm package README
  (exported by `./builder docs:export`; never a site page). It is a thin
  pointer: install, one quickstart, a one-line deferral to the docs site.
- **The site pages** — mounted at `/clients/python` and `/clients/typescript`,
  the canonical home of all guides and the full API reference.

Validate both layers with:

```bash
python3 scripts/validate-client-docs.py
```

The MCP readme (`docs/public/mcp/README.md`) is a different product surface and is
**not** covered by this schema.

## README section order

Both READMEs carry exactly these `##` sections, in this order — no
language-specific sections, no API reference, no worked-example gallery
(all of that lives on the docs site):

| # | Section |
|---|---|
| 1 | `## Quick Start` |
| 2 | `## What is RocketRide?` |
| 3 | `## Configuration` |
| 4 | `## Documentation` |
| 5 | `## Links` |
| 6 | `## License` |

Content rules:

- A bold **"Full documentation: …"** deferral line sits above `## Quick Start`.
- `## Quick Start` is install plus ONE runnable snippet.
- `## Configuration` is the env-var table plus a link to the site's
  Configuration page — not the constructor reference.
- `## Documentation` is a link map into the site pages.
- Package-facing constraints: these files become the npm/PyPI landing pages —
  no repo-relative links (use absolute URLs), and image references must use
  absolute `raw.githubusercontent.com` URLs.

## Site page set

Both client folders publish the same pages (index is `.mdx`, the rest `.md`),
pinned to journey order with `sidebar_position`:

`index` (0) · `configuration` (1) · `connection` (2) · `pipelines` (3) ·
`deploy` (4) · `data` (5) · `storage` (6) · `chat` (7) · `logs` (8) ·
`errors` (9) · `reference` (10) · `examples` (11) · `analytics` (12)

TypeScript-only extras are allowed for surface that exists in one SDK
(currently `database-sequelize` (13)); they must be declared in
`scripts/validate-client-docs.py` (`TS_ONLY_PAGES` / `PY_ONLY_PAGES`).

Method **tables live only in `reference.md`** (plus the constructor/env tables
on `configuration.md`). Guides carry workflow prose and examples and link into
the reference — never a second copy of a table.

## The parity rule

The two clients implement the same protocol, so the two `reference.md` files
must document the same API. **Any method, property, or type documented in one
must be documented in the other**, allowing for naming convention
(`snake_case` ↔ `camelCase` are the same symbol), **or** be explicitly marked
as language-specific:

- To mark a table row as language-specific, end the row's description with
  `<!-- language-specific -->`.
- Python dunder methods (`__aenter__`, …) are recognized as Python idiom and
  exempt automatically; document the TypeScript equivalent (e.g. `await using`)
  in prose.

When adding an API to one client, either add it to both references (preferred —
and ideally to both clients) or mark it. The checker fails on unmarked
asymmetry; CodeRabbit reviews whether a marked asymmetry is justified.

## Validation

`scripts/validate-client-docs.py` checks, deterministically:

- both READMEs exist, carry exactly the schema sections, in order
- both folders publish the same site page set (declared single-language extras
  aside)
- env-var parity between the two README Configuration tables
- API symbol parity across the two `reference.md` files: symbols are harvested
  from table rows and normalized across naming conventions; unmarked
  asymmetries fail

The checker verifies structure and parity, not truth. Whether signatures match
the shipped clients is a review concern.
