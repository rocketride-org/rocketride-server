---
title: Managed evaluations
---

Managed evaluations use `client.evals` and the versioned bearer HTTP API at
`/evals/v1`. They are durable, server-owned evaluations shared by the native UI,
SDKs, CLI, and MCP tools. The managed `rocketride evals` command coexists with
the separate offline `rocketride eval` workflow.

## Python SDK

```python
import asyncio
import json
import os

from rocketride import RocketRideClient, EvalsError


async def main():
    client = RocketRideClient(
        uri=os.environ['ROCKETRIDE_URI'],
        auth=os.environ['ROCKETRIDE_APIKEY'],
    )
    # HTTP only: connect() and async-with are unnecessary.
    capabilities = await client.evals.capabilities()
    with open('reviewed-spec.json', encoding='utf-8') as stream:
        spec = json.load(stream)
    saved = await client.evals.create(spec)
    evaluation = saved['evaluation']
    result = await client.evals.run(
        evaluation['id'],
        revision=evaluation['revision'],
        idempotency_key='ci-build-42',  # Persist and reuse for this submission.
    )
    result = await client.evals.wait(
        result['run']['id'],
        timeout=300,
        poll_interval=1,
    )
    print(result['run']['summary']['gate'])


asyncio.run(main())
```

Methods return the API response envelopes without inventing execution results.
JSON responses are dictionaries; `report(format='junit')` returns an XML string.

| Method | Parameters / behavior |
| --- | --- |
| `capabilities()` | Available environments, scorers, assistant |
| `list(project_id=None)` | Evaluation list; optional keyword filter |
| `get(evaluation_id)` | Evaluation and revision history |
| `create(spec)` | Create from a strict JSON spec dictionary |
| `revise(evaluation_id, spec, expected_revision=...)` | Create a guarded revision |
| `run(evaluation_id, revision=..., idempotency_key=..., baseline_run_id=None)` | Enqueue a durable run; required keyword revision and stable key |
| `runs(evaluation_id=None)` | Run list; optional keyword filter |
| `status(run_id)`, `cancel(run_id)` | Read or request cancellation |
| `baseline(evaluation_id, run_id)` | Explicitly select baseline |
| `report(run_id, format='json')` | Complete JSON or JUnit report |
| `compare(run_id)` | Run envelope containing its server comparison |
| `assist(instruction, spec)` | Proposal only |
| `review(run_id, case_id=..., scorer_id=..., status=..., reason=..., expected_report_revision=..., case_result_id=None)` | Review one human-scored result |
| `wait(run_id, timeout=300, poll_interval=1)` | Bounded polling; keyword budgets in seconds |

`EvalsApi` and `EvalsError` are exported from `rocketride`.
`client.evals.timeout` controls the per-request budget in seconds (default 30).
`EvalsError.status` contains the HTTP status when available and `.code`
contains the server code or `timeout`, `transport_error`, or
`invalid_response`. Invalid local arguments raise `ValueError`.

## Managed CLI

Both SDK distributions provide the same `rocketride evals` commands. They use
`ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` from the environment or workspace
`.env`, with `--uri` and `--apikey` overrides. Prefer environment credentials
so keys do not enter shell history. Every leaf command accepts `--json`
(one JSON value on stdout) or `--json=NEW_FILE` (JSON file plus human output).

```bash
rocketride evals capabilities --json
rocketride evals list --project-id PROJECT_ID --json
rocketride evals show EVALUATION_ID --json
rocketride evals create reviewed-spec.json --json
rocketride evals save reviewed-spec.json --json
rocketride evals save reviewed-spec.json --id EVALUATION_ID --expected-revision 1 --json
rocketride evals revision EVALUATION_ID reviewed-spec.json --expected-revision 1 --json

rocketride evals run EVALUATION_ID --revision 2 --idempotency-key ci-build-42 --wait --json
rocketride evals runs --evaluation-id EVALUATION_ID --json
rocketride evals status RUN_ID --wait --wait-timeout 120 --poll-interval 2 --json
rocketride evals status RUN_ID --gate --json
rocketride evals cancel RUN_ID --json

rocketride evals baseline EVALUATION_ID BASELINE_RUN_ID --json
rocketride evals run EVALUATION_ID --revision 2 --idempotency-key ci-build-43 --baseline-run-id BASELINE_RUN_ID --wait --json
rocketride evals compare CANDIDATE_RUN_ID --json
rocketride evals report RUN_ID --format json --output new-report.json --json
rocketride evals report RUN_ID --format junit --output new-report.xml --json

rocketride evals assist reviewed-spec.json --instruction "Clarify the scorer rubric" --json
rocketride evals review RUN_ID --case-id CASE_ID --case-result-id RESULT_ROW_ID --scorer-id HUMAN_SCORER_ID --status pass --reason "Inspected this trial output" --expected-report-revision 3 --json
```

`save` creates an evaluation unless `--id` is supplied. Updating requires
`--expected-revision`; a conflict is returned without retrying or overwriting a
newer revision. `revision` is the explicit update form.

A run requires an explicit revision and a caller-supplied idempotency key. Store
and reuse that same key, evaluation ID, revision, and baseline ID when resuming an
uncertain submission. Use a new key for an intentionally new execution. No SDK or
CLI request is retried automatically, including conflicts or network failures.

Without `--wait` or `--gate`, `run` and `status` return 0 for a successful
API operation; that is not a passing evaluation. `--wait`, `--gate`, and
`compare` use the server verdict:

| Exit | Meaning |
| --- | --- |
| 0 | Completed passing gate |
| 1 | Completed failing gate |
| 2 | Incomplete gate, queued/running under `--gate`, cancelled/error run, incompatible or missing comparison, timeout, usage or API failure |

All other successful operations return 0; their failures return 2. Neither
unknown cost nor missing evidence is synthesized. Empty or unapproved cohorts
cannot pass on the server.

CLI budgets are **seconds** in both languages: `--timeout` defaults to 30 per
HTTP request, `--wait-timeout` to 300 for the entire polling period, and
`--poll-interval` to 1. The initial POST has its own request budget. Polling
starts immediately and each GET is bounded by the remaining wait budget. Timeout
stops local waiting without cancelling the durable run. A failed wait after
enqueue retains the run ID and idempotency key in its JSON result; resume with
`status`. Use `cancel` to request cancellation explicitly.

`compare` reads the server comparison already attached to the candidate run,
using its recorded `baselineRunId`. It does not create a new comparison, execute
a pipeline, or change the selected baseline. Missing comparison is an error;
incompatibility returns exit 2 even if individual test results passed.

`review` accepts `pass`, `fail`, or `abstain`, a reason, and the current
`expectedReportRevision`. `caseId` is the stable dataset ID.
`caseResultId` / `--case-result-id` is the exact **`run.cases[].id`** of one
execution trial, not its trial number. It is optional only when `caseId`
identifies a single result; repeated trials require it. The server rejects
ambiguous reviews and stale report revisions. Human review cannot approve a
dataset case: approve it in a new spec revision before trusting its result.

`assist` returns a proposed spec for inspection. It never saves the proposal,
approves references, selects a baseline, or starts a run.

## Reports and credentials

`report` downloads the complete versioned JSON report (`{schemaVersion,run}`)
or JUnit XML. `--output` writes full evidence to a new file with private
permissions on POSIX; no parent directories are created. Existing files,
including symlinks, are refused. `--json=FILE` uses the same exclusive file
policy and reserves the destination atomically before submitting a mutation. On
Windows, files inherit directory access controls; use a private output directory.
Choose distinct
new paths for report evidence and JSON command metadata.

Console and JSON command output redact the configured bearer credential and
recognized credential fields. A JUnit report under `--json` is wrapped as
`{format:"junit",report:"..."}`; without `--json`, XML is printed directly.
`report --output` preserves the complete downloaded evidence, which can contain
sensitive pipeline inputs and outputs. Protect that file accordingly.

The HTTP API accepts an explicit HTTP(S) origin, equivalent WS(S) endpoint, or
bare `host:port`. The optional `/task/service` or `/evals/v1` suffix is
normalized to `/evals/v1`. HTTP ports follow the supplied origin; specify local
ports explicitly, for example `http://localhost:5565`. Other paths, embedded
credentials, query strings, fragments, and unsupported schemes are rejected
before HTTP. Redirects are refused and bearer credentials are never forwarded
to a redirect target. Server/provider transport errors are not echoed verbatim.
Remote origins require HTTPS or WSS. Plain HTTP/WS is allowed only for literal
loopback addresses or `localhost`, not other private-network hosts.

## Spec and execution semantics

Provide the strict v1 `EvaluationSpec` JSON, including `schemaVersion:1`,
`name`, `projectId`, an unchanged flat `pipeline` snapshot, `source`,
`inputMode`, `environment`, `datasetName`, `cases`, `scorers`,
`repetitions`, and `passCriteria`. The server validates fields and capabilities.
The pipeline must contain the selected source and its `project_id` must match
`projectId`. Use `development` or `staging` only when capabilities marks the
environment available.

Each case has a unique stable ID, name, input, and explicit `approved` boolean,
with optional reference, tags, and provenance. Scorers support `equals`,
`contains`, `not_contains`, `json`, `latency`, `llm_judge`, and `human`.
The server owns execution, scoring, baseline compatibility, report revisioning,
and gate decisions. Saving a spec or running its snapshot does not publish or
change the saved target pipeline.
