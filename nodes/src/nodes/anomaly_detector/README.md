# anomaly_detector

A RocketRide filter node that monitors numeric text or document metadata and
marks statistically unusual values. Pick it when a pipeline needs a rolling
check for outliers, per series, rather than a fixed rule for every value.

## What it does

The node accepts `text` and `documents` lanes and returns data on the matching
lane. Text is inspected for one numeric value; documents are copied and
enriched with anomaly metadata based on the configured metadata field. Use it
for changing measurements whose usual range must be learned from recent data,
instead of a rule-based validation node that compares each item against a
known limit.

Values belong to series: one series by default, or one per value of a
metadata field you name. Each series keeps its own fixed-size history in the
node's state, outside the engine, so it survives from one call to the next
and every replica that serves the pipeline scores the series from the same
history; a history nobody adds to expires with the pipeline's idle timeout.
Each value is evaluated against the existing history and only then added to
it. This node is experimental.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | `text` | Inspect a numeric value in text; anomalous values receive a suffix. |
| `documents` | `documents` | Inspect the configured metadata metric and add detection metadata. |

## Profiles

Default: **Z-Score - Standard deviation based detection** (`z_score`).

| Profile | Method | Default window | Warning / critical threshold |
| --- | --- | --- | --- |
| `z_score` **(default)** | Z-Score | 100 | 2.0 / 3.0 |
| `iqr` | Interquartile range | 100 | 1.5 / 3.0 |
| `rolling_avg` | Rolling Average - Moving average deviation detection | 50 | 2.0 / 3.0 |

## Configuration

Start with the profile whose kind of change you need to detect, then point
**Metric field** at the numeric document-metadata key to monitor. The defaults
are conservative starting points; every method needs a warm-up period before
it can identify an outlier.

Every setting is a per-call parameter: a pipeline that exposes it lets each
call choose the method, sensitivity, window size, thresholds, metric field,
series and series field without starting another run; the configured values
are the defaults. A call that
switches the method scores against the same history, so one series can be
watched with z-score and IQR alike.

### Series and series field

Leave **Series field** empty to keep every value in one series named by
**Series** (`default` unless a call or the configuration names another). Set
it to a metadata key, such as `host`, to give each value of that key its own
history: documents from `web-1` and `web-2` are then scored against their own
past, never each other's. Text input, and documents without the key, use the
**Series** value.

### Detection method and sensitivity

Choose `z_score` when distance in standard deviations is meaningful, `iqr`
when you want quartile-based outlier bounds, or `rolling_avg` when percentage
change from recent values is more useful. `sensitivity` controls the IQR bounds
and normalizes the rolling-average score; lowering it makes both methods flag
smaller deviations. It has no effect on Z-Score, whose score is calculated
from the window standard deviation.

### Window size

**Window size** retains 10 to 10,000 recent values per series, with 100 by
default. Use a larger window for a stable long-term baseline and a smaller one
when the normal level changes quickly. A call with a smaller window than the
stored history keeps only the newest values, so shrinking it forgets the
oldest ones for every later call. Z-Score and Rolling Average need at least two existing
values; IQR needs four. Before that, a value is returned as `normal` with
`insufficient data`, so a very large window does not delay the minimum
warm-up but does make the baseline slower to adapt.

### Metric field

For documents, set **Metric field** to the metadata key containing the number;
the default is `value`. A missing or non-numeric key does not stop the
pipeline: the copied document is marked normal and receives an explanatory
`anomaly_details` value. Text input first attempts to parse all of the text,
then uses its first integer, decimal, or scientific-notation token; text with
no number passes through unchanged.

### Warning and critical thresholds

The detector labels a score at or above **Critical threshold** as `critical`,
then a score at or above **Warning threshold** as `warning`; lower scores are
`normal`. Raise these values to reduce alerts and lower them to surface more
borderline changes. With the default rolling-average settings, warning begins
at a 40% deviation and critical at 60%; changing sensitivity changes those
effective percentages as well.

## Notes

### Output details

For anomalous text, the node appends a suffix such as
`[ANOMALY: critical score=3.4119]`; normal text remains unchanged. Documents
receive `anomaly_score`, `anomaly_severity`, `anomaly_is_anomalous`, and
`anomaly_details` metadata. Non-finite numeric input is treated as normal and
is not added to the history.

### Method edge cases

Z-Score produces a normal result when the history has zero variance, IQR does
the same when the interquartile range is zero, and Rolling Average does so when
its local mean is zero. IQR marks any value outside its sensitivity-based
bounds as anomalous even if its resulting score remains below the configured
warning threshold; its severity still uses the warning and critical thresholds.

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
