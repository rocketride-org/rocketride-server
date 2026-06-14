# check-externals: 3rd-party interface contract tests

Catches breaking API changes in upstream Python packages **before** they ship to customers.

## Why this exists

In May 2026, `img2table 2.0` moved `OCRInstance` from `img2table.ocr.base` to `img2table.ocr._types`. Our OCR node started failing in production with `No module named 'img2table.ocr.base'`. The fix landed in [commit c4aa67921](https://github.com/aparavi/rocketride-server/commit/c4aa67921), but only **after** the breakage shipped, we found out from a customer.

This tool catches the next one in CI instead.

## What it does

For every `.py` file in `nodes/`, `packages/ai/`, `packages/client-python/`, and `packages/server/engine-lib/rocketlib-python/`, the framework:

1. Walks the AST to find every third-party `import` and every attribute chain you use on the imported objects.
2. Builds a per-component contract automatically, no manual work needed for ~90% of code.
3. At test time, tries to import each symbol and walk each chain against the **installed** package versions. If anything is missing, the test fails and names the broken `(tree, component, package)`.

It never calls real APIs. It only loads modules and reads attributes.

## Run it locally

```sh
# Full suite (builds engine + all 4 trees first)
./builder.cmd check-externals:run

# Force a fresh constraint resolution (deletes the engine's constraints cache)
./builder.cmd check-externals:run --rebuild-cache

# Filter to one package / one node (substring match on `<tree>/<component>/<package>`)
./builder.cmd check-externals:run --pattern=twelvelabs

# Unit tests for the framework itself (fast — only builds the engine)
./builder.cmd check-externals:test
```

## Options reference

There are two ways to invoke the framework: via `builder` (recommended; handles build deps + engine resolution) or directly under the engine binary (faster iteration; assumes everything is already built). The flag set differs slightly between the two layers.

### Builder flags (`./builder.cmd check-externals:run|test`)

| Flag | Applies to | What it does |
| ---- | ---------- | ------------ |
| `--rebuild-cache` | `:run` | Deletes `<engine>/cache/constraints.txt` AND `<engine>/cache/requirements.hash`, forcing `ensure_constraints()` to recompile via `uv pip compile` from scratch. Used by the nightly cron lane to catch fresh upstream releases. |
| `--pattern=SUBSTR` | `:run`, `:test` | Generic substring filter passed to the underlying invocation. For `:run` it filters triple ids (`<tree>/<component>/<package>`). For `:test` it maps to pytest's `-k` expression. **Repeatable**, multiple `--pattern=` values combine with OR semantics for `:run` (forwarded as separate `--pattern` flags to the CLI), and are joined with ` or ` into a single `-k` expression for `:test` (pytest only accepts one `-k`). |
| `--pytest-pattern=EXPR` | `:run`, `:test` | Back-compat alias. Single-value (overwrites on repeat). Same behavior as `--pattern` for `:run`; reaches pytest's `-k` for `:test`. Prefer `--pattern` going forward, especially when you want repeat semantics. |

Plus the standard global builder flags (`--verbose`, `--force`, `--log=FILE`, etc.), see `./builder.cmd --help` for the full list.

### Direct CLI flags (`engine tools/contract_checks/cli.py`)

Use these when the engine + trees are already built and you want a faster inner loop without the builder pipeline. Same `check-externals:run-checks` action runs internally, just without the build-step preamble.

**Flags marked "repeatable" below can be specified multiple times**, repeated values combine with **OR semantics within the flag** (any match accepts the row), **AND across flags** (e.g., `--tree=nodes --tree=ai --package=requests` = "rows where tree ∈ {nodes, ai} AND package == requests").

| Flag | Repeatable? | What it does |
| ---- | ----------- | ------------ |
| `--tree=NAME` | yes | Limit the run to one or more configured trees. Valid names: `nodes`, `ai`, `client-python`, `rocketlib` (see [trees.py](src/contract_checks/trees.py) for the full list). Omit to run all four. Multiple: `--tree=nodes --tree=ai`. |
| `--package=NAME` | yes | Limit checks to one or more third-party packages by **exact top-level name** (e.g., `requests`, `img2table`, `twelvelabs`). Walks every tree+component but only reports rows for those packages. Multiple: `--package=requests --package=img2table`. |
| `--pattern=SUBSTR`, `-k SUBSTR` | yes | **Substring** filter on the full triple id `<tree>/<component>/<package>`. Looser than `--package`: `--pattern=db_` matches `db_mysql`, `db_neo4j`, etc. Multiple-pattern OR: `--pattern=img --pattern=twelve` matches either substring. |
| `--requirements=FILE` | yes | Limit checks to packages listed in the given `requirements.txt`. Reads the file, normalises distribution names per PEP 503 (`PyYAML` → `pyyaml`), then maps them to Python module names via `importlib.metadata.packages_distributions()` (so `Pillow` correctly resolves to `PIL`). Useful for "*I just bumped this requirements file, verify everything it affects.*" Multiple files: the resolved package sets are unioned. |
| `--no-install` | no | Skip the per-component `depends()` calls entirely. Only verifies what's already installed in the engine's site-packages. Big speedup for iteration when you know the env is already correct; misses packages that need installing. |
| `--fail-on-missing` | no | Treat "package not installed in engine env" as a hard failure instead of a `[SKIP]`. Default behavior is skip, the lane's job is to flag interface drift, not absence. Useful when you want to confirm everything that *should* be installed actually is. |
| `--install-all` | no | Ignore `# contract-check: skip-install` markers in requirements files and attempt to install every `requirement*.txt` under the scanned trees. PR lanes respect the markers (fast); nightly cron lanes use this flag for full coverage. See [`# contract-check: skip-install`](#-contract-check-skip-install) below. |
| `--verbose`, `-v` | no | Print `OK` and `SKIP` rows in addition to `FAIL`. **Default is FAIL-only**: the framework stays quiet when everything is green so red rows pop out, and the summary line (`N passed, M skipped, K failed`) always prints regardless. Turn on for debugging or when you want to confirm exactly which entries the framework saw and skipped. |

### Examples

```sh
# Verify everything across all four trees (slow first time; cached after)
./builder.cmd check-externals:run

# Just the twelvelabs node, full builder pipeline
./builder.cmd check-externals:run --pattern=twelvelabs

# Iterate on the framework — direct invocation, only verify packages already installed
engine tools/contract_checks/cli.py --tree=nodes --package=img2table --no-install

# Verify everything affected by a requirements.txt change (useful before pushing a dep bump)
engine tools/contract_checks/cli.py --requirements=nodes/src/nodes/db_mysql/requirements.txt

# Two trees at once
engine tools/contract_checks/cli.py --tree=nodes --tree=ai

# Two packages, OR semantics — see rows for either
engine tools/contract_checks/cli.py --package=img2table --package=twelvelabs

# Two substring patterns, OR semantics — matches "img2table" AND "twelvelabs" rows
engine tools/contract_checks/cli.py --pattern=img --pattern=twelve

# Two requirements files: union of packages from both
engine tools/contract_checks/cli.py --requirements=nodes/src/nodes/db_mysql/requirements.txt --requirements=nodes/src/nodes/db_neo4j/requirements.txt

# Verbose: also print OK and SKIP rows (default is FAIL-only)
engine tools/contract_checks/cli.py --tree=nodes --package=img2table --verbose

# Confirm the engine env has everything (no skips allowed)
engine tools/contract_checks/cli.py --fail-on-missing

# Nightly cron pattern: fresh constraint resolution + full run + install everything
./builder.cmd check-externals:run --rebuild-cache --install-all
```

## What gets checked **automatically** (no work for you)

If you write normal Python in a normal node, the framework already covers:

- Plain `import X` and `from X import Y`, verified to still resolve.
- `from X import Y` inside a function body, not just at the top of the file.
- `try / except ImportError` shims that swap import paths for version compatibility (rerouted to an `any_of` group automatically).
- SDK client patterns like `client = SomeSDK(...); client.foo.bar(...)`, the AST follows the variable assignment, generates a safe construction with dummy args (strings become `"x"`, ints become `0`), and walks the attribute chain.

For most new nodes you don't have to add anything. Just write code; the framework finds the contracts.

## When you **do** need a manifest

A manifest is a small Python file at `<your-node>/external_contracts.py`. Add one when:

1. **An upstream symbol is version-gated**: e.g., a module that was renamed or removed across major versions. Use `applies_when='<2.0'` (see [Version-gated entry](#version-gated-entry-applies_when) below) so the framework skips the check on installed versions that don't apply, instead of failing.
2. **You want a heavy-class chain to be a hard requirement, not best-effort.** Auto-extracted heavy classes are best-effort: if construction with dummy args can't succeed, the check is silently demoted to SKIP (see [Auto-extracted vs manifest: the trust gradient](#auto-extracted-vs-manifest-the-trust-gradient) below). Declaring the heavy class in a manifest with a safer `construct` expression turns the chain check into a hard FAIL on breakage, a real CI assertion instead of a best-effort one.
3. **You want to lock in coverage even after refactors**: manifests survive code reorganizations that move the constructor call between functions.
4. **You need to express a multi-version contract** more explicitly than `try/except` (e.g., when version-detection isn't via `ImportError`).

For false positives **and** for legitimately-optional imports, prefer the inline comment over a manifest:

```python
import some_optional_dep  # contract-check: ignore  reason: loaded only when feature X is on
```

The marker is the right tool for two related shapes:

- **False positive**: the framework auto-detected a third-party import that's actually loaded through some indirect mechanism (importlib, plugin loader, configuration-driven dispatch) and shouldn't be statically verified.
- **Defensive optional**: the consuming code wraps an import in a permissive try/except with a default fallback. The framework's auto-detection only treats *narrow* `except (ImportError, ModuleNotFoundError):` as an import guard; broader catches like `except Exception:` (intentional in some defensive shims to also catch attribute-access errors during a downstream patching dance) leave the inner import flagged as required. Mark those imports with `# contract-check: ignore` so the framework matches the author's intent.

Real examples from this repo:

```python
# nodes/src/nodes/llm_anthropic/anthropic.py — optional monkey-patch
try:
    import langchain_core.utils.tokenization as _tok  # contract-check: ignore  optional monkey-patch path; outer except handles absence
    ...
except Exception:
    pass

# nodes/src/nodes/llm_mistral/IGlobal.py — falls back to built-in Exception
try:
    from mistralai.exceptions import MistralException  # contract-check: ignore  optional, falls back to built-in Exception
except Exception:
    MistralException = Exception

# nodes/src/nodes/pinecone/IGlobal.py — moved between pinecone versions
try:
    from pinecone.core.client.exceptions import ApiException as _ApiException  # contract-check: ignore  optional, path moved between pinecone versions; outer handler covers absence
    ...
except Exception:
    pass
```

Always include a short *why* after the marker, it saves the next maintainer a `git blame` trip.

## `# contract-check: skip-install`

Two sibling markers for **requirements files** (a parallel to `# contract-check: ignore` for Python imports). The framework's install hook recursively walks every `requirement*.txt` under each scanned tree (matching the engine's own `requirement*.txt` glob) and feeds each to `depends()`. Two markers opt files out, with different strengths:

| Marker | Default lane behaviour | Under `--install-all` | Use for |
| ------ | ---------------------- | --------------------- | ------- |
| `# contract-check: skip-install` | Skip: `[skip-install]` line | **Installs**: `[install-all]` bypass line | Heavy Tier-2 bundles (kokoro, whisper, etc.). PR lane fast; nightly verifies. |
| `# contract-check: disable` | Skip: `[disable]` line | **Still skipped**: `[disable]` line, no bypass | Fundamental incompatibilities (surya/trocr's opencv pin) where attempting install just produces a guaranteed `[install-failed]`. Paired with `# contract-check: ignore` on the consuming imports so the contract isn't checked either. |

`disable` is strictly stronger than `skip-install`. If a file has both, `disable` wins.

Mark a file by placing the marker on its own comment line (typically at the top so it's the first thing a reader sees):

```text
# contract-check: disable  reason: surya transitively pins opencv-python-headless==4.11.0.86; the ai.common.opencv runtime shim handles the override; uv can't replay it.
surya-ocr>=0.17.0
…
```

### Output routing

Install-layer status lines (`[disable]`, `[skip-install]`, `[install-all]`, `[install]`) go to **stdout** alongside the contract check output (`[OK]`/`[SKIP]`/`[FAIL]`). A single redirect captures the full transcript. Only `[install-failed]` goes to **stderr** since it's a real failure event.

### Effects in detail

- **Default PR lane** (`./builder.cmd check-externals:run`): both markers cause the file's `depends()` call to be bypassed. Stdout shows `[skip-install] <path>: <reason>` or `[disable] <path>: <reason>` so the bypass is visible in CI logs. Packages stay uninstalled; their contract rows show `[SKIP] package not installed in engine env` (unless paired with `# contract-check: ignore` on the imports, in which case there's no contract row at all, see the surya/trocr pattern below).
- **Nightly cron lane** (`./builder.cmd check-externals:run --install-all`):
  - `skip-install`-marked files: marker is **ignored**. Stdout shows `[install-all] <path>: bypassing skip-install marker`, then `depends()` is called. Most succeed; contracts get verified.
  - `disable`-marked files: marker is **honoured**. Stdout shows the same `[disable]` line as the PR lane. `--install-all` does not override `disable`, that's the whole point of the stronger marker.

### `[install-failed]` (stderr)

When `depends()` raises for a file that was attempted (i.e., NOT `disable`d AND either unmarked or `skip-install` + `--install-all`), the framework prints one stderr line and moves on:

```text
[install-failed] /path/to/requirements_kokoro.txt: RuntimeError: uv pip install error: ...
```

This is the drift signal for the install layer itself. If a previously-installable file starts failing, the `[install-failed]` line appears in nightly logs and we can act. Files with fundamental conflicts should use `disable` precisely so they never reach this branch, `[install-failed]` lines are reserved for unexpected failures.

### What's currently marked (9 files)

| Marker | File | Why marked | Paired `# contract-check: ignore` on imports? |
| ------ | ---- | ---------- | --- |
| `disable` | `packages/ai/src/ai/common/models/ocr/requirements_surya.txt` | `opencv-python-headless==4.11.0.86` transitive pin | Yes: 3 imports in `surya.py` |
| `disable` | `packages/ai/src/ai/common/models/ocr/requirements_trocr.txt` | `opencv-python<4.5.4.62` transitive pin (via craft-text-detector) | Yes: 1 import in `trocr.py` |
| `skip-install` | `packages/ai/src/ai/common/models/audio/requirements_kokoro.txt` | ~200 MB audio model deps | No: verified on nightly |
| `skip-install` | `packages/ai/src/ai/common/models/audio/requirements_whisper.txt` | ~400 MB ASR deps (ctranslate2, av, onnxruntime) | No |
| `skip-install` | `packages/ai/src/ai/common/models/gliner/requirements_gliner.txt` | ~300 MB NER deps + mecab C compile | No |
| `skip-install` | `packages/ai/src/ai/common/models/ocr/requirements_doctr.txt` | ~50 MB OCR engine on top of torch | No |
| `skip-install` | `packages/ai/src/ai/common/models/ocr/requirements_easyocr.txt` | ~150 MB OCR engine + CRAFT detector | No |
| `skip-install` | `packages/ai/src/ai/common/models/transformers/requirements_sentence_transformers.txt` | ~100 MB embedding loader | No |
| `skip-install` | `packages/ai/src/ai/common/models/vision/requirements_vision.txt` | ~50 MB vision embeddings | No |

The `disable` files are paired with import-line ignores because they will *never* be installable, verifying their contracts would always SKIP and add noise. The `skip-install` files keep their imports unmarked because nightly `--install-all` installs them and can actually verify the contracts.

### When to add a new marker

Use **`skip-install`** when:

- A new `requirement*.txt` file whose install costs >100 MB AND whose package is feature-opt-in (consumer code only loads it on demand).
- You want PR-lane speed but nightly verification.

Use **`disable`** when:

- A file's install reproducibly fails uv resolution against the engine's pinned constraints AND the conflict isn't going to resolve (typically a transitive opencv/torch/numpy pin override handled by a runtime shim).
- You've confirmed the consuming code handles the package being absent (typically via try/except), so contract verification is meaningless without install.
- **Also add `# contract-check: ignore` on every import of that package's modules** so the framework doesn't try to verify a contract whose dependency is permanently absent.

When in doubt: don't mark it. The lost coverage is real; the install cost is amortized by uv's cache after the first run on each CI agent.

## Auto-extracted vs manifest: the trust gradient

The framework has two sources of contract entries, and they earn different levels of CI authority:

| Source | Origin | On construction success | On construction failure |
| ------ | ------ | ----------------------- | ----------------------- |
| **Auto-extracted** | AST walker guesses from `x = callable(...); x.foo(...)` patterns | `OK`: full chain coverage | **`SKIP`**: "framework guessed, guess didn't pan out" |
| **Manifest** | Maintainer wrote `HeavyClass(...)` in `external_contracts.py` | `OK`: assertion holds | **`FAIL`**: "maintainer asserted this works and it doesn't" |

The reasoning: auto-extracted entries are best-effort. The AST treats any `x = something(...); x.attr(...)` shape as a possible SDK pattern, including things that aren't classes (`sqlalchemy.create_engine`, `transformers.pipeline`, `doctr.models.ocr_predictor`, all factory *functions*). When the framework can't fabricate args that satisfy the callable, that's not real upstream drift, it's the framework being too aggressive. Failing CI on a guess that didn't work out trains everyone to ignore the lane.

Manifest entries are different. When you write a `HeavyClass` in `external_contracts.py`, you're asserting three things:

1. The qualname is a real class.
2. It can be constructed with the given expression without I/O.
3. The constructed instance has every declared chain.

If any of those breaks, **something the maintainer signed off on is no longer true**, exactly the signal the framework exists to produce. Hard fail.

Two safety rails enforce the distinction:

- **`inspect.isclass` gate.** The runner refuses to `eval()` the construct expression at all unless the target is a real class. Catches factory-function false positives before they can do real I/O. Applies to both auto-extracted and manifest entries (a manifest entry with the wrong qualname gets a clear "not a class" error).
- **Restricted `eval` builtins.** Construction runs with builtins locked to a whitelist of pure data constructors. A `construct` string can't reach `open`, `__import__`, or `exec`, so a typo or a bad manifest can't drive I/O through the eval.
- **Source-tagged demotion.** Auto-extracted entries carry a `source='<file>:<line>'` marker. The CLI dispatch checks for that marker and downgrades any construction failure to `SKIP`. Manifest entries leave `source=''`, so failures pass through as `FAIL`.

**Implication for contributors:** if you want a chain check to be a hard CI requirement, add a manifest entry for it. If you just want the framework to verify it when it can, leave the AST to do its job.

## Manifest file shape

All manifests look like this:

```python
from contract_checks.manifest import ComponentManifest

MANIFEST = ComponentManifest(
    # zero or more of each field below
)
```

The framework looks for the module-level `MANIFEST` variable. If the file isn't present, the contract is the auto-extracted one.

### Heavy class (for SDK clients)

Use when the SDK populates client attributes in `__init__` and you want to lock down which attributes your code uses:

```python
from contract_checks.manifest import ComponentManifest, HeavyClass

MANIFEST = ComponentManifest(
    heavy_classes=(
        HeavyClass(
            qualname='somesdk.Client',
            construct='Client(api_key="x")',     # MUST be side-effect-free
            attr_chains=(
                'users.list',
                'users.get',
                'projects.create',
            ),
        ),
    ),
)
```

Rules for `construct`:

- It is `eval()`'d in a namespace holding the imported class plus a whitelist of pure data-constructor builtins (`set`, `dict`, `list`, `bytes`, …). `open`, `__import__`, `exec`, and the like are not reachable.
- It MUST not hit the network or touch the filesystem. If your SDK can't be constructed without I/O, leave out the heavy-class entry, class-level coverage is better than no coverage.
- The framework wraps the eval in a 2-second timeout. A timeout means "the manifest is wrong, the construction is doing something."

### Version-gated entry (`applies_when`)

Use when a symbol only exists on certain versions of a package, the check is skipped (not failed) when the installed version doesn't match. Specifier syntax is PEP 440 (`<2.0`, `>=1.0,<2.0`, `~=1.4`, etc.).

```python
from contract_checks.manifest import ComponentManifest, ImportRequirement

MANIFEST = ComponentManifest(
    imports=(
        # OCRDataframe was removed in img2table 2.0
        ImportRequirement(
            module='img2table.ocr.data',
            symbols=('OCRDataframe',),
            applies_when='<2.0',
        ),
        # OCRData was added in img2table 2.0
        ImportRequirement(
            module='img2table.ocr._types',
            symbols=('OCRData',),
            applies_when='>=2.0',
        ),
    ),
)
```

Output rows for entries that don't apply look like:

```text
[SKIP] nodes/ocr/img2table: img2table.ocr.data: applies_when='<2.0', installed=2.0.0
```

**Manifest entries replace auto-extracted entries** when they target the same module (for `ImportRequirement`) or qualname (for `HeavyClass`). So adding a version-gated `ImportRequirement(module='img2table.ocr.data', ...)` correctly overrides the unconditional version the AST would otherwise emit.

`applies_when` is available on `ImportRequirement`, `AnyOf`, and `HeavyClass`. Available specifier operators: `==`, `!=`, `>=`, `<=`, `>`, `<`, `~=`, and comma-joined ranges. Malformed specs fail loudly at manifest-load time.

### Any-of (for non-version fallbacks)

Use when two interchangeable libraries can satisfy the same import, e.g., `cryptography` OR `pycryptodome`. For pure version splits, prefer two `ImportRequirement` entries with `applies_when` over `AnyOf`, they read more like a changelog.

```python
from contract_checks.manifest import AnyOf, ComponentManifest, ImportRequirement

MANIFEST = ComponentManifest(
    any_of_imports=(
        AnyOf(
            alternatives=(
                ImportRequirement(module='cryptography.hazmat.primitives.ciphers'),
                ImportRequirement(module='Crypto.Cipher'),  # pycryptodome
            ),
        ),
    ),
)
```

The test passes if **at least one** alternative resolves.

### Skip packages

Use to drop a whole top-level package from the contract, e.g., when the AST detects it but you know it's optional / dynamically loaded:

```python
MANIFEST = ComponentManifest(
    skip_packages=frozenset({'some_optional_package'}),
)
```

For single imports, the inline `# contract-check: ignore` comment is usually a better choice (the *why* lives next to the code).

## Adding a new tree to scan

Edit [`tools/contract_checks/src/contract_checks/trees.py`](src/contract_checks/trees.py) and append one `Tree` entry to `SCANNED_TREES`:

```python
Tree(
    name='my-new-tree',
    root=REPO_ROOT / 'path' / 'to' / 'python' / 'source',
    internal_packages=frozenset({'my_internal_package'}),
),
```

No other change is needed, the CLI's tree iteration loop picks up the new entry automatically on the next run, and the install hook recursively finds every `requirement*.txt` under `root` on its own (no per-tree requirements config).

## Reading CI output

Failures take the form:

```text
<tree>/<component>/<package>: <what was checked>: <how it failed>
```

For example:

```text
nodes/somenode/somelib: somelib.helpers: symbol 'OldClass' not found in module 'somelib.helpers'
nodes/twelvelabs/twelvelabs: twelvelabs.TwelveLabs [twelvelabs_driver.py:51]: \
    attribute chain 'indexes.create' broke at .create (walked: .indexes, \
    construct: 'TwelveLabs(api_key="x")')
```

Both name the upstream symbol that drifted and the file/line where your code uses it.

Skipped checks (yellow, non-failing) look like this, emitted when the package isn't installed, or when an entry's `applies_when` doesn't match the installed version:

```text
[SKIP] nodes/ocr/img2table: img2table.ocr.data: applies_when='<2.0', installed=2.0.0
[SKIP] nodes/twelvelabs/twelvelabs: twelvelabs: package not installed in engine env
```

## Architecture (one screen)

```text
tools/contract_checks/
├── README.md                    ← you are here
├── cli.py                       ← thin entry: `engine cli.py --tree=… --package=…`
├── requirements.txt             ← empty; framework uses stdlib only
├── scripts/
│   └── tasks.js                 ← `check-externals:run`, `check-externals:test`
├── src/
│   └── contract_checks/         ← the framework package
│       ├── trees.py             ← which trees to scan + which packages are "internal"
│       ├── extractor.py         ← AST walker + data-flow tracking
│       ├── manifest.py          ← per-component override schema (ImportRequirement, HeavyClass, AnyOf, ...)
│       ├── engine_env.py        ← wraps depends.ensure_constraints() and depends()
│       ├── runner.py            ← pure verify_* functions; no pytest dep
│       └── cli.py               ← CLI dispatcher
└── test/
    ├── conftest.py              ← sys.path bootstrap so `from contract_checks.X import ...` works
    ├── test_extractor.py              ← framework unit tests
    └── test_runner.py                 ← framework unit tests
```

## CI lanes

Defined in [.github/workflows/check-externals.yml](../../.github/workflows/check-externals.yml). **Phase 1 posture: failures surface as GitHub Actions `::warning::` annotations only, non-blocking, no auto-issue yet.**

- **PR lane** (`check-externals:run`): runs on every PR touching `packages/**`, `nodes/**`, or `tools/contract_checks/**`. `continue-on-error: true` (non-blocking) during the stabilization period. `[FAIL]` / `[install-failed]` lines are surfaced as warning annotations.
- **Nightly lane** (`check-externals:run --rebuild-cache --install-all`): runs at 03:00 UTC against freshly-resolved constraints with every bundle installed. Same warning-only posture. The auto-issue-on-failure step is written but **commented out**, when enabled in a later phase it files a `check-externals,bug` issue, mirrored to Discord via `.github/workflows/discord-issues.yml`.

Run the framework's own unit tests with `./builder.cmd check-externals:test` (not yet a separate CI job).

## Common questions

**Q: My PR is red on `check-externals` and I didn't change any imports.**
A: Upstream shipped a breaking change. The failure message names the package and symbol. Either update the consuming code, add an `applies_when` manifest entry pinning the symbol to the version where it exists, add an `any_of` group, or pin the package version in the relevant `requirements.txt`.

**Q: The lane says my heavy-class construction timed out.**
A: Your SDK's `__init__` is doing I/O. If this is an **auto-extracted** entry (the message includes `[auto-extracted from <file>:<line>]`), the row is already a `SKIP` and doesn't block CI, nothing to do unless you want chain coverage, in which case add a manifest entry with safer dummy args. If it's a **manifest** entry, either find a constructor invocation that doesn't hit the network and update the `construct` field, or remove the heavy-class entry (you'll lose chain coverage but keep import coverage).

**Q: The lane reported `<package>.<thing> is a <type>, not a class`.**
A: Either auto-extraction guessed wrong (the thing is actually a factory function, `create_engine`, `pipeline`, etc.) and the row is harmlessly a `SKIP`, or your manifest's `qualname` points at a function instead of a class. For the function case, use an `ImportRequirement` for the symbol instead of a `HeavyClass`, the framework will verify the symbol resolves without trying to construct anything.

**Q: I added a new node, do I need a manifest?**
A: Usually no. Run `./builder.cmd check-externals:run --pattern=<your-node>` locally. If everything's green, you're done. (`--pytest-pattern=` still works as an alias for muscle memory, but `check-externals:run` no longer runs through pytest.)

**Q: How do I disable the framework for a specific import I know is optional?**
A: Add `# contract-check: ignore` on the same line as the import. Add a short reason after, it'll save the next maintainer a trip to `git log`.

**Q: Why doesn't `check-externals:run` go through pytest?**
A: It used to, but pytest only contributed parametrization and skip-on-missing semantics, things the [CLI](cli.py) implements directly in ~150 lines. Removing the pytest layer made the failure framing honest ("checks" not "tests") and dropped a dependency from the run path. `check-externals:test` *does* use pytest, that lane runs real unit tests against the framework's own code.
