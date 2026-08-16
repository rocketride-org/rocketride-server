# input_prescreen

A RocketRide filter node that screens questions before they reach the LLM, mitigating OWASP LLM01 (Prompt Injection).

## What it does

Sits in the pipeline as a pre-LLM guard filter. On the input side it:

1. **Scans** incoming text (questions + context + RAG documents) against a compiled set of regex heuristic rules targeting known prompt injection markers — instruction overrides, delimiter injection, encoding evasion, roleplay jailbreaks, and multi-step attacks.
2. **Wraps** untrusted content in cryptographic nonce fences so the downstream LLM treats it strictly as data, not instructions.

All checks are pure stdlib (regex, secrets): no external dependencies, no model calls, no network latency.

How it reacts is controlled by the `policy_mode` field: `block` drops the offending question and never forwards it, `warn` logs the violation and forwards anyway, and `log` records the violation silently. The default profile (`strict`) runs in `block` mode.

Text that is empty or whitespace-only is forwarded without checks.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                       |
|-------------|-------------|-------------------------------------------------------------------|
| `questions` | `questions` | Input checks run before the question is forwarded to the LLM     |
| `documents` | `documents` | Forwarded unchanged                                               |

Question text is assembled from both the question objects and any attached context before evaluation.

### Fields

| Field | Type | Description | Default |
|---|---|---|---|
| `block_ignore_instructions` | boolean | Scan input for prompt injection heuristics | `true` |
| `enable_nonce_fencing` | boolean | Wrap untrusted content in cryptographic nonce fences | `true` |
| `nonce_length` | number | Nonce length in bytes (min 16, max 128) | `16` |
| `policy_mode` | string | How to handle violations: block, warn, log | `"block"` |
| `custom_rules` | array | Additional regex rules (each: id, pattern, category, severity, description) | `[]` |
| `max_input_length` | number | Max character count (0 = no limit) | `0` |

---

## Profiles

| Profile | Behaviour |
|---------|-----------|
| Strict *(default)* | Block injections, enable nonce fencing. Only `policy_mode` exposed in UI. |
| Moderate | Warn on injections, enable nonce fencing. Exposes `policy_mode` and `nonce_length`. |
| Custom | All fields configurable individually. |

---

## Heuristic rules

Built-in rules cover:

- **Instruction overrides** (critical): "ignore/disregard/forget all previous instructions", system prompt extraction, DAN jailbreaks, mode switch attacks
- **Delimiter injection** (critical/high): `<|system|>`, `[INST]`, `### system` headers
- **Encoding evasion** (high): "decode this base64/hex/rot13"
- **Multi-step jailbreaks** (critical): "first ignore instructions then..."

Custom rules can be added via the `custom_rules` array in `.pipe` config.

---

## Nonce fencing

When enabled, the node:

1. Generates a cryptographically secure nonce (CSPRNG) per execution cycle
2. Wraps each question text and context document between `<<<UNTRUSTED_DATA_{nonce}>>>` and `<<<END_UNTRUSTED_DATA_{nonce}>>>` markers
3. Appends a system prompt directive telling the LLM to treat fenced content as data-only

Nonce collision (nonce appearing in content) is handled by regeneration with up to 10 retries.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
