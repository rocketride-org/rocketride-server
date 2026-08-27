# hackjudge_engine

The verdict node of the Hack Judge suite: given a GitHub repository and a target
product definition, it decides deterministically whether the project really used
the product, and how deeply.

## What it does

Hackathon sponsors need to know which submissions actually built on their product
and which only name-dropped it. This node fetches the repository, scans manifests,
source files, pipelines and deploy configuration, and returns a scored verdict:

- a tag (`Significant` / `Moderate` / `Less` / `None`) with the numeric score,
- a backbone read (`Yes` / `Partial` / `No`): is the product load-bearing,
- the evidence behind every point (files, call sites, markers),
- `kb_processed`: the KB of source actually scanned, for metering,
- a ready `explain_prompt` a downstream LLM node can use to write the
  plain-English explanation of the verdict.

The verdict itself never involves an LLM: same repo, same target, same answer.
The engine is vendored under `_engine/` (see `VENDORED.md`) and is the same code
validated against the production Hack Judge server, byte-identical verdicts on
the full acceptance set.

If any file fetch fails mid-scan the node returns `fetch_incomplete` instead of
a verdict, so a flaky network can never shrink the evidence and change a score.
The caller retries that repository; it is never judged on partial evidence.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | JSON job in, JSON verdict out |
| `questions` | `questions` | The enriched envelope, forwarded to the next stage |

## The verify flow envelope

The Hack Judge pipeline wires several nodes onto one questions lane, so every
record carries an address: `{"flow": "verify", "next": "<stage>"}`. This node
only acts when `next` is `engine` (or unset) and drops everything else without
fetching anything. After a verdict it stamps `next: "store"` and forwards, so
persistence and token settlement happen downstream.

## Job fields

```json
{"flow": "verify", "next": "engine",
 "repo_url": "https://github.com/team/project",
 "target": {"name": "LaserData", "dependency_names": "laser-sdk, ...", "...": "..."},
 "event_date": "2026-08-03", "history_penalty": 2.0}
```

`target` accepts the same free-text config the Targets editor produces; omit it
to judge against the built-in preset. `event_date` enables the commit-freshness
and history-tamper checks with `history_penalty` as the judge-set deduction.

## Config

| Field | Meaning |
| --- | --- |
| `github_token` | GitHub token used for repository fetches (raises rate limits; read-only public scope is enough) |
| `name` | Optional label for this instance |

## Validation

Parity-proven against the production server on a 21-repo acceptance set
(identical verdicts, exact KB settlement) and exercised by the 12-check
in-engine suite together with the account, store and tokens nodes.
