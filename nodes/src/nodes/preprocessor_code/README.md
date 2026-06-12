# preprocessor_code

A RocketRide preprocessor node that splits source code into syntax-aware chunks for embedding, search, or LLM processing.

## What it does

Accepts source code text and emits each syntactic construct (function, class, statement, block) as a separate document, so downstream nodes receive chunks that respect code boundaries rather than cutting mid-construct.

Uses **tree-sitter** with per-language grammar packages (`tree-sitter-python`, `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-c`, `tree-sitter-cpp`). If the optional `tree_sitter_languages` package is installed it is used as a fast path for grammar loading; otherwise the individual per-language modules are loaded directly. Parsers are cached per language for the lifetime of the pipeline run.

By default (`language: auto`) the language is detected from the **content** of each file using weighted regex heuristics, not the filename extension. If detection cannot identify a supported language with sufficient confidence, the file is skipped and a warning is emitted; no documents are produced for that file.

---

## Configuration

### Lanes

| Lane in | Lane out    | Description                                         |
|---------|-------------|-----------------------------------------------------|
| `text`  | `documents` | Split source code into syntax-aware document chunks |

Both `writeText` and `writeTable` inputs are processed. Table input marks the resulting documents with `isTable: true` and an incrementing `tableId`. Each emitted document carries an incrementing `chunkId` starting at 0 per object.

### Fields

Configuration is profile-based. Select a profile to fix the parsing language, or leave the default `auto` profile to detect the language per file.

| Field | Type | Description |
|---|---|---|
| `strlen` | number | Default 512.  |
| `language` | string | Default "auto".  |
| `profile` | string | Default "auto".  |

Note: `strlen` is stored in the configuration and profile but the current splitter determines chunk boundaries purely from syntax nodes. A single large function or class becomes a single chunk regardless of `strlen`.

### Profiles

| Profile          | Language setting | Notes                                      |
|------------------|------------------|--------------------------------------------|
| `auto` (default) | `auto`           | Detects language from file content         |
| `c`              | `c`              | C source and headers                       |
| `cpp`            | `cpp`            | C++ source                                 |
| `python`         | `python`         | Python source                              |
| `javascript`     | `javascript`     | JavaScript source                          |
| `typescript`     | `typescript`     | TypeScript source                          |

The UI profile picker exposes `auto`, `c` (labelled "C/C++ source"), `python`, `javascript`, and `typescript`. The `cpp` profile is also present in `preconfig` for direct configuration use.

---

## Language auto-detection

With `language: auto`, the node scores the text against weighted regex patterns for Python, TypeScript, JavaScript, C++, and C (only the first 5 MB of the text is sampled).

Example signals used per language:

- **Python**: `def ...():`, `class ...:`, decorator patterns, `from X import`, `async def`
- **TypeScript**: `interface`, `type X =`, `import type`, `enum`, type annotations, `export ... type`
- **JavaScript**: `export default/const/function/class`, `require(`, `module.exports`, arrow functions
- **C++**: `std::`, `template <`, `using namespace std`, `::` resolution
- **C**: include guards (`#ifndef`/`#define`/`#endif`), `typedef struct`, prototypes ending with `;`

The winner must score at least 3 and lead the runner-up by at least 2, otherwise detection fails and the file is skipped with a warning. Tie-break rules for C vs C++:

- `extern "C"` present with no C++-only markers (`std::`, templates, namespaces, `::`) resolves to **C**.
- A near-tie where the top two candidates are C and C++ resolves to **C** (conservative, matches typical header-like code).

If detection regularly fails on valid source (very short snippets, unusual dialects), pin the language with an explicit profile instead of `auto`.

---

## How chunks are extracted

The tree-sitter syntax tree is walked recursively. The following node types become chunks:

- **Python**: `function_definition`, `class_definition`, `decorated_definition`, plus module-level `import_statement`, `import_from_statement`, `assignment`, and `expression_statement`.
- **JavaScript / TypeScript**: `function_declaration`, `function_expression`, `arrow_function`, `class_declaration`, `method_definition`, and function values in minified patterns (`const f = () => {...}`, object pair values that are functions).
- **C / C++**: `function_definition`, `class_specifier`, `struct_specifier`, entire `extern "C" { ... }` linkage blocks, and top-level declarations in headers (prototypes, typedefs, field declarations). Preprocessor directives (`#include`, `#define`, etc.) are skipped.

Because the walk recurses into matched nodes, nested constructs produce overlapping chunks: a class is emitted as one chunk and each of its methods is also emitted as its own chunk. This gives both whole-construct and per-member granularity for downstream retrieval.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `code.splitter.auto.language` | `string` |  | const: `"auto"` |
| `code.splitter.c.language` | `string` |  | const: `"c"` |
| `code.splitter.cpp.language` | `string` |  | const: `"cpp"` |
| `code.splitter.javascript.language` | `string` |  | const: `"javascript"` |
| `code.splitter.profile` | `string` | **Code splitter profile** | `"auto"` |
| `code.splitter.python.language` | `string` |  | const: `"python"` |
| `code.splitter.strlen` | `number` | **Maximum string length** | `512` |
| `code.splitter.typescript.language` | `string` |  | const: `"typescript"` |

## Dependencies

- `tree-sitter`
- `tree-sitter-c`
- `tree-sitter-cpp`
- `tree-sitter-javascript`
- `tree-sitter-python`
- `tree-sitter-typescript`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/preprocessor_code)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
