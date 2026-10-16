# guardrails

A RocketRide filter node that screens questions before they reach the LLM and answers before they reach your users.

## What it does

Sits in the pipeline as a guard filter, evaluating questions on the way in and answers on the way out. On the input side it catches prompt injection, enforces topic rules (blocked and allowed keyword lists), and caps input length or estimated token count. On the output side it checks answers for hallucination (keyword grounding against source documents), flags harmful content, detects PII leaks (emails, phones, SSNs, credit cards, IP addresses), and validates the output format.

All checks are pure stdlib and regex: the node has no external dependencies, no model calls, and adds no network latency.

How it reacts is controlled by the `policy_mode` field: `block` drops the offending question or answer and never forwards it, `warn` logs the violation and forwards anyway, and `log` records the violation silently. The default profile runs in `warn` mode, so a freshly added node never blocks traffic until you opt in.

Text that is empty or whitespace-only is forwarded without checks.

---

## Configuration

### Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `questions` | Input checks run before the question is forwarded to the LLM |
| `answers` | `answers` | Output checks run after the LLM responds |
| `documents` | `documents` | Forwarded unchanged; content is collected as ground-truth context for the hallucination check |

Question text is assembled from both the question objects and any attached context before evaluation. Collected document content resets per pipeline object.

### Fields

| Field | Type | Description |
|---|---|---|
| `policy_mode` | string | Default `warn`; controls block, warn, or log behavior |
| `enable_prompt_injection` | boolean | Detect prompt injection attempts in input |
| `enable_content_safety` | boolean | Detect harmful or unsafe output |
| `enable_pii_detection` | boolean | Detect personal information in output |
| `enable_hallucination_check` | boolean | Verify output claims against source documents |
| `enable_nonce_fencing` | boolean | Default `false`; fence untrusted question text and context |
| `nonce_length` | integer | Default 16 bytes; whole-byte range 16–128 |
| `max_input_length` | number | Maximum input character count; 0 means unlimited |
| `max_tokens_estimate` | number | Estimated token limit; 0 means unlimited |
| `expected_format` | string | Required output format, or empty for no check |
| `blocked_topics` | array | Keywords for topics that should be rejected |
| `allowed_topics` | array | If set, input must contain one of these keywords |
| `profile` | string | Default `basic`; selected guardrails profile |

### Nonce length (bytes)

`nonce_length` defaults to 16 bytes and accepts whole-byte values from 16 through 128. Values outside this range are clamped by the runtime validator.

## Profiles

Three built-in profiles control which fields are exposed in the UI and set sensible starting defaults.

| Profile | Behaviour |
|---|---|
| Basic *(default)* | Prompt injection + PII detection, `warn` mode. Nonce fencing off. |
| Strict | All checks enabled, `block` on violation, `max_input_length` 50000, and `max_tokens_estimate` 4096. Nonce fencing is off by default to avoid silently rewriting text for existing downstream consumers. |
| Custom | All checks enabled, `warn` mode. Every field is configurable individually. |

## Input checks

Run on the `questions` lane before the question is forwarded. Prompt-injection detection covers instruction overrides, system-prompt extraction, jailbreaks, delimiter/token injection, and encoding-evasion commands. Topic restrictions use case-insensitive substring matching. Input length checks run only when a limit is configured; token counts are estimated as word count times 1.3.

## Nonce fencing

When `enable_nonce_fencing` is true, accepted questions are mutated before forwarding. One cryptographically secure nonce is selected per execution cycle, then every question text and context string is wrapped with that nonce's markers. A `Security Directive` instruction uses the same markers.

Caller-supplied `Question.instructions` are rejected while nonce fencing is enabled, preventing untrusted caller instructions from bypassing the fencing boundary. If a nonce collision cannot be resolved, the question is blocked. Fencing is disabled by default in every profile because some downstream consumers read raw question text as data.

## Output checks

Run on the `answers` lane before forwarding. Checks cover lexical hallucination grounding, harmful content, PII leaks, and configured JSON, Markdown, bullet-list, or numbered-list format compliance.

## Policy modes

| Mode | Effect |
|---|---|
| `block` | Logs each violation and drops the question or answer. |
| `warn` | Logs each violation and forwards the item. |
| `log` | Forwards the item without warnings. |

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `allowed_topics` | `array` | **Allowed topics** |  |
| `blocked_topics` | `array` | **Blocked topics** |  |
| `enable_content_safety` | `boolean` | **Enable content safety check** | `true` |
| `enable_hallucination_check` | `boolean` | **Enable hallucination check** | `false` |
| `enable_pii_detection` | `boolean` | **Enable PII detection** | `true` |
| `enable_prompt_injection` | `boolean` | **Enable prompt injection detection** | `true` |
| `expected_format` | `string` | **Expected output format** | `""` |
| `guardrails.profile` | `string` | **Profile** | `"basic"` |
| `max_input_length` | `number` | **Max input length** | `0` |
| `max_tokens_estimate` | `number` | **Max tokens estimate** | `0` |
| `policy_mode` | `string` | **Policy mode** | `"warn"` |

## Source

[View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/guardrails)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
