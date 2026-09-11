# chunker

A RocketRide preprocessor node ("Text Chunker") that splits documents into smaller, overlapping chunks for downstream embedding, retrieval, and LLM generation. Pick it when you need sentence-boundary splitting with no extra dependencies, or token-accurate splitting sized with the real `tiktoken` BPE tokenizer.

## What it does

The node receives documents on its `documents` lane, splits each one's text with the configured strategy, and emits one document per chunk on the same lane. Every emitted chunk copies the source document and gets its own metadata — `chunkId`, `parentId` (the source `objectId`), `chunk_index`, `start_char`, `end_char`, and `total_chunks` — so downstream nodes can trace a chunk back to its origin or reassemble the original. The incoming documents themselves are never forwarded; only chunks continue down the pipeline, and documents whose text is empty or whitespace-only are consumed and produce nothing.

It deliberately covers only the two strategies the engine does not otherwise have: sentence-boundary grouping and real token counting. For recursive character splitting use the **General Text** (`preprocessor_langchain`) node, which already exposes LangChain's `RecursiveCharacterTextSplitter`; configuring `recursive` here fails at startup with a pointer to that node rather than falling back silently.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `documents` | `documents` | Split each incoming document and emit one document per chunk. |

## Profiles

Default: **Sentence Boundary - Splits at sentence endings for coherent chunks** (`sentence`).

| Profile | Strategy | Chunk size | Overlap | Best for |
| --- | --- | --- | --- | --- |
| `sentence` **(default)** | `sentence` | 1000 characters | 200 | Ordinary punctuated prose that should never be cut mid-sentence. |
| `token` | `token` | 512 tokens | 50 | Chunks that must fit a model's context or an embedding input limit. |

The `sentence` strategy splits on sentence-ending punctuation (`.`, `!`, `?`) followed by whitespace, using only the Python standard library — no third-party package and no language-model download. It treats a sentence as indivisible, so `chunk_size` is a grouping target rather than a hard cap: a single sentence longer than `chunk_size` is emitted whole.

The `token` strategy encodes the text with `tiktoken` and slices it by token count, so every chunk is capped at `chunk_size` tokens unconditionally. Its dependency is probed and its encoder imported only when this strategy is selected. Choose it for input with no sentence-ending punctuation — log lines, CSV rows, OCR dumps, minified text — where the sentence strategy finds no boundaries to group on and emits one oversized chunk.

## Configuration

Pick the profile first: it sets the strategy along with chunk size, overlap, and (for `token`) the encoding, and the defaults are sensible for each. The configuration panel then shows only the fields that apply to the chosen strategy, so there is nothing else most pipelines need to touch. All three values are validated at startup — a non-positive chunk size, a negative overlap, or an overlap that is not smaller than the chunk size stops the node rather than degrading quietly.

### Chunk size

The maximum size of a chunk, measured in **characters** for the `sentence` strategy and in **tokens** for the `token` strategy — the same field means different units depending on the profile. Larger values preserve more context per chunk but retrieve less precisely; smaller values sharpen retrieval and cost more chunks. The profile defaults (1000 characters, 512 tokens) suit general documents; when the chunks feed an embedding model or an LLM prompt, size them against that model's input limit using the `token` strategy so the count is exact rather than estimated.

### Chunk overlap

How much of each chunk is repeated at the start of the next one, in the same units as chunk size, so a sentence or idea straddling a boundary still appears whole in at least one chunk. It must be less than the chunk size. With the `token` strategy the window advances by `chunk_size - chunk_overlap` tokens; with the `sentence` strategy the trailing sentences of the finished chunk are carried forward as long as their combined span fits within the overlap, so the effective overlap lands on a sentence boundary and can be smaller than the configured value. Set it to `0` to disable overlap entirely; the profile defaults of 200 characters and 50 tokens are roughly a fifth and a tenth of their chunk sizes.

### Token encoding

The `tiktoken` encoding used to count and slice tokens. It applies only to the `token` strategy and is ignored by `sentence`. Match it to the model the chunks are destined for, since token boundaries differ between encodings: `cl100k_base` (the default) for GPT-4, GPT-3.5-turbo and `text-embedding-ada-002`, `o200k_base` for GPT-4o and newer models, `p50k_base` for Codex models, and `r50k_base` for GPT-3 models. The wrong encoding still produces chunks, but their token counts will not match what the consuming model measures.

## Notes

### Chunk metadata

`chunkId` is a running counter across everything emitted for one incoming object and resets to `0` when the next object opens; `chunk_index` restarts at `0` for each source document, and `total_chunks` is that document's chunk count. `start_char` and `end_char` are character offsets into the source text — exact for the `sentence` strategy, and derived from decoded token spans for the `token` strategy.

### Undecodable tokens

A token window can end mid-character, so the `token` strategy falls back to a per-token byte rebuild when a decode fails, substituting U+FFFD for bytes it cannot recover. A chunk is never dropped because of a malformed multi-byte sequence.

## Upstream docs

- [tiktoken](https://github.com/openai/tiktoken)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `chunker.chunk_overlap` | `integer` | **Chunk overlap**<br/>Number of characters or tokens to overlap between consecutive chunks; must be less than chunk size. | `200` |
| `chunker.chunk_size` | `integer` | **Chunk size**<br/>Maximum size of each chunk (characters for the sentence strategy, tokens for the token strategy) | `1000` |
| `chunker.encoding_name` | `string` | **Token encoding**<br/>Tiktoken encoding name (only used with token strategy) | `"cl100k_base"` |
| `chunker.profile` | `string` | **Chunking strategy**<br/>Select the text chunking strategy | `"sentence"` |

## Dependencies

- `tiktoken` `>=0.7.0,<1.0.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/chunker)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
