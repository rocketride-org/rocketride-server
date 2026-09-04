# Semantic pipeline diff: raw JSON vs. `rocketride diff`

A `.pipe` file is JSON, so `git diff` "works" on it — but the output is mostly
noise. Every component carries a `ui` block whose `position.x` / `position.y`
change whenever you nudge a node on the canvas, and the top-level `viewport`
shifts when you pan or zoom. None of that changes what the pipeline *does*, yet it
dominates the diff and buries the changes that matter.

`rocketride diff` is a **semantic** diff for `.pipe` files. It compares the parts
that affect behavior — nodes, wiring, and config — and collapses all canvas churn
into a single line. This page shows the exact same change through both lenses.

## The change

Someone upgraded a RAG pipeline in one commit:

- **Swapped the LLM** from OpenAI to Anthropic (`llm_openai` → `llm_anthropic`,
  with the matching profile/key config).
- **Tightened the prompt** — added a "cite your sources" instruction.
- **Inserted a reranker** (`reranker_cohere`) between retrieval and the prompt, so
  the `documents` lane now flows `qdrant_1 → reranker_1 → prompt_1` instead of
  `qdrant_1 → prompt_1`.
- ...and, incidentally, **tidied the canvas** — nudged every node a few pixels and
  zoomed out a little.

Three real changes. One cosmetic one. Here is what each tool shows.

## What a raw `git diff` shows

Of the **69** added/removed lines in the raw diff, **33 are pure canvas
coordinates** — nearly half the diff is noise, and it's interleaved with the real
changes so a reviewer has to hunt for them. Excerpt (repetitive `x`/`y` hunks
elided):

```diff
@@ -11,8 +11,8 @@
       },
       "ui": {
         "position": {
-          "x": 20,
-          "y": 500
+          "x": 32,
+          "y": 512
         },
         "measured": {

@@ ... 5 more identical x/y position hunks, one per node ... @@

@@ -80,18 +80,45 @@
       }
     },
     {
+      "id": "reranker_1",
+      "provider": "reranker_cohere",
+      "config": {
+        "profile": "rerank-3",
+        "parameters": {},
+        "topN": 5
+      },
+      "input": [
+        { "lane": "documents", "from": "qdrant_1" }
+      ],
+      "ui": {
+        "position": { "x": 690, "y": 380 },
+        "measured": { "width": 150, "height": 66 },
+        "nodeType": "default",
+        "formDataValid": true
+      }
+    },
+    {
       "id": "prompt_1",
       "provider": "prompt",
       "config": {
         "instructions": [
-          "Answer using only the retrieved context."
+          "Answer using only the retrieved context. Cite the source document for every claim."
         ],
         "parameters": {}
       },
       "input": [
         {
           "lane": "documents",
-          "from": "qdrant_1"
+          "from": "reranker_1"
         },

@@ -113,11 +140,11 @@
     {
       "id": "llm_1",
-      "provider": "llm_openai",
+      "provider": "llm_anthropic",
       "config": {
-        "profile": "openai-4o",
-        "openai-4o": {
-          "apikey": "${ROCKETRIDE_OPENAI_KEY}"
+        "profile": "claude",
+        "claude": {
+          "apikey": "${ROCKETRIDE_ANTHROPIC_KEY}"
         },
         "parameters": {}
       },

@@ ... 3 more x/y position hunks ... @@

@@ -168,9 +195,9 @@
   "project_id": "1327e7c0-8479-4ab7-a319-c4dc944daeb5",
   "viewport": {
-    "x": 0,
-    "y": 0,
-    "zoom": 1
+    "x": -120,
+    "y": -40,
+    "zoom": 0.85
   },
   "version": 1
 }
```

To review this, you scroll past six coordinate hunks and a viewport change to find
the three lines that actually matter — and it's on you to notice that the
`prompt_1` input silently switched from `qdrant_1` to `reranker_1`.

## What `rocketride diff` shows

```bash
rocketride diff old.pipe new.pipe
```

```text
Pipeline diff: 1 node added, 2 nodes changed, 2 edges added, 1 edge removed, layout changed

Nodes
  + reranker_1 (reranker_cohere)
  ~ llm_1 provider: llm_openai -> llm_anthropic

Edges
  + qdrant_1 --documents--> reranker_1
  + reranker_1 --documents--> prompt_1
  - qdrant_1 --documents--> prompt_1

Config
  llm_1
    + config.claude = {"apikey": "${ROCKETRIDE_ANTHROPIC_KEY}"}
    - config.openai-4o = {"apikey": "${ROCKETRIDE_OPENAI_KEY}"}
    ~ config.profile: openai-4o -> claude
  prompt_1
    ~ config.instructions[0]: Answer using only the retrieved context. -> Answer using only the retrieved context. Cite the source document for every claim.

Layout: changed (ui/viewport)
```

Every real change is called out — including the rewire, shown explicitly as a
removed edge (`qdrant_1 --documents--> prompt_1`) plus two added edges through the
new reranker — and the entire canvas cleanup is one honest `Layout: changed` line.
The command exits `1` because there are semantic changes; a pure canvas move would
exit `0`. (Pass `--include-layout` if you *do* want the individual `ui.*`
coordinates enumerated.)

## For a PR comment: `--markdown`

`--markdown` renders the same diff as a compact, comment-safe report — the form
the CI job below posts on the pull request:

```markdown
**Pipeline diff:** 1 node added, 2 nodes changed, 2 edges added, 1 edge removed, layout changed

**Nodes**
- + `reranker_1` (`reranker_cohere`)
- ~ `llm_1` provider: `llm_openai` → `llm_anthropic`

**Edges**
- + `qdrant_1` --`documents`--> `reranker_1`
- + `reranker_1` --`documents`--> `prompt_1`
- - `qdrant_1` --`documents`--> `prompt_1`

**Config**

| Node | Field | Change |
| --- | --- | --- |
| `llm_1` | `config.claude` | + `{'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'}` |
| `llm_1` | `config.openai-4o` | - `{'apikey': '${ROCKETRIDE_OPENAI_KEY}'}` |
| `llm_1` | `config.profile` | `openai-4o` → `claude` |
| `prompt_1` | `config.instructions[0]` | `Answer using only the retrieved context.` → `Answer using only the retrieved context. Cite the source document for every claim.` |

_Layout (ui/viewport) changed._
```

That is exactly what `--markdown` prints — there is no title. The pipe-diff action
adds the per-file `### <file>` heading and the `## RocketRide pipeline diff`
heading around it when it assembles the comment.

There's also `--json`, a single stable, sorted document (`nodes`, `edges`, and a
`summary` block) for feeding other tooling. See the
[CLI reference](../docs/README-python-client.md#semantic-pipeline-diff-rocketride-diff)
for every flag and exit code.

## Use it in CI (the pipe-diff GitHub Action)

Because the comparison is local, needs no engine, and exits non-zero on change,
`diff` drops straight into a pull-request check. The supported integration is the bundled
[`pipe-diff` composite action](../.github/actions/pipe-diff/), which finds **every**
changed `.pipe`, diffs each against the PR base, and posts one **sticky PR comment**
so reviewers see the semantic change instead of the coordinate noise:

```yaml
# .github/workflows/pipe-diff.yml
name: Pipeline diff
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      # default fetch-depth: 1 is fine; the action fetches the base itself
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: rocketride-org/rocketride-server/.github/actions/pipe-diff@develop
```

Every `uses:` runs with the job's token, so pin each one to a full commit SHA
(keep the `# v4` comment for readability) instead of a mutable tag or branch: a
retagged action changes what your job executes. Pin `@develop` to a tag or commit
SHA the same way once the action is released. Inside this
repository the local form `uses: ./.github/actions/pipe-diff` works too, but it
resolves only here — another repository has no such directory on disk.

The action installs the CLI, resolves the PR base commit (fetching it under the
default shallow checkout), and updates a single comment in place on re-runs. Its
[README](../.github/actions/pipe-diff/README.md) documents the `files`,
`cli-version`, `install-from`, `comment`, and `include-layout` inputs.

Two things worth knowing before you wire it up:

- **Fork pull requests.** On a `pull_request` event from a fork the default
  `GITHUB_TOKEN` is read-only whatever `permissions:` says, so the comment API
  returns `403`. The action warns instead of failing and every run also writes the
  report to the job summary, so the diff is still there. Use `comment: false`, or
  `pull_request_target` (never checking out the PR head's code from it), if you
  need something else.
- **Before the CLI release.** `rocketride diff` ships in a release after 1.3.0;
  until then pass `install-from: ./packages/client-python` so the action installs
  the CLI from a checkout rather than PyPI.

If you would rather not vendor the composite action, the same result can be
assembled inline for a single file — check out with `fetch-depth: 0` so the base
branch is present for `--git`, then diff and post the Markdown yourself:

```yaml
# Alternative: inline equivalent of the composite action, for a single file.
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          fetch-depth: 0 # need the base branch for `git show`
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5
        with:
          python-version: "3.12"
      # `rocketride diff` ships in a release AFTER 1.3.0: until then `pip install
      # rocketride` installs a CLI without the subcommand and the next step fails
      # with "invalid choice: 'diff'". Install the client package from a checkout
      # of this repository instead -- the path below resolves only here, so from
      # another repository use the pinned remote form instead: pip install
      # "rocketride @ git+https://github.com/rocketride-org/rocketride-server@<full-commit-sha>#subdirectory=packages/client-python".
      # Switch to `pip install "rocketride==<release>"` once a release provides `diff`.
      - run: pip install ./packages/client-python
      - name: Semantic diff of the pipeline
        run: |
          rocketride diff --git "origin/${{ github.base_ref }}" rag.pipe \
            --markdown --exit-zero | tee pipe-diff.md
      - name: Comment on the PR
        uses: marocchino/sticky-pull-request-comment@773744901bac0e8cbb5a0dc842800d45e9b2b405 # v2.9.4
        with:
          path: pipe-diff.md
```

`--exit-zero` keeps the comment step from being skipped when changes exist. Drop
`--exit-zero` (and the sticky-comment step) if you'd rather the job **fail** the
check whenever a pipeline changes and require an explicit review.

## Why this matters

This is the review half of treating **pipelines as code**: **validate** a `.pipe`
to confirm it is well-formed before it ever runs, **evaluate** it to measure output
quality, and **diff** it to see exactly what changed between revisions — the same
lint / test / review loop teams already run on their source, now applied to their
AI pipelines. A reviewer approving "OpenAI → Anthropic, added a reranker, tightened
the prompt" is reviewing the pipeline; a reviewer squinting at `"x": 900` → `"x":
1120` is reviewing the canvas. `rocketride diff` makes sure they only ever have to
do the first.
