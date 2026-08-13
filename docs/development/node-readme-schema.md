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

## 3. `## Example pipelines` — CORE

At least one example. The **first example is the shipped example**: a
small working pipeline committed with the node, so a reader can see the
node on the canvas and download the pipeline itself instead of rebuilding
it from prose.

**Files, in the node's directory:**

- `example.pipe` — a minimal, runnable pipeline featuring this node
- `example.png` — a canvas screenshot of that same pipeline

**The section opens with the shipped example**, in this shape:

```markdown
## Example pipelines

**Summarize scanned documents**

`webhook → ocr → summarization → response`

![The ocr node wired between a webhook source and summarization on the canvas](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

Scanned PDFs arrive over a webhook, OCR turns them into text, and the
summarization node condenses each one.
```

Rules:

- The flow line, the screenshot, and the `.pipe` must all depict the
  **same pipeline**. The screenshot shows the node wired on the canvas —
  never floating alone — and its alt text names the node.
- Reference the files by bare relative name (`example.png`,
  `example.pipe`), as above. The docs build rewrites both to repository
  URLs when staging the site, and GitHub resolves them natively — do not
  hand-write absolute URLs.
- The download button is a [shields.io](https://shields.io) badge, exactly
  as in the template (`style=for-the-badge`, brand color `41b6e6`).
- **Reference both halves or neither.** Embedding the screenshot obliges
  the download badge and vice versa, and a referenced file must exist —
  a README never renders half a bundle or a broken link. Committing a
  file *without* referencing it is fine and is the normal way to build
  the bundle in stages: land `example.pipe` first, add `example.png` and
  the two references together once the pipeline has been screenshotted.
  Until then the node gets a validator warning, not a failure. New nodes
  ship the complete bundle.
- Further examples follow the same title → flow → prose format (no files
  required).

Examples must be real, runnable shapes using nodes that exist — no
hypothetical node names.

## 4. `## Connections` — CONDITIONAL

**Trigger:** a service entry declares an `invoke` object.

| Connection | Required | Description |
|---|---|---|

- Exactly one row per key in `invoke`. Required = "yes" when `min ≥ 1`.
- Connection names must match the `invoke` keys.

## 5. `## Lanes` — CONDITIONAL

**Trigger:** a service entry declares a non-empty `lanes` object.

| Lane in | Lane out | Description |
|---|---|---|

- One row per in→out pair declared in `lanes` (an input with multiple
  outputs gets one row per output; an input with no output gets `—`).
- Lane names must match `services*.json` exactly.

## 6. `## As a tool` — CONDITIONAL

**Trigger:** `"tool"` ∈ `classType`.

What an agent sees when this node is connected as a tool: the tool server
name and one row per exposed function.

| Function | Description |
|---|---|

- Describe arguments and return values beneath the table when non-obvious.
- This section is the agent-facing contract — it has the highest accuracy
  bar in the file.

## 7. `## Profiles` — CONDITIONAL

**Trigger:** `preconfig.profiles` contains ≥ 2 entries other than `custom`.

| Profile | Model | Context |
|---|---|---|

- List exactly the declared profiles, default marked `*(default)*`. Column
  names after the first may be adapted to the node.

## 8. `## Configuration` — CORE

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

## 9. `## Authentication` — OPTIONAL

Credentials setup: which key/token the node needs, required scopes, where
to obtain it, and the expected format. Keep instructions structural
(scopes, format) rather than duplicating vendor UI walkthroughs that go
stale.

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
- shipped example bundle: referencing either half obliges the other, every
  referenced file exists, and the screenshot carries alt text; an
  unreferenced file — or no bundle at all — is a warning, not a failure
- `## About` ≤ 80 words, first section, with `## Upstream docs` present
- warns when a field with objective complexity signals (a `textarea`
  widget or a large enum) lacks a `###` subsection under `## Configuration`

The validator checks structure, not truth. Whether the prose accurately
describes the code is a review concern (CodeRabbit on the PR, plus the
release documentation pass).
