# anonymize

A RocketRide filter node that detects and redacts sensitive entities in text flowing through a pipeline.

## What it does

Scans text for sensitive entities — names, emails, phone numbers, organizations, and more — using a locally-run GLiNER zero-shot NER model, then replaces each detected span. You control **which** entity types are detected (the `entityTypes` field) and **how** matches are replaced (the `redactionStyle` field):

- **`mask`** (default) overwrites every character of the span with a configurable masking character (default `█`, U+2588), preserving text length and structure.
- **`token`** replaces each span with a labelled placeholder tag such as `[PERSON]` or `[EMAIL]`.

Example (mask):

```
Input:  John Smith is a patient at St. Mary's Hospital.
Output: ████ █████ is a patient at ██ █████████████████.
```

Example (token):

```
Input:  John Smith is a patient at St. Mary's Hospital.
Output: [PERSON] is a patient at [ORGANIZATION].
```

Overlapping spans are merged before replacement (mask style also merges directly-adjacent spans, since the masked output is identical either way; token style keeps adjacent spans separate so each entity keeps its own tag).

Models are loaded via `ai.common.models.GLiNER`, which runs inference locally and automatically routes to a model server when the engine is started with the `--modelserver` flag. Models are downloaded from Hugging Face on first use; no API key is required. The node declares the `gpu` capability, so GPU acceleration is used when available.

Large documents are split into 1024-character chunks with a 128-character overlap so entities at chunk boundaries are not missed. Chunks are processed in parallel using up to 4 threads, entity labels are batched in groups of 32, and entities found in the overlap regions are de-duplicated before the final replacement pass.

Note: AI-based detection cannot guarantee 100% accuracy. Review results before using in production.

---

## Configuration

### Lanes

| Lane   | Direction | Behaviour |
|--------|-----------|-----------|
| `text` | in -> out | Incoming text chunks are buffered for the whole object (downstream delivery is suspended via `preventDefault`). At object close, the buffered text is anonymized once and forwarded downstream as a single write. |

When an upstream classifier node is present, the node also receives classifications and adjusts its behaviour (see "Entity labels" below).

### Fields

The node is configured by choosing a model profile. Each profile exposes the entity-type, redaction-style, and masking-character fields; the `custom` profile additionally exposes a free-form model name field.

| Field | Type | Description |
|---|---|---|
| `entityTypes` | array | Entity types to detect. Pre-filled with 15 common PII types; remove any you don't want or add your own (the model is zero-shot, so any label works). An empty value falls back to the defaults. |
| `redactionStyle` | string | How matches are replaced: `mask` (default) overwrites with the masking character; `token` replaces with a labelled tag like `[PERSON]`. |
| `anonymizeChar` | string | Character used for masking (mask style only) |
| `model` | string | Gliner model to use for anonymization |
| `profile` | string | Default "glinerMergedLarge". Anonymize model |

---

## Model profiles

| Profile key | Model | Best for |
|-------------|-------|----------|
| `glinerSmall` | `urchade/gliner_small-v2.1` | General English PII, fastest |
| `glinerMedium` | `urchade/gliner_medium-v2.1` | General English PII, balanced |
| `glinerLarge` | `urchade/gliner_large-v2.1` | General English PII, highest accuracy |
| `glinerPIILarge` | `knowledgator/gliner-pii-large-v1.0` | High-accuracy English PII |
| `glinerMergedLarge` (default) | `xomad/gliner-model-merge-large-v1.0` | Combined from multiple datasets, broad coverage |
| `glinerMulti` | `urchade/gliner_multi` | Multilingual text |
| `glinerMultiPII` | `urchade/gliner_multi_pii-v1` | Multilingual PII |
| `gretelSmall` | `gretelai/gretel-gliner-bi-small-v1.0` | Business-oriented NER, compact |
| `gretelLarge` | `gretelai/gretel-gliner-bi-large-v1.0` | Business-oriented NER, large scale |
| `glinerKo` | `taeminlee/gliner_ko` | Korean |
| `glinerIt` | `DeepMount00/GLiNER_PII_ITA` | Italian |
| `glinerAr` | `NAMAA-Space/gliner_arabic-v2.1` | Arabic |
| `glinerCommunitySmall` | `gliner-community/gliner_small-v2.5` | Community general, compact |
| `glinerCommunityMedium` | `gliner-community/gliner_medium-v2.5` | Community general, balanced |
| `glinerCommunityLarge` | `gliner-community/gliner_large-v2.5` | Community general, largest |
| `glinerBiomedSmall` | `Ihor/gliner-biomed-small-v1.0` | Biomedical and clinical text, compact |
| `glinerBiomedLarge` | `Ihor/gliner-biomed-large-v1.0` | Biomedical and clinical text, high accuracy |
| `custom` | user-supplied | Any Hugging Face GLiNER model name |

The default profile when adding the node is `glinerSmall` (as set in `preconfig.default`); the `anonymize.profile` field UI default is `glinerMergedLarge`.

---

## Entity labels

What gets detected and redacted depends on whether an upstream classifier node feeds this node.

### Standalone (no upstream classifier)

The node runs GLiNER with the labels from the `entityTypes` field. This is pre-filled with a default set of 15 common PII labels, which you can edit freely (the model is zero-shot, so any label works):

`person`, `name`, `email`, `phone number`, `address`, `social security number`, `credit card number`, `date of birth`, `organization`, `company`, `location`, `ip address`, `bank account`, `passport number`, `driver license`

### With an upstream classifier

When classification data arrives before the object closes, the node:

1. Redacts the exact character spans (`offset`, `length`) reported in the classification `textMatches`. In `token` style these carry no entity type, so they are tagged `[REDACTED]` unless a more specific NER detection covers the same span.
2. Resolves classification rule `idRef` values to English names via the Nucleuz rule pack (`nucleuz/rulePack.dat` under the engine path).
3. Extracts keyword `<Term>` entries from the classification rules as additional GLiNER labels.
4. Runs GLiNER with the combined label set and merges the results with the spans from step 1.

If `nucleuz/rulePack.dat` is not present, rule-name resolution silently produces no results and the node falls back to GLiNER-only mode using the labels extracted from the classification rules.

---

## Running the tests

The node ships automated test cases in `services.json`. The standard test runs against the `glinerSmall` profile; the full test exercises every model profile. Server-free unit tests for the pure redaction logic live in `nodes/test/test_anonymize_logic.py`.

```bash
# Standard test (glinerSmall profile)
builder nodes:test

# Full test across all model profiles
builder nodes:test-full
```

---

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
