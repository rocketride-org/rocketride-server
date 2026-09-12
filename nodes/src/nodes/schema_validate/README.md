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

### Fact-record convention

A "fact" is a JSON object. The relevant fields are configurable:

- `amount_field` (default `amount`) — the numeric amount;
- `currency_field` (default `currency`) — the currency code;
- `metric_field` (default `metric`) — the line-item label (e.g. `"Cost of goods sold"`);
- `category_field` (default `category`) — the declared classification (e.g. `"revenue"`).

An answer payload may be a single fact object or a list of fact objects; other shapes
pass through untouched.

### Checks

| Flag code | Severity | Fires when |
|---|---|---|
| `missing_amount` | warning | `amount_field` is absent or `null`. |
| `non_numeric_amount` | warning | `amount_field` is present but not a finite number (bools and comma/currency-formatted strings are rejected). |
| `missing_currency` | warning | `currency_field` is absent, `null`, or blank. |
| `category_metric_mismatch` | **error** | The metric label implies one category but the fact declares another — the headline "cost row stored as revenue" guard. |
| `ambiguous_metric` | warning | The metric label matches keywords from two or more categories, so the declared category can't be corroborated (suppresses the mismatch check). |
| `sign_category_mismatch` | configurable (`sign`, default warning) | The amount's sign contradicts its class (an expense/liability with a positive amount, or revenue/asset with a negative amount). Zero never fires. Applies only to the four built-in signed classes (revenue/expense/asset/liability); a custom category has no sign convention and is not sign-checked. |
| `unknown_category` | warning | `category_field` is present but is not a recognized classification. |
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
categories are recognized from the built-in aliases **plus** the keys of `category_metric_map`, so a
custom category (e.g. `equity`) added to the map is accepted rather than flagged `unknown_category`.

### Example

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

### Provenance handling

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

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `answers` | `answers` | Annotates fact dictionaries and re-emits every record. Non-fact payloads retain their content; JSON-lane scalar values are re-emitted as text (`expectJson=False`). |

## Configuration

The default profile expects conventional financial field names and applies all
checks. Change the field names only when upstream facts use a different schema;
otherwise the defaults keep the validator and its provenance records consistent.

### Fact field names

`amount_field`, `currency_field`, `metric_field`, and `category_field` select
the keys read from each fact. The defaults are `amount`, `currency`, `metric`,
and `category`. Change all relevant names to match an upstream extraction
schema; changing only one can turn valid facts into missing-field warnings.
Blank or whitespace-only configured names fall back to their defaults.

### Category → metric keywords

`category_metric_map` maps a canonical category to a list of metric-label
substrings. Its default map recognizes revenue, expense, asset, and liability.
Extend it for corpus-specific labels, or use an empty object to skip the
metric/category mismatch check. A keyword that appears in more than one
category makes the metric ambiguous and suppresses that mismatch check, so use
distinct, deliberate keywords. A malformed map logs a warning and retains the
built-in default.

### Sign and provenance severity

`sign` and `require_provenance` accept `off`, `warning`, or `error`; their
defaults are `warning` and `error`. Set either to `off` when that check is not
meaningful for an input source, use `warning` for review queues, and use
`error` when the check must make the record invalid. Missing or `null` values
retain their defaults without a warning; any other invalid non-null value logs
a warning and falls back to the default. A pre-existing `validation` field is
replaced when the fact is re-validated.

## Notes

### Pipeline position

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
<!-- Run `./builder nodes:docs-generate` to populate the schema table from services.json. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
