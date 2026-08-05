# Landing.ai Parse

Parses documents with Landing.ai ADE (`client.parse`), emitting Markdown text
and tables.

- **Protocol:** `landing_ai_parse://`
- **Lanes:** `data` → `text` (Markdown), `table`
- **Inputs:** PDF, images, spreadsheets (XLSX/CSV)
- **Config:** API Key, Model (`dpt-2-latest`), Region

The document arrives on the `Data` lane as a byte stream (handled by the
tag-stream state machine in `IInstance.py`) and is passed to the ADE SDK as a
`(filename, bytes)` tuple. The response's `markdown` goes to the `text` lane;
chunks of type `table` go to the `table` lane.

Pairs with **Landing.ai Extract** downstream for schema-based field extraction.
