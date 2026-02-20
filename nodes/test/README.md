# Node Test Framework

This framework enables automated testing of pipeline nodes by defining test configurations directly in `service*.json` files.

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
builder test:nodes
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
        "timeout": 60,       // Timeout in seconds (default: 60)
        "cases": []          // Test cases (see below)
    }
}
```

### Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `requires` | `string[]` | No | Environment variables that must be set. Test is skipped if any are missing. |
| `profiles` | `string[]` | No | Profile names from `preconfig.profiles` to test. Each profile runs as a separate test. |
| `controls` | `string[]` | No | Control node providers to attach (e.g., `["llm_openai"]`). |
| `chain` | `string[]` | No | Pipeline chain. Use `*` for the node under test. Default: `["*"]` |
| `timeout` | `number` | No | Test timeout in seconds. Default: 60 |
| `cases` | `object[]` | Yes | Array of test cases. |

> **Note:** Output lanes are automatically inferred from the `expect` keys in your test cases. No need to specify them separately.

---

## Test Cases

Each test case specifies an input and expected output.

### Input Format

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

### Lane Type Inference

| Lane | Input Type | Example |
|------|------------|---------|
| `text` | Inline string | `"text": "Hello world"` |
| `questions` | Inline string/object | `"questions": "What is 2+2?"` |
| `answers` | Inline string/object | `"answers": "42"` |
| `image` | File path | `"image": "ocr/sample.png"` |
| `audio` | File path | `"audio": "transcribe/sample.mp3"` |
| `video` | File path | `"video": "frames/sample.mp4"` |
| `documents` | File path | `"documents": "parse/sample.pdf"` |

### Explicit File Reference

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

### Lane-Aware Shortcuts

For common lanes, content matchers (`equals`, `contains`, `matches`) automatically navigate to the content:

| Lane | Shortcut Path | Example Output Structure |
|------|---------------|--------------------------|
| `text` | `[0].text` | `[{text: "hello", ...}]` |
| `questions` | `[0].questions[0].text` | `[{questions: [{text: "..."}], ...}]` |
| `answers` | `[0].answer` | `[{answer: "...", ...}]` |
| `documents` | `[0].text` | `[{text: "...", ...}]` |

This means:
```json
"expect": { "text": { "contains": "hello" } }
```

Is equivalent to:
```json
"expect": { "text": { "property": { "path": "[0].text", "contains": "hello" } } }
```

### Available Matchers

#### Value Matchers (use lane shortcuts)

| Matcher | Description | Example |
|---------|-------------|---------|
| `equals` | Exact match | `{"equals": "hello"}` |
| `contains` | Substring or array contains | `{"contains": "world"}` |
| `matches` | Regex pattern | `{"matches": "^Hello.*"}` |

#### Structure Matchers

| Matcher | Description | Example |
|---------|-------------|---------|
| `notEmpty` | Value is not null, empty string, or empty array | `{"notEmpty": true}` |
| `minLength` | Minimum length | `{"minLength": 5}` |
| `maxLength` | Maximum length | `{"maxLength": 100}` |
| `type` | Type check | `{"type": "string"}` |
| `hasProperty` | Property exists | `{"hasProperty": "embedding"}` |

#### Numeric Matchers

| Matcher | Description | Example |
|---------|-------------|---------|
| `greaterThan` | Value > threshold | `{"greaterThan": 0}` |
| `lessThan` | Value < threshold | `{"lessThan": 100}` |

#### Nested Matchers

| Matcher | Description | Example |
|---------|-------------|---------|
| `property` | Check nested path | `{"property": {"path": "[0].score", "greaterThan": 0.5}}` |
| `each` | All array items match | `{"each": {"hasProperty": "text"}}` |
| `any` | At least one item matches | `{"any": {"contains": "hello"}}` |

### Property Path Syntax

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

Path syntax:
- `.property` - object property
- `[0]` - array index
- Combined: `[0].questions[0].text`

### Combining Matchers

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

---

## Examples

### Simple Text Transformation

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

### OCR with Image Input

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

### LLM with External API Key

```json
{
    "test": {
        "requires": ["APARAVI_OPENAI_KEY"],
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

### Vector DB with Chain

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
                            "path": "[0].answer",
                            "minLength": 10
                        }
                    }
                }
            }
        ]
    }
}
```

### Multiple Test Cases

```json
{
    "test": {
        "profiles": ["default"],
        "cases": [
            {
                "text": "Hello",
                "expect": { "text": { "notEmpty": true } }
            },
            {
                "text": "World",
                "expect": { "text": { "contains": "World" } }
            }
        ]
    }
}
```

---

## Running Tests

```bash
# Run all node tests
builder test:nodes

# Run with verbose output
builder test:nodes --pytest="-v -s"

# Run specific test
builder test:nodes --pytest="-k question"

# Run only contract tests (no server needed)
pytest nodes/test/test_contracts.py -v
```

---

## Test Data

Place test files in the `testdata/` directory at the project root:

```
testdata/
├── ocr/
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
"image": "ocr/sample-text.png"
```

