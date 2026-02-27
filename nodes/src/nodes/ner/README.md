# Named Entity Recognition (NER) Node

## Overview

The NER node extracts named entities (people, organizations, locations, etc.) from text using state-of-the-art transformer models via the RocketRide model server. It enriches documents with entity metadata for enhanced search and analysis capabilities.

## Features

- **GPU Accelerated**: Uses model server for efficient batch processing
- **Multiple Models**: Supports various pre-trained NER models
- **Multilingual**: Includes models for 100+ languages
- **Specialized Domains**: Biomedical, scientific, and general-purpose models
- **Confidence Filtering**: Configurable threshold for entity detection
- **Metadata Enrichment**: Automatically adds entities to document metadata (documents lane only)
- **Pass-through Processing**: Original text/documents preserved

## Pipeline Integration

### Text lane processing

```text
Source -> NER -> Output
```

The node processes text from the `text` lane and passes it through unchanged while extracting entities. **Entities are only added to metadata when using the documents lane;** for the text lane, entities are extracted internally but are not attached to the output.

### Document lane processing

```text
Parser -> NER -> Embedder -> Vector Store
```

The node processes documents from the `documents` lane and enriches them with entity metadata.

### Output

#### Document metadata

When `store_in_metadata` is enabled, entities are added to document metadata:

```python
{
  "entities_per": ["John Smith", "Marie Curie"],
  "entities_org": ["Apple Inc.", "NASA"],
  "entities_loc": ["New York", "Paris"],
  "entities_count": 5
}
```

Metadata fields:

- `entities_<type>`: List of unique entities for each type (sorted)
- `entities_count`: Total number of entities detected

#### Entity structure

Each entity contains:

```python
{
  "entity_group": "PER",        # Entity type
  "word": "John Smith",         # Entity text
  "score": 0.95,                # Confidence score
  "start": 10,                  # Start position in text
  "end": 21                     # End position in text
}
```

## Supported Models

### Supported entity types

Common entity types extracted by NER models:

- **PER/PERSON**: People names (e.g., "John Smith", "Marie Curie")
- **ORG**: Organizations (e.g., "Apple Inc.", "United Nations")
- **LOC/LOCATION**: Locations (e.g., "New York", "Mount Everest")
- **DATE**: Dates and temporal expressions
- **MISC**: Miscellaneous entities (products, events, etc.)

Specialized models may support additional types (e.g., biomedical entities).

### General purpose

1. **BERT Large (English)** -- Default, high accuracy
   - Model: `dbmdz/bert-large-cased-finetuned-conll03-english`
   - Best for: English text, high accuracy requirements
   - Entities: PER, ORG, LOC, MISC

2. **BERT Base (English)** -- Balanced performance
   - Model: `dslim/bert-base-NER`
   - Best for: General English NER, faster inference

3. **DistilBERT** -- Fast and lightweight
   - Model: `Davlan/distilbert-base-multilingual-cased-ner-hrl`
   - Best for: Real-time processing, resource-constrained environments

4. **DeBERTa** (profile: `deberta`) -- Alternative English NER
   - Model: `dslim/distilbert-NER` (DistilBERT-based)
   - Best for: General English when using this profile

### Multilingual

1. **XLM-RoBERTa** -- 100+ languages
   - Model: `Davlan/xlm-roberta-base-ner-hrl`
   - Best for: Multilingual documents, non-English text

### Specialized

1. **Biomedical** -- Medical/scientific entities
   - Model: `dmis-lab/biobert-base-cased-v1.1`
   - Best for: Medical records, scientific papers
   - Lower confidence threshold (0.85) for specialized terms

### Model selection

| Model                        | Speed  | Accuracy    | Memory | Use Case            |
| ---------------------------- | ------ | ----------- | ------ | ------------------- |
| DistilBERT                   | Fast   | Good        | Low    | Real-time processing|
| BERT Base                    | Medium | Very Good   | Medium | General purpose     |
| BERT Large                   | Slow   | Excellent   | High   | High accuracy needs |
| XLM-RoBERTa                  | Medium | Very Good   | Medium | Multilingual        |
| DeBERTa (distilbert-NER)     | Fast   | Good        | Low    | Alternative English |
| BioBERT                      | Medium | Specialized | Medium | Medical/scientific  |

### Language-specific models

For non-English text, use appropriate models:

- **German**: `dslim/bert-base-NER-uncased`
- **French**: `Jean-Baptiste/camembert-ner`
- **Spanish**: `mrm8488/bert-spanish-cased-finetuned-ner`
- **Chinese**: `ckiplab/bert-base-chinese-ner`
- **Multilingual**: `Davlan/xlm-roberta-base-ner-hrl`

---

## Configuration

### Basic usage

Add the NER node to your pipeline:

```json
{
  "provider": "ner",
  "config": {
    "profile": "bertLarge"
  }
}
```

### Custom configuration

```json
{
  "provider": "ner",
  "config": {
    "profile": "custom",
    "model": "your-model-name",
    "aggregation_strategy": "simple",
    "min_confidence": 0.9,
    "store_in_metadata": true
  }
}
```

### Configuration parameters

- **profile**: Pre-configured model key (e.g. `bertLarge`, `bertBase`, `distilbert`, `xlmRoberta`, `deberta`, `biomedical`, `custom`). The UI shows a display title; pipeline config uses these keys.
- **model**: HuggingFace model name (custom profile only)
- **aggregation_strategy**: How to combine word pieces
  - `simple`: Default, combines word pieces into entities
  - `first`: Use first word piece score
  - `average`: Average word piece scores
  - `max`: Use maximum word piece score
  - `none`: No aggregation
- **min_confidence**: Minimum confidence threshold (0.0-1.0)
  - Default: 0.9 (90% confidence)
  - Lower for more entities (more false positives)
  - Higher for fewer entities (more precision)
- **store_in_metadata**: Add entities to document metadata (default: true)

### Custom model integration

Use any HuggingFace NER model:

1. Find a model on [HuggingFace Hub](https://huggingface.co/models?pipeline_tag=token-classification)
2. Set profile to "custom"
3. Configure model name
4. Adjust aggregation strategy and confidence as needed

Example:

```json
{
  "profile": "custom",
  "model": "your-username/your-ner-model",
  "aggregation_strategy": "simple",
  "min_confidence": 0.85
}
```

### Confidence threshold tuning

- **0.95+**: Very high precision, may miss some entities
- **0.90**: Default, good balance (recommended)
- **0.85**: More entities, some false positives
- **0.80**: High recall, more false positives
- **<0.80**: Not recommended for production

---

## Usage

### Example use cases

#### 1. Document classification by people/organizations

Extract key entities to understand document context:

```text
PDF -> Parser -> NER -> Classifier
```

#### 2. Privacy redaction pipeline

Identify PII for anonymization:

```text
Documents -> NER -> Anonymizer -> Output
```

#### 3. Search enhancement

Enrich documents with entity metadata for better search:

```text
Documents -> NER -> Embedder -> Vector DB
```

Then search by entity:

```text
metadata.entities_org contains "Apple Inc."
```

#### 4. Knowledge graph construction

Extract entities and relationships:

```text
Documents -> NER -> Entity Linker -> Graph DB
```

---

## Error Handling

### No entities detected

- **Check confidence threshold**: Lower `min_confidence` to 0.85 or 0.80
- **Verify text quality**: NER works best with clean, well-formatted text
- **Try different models**: Some models work better for specific domains

### Too many false positives

- **Increase confidence threshold**: Set `min_confidence` to 0.95
- **Use larger models**: BERT Large has better precision than Base/DistilBERT
- **Check text preprocessing**: Ensure text is properly cleaned

### Performance issues

- **Use DistilBERT**: 2-3x faster than BERT Base
- **Enable model server**: Ensures GPU acceleration
- **Batch processing**: node automatically batches for efficiency

### Model not loading

- **Check model name**: Verify it exists on HuggingFace
- **Check model server**: Ensure it's running and accessible
- **Check disk space**: Models are cached locally

---

## Testing

The node defines automated tests in `services.json` (e.g. profile `distilbert` and sample text). See the project's node testing documentation for how to run them.

## Dependencies

The node uses the model server's transformers support, so no additional dependencies are required beyond the base RocketRide installation.

### Model server integration

The node uses `NERRecognizer`, which initializes a HuggingFace NER pipeline from `ai.common.models.transformers`. That pipeline uses the RocketRide model server when available and falls back to local execution otherwise:

```python
# NERRecognizer uses this pipeline internally
from ai.common.models.transformers import pipeline

ner_pipeline = pipeline(
    task='ner',
    model=model_name,
    aggregation_strategy=aggregation_strategy
)
# Uses model server if started with --models; otherwise runs locally
```

No pipeline changes are needed -- routing is handled automatically.

### GPU acceleration

The node automatically uses the model server's GPU acceleration when available. For best performance:

- Ensure model server is running with `--models` flag
- Use batch processing (node handles this automatically)
- Models are loaded once and shared across all documents
