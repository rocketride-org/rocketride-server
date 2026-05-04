# LLM Translate

Translates text between languages using any connected LLM node.

## What it does

- `text → text` — translates plain text in one LLM call at stream close.
- `documents → documents` — translates `Doc.page_content` for all segments in a single
  batched LLM call and passes `metadata` through unchanged, preserving `time_stamp` /
  `time_stamp_end` so downstream nodes (e.g., Video Player) keep subtitle timing.

Source language can be auto-detected (leave **Source language** blank) or specified
explicitly. Translation style shapes the instruction sent to the LLM.

## Setup

1. Drop an LLM node (e.g., **OpenAI**, **Anthropic**, **Gemini**) onto the canvas.
2. Connect its **llm** output to the **LLM Translate** invoke channel labelled `llm`.
3. Configure **Target language** (and optionally **Source language** and **Translation style**).

No API key is needed in this node — authentication is handled by the connected LLM node.

## Translation styles

| Style         | Behaviour                                                                     |
| ------------- | ----------------------------------------------------------------------------- |
| **Standard**  | Neutral, general-purpose translation.                                         |
| **Technical** | Preserves technical terms, acronyms, and domain-specific vocabulary exactly.  |
| **Formal**    | Uses formal, professional register.                                           |
| **Casual**    | Uses natural, conversational language.                                        |
| **Literary**  | Preserves the literary style, rhythm, and artistic intent of the original.    |
| **Custom**    | Uses the text entered in **Custom instructions** as the full LLM instruction. |

## Example pipeline: translated video subtitles

```
video source → Transcribe → LLM Translate → Video Player
                                                  ↑
              video source ───────────────────────┘
              llm_openai   ──(invoke)──────────────┘
```

- `Transcribe.documents → LLM Translate.documents` — timed transcript chunks enter,
  translated chunks exit with the same timestamps.
- `source.video → Video Player.video` — original video stream.
- `LLM Translate.documents → Video Player.documents` — translated subtitles.
- `llm_openai → LLM Translate` (invoke channel) — provides translation inference.

## Batching

All document segments are sent to the LLM in a single call as a JSON array, keeping
API usage minimal. If the LLM returns a mismatched number of translations (rare but
possible with very large batches), the node automatically falls back to one call per
segment to guarantee correctness.

## Supported languages

Any BCP-47 language code supported by the connected LLM works. The UI lists ~20 common
codes. You can wire this node to any LLM that supports translation (GPT-4o, Claude 3,
Gemini 1.5, Mistral, Ollama models, etc.).
