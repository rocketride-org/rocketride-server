# anomaly_detector

A RocketRide filter node that monitors numeric values flowing through a pipeline and flags statistical anomalies by severity.

## What it does

Watches numeric values passing through a pipeline and classifies each one as `normal`, `warning`, or `critical` using one of three statistical methods: Z-Score, IQR (interquartile range), or Rolling Average percentage deviation. Use it to catch outliers, unexpected spikes, or shifts in data distribution that may need attention.

Implemented entirely with the Python standard library (`math`, `threading`, `collections`); no external dependencies are required.

One detector is created per pipeline execution and shared across all instances. It maintains a thread-safe sliding window of the most recent `windowSize` values. Each incoming value is scored against the current window contents and then appended to the window. Window state is discarded when the pipeline ends.

Non-finite inputs (NaN, positive/negative infinity) are treated as `normal` and skipped. Until the window holds enough data (2 values for Z-Score and Rolling Average, 4 for IQR), every value is reported as `normal` with `details: "insufficient data"`, so expect a brief warm-up period at the start of every run.

This node is marked **experimental**.

---

## Configuration

### Lanes

| Lane        | In → Out                  | Behaviour                                                                                                                      |
|-------------|---------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `text`      | `text` → `text`           | Parses a numeric value from the incoming text, scores it, and annotates anomalous text. Non-numeric text passes through unchanged. |
| `documents` | `documents` → `documents` | Reads the configured `metric` field from each document's metadata, scores it, and writes the detection result back into the metadata. |

### Text lane

The node first tries to parse the entire (stripped) text as a float. If that fails, it extracts the first numeric token via regex (integers, decimals, scientific notation, optional leading minus). If no number can be found, the text is forwarded unchanged and a debug message is logged.

When a value is anomalous (`warning` or `critical`), a tag is appended to the original text:

```
42.7 [ANOMALY: critical score=3.4119]
```

Normal values pass through unchanged.

### Documents lane

Each document is deep-copied before enrichment; documents whose `metadata` is `None` pass through untouched. Four fields are added to the metadata of each processed document:

| Metadata field         | Content                                                                                |
|------------------------|----------------------------------------------------------------------------------------|
| `anomaly_score`        | Numeric anomaly score, rounded to 4 decimal places.                                   |
| `anomaly_severity`     | `normal`, `warning`, or `critical`.                                                    |
| `anomaly_is_anomalous` | Boolean, `true` when severity is `warning` or `critical`.                              |
| `anomaly_details`      | Human-readable diagnostics: method internals, or an explanation of why detection was skipped. |

If the `metric` field is absent from a document's metadata or contains a non-numeric value, the document is marked `normal` with an explanatory `details` string and is never dropped.

### Fields

The node is configured through a single profile selector plus per-method fields. The selected profile determines the detection method and supplies the defaults shown in the Profiles table below.

| Field | Type | Description |
|---|---|---|
| `method` | string | Default "z_score". Statistical method used for anomaly detection |
| `sensitivity` | number | Default 2.0. Detection sensitivity threshold (lower = more sensitive) |
| `windowSize` | integer | Default 100. Number of recent values to consider for statistical calculations |
| `metric` | string | Default "value". The metadata field name containing the numeric value to monitor |
| `warningThreshold` | number | Default 2.0. Threshold multiplier for warning-level anomalies |
| `criticalThreshold` | number | Default 3.0. Threshold multiplier for critical-level anomalies |
| `profile` | string | Default "z_score". Anomaly detection configuration |

### Profiles

The `profile` field (UI: "Detection Method") selects a preset that pre-fills `method` and the threshold defaults. The default profile is `z_score`.

| Profile       | Method          | `sensitivity` | `windowSize` | `warningThreshold` | `criticalThreshold` |
|---------------|-----------------|---------------|--------------|--------------------|---------------------|
| `z_score`     | Z-Score         | 2.0           | 100          | 2.0                | 3.0                 |
| `iqr`         | IQR             | 1.5           | 100          | 1.5                | 3.0                 |
| `rolling_avg` | Rolling Average | 2.0           | 50           | 2.0                | 3.0                 |

---

## Detection methods

All three methods produce a numeric score that is classified by the same rule: `score >= criticalThreshold` is `critical`, else `score >= warningThreshold` is `warning`, else `normal`.

### Z-Score

Measures how many standard deviations the value is from the window mean: `score = |value - mean| / std`. Requires at least 2 values in the window. A window with zero variance (all identical values) yields `normal` with `details: "zero variance"`. The `sensitivity` field has no effect on this method.

### IQR

Computes Q1 and Q3 by linear interpolation over the sorted window and defines outlier bounds at `Q1 - sensitivity * IQR` and `Q3 + sensitivity * IQR`. The score is the distance from the nearer bound expressed in IQR units; any value outside the bounds (score > 0) is flagged as anomalous regardless of `warningThreshold`. Requires at least 4 values. A zero-IQR window yields `normal` with `details: "zero IQR"`.

### Rolling Average

Computes a moving average over the most recent half of the window (minimum 2 values) and measures the value's percentage deviation from that local mean. No standard-deviation normalization is applied, making it intuitive for business metrics where "a 10% deviation" has a clear meaning.

The score is `pct_deviation / (sensitivity * 10)`, so the effective trigger points are `sensitivity * 10 * threshold` percent deviation. With default values (sensitivity 2.0, warningThreshold 2.0, criticalThreshold 3.0), warning fires at 40% deviation and critical at 60%. A zero local mean yields `normal` with `details: "zero mean"`.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `anomaly_detector.criticalThreshold` | `number` | **Critical threshold**<br/>Threshold multiplier for critical-level anomalies | `3` |
| `anomaly_detector.method` | `string` | **Detection method**<br/>Statistical method used for anomaly detection | `"z_score"` |
| `anomaly_detector.metric` | `string` | **Metric field**<br/>The metadata field name containing the numeric value to monitor | `"value"` |
| `anomaly_detector.profile` | `string` | **Detection Method**<br/>Anomaly detection configuration | `"z_score"` |
| `anomaly_detector.sensitivity` | `number` | **Sensitivity**<br/>Detection sensitivity threshold (lower = more sensitive) | `2` |
| `anomaly_detector.warningThreshold` | `number` | **Warning threshold**<br/>Threshold multiplier for warning-level anomalies | `2` |
| `anomaly_detector.windowSize` | `integer` | **Window size**<br/>Number of recent values to consider for statistical calculations | `100` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/anomaly_detector)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
