# docs-audit: verify documentation against the code it describes

Answers two questions mechanically, so doc cleanup is a review task instead of
an archaeology task:

1. **Does every path a doc cites actually exist?** (delete/fix candidates)
2. **Does every node that ships code actually have docs?** (write candidates)

## Why it is not a `grep -c`

The obvious version of this tool — "flag every cited path that isn't on disk" —
reports **68% of this repo's doc citations as dead**. Nearly all of that is
wrong, and acting on it deletes correct documentation. Three ways a citation
looks dead while being right:

| Doc says | On disk | Actually |
| --- | --- | --- |
| ``Save this as `extract.pipe`:`` | absent | a file the **reader** creates |
| ``Writes `version.docker.json``` | absent | built at runtime by `apps/vscode/src/engine/docker/engine-docker.ts` |
| ``**NOT:** `.pipeline.json``` | absent | a **counter-example** — deleting it reintroduces the mistake the doc prevents |

So every citation gets a **class plus the evidence behind it**, and only one
class is ever a deletion candidate:

- `VERIFIED` — resolves to a real path, or some file in the tree has that basename
- `PLACEHOLDER` — create-verb prose, a scaffolding tree, or an illustrative example
- `HISTORICAL` — a changelog naming a deleted file is correct by definition
- `RUNTIME` — no file at rest, but source code constructs the name
- `ORPHANED` — no path, no basename, no source literal → **review it**

`ORPHANED` is never auto-deleted. The tool reports; a human decides.

## Code → doc

Ordered by how loudly the gap misleads a reader:

- `STALE_PARAMS` — the generated schema table disagrees with `services*.json`.
  Confidently wrong, which is worse than absent. Fix by re-running
  `nodes:docs-generate` — never by hand-editing the generated block.
- `MISSING_PARAMS` — a node README with no generated block at all.
- `MISSING_DOC` — a node ships Python and has no README.

Profile groupings in `fields` (entries carrying `object`/`properties` rather
than `type`) are **not** parameters; `nodes:docs-generate` omits them from the
table, so counting them reports phantom drift on every profile-based node.

## Run it

```sh
python3 tools/docs_audit/cli.py --root .
python3 tools/docs_audit/cli.py --root . --json          # machine-readable
python3 tools/docs_audit/cli.py --root . --fail-on-orphaned   # CI gate
```

Tests:

```sh
python3 -m pytest tools/docs_audit/test/ -q
```

Every test named `test_placeholder_*`, `test_counter_example_*`, or
`test_profile_groups_*` pins a false positive an earlier version of this tool
actually produced. Keep them.

## Scope

Path-level citations only. Symbol-level checking (does this doc's
`session.display.render()` still match the signature?) is a natural extension
and is not implemented.
