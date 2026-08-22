# guardrails

A RocketRide filter node that checks questions before they reach an LLM and answers before they reach users. Pick it when a pipeline needs configurable local rule checks at its boundary rather than another generation or retrieval step.

## What it does

Evaluates `questions` before forwarding them, `answers` before forwarding them, and collects `documents` as grounding context for answer checks. Input checks cover prompt-injection patterns, optional topic keywords, and optional size limits; output checks cover configured grounding, content-safety, PII, and format rules. Unlike an LLM moderation or retrieval node, it decides from the text and local configuration, then either forwards or suppresses the original pipeline item.

All checks are pure stdlib and regex: the node has no external dependencies, no model calls, and adds no network latency.

How it reacts is controlled by the `policy_mode` field: `block` drops the offending question or answer and never forwards it, `warn` logs the violation and forwards anyway, and `log` records the violation silently. The default profile runs in `warn` mode, so a freshly added node never blocks traffic until you opt in.

Text that is empty or whitespace-only is forwarded without checks.

---

## Lanes

| Lane in     | Lane out    | Description                                                           |
|-------------|-------------|-----------------------------------------------------------------------|
| `questions` | `questions` | Input checks run before the question is forwarded to the LLM         |
| `answers`   | `answers`   | Output checks run after the LLM responds                             |
| `documents` | `documents` | Forwarded unchanged; content is collected as ground-truth context for the hallucination check |

Question text is assembled from both the question objects and any attached context before evaluation. Collected document content resets per pipeline object.

## Profiles

Start with Basic to observe violations without interrupting a pipeline, or use Strict when rejected content must not continue. Choose Custom when the checks need to be selected individually.

| Profile            | Behaviour                                                                                                   |
|--------------------|-------------------------------------------------------------------------------------------------------------|
| Basic *(default)*  | Prompt injection + PII detection, `warn` mode. Only `policy_mode` is configurable in the UI.               |
| Strict             | All checks enabled, `block` on violation, `max_input_length` 50000, `max_tokens_estimate` 4096. Exposes `policy_mode`, `max_tokens_estimate`, and `expected_format`. |
| Custom             | All checks enabled with no size limit, `warn` mode. Exposes every individual check, limit, topic, format, and policy control. |

## Configuration

The generated schema is the field reference. Use the checks below to select what to enforce, then choose the policy mode that determines whether an observed violation should stop the pipeline.

### Input checks

Run on the `questions` lane before the question is forwarded:

Enable prompt-injection checking for untrusted questions. Use an allowed-topic list to constrain a focused workflow, or a blocked-topic list for specific unacceptable terms; both are case-insensitive substring checks, not semantic classification. Set one or both size limits when unusually large questions should be stopped before later nodes consume them.

- **Prompt injection** (rule `prompt_injection`, critical severity): regex patterns covering instruction-override attempts ("ignore all previous instructions"), system-prompt extraction, role-play jailbreaks (DAN and similar), delimiter/token injection (`<|system|>`, `[INST]`, etc.), and encoding-evasion commands; plus weighted keyword scoring (keywords such as `jailbreak`, `bypass`, `ignore safety`) that triggers when the combined score reaches 0.7. Topic restriction only runs when `blocked_topics` or `allowed_topics` is non-empty.
- **Topic restriction** (rule `topic_restriction`): blocked-keyword matches are high severity; failing to match any allowed keyword is medium severity. Matching is case-insensitive substring.
- **Input length** (rule `input_length`, medium severity): only runs when a limit is set (`max_input_length > 0` or `max_tokens_estimate > 0`). Tokens are estimated as word count times 1.3, so treat `max_tokens_estimate` as a rough budget rather than an exact tokenizer count.

---

### Output checks

Run on the `answers` lane before the answer is forwarded:

Enable hallucination checking only when relevant documents arrive on the `documents` lane before the answer. It is a lexical grounding test, so use it to flag potentially unsupported output rather than as a factual verifier. Select an expected format only when a downstream consumer requires that shape; an unrecognized format value is skipped.

- **Hallucination** (rule `hallucination`, high severity): sentence-level grounding check. Each output sentence is evaluated for keyword overlap (3+ character non-stop words) against the combined source documents; sentences with less than 30% coverage are flagged. The check is skipped when no documents have been received on the `documents` lane.
- **Content safety** (rule `content_safety`, critical severity): regex patterns across three categories: self-harm, violence (weapon and explosive construction), and illegal activity (hacking, theft, counterfeiting).
- **PII leak** (rule `pii_leak`, high severity): pattern matches for `email`, `phone_us`, `ssn`, `credit_card`, and `ip_address`.
- **Format compliance** (rule `format_compliance`, medium severity): only runs when `expected_format` is set. `json` must parse cleanly; `markdown` requires at least one markdown element (heading, bold, code, list marker); `bullet_list` and `numbered_list` require at least half the non-empty lines to be list items.

---

### Policy modes

When any enabled check fails, `policy_mode` decides the outcome:

| Mode    | Effect                                                                             |
|---------|------------------------------------------------------------------------------------|
| `block` | Each violation is logged as a warning and the question or answer is dropped; nothing is forwarded downstream. |
| `warn`  | Each violation is logged as a warning; the item is forwarded anyway.               |
| `log`   | The item is forwarded with no warnings emitted.                                    |

Blocking happens silently from the pipeline's point of view: downstream nodes simply never receive the item. Check the engine logs (`Guardrails input blocked: ...` / `Guardrails output blocked: ...`) to see what was rejected and why.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `allowed_topics` | `array` | **Allowed topics**<br/>If set, input must contain at least one of these keywords |  |
| `blocked_topics` | `array` | **Blocked topics**<br/>Keywords for topics that should be rejected |  |
| `enable_content_safety` | `boolean` | **Enable content safety check**<br/>Detect harmful or unsafe content in output | `true` |
| `enable_hallucination_check` | `boolean` | **Enable hallucination check**<br/>Verify that output claims are grounded in source documents | `false` |
| `enable_pii_detection` | `boolean` | **Enable PII detection**<br/>Detect personal identifiable information (emails, phones, SSNs, credit cards) in output | `true` |
| `enable_prompt_injection` | `boolean` | **Enable prompt injection detection**<br/>Detect and flag prompt injection attempts in input | `true` |
| `expected_format` | `string` | **Expected output format**<br/>Validate that output matches this format (empty = no check) | `""` |
| `guardrails.profile` | `string` | **Profile**<br/>Guardrails profile | `"basic"` |
| `max_input_length` | `number` | **Max input length (chars)**<br/>Maximum character count for input text (0 = no limit) | `0` |
| `max_tokens_estimate` | `number` | **Max tokens (estimate)**<br/>Maximum estimated token count for input text (0 = no limit) | `0` |
| `policy_mode` | `string` | **Policy mode**<br/>How to handle violations: block (reject), warn (log + continue), log (silent) | `"warn"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/guardrails)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
