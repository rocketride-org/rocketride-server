# RocketRide Node Test Framework

This framework enables automated testing of Python pipeline nodes by defining test configurations directly in `service*.json` files.

> **Note:** Only nodes with `"node": "python"` in their service file are supported by this test framework.

## Quick Start

Add a `test` property to your node's `services.json`:

```json
{
    "test": {
        "profiles": ["default"],
        "cases": [
            {
                "text": "Hello world",
                "expect": {
                    "text": { "contains": "Hello" }
                }
            }
        ]
    }
}
```

Run tests:

```bash
# Contract tests (no server needed)
./builder nodes:test

# Full integration tests (starts a server, runs test cases)
./builder nodes:test-full
```

---

## Test Configuration Schema

```json
{
    "test": {
        "requires": [],      // Environment variables required (test skipped if missing)
        "requiresLibs": {},  // Native libraries required (test skipped if missing)
        "requiresHardware": { "cuda": { "vramGb": 4 } },  // Where the test can run (see Hardware requirements)
        "profiles": [],      // Profile names to test (runs once per profile)
        "controls": [],      // Control nodes to attach to pipeline
        "chain": ["*"],      // Pipeline chain (* = node under test)
        "outputs": [],       // Output lanes to capture (auto-inferred if omitted)
        "timeout": 600,      // Per-test limit in seconds; only raises the 600 s suite default
        "cases": []          // Test cases (see below)
    }
}
```

### Properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `requires` | `string[]` | No | Environment variables that must be set. Test is skipped (reason `[env]`) if any are missing. |
| `profiles` | `string[]` | No | Profile names from `preconfig.profiles` to test. Each profile runs as a separate test. |
| `controls` | `string[]` | No | Control node providers to attach (e.g., `["llm_openai"]`). |
| `chain` | `string[]` | No | Pipeline chain. Use `*` for the node under test. Default: `["*"]` |
| `outputs` | `string[]` | No | Output lanes to capture. If omitted, automatically inferred from the `expect` keys in your test cases. |
| `timeout` | `number` | No | Per-test limit in seconds. It only takes effect above the suite default (`timeout = 600` in `pyproject.toml`); lower values change nothing. |
| `requiresLibs` | `object` or `string[]` | No | Native libraries that must be present (e.g., `{"Linux": ["libGLESv2.so.2"]}`; a plain array applies to all OSes). Test is skipped (reason `[libs]`) if any are missing. |
| `requiresHardware` | `object` or `false` | Conditional | Machine classes the test can run on and the memory each needs. Required for every group of a node with the `gpu` capability and every group listing a profile with `memory_gb`. See [Hardware requirements](#hardware-requirements). |
| `cases` | `object[]` | Yes | Array of test cases. |

---

## Hardware requirements

A group that loads a local model declares where it can run, so a machine that
cannot hold the model skips the test with a reason instead of running out of
memory or crawling:

```json
"requiresHardware": {
    "cuda": { "vramGb": 11 },
    "mps": { "ramGb": 32, "timeout": 1800 },
    "cpu": false
}
```

| Key | Meaning |
| --- | ------- |
| `cuda` | A machine with an NVIDIA GPU that Torch will use. `vramGb`: free VRAM needed on `cuda:0` (weights, activations and the CUDA context). |
| `mps` | An Apple Silicon Mac. `ramGb`: total unified memory needed. |
| `cpu` | Any other machine. `ramGb`: total memory needed. |
| `ramGb` | Also allowed under `cuda`: total system memory needed. |
| `timeout` | Per-test limit on that machine class, in seconds; like the group `timeout`, it only raises the suite default. |

- Only the listed classes are allowed; `"cpu": false` just says so explicitly. A
  class value is an object, `true`/`{}` (allowed, no minimum) or `false`.
- The keys name the **machine**, not the device the node uses. The test checks
  the class Torch would pick (CUDA, then MPS, then CPU). A machine with a small
  GPU skips even when `cpu` is allowed, because the node would still use the
  GPU. A node that cannot use MPS (Whisper, EasyOCR) still declares `mps` for
  Apple Silicon machines.
- `"requiresHardware": false` states that the group needs no special hardware.
- Unknown keys or wrong types fail the test, even outside strict mode.
- The requirement applies to every profile in the group. When profiles need
  different hardware, split them into separate groups (see
  `caption` or `background_removal`).
- `test_hardware_contract.py` (runs in `nodes:test`) requires a declaration on
  every group of a node with the `gpu` capability and on every group listing a
  profile with `memory_gb`, and `cuda.vramGb` must be at least that `memory_gb`.
  Nodes that load models without the `gpu` capability (`audio_transcribe`,
  `audio_tts`) must be annotated by hand.
- Declared groups are *heavy*: under xdist they run in dedicated lanes (see
  [Parallel runs](#parallel-runs)).

### How the machine is detected

The probe (`ai.common.utils.hardware`) never imports Torch. It uses NVML for NVIDIA
GPUs (honouring `CUDA_VISIBLE_DEVICES`; with several different GPUs and no
`CUDA_DEVICE_ORDER=PCI_BUS_ID` it assumes the smallest), the platform for Apple
Silicon, and psutil for memory. The pytest header shows the result:

```text
hardware: cuda NVIDIA RTX 2000 Ada Generation Laptop GPU, 8.0 GB VRAM (6.5 GB free), 95.6 GB RAM [probe]; strict off
```

A test is skipped (reason `[hardware]`) when the class is not allowed, when a
total is below its minimum, or when less than `vramGb` is free at session start;
the reason names the processes holding VRAM. Before each gated CUDA test the
harness waits up to 60 s for `vramGb` to be free and **fails** if it is not: an
earlier test kept its memory, or another process took the GPU.

| Variable | Effect |
| -------- | ------ |
| `ROCKETRIDE_TEST_DEVICE` | `cuda`, `mps` or `cpu`: describe the test server instead of probing this machine (use with `--taskserver`). Disables the per-test VRAM check. |
| `ROCKETRIDE_TEST_VRAM_GB`, `ROCKETRIDE_TEST_RAM_GB` | Memory of that machine; a declared minimum without its value skips the test. |
| `ROCKETRIDE_TEST_HARDWARE_STRICT=1` | Hardware skips become failures, so a run where everything was skipped cannot pass. Use it on GPU boxes that are expected to run everything. |
| `ROCKETRIDE_TEST_HW_LANES` | `1` (default), a number, or `auto`; see [Parallel runs](#parallel-runs). |

When `ROCKETRIDE_URI` points to another host and `ROCKETRIDE_TEST_DEVICE` is not
set, gated tests are skipped with reason `[remote]`.

---

## Test Cases

Each test case specifies an input and expected output.

```json
{
    "name": "Optional test case name",
    "text": "input data",
    "expect": { ... }
}
```

### Test case properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `name` | `string` | No | Optional descriptive name for the test case. |
| *(input lane)* | `string` or `object` | Yes | The input lane key and its data (see Input Format below). |
| `expect` | `object` | No | Expected output validation rules. If omitted, the test just checks that no error occurs. |

### Input format

The input lane is specified as a key, with the value depending on the lane type:

**Text-based lanes** (inline content):

```json
{
    "text": "What is the capital of France?",
    "expect": { ... }
}
```

**File-based lanes** (path relative to `testdata/`):

```json
{
    "image": "ocr/sample.png",
    "expect": { ... }
}
```

```json
{
    "audio": "audio/sample.mp3",
    "expect": { ... }
}
```

```json
{
    "documents": "docs/sample.pdf",
    "expect": { ... }
}
```

### Lane type inference

| Lane | Input Type | Example |
| ---- | ---------- | ------- |
| `text` | Inline string | `"text": "Hello world"` |
| `questions` | Inline string/object | `"questions": "What is 2+2?"` |
| `answers` | Inline string/object | `"answers": "42"` |
| `table` | Inline string/object | `"table": [...]` |
| `classifications` | Inline string/object | `"classifications": [...]` |
| `tags` | Inline string/object | `"tags": [...]` |
| `image` | File path | `"image": "ocr/sample.png"` |
| `audio` | File path | `"audio": "transcribe/sample.mp3"` |
| `video` | File path | `"video": "frames/sample.mp4"` |
| `documents` | File path | `"documents": "parse/sample.pdf"` |
| `_source` | Special | Internal source lane |

### Explicit file reference

For any lane, you can use an explicit file reference:

```json
{
    "text": { "file": "text/sample.txt" },
    "expect": { ... }
}
```

---

## Expectations

The `expect` property maps output lanes to validation rules.

```json
"expect": {
    "text": { "contains": "hello" },
    "questions": { "notEmpty": true }
}
```

### Lane-aware shortcuts

For known lanes, content matchers (`equals`, `contains`, `matches`, `beginsWith`, `endsWith`) automatically navigate to the lane's content path:

| Lane | Shortcut Path | Example Output Structure |
| ---- | ------------- | ------------------------ |
| `text` | `[0]` | `["hello", ...]` |
| `questions` | `[0].questions[0].text` | `[{questions: [{text: "..."}], ...}]` |
| `answers` | `[0]` | `["answer text", ...]` |
| `documents` | `[0].page_content` | `[{page_content: "...", ...}]` |
| `table` | `[0]` | `[...]` |
| `image` | `[0]` | `[...]` |
| `audio` | `[0]` | `[...]` |
| `video` | `[0]` | `[...]` |
| `classifications` | `[0]` | `[...]` |
| `tags` | `[0]` | `[...]` |

This means:

```json
"expect": { "text": { "contains": "hello" } }
```

Is equivalent to:

```json
"expect": { "text": { "property": { "path": "[0]", "contains": "hello" } } }
```

### Available matchers

#### Value matchers (use lane shortcuts)

| Matcher | Description | Example |
| ------- | ----------- | ------- |
| `equals` | Exact match | `{"equals": "hello"}` |
| `contains` | Substring or array contains | `{"contains": "world"}` |
| `matches` | Regex pattern | `{"matches": "^Hello.*"}` |
| `beginsWith` | String prefix match | `{"beginsWith": "Hello"}` |
| `endsWith` | String suffix match | `{"endsWith": "world"}` |

#### Structure matchers

| Matcher | Description | Example |
| ------- | ----------- | ------- |
| `notEmpty` | Value is not null, empty string, empty array, or empty object | `{"notEmpty": true}` |
| `minLength` | Minimum length | `{"minLength": 5}` |
| `maxLength` | Maximum length | `{"maxLength": 100}` |
| `type` | Type check | `{"type": "string"}` |
| `hasProperty` | Property exists | `{"hasProperty": "embedding"}` |
| `noError` | Just check no error occurred (value exists) | `{"noError": true}` |

#### Numeric matchers

| Matcher | Description | Example |
| ------- | ----------- | ------- |
| `greaterThan` | Value > threshold | `{"greaterThan": 0}` |
| `lessThan` | Value < threshold | `{"lessThan": 100}` |

#### Nested matchers

| Matcher | Description | Example |
| ------- | ----------- | ------- |
| `property` | Check nested path (single or array) | `{"property": {"path": "[0].score", "greaterThan": 0.5}}` |
| `each` | All array items match | `{"each": {"hasProperty": "text"}}` |
| `any` | At least one item matches | `{"any": {"contains": "hello"}}` |

### Property path syntax

Use `property` for explicit path navigation:

```json
"expect": {
    "questions": {
        "property": {
            "path": "[0].questions[0].text",
            "contains": "capital"
        }
    }
}
```

The `property` matcher also accepts an array for multiple property checks:

```json
"expect": {
    "documents": {
        "property": [
            { "path": "[0].page_content", "contains": "machine learning" },
            { "path": "[0].metadata.objectId", "equals": "test-doc-1" }
        ]
    }
}
```

Path syntax:
- `.property` - object property
- `[0]` - array index
- Combined: `[0].questions[0].text`

### Combining matchers

Multiple matchers can be combined:

```json
"expect": {
    "text": {
        "notEmpty": true,
        "contains": "hello",
        "minLength": 5
    }
}
```

Content matchers and `property` can be used together -- content matchers check the lane content path while `property` checks explicit paths on the raw result:

```json
"expect": {
    "text": {
        "contains": "hello",
        "property": { "path": "[0]", "minLength": 10 }
    }
}
```

---

## Examples

### Simple text transformation

```json
{
    "test": {
        "profiles": ["default"],
        "cases": [
            {
                "text": "What is the capital of France?",
                "expect": {
                    "questions": { "notEmpty": true }
                }
            }
        ]
    }
}
```

### OCR with image input

```json
{
    "test": {
        "profiles": ["default"],
        "cases": [
            {
                "image": "ocr/sample-text.png",
                "expect": {
                    "text": {
                        "notEmpty": true,
                        "contains": "Hello World"
                    }
                }
            }
        ]
    }
}
```

### LLM with external API key

```json
{
    "test": {
        "requires": ["ROCKETRIDE_OPENAI_KEY"],
        "profiles": ["openai-gpt4"],
        "controls": ["llm_openai"],
        "cases": [
            {
                "questions": "What is 2+2?",
                "expect": {
                    "answers": { "contains": "4" }
                }
            }
        ]
    }
}
```

### Vector DB with chain

```json
{
    "test": {
        "requires": ["MILVUS_URI"],
        "profiles": ["default"],
        "chain": ["preprocessor_langchain", "embedding_transformer", "*"],
        "cases": [
            {
                "questions": "What is machine learning?",
                "expect": {
                    "documents": { "notEmpty": true },
                    "answers": {
                        "property": {
                            "path": "[0]",
                            "minLength": 10
                        }
                    }
                }
            }
        ]
    }
}
```

### Named test cases with explicit outputs

```json
{
    "test": {
        "profiles": ["default"],
        "outputs": ["answers"],
        "cases": [
            {
                "name": "LLM returns mock response",
                "text": "What is 2+2?",
                "expect": {
                    "answers": { "contains": "Mock LLM response" }
                }
            },
            {
                "name": "LLM handles empty input",
                "text": "",
                "expect": {
                    "answers": { "notEmpty": true }
                }
            }
        ]
    }
}
```

---

## Running Tests

### Contract tests

Contract tests validate `services*.json` structure (required fields, lane names, module existence) without running a server:

```bash
# Run contract tests
./builder nodes:test

# Or explicitly
./builder nodes:test-contracts

# Or directly with pytest
pytest nodes/test/test_contracts.py -v

# Filter by node name
pytest nodes/test/test_contracts.py -k "llm_openai" -v
```

### Integration tests

Integration tests execute the test cases defined in `services*.json` through a live pipeline. This starts a test server automatically:

```bash
# Run full integration tests
./builder nodes:test-full

# With verbose pytest output
./builder nodes:test-full --pytest="-v -s"

# Run specific test by name pattern
./builder nodes:test-full --pytest="-k question"

# Filter by pytest markers
./builder nodes:test-full --pytest="-m slow"

# Filter by test pattern
./builder nodes:test-full --pytest-pattern="llm"
```

### Test dependencies

A node installs its `requirements.txt` only when a pipeline first loads it. A test
that imports a node's package directly (for example `psycopg2`, `img2table`,
`python-docx`) would otherwise skip until some earlier run happened to load that
node. `nodes:test` and `nodes:test-full` therefore first install
`nodes/test/requirements.txt` — the pytest harness plus those packages — through
the engine's `depends()`, so versions match what the nodes get at runtime.

When a test starts importing a package that only a node provides (not a base
engine package such as `numpy`, `pillow`, `requests` or `SQLAlchemy`), add it to
`nodes/test/requirements.txt` without a version; the engine constraints pin it.

`--list-skipped` and `--warmup=plan` do not install anything: they report the
environment as it is.

```bash
./builder nodes:test-full --list-skipped=marker   # e.g. "img2table not installed in test env"
./builder nodes:test                              # installs nodes/test/requirements.txt, then tests
./builder nodes:test-full --list-skipped=marker   # those tests are no longer listed
```

### Full tests (`fulltest`)

`nodes:test-full` also runs every profile listed under the `fulltest` key
(`test_dynamic_full.py`). These groups load real models, so:

- Before the server starts, a warmup pass downloads the models of the selected
  heavy tests (same `-k`/`-m` selection and gates as the run, pinned
  `revision`s, only the files the loaders read), so downloads don't count
  against test timeouts. It is skipped with `--taskserver`.
- A failed download is reported but does not stop the run; the affected test
  fails with the real error.

```bash
# Show what the warmup would download, and run nothing
./builder nodes:test-full --warmup=plan --pytest-pattern="caption"

# Skip the warmup pass
./builder nodes:test-full --warmup=off

# Fail instead of skip when this machine should run every heavy test
ROCKETRIDE_TEST_HARDWARE_STRICT=1 ./builder nodes:test-full
```

The same pytest options work without the builder: `--warmup-models[=plan]`.

### Listing skipped tests

`--list-skipped` collects the selected tests and prints the ones that will be
skipped, grouped by reason (`hardware`, `remote`, `env`, `libs`, `marker`),
without starting a server or running anything. A category narrows the list.
Skips decided while a test runs (for example, no server) cannot be predicted.

```bash
./builder nodes:test-full --list-skipped
./builder nodes:test-full --list-skipped=hardware
./builder nodes:test --list-skipped=env
```

### Parallel runs

The test tasks run pytest-xdist with `--dist loadgroup`. Heavy tests (groups
that declare `requiresHardware`) share lanes: xdist groups `hw0`, `hw1`, …, each
running its tests one at a time. `ROCKETRIDE_TEST_HW_LANES` sets how many lanes
exist:

- `1` (default): all heavy tests run one after another.
- `N`: up to `N` lanes (at most the worker count).
- `auto`: as many lanes as fit the memory free at session start (VRAM on CUDA,
  RAM otherwise, minus a reserve). Heavy tests are dealt largest first, so the
  peak is the sum of the largest declared needs. An 80 GB GPU runs several at
  once; an 8 GB laptop runs them one by one. Any heavy test without a declared
  memory need falls back to one lane.

If you choose another `--dist` mode with several workers while heavy tests are
selected, the run stops before any test starts.

### Mock support

Integration tests set the `ROCKETRIDE_MOCK` environment variable, which enables mock implementations for external services (LLM providers, vector stores, etc.). This allows tests to run in CI without real API keys. Mock modules are located in `nodes/test/mocks/`.

---

## Test Data

Place test files in the `testdata/` directory at the project root:

```text
testdata/
├── images/
│   ├── sample-text.png
│   └── document.jpg
├── audio/
│   └── sample.mp3
├── docs/
│   └── sample.pdf
└── ...
```

Reference files relative to `testdata/`:

```json
"image": "images/sample-text.png"
```

---

## License

MIT License -- see [LICENSE](../../../LICENSE).
