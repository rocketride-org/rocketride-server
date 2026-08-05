# preprocessor_langchain

A RocketRide preprocessor node ("General Text") that splits incoming text into chunks for downstream embedding or LLM processing.

## What it does

Splits text into chunks using **LangChain text splitters** (`langchain_text_splitters`). Choose a profile tuned for the content type: general prose, markdown, LaTeX, or sentence-based NLP. No LLM is required.

Each profile pins its own splitter class, and the `custom` profile is const-locked to `RecursiveCharacterTextSplitter` (a general-purpose splitter, the same class as `default`). Constructor kwargs are filtered against the target class signature, preventing "unexpected keyword argument" errors across splitters. Chunk overlap is fixed at `0`.

Incoming text is accumulated per file and split once when the file closes. Each incoming table is split immediately as its own unit. Every chunk is emitted as a document with a sequential `chunkId` (reset per file); tables additionally carry a `tableId`.

By default chunks are measured by **string length** with a maximum of **512** characters. Token mode uses a conservative byte-length estimator instead of a real tokenizer (no transformers model is loaded). See [Token mode](#token-mode) below.

---

## Configuration

### Lanes

| Lane in | Lane out    | Description                              |
|---------|-------------|------------------------------------------|
| `text`  | `documents` | Split plain text into document chunks    |
| `table` | `documents` | Split table content into document chunks |

### Fields

| Field | Type | Description |
|---|---|---|
| `strlen` | number | Default 512.  |
| `tokens` | number | Default 512.  |
| `mode` | string | Default "strlen".  |
| `splitter` | string | Default "RecursiveCharacterTextSplitter".  |
| `separators` | string | Default "'\n\n', '\n', ' ', ''".  |
| `separator` | string | Default ""\n"".  |
| `model` | string | Default "en_core_web_sm".  |
| `profile` | string | Default "default".  |

### Separator syntax

`separators` and `separator` are parsed as comma-separated Python string literals (e.g. `'\n\n', '\n', ' ', ''`). Escape sequences such as `\n` are interpreted. Every element must be a string. The `character` profile accepts exactly one element. An invalid format raises an error at startup.

### Advanced token-mode options

These keys are read from the node config but are not exposed in the UI shape:

| Field                 | Type / Default   | Description                                                                      |
|-----------------------|------------------|----------------------------------------------------------------------------------|
| `bytes_per_token`     | float, `3.0`     | Bytes-per-token ratio used by the estimator. Lower values estimate more tokens (safer). |
| `max_model_tokens`    | int, unset       | Hard cap for the model's max token context. When set, caps the chunk size and enables the post-split safety net. |
| `token_safety_margin` | int, `32`        | Subtracted from `max_model_tokens` to leave headroom for special tokens.         |

---

## Profiles

| Profile             | Splitter                         | Best for                                                               |
|---------------------|----------------------------------|------------------------------------------------------------------------|
| `default` (default) | `RecursiveCharacterTextSplitter` | General-purpose prose                                                  |
| `recursive`         | `RecursiveCharacterTextSplitter` | General-purpose prose with custom separators                           |
| `character`         | `CharacterTextSplitter`          | Simple splitting on a fixed separator                                  |
| `markdown`          | `MarkdownTextSplitter`           | Structured Markdown documents (separators kept in chunks)              |
| `latex`             | `LatexTextSplitter`              | Scientific and academic documents (separators kept in chunks)          |
| `nltk`              | `NLTKTextSplitter`               | Sentence-based splitting                                               |
| `spacy`             | `SpacyTextSplitter`              | NLP-based sentence splitting (English, German, French, Spanish models) |
| `custom`            | `RecursiveCharacterTextSplitter` | General-purpose prose (const-locked to `RecursiveCharacterTextSplitter`, same class as `default`) |

> **Each profile locks its splitter class.** The splitter cannot be selected independently of the profile. To use `MarkdownTextSplitter`, choose the `markdown` profile (not `default`); likewise `latex`, `character`, `nltk`, `spacy`, and `custom` each pin their own class. Editing a profile's `splitter` field to a different class name fails schema validation with `... must be equal to constant`. The fix is to switch the **Text splitter** profile, not to change the splitter field.

### NLTK

Dependencies (`nltk`) are installed lazily the first time this profile is used. The `punkt` tokenizer data (and `punkt_tab`, required by NLTK 3.9+) is downloaded automatically if missing. Pass a `language` key in the node config (e.g. `"english"`, `"spanish"`) to forward it to the splitter.

### spaCy

Dependencies (`spacy`) are installed lazily the first time this profile is used. The configured pipeline model (default `en_core_web_sm`) is downloaded automatically if not already installed. Small, medium, and large models are available for English, German, French, and Spanish; an English transformer model (`en_core_web_trf`) is also supported (best accuracy, slower).

### Custom

The `custom` profile's `splitter` field is const-locked to `RecursiveCharacterTextSplitter`; it cannot be pointed at another class through the UI (editing it to a different class name fails schema validation). It behaves like `default`, and only kwargs accepted by the splitter's constructor are forwarded; unrecognized kwargs are silently dropped.

---

## Token mode

With `mode: tokens`, chunk size is measured by an estimated token count. No tokenizer or transformers model is loaded. The estimate is the UTF-8 byte length of the text divided by `bytes_per_token` (default `3.0`), rounded up. This is conservative by design, so real token counts should come in at or under the estimate.

When `max_model_tokens` is set:

- The effective token budget is `max_model_tokens - token_safety_margin`.
- The requested chunk size (`tokens`) is capped to that budget.
- After splitting, any chunk that still exceeds the budget is force-subdivided by proportional character cuts until every piece fits.

This guarantees no emitted chunk exceeds the model's context budget even without an exact tokenizer.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `langchain.splitter.character.separator` | `string` | **Split separator** | `"\"\\n\""` |
| `langchain.splitter.character.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to CharacterTextSplitter by the 'Character Text Splitter' profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"CharacterTextSplitter"` |
| `langchain.splitter.custom.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to RecursiveCharacterTextSplitter by the 'Custom' text-splitter profile and cannot be changed here; the custom profile currently behaves like default. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"RecursiveCharacterTextSplitter"` |
| `langchain.splitter.default.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to RecursiveCharacterTextSplitter by the 'Default' text-splitter profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile (for example Markdown for MarkdownTextSplitter). Editing this to another class fails validation with 'must be equal to constant'. | const: `"RecursiveCharacterTextSplitter"` |
| `langchain.splitter.latex.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to LatexTextSplitter by the 'Latex Text Splitter' profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"LatexTextSplitter"` |
| `langchain.splitter.markdown.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to MarkdownTextSplitter by the 'Markdown Text Splitter' profile and cannot be changed here. To use MarkdownTextSplitter, select 'Markdown Text Splitter' in the 'Text splitter' selector above rather than editing this field. Editing this to another class fails validation with 'must be equal to constant'. | const: `"MarkdownTextSplitter"` |
| `langchain.splitter.mode` | `string` | **Split by** | `"strlen"` |
| `langchain.splitter.nltk.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to NLTKTextSplitter by the 'NLTK Text Splitter' profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"NLTKTextSplitter"` |
| `langchain.splitter.profile` | `string` | **Text splitter**<br/>Selects the splitter profile. Each profile locks one LangChain splitter class and shows only that splitter's options, so the splitter class is not chosen independently of the profile. Pick the profile that matches your content: Markdown for .md, Latex for LaTeX, Character/NLTK/Spacy as needed. Editing a profile's splitter field to a different class fails schema validation with a 'must be equal to constant' error; change this selector instead. | `"default"` |
| `langchain.splitter.recursive.separators` | `string` | **Split separators** | `"'\\n\\n', '\\n', ' ', ''"` |
| `langchain.splitter.recursive.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to RecursiveCharacterTextSplitter by the 'Recursive Character Text Splitter' profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"RecursiveCharacterTextSplitter"` |
| `langchain.splitter.spacy.model` | `string` | **Model** | `"en_core_web_sm"` |
| `langchain.splitter.spacy.splitter` | `string` | **Splitter class (set by profile)**<br/>Fixed to SpacyTextSplitter by the 'Spacy Text Splitter' profile and cannot be changed here. To use a different splitter, change the 'Text splitter' selector above to the matching profile. Editing this to another class fails validation with 'must be equal to constant'. | const: `"SpacyTextSplitter"` |
| `langchain.splitter.strlen` | `number` | **String length** | `512` |
| `langchain.splitter.tokens` | `number` | **Number of tokens** | `512` |

## Dependencies

- `langchain`
- `langchain-text-splitters`
- `langchain-core`
- `accelerate`
- `transformers`
- `tokenizers`
- `huggingface-hub`
- `pyyaml`
- `filelock`
- `regex`
- `tqdm`
- `safetensors`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/preprocessor_langchain)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
