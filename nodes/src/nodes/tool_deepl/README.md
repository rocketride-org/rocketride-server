# tool_deepl

Exposes [DeepL](https://www.deepl.com) translation and AI rephrasing as agent tool functions.

## What it does

Agents invoke this node through the tool invoke channel. It exposes two tools: `deepl_translate` (translate text into a target language) and `deepl_write` (rewrite text in a chosen style or tone). Both return the full ordered list of results plus a top-level `text` convenience field holding the first result's text.

Because `lanes` is empty (`{}`), this node has no pipeline input/output lanes — it is consumed exclusively by agent runtimes through the `invoke` capability.

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

| Tool              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `deepl_translate` | Translate one or more texts into a target language           |
| `deepl_write`     | Rewrite one or more texts in a chosen writing style or tone  |

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

`writing_style` and `tone` are **mutually exclusive** — supplying both is rejected before any HTTP call.

**Write language restriction:** `deepl_write` supports a narrower target-language set than translate: `de`, `en-GB`, `en-US`, `es`, `fr`, `it`, `ja`, `ko`, `pt-BR`, `pt-PT`, `zh`. An invalid write target is rejected client-side (no HTTP call) with an error naming the valid set.

Returns `improvements[]` (each with `text`, `target_language`, and `detected_source_language`) plus a top-level convenience `text`.

## Limits

Both tools accept a single string or an array of up to **50 text entries** per call. That 50-entry cap is enforced by this node: a longer array is rejected client-side with an error and no HTTP call is made.

The node does not impose a request byte-size limit. DeepL itself rejects oversized request bodies, and when it does the node surfaces DeepL's own error message. (DeepL also caps total characters by plan, for example the Free tier's 500,000 characters/month, which the node reports as a quota error on HTTP 456.)

## Configuration

| Field                   | Default             | Description                                                        |
| ----------------------- | ------------------- | ------------------------------------------------------------------ |
| API Key                 | *(empty)*           | DeepL API key. Encrypted at rest, masked in the UI.                |
| Default Target Language | `EN-US`             | Target language used by `deepl_translate` when the agent omits one. Applies to `deepl_translate` only, not `deepl_write` (which takes its target language solely from the call argument). |
| Formality               | `default`           | Default formality for `deepl_translate` when the agent omits one (subject to the formality caveat above). |
| Model Type              | *(empty)*           | Default translation model for `deepl_translate` when the agent omits one. Empty (the default) lets DeepL choose, so no model preference is forced on every call. |

For all three defaults the resolution rule is: the agent argument wins, the config is the fallback, and an empty config means the parameter is omitted from the request.

## Upstream docs

- [DeepL API documentation](https://developers.deepl.com/docs)
