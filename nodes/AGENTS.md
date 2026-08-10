# nodes/ — agent guide

Every node README (`src/nodes/<name>/README.md`) must follow the schema at
`../docs/internal/node-readme-schema.md`. The node's `services*.json` decides
which sections are required — check your work with:

```bash
python3 ../scripts/validate-node-readme.py src/nodes/<name>
```

The `ROCKETRIDE:GENERATED:PARAMS` region at the end of each README is
maintained by `nodes:docs-generate` — never edit it by hand. The
`services.json` contract itself is documented in
`../docs/internal/node-schema.md`; testing in
`../docs/internal/node-testing.md`.
