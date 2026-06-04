# guardrails

An input/output safety filter for AI pipelines.

## What it does

Checks questions before they reach the LLM and answers after the LLM responds. On the input side it can detect prompt injection attempts, enforce topic restrictions (blocked/allowed keywords), and cap input length or estimated token count. On the output side it can detect hallucinations (grounding answers against source documents), flag unsafe content, detect PII leaks (emails, phones, SSNs, credit cards), and validate the output format.

Each violation is handled according to the **policy mode**: `block` rejects the offending question/answer, `warn` logs the violation and forwards anyway, and `log` records it silently.

**Lanes:**

| Lane in     | Lane out    | Description                                              |
| ----------- | ----------- | ------------------------------------------------------- |
| `questions` | `questions` | Apply input checks before forwarding to the LLM         |
| `answers`   | `answers`   | Apply output checks after the LLM responds              |
| `documents` | `documents` | Collected as ground-truth context for hallucination checks |

## Configuration

| Field                          | Default | Description                                                              |
| ------------------------------ | ------- | ------------------------------------------------------------------------ |
| Policy mode                    | `warn`  | How to handle violations: `block`, `warn`, or `log`.                     |
| Enable prompt injection        | `true`  | Detect and flag prompt injection attempts in input.                      |
| Enable content safety check    | `true`  | Detect harmful or unsafe content in output.                              |
| Enable PII detection           | `true`  | Detect personal identifiable information in output.                      |
| Enable hallucination check     | `false` | Verify output claims are grounded in source documents.                   |
| Max input length (chars)       | `0`     | Maximum character count for input text (`0` = no limit).                 |
| Max tokens (estimate)          | `0`     | Maximum estimated token count for input text (`0` = no limit).           |
| Expected output format         | *(none)*| Validate output matches a format: `json`, `markdown`, `bullet_list`, `numbered_list`. |
| Blocked topics                 | *(empty)* | Keywords for topics that should be rejected.                           |
| Allowed topics                 | *(empty)* | If set, input must contain at least one of these keywords.             |

## Profiles

| Profile             | Notes                                                          |
| ------------------- | -------------------------------------------------------------- |
| Basic _(default)_   | Prompt injection + PII detection, `warn` mode                  |
| Strict              | All checks enabled, `block` on violation                       |
| Custom              | Configure each check individually                              |
