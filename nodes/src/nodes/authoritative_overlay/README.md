# Authoritative Overlay Node

Part of the **Audit-grade financial extraction node suite**.

## Overview
The `authoritative_overlay` node is a pipeline filter that cross-checks extracted financial numbers against the live US SEC EDGAR company-concept API for a configured CIK.

Currently supported regulators:
- US SEC (EDGAR)

## Behavior

- **Input**: Pipeline `answers` (or `text` containing a JSON payload).
- **Process**: The node queries `https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json` and compares the extracted number against measurements that match the requested filing period.
- **Output**:
  - If the extracted number matches an official value **for that period**, the answer is forwarded downstream (once).
  - If there is a mismatch, missing period, failed lookup, or unrecognized regulator, the node **abstains** by dropping the answer and logging a warning.

### Period-scoped matching

A match is **not** "this number appears somewhere in the company's filing history." The answer payload must include at least one of `form`, `fy`, `fp`, `end`, `unit`, or `frame`. All provided filters are applied together. Typical payload:

```json
{
  "concept": "AccountsPayableCurrent",
  "value": "$69,860,000,000",
  "form": "10-K",
  "fy": 2025
}
```

Without a period the node abstains. A value that is correct for a 2010 10-K will not verify a 2025 extraction.

> [!NOTE]
> **Strict Matching**: The node uses exact matching (`math.isclose` with `rel_tol=1e-9`). This ensures that only exact financial figures are passed through. Filings restated to the nearest thousand will not match a value extracted to the unit.

## Configuration

See `services.json` for node configuration schemas.

The live `services.json` test block hits `data.sec.gov` and is excluded from the default `builder nodes:test` run (opt in with `ROCKETRIDE_INCLUDE_SKIP=authoritative_overlay`). Unit tests under `nodes/test/authoritative_overlay/` mock the API and do not require the network.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
