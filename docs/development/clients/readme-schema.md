# Client README schema

The Python and TypeScript client readmes (`docs/public/python/README.md`,
`docs/public/typescript/README.md`) are the sources for the published PyPI
and npm package READMEs (exported by `./builder docs:export`). They follow
this schema. Validate with:

```bash
python3 scripts/validate-client-docs.py
```

The MCP readme (`docs/public/mcp/README.md`) is a different product surface and is
**not** covered by this schema.

## Section order

Both readmes carry the same shared sections, in this order, with
language-specific sections at fixed insertion points:

| # | Section | Applies to |
|---|---|---|
| 1 | `## Quick Start` | both |
| 2 | `## What is RocketRide?` | both |
| 3 | `## Features` | both |
| 4 | `## RocketRideClientConfig` | TypeScript only |
| 5 | `## RocketRideClient` | both |
| 6 | `## DataPipe` | both |
| 7 | `## Question` | both |
| 8 | `## Answer` | both |
| 9 | `## Types` | both |
| 10 | `## Exceptions` | both |
| 11 | `## Examples (Full API Usage)` | both |
| 12 | `## CLI` | Python only |
| 13 | `## Configuration` | Python only |
| 14 | `## Links` | both |
| 15 | `## License` | both |

No other `##` sections. New API surface goes into the section that owns it;
new prose goes under the closest existing section.

## The parity rule

The two clients implement the same protocol, so the two readmes must
document the same API. **Any method, property, type, or exception documented
in one readme must be documented in the other**, allowing for naming
convention (`snake_case` ↔ `camelCase` are the same symbol), **or** be
explicitly marked as language-specific.

- To mark a table row as language-specific, end the row's description with
  `<!-- language-specific -->`.
- Python dunder methods (`__aenter__`, `__aexit__`, ...) are recognized as
  Python idiom and exempt automatically; document the TypeScript
  equivalent (e.g. `await using` / `Symbol.asyncDispose`) in prose.

When adding an API to one client, either add it to both readmes (preferred —
and ideally to both clients) or mark it. The checker fails on unmarked
asymmetry; CodeRabbit reviews whether a marked asymmetry is justified.

## Content rules

- Method documentation is table-based: one row per method with backticked
  name, signature, return, and description columns. Prose guidance
  ("How to use", "Why the options matter") sits next to the tables it
  explains.
- `## Quick Start` must be runnable as written against a current server.
- Package-facing constraints: these files become the npm/PyPI landing pages —
  no repo-relative links (they break on the registries; use absolute URLs),
  and image references must use absolute `raw.githubusercontent.com` URLs.

## Validation

`scripts/validate-client-docs.py` checks, deterministically:

- both files exist, all shared sections present, in schema order
- language-specific sections appear only in their language's file
- no unknown `##` sections
- API symbol parity across `RocketRideClient`, `DataPipe`, `Question`,
  `Answer`, `Types`, and `Exceptions`: symbols are harvested from table
  rows and normalized across naming conventions; unmarked asymmetries fail

The checker verifies structure and parity, not truth. Whether signatures
match the shipped clients is a review concern (CodeRabbit and the release
documentation pass).
