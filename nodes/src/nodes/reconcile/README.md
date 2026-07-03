# Reconcile Node

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->

The `reconcile` node is an essential part of the financial extraction suite. It takes structured data (answers) from upstream nodes, compares them, and uses an LLM to generate a reconciliation report that highlights any discrepancies.

## Use Cases
- Comparing extracted data from an unaudited PDF vs. an official SEC filing (e.g., 10-K).
- Identifying mismatching financial figures, dates, or labels.
- Generating a report that can be indexed into a vector store or fed into downstream systems for human review.

## Architecture
- **Input Lane:** `answers`
- **Output Lanes:** `answers` and `documents`
- **Requirements:** An LLM capability must be connected for the reconciliation logic.
