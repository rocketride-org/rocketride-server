# Node README schema

Every node directory (`nodes/src/nodes/<node>/`) contains a `README.md` that
follows this schema. The README's required shape is determined by the node's
`services*.json` — not by the author's judgment. Validate with:

```bash
python3 scripts/validate-node-readme.py nodes/src/nodes/<node>
```

## Tiers

- **CORE** — present in every node README, no exceptions.
- **CONDITIONAL** — required when `services*.json` declares the triggering
  fact, **forbidden** when it doesn't. A conditional section appearing
  without its trigger means the README and the metadata disagree — fix
  whichever one is wrong.
- **OPTIONAL** — never required. When present, must sit in its fixed slot
  and follow its rules.

Section order is fixed. In the hand-written region, no `##` headings other
than the ones defined here — anything node-specific goes under `## Notes`.

## Two regions

A node README has a **hand-written region** (everything below) followed by a
**generated region**: the `<!-- ROCKETRIDE:GENERATED:PARAMS START/END -->`
block containing `## Schema`, `## Dependencies`, and `## Source`, maintained
by `nodes:docs-generate`. The generated region is always last, is never
edited by hand, and is exempt from the section rules in this document.

Because the generated `## Schema` table is the field reference (one row per
field, machine-owned, cannot drift), the hand-written region does **not**
repeat a field table. Hand-written configuration content is usage guidance —
the things generation cannot know.

---

## 0. Title + summary — CORE

```markdown
# db_postgres

A RocketRide database node that answers natural-language questions against
PostgreSQL — as a pipeline node via lanes or as an agent tool.
```

- H1 is the node's directory name.
- The first paragraph is a one-to-two sentence summary, plain language, no
  marketing: what the node is and when to pick it, for someone choosing
  between 100+ nodes.

## 1. `## About <Vendor>` — OPTIONAL

*For nodes that wrap a third-party service or product.*

- 2–4 sentences, ≤ 80 words: what the company/product is and what it's
  known for, for a reader who has never heard of it.
- **Timeless-prose rule:** no model names, versions, prices, rate limits, or
  anything that changes on the vendor's schedule — that content belongs in
  `## Profiles` or the generated `## Schema`.
- First section after the summary.
- If present, `## Upstream docs` must also be present.

## 2. `## What it does` — CORE

- 2–5 sentences of prose. What the node does *inside a pipeline*, which
  roles it plays (lanes, agent tool, both), and when to pick it over
  sibling nodes.
- RocketRide's perspective only — vendor background belongs in `## About`.

**Screenshot** (optional, maintainer-added): the section may end with one
screenshot of the node wired into a pipeline on the canvas.

- File: `./screenshot.png`, stored in the node's directory.
- Must show the node connected to at least one other node.
- Alt text is mandatory and must name the node.
- Contributors are not expected to provide screenshots; the maintainer team
  adds them for visual consistency. Reviewers must not block a PR on a
  missing screenshot.

## 3. `## Connections` — CONDITIONAL

**Trigger:** a service entry declares an `invoke` object.

| Connection | Required | Description |
|---|---|---|

- Exactly one row per key in `invoke`. Required = "yes" when `min ≥ 1`.
- Connection names must match the `invoke` keys.

## 4. `## Lanes` — CONDITIONAL

**Trigger:** a service entry declares a non-empty `lanes` object.

| Lane in | Lane out | Description |
|---|---|---|

- One row per in→out pair declared in `lanes` (an input with multiple
  outputs gets one row per output; an input with no output gets `—`).
- Lane names must match `services*.json` exactly.

## 5. `## As a tool` — CONDITIONAL

**Trigger:** `"tool"` ∈ `classType`.

What an agent sees when this node is connected as a tool: the tool server
name and one row per exposed function.

| Function | Description |
|---|---|

- Describe arguments and return values beneath the table when non-obvious.
- This section is the agent-facing contract — it has the highest accuracy
  bar in the file.

## 6. `## Profiles` — CONDITIONAL

**Trigger:** `preconfig.profiles` contains ≥ 2 entries other than `custom`.

| Profile | Model | Context |
|---|---|---|

- List exactly the declared profiles, default marked `*(default)*`. Column
  names after the first may be adapted to the node.

## 7. `## Configuration` — CORE

Usage guidance for the configuration panel. The generated `## Schema` table
already lists every field — do not repeat it. This section contains:

- A short paragraph on how to approach configuring the node (what the
  profile gives you, what most users can ignore).
- A `###` subsection per **complex field**, named after the field's title,
  covering: what the field controls, valid values and what the default
  gives you, when and why to change it, interactions with other fields, and
  a concrete example of a good value where applicable.

A field is complex when any of these is true: its behavior isn't obvious
from its name, it interacts with other fields, wrong values fail silently
or expensively, or its value takes skill to write (prompts, descriptions,
connection strings). Fields that only make sense together may share one
grouped subsection.

**Multi-service directories** (more than one `services*.json` with a
`protocol`): split `## Connections` and `## Configuration` content by
`###`-per-service, primary service first. Exception: when the services are
presets of the same implementation with identical wiring (e.g. a branded
variant), document them once and describe the preset differences under
`## Notes`.

## 8. `## Authentication` — OPTIONAL

Credentials setup: which key/token the node needs, required scopes, where
to obtain it, and the expected format. Keep instructions structural
(scopes, format) rather than duplicating vendor UI walkthroughs that go
stale.

## 9. `## Example pipelines` — CORE

At least one example. Purpose: show what the node can actually do, in
context. For each example:

- **Bold one-line title** stating the use case.
- The pipeline shape as a flow of node names:
  `webhook → ocr → summarization → response`
- 1–3 sentences: what flows through, what the node contributes, what comes
  out. Mention non-default configuration when the example depends on it.

Examples must be real, runnable shapes using nodes that exist — no
hypothetical node names.

## 10. `## Requirements` — CONDITIONAL

**Trigger:** `"gpu"` ∈ `capabilities`.

Hardware/runtime requirements: GPU, VRAM, local model downloads, CPU
fallback behavior.

## 11. `## Limitations` — CONDITIONAL

**Trigger:** any of `nosaas`, `noremote`, `security`, `filesystem`
∈ `capabilities`.

Where the node can and cannot run, and any security-relevant behavior
(filesystem access, network access, SaaS exclusion), in plain language.

## 12. `## Notes` — OPTIONAL

The only free-form section. Anything genuinely node-specific:
troubleshooting, compatibility quirks, algorithm details, test
instructions. Use `###` subsections. Must not duplicate content owned by a
structured section.

## 13. `## Upstream docs` — OPTIONAL

*Required when `## About` exists; allowed otherwise.*

- Bulleted links to the vendor's or underlying library's documentation.
- Last hand-written section (the generated region follows it).

---

## Validation

`scripts/validate-node-readme.py` checks, per node, against `services*.json`
(all service files in the directory are merged; entries without a `protocol`
are shared fragments and are ignored):

- H1 equals the directory name; a summary paragraph follows it
- required sections present; conditional sections absent when untriggered
- section order; no unknown `##` headings in the hand-written region
- table parity: Connections rows = `invoke` keys, Lanes rows = declared
  lanes, Profiles rows = declared profiles
- `## Example pipelines` contains at least one flow
- the generated region, when present, is last and unmodified in shape
- screenshot, only if referenced: file exists and alt text is non-empty
- `## About` ≤ 80 words, first section, with `## Upstream docs` present
- warns when a field with objective complexity signals (a `textarea`
  widget or a large enum) lacks a `###` subsection under `## Configuration`

The validator checks structure, not truth. Whether the prose accurately
describes the code is a review concern (CodeRabbit on the PR, plus the
release documentation pass).
