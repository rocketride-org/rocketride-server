# context_optimizer

A RocketRide text node that fits an LLM request into a model's context window by budgeting tokens across the system prompt, question, retrieved documents and conversation history. Put it in front of an LLM node when retrieval or a long conversation can push a prompt past the window and you want deterministic, local trimming instead of a provider-side rejection.

## What it does

The node counts the tokens of the prompt the engine will actually render with `tiktoken`, and only when that rendering exceeds the model's context window does it allocate a per-component budget and trim. The system prompt and the question are truncated on sentence boundaries, falling back to a token-level cut when a single sentence is still over budget; documents are ranked by their vector-DB `score` (descending, or by keyword overlap with the question when no scores are present) and selected greedily until the document budget is spent; conversation history keeps the first message and as many recent messages as fit, replacing the middle with a single summarized placeholder. A question carrying several `QuestionText` entries keeps every entry — the entries share the query allowance in proportion to their own size — so the per-entry embedding metadata that the embedding nodes write and the document stores read survives the node. Requests whose rendered prompt already fits pass through unchanged, and no extra model call is ever made. This node is marked **experimental**.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `questions` | Questions with optimized context fitting within model token limits |

## Profiles

Default: **Auto - Use default model limits** (`auto`). Both user-facing profiles ship the same budget split; they differ only in where the context window comes from.

| Profile | Budget split (system / query / documents / history) | When to pick it |
| --- | --- | --- |
| `auto` **(default)** | 10 / 15 / 50 / 25 | The usual choice: name the model and let the node resolve its window. |
| `manual` | 10 / 15 / 50 / 25 | A deployment whose real window neither the live catalog nor the fallback table knows; set **Max context tokens** yourself (ships at 128 000). |
| `ci_tiny` | 10 / 20 / 35 / 35 | Automated node tests only. It pins a 112-token window so every case is forced over budget; it is deliberately absent from the **Mode** dropdown. |

## Configuration

Pick a **Mode** and, in `auto`, name the model. The four budget percentages have workable defaults (10 / 15 / 50 / 25) and most pipelines never touch them — reach for them only when one component of your prompt is systematically starved.

### Mode

`auto` resolves the context window for the model named in **Model name**; `manual` ignores the model entirely and uses **Max context tokens**. `auto` is right whenever the model is one an `llm_*` node in this deployment publishes, which is the common case; `manual` is the escape hatch for a gateway, a fine-tune, or a self-hosted deployment whose window this build cannot know. How `auto` resolves the window — and what it does when it cannot — is described under [Where the context-window size comes from](#where-the-context-window-size-comes-from).

### Model name

The model identifier used for the window lookup in `auto` mode, e.g. `gpt-5.4`, `claude-sonnet-4-6`, `models/gemini-3.1-pro-preview`. Use the id an `llm_*` node publishes; a provider-scoped id (`openai/gpt-5`) also resolves under its bare name when that name is unambiguous, and the abbreviated family aliases `claude-sonnet`, `claude-opus`, `gemini-pro` and `gemini-flash` resolve from the built-in table. An id nothing recognizes does not fail the run — it is budgeted against the smallest window this build knows about, with a warning — so a typo here costs context rather than correctness. Set the id to match the LLM node the pipeline actually calls; budgeting for a larger window than the model has is what gets a request rejected downstream.

### Max context tokens

The explicit window, in tokens, used by `manual` mode; `0` falls back to the model default. Set it to the model's real total window, not the share you want the prompt to use — the percentages below divide this number. In `auto` mode the field is hidden and ignored.

### System prompt, query, document and history budget percentages

These four fields divide whatever window is left after the un-budgeted sections are counted (see [What is budgeted, and what is only counted](#what-is-budgeted-and-what-is-only-counted)). They are percentages of that remainder, and the node never lets them over-commit it: a set summing to more than 100 is scaled proportionally back to 100, and a set summing to less than 90 is honoured but logs a warning that the window is being under-used. The system prompt, query and document allowances are taken from their percentages in that order and history absorbs whatever is left, so history is the component that gives way first. Raise **Document budget %** for retrieval-heavy pipelines where history is short; raise **History budget %** for long chat sessions with few documents. A component given `0` is emptied whenever the request is over budget, which is a legitimate way to say "drop history before you touch my documents".

## Notes

### What is budgeted, and what is only counted

Exactly four fields of the incoming `Question` are budgeted and trimmed: `role` (the system prompt), `questions`, `documents` and `history`. Everything else `Question.getPrompt()` renders is **counted against the window but never trimmed**:

- `instructions`, including the JSON-format boilerplate `expectJson` injects (the `prompt` node appends here);
- `examples`;
- `context` (retrieval nodes fill this);
- `goals`;
- the section markup itself — the `### System Instructions:` / `### Documents:` / `### Current Task:` headers, the `Document N) Content:` and `role:` line prefixes, and the CRLF joins between them.

That second group is measured, not estimated: the incoming question is rendered through `getPrompt()` with the four budgeted fields emptied, the result is counted with the node's own tokenizer, and the total is subtracted from the context window *before* the per-component percentages are applied. A request is therefore judged against the prompt that will actually be sent — a question whose `role`, `questions`, `documents` and `history` fit but whose instructions and context push the rendering over the window is trimmed instead of being waved through. The figure errs high: it keeps the markup of every document, history message and question entry even though trimming may later drop some of them, and it adds a two-token margin for the line break `getPrompt()` appends after a non-empty `role`, which the blanked rendering cannot see.

If the un-budgeted fields alone fill the window, nothing is left to allocate: every budget becomes 0, all four budgeted fields are emptied, and the node warns once naming the cost. This node cannot shorten `instructions`, `examples`, `context` or `goals` — shorten them upstream, or raise **Max context tokens**.

### Where the context-window size comes from

`auto` mode resolves the window for the configured model in this order:

1. **The live model catalog** — the `modelTotalTokens` value on the matching `preconfig` profile of any LLM node, read through the engine's own service registry (`rocketlib.getServiceDefinitions()` to enumerate the registered types, then `getServiceDefinition()` for each raw definition; whichever definitions publish `modelTotalTokens` contribute — the chat `llm_*` nodes, the `image_vision_*` nodes, and the embedding/search nodes alike). Because the registry is the same path the engine used to load the nodes, the catalog is found whether this node runs from the source tree, from an installed node store, or from a `--node_path` materialisation with no sibling directories; it is re-read at every pipeline start, so a reloaded registry is never masked by a stale cache. Those values are kept current by the [`sync-models`](https://github.com/rocketride-org/rocketride-server/tree/develop/tools/sync_models) tool, so `gpt-5.4`, `claude-sonnet-4-6`, `models/gemini-3.1-pro-preview` and every other id the LLM nodes publish resolve without this node hard-coding them. Provider-scoped ids also resolve under their bare name (`openai/gpt-5` → `gpt-5`), but only when that name is unambiguous: an unscoped profile always wins, and a bare name that two gateways disagree about is dropped so it falls through to the table below rather than silently picking one. Where the same full id appears in two services files with different windows, the smaller is used.
2. **A built-in fallback table** (`ContextOptimizer.MODEL_LIMITS`), refreshed against that catalog on 2026-09-04. It covers deployments where no LLM node is registered with the engine, and it is where the abbreviated family aliases that no provider actually publishes — `claude-sonnet`, `claude-opus`, `gemini-pro`, `gemini-flash` — are defined.
3. **The conservative fallback** — the *smallest* context window published by any registered chat-LLM profile (`llm_*` nodes / `classType: ["llm"]`) or by the fallback table — 8 191 tokens on develop today, the smallest published chat windows (`gpt-4`, `codestral-latest`, `mistral-medium-2505`) — with a one-time warning naming the unresolved model id. Embedding input limits and vision models are catalogued for lookup but never lower this floor. An unknown id is usually a typo or a model this build predates; budgeting it low costs some unused context, whereas the previous optimistic 128 000 default made the provider reject the request outright for any smaller-window model. Set **Max context tokens** for the real window.

`manual` mode sets **Max context tokens** explicitly and bypasses all three.

The engine also exposes the *connected* LLM's own limit and tokenizer to upstream nodes through `IInvokeLLM.GetContextLength()` / `GetTokenCounter()` (as used by `summarization` and `preprocessor_llm`). That channel is only reachable after `beginFilter`, so this node does not consume it today; `manual` mode is the escape hatch when both the catalog and the fallback table are wrong for a given deployment.

### Offline use

Token counting uses `tiktoken`, which downloads its BPE vocabulary from `openaipublic.blob.core.windows.net` the first time a given encoding is requested (`o200k_base` for the GPT-5 / GPT-4o families, `cl100k_base` otherwise) and then caches it on disk. In an air-gapped or egress-restricted deployment, pre-seed that cache and point `TIKTOKEN_CACHE_DIR` at it before starting the engine. The node's own `services.json` test cases exercise the same path, so a CI runner without egress needs the same pre-seeded cache.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `context_optimizer.document_budget_pct` | `number` | **Document budget (%)**<br/>Percentage of context window for retrieved documents | `50` |
| `context_optimizer.history_budget_pct` | `number` | **History budget (%)**<br/>Percentage of context window for conversation history | `25` |
| `context_optimizer.max_context_tokens` | `number` | **Max context tokens**<br/>Override model token limit (0 = use model default) | `0` |
| `context_optimizer.model_name` | `string` | **Model name**<br/>Model identifier for context-window lookup. Use an id published by an llm_* node (e.g. gpt-5.4, claude-sonnet-4-6, models/gemini-3.1-pro-preview); a short family alias such as claude-sonnet also resolves. |  |
| `context_optimizer.profile` | `string` | **Mode**<br/>Context optimization mode | `"auto"` |
| `context_optimizer.query_budget_pct` | `number` | **Query budget (%)**<br/>Percentage of context window for the query/question | `15` |
| `context_optimizer.system_prompt_budget_pct` | `number` | **System prompt budget (%)**<br/>Percentage of context window for system prompt | `10` |

## Dependencies

- `tiktoken` `>=0.7.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/context_optimizer)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
