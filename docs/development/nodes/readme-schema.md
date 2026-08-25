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

<!--
PARKED — `## Example pipelines` (shipped example: screenshot + .pipe download).

Deferred until the node READMEs have been migrated to this schema. The
supporting machinery stays in place (the validator's bundle checks are
parked alongside this, and the docs build already rewrites relative
example refs), so restoring it is: uncomment this block, re-number the
sections below, and un-park the matching checks in
scripts/validate-node-readme.py.

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

<div align="center">

![The ocr node wired between a webhook source and summarization on the canvas](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>

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
  hand-write absolute URLs. Relative is also what makes the button work
  best in the IDE: the extension registers a custom editor for `*.pipe`,
  so clicking it there opens the pipeline straight onto the canvas.
- Keep the **blank lines inside the `<div>`** exactly as shown. They are
  load-bearing: a blank line ends the HTML block, so the image and badge
  are parsed as markdown while the wrapper still centres them. Written as
  raw `<img>`/`<a>` tags instead, the block renders on GitHub but comes up
  empty in the VS Code / Cursor markdown preview, which only rewrites
  relative paths for markdown-syntax images.
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
-->

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

Every declared profile appears exactly once.

The `Profile` cell identifies the profile by **either its declared key, written
as code (`gpt-5-5`), or its declared `title` reproduced exactly**. A cell may
carry both (`` Profile 1 (`profile-1`) ``). Anything else — a display name the
metadata does not declare, an abbreviation, a re-cased title — is an unknown
row and fails, because a reader cannot map it back to what the configuration
panel shows. Pick one of the two forms and use it for every row in a node;
`custom` is always written as `` `custom` ``. Correct a metadata `title` that
reads badly in a table rather than paraphrasing it here.

The introductory sentence names the declared default profile, bolding its title
and giving its key: `Default: **Profile 1** (`profile-1`).` The default's own
row is marked `**(default)**` after the profile name. The validator accepts any
markdown decoration around `(default)` so that older pages keep passing, but
bold is the form to write.

Column names after `Profile` may be adapted to the provider, but when
`Model`/`Model ID`, `Context`/`Context tokens`, or `Output`/`Output tokens` is
present, its values must match `model`, `modelTotalTokens`, or
`modelOutputTokens` in the profile metadata.

For a node whose merged `classType` does not contain `llm`, or whose merged
metadata declares six or fewer profiles, use one ordinary table. A `<details>`
block is forbidden in this layout.

For a node whose merged `classType` contains `llm` and whose merged metadata
declares more than six profiles, use two tables:

1. A visible table containing **up to six** unique profiles — six is a ceiling,
   not a quota. Put the declared default first, then profiles from the two
   newest recognizable release groups, newest group first. Stop when those
   groups are exhausted or the table reaches six rows, whichever comes first;
   padding the table with older models to reach six defeats the point of the
   collapse. For a node that fronts several vendors' catalogues (`llm_bedrock`,
   `llm_ollama`, `llm_gmi_cloud`), "release group" is read per vendor: show the
   newest group of each vendor a reader is likely to be choosing between, and
   never leave a vendor's newest generation collapsed while an older one from
   the same vendor is visible.
2. A table inside one native `<details>` block containing every remaining
   profile. `custom` and profiles marked `deprecated` must be here.

Use this exact shape (the columns after `Profile` may be adapted, but both
tables use the same columns):

```markdown
## Profiles

Default: **GPT-5.2** (`openai-5-2`).

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `openai-5-2` **(default)** | `gpt-5.2` | 400,000 | 128,000 |
| `gpt-5-6-sol` | `gpt-5.6-sol` | 1,050,000 | 128,000 |
| `gpt-5-6-terra` | `gpt-5.6-terra` | 1,050,000 | 128,000 |
| `gpt-5-6-luna` | `gpt-5.6-luna` | 1,050,000 | 128,000 |
| `gpt-5-5` | `gpt-5.5` | 1,050,000 | 128,000 |

<details>
<summary><strong>View 2 more models</strong></summary>

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `openai-5-4` | `gpt-5.4` | 400,000 | 128,000 |
| `custom` | _(user-specified)_ | editable | editable |

</details>
```

The summary text is exactly `View N more models`, where `N` is the number of
rows in the collapsed table. Keep the blank line after `</summary>` and the
blank line before `</details>`; both are required for CommonMark renderers to
parse the nested table. A large-layout default cannot be `custom` or
deprecated, because the default must be visible while those profiles must be
collapsed; correct inconsistent metadata rather than changing the documented
default.

Profile counts and row parity in a multi-service directory use the combined
profiles from all protocol-bearing `services*.json` entries. `###` service
labels may be added when useful, but the combined profile set is validated
once for the directory.

**Each protocol-bearing service keeps its own default.** A second registration
is a separate node to the engine — a branded preset (`llm_openai_api`'s Nebius
service), a second provider (`cloud_tts`'s OpenAI and ElevenLabs), or a second
backend (`store_elasticsearch`'s Elasticsearch and OpenSearch) — so its
`preconfig.default` is a fact about that service, not a competing claim about
the primary one. In a combined table, mark **every** service's default row and
name each one in the introduction:

```markdown
Primary default: **Primary A** (`primary-a`). Secondary default: **Secondary A** (`secondary-a`).
```

Say in one sentence which registration each default belongs to; two unexplained
`**(default)**` markers read as a contradiction. In the large layout the primary
service's default still leads the visible table, and no service's default may be
collapsed.

Release recency is review judgment. Service metadata has no dependable
release dates or newest-first order, so the deterministic validator does not
infer whether the visible release groups are the newest.

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

## 9. `## Requirements` — CONDITIONAL

**Trigger:** `"gpu"` ∈ `capabilities`.

Hardware/runtime requirements: GPU, VRAM, local model downloads, CPU
fallback behavior.

## 10. `## Limitations` — CONDITIONAL

**Trigger:** any of `nosaas`, `noremote`, `security`, `filesystem`
∈ `capabilities`.

Where the node can and cannot run, and any security-relevant behavior
(filesystem access, network access, SaaS exclusion), in plain language.

## 11. `## Notes` — OPTIONAL

The only free-form section. Anything genuinely node-specific:
troubleshooting, compatibility quirks, algorithm details, test
instructions. Use `###` subsections. Must not duplicate content owned by a
structured section.

## 12. `## Upstream docs` — OPTIONAL

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
- table parity: Connections rows = `invoke` keys and Lanes rows = declared
  lanes
- exact Profiles parity across merged services: every declared profile appears
  once, with separate failures for missing, duplicate, and unknown rows
- every protocol-bearing service's declared default appears in the introduction
  (key, and title in bold) and is marked on its row, with nothing else marked;
  for large LLM lists the primary service's default is also the first visible
  row and no service's default is collapsed
- ordinary profile sections have one table and no `<details>`; large LLM
  sections have one visible table plus one collapsed table, at most six
  visible rows, and `custom`/deprecated rows collapsed
- the large-layout summary uses the exact hidden-row count, and the required
  blank lines surround the nested table
- rendered model identifiers and context/output token values match declared
  profile metadata when those semantic columns are present (Markdown
  decoration and numeric thousands separators are ignored)
- the generated region, when present, is last and unmodified in shape
- `## About` ≤ 80 words, first section, with `## Upstream docs` present
- warns when a field with objective complexity signals (a `textarea`
  widget or a large enum) lacks a `###` subsection under `## Configuration`

The validator checks structure, not truth. Whether the prose accurately
describes the code is a review concern (CodeRabbit on the PR, plus the
release documentation pass).
