# llm_bedrock

A RocketRide LLM node that connects Amazon Bedrock-hosted foundation models to a pipeline.

## What it does

Provides an `llm` invoke connection backed by Amazon Bedrock. It is used primarily by
agents and other nodes that need an LLM, and can also be wired directly via lanes:
text arriving on the `questions` lane is answered on the `answers` lane.

Uses **langchain-aws (`ChatBedrock`)** on top of **boto3 / botocore**. The chat client is
created once per pipeline run with a fixed `temperature` of `0`; the output token cap is
taken from the model's configured output-token limit.

The node automatically prepends a cross-region inference prefix to the model ID based on
the configured AWS region: `eu.` for `eu*` regions, `apac.` for `ap*` regions, and `us.`
otherwise (for example, `meta.llama3-3-70b-instruct-v1:0` becomes
`us.meta.llama3-3-70b-instruct-v1:0` in `us-east-1`). Model IDs that are ARNs or already
carry a `us.` / `eu.` / `apac.` prefix are left untouched.

When you save the node configuration, it is validated with a minimal live API call
(`"Hi"`) against the selected model, so credential, model, and region problems surface
immediately instead of at pipeline runtime.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

| Field | Type | Description |
|---|---|---|
| `model` | string | Bedrock LLM model name or ARN for custom or provisioned models |
| `modelTotalTokens` | number | Total Tokens |
| `profile` | string | Default "meta_llama3_3-70b". LLM model |

`model` and `modelTotalTokens` only appear when the **Custom** profile is selected; the
built-in profiles set both for you.

---

## Profiles

The default profile is **Llama 3.3 70B Instruct** (`meta_llama3_3-70b`). All profiles
default to region `us-east-1`.

### Anthropic

| Profile           | Model ID                                    | Context     |
| ----------------- | ------------------------------------------- | ----------- |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | 200K tokens |
| Claude Haiku 4.5  | `anthropic.claude-haiku-4-5-20251001-v1:0`  | 200K tokens |
| Claude Opus 4     | `anthropic.claude-opus-4-20250514-v1:0`     | 200K tokens |
| Claude Opus 4.5   | `anthropic.claude-opus-4-5-20251101-v1:0`   | 200K tokens |
| Claude Sonnet 3.7 | `anthropic.claude-3-7-sonnet-20250219-v1:0` | 200K tokens |
| Claude Haiku 3.5  | `anthropic.claude-3-5-haiku-20241022-v1:0`  | 200K tokens |

### Meta

| Profile                            | Model ID                                 | Context     |
| ---------------------------------- | ---------------------------------------- | ----------- |
| Llama 3.3 70B Instruct *(default)* | `meta.llama3-3-70b-instruct-v1:0`        | 128K tokens |
| Llama 4 Scout 17B Instruct         | `meta.llama4-scout-17b-instruct-v1:0`    | 3.5M tokens |
| Llama 4 Maverick 17B Instruct      | `meta.llama4-maverick-17b-instruct-v1:0` | 1M tokens   |
| Llama 3.2 90B Vision Instruct      | `meta.llama3-2-90b-instruct-v1:0`        | 128K tokens |
| Llama 3.2 11B Vision Instruct      | `meta.llama3-2-11b-instruct-v1:0`        | 128K tokens |
| Llama 3.2 3B Instruct              | `meta.llama3-2-3b-instruct-v1:0`         | 128K tokens |
| Llama 3.2 1B Instruct              | `meta.llama3-2-1b-instruct-v1:0`         | 128K tokens |
| Llama 3.1 70B Instruct             | `meta.llama3-1-70b-instruct-v1:0`        | 128K tokens |
| Llama 3.1 8B Instruct              | `meta.llama3-1-8b-instruct-v1:0`         | 128K tokens |

### Amazon

| Profile            | Model ID                       | Context   |
| ------------------ | ------------------------------ | --------- |
| Nova 2 Lite        | `amazon.nova-2-lite-v1:0`      | 1M tokens |
| Titan Text Express | `amazon.titan-text-express-v1` | 8K tokens |

### AI21

| Profile         | Model ID                    | Context     |
| --------------- | --------------------------- | ----------- |
| Jamba 1.5 Large | `ai21.jamba-1-5-large-v1:0` | 256K tokens |
| Jamba 1.5 Mini  | `ai21.jamba-1-5-mini-v1:0`  | 256K tokens |

### Cohere

| Profile    | Model ID                     | Context     |
| ---------- | ---------------------------- | ----------- |
| Command R+ | `cohere.command-r-plus-v1:0` | 128K tokens |
| Command R  | `cohere.command-r-v1:0`      | 128K tokens |

### Custom

Select the **Custom** profile to use any Bedrock model not in the list. Provide the full
provider-prefixed model ID (e.g. `anthropic.claude-3-7-sonnet-20250219-v1:0`) or an ARN
for a custom or provisioned model, plus the model's total token limit. Bare model names
without a provider prefix are rejected at save time with a validation warning. See the
[Bedrock model IDs reference](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)
for available identifiers.

---

## Authentication

Provide an AWS access key ID and secret access key with permission to invoke the chosen
Bedrock model in the configured region. Credentials are passed directly to the Bedrock
client and are not persisted by the node.

Save-time validation performs a minimal test invocation and reports provider errors
verbatim. One gotcha: Bedrock returns a `ValidationException` (HTTP 400) when the
**region** does not match your account or model availability, while incorrect keys
surface as different error types. If you see a `ValidationException` during validation,
verify the AWS region first.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `bedrock.profile` | `string` | **Model**<br/>LLM model | `"meta_llama3_3-70b"` |
| `model` | `string` | **Model**<br/>Bedrock LLM model name or ARN for custom or provisioned models |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |

## Dependencies

- `langchain-aws`
- `langchain-core`
- `langchain`
- `boto3`
- `botocore`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_bedrock)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
