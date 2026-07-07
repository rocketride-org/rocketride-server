# tool_deepl

Exposes [DeepL](https://www.deepl.com) translation and AI rephrasing as agent tool functions.

## What it does

Agents invoke this node through the tool invoke channel. It exposes two tools: `deepl_translate` (translate text into a target language) and `deepl_write` (rewrite text in a chosen style or tone). Both return the full ordered list of results plus a top-level `text` convenience field holding the first result's text.

Because `lanes` is empty (`{}`), this node has no pipeline input/output lanes: it is consumed exclusively by agent runtimes through the `invoke` capability.

## Setup

Set your DeepL API key via the node config field **API Key** or the environment variable:

```bash
ROCKETRIDE_DEEPL_KEY=...
```

### Key tiers and host routing

DeepL has two API tiers, and the node routes to the right host automatically based on the key:

- **Free** keys end in `:fx` and are routed to `https://api-free.deepl.com`. Note that DeepL has closed new DeepL API Free sign-ups in several regions, so a Free key may not be obtainable for new accounts.
- **Pro** keys (no `:fx` suffix) are routed to `https://api.deepl.com`. A Pro/Pro-API plan is the reliable way to obtain a working key.

The key is never written to logs or surfaced in any error message.

## Tools


| Tool | Description |
|---|---|---|
| `deepl_translate` | Translate text into a target language using DeepL. Accepts a single string or a batch of up to 50 strings. Returns each translation with its detected source language, plus a convenience "text" holding the first translation. |
| `deepl_write` | Rewrite text using DeepL Write. Accepts a single string or a batch of up to 50 strings, and an optional writing_style OR tone (not both). Returns each improvement with its detected source language, plus a convenience "text" holding the first improvement. |


### deepl_translate

| Parameter             | Required | Description                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `text`                | yes      | A string, or an array of up to 50 strings, to translate.                                      |
| `target_lang`         | yes      | Target language. Regional variants allowed (e.g. `EN-US`, `EN-GB`, `PT-BR`, `PT-PT`, `ZH-HANS`, `ZH-HANT`). |
| `source_lang`         | no       | Source language as a base code only (e.g. `EN`, not `EN-US`). Auto-detected when omitted.     |
| `formality`           | no       | One of `default`, `more`, `less`, `prefer_more`, `prefer_less`. See the caveat below.         |
| `model_type`          | no       | One of `latency_optimized`, `quality_optimized`, `prefer_quality_optimized`.                  |
| `preserve_formatting` | no       | Keep original formatting (punctuation, casing) when set.                                       |
| `context`             | no       | Additional context that influences translation but is not itself translated.                  |

Returns `translations[]` (each with `text` and `detected_source_language`, the full source-language word), a top-level convenience `text`, and `model_type_used` when a `model_type` was requested.

**Formality caveat:** DeepL only honors `formality` for a subset of target languages (roughly nine, such as German, French, Italian, Spanish, Dutch, Polish, Portuguese, Japanese, and Russian). Requesting it for an unsupported target language makes DeepL return an error, which the node surfaces rather than silently ignoring.

### deepl_write

| Parameter       | Required | Description                                                                                       |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `text`          | yes      | A string, or an array of up to 50 strings, to rewrite.                                             |
| `target_lang`   | no       | Restricted set (see below). When omitted, DeepL rewrites in the detected language.                 |
| `writing_style` | no       | One of `simple`, `business`, `academic`, `casual`, `default`, and their `prefer_*` variants.       |
| `tone`          | no       | One of `enthusiastic`, `friendly`, `confident`, `diplomatic`, `default`, and their `prefer_*` variants. |

`writing_style` and `tone` are **mutually exclusive**, supplying both is rejected before any HTTP call.

**Write language restriction:** `deepl_write` supports a narrower target-language set than translate: `de`, `en-GB`, `en-US`, `es`, `fr`, `it`, `ja`, `ko`, `pt-BR`, `pt-PT`, `zh`. An invalid write target is rejected client-side (no HTTP call) with an error naming the valid set.

Returns `improvements[]` (each with `text`, `target_language`, and `detected_source_language`) plus a top-level convenience `text`.

## Limits

Both tools accept a single string or an array of up to **50 text entries** per call. That 50-entry cap is enforced by this node: a longer array is rejected client-side with an error and no HTTP call is made.

The node does not impose a request byte-size limit. DeepL itself rejects oversized request bodies, and when it does the node surfaces DeepL's own error message. (DeepL also caps total characters by plan, for example the Free tier's 500,000 characters/month, which the node reports as a quota error on HTTP 456.)

## Configuration


| Field | Type | Description |
|---|---|---|
| `apikey` | string | Default empty. DeepL API key (from https://www.deepl.com/pro-api). A key ending in :fx is a Free-tier key and is routed to api-free.deepl.com automatically. |
| `targetLang` | string | Default "EN-US". Default target language for translation when the agent does not supply one. Regional variants are allowed (e.g. EN-US, EN-GB, PT-BR, PT-PT, ZH-HANS, ZH-HANT). |
| `formality` | string | Default "default". Default formality for translation. Only honored by a subset of target languages; DeepL returns an error for unsupported ones, which the node surfaces. |
| `modelType` | string | Default empty. Translation model to request. Empty lets DeepL choose its default. quality_optimized favors quality, latency_optimized favors speed, prefer_quality_optimized uses quality where available and otherwise falls back. |


For all three defaults the resolution rule is: the agent argument wins, the config is the fallback, and an empty config means the parameter is omitted from the request.

## Upstream docs

- [DeepL API documentation](https://developers.deepl.com/docs)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_deepl.apikey` | `string` | **API Key**<br/>DeepL API key (from https://www.deepl.com/pro-api). A key ending in :fx is a Free-tier key and is routed to api-free.deepl.com automatically. | `""` |
| `tool_deepl.formality` | `string` | **Formality**<br/>Default formality for translation. Only honored by a subset of target languages; DeepL returns an error for unsupported ones, which the node surfaces. | `"default"` |
| `tool_deepl.modelType` | `string` | **Model Type**<br/>Translation model to request. Empty lets DeepL choose its default. quality_optimized favors quality, latency_optimized favors speed, prefer_quality_optimized uses quality where available and otherwise falls back. | `""` |
| `tool_deepl.targetLang` | `string` | **Default Target Language**<br/>Default target language for translation when the agent does not supply one. Regional variants are allowed (e.g. EN-US, EN-GB, PT-BR, PT-PT, ZH-HANS, ZH-HANT). | `"EN-US"` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_deepl)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
