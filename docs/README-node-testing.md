# RocketRide Node Test Framework

This framework enables automated testing of Python pipeline nodes by defining test configurations directly in `service*.json` files.

> **Note:** Only nodes with `"node": "python"` in their service file are supported by this test framework.

## Quick Start

Add a `test` property to your node's `service.json`:

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
builder nodes:test

# Full integration tests (starts a server, runs test cases)
builder nodes:test-full
```

---

## Test Configuration Schema

```json
{
    "test": {
        "requires": [],      // Environment variables required (test skipped if missing)
        "profiles": [],      // Profile names to test (runs once per profile)
        "controls": [],      // Control nodes to attach to pipeline
        "chain": ["*"],      // Pipeline chain (* = node under test)
        "outputs": [],       // Output lanes to capture (auto-inferred if omitted)
        "timeout": 60,       // Timeout in seconds (default: 60)
        "cases": []          // Test cases (see below)
    }
}
```

### Properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `requires` | `string[]` | No | Environment variables that must be set. Test is skipped if any are missing. |
| `profiles` | `string[]` | No | Profile names from `preconfig.profiles` to test. Each profile runs as a separate test. |
| `controls` | `string[]` | No | Control node providers to attach (e.g., `["llm_openai"]`). |
| `chain` | `string[]` | No | Pipeline chain. Use `*` for the node under test. Default: `["*"]` |
| `outputs` | `string[]` | No | Output lanes to capture. If omitted, automatically inferred from the `expect` keys in your test cases. |
| `timeout` | `number` | No | Test timeout in seconds. Default: 60 |
| `cases` | `object[]` | Yes | Array of test cases. |

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

Contract tests validate service.json structure (required fields, lane names, module existence) without running a server:

```bash
# Run contract tests
builder nodes:test

# Or explicitly
builder nodes:test-contracts

# Or directly with pytest
pytest nodes/test/test_contracts.py -v

# Filter by node name
pytest nodes/test/test_contracts.py -k "llm_openai" -v
```

### Integration tests

Integration tests execute the test cases defined in `service.json` through a live pipeline. This starts a test server automatically:

```bash
# Run full integration tests
builder nodes:test-full

# With verbose pytest output
builder nodes:test-full --pytest="-v -s"

# Run specific test by name pattern
builder nodes:test-full --pytest="-k question"

# Filter by pytest markers
builder nodes:test-full --markers="slow"

# Filter by test pattern
builder nodes:test-full --pattern="llm"
```

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

MIT License -- see [LICENSE](../LICENSE).
