# Vector Explorer wire captures (`v1`)

`live/<backend>/<tool>[.<case>].json` are real answers of the vector store tools,
captured from the shipped templates running in an engine against the live test
databases (pgvector, RocketRide Vector through the broker stand-in, Qdrant,
Chroma), on a new collection and on a legacy-shaped copy of it (`*.legacy.json`).
They pin the app's parsing to what the tools return; the hand-written
`../provisional/` fixtures cover the shapes no live store produces on demand.

Each file is the answer in canonical form: floats rounded to 4 decimal places
and run-specific values (times, durations, point ids, caller ids, sizes, server
versions) replaced by `"<scrubbed>"`; the `__scrub__` key lists which keys were
scrubbed. Upload names are fixed (`C:/demo/<folder>/<file>`), so objectIds are
stable.

Never edit these by hand. Regenerate them from `nodes/` with the test databases
up (see `scripts/acceptance/vector-explorer/README.md`):

```bash
../dist/server/engine test/vector_wire_fixtures.py ../apps/vector-ui/tests/fixtures/v1/live
```

`nodes/test/test_vector_wire_fixtures_full.py` regenerates them and fails when a
committed capture no longer matches the tools.
