# Agent repetition investigation, November 5, 2026

## Findings and changes

The Redis client did not retry the observed writes. Each was a separate
model-selected invocation through the LlamaIndex agent.

The LlamaIndex adapter also contained a concrete metadata bug: it put the
host's actual JSON Schema in the description but inferred the formatter's
`Tool Args` schema from an argument-free placeholder function. The formatter
therefore advertised empty argument properties alongside the real schema.
Three new regression assertions failed against that adapter before its fix.

The adapter now supplies the host schema through `ToolMetadata`, preserving
required fields, nested constraints and independent copies. The placeholder
is still never executed; dispatch and validation remain with the host tool.
Four real-formatter regression tests pass. No implicit write deduplication,
command retry or change to Redis increment semantics was introduced.

The local 3B model remained unreliable after the metadata fix: on the original
unquoted-key request it issued one increment and one read, but still renamed
`counter` to `counter_key`. With clearer instructions and quoted names it
passed nine precise requests, which does not establish broad reliability.
The initial reproduction instead incremented by 1 and then by 3, both on the
wrong key, returning 4. These observations support both a schema correction
and stronger model/configuration acceptance, not a claim that model size alone
explains every failure.

[Comparison traces and model manifest digests](2026-11-05-agent-comparison.json)
record the selected tools, inputs, observations and actual requested-key state.
The runs did not truncate the prompt; context exhaustion was not established
as the cause of this reproduction.

## Tested profile and results

- Source base: `bed7a87e5a26fa1c7bb2e08ca93200f130db89b5` plus this change.
- Official prebuilt engine 3.6.0.646 (`9e661aae`), embedded Python 3.12.13.
- LlamaIndex core 0.14.25, redis-py 7.4.1, Valkey 8.1.11.
- Ollama 0.40.14 on Apple Silicon. Local `qwen2.5:7b`, Q4_K_M, with
  16,384-token context and temperature 0, prepared using the checked-in
  Modelfile as `rocketride-redis-qwen2.5-7b`.
- The checked-in agent example adds explicit key/argument instructions and
  a rule to stop after each requested operation succeeds. It stays read-only
  by default. Tests enable writes only for isolated, disposable prefixes.

| Validation | Result |
| --- | --- |
| Three fresh real-engine agent pipelines, ten requests each | 3 passed; 30 requests, one correct invocation each |
| Seven tools, exact keys/arguments and real Redis state | Passed |
| Two intentional increment requests in each pipeline | Values 3 then 6, one invocation per request |
| Original plain-language increment request | Correct key, amount 3 and one invocation in each pipeline |
| Broader node/lifecycle/live/auth/TLS/contracts and formatter suite | 685 passed; three model cases skipped in this separate run because no model was selected |
| Lint, formatting, both README schemas, credential catalog and Action pins | Passed |

The three model cases skipped in the broader run are the same cases explicitly
selected and passed in the separate live-model run; these are not CI model runs.

- [Live-model acceptance log](2026-11-05-agent-acceptance.txt)
- [Broader regression log](2026-11-05-agent-node-regressions.txt)
- [Reproduction commands](../README.md#real-model-acceptance)
- [Interactive agent pipeline](../../../src/nodes/tool_redis/agent-example.pipe)

## Limits and remaining work

This verifies these requests and this profile. It is not an exactly-once
execution guarantee for arbitrary language, models or prompts. The 3B model's
wrong-key behavior remains a reason not to use that setup for the write demo.
An earlier pre-fix 7B run completed two pipelines but one additional pipeline
failed during startup with `Python error 1`, before model invocation. That
startup error was not diagnosed or attributed to the schema fix. All three
fresh post-fix pipelines initialized and passed.

No production Redis, cloud-model credentials or hosted/public Redis endpoint
was used. Test keys were removed and pipelines terminated. GitHub test
workflows still require maintainer action; no CI pass or new VS Code canvas
walkthrough is claimed by these CLI results.
