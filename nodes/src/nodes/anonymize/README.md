# anonymize

A RocketRide text filter that detects configured entity types and replaces their
spans before text continues downstream. Pick it to redact PII-like content
while preserving the rest of the document, rather than dropping the document
or relying on a fixed pattern matcher alone.

## About GLiNER

GLiNER is the named-entity recognizer used by this node through RocketRide's
GLiNER model adapter. The recognizer receives a list of labels, returns entity
spans, and is used here to replace those spans in pipeline text. This node can
also combine those detections with spans and labels supplied by an upstream
classification stage.

## What it does

The node accumulates text for an input object, detects entities when that
object closes, and writes the redacted text to the `text` lane. Without
classification input it detects the configured entity types; with
classification input it also uses its reported character spans and associated
rule labels. Choose it over an exact-match redaction step when the data needs
entity detection over configurable labels or integration with classifier
results.

In mask mode each detected span is replaced with the configured character for
the original span length. Token mode replaces it with a label such as
`[EMAIL]`; a classifier-only match becomes `[REDACTED]` unless an overlapping
GLiNER match supplies a more specific label.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `text` | Collect text for an object, redact detected spans at closing, and emit it. |

## Profiles

| Profile | Model |
| --- | --- |
| `glinerMultiPII` | `urchade/gliner_multi_pii-v1` |
| `glinerPIILarge` | `knowledgator/gliner-pii-large-v1.0` |
| `glinerMergedLarge` | `xomad/gliner-model-merge-large-v1.0` |
| `glinerSmall` *(default)* | `urchade/gliner_small-v2.1` |
| `glinerMedium` | `urchade/gliner_medium-v2.1` |
| `glinerLarge` | `urchade/gliner_large-v2.1` |
| `glinerMulti` | `urchade/gliner_multi` |
| `gretelSmall` | `gretelai/gretel-gliner-bi-small-v1.0` |
| `gretelLarge` | `gretelai/gretel-gliner-bi-large-v1.0` |
| `glinerKo` | `taeminlee/gliner_ko` |
| `glinerIt` | `DeepMount00/GLiNER_PII_ITA` |
| `glinerAr` | `NAMAA-Space/gliner_arabic-v2.1` |
| `glinerCommunitySmall` | `gliner-community/gliner_small-v2.5` |
| `glinerCommunityMedium` | `gliner-community/gliner_medium-v2.5` |
| `glinerCommunityLarge` | `gliner-community/gliner_large-v2.5` |
| `glinerBiomedSmall` | `Ihor/gliner-biomed-small-v1.0` |
| `glinerBiomedLarge` | `Ihor/gliner-biomed-large-v1.0` |

## Configuration

Choose a profile when one of the supplied model choices suits the text you
process, or choose `custom` and supply a model name. Most pipelines then only
need to tailor the entity labels and decide whether retaining entity labels in
the output is useful. The profile selected when adding the node is
`glinerSmall`; the configuration field itself defaults to `glinerMergedLarge`.

### Model

Profiles supply a model name, while the `custom` profile exposes **Model name**
for a name at least two characters long. Change models when the supplied
profile's intended language, domain, or resource trade-off is a closer match
for the data. The recognizer loads the configured model through the RocketRide
GLiNER adapter, which uses a model server when one is configured and otherwise
runs locally.

### Entity types to anonymize

**Entity types to anonymize** is a list of zero-shot labels. Its default has
15 common PII-style labels, including `person`, `email`, `phone number`, and
`credit card number`. Replace or extend this list for the kinds of entities
your pipeline must hide. Blank and non-string list items are ignored; a
non-list or an empty resulting list falls back to the default labels, so an
attempt to clear the list does not silently disable detection.

### Redaction style and character

Use `mask` (the default) when it is important to preserve the original text
length: each matched character is overwritten by **Character to use for
anonymization**, which defaults to `█`. Use `token` when downstream processing
needs to know what was removed; it substitutes label tokens instead and does
not use the masking character. Adjacent mask spans merge into one replacement;
token spans remain separate unless they actually overlap.

## Requirements

The node declares GPU capability and installs GLiNER plus an ONNX Runtime.
Outside macOS its requirements select `onnxruntime-gpu`; on macOS they select
the non-GPU `onnxruntime` package. Model loading is therefore a runtime cost to
plan for, especially before selecting a larger profile.

## Notes

### Long text and prediction failures

Text is processed in 1,024-character chunks with 128-character overlap, label
lists are sent in batches of 32, and up to four chunks run concurrently.
Duplicate entities from overlapping chunks are removed. A model error for one
label batch or chunk is logged and processing continues, so review redaction
results when complete coverage is required.

### Classifier input

When classification data arrives, the node uses three independent inputs.
`classificationPolicy` `idRef` values become GLiNER labels only when the local
Nucleuz `rulePack.dat` maps them; if the rule pack is unavailable, those labels
are omitted. `<Term>` values from `classificationRules` remain GLiNER labels
without the rule pack. Classifier-reported `textMatches` are redacted directly,
independent of both label sources. If neither source produces labels, GLiNER
adds no classification-derived detections, but the reported text matches are
still redacted.

## Upstream docs

- [GLiNER documentation](https://github.com/urchade/GLiNER)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `anonymize.model` | `string` | **Model name**<br/>Gliner model to use for anonymization |  |
| `anonymize.profile` | `string` | **Model**<br/>Anonymize model | `"glinerMergedLarge"` |
| `anonymizeChar` | `string` | **Character to use for anonymization**<br/>Character |  |

## Dependencies

- `gliner`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/anonymize)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
