# Landing.ai Extract

Extracts structured fields from parsed Markdown with Landing.ai ADE
(`client.extract`), using a JSON Schema you upload.

- **Protocol:** `landing_ai_extract://`
- **Lanes:** `text` (parsed Markdown) → `answers`, `documents`
- **Config:** API Key, Extraction Schema (`.json` upload), Strict, Region

ADE Extract consumes the **Markdown produced by Parse**, not the raw document,
so this node runs **downstream of Landing.ai Parse**:
`Parse (data → text) → Extract (text → answers)`.

The uploaded schema is a JSON Schema document; it supports ADE's `format` and
`x-alternativeNames` keywords. The Markdown received on the `text` lane is
accumulated and passed directly to the SDK — ADE Extract accepts the Markdown
content directly. The response's `extraction` (key-value data) is written to
`answers` and `documents`.
