# schema_validate

A RocketRide guard node that flags inconsistencies in structured financial facts —
most notably a **cost row stored as revenue** — and makes sure **provenance is never
dropped**. It is the validation step of the audit-grade financial extraction node suite.

## What it does

Reads structured facts on the `answers` lane and, for every fact, runs a set of
deterministic audit checks. The node is a **guard**: it *flags*, it never fixes,
drops, or reorders records, and it never calls an LLM or the network.

For every fact it inspects, the node:

- adds a `validation` block (`valid`, `severity`, `flags`);
- appends a `provenance` entry recording that the fact was checked and which flags
  fired — so the audit chain is always present on the fact it leaves behind.

Records that are not fact objects (plain text, bare numbers), and non-dict elements
inside a list payload, are **passed through unchanged** — the node never drops a
record.

## Fact-record convention

A "fact" is a JSON object. The relevant fields are configurable:

- `amount_field` (default `amount`) — the numeric amount;
- `currency_field` (default `currency`) — the currency code;
- `metric_field` (default `metric`) — the line-item label (e.g. `"Cost of goods sold"`);
- `category_field` (default `category`) — the declared classification (e.g. `"revenue"`).

An answer payload may be a single fact object or a list of fact objects; other shapes
pass through untouched.

## Checks

| Flag code | Severity | Fires when |
|---|---|---|
| `missing_amount` | warning | `amount_field` is absent or `null`. |
| `non_numeric_amount` | warning | `amount_field` is present but not a finite number (bools and comma/currency-formatted strings are rejected). |
| `missing_currency` | warning | `currency_field` is absent, `null`, or blank. |
| `category_metric_mismatch` | **error** | The metric label implies one category but the fact declares another — the headline "cost row stored as revenue" guard. |
| `ambiguous_metric` | warning | The metric label matches keywords from two or more categories, so the declared category can't be corroborated (suppresses the mismatch check). |
| `sign_category_mismatch` | configurable (`sign`, default warning) | The amount's sign contradicts its class (an expense/liability with a positive amount, or revenue/asset with a negative amount). Zero never fires. Applies only to the four built-in signed classes (revenue/expense/asset/liability); a custom category has no sign convention and is not sign-checked. |
| `unknown_category` | warning | `category_field` is present but is not a recognised classification. |
| `missing_provenance` | configurable (`require_provenance`, default error) | The **incoming** fact has no usable `provenance` list — the value is absent, `null`, an **empty list** `[]`, or not a list at all. |
| `malformed_provenance` | warning | `provenance` is present but is not a list (the original value is preserved, never discarded). |

`valid` is `true` when no `error`-severity flag fired (warnings do not invalidate).
`severity` is the highest severity across the flags (`error` > `warning` > `ok`).

The metric classifier is **keyword-based**: it case-insensitively substring-matches the metric label
against `category_metric_map`. It is intentionally conservative — a label that matches keywords from
two or more categories resolves to `ambiguous` (and suppresses the mismatch check) rather than
guessing, and a label matching none is simply not classified. Because it is heuristic, tune
`category_metric_map` to your corpus: e.g. a label containing `"tax"` (expense) and `"income"`
(revenue) is treated as ambiguous, and `"deferred tax asset"` matches the `"tax"` keyword. Declared
categories are recognised from the built-in aliases **plus** the keys of `category_metric_map`, so a
custom category (e.g. `equity`) added to the map is accepted rather than flagged `unknown_category`.

## Example

Input — a cost row wrongly declared as revenue, positive amount, no provenance:

```json
{ "metric": "Cost of goods sold", "category": "revenue", "amount": 500, "currency": "USD" }
```

Output (defaults `sign="warning"`, `require_provenance="error"`):

```json
{
  "metric": "Cost of goods sold",
  "category": "revenue",
  "amount": 500,
  "currency": "USD",
  "validation": {
    "op": "schema_validate",
    "valid": false,
    "severity": "error",
    "flags": [
      { "code": "category_metric_mismatch", "severity": "error", "field": "category",
        "message": "metric 'Cost of goods sold' implies category 'expense' but fact declares 'revenue'" },
      { "code": "missing_provenance", "severity": "error", "field": "provenance",
        "message": "fact has no usable provenance list; upstream extraction chain is not recorded" }
    ]
  },
  "provenance": [
    { "op": "schema_validate", "valid": false,
      "flag_codes": ["category_metric_mismatch", "missing_provenance"] }
  ]
}
```

The sign check does **not** fire here: it resolves the class from the *declared*
category when that is a signed class, and a declared `revenue` with a positive
amount is self-consistent — the mismatch flag already captures the inconsistency.
`sign_category_mismatch` fires when the sign contradicts the resolved class, e.g.
a fact declared `expense` (or with an expense metric and no declared category)
carrying a positive amount.

A clean fact receives `validation: { "op": "schema_validate", "valid": true, "severity": "ok", "flags": [] }`
and a provenance entry with `"flag_codes": []` — proof it was checked.

## Provenance handling

The node always appends its own `{ "op": "schema_validate", ... }` entry, never
rewriting existing entries and preserving order:

- if `provenance` is a non-empty list → the entry is appended to a copy of it;
- if `provenance` is absent/`null` → a new `[entry]` list is created (and
  `missing_provenance` fires);
- if `provenance` is an **empty list** `[]` → the entry is appended (result
  `[entry]`), and `missing_provenance` fires — an empty chain is treated as no
  usable provenance;
- if `provenance` is present but not a list → the original value is preserved in
  place as `[original, entry]` (and `malformed_provenance` fires).

`missing_provenance` is evaluated against the **incoming** fact, before this node
appends its own entry, so the guard can actually fire.

## Configuration

### Lanes

| Lane      | In → Out              | Behaviour                                                                                     |
|-----------|-----------------------|-----------------------------------------------------------------------------------------------|
| `answers` | `answers` → `answers` | Annotates fact objects with a `validation` block; all other records pass through unchanged. |

### Fields

| Field                 | Type    | Default      | Description                                                                                       |
|-----------------------|---------|--------------|---------------------------------------------------------------------------------------------------|
| `amount_field`        | string  | `amount`     | The fact field holding the numeric amount.                                                        |
| `currency_field`      | string  | `currency`   | The fact field holding the currency code.                                                         |
| `metric_field`        | string  | `metric`     | The fact field naming the line item — classifier input for the mismatch check.                    |
| `category_field`      | string  | `category`   | The fact field holding the declared classification.                                               |
| `category_metric_map` | object  | built-in map | Map of canonical category → metric keyword substrings. Empty ⇒ the mismatch check is skipped.      |
| `sign`                | enum    | `warning`    | Severity for `sign_category_mismatch` (`off` / `warning` / `error`).                               |
| `require_provenance`  | enum    | `error`      | Severity for `missing_provenance` (`off` / `warning` / `error`).                                   |

The node runs with these defaults out of the box. Misconfiguration (an invalid
severity or a malformed map) logs a warning and falls back to the default rather than
failing the run. A fact that already carries a `validation` key is re-validated and
that key is overwritten — this node is its sole owner.

## Pipeline position

```text
datalab_parse → extract_facts → normalize_facts → currency_convert_explicit → schema_validate → authoritative_overlay → reconcile
```

Several of these sibling nodes (`datalab_parse`, `extract_facts`, `authoritative_overlay`,
`reconcile`, `currency_convert_explicit`) are part of the in-progress audit-grade financial
extraction suite (epic #1432) and are not all on `develop` yet; `schema_validate` stands alone and
runs on any upstream that emits fact objects on the `answers` lane.

This node is marked **experimental**.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `schema_validate.amount_field` | `string` | **Amount field**<br/>The fact field holding the numeric amount (presence and sign checks). | `"amount"` |
| `schema_validate.category_field` | `string` | **Category field**<br/>The fact field holding the declared classification (e.g. revenue, expense) — checked against the metric. | `"category"` |
| `schema_validate.category_metric_map` | `object` | **Category → metric keywords**<br/>Map of canonical category to metric keyword substrings that imply it. Drives the cost-as-revenue check. Leave empty to skip the metric/category mismatch check. |  |
| `schema_validate.currency_field` | `string` | **Currency field**<br/>The fact field holding the currency code (presence check only). | `"currency"` |
| `schema_validate.metric_field` | `string` | **Metric field**<br/>The fact field naming the line item (e.g. 'Cost of goods sold') — the classifier input for the mismatch check. | `"metric"` |
| `schema_validate.profile` | `string` | **Validation**<br/>Schema validation configuration | `"default"` |
| `schema_validate.require_provenance` | `string` | **Require provenance**<br/>Severity for a fact that arrives with no usable provenance list (absent, empty, or not a list). Set to 'off' to disable the flag; a provenance entry is still appended. | `"error"` |
| `schema_validate.sign` | `string` | **Sign check severity**<br/>Severity for a sign-convention violation (e.g. an expense with a positive amount). Set to 'off' to disable the check. | `"warning"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/schema_validate)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
