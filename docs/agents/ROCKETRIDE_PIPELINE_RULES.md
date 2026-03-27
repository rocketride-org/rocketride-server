# RocketRide Pipeline Building Rules & Guide

Complete reference for building RocketRide pipelines across any project.

---

## Table of Contents

- [Pipeline File Format](#pipeline-file-format)
- [Core Structure](#core-structure)
- [Components](#components)
- [Data Lanes](#data-lanes)
- [Configuration Profiles](#configuration-profiles)
- [Environment Variables](#environment-variables)
- [Connection Rules](#connection-rules)
- [Best Practices](#best-practices)
- [Common Patterns](#common-patterns)
- [Troubleshooting](#troubleshooting)
- [Validation Checklist](#validation-checklist)

---

## Pipeline File Format

### File Naming Convention

- **Extension:** `.pipe` (required)
- **Examples:** `chat.pipe`, `document_processor.pipe`, `ocr_workflow.pipe`
- **NOT:** `.json` or `.pipeline.json`

### File Structure

```json
{
	"project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
	"source": "entry_component_id",
	"components": [
		{
			"id": "unique_component_id",
			"provider": "component_type",
			"config": {},
			"ui": {},
			"input": []
		}
	]
}
```

---

## Core Structure

### Required Fields

#### `project_id` (string)

- **MUST be a unique GUID** for each pipeline file
- **Format:** Standard UUID/GUID (e.g., `85be2a13-ad93-49ed-a1e1-4b0f763ca618`)
- **Variable substitution NOT supported** - must be a literal GUID

**Why This Requirement:**

- Each pipeline must be uniquely identifiable by the RocketRide engine
- The `project_id` is read before environment variable substitution occurs
- The GUID serves as the permanent identity of the pipeline

**Incorrect:**

```json
"project_id": "${ROCKETRIDE_PROJECT_ID}"  // Variable substitution NOT allowed
```

**Correct:**

```json
"project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618"  // Literal GUID required
```

**Generate GUIDs with:**

- PowerShell: `[guid]::NewGuid().ToString()`
- Linux/Mac: `uuidgen`
- Python: `import uuid; print(uuid.uuid4())`
- JavaScript: `crypto.randomUUID()`
- Online: https://www.uuidgenerator.net/

**Note:** Do NOT reuse GUIDs from other pipelines. Each `.pipe` file must have its own unique GUID.

#### `source` (string)

- ID of the entry point component where data enters the pipeline
- Must match the `id` of one component in the `components` array
- Typically a source-type component (webhook, chat, dropper, etc.)

#### `components` (array)

- Array of component objects
- Each component must have a unique `id`
- Components are connected via `input` arrays

---

## Components

### Component Structure

Every component must have:

```json
{
	"id": "unique_identifier",
	"provider": "component_type",
	"config": {},
	"input": []
}
```

**Note:** The `ui` field is optional and only used by the pipeline editor for visual layout. It should be omitted when creating pipelines programmatically.

### Component Fields

#### `id` (string, required)

- Unique identifier within this pipeline
- Convention: `{provider}_{number}` (e.g., `llm_1`, `parser_1`, `qdrant_1`)
- Used by other components to reference this component

#### `provider` (string, required)

- Type of component (e.g., `webhook`, `llm_openai`, `parse`, `qdrant`)
- Must match an available RocketRide connector
- See ROCKETRIDE_COMPONENT_REFERENCE.md for all available providers

#### `config` (object, required)

- Component-specific configuration
- Often uses profiles: `{ "profile": "profile_name", "profile_name": {...} }`
- Supports environment variable substitution: `"apikey": "${ROCKETRIDE_OPENAI_KEY}"`

#### `ui` (object, optional)

- UI positioning and metadata for visual pipeline editor
- Can include:
  - `position`: `{ "x": 100, "y": 200 }`
  - `measured`: `{ "width": 160, "height": 88 }`
  - `data`: `{ "class": "llm", "type": "default" }`

#### `input` (array, optional/required for non-source components)

- Defines data sources from other components
- Format:

```json
"input": [
  {
    "lane": "lane_type",
    "from": "source_component_id"
  }
]
```

- Can have multiple inputs from different components
- Source components typically don't have input arrays

### Special Fields

#### `control` (array, optional)

- Used to pass LLM context between components
- Format:

```json
"control": [
  {
    "classType": "llm",
    "from": "component_id"
  }
]
```

---

## Data Lanes

### Lane Types

Lanes are typed data channels that connect components:

| Lane        | Data Type        | Description                                       |
| ----------- | ---------------- | ------------------------------------------------- |
| `tags`      | Metadata         | File metadata and RocketRide tags (raw file info) |
| `text`      | Plain text       | Extracted or generated text content               |
| `table`     | Structured data  | Tables from documents                             |
| `documents` | Document objects | Chunked/processed documents with embeddings       |
| `questions` | Question objects | Questions to be answered                          |
| `answers`   | Answer objects   | Answers from LLMs or vector stores                |
| `image`     | Image data       | Images extracted from documents                   |
| `audio`     | Audio streams    | Audio content                                     |
| `video`     | Video streams    | Video content                                     |

### Lane Flow Rules

1. **Type Compatibility**: Output lane from one component must match input lane of the next
1. **Multiple Inputs**: A component can accept multiple inputs:

```json
"input": [
  { "lane": "text", "from": "parser_1" },
  { "lane": "text", "from": "ocr_1" }
]
```

1. **Multiple Outputs**: One component's output can go to multiple components (no special syntax needed)

### Common Lane Transformations

| Input Lane  | Component    | Output Lanes                               |
| ----------- | ------------ | ------------------------------------------ |
| `tags`      | parse        | `text`, `table`, `image`, `audio`, `video` |
| `text`      | preprocessor | `documents`                                |
| `text`      | question     | `questions`                                |
| `documents` | embedding    | `documents` (with vectors)                 |
| `questions` | embedding    | `questions` (with vectors)                 |
| `documents` | vector_db    | — (stored)                                 |
| `questions` | vector_db    | `documents`, `answers`, `questions`        |
| `questions` | llm          | `answers`                                  |
| `image`     | ocr          | `text`, `table`                            |

---

## Configuration Profiles

### Profile System

Most components use a profile-based configuration:

```json
{
	"config": {
		"profile": "profile_name",
		"profile_name": {
			// profile-specific settings
		}
	}
}
```

### Common Profile Patterns

#### LLM Components

```json
{
	"config": {
		"profile": "openai-5",
		"openai-5": {
			"apikey": "${ROCKETRIDE_OPENAI_KEY}",
			"model": "gpt-4-turbo",
			"modelTotalTokens": 16384
		}
	}
}
```

#### Preprocessor Components

```json
{
	"config": {
		"profile": "default",
		"default": {
			"mode": "strlen",
			"splitter": "RecursiveCharacterTextSplitter",
			"strlen": 512
		}
	}
}
```

#### Vector Database Components

```json
{
	"config": {
		"profile": "local",
		"local": {
			"host": "localhost",
			"port": 6333,
			"collection": "my_collection",
			"score": 0.7
		}
	}
}
```

---

## Environment Variables

### Variable Substitution

Pipeline configurations support environment variable substitution using the format `${ROCKETRIDE_*}`:

**Supported:**

```json
{
	"apikey": "${ROCKETRIDE_OPENAI_KEY}",
	"host": "${ROCKETRIDE_QDRANT_HOST}",
	"port": "${ROCKETRIDE_QDRANT_PORT}",
	"collection": "${ROCKETRIDE_COLLECTION_NAME}"
}
```

**NOT Supported:**

```json
{
	"project_id": "${ROCKETRIDE_PROJECT_ID}" // Variables NOT allowed in project_id!
}
```

### Variable Requirements

1. **Must start with `ROCKETRIDE_`** prefix
2. Define in `.env` file in your working directory
3. Unknown variables are left unchanged
4. Only works with string values

### Example .env File

```env
# Core Configuration
ROCKETRIDE_URI=https://cloud.rocketride.ai
ROCKETRIDE_APIKEY=your-api-key

# LLM API Keys
ROCKETRIDE_OPENAI_KEY=sk-...
ROCKETRIDE_ANTHROPIC_KEY=sk-ant-...
ROCKETRIDE_GEMINI_KEY=...

# Vector Database
ROCKETRIDE_QDRANT_HOST=localhost
ROCKETRIDE_QDRANT_PORT=6333
ROCKETRIDE_COLLECTION_NAME=documents
```

---

## Connection Rules

### Rule 1: Source Components

- Every pipeline must have exactly one source component
- The `source` field must reference this component's `id`
- Source components typically don't have an `input` array
- Examples: webhook, chat, dropper

### Rule 2: Linear Flow

Basic linear pipeline:

```text
source → processor → output
```

Example:

```json
{
	"source": "webhook_1",
	"components": [
		{ "id": "webhook_1", "provider": "webhook" },
		{ "id": "parse_1", "provider": "parse", "input": [{ "lane": "tags", "from": "webhook_1" }] },
		{ "id": "response_1", "provider": "response_text", "input": [{ "lane": "text", "from": "parse_1" }] }
	]
}
```

### Rule 3: Branching Flow

One component can feed multiple components:

```text
         → processor_a →
source →                  → output
         → processor_b →
```

### Rule 4: Merging Flow

Multiple components can feed into one:

```text
component_a →
             → processor → output
component_b →
```

Example:

```json
{
	"id": "response_1",
	"provider": "response_text",
	"input": [
		{ "lane": "text", "from": "parser_1" },
		{ "lane": "text", "from": "ocr_1" }
	]
}
```

### Rule 5: Lane Compatibility

- The output lane type of one component must match the input lane type of the next
- Check component reference for supported lanes
- Mismatched lanes will cause pipeline errors

---

## Best Practices

### 1. Naming Conventions

**Pipeline Files:**

- Use descriptive names: `document_ingestion.pipe`
- Include purpose: `rag_chat.pipe`, `ocr_processor.pipe`

**Component IDs:**

- Pattern: `{provider}_{number}` (e.g., `llm_1`, `parser_1`)
- Use descriptive names for clarity: `llm_for_chat`, `parser_financial_docs`

### 2. Component Configuration

**Use Profiles:**

- Leverage built-in profiles for common configurations
- Create custom profiles when needed
- Document profile choices

**Environment Variables:**

- Always use variables for API keys and sensitive data
- Use variables for environment-specific settings (hosts, ports)
- Never hardcode secrets

### 3. Pipeline Design

**Start Simple:**

```text
source → processor → output
```

Add complexity incrementally.

**Logical Grouping:**
Group related operations:

```text
source → [parse → preprocessor → embedding] → vector_db
```

**Error Handling:**

- Always include a response component
- Consider error scenarios
- Test with sample data during development

### 4. Chunk Sizing

| Content Type    | Recommended Size |
| --------------- | ---------------- |
| General text    | 512-1024 chars   |
| Code            | 256-512 chars    |
| Legal documents | 1024-2048 chars  |
| Chat messages   | 256-512 chars    |
| Articles/blogs  | 768-1536 chars   |

### 5. Performance

**Embedding Models:**

- Speed: miniLM
- Quality: mpnet
- Balance: miniAll

**LLM Selection:**

- Best quality: GPT-4, Claude
- Fast responses: GPT-3.5
- Cost-effective: Mistral, Gemini
- Local/private: Ollama

**Vector Databases:**

- Local dev: Qdrant local, ChromaDB
- Production: Qdrant cloud, Pinecone, Weaviate

### 6. Testing Strategy

1. **Unit Test Components**: Test each component individually
2. **Integration Test Flow**: Test complete pipeline
3. **Test Incrementally**: Test each component addition with sample data
4. **Validate Data**: Check data at each stage
5. **Monitor Performance**: Track processing times

---

## Common Patterns

### Pattern 1: Chat/Q&A System (RAG)

```text
chat → embedding → vector_db → llm → response_answers
```

**Use Case:** Any conversational interface (web, console, API, mobile)
**Client Method:** `client.chat({ token, question })` (TS) / `client.chat(token=token, question=question)` (PY)
**Key Point:** Use `chat` component for ALL Q&A pipelines, not just web UIs

### Pattern 2: Simple Chat (No RAG)

```text
chat → llm → response_answers
```

**Use Case:** Direct LLM conversation without document retrieval
**Client Method:** `client.chat({ token, question })` (TS) / `client.chat(token=token, question=question)` (PY)

### Pattern 3: Document Processing/Ingestion

```text
webhook → parse → preprocessor → embedding → vector_db
```

**Use Case:** Upload and index documents  
**Client Method:** `client.send()`, `client.send_files()`  
**Key Point:** Use `webhook` for file uploads, not conversations

### Pattern 4: Simple Document Extraction

```text
webhook → parse → response_text
```

**Use Case:** Extract content from uploaded documents  
**Client Method:** `client.send()`, `client.send_files()`

### Pattern 5: OCR Pipeline

```text
webhook → parse → ocr → preprocessor → embedding → vector_db
```

**Use Case:** Extract and index text from images  
**Client Method:** `client.send_files()`

### Pattern 6: Direct LLM Analysis

```text
webhook → parse → llm → response_answers
```

**Use Case:** LLM analysis of uploaded documents  
**Client Method:** `client.send()`

### Pattern 7: Multi-Modal Processing

```text
                → ocr →
webhook → parse →         → merge → preprocessor → ...
                → audio_transcribe →
```

**Use Case:** Process multiple content types from uploads  
**Client Method:** `client.send_files()`

### Pattern 8: Advanced RAG with Summaries

```text
                → [preprocessor → embedding → vector_db (content)]
webhook → parse →
                → [summarization → embedding → vector_db (summaries)]
```

**Use Case:** Two-tier retrieval system for document indexing  
**Client Method:** `client.send_files()`

---

## Troubleshooting

### Common Issues

#### "Component not found"

**Cause:** Invalid provider name  
**Solution:** Check provider spelling against component reference

#### "Lane not supported"

**Cause:** Wrong input lane type  
**Solution:** Check component's supported lanes in reference

#### "Connection refused"

**Cause:** Service not running  
**Solution:** Start required services (Qdrant, etc.)

#### "Invalid API key"

**Cause:** Missing or wrong API key  
**Solution:** Check `.env` file and variable names

#### "No data flowing"

**Cause:** Lane mismatch  
**Solution:** Verify output lane of component A matches input lane of component B

### Development Strategy

1. **Start Minimal**: Begin with source → response component
2. **Add Components One at a Time**: Verify each addition works
3. **Check Lanes**: Ensure lane types match
4. **Test with Sample Data**: Use small test files first
5. **Verify Connections**: Ensure all inputs reference valid components

---

## Validation Checklist

Before deploying a pipeline:

- [ ] File named with `.pipe` extension
- [ ] `project_id` is a unique GUID (not a variable)
- [ ] `source` field references a valid component ID
- [ ] All component IDs are unique
- [ ] All `provider` names are valid
- [ ] Lane types match between connected components
- [ ] API keys use environment variables
- [ ] No hardcoded secrets
- [ ] All required services are available
- [ ] Pipeline tested with sample data
- [ ] Performance is acceptable

---

## Quick Reference

### Minimal Pipeline

```json
{
	"project_id": "{guid}", // Replace with your unique GUID
	"source": "source_1",
	"components": [
		{
			"id": "source_1",
			"provider": "webhook",
			"config": {}
		},
		{
			"id": "response_1",
			"provider": "response_text",
			"config": {},
			"input": [{ "lane": "text", "from": "source_1" }]
		}
	]
}
```

### Complete RAG Pipeline

```json
{
	"project_id": "{guid}", // Replace with your unique GUID
	"source": "chat_1",
	"components": [
		{ "id": "chat_1", "provider": "chat", "config": {} },
		{ "id": "embedding_1", "provider": "embedding_transformer", "config": { "profile": "miniLM" }, "input": [{ "lane": "questions", "from": "chat_1" }] },
		{ "id": "qdrant_1", "provider": "qdrant", "config": { "profile": "local", "local": { "collection": "docs" } }, "input": [{ "lane": "questions", "from": "embedding_1" }] },
		{ "id": "llm_1", "provider": "llm_openai", "config": { "profile": "openai-5", "openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" } }, "input": [{ "lane": "questions", "from": "qdrant_1" }] },
		{ "id": "response_1", "provider": "response_answers", "config": {}, "input": [{ "lane": "answers", "from": "llm_1" }] }
	]
}
```

---

## Additional Resources

- **Component Reference**: See `ROCKETRIDE_COMPONENT_REFERENCE.md` for detailed component documentation
- **Common Mistakes**: See `ROCKETRIDE_COMMON_MISTAKES.md` for troubleshooting
- **Python SDK**: See `ROCKETRIDE_python_API.md` for the Python client API reference
- **TypeScript SDK**: See `ROCKETRIDE_typescript_API.md` for the TypeScript client API reference

---

**Remember**: Every `.pipe` file is a complete, self-contained pipeline definition that can be executed by the RocketRide engine.
