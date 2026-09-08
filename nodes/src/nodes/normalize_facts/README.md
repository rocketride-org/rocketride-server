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
<!-- Run `./builder nodes:docs-generate` to populate the schema table from services.json. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
