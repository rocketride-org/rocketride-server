# normalize_facts

A RocketRide filter node that deterministically cleans up extracted financial
facts — the normalization step of the audit-grade financial extraction node
suite. No LLM, no network: given the same input it always produces the same
output.

## What it does

Reads structured facts on the `answers` lane and, for every fact, adds a
`normalized` block that:

- **maps the label to a standard metric name** (e.g. `Net sales` / `Turnover` →
  `revenue`) — matching is exact on the cleaned label, so a line item that merely
  *contains* a synonym (`Deferred revenue`, `Non-operating income`) is **not**
  mapped and keeps its own label as a passthrough metric;
- **parses the number and its sign** — parentheses `(1,234)`, trailing minus `1,234-`,
  unicode minus/dashes, and thousands separators are all handled;
- **detects and tags the currency** from symbols (`$ € £ ¥ ₹`) or ISO codes in the
  value or label — currency is **tagged, never converted** (conversion is the separate
  `currency_convert_explicit` node);
- **detects and tags the scale** (`in millions`, `£500m`, `1.2bn`) as a `scale_factor`
  — the scale is recorded but the value is **never multiplied**, so the as-stated
  number stays auditable and the scale can never be applied twice.

Across the batch the node also **de-duplicates** facts that are identical. The
identity key is the **cleaned raw label** plus metric, normalized value, currency,
scale and sign — so two different line items that happen to share a number
(`Revenue 1,234` and `Deferred revenue 1,234`) are always both kept. Facts that
share a label and metric but differ in value, currency or scale are conflicts, not
duplicates, and are all kept — a genuine fact is never dropped. Because dedupe works
on the whole batch, the facts are re-emitted together as a **single list answer** (a
lone bare fact object keeps its shape) — downstream consumers must accept a list
payload even when the facts arrived as separate answers.

The normalization is **non-destructive and audit-friendly**: the raw `label` and
`value` are left untouched, a `normalized` block is added, and a `provenance` entry
records how each field was derived. Records that are not fact objects — plain text,
bare numbers, and dicts carrying neither `label_field` nor `value_field` (page
markers, section headers) — pass through unchanged.

**Scope note:** percentage and ratio values (`12.5%`, `1.5x`) are out of scope for
this experimental version — `value_normalized` comes back `null` while the raw value
is preserved untouched. Handling them (tagging the unit the way scale is tagged) is
planned as a follow-up.

## Fact-record convention

A "fact" is a JSON object with a free-text label under `label_field` (default
`label`) and a raw value under `value_field` (default `value`). An answer payload may
be a single fact object or a list of fact objects; other shapes pass through
untouched.

Input:

```json
{ "label": "Revenue ($ in millions)", "value": "1,234.5" }
```

Output:

```json
{
  "label": "Revenue ($ in millions)",
  "value": "1,234.5",
  "normalized": {
    "metric": "revenue",
    "value_normalized": 1234.5,
    "currency": "USD",
    "scale_factor": 1000000,
    "scale_unit": "millions",
    "is_negative": false
  },
  "currency": "USD",
  "provenance": [
    {
      "op": "normalize_facts",
      "value_normalized": 1234.5,
      "currency": "USD",
      "currency_source": "label_symbol",
      "scale_factor": 1000000,
      "scale_unit": "millions",
      "scale_source": "label",
      "sign_source": "none",
      "metric_source": "mapped"
    }
  ]
}
```

`amount` and `currency` are mirrored to the top level (only when absent) so the
downstream `currency_convert_explicit` node works with its default field names.
The `amount` mirror is **withheld when `scale_factor != 1`** (as in the example
above): the converter multiplies `amount` as-is and does not read `scale_factor`,
so mirroring an as-stated in-millions figure would produce a converted number off
by the scale factor. Scaled facts must be explicitly de-scaled before conversion.
If the fact already carries a `provenance` list, the normalization entry is
appended so upstream provenance is preserved.

## Configuration

### Lanes

| Lane      | In → Out              | Behaviour                                                                                             |
|-----------|-----------------------|------------------------------------------------------------------------------------------------------|
| `answers` | `answers` → `answers` | Normalizes each fact object and de-duplicates the batch; non-fact records pass through unchanged. |

### Fields

| Field              | Type    | Default  | Description                                                                                       |
|--------------------|---------|----------|---------------------------------------------------------------------------------------------------|
| `label_field`      | string  | `label`  | The fact field holding the free-text metric label.                                                |
| `value_field`      | string  | `value`  | The fact field holding the raw numeric value to parse.                                             |
| `default_currency` | string  | `""`     | 3-letter ISO code to tag when none is detected (upper-cased; anything else is warned about and ignored). Empty leaves facts untagged. |
| `decimal_format`   | string  | `auto`   | `auto`/`us`: comma = thousands, dot = decimal. `eu`: dot = thousands, comma = decimal.            |
| `label_to_metric`  | object  | `{}`     | `{synonym: metric}` map merged over the built-in mapping (user entries win, case-insensitive).    |

The node never fails the run on misconfiguration: an invalid `label_to_metric`,
`decimal_format` or `default_currency` is warned about and ignored, and facts still
pass through normalized as far as possible.

## Pipeline position

```text
datalab_parse → extract_facts → normalize_facts → currency_convert_explicit → schema_validate → …
```

This node is marked **experimental**.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `normalize_facts.decimal_format` | `string` | **Decimal format**<br/>Number format. 'auto'/'us': comma = thousands separator, dot = decimal point. 'eu': dot = thousands separator, comma = decimal point. | `"auto"` |
| `normalize_facts.default_currency` | `string` | **Default currency**<br/>3-letter ISO code to tag when none is detected in the label or value (anything else is ignored with a warning). Leave empty to keep facts untagged. | `""` |
| `normalize_facts.label_field` | `string` | **Label field**<br/>The fact field holding the free-text metric label (mapped to a standard metric name). | `"label"` |
| `normalize_facts.label_to_metric` | `object` | **Label→metric overrides**<br/>JSON map of {synonym: metric} merged over the built-in mapping (user entries win). Case-insensitive. | `{}` |
| `normalize_facts.profile` | `string` | **Normalization**<br/>Deterministic fact normalization configuration | `"default"` |
| `normalize_facts.value_field` | `string` | **Value field**<br/>The fact field holding the raw numeric value to parse. | `"value"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/normalize_facts)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
