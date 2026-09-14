# ner

A RocketRide text-processing node that identifies named entities with a configured Hugging Face model. Choose it when documents need entity metadata for downstream filtering or analysis, rather than LLM-generated structured records.

## About Hugging Face

Hugging Face provides tools and models for machine-learning workflows. This node uses its model identifiers with RocketRide's Transformers pipeline to perform named-entity recognition.

## What it does

The node runs named-entity recognition on incoming text and documents, filtering the model's results by the configured confidence threshold. Text continues unchanged on the `text` lane. Documents are copied and, by default, enriched with entity lists and a total count in their metadata. Use it instead of `dictionary` when you need model-recognized entity spans and categories, not LLM-authored definitions of internal terminology.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `text` | Runs recognition and passes the original text through unchanged. |
| `documents` | `documents` | Runs recognition on each document and writes an enriched copy downstream. |

## Profiles

Default: **BERT Large (English) - High accuracy for English text** (`bertLarge`).

| Profile | Model | Context |
| --- | --- | --- |
| `bertLarge` **(default)** | `dbmdz/bert-large-cased-finetuned-conll03-english` | English profile; `min_confidence` defaults to `0.9`. |
| `bertBase` | `dslim/bert-base-NER` | English profile; `min_confidence` defaults to `0.9`. |
| `distilbert` | `Davlan/distilbert-base-multilingual-cased-ner-hrl` | Multilingual profile; `min_confidence` defaults to `0.9`. |
| `xlmRoberta` | `Davlan/xlm-roberta-base-ner-hrl` | Multilingual profile; `min_confidence` defaults to `0.9`. |
| `deberta` | `dslim/distilbert-NER` | English profile; `min_confidence` defaults to `0.9`. |
| `biomedical` | `dmis-lab/biobert-base-cased-v1.1` | Biomedical profile; `min_confidence` defaults to `0.85`. |
| `custom` | _(your own token-classification model)_ | `min_confidence` defaults to `0.9`. |

## Configuration

Start with the profile that matches the language or domain of the input, then adjust confidence and output handling only when the default behavior does not fit the pipeline. Select `custom` when a compatible model identifier is required; the other profiles preconfigure their model value.

### Model

The profile selector defaults to `bertLarge`. Its preset supplies the model identifier, aggregation strategy, and confidence threshold. Use a named profile when it matches the input domain, or select `custom` to enter a model name yourself; the recognizer otherwise falls back to `dbmdz/bert-large-cased-finetuned-conll03-english` when no model value reaches it. A custom model must work with the NER pipeline and the selected aggregation strategy.

### Entity aggregation strategy

This controls how the underlying pipeline combines word pieces into entities. The default is `simple`; the available strategies are `none`, `simple`, `first`, `average`, and `max`. Change it when your model's subword output produces entity boundaries or scores that are not useful to downstream consumers. Because confidence filtering happens after recognition, a different aggregation strategy can also change which combined entities meet the threshold.

### Minimum confidence threshold

The threshold is a number from `0.0` to `1.0` and defaults to `0.9` for most presets (`0.85` for `biomedical`). Raise it when metadata should contain only more confident entities; lower it when the model is missing useful candidates and the pipeline can tolerate more noise. The recognizer discards results below this value before it formats the entity dictionaries or stores them in document metadata.

### Store entities in document metadata

This is on by default and affects the `documents` lane. When enabled, the node copies each document and stores deduplicated, sorted entity words under `entities_<type>` keys plus `entities_count`. Turn it off when the lane should preserve document metadata unchanged; recognition still runs, but the extracted entity list is not written to that document's metadata.

## Requirements

This node declares GPU capability. It initializes its recognizer once at pipeline start and uses RocketRide's Transformers pipeline, which uses the model server when it is available and otherwise falls back to local execution. The model is not loaded while the node is opened in configuration mode.

## Notes

### Result handling

Each recognized item is formatted with `entity_group`, `word`, `score`, `start`, and `end`. Empty or whitespace-only text yields no entities. If recognition raises an exception, the node reports the error and returns an empty list, while text and documents continue through their normal lane handling.

### Text and document behavior

On the `text` lane, the node collects recognized entities in instance state but writes only the original text downstream. On the `documents` lane, it processes each document's `page_content` separately and uses `model_copy()` before changing metadata, so the original document object is not mutated.

## Upstream docs

- [Hugging Face Transformers documentation](https://huggingface.co/docs/transformers/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `ner.aggregation_strategy` | `string` | **Entity aggregation strategy**<br/>How to combine word pieces into entities | `"simple"` |
| `ner.min_confidence` | `number` | **Minimum confidence threshold**<br/>Minimum confidence score (0.0-1.0) for entity detection | `0.9` |
| `ner.model` | `string` | **Model name**<br/>HuggingFace model to use for NER |  |
| `ner.profile` | `string` | **Model**<br/>NER model configuration | `"bertLarge"` |
| `ner.store_in_metadata` | `boolean` | **Store entities in document metadata**<br/>Add extracted entities to document metadata fields | `true` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/ner)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
